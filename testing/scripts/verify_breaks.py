#!/usr/bin/env python3
"""The break check for `docs/changes/DESIGN-journey-consolidation/breaks/<area>.yaml`
(PLAN.md section 7, row A3).

A break manifest names a journey test PR B is about to remove, the tests that
still protect the same behavior, and a small product/mock patch that breaks
that behavior. This script proves the patch actually hits the reason the
removed test existed:

- direction ``base``: apply the patch at the manifest's ``base`` commit and
  show the removed test fails there.
- direction ``head``: apply the same patch at ``--head`` (default ``HEAD``)
  and show every ``remaining`` test fails there too.

Both directions run in throw-away ``git worktree`` sandboxes so the real
checkout is never touched. This module is split into pure functions (manifest
loading and validation, patch apply/revert on a string, title resolution
against a file's text, JSON result parsing) with no subprocess calls, and an
orchestration layer built on a small injectable ``Runner`` so the ordering
(apply, run, revert, sandbox cleanup) can be unit-tested with a fake, even on
a host with no ``app/node_modules`` to actually run vitest or Playwright.
"""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import IO, Any, Dict, List, Optional, Sequence, Set, Tuple

REPO_ROOT = Path(__file__).resolve().parents[2]

# The plan folder and its break manifests: the one place that names them.
# The `breaks/` subfolder may not exist yet (PR A ships the tool, PR B the
# manifests); the plan folder itself always does.
PLAN_DIR = REPO_ROOT / "docs" / "changes" / "DESIGN-journey-consolidation"
BREAKS_DIR = PLAN_DIR / "breaks"

# PyYAML lives in vendor/ next to hub.py (hub.py:21-23 does the same), never
# in the user site-packages: a sandboxed subprocess with a faked $HOME must
# still find it.
_VENDOR_DIR = REPO_ROOT / "vendor"
if _VENDOR_DIR.is_dir() and str(_VENDOR_DIR) not in sys.path:
    sys.path.insert(0, str(_VENDOR_DIR))

import yaml  # type: ignore[import-untyped]  # noqa: E402

# ── errors ───────────────────────────────────────────────────────────────────


class BreakCheckError(Exception):
    """A fatal, user-facing orchestration error (not a schema violation)."""


class PatchError(BreakCheckError):
    """A patch's `find` text does not occur exactly once. A subclass of
    `BreakCheckError` so an unhandled `PatchError` from `main()` prints a
    one-line message and exits 2, instead of a traceback."""


# ── manifest: loading and validation (pure) ────────────────────────────────


def load_manifest(path: Path) -> Any:
    return yaml.safe_load(path.read_text(encoding="utf-8"))


def _patch_path_ok(file: str) -> bool:
    return file.startswith("app/src/") and not file.startswith("app/src/test/") and not file.startswith(
        "app/e2e/"
    )


def _entry_line_count(entry: Dict[str, Any]) -> int:
    """The size of one patch entry's change: the larger of the `find` and
    `replace` line counts, not their sum — a 3-line block replaced by 3
    different lines is a 3-line change, not 6."""
    find_lines = str(entry.get("find", "")).splitlines() or [""]
    replace_lines = str(entry.get("replace", "")).splitlines() or [""]
    return max(len(find_lines), len(replace_lines))


def patch_line_budget(patch: Sequence[Dict[str, Any]]) -> int:
    return sum(_entry_line_count(entry) for entry in patch)


def _validate_patch_entry(row_index: int, entry_index: int, entry: Any) -> List[str]:
    if not isinstance(entry, dict) or not entry.get("file") or "find" not in entry or "replace" not in entry:
        return [f"row {row_index}: patch[{entry_index}] needs file, find and replace"]
    problems: List[str] = []
    file = entry["file"]
    if not isinstance(file, str) or not _patch_path_ok(file):
        problems.append(
            f"row {row_index}: patch[{entry_index}] file {file!r} must be under app/src/, "
            "not app/src/test/ or app/e2e/"
        )
    if entry["find"] == entry["replace"]:
        problems.append(f"row {row_index}: patch[{entry_index}] find and replace must differ")
    return problems


def _validate_row(index: int, row: Any) -> List[str]:
    """A row is either *tested* (`remaining` + `patch`, checked by
    `verify_breaks.py`) or *dropped* (`dropped_reason`, a one-line note that
    the removed behavior cannot be tested on the preview build — e.g. a
    journey needing dev-server-only module URLs, plan section 11). Exactly
    one of the two shapes is required; neither, or both, is a violation."""
    if not isinstance(row, dict):
        return [f"row {index}: must be a mapping"]
    problems: List[str] = []
    if "removed" not in row:
        problems.append(f"row {index}: missing 'removed'")
    if "reason" not in row:
        problems.append(f"row {index}: missing 'reason'")

    has_dropped = "dropped_reason" in row
    has_tested = "remaining" in row or "patch" in row
    if has_dropped and has_tested:
        problems.append(
            f"row {index}: has both 'dropped_reason' and 'remaining'/'patch' "
            "— a row is either tested or dropped, not both"
        )
    elif not has_dropped and not has_tested:
        problems.append(f"row {index}: missing 'remaining'/'patch' (or 'dropped_reason' for an untestable row)")

    if problems:
        return problems

    removed = row["removed"]
    if not isinstance(removed, dict) or not removed.get("file") or not removed.get("title"):
        problems.append(f"row {index}: removed needs file and title")

    if has_dropped:
        dropped_reason = row.get("dropped_reason")
        if not isinstance(dropped_reason, str) or not dropped_reason.strip():
            problems.append(f"row {index}: dropped_reason must be a non-empty string")
    else:
        remaining = row.get("remaining")
        if not isinstance(remaining, list) or not remaining:
            problems.append(f"row {index}: remaining must be a non-empty list")
        else:
            for i, entry in enumerate(remaining):
                if not isinstance(entry, dict) or not entry.get("file") or not entry.get("title"):
                    problems.append(f"row {index}: remaining[{i}] needs file and title")

        patch = row.get("patch")
        if not isinstance(patch, list) or not patch:
            problems.append(f"row {index}: patch must be a non-empty list")
        else:
            for i, entry in enumerate(patch):
                problems.extend(_validate_patch_entry(index, i, entry))
            well_formed = [e for e in patch if isinstance(e, dict) and "find" in e and "replace" in e]
            if len(well_formed) == len(patch):
                budget = patch_line_budget(well_formed)
                if budget > 5:
                    problems.append(f"row {index}: patch changes {budget} lines, over the 5-line budget")

    if not isinstance(row.get("reason"), str) or not row["reason"].strip():
        problems.append(f"row {index}: reason must be a non-empty string")

    return problems


def validate_manifest(data: Any) -> List[str]:
    """Every violation, each prefixed with its row index (or `manifest:` for a
    top-level defect), as the plan's manifest rules require."""
    if not isinstance(data, dict):
        return ["manifest: top level must be a mapping"]
    problems: List[str] = []
    for key in ("area", "base", "rows"):
        if key not in data:
            problems.append(f"manifest: missing field {key!r}")
    if problems:
        return problems
    rows = data.get("rows")
    if not isinstance(rows, list) or not rows:
        return ["manifest: rows must be a non-empty list"]
    for index, row in enumerate(rows):
        problems.extend(_validate_row(index, row))
    return problems


# ── patch: apply/revert on a string (pure) ─────────────────────────────────


def apply_patch(text: str, find: str, replace: str) -> str:
    """Replace the single occurrence of `find` with `replace`. Raises
    `PatchError` when `find` occurs zero or more than once — an ambiguous or
    stale patch must never silently apply."""
    count = text.count(find)
    if count != 1:
        raise PatchError(f"expected exactly one match for {find!r}, found {count}")
    return text.replace(find, replace, 1)


def revert_patch(patched_text: str, find: str, replace: str) -> str:
    """The inverse of `apply_patch`: turn `replace` back into `find`."""
    return apply_patch(patched_text, replace, find)


# ── title resolution against a file's text (pure) ──────────────────────────

# `test(` / `it(` immediately followed by a quoted string or a template
# literal. A leading `\b` keeps `wait(` from matching `it(`, and excludes
# `it.each(` / `test.each(` (the call after `.each(...)` is a bare `(`, not
# `it(`), which is how `it.each` tables end up out of scope for free.
_TITLE_CALL_RE = re.compile(r"\b(?:test|it)\(\s*(['\"`])((?:\\.|(?!\1).)*)\1")

_ESCAPES = {"n": "\n", "t": "\t", "r": "\r", "\\": "\\", "'": "'", '"': '"', "`": "`"}


def _unescape_js_string(raw: str) -> str:
    out: List[str] = []
    i = 0
    while i < len(raw):
        ch = raw[i]
        if ch == "\\" and i + 1 < len(raw):
            out.append(_ESCAPES.get(raw[i + 1], raw[i + 1]))
            i += 2
        else:
            out.append(ch)
            i += 1
    return "".join(out)


def extract_titles(text: str) -> Set[str]:
    """Every literal `test("…")`, `test(\\`…\\`)` or `it("…")` title in
    `text`. A template literal with `${...}` interpolation cannot be
    resolved statically (the manifest author must record the
    already-substituted title) and is skipped; `it.each` tables never match
    `_TITLE_CALL_RE` at all. Both are out of scope here."""
    titles: Set[str] = set()
    for match in _TITLE_CALL_RE.finditer(text):
        quote, raw = match.group(1), match.group(2)
        if quote == "`" and "${" in raw:
            continue
        titles.add(_unescape_js_string(raw))
    return titles


# A template literal title, kept *with* its `${...}` placeholders — unlike
# `_TITLE_CALL_RE`'s use in `extract_titles`, this one is not filtered down
# to literal-only titles. Used so a manifest row can name the *resolved*
# literal from a width- or row-loop template (e.g. a `widths.forEach` test)
# even though the source only has the unresolved template, and by the CI
# diff rule to notice a removed templated title.
_TEMPLATE_TITLE_RE = re.compile(r"\b(?:test|it)\(\s*`((?:\\.|[^`\\])*)`")


def extract_template_titles(text: str) -> Set[str]:
    """Every `test(`` `…` ``)` / `it(`` `…` ``)` template literal title in
    `text`, **including** ones with `${...}` interpolation, kept as their
    raw source text (placeholders and all). `extract_titles` skips these
    because they cannot be resolved to one literal string on their own;
    `resolve_title` and the CI diff rule instead match a literal, already
    -substituted title against these templates with
    `template_title_matches_row_title`."""
    return {match.group(1) for match in _TEMPLATE_TITLE_RE.finditer(text)}


def template_title_matches_row_title(template: str, row_title: str) -> bool:
    """True when `row_title` equals the raw template exactly, or matches it
    once every `${...}` placeholder is treated as `.+` (one or more of any
    character, anchored to the surrounding literal text) — e.g. the
    template `` `opens at ${width}px` `` matches the resolved title
    `"opens at 1440px"` (`${width}` -> `1440`), but not `"closes at 1440px"`
    (the literal `opens at ` prefix does not match)."""
    if template == row_title:
        return True
    parts = re.split(r"(\$\{[^}]*\})", template)
    pattern = "".join(".+" if p.startswith("${") and p.endswith("}") else re.escape(p) for p in parts)
    return re.fullmatch(pattern, row_title) is not None


def resolve_title(text: str, title: str) -> bool:
    """True when some `test(`/`it(` call in `text` has the exact literal
    title `title` (see `extract_titles`), or a template literal call whose
    placeholders `title` fits (see `template_title_matches_row_title`) — a
    manifest row may name the already-resolved literal for a width- or
    row-loop test (`"…at 520px"` for a source template
    `` `…at ${width}px` ``), since that is the title Playwright/vitest
    actually runs at, not the unresolved source template."""
    if title in extract_titles(text):
        return True
    return any(template_title_matches_row_title(t, title) for t in extract_template_titles(text))


# A numeric array literal, e.g. a width table like `[1440, 768, 520]`. Used
# only as a soft signal (see `detect_shrinking_width_arrays`): a dropped
# width changes no test title, so the title diff cannot see it.
_NUMERIC_ARRAY_RE = re.compile(r"\[\s*\d+(?:\s*,\s*\d+)*\s*\]")


def _numeric_arrays(text: str) -> List[Tuple[int, ...]]:
    arrays = []
    for match in _NUMERIC_ARRAY_RE.finditer(text):
        arrays.append(tuple(int(n) for n in re.findall(r"\d+", match.group(0))))
    return arrays


def detect_shrinking_width_arrays(base_text: str, head_text: str) -> List[str]:
    """A soft signal only, never a failure: a numeric array literal present
    at `base_text` (typically a width table such as `[1440, 768, 520]`) that
    is gone from `head_text`, where some array at head is a strict subset of
    it, suggests a dropped width — the kind of change the title diff cannot
    see because it changes no test title. The B1 process must add that
    manifest row by hand; this only prints a warning line for a human to
    notice."""
    base_arrays = set(_numeric_arrays(base_text))
    head_arrays = set(_numeric_arrays(head_text))
    warnings: List[str] = []
    for base_arr in sorted(base_arrays - head_arrays):
        shrunk = [h for h in head_arrays if set(h) < set(base_arr)]
        if shrunk:
            narrowest = min(shrunk, key=len)
            warnings.append(
                f"array literal {list(base_arr)} shrank to {list(narrowest)}; a dropped value changes "
                "no test title — check the B1 manifest by hand"
            )
    return warnings


# ── JSON result parsing (pure) ──────────────────────────────────────────────


@dataclass
class RunSummary:
    total: int
    failed: int
    items: List[Dict[str, Any]] = field(default_factory=list)

    @property
    def all_failed(self) -> bool:
        return self.total > 0 and self.failed == self.total

    @property
    def none_failed(self) -> bool:
        return self.total > 0 and self.failed == 0


_VITEST_FAILING = {"failed"}
_PLAYWRIGHT_FAILING = {"failed", "timedOut", "unexpected", "interrupted"}


def parse_vitest_json(data: Dict[str, Any], title: str) -> RunSummary:
    """`vitest run <file> -t "<vitest_grep_pattern(title)>" --reporter=json`.
    `-t` is unanchored at the start, so it can select more than the one
    assertion asked for — an unguarded suffix check is not enough either:
    `"reopens the shell"` ends with `"opens the shell"`, so a naive
    `endswith(title)` would wrongly count it. Only an assertion whose full
    name *equals* `title`, or ends with `" " + title` (a real word/describe
    boundary before it), counts."""
    items: List[Dict[str, Any]] = []
    for suite in data.get("testResults") or []:
        for assertion in suite.get("assertionResults") or []:
            full_name = assertion.get("fullName") or assertion.get("title") or ""
            if full_name == title or full_name.endswith(" " + title):
                items.append({"name": full_name, "status": assertion.get("status")})
    failed = sum(1 for item in items if item["status"] in _VITEST_FAILING)
    return RunSummary(total=len(items), failed=failed, items=items)


def parse_playwright_json(data: Dict[str, Any], title: str) -> RunSummary:
    """`playwright test <file> -g "<playwright_grep_pattern(title)>" --reporter=json`.

    Playwright's `-g` matches against `[projectName, file, ...describeTitles,
    testTitle].join(" ")`, not the bare test title — a plain `^<title>$`
    anchor can never match because the project name (`chromium`) and file
    path always come first. `playwright_grep_pattern` accounts for that, but
    a regex boundary is still an approximation: a *different* test whose
    title happens to end on the same word boundary can also satisfy it. The
    real filter is here — only specs whose own `title` equals `title`
    exactly are counted, so a coincidental `-g` match can never slip
    through as a false pass or false fail.
    """
    items: List[Dict[str, Any]] = []

    def walk(suite: Dict[str, Any]) -> None:
        for spec in suite.get("specs") or []:
            if spec.get("title") != title:
                continue
            for test in spec.get("tests") or []:
                results = test.get("results") or []
                status = results[-1].get("status") if results else "unknown"
                items.append({"name": spec.get("title"), "status": status})
        for child in suite.get("suites") or []:
            walk(child)

    for suite in data.get("suites") or []:
        walk(suite)
    failed = sum(1 for item in items if item["status"] in _PLAYWRIGHT_FAILING)
    return RunSummary(total=len(items), failed=failed, items=items)


# ── which runner owns a test file (pure) ────────────────────────────────────


def test_kind_for_file(file: str) -> str:
    if file.startswith("app/e2e/") and file.endswith(".spec.ts"):
        return "playwright"
    if file.startswith("app/src/") and (file.endswith(".test.ts") or file.endswith(".test.tsx")):
        return "vitest"
    raise BreakCheckError(f"cannot tell which runner owns {file!r}")


def vitest_grep_pattern(title: str) -> str:
    """Vitest compiles `-t` as `new RegExp(pattern)`, not a literal
    substring — an unescaped title with `(`, `)`, `?`, `+` or other regex
    metacharacters (real examples: "reflects STALE (registry changed) when
    ≥1 project's fingerprint drifted (B1-02)", "…only when ?pruned=1 is
    set") either fails to compile or matches the wrong tests. Escape it and
    anchor the end, requiring either the very start of the full name or a
    preceding word boundary (the same `(^|\\s)` shape as
    `playwright_grep_pattern`) — without that, `-t` would also select
    `"reopens the shell"` while looking for `"opens the shell"`.
    `parse_vitest_json` separately verifies the executed test's full name
    equals the exact title (or ends with it past a real boundary), since
    `-t` is a selection filter, not the final proof."""
    return rf"(^|\s){re.escape(title)}$"


def vitest_argv(file: str, title: str, output_file: Path) -> List[str]:
    rel = file[len("app/") :] if file.startswith("app/") else file
    return [
        "npx",
        "vitest",
        "run",
        rel,
        "-t",
        vitest_grep_pattern(title),
        "--reporter=json",
        "--outputFile",
        str(output_file),
    ]


def playwright_grep_pattern(title: str) -> str:
    """`-g` matches against the *joined* full title
    (`[projectName, file, ...describeTitles, testTitle].join(" ")`), so a
    `^<title>$` anchor never matches — the project name and file path always
    precede the test's own title. Anchoring only the end, and requiring the
    title be preceded by either the start of the string or whitespace, gets
    the exact test without also matching an unrelated title that merely
    contains `title` as a substring in the middle. `parse_playwright_json`'s
    exact `spec.title == title` check is the real guarantee; this pattern
    only needs to be selective enough that Playwright runs the right spec."""
    return rf"(^|\s){re.escape(title)}$"


def playwright_argv(file: str, title: str) -> List[str]:
    rel = file[len("app/") :] if file.startswith("app/") else file
    return ["npx", "playwright", "test", rel, "-g", playwright_grep_pattern(title), "--reporter=json"]


def _safe_name(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", value)[:120]


# ── row-level patch application (file I/O, not pure) ────────────────────────


def apply_row_patch(tree: Path, patch: Sequence[Dict[str, Any]]) -> Dict[str, str]:
    """Apply every entry in a row's patch under `tree`, all-or-nothing.

    Every entry's `find`/`replace` is resolved against an in-memory copy of
    its file's text first (entries that share a file chain, in order); only
    once every entry has matched exactly once does this write anything to
    disk. A `PatchError` from any entry therefore leaves every file on disk
    exactly as it started — there is nothing partially applied to revert.

    Returns the original text of each touched file (relative path -> text)
    so the caller can revert after a successful run.
    """
    originals: Dict[str, str] = {}
    working: Dict[str, str] = {}
    for entry in patch:
        rel = entry["file"]
        if rel not in working:
            text = (tree / rel).read_text(encoding="utf-8")
            originals[rel] = text
            working[rel] = text
        working[rel] = apply_patch(working[rel], entry["find"], entry["replace"])
    for rel, text in working.items():
        (tree / rel).write_text(text, encoding="utf-8")
    return originals


def revert_row_patch(tree: Path, originals: Dict[str, str]) -> None:
    for rel, text in originals.items():
        (tree / rel).write_text(text, encoding="utf-8")


# ── subprocess seam ──────────────────────────────────────────────────────────


class Runner:
    """Thin wrapper around `subprocess` so orchestration can be exercised
    with a fake in unit tests, without ever launching a real process here."""

    def run(
        self,
        argv: Sequence[str],
        *,
        cwd: Optional[Path] = None,
        env: Optional[Dict[str, str]] = None,
        timeout: Optional[float] = None,
    ) -> "subprocess.CompletedProcess[str]":
        return subprocess.run(
            list(argv),
            cwd=str(cwd) if cwd else None,
            env=env,
            timeout=timeout,
            capture_output=True,
            text=True,
            check=False,
        )

    def popen(
        self,
        argv: Sequence[str],
        *,
        cwd: Optional[Path] = None,
        env: Optional[Dict[str, str]] = None,
    ) -> "subprocess.Popen[Any]":
        # A long-lived child (the dev server): its own session, so stopping it
        # can signal the whole group (`npm run dev` forks `vite`, which a
        # plain terminate of npm leaves running); output to a log file, never
        # an unread pipe that could fill and block the server.
        log_path = Path((env or {}).get("TMPDIR", "/tmp")) / "dev-server.log"
        log_path.parent.mkdir(parents=True, exist_ok=True)
        log = open(log_path, "ab")
        try:
            return subprocess.Popen(
                list(argv),
                cwd=str(cwd) if cwd else None,
                env=env,
                stdout=log,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
        finally:
            log.close()


# ── sandbox (two detached git worktrees, as mutate.py's Sandbox in spirit) ──


@dataclass
class Sandboxes:
    root: Path
    base_dir: Path
    head_dir: Path


def sandbox_root_for(repo_root: Path, override: Optional[Path] = None) -> Path:
    if override is not None:
        return override
    digest = hashlib.sha1(str(repo_root).encode()).hexdigest()[:8]
    cache = Path(os.environ.get("XDG_CACHE_HOME") or (Path.home() / ".cache"))
    return cache / "skill-hub-breaks" / f"{repo_root.name}-{digest}"


_SANDBOX_LOCKS: Dict[Path, IO[str]] = {}


def acquire_sandbox_lock(root: Path) -> None:
    """Exclusive, non-blocking lock on the sandbox root: one `verify_breaks.py`
    run at a time, as `mutate.py`'s `acquire_run_lock` does for its sandbox.
    The fd is kept in `_SANDBOX_LOCKS` (never closed) so the lock holds for
    the rest of this process."""
    root.mkdir(parents=True, exist_ok=True)
    lock_path = root / "run.lock"
    fh = open(lock_path, "a+")
    try:
        fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        fh.close()
        raise BreakCheckError(f"another verify_breaks.py run is using {root}")
    _SANDBOX_LOCKS[root] = fh


def sandbox_env(root: Path, base: Optional[Dict[str, str]] = None) -> Dict[str, str]:
    """A minimal, isolated child environment (HOME/XDG_*/TMPDIR inside the
    sandbox root), as `sandbox_env` in mutate.py does, so no real dotfile is
    ever touched by the dev server or the test runners."""
    ambient = os.environ if base is None else base
    keep = {"PATH", "LANG", "TERM", "TZ", "SHELL", "USER", "LOGNAME"}
    env = {key: value for key, value in ambient.items() if key in keep or key.startswith("LC_")}
    home = root / "home"
    env.update(
        {
            "HOME": str(home),
            "USERPROFILE": str(home),
            "XDG_CONFIG_HOME": str(home / ".config"),
            "XDG_CACHE_HOME": str(home / ".cache"),
            "XDG_DATA_HOME": str(home / ".local" / "share"),
            "TMPDIR": str(root / "tmp"),
        }
    )
    # Playwright looks for its browsers under the real cache; the sandbox
    # home has none. Point at the ambient location unless the caller set one.
    real_home = Path(ambient.get("HOME", str(home)))
    env["PLAYWRIGHT_BROWSERS_PATH"] = ambient.get(
        "PLAYWRIGHT_BROWSERS_PATH", str(real_home / ".cache" / "ms-playwright")
    )
    for directory in (home, root / "tmp"):
        directory.mkdir(parents=True, exist_ok=True)
    return env


def create_sandboxes(
    runner: Runner,
    repo_root: Path,
    root: Path,
    base_sha: str,
    head_ref: str,
) -> Sandboxes:
    sandboxes = Sandboxes(root=root, base_dir=root / "base", head_dir=root / "head")
    try:
        for directory, ref in ((sandboxes.base_dir, base_sha), (sandboxes.head_dir, head_ref)):
            result = runner.run(["git", "worktree", "add", "--detach", str(directory), ref], cwd=repo_root)
            if result.returncode != 0:
                raise BreakCheckError(f"git worktree add {directory} {ref} failed: {result.stderr}")
            source_node_modules = repo_root / "app" / "node_modules"
            if source_node_modules.exists():
                target = directory / "app" / "node_modules"
                # A hardlink copy, not a symlink: a symlinked node_modules breaks
                # Vite's @fontsource file resolution.
                cp_result = runner.run(["cp", "-al", str(source_node_modules), str(target)])
                if cp_result.returncode != 0:
                    raise BreakCheckError(f"cp -al node_modules into {directory} failed: {cp_result.stderr}")
    except BaseException:
        # A half-built pair (base added, head failed) must not outlive this
        # call: the caller's cleanup only covers sandboxes it got back, and
        # a registered leftover makes the next run's `worktree add` fail.
        remove_sandboxes(runner, repo_root, sandboxes, keep=False)
        raise
    return sandboxes


def clear_stale_sandboxes(runner: Runner, repo_root: Path, root: Path) -> None:
    """Remove a `base`/`head` pair a previous run left behind (`--keep`, or a
    crash before its cleanup), then prune worktree registrations whose
    directory is gone. Call it only while holding the sandbox lock: another
    live run's trees are never stale."""
    remove_sandboxes(
        runner, repo_root, Sandboxes(root=root, base_dir=root / "base", head_dir=root / "head"), keep=False
    )
    runner.run(["git", "worktree", "prune"], cwd=repo_root)


def remove_sandboxes(runner: Runner, repo_root: Path, sandboxes: Sandboxes, *, keep: bool) -> None:
    if keep:
        return
    for directory in (sandboxes.base_dir, sandboxes.head_dir):
        runner.run(["git", "worktree", "remove", "--force", str(directory)], cwd=repo_root)
        # `git worktree remove` leaves untracked output (test-results) behind,
        # and a non-empty directory blocks the next run's `git worktree add`.
        shutil.rmtree(directory, ignore_errors=True)


# ── the dev server (Playwright direction only) ──────────────────────────────


def free_port(start: int = 1500) -> int:
    """The lowest free port above `start`, bound to 127.0.0.1 — this host's
    `localhost` probe fails on `::1`, so every probe here is explicit about
    the host."""
    port = start + 1
    while True:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                probe.bind(("127.0.0.1", port))
            except OSError:
                port += 1
                continue
        return port


@dataclass
class DevServer:
    process: "subprocess.Popen[Any]"
    port: int


def start_dev_server(
    runner: Runner,
    cwd: Path,
    env: Dict[str, str],
    port: int,
    *,
    timeout: float = 120.0,
    poll_interval: float = 0.5,
) -> DevServer:
    server_env = dict(env)
    server_env["VISUAL_MOCK"] = "1"
    server_env["ST_DEV_PORT"] = str(port)
    process = runner.popen(["npm", "run", "dev"], cwd=cwd, env=server_env)
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise BreakCheckError(f"dev server for {cwd} exited early (code {process.returncode})")
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            try:
                probe.connect(("127.0.0.1", port))
            except OSError:
                time.sleep(poll_interval)
                continue
        return DevServer(process=process, port=port)
    # The same group stop as `stop_dev_server`: a plain terminate of `npm`
    # leaves `vite` running in the server's own session.
    _terminate_group(process)
    raise BreakCheckError(f"dev server on 127.0.0.1:{port} did not answer within {timeout}s")


def stop_dev_server(server: Optional[DevServer]) -> None:
    """Stop the server by its own PID. Never `pkill`."""
    if server is None:
        return
    if server.process.poll() is not None:
        return
    _terminate_group(server.process)


def _terminate_group(process: "subprocess.Popen[Any]") -> None:
    # Signal the server's own process group (it runs in a new session), so
    # `vite` dies with `npm`. This is the group this script created, never a
    # pattern match on other processes.
    _signal_group(process, signal.SIGTERM)
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        _signal_group(process, signal.SIGKILL)
        process.wait(timeout=10)


def _signal_group(process: "subprocess.Popen[Any]", sig: int) -> None:
    try:
        os.killpg(os.getpgid(process.pid), sig)
    except (ProcessLookupError, PermissionError):
        pass


# ── running one test ─────────────────────────────────────────────────────────


@dataclass
class TestOutcome:
    file: str
    title: str
    kind: str
    summary: Optional[RunSummary]
    log_path: Path
    error: Optional[str] = None

    @property
    def failed_as_expected(self) -> bool:
        return self.error is None and self.summary is not None and self.summary.all_failed

    @property
    def passed_cleanly(self) -> bool:
        """Every test ran and none failed — the shape a control run needs."""
        return self.error is None and self.summary is not None and self.summary.none_failed


@dataclass
class RowOutcome:
    """One target test's result for a row/direction: the unpatched control
    run (proof the test passes before the patch, so a broken sandbox or an
    already-failing test cannot masquerade as proof the patch works) and the
    patched run (proof the patch breaks it)."""

    file: str
    title: str
    control: Optional[TestOutcome]
    patched: TestOutcome

    @property
    def control_ok(self) -> bool:
        """True when no control run was requested, or the control run
        passed cleanly (0 tests still counts as a failure to prove
        anything)."""
        return self.control is None or self.control.passed_cleanly

    @property
    def ok(self) -> bool:
        return self.control_ok and self.patched.failed_as_expected


def run_single_test(
    runner: Runner,
    cwd: Path,
    env: Dict[str, str],
    file: str,
    title: str,
    log_dir: Path,
) -> TestOutcome:
    kind = test_kind_for_file(file)
    log_dir.mkdir(parents=True, exist_ok=True)
    log_path = log_dir / f"{_safe_name(file)}__{_safe_name(title)}.json"
    if kind == "vitest":
        # vitest writes the JSON to `log_path`; a file left by an earlier run
        # (control, previous direction, previous invocation) must never be
        # read as this run's result. Once it is gone, an existing file after
        # the run is fresh, and a missing one is an error below.
        log_path.unlink(missing_ok=True)
        argv = vitest_argv(file, title, log_path)
        result = runner.run(argv, cwd=cwd, env=env)
        if log_path.exists():
            try:
                data = json.loads(log_path.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                return TestOutcome(file, title, kind, None, log_path, error="could not parse vitest JSON output")
        else:
            log_path.write_text(result.stdout + "\n" + result.stderr, encoding="utf-8")
            return TestOutcome(file, title, kind, None, log_path, error="vitest produced no JSON output file")
        summary = parse_vitest_json(data, title)
    else:
        argv = playwright_argv(file, title)
        result = runner.run(argv, cwd=cwd, env=env)
        log_path.write_text(result.stdout, encoding="utf-8")
        try:
            data = json.loads(result.stdout or "{}")
        except json.JSONDecodeError:
            return TestOutcome(file, title, kind, None, log_path, error="could not parse playwright JSON output")
        summary = parse_playwright_json(data, title)
    if summary.total == 0:
        return TestOutcome(file, title, kind, summary, log_path, error="no tests found")
    return TestOutcome(file, title, kind, summary, log_path)


# ── one row, one direction ──────────────────────────────────────────────────


def run_row_direction(
    runner: Runner,
    tree: Path,
    env: Dict[str, str],
    row: Dict[str, Any],
    direction: str,
    log_dir: Path,
    *,
    control: bool = True,
) -> List[RowOutcome]:
    """Run the direction's target test(s) against `tree`, in this order:
    control (unpatched), apply, run (patched), revert — always, even when a
    later step raises. Direction `base` runs only the removed test;
    direction `head` runs every remaining test.

    The control run (default on, `control=False` to skip) proves each
    target test passes before the patch — without it, a broken sandbox or a
    test that was already failing for an unrelated reason would look like
    proof the patch works.
    """
    targets = [row["removed"]] if direction == "base" else list(row["remaining"])

    controls: Dict[Tuple[str, str], TestOutcome] = {}
    if control:
        control_dir = log_dir / "control"
        for t in targets:
            key = (t["file"], t["title"])
            controls[key] = run_single_test(runner, tree / "app", env, t["file"], t["title"], control_dir)

    originals = apply_row_patch(tree, row["patch"])
    try:
        results: List[RowOutcome] = []
        for t in targets:
            patched = run_single_test(runner, tree / "app", env, t["file"], t["title"], log_dir)
            results.append(
                RowOutcome(
                    file=t["file"],
                    title=t["title"],
                    control=controls.get((t["file"], t["title"])),
                    patched=patched,
                )
            )
        return results
    finally:
        revert_row_patch(tree, originals)


# ── manifest-wide check-only mode (no sandbox) ──────────────────────────────


def check_manifest(repo: Path, data: Any) -> Tuple[List[str], List[str]]:
    """Returns `(problems, warnings)`.

    `problems` are hard failures (a non-empty result fails the check).
    `warnings` are informational only, today just: a `remaining` title that
    resolves solely through a template match. Its actual value (which width,
    which row) cannot be checked statically from source — only the run step
    proves it, by actually invoking that title (0 tests found there is
    itself an error). Template matching is deliberately *not* used for the
    "removed title is absent at head" check: a loose template match would
    wrongly accept a title as "still present" for a width the loop no
    longer has (a legitimate `dropped_reason` row for that exact width), so
    that check only ever looks at exact literal titles (`extract_titles`).
    """
    problems = validate_manifest(data)
    if problems:
        return problems, []
    warnings: List[str] = []
    for index, row in enumerate(data["rows"]):
        for entry in row.get("remaining", []):  # a dropped row has no `remaining`
            path = repo / entry["file"]
            if not path.exists():
                problems.append(f"row {index}: remaining file not found: {entry['file']}")
                continue
            text = path.read_text(encoding="utf-8", errors="ignore")
            if entry["title"] in extract_titles(text):
                continue
            if resolve_title(text, entry["title"]):
                warnings.append(
                    f"row {index}: remaining title in {entry['file']} is template-resolved — its value "
                    f"cannot be checked statically, only the run step proves it: {entry['title']!r}"
                )
                continue
            problems.append(f"row {index}: remaining title not found in {entry['file']}: {entry['title']!r}")
        removed = row["removed"]
        removed_path = repo / removed["file"]
        if removed_path.exists():
            removed_text = removed_path.read_text(encoding="utf-8", errors="ignore")
            if removed["title"] in extract_titles(removed_text):
                problems.append(
                    f"row {index}: removed title still present in {removed['file']}: {removed['title']!r}"
                )
    return problems, warnings


# ── row/direction selection ─────────────────────────────────────────────────


def parse_rows_arg(value: Optional[str], total: int) -> List[int]:
    """`--rows 1,3` (1-based, as the CLI documents) to 0-based row indices;
    `None` selects every row."""
    if not value:
        return list(range(total))
    indices: List[int] = []
    for chunk in value.split(","):
        chunk = chunk.strip()
        if not chunk:
            continue
        n = int(chunk)
        if n < 1 or n > total:
            raise BreakCheckError(f"--rows names row {n}, but the manifest has {total} row(s)")
        indices.append(n - 1)
    return indices


def directions_for(direction: str) -> List[str]:
    if direction == "both":
        return ["base", "head"]
    return [direction]


# ── CLI ──────────────────────────────────────────────────────────────────────


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="verify_breaks.py")
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--repo", type=Path, default=REPO_ROOT)
    parser.add_argument("--head", default="HEAD")
    parser.add_argument("--rows", default=None)
    parser.add_argument("--direction", choices=("base", "head", "both"), default="both")
    parser.add_argument("--sandbox-root", type=Path, default=None)
    parser.add_argument("--port", type=int, default=None)
    parser.add_argument("--keep", action="store_true")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--check-only", action="store_true")
    parser.add_argument(
        "--no-control",
        dest="control",
        action="store_false",
        default=True,
        help="skip the unpatched control run (on by default) that proves each target test passes before the patch",
    )
    return parser


def _print_problems(problems: List[str], *, as_json: bool, warnings: Optional[List[str]] = None) -> None:
    warnings = warnings or []
    if as_json:
        print(
            json.dumps(
                {"verdict": "invalid" if problems else "ok", "problems": problems, "warnings": warnings}, indent=2
            )
        )
        return
    for warning in warnings:
        print(f"  ! {warning}")
    if not problems:
        print("ok: manifest is valid")
        return
    print("invalid:")
    for problem in problems:
        print(f"  - {problem}")


def _resolve_git_sha(runner: Runner, repo: Path, ref: str) -> str:
    result = runner.run(["git", "rev-parse", ref], cwd=repo)
    if result.returncode != 0:
        raise BreakCheckError(f"could not resolve {ref!r}: {result.stderr}")
    return result.stdout.strip()


def _print_table(rows_report: List[Dict[str, Any]], *, as_json: bool) -> None:
    if as_json:
        print(json.dumps({"rows": rows_report}, indent=2))
        return
    print(f"{'row':>4}  {'direction':<9}  {'test':<60}  {'control':<8}  {'expected':<8}  {'observed':<8}  log")
    all_ok = True
    for row_report in rows_report:
        if "dropped_reason" in row_report:
            print(f"{row_report['row']:>4}  dropped: {row_report['dropped_reason']}")
            continue
        for direction_report in row_report["directions"]:
            for outcome in direction_report["outcomes"]:
                all_ok = all_ok and outcome["ok"]
                control_label = "ok" if outcome["control_ok"] else (outcome["control_error"] or "failed")
                observed = outcome["error"] or ("fail" if outcome["ok"] else "pass")
                test_label = f"{outcome['file']}::{outcome['title']}"[:60]
                print(
                    f"{row_report['row']:>4}  {direction_report['direction']:<9}  "
                    f"{test_label:<60}  {control_label:<8}  {'fail':<8}  {observed:<8}  {outcome['log_path']}"
                )
    print("PASS" if all_ok else "FAIL")


def run_all(args: argparse.Namespace, runner: Optional[Runner] = None) -> int:
    data = load_manifest(args.manifest)
    problems = validate_manifest(data)
    if problems:
        _print_problems(problems, as_json=args.json)
        return 1

    if args.check_only:
        problems, warnings = check_manifest(args.repo, data)
        _print_problems(problems, as_json=args.json, warnings=warnings)
        return 1 if problems else 0

    if runner is None:
        runner = Runner()
    total_rows = len(data["rows"])
    row_indices = parse_rows_arg(args.rows, total_rows)
    directions = directions_for(args.direction)

    root = sandbox_root_for(args.repo, args.sandbox_root)
    acquire_sandbox_lock(root)
    clear_stale_sandboxes(runner, args.repo, root)
    base_sha = _resolve_git_sha(runner, args.repo, data["base"])
    head_sha = _resolve_git_sha(runner, args.repo, args.head)
    sandboxes = create_sandboxes(runner, args.repo, root, base_sha, head_sha)

    rows_report: List[Dict[str, Any]] = []
    # One dev server for each sandbox tree: the base tree and the head tree
    # hold different source, so one server cannot serve both directions.
    dev_servers: Dict[Path, DevServer] = {}
    try:
        for index in row_indices:
            row = data["rows"][index]
            if "dropped_reason" in row:
                # No remaining test protects this behavior on the preview
                # build (plan section 11); nothing to apply or run. Counts
                # as passed — `directions: []` contributes no outcomes to
                # the `all_ok` reduction below.
                rows_report.append(
                    {
                        "row": index + 1,
                        "reason": row["reason"],
                        "dropped_reason": row["dropped_reason"],
                        "directions": [],
                    }
                )
                continue
            row_report: Dict[str, Any] = {"row": index + 1, "reason": row["reason"], "directions": []}
            for direction in directions:
                tree = sandboxes.base_dir if direction == "base" else sandboxes.head_dir
                env = sandbox_env(root)
                needs_playwright = any(
                    test_kind_for_file(t["file"]) == "playwright"
                    for t in ([row["removed"]] if direction == "base" else row["remaining"])
                )
                if needs_playwright:
                    if tree not in dev_servers:
                        port = free_port(args.port - 1) if args.port and not dev_servers else free_port()
                        dev_servers[tree] = start_dev_server(runner, tree / "app", env, port)
                    env["ST_DEV_PORT"] = str(dev_servers[tree].port)
                log_dir = root / "logs" / f"row-{index + 1}" / direction
                outcomes = run_row_direction(runner, tree, env, row, direction, log_dir, control=args.control)
                row_report["directions"].append(
                    {
                        "direction": direction,
                        "outcomes": [
                            {
                                "file": o.file,
                                "title": o.title,
                                "ok": o.ok,
                                "control_ok": o.control_ok,
                                "error": o.patched.error,
                                "control_error": o.control.error if o.control is not None else None,
                                "log_path": str(o.patched.log_path),
                            }
                            for o in outcomes
                        ],
                    }
                )
            rows_report.append(row_report)
    finally:
        for server in dev_servers.values():
            stop_dev_server(server)
        remove_sandboxes(runner, args.repo, sandboxes, keep=args.keep)

    _print_table(rows_report, as_json=args.json)
    all_ok = all(
        outcome["ok"]
        for row_report in rows_report
        for direction_report in row_report["directions"]
        for outcome in direction_report["outcomes"]
    )
    return 0 if all_ok else 1


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return run_all(args)
    except BreakCheckError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
