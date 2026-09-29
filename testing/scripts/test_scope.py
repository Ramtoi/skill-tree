#!/usr/bin/env python3
"""Selection and audit-scope tool for `testing/test-map.yaml` (PLAN.md revision 2).

Reads git history and the committed test map to answer two questions:

- `select`: given a change (a diff, or the working tree), which tests own
  the affected behavior and which CI runners does that require?
- `audit-scope`: given the committed `testing/audits/*/manifest.json`
  history, what is left to review for a structural test audit?

This tool never runs a test, never imports `hub`, never touches a real
home directory, and never launches an integration run. It only reads git
metadata and the tracked test map / mutation target files (plus, lazily
and defensively, `harness_validation.read_report` for manifest
recomputation — never `hub`). Every `--json` read exits 0 with a verdict
in the payload; usage errors exit 2.
"""

from __future__ import annotations

import argparse
import ast
import fnmatch
import hashlib
import io
import json
import os
import posixpath
import re
import shlex
import stat
import sys
import tarfile
import tempfile
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

REPO_ROOT = Path(__file__).resolve().parents[2]

# PyYAML lives in vendor/ next to hub.py (hub.py:21-23 does the same),
# never in the user site-packages: a test's faked $HOME would otherwise
# make this script unable to find it when spawned as a subprocess.
_VENDOR_DIR = REPO_ROOT / "vendor"
if _VENDOR_DIR.is_dir() and str(_VENDOR_DIR) not in sys.path:
    sys.path.insert(0, str(_VENDOR_DIR))

import yaml  # type: ignore[import-untyped]  # noqa: E402

RUNNER_KEYS = ["python", "vitest", "e2e", "cargo"]
FINDING_STATUSES = {"open", "fixed", "superseded", "reopened"}
FINDING_ID_RE = re.compile(r"^TA-(\d+)-[0-9a-f]{4}$")
# hub.py is the facade every CLI slice funnels through, and a large
# share of the suite does `import hub` for monkeypatching. It is a sink
# for the import-closure walk: recorded as a dependent, never expanded.
PY_GRAPH_SINKS = frozenset({"hub.py"})
SEMANTIC_FINGERPRINT_SCHEMA = 1
RECORD_SCHEMA = 2


class ToolError(Exception):
    """A usage error. Callers turn this into exit code 2."""


# --------------------------------------------------------------------- git


def _run_git(repo: Path, args: List[str]) -> Tuple[int, str, str]:
    import subprocess

    proc = subprocess.run(
        ["git", "-C", str(repo), *args],
        capture_output=True,
        text=True,
    )
    return proc.returncode, proc.stdout, proc.stderr


def git(repo: Path, *args: str) -> str:
    code, out, err = _run_git(repo, list(args))
    if code != 0:
        raise ToolError(f"git {' '.join(args)} failed: {err.strip()}")
    return out


def git_ok(repo: Path, *args: str) -> Tuple[bool, str]:
    code, out, _err = _run_git(repo, list(args))
    return code == 0, out


def is_shallow_repo(repo: Path) -> bool:
    ok, out = git_ok(repo, "rev-parse", "--is-shallow-repository")
    return ok and out.strip() == "true"


def is_dirty(repo: Path) -> bool:
    out = git(repo, "status", "--porcelain")
    for line in out.splitlines():
        if not line.strip():
            continue
        # Untracked files under DESIGN-*/ are scratch planning artifacts,
        # never part of "dirty" for audit purposes.
        if line.startswith("??") and line[3:].strip().startswith("DESIGN-"):
            continue
        return True
    return False


def rev_parse(repo: Path, rev: str) -> Optional[str]:
    ok, out = git_ok(repo, "rev-parse", rev)
    return out.strip() if ok else None


def is_ancestor(repo: Path, ancestor: str, rev: str) -> bool:
    ok, _out = git_ok(repo, "merge-base", "--is-ancestor", ancestor, rev)
    return ok


def commit_exists(repo: Path, rev: str) -> bool:
    """True when `rev` resolves to a real commit object.

    Plain `git rev-parse <sha>` echoes back a well-formed-looking 40-hex
    string even when no such object exists; `--verify` on the peeled
    `^{commit}` form is what actually checks the object database.
    """
    ok, _out = git_ok(repo, "rev-parse", "--verify", "--quiet", f"{rev}^{{commit}}")
    return ok


def blob_of_worktree(repo: Path, path: str) -> Optional[str]:
    """Blob sha of `path` as it stands on disk right now (dirty counts)."""
    full = repo / path
    if not full.exists():
        return None
    ok, out = git_ok(repo, "hash-object", "--", path)
    return out.strip() if ok else None


def blob_of_ref(repo: Path, path: str, ref: str) -> Optional[str]:
    ok, out = git_ok(repo, "rev-parse", f"{ref}:{path}")
    return out.strip() if ok else None


def parse_name_status(out: str) -> List[Tuple[str, str, Optional[str]]]:
    result: List[Tuple[str, str, Optional[str]]] = []
    for line in out.splitlines():
        if not line.strip():
            continue
        parts = line.split("\t")
        status = parts[0]
        if status.startswith("R") or status.startswith("C"):
            result.append((status, parts[1], parts[2]))
        else:
            result.append((status, parts[1], None))
    return result


def collect_changes(
    repo: Path, base: str, head: Optional[str], worktree: bool
) -> List[Tuple[str, str, Optional[str]]]:
    if worktree:
        out = git(repo, "diff", "--name-status", "-M", base)
        entries = parse_name_status(out)
        # ``git diff <base>`` includes staged additions and renames, while
        # ``git ls-files --others`` supplies only current, non-ignored
        # untracked files.  Walking an untracked directory from the status
        # output also walks ignored ``__pycache__`` files.
        ok, untracked = git_ok(repo, "ls-files", "--others", "--exclude-standard")
        known = {path for _status, old, new in entries for path in (old, new) if path}
        if ok:
            entries.extend(
                ("A", path, None)
                for path in untracked.splitlines()
                if path and path not in known
                and ((repo / path).exists() or (repo / path).is_symlink())
            )
        return entries
    args = ["diff", "--name-status", "-M", base]
    if head:
        args.append(head)
    return parse_name_status(git(repo, *args))


def list_tracked_files(repo: Path, ref: str = "HEAD") -> List[str]:
    ok, out = git_ok(repo, "ls-tree", "-r", "--name-only", ref)
    if not ok:
        return []
    return [line for line in out.splitlines() if line]


def list_working_files(repo: Path) -> List[str]:
    # The index is the source of truth for staged additions and renames; HEAD
    # can still contain the pre-migration paths.  ``--others`` adds current
    # untracked files while ``--exclude-standard`` keeps ignored build output
    # out of the import graph.  Preserve tracked symlinks even when their
    # targets are absent, since they are still source files in the checkout.
    ok, out = git_ok(repo, "ls-files", "--cached", "--others", "--exclude-standard")
    if not ok:
        return []
    return sorted(
        path
        for path in out.splitlines()
        if path and ((repo / path).exists() or (repo / path).is_symlink())
    )


def _read_snapshot_text(repo: Path, path: str, ref: Optional[str]) -> Optional[str]:
    if ref is None:
        try:
            return (repo / path).read_text(errors="ignore")
        except OSError:
            return None
    ok, out = git_ok(repo, "show", f"{ref}:{path}")
    return out if ok else None


def _snapshot_repo(repo: Path, ref: str, destination: Path) -> None:
    """Materialize one committed tree without consulting checkout files."""
    import subprocess

    proc = subprocess.run(
        ["git", "-C", str(repo), "archive", "--format=tar", ref],
        capture_output=True,
    )
    if proc.returncode != 0:
        raise ToolError(f"cannot read snapshot {ref}: {proc.stderr.decode(errors='replace').strip()}")
    with tarfile.open(fileobj=io.BytesIO(proc.stdout), mode="r:") as archive:
        archive.extractall(destination)


def _semantic_excluded(path: str, test_map: Dict[str, Any]) -> bool:
    reads = [pattern for row in cross_readers_of(test_map) for pattern in row.get("reads") or []]
    if any_glob_match(path, reads):
        return False
    if not any_glob_match(path, test_map.get("report_only") or []):
        return False
    # Report directories occasionally acquire executable helpers. Static
    # checks can read those even when the directory is otherwise inert.
    return not path.endswith((".py", ".pyi", ".js", ".jsx", ".ts", ".tsx", ".rs"))


def _worktree_git_entry(repo: Path, path: str) -> Tuple[str, str]:
    """Return effective Git mode/type and blob id from the filesystem."""
    import subprocess

    full = repo / path
    try:
        metadata = full.lstat()
        if stat.S_ISLNK(metadata.st_mode):
            mode = "120000:blob"
            content = os.fsencode(os.readlink(full))
        elif stat.S_ISREG(metadata.st_mode):
            executable = bool(metadata.st_mode & (stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH))
            mode = f"{'100755' if executable else '100644'}:blob"
            content = full.read_bytes()
        else:
            return "missing", "missing"
    except OSError:
        return "missing", "missing"
    proc = subprocess.run(
        ["git", "-C", str(repo), "hash-object", "--stdin"],
        input=content,
        capture_output=True,
    )
    object_id = proc.stdout.decode().strip() if proc.returncode == 0 else "missing"
    return mode, object_id


def semantic_fingerprint(
    repo: Path, ref: Optional[str] = None, worktree: bool = False
) -> Dict[str, Any]:
    """Identity of every effective input, including tree membership and mode."""
    if worktree == (ref is not None):
        raise ToolError("semantic_fingerprint requires exactly one of ref or worktree")

    map_text = _read_snapshot_text(repo, "testing/test-map.yaml", None if worktree else ref)
    if map_text is None:
        raise ToolError("missing testing/test-map.yaml in semantic snapshot")
    test_map = yaml.safe_load(map_text) or {}
    rows: List[Tuple[str, str, str]] = []
    excluded: List[str] = []
    if worktree:
        files = list_working_files(repo)
        for path in files:
            if _semantic_excluded(path, test_map):
                excluded.append(path)
                continue
            mode, object_id = _worktree_git_entry(repo, path)
            rows.append((path, mode, object_id))
    else:
        ok, raw = git_ok(repo, "ls-tree", "-r", ref or "")
        if not ok:
            raise ToolError(f"cannot list semantic snapshot {ref}")
        for line in raw.splitlines():
            meta, _, path = line.partition("\t")
            if not path:
                continue
            mode, object_type, object_id = meta.split()
            if _semantic_excluded(path, test_map):
                excluded.append(path)
                continue
            rows.append((path, f"{mode}:{object_type}", object_id))

    hasher = hashlib.sha256()
    hasher.update(f"semantic-input-v{SEMANTIC_FINGERPRINT_SCHEMA}\n".encode())
    for path, mode, object_id in sorted(rows):
        hasher.update(f"{path}\0{mode}\0{object_id}\n".encode())
    return {
        "schema_version": SEMANTIC_FINGERPRINT_SCHEMA,
        "fingerprint": hasher.hexdigest(),
        "input_count": len(rows),
        "excluded_paths": sorted(excluded),
    }


def _same_semantic_identity(left: Any, right: Any) -> bool:
    return (
        isinstance(left, dict)
        and isinstance(right, dict)
        and left.get("schema_version") == right.get("schema_version")
        and left.get("fingerprint") == right.get("fingerprint")
    )


# -------------------------------------------------------------- map load


def load_yaml(path: Path) -> Dict[str, Any]:
    return yaml.safe_load(path.read_text()) or {}


def load_test_map(repo: Path) -> Dict[str, Any]:
    path = repo / "testing" / "test-map.yaml"
    if not path.exists():
        raise ToolError(f"missing test map: {path}")
    return load_yaml(path)


def load_targets(repo: Path) -> Dict[str, Any]:
    path = repo / "mutation" / "targets.yaml"
    if not path.exists():
        raise ToolError(f"missing mutation targets: {path}")
    return load_yaml(path)


_BRACE_RE = re.compile(r"\{([^{}]+)\}")


def _expand_braces(pattern: str) -> List[str]:
    """Expand one level of shell-style `{a,b}` alternation in a glob.

    `fnmatch` has no brace syntax, and the map uses it (`*.{ts,tsx}`).
    Expand to the cross product of alternatives; patterns without braces
    pass through unchanged.
    """
    match = _BRACE_RE.search(pattern)
    if not match:
        return [pattern]
    prefix, suffix = pattern[: match.start()], pattern[match.end() :]
    options = match.group(1).split(",")
    expanded: List[str] = []
    for option in options:
        expanded.extend(_expand_braces(prefix + option + suffix))
    return expanded


def _expand_optional_leading_double_star(pattern: str) -> List[str]:
    """`**/` means "zero or more directories", so it must be optional.

    `fnmatch` has no directory awareness at all: `*` already matches `/`,
    so `**/*.md` still requires a LITERAL `/` in the text, and never
    matches a root file like `AGENTS.md`. Generate every variant with
    each `**/` occurrence present or absent (pathlib/gitignore
    semantics), so a root-level match is possible.
    """
    if "**/" not in pattern:
        return [pattern]
    parts = pattern.split("**/")
    variants = [parts[0]]
    for part in parts[1:]:
        variants = [v + sep + part for v in variants for sep in ("**/", "")]
    return variants


def glob_match(path: str, pattern: str) -> bool:
    candidates = [
        variant
        for braced in _expand_braces(pattern)
        for variant in _expand_optional_leading_double_star(braced)
    ]
    return any(fnmatch.fnmatch(path, p) for p in candidates)


def any_glob_match(path: str, patterns: Iterable[str]) -> bool:
    return any(glob_match(path, p) for p in patterns)


def cross_readers_of(test_map: Dict[str, Any]) -> List[Dict[str, Any]]:
    """`cross_readers` entries, each `{runner, path, reads}`."""
    return list(test_map.get("cross_readers", []) or [])


# --------------------------------------------------------------- kind

CONFIG_PATHS = {
    "pyproject.toml",
    "requirements.txt",
    "app/vitest.config.ts",
    "app/package.json",
    "app/package-lock.json",
    "app/src-tauri/Cargo.toml",
    "app/src-tauri/Cargo.lock",
    "app/src-tauri/tauri.conf.json",
    "mutation/targets.yaml",
    "testing/test-map.yaml",
}
CONFIG_GLOBS = ["app/tsconfig*.json"]
RUNNER_PATHS = {"app/playwright.config.ts", "app/src-tauri/build.rs"}


def classify_kind(path: str, test_map: Dict[str, Any]) -> str:
    if path.startswith("tests/fixtures/"):
        return "fixture"

    test_globs = [
        r.get("test_glob") for r in test_map.get("runners", {}).values() if r.get("test_glob")
    ]
    if any_glob_match(path, test_globs):
        return "test"
    if glob_match(path, "app/src-tauri/tests/**"):
        return "test"

    # A cross_reader's `reads` glob wins over report_only: a Markdown
    # file a test actually reads (a SKILL.md, the root AGENTS.md) is a
    # source, not inert, even though it also matches **/*.md.
    all_reads = [r for cr in test_map.get("cross_readers", []) or [] for r in cr.get("reads") or []]
    if any_glob_match(path, all_reads):
        return "source"

    report_only = test_map.get("report_only", [])
    if any_glob_match(path, report_only):
        return "report_only"

    if glob_match(path, ".github/workflows/**") or path == "scripts/ci-changed-areas.sh":
        return "workflow"

    if path in CONFIG_PATHS or any_glob_match(path, CONFIG_GLOBS):
        return "config"

    integration_catalog = (test_map.get("runners", {}).get("integration") or {}).get("catalog")
    if integration_catalog and path == integration_catalog:
        return "config"

    if path in RUNNER_PATHS:
        return "runner"

    if path.endswith(".py"):
        return "source"
    if glob_match(path, "connectors/**"):
        return "source"
    if glob_match(path, "app/src/**"):
        # Every file under app/src/** is a vitest/e2e-domain source, not
        # just .ts/.tsx — a stylesheet (headlessMachines.css) still feeds
        # a journey and an area, even with no import graph of its own.
        return "source"
    if glob_match(path, "app/src-tauri/**/*.rs"):
        return "source"
    if glob_match(path, "app/e2e/**"):
        # A non-spec file under app/e2e/** (a helper, a fixture module) is
        # e2e-domain source: it can change what every journey does, but it
        # has no import edge python/vitest/cargo can see and no reason to
        # broaden those runners. shared_infrastructure.e2e picks it up.
        return "source"

    return "unknown"


# --------------------------------------------------------------- targets


def find_group_for_path(path: str, targets: Dict[str, Any]) -> Optional[str]:
    for group_name, group in (targets.get("groups") or {}).items():
        for p in group.get("paths") or []:
            if path == p or path.startswith(p.rstrip("/") + "/"):
                return group_name
    return None


def is_hub_source_path(path: str, targets: Dict[str, Any]) -> bool:
    """True for hub's own shipped Python: `hub.py`, the connector
    compatibility shim, or anything under the `skill_hub/**` package.
    `testing/scripts/**` and
    `scripts/**` are `.py` too but never hub source — a change there
    cannot break `cargo test` (its command tests spawn the real
    `hub.py`) and is not evidence the integration suite needs a run.
    """
    if not path.endswith(".py"):
        return False
    if path == "hub.py" or path.startswith("skill_hub/") or path == "connectors/__init__.py":
        return True
    # Synthetic repositories used by the selector tests still exercise the
    # original root-module group shape. Keep that generic contract while the
    # real tree's domain modules live under skill_hub/.
    if "/" not in path:
        return find_group_for_path(path, targets) is not None
    return False


# --------------------------------------------------------- python graph


def _mutation_group_packages(targets: Dict[str, Any]) -> Set[str]:
    """Root package directories a mutation group owns (e.g. `connectors`),
    from `mutation/targets.yaml`'s `source_dirs` — the group `paths`
    entries name them without a `.py` suffix (`find_group_for_path`
    already handles that), but the import graph needs to know which
    root-level directories are packages at all, not top-level modules.
    """
    return set(targets.get("source_dirs") or [])


def _python_files(files: Iterable[str], targets: Optional[Dict[str, Any]] = None) -> Set[str]:
    """Every `.py` file the import graph should have a node for: a
    repo-root module, anything under `skill_hub/**`, or anything under a
    mutation-group package directory (`source_dirs` in
    `mutation/targets.yaml`, e.g. `skill_hub/infrastructure/connectors/transport/ssh.py`) — not
    just its own top-level `__init__.py`.
    """
    # Local helper modules are valid dependency nodes even when they live
    # outside mutation-owned packages (for example scripts/ or tests/).
    # Unrelated malformed fixtures do not broaden ordinary changes because
    # uncertainty is scoped to changed/reachable dependency candidates.
    return {f for f in files if f.endswith(".py")}


def _module_name_for_path(path: str) -> str:
    stem = path[:-3].replace("/", ".")
    return stem.removesuffix(".__init__")


def _extract_py_imports(text: str, importer: str) -> Tuple[List[Tuple[str, bool]], bool]:
    """Return module candidates and whether parsing succeeded.

    Imported attributes are candidates only when they resolve to a real local
    module. This keeps ``from module import symbol`` from manufacturing a
    missing-edge uncertainty while still supporting ``from . import helper``.
    """
    names: List[Tuple[str, bool]] = []
    try:
        tree = ast.parse(text)
    except SyntaxError:
        return names, False
    importer_module = _module_name_for_path(importer)
    package_parts = importer_module.split(".")
    if not importer.endswith("/__init__.py"):
        package_parts = package_parts[:-1]
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                names.append((alias.name, True))
        elif isinstance(node, ast.ImportFrom):
            if node.level:
                keep = max(0, len(package_parts) - node.level + 1)
                prefix = package_parts[:keep]
                if node.module:
                    prefix.extend(node.module.split("."))
                base = ".".join(prefix)
            else:
                base = node.module or ""
            if base:
                names.append((base, True))
            for alias in node.names:
                if alias.name != "*":
                    names.append((".".join(x for x in (base, alias.name) if x), False))
    return names, True


def _resolve_py_import(name: str, python_files: Set[str]) -> Set[str]:
    dotted = name.replace(".", "/")
    # The root connectors namespace remains a compatibility alias for the
    # relocated implementation. Attribute imports such as
    # `connectors.transport.ssh` therefore resolve to the canonical package
    # path in the graph, even though no duplicate implementation is shipped.
    if name.startswith("connectors."):
        canonical = (
            "skill_hub/infrastructure/connectors/"
            + name.removeprefix("connectors.").replace(".", "/")
        )
        for candidate in (canonical + ".py", canonical + "/__init__.py"):
            if candidate in python_files:
                leaf = candidate
                break
        else:
            leaf = None
    else:
        leaf = None
    for candidate in (
        dotted + ".py",
        f"{dotted}/__init__.py",  # `import connectors` (bare package)
        f"{name}.py",
    ):
        if candidate in python_files:
            leaf = candidate
            break
    if leaf is None:
        return set()
    result = {leaf}
    parts = name.split(".")
    for index in range(1, len(parts)):
        package_init = "/".join(parts[:index]) + "/__init__.py"
        if package_init in python_files:
            result.add(package_init)
    return result


def build_python_reverse_graph(
    repo: Path,
    python_files: Set[str],
    test_files: Set[str],
    uncertainty: Optional[List[Dict[str, str]]] = None,
) -> Dict[str, Set[str]]:
    """module -> set of files (source or test) that import it, directly."""
    reverse: Dict[str, Set[str]] = {}
    for f in sorted(python_files | test_files):
        full = repo / f
        if not full.exists():
            continue
        try:
            text = full.read_text(errors="ignore")
        except OSError:
            if uncertainty is not None:
                uncertainty.append({"reason": "python_unreadable", "path": f})
            continue
        names, parsed = _extract_py_imports(text, f)
        if not parsed and uncertainty is not None:
            uncertainty.append({"reason": "python_parse_failed", "path": f})
        local_roots = {path.split("/", 1)[0].removesuffix(".py") for path in python_files}
        for name, required in names:
            resolved = _resolve_py_import(name, python_files)
            namespace_exists = any(
                path.startswith(name.replace(".", "/") + "/") for path in python_files
            )
            if (
                required
                and not resolved
                and not namespace_exists
                and name.split(".", 1)[0] in local_roots
            ):
                if uncertainty is not None:
                    uncertainty.append(
                        {"reason": "python_local_import_unresolved", "path": f, "detail": name}
                    )
            for target in resolved:
                if target != f:
                    reverse.setdefault(target, set()).add(f)
    return reverse


def transitive_dependents(
    module: str, reverse_graph: Dict[str, Set[str]], sinks: Iterable[str] = ()
) -> Set[str]:
    """Every file that imports `module`, directly or transitively.

    A `sink` is recorded as a dependent but never expanded further: hub.py
    imports every CLI slice, and a huge share of the suite does
    `import hub` for `monkeypatch.setattr(hub, ...)`, so without this a
    one-slice change's closure balloons to most of the repository (110 of
    202 pytest files, observed) by walking THROUGH hub.py into every test
    that merely imports the facade for something unrelated.
    """
    sink_set = set(sinks)
    seen: Set[str] = set()
    queue = [module]
    while queue:
        cur = queue.pop()
        for dep in reverse_graph.get(cur, ()):
            if dep not in seen:
                seen.add(dep)
                if dep not in sink_set:
                    queue.append(dep)
    return seen


# ------------------------------------------------- facade / subprocess index


def build_facade_index(repo: Path, targets: Dict[str, Any]) -> Dict[str, str]:
    """symbol -> owning group, from the `from skill_hub.entrypoints.cli.<slice> import (...)`
    blocks at the bottom of `hub.py`. Symbols hub.py defines itself map to
    the `entry` group.
    """
    index: Dict[str, str] = {}
    hub_py = repo / "hub.py"
    if not hub_py.exists():
        return index
    try:
        tree = ast.parse(hub_py.read_text(errors="ignore"))
    except SyntaxError:
        return index
    for node in tree.body:
        if isinstance(node, ast.ImportFrom) and node.module and node.module.startswith(
            "skill_hub.entrypoints.cli."
        ):
            slice_name = node.module.split(".")[-1]
            group = find_group_for_path(f"skill_hub/entrypoints/cli/{slice_name}.py", targets)
            if group:
                for alias in node.names:
                    index[alias.asname or alias.name] = group
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            index.setdefault(node.name, "entry")
        elif isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name):
                    index.setdefault(target.id, "entry")
    return index


def build_subprocess_index(repo: Path, targets: Dict[str, Any]) -> Dict[str, str]:
    """subcommand word -> owning group, from a CLI slice's `NAME`."""
    index: Dict[str, str] = {}
    hub_cli_dir = repo / "skill_hub" / "entrypoints" / "cli"
    if not hub_cli_dir.exists():
        return index
    for f in sorted(hub_cli_dir.glob("*.py")):
        try:
            tree = ast.parse(f.read_text(errors="ignore"))
        except (SyntaxError, OSError):
            continue
        for node in tree.body:
            if isinstance(node, ast.Assign):
                for target in node.targets:
                    if (
                        isinstance(target, ast.Name)
                        and target.id == "NAME"
                        and isinstance(node.value, ast.Constant)
                        and isinstance(node.value.value, str)
                    ):
                        group = find_group_for_path(
                            f"skill_hub/entrypoints/cli/{f.stem}.py", targets
                        )
                        if group:
                            index[node.value.value] = group
    return index


_HUB_ATTR_RE = re.compile(r"\bhub\.(\w+)\b")


def _argv_string_list(node: ast.expr) -> Optional[List[str]]:
    """The string-literal elements of `node` if it is a list literal, else
    None — a non-literal element (`sys.executable`, a variable) is simply
    skipped, not disqualifying (`[sys.executable, "hub.py", "widget"]` is
    the common shape). AST-only, so a comment or a docstring mentioning
    the same words never contributes an element here.
    """
    if not isinstance(node, ast.List):
        return None
    elts = [e.value for e in node.elts if isinstance(e, ast.Constant) and isinstance(e.value, str)]
    return elts or None


def find_hub_argv_evidence(text: str) -> Tuple[bool, Set[str]]:
    """AST-only evidence (never a comment or a docstring) that a file
    spawns `hub.py` or calls `hub.main()` with a specific subcommand:
    (is_spawner, subcommand words present as argv string-literal
    elements next to that call). Three shapes count: a call whose
    list-literal argument contains `"hub.py"` (`subprocess.run(["python3",
    "hub.py", "hook", ...])`, `_run_hub_cli(["hook", ...])`); or a
    `hub.main()` call anywhere in the file alongside a `sys.argv = [...]`
    assignment.
    """
    try:
        tree = ast.parse(text)
    except SyntaxError:
        return False, set()

    call_lists: List[List[str]] = []
    argv_lists: List[List[str]] = []
    has_hub_main = False

    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            func = node.func
            if (
                isinstance(func, ast.Attribute)
                and func.attr == "main"
                and isinstance(func.value, ast.Name)
                and func.value.id == "hub"
            ):
                has_hub_main = True
            for arg in list(node.args) + [kw.value for kw in node.keywords]:
                elts = _argv_string_list(arg)
                if elts:
                    call_lists.append(elts)
        elif isinstance(node, ast.Assign):
            targets_argv = any(
                (isinstance(t, ast.Attribute) and t.attr == "argv")
                or (isinstance(t, ast.Name) and t.id == "argv")
                for t in node.targets
            )
            if targets_argv:
                elts = _argv_string_list(node.value)
                if elts:
                    argv_lists.append(elts)

    is_spawner = False
    words: Set[str] = set()
    for lst in call_lists:
        if any("hub.py" in s for s in lst):
            is_spawner = True
            words.update(lst)
    if has_hub_main:
        for lst in argv_lists:
            is_spawner = True
            words.update(lst)

    return is_spawner, words


def compute_hub_reference_hits(
    repo: Path,
    python_test_files: Set[str],
    facade_index: Dict[str, str],
    subprocess_index: Dict[str, str],
) -> Tuple[Dict[str, Set[str]], Set[str]]:
    """Returns (group -> owning tests via facade/subprocess, pure-spawner
    composition tests with no recognizable subcommand)."""
    group_tests: Dict[str, Set[str]] = {}
    composition: Set[str] = set()
    for t in python_test_files:
        full = repo / t
        if not full.exists():
            continue
        text = full.read_text(errors="ignore")
        hit_groups: Set[str] = set()
        for match in _HUB_ATTR_RE.finditer(text):
            group = facade_index.get(match.group(1))
            if group:
                hit_groups.add(group)
        is_spawner, argv_words = find_hub_argv_evidence(text)
        subcommand_hit = False
        if is_spawner:
            for word, group in subprocess_index.items():
                if word in argv_words:
                    hit_groups.add(group)
                    subcommand_hit = True
            if not subcommand_hit:
                composition.add(t)
        for group in hit_groups:
            group_tests.setdefault(group, set()).add(t)
    return group_tests, composition


# ------------------------------------------------------------- build.rs


def parse_build_rs_rerun_inputs(repo: Path, rel_path: str) -> Set[str]:
    """Python module names build.rs re-runs on, from its literal `.py`
    string constants (both `repo_root.join("x.py")` and list entries)."""
    full = repo / rel_path
    if not full.exists():
        return set()
    text = full.read_text(errors="ignore")
    return set(re.findall(r'"([\w./]+\.py)"', text))


# ------------------------------------------------------------------ ts graph


def _ts_files(files: Iterable[str]) -> Set[str]:
    return {
        f
        for f in files
        if f.startswith("app/src/") and (f.endswith(".ts") or f.endswith(".tsx"))
    }


def _ts_asset_files(files: Iterable[str]) -> Set[str]:
    """Static frontend assets that TypeScript can import by relative path."""
    return {
        f
        for f in files
        if f.endswith((".css", ".json"))
    }


_TS_IMPORT_RE = re.compile(
    r"""(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)['"`]([^'"`]+)['"`]"""
)


def _ts_without_comments(text: str) -> str:
    """Blank TS comments while preserving strings and character offsets."""
    chars = list(text)
    i = 0
    quote: Optional[str] = None
    while i < len(chars):
        char = chars[i]
        if quote:
            if char == "\\":
                i += 2
                continue
            if char == quote:
                quote = None
            i += 1
            continue
        if char in ("'", '"', "`"):
            quote = char
            i += 1
            continue
        if text.startswith("//", i):
            end = text.find("\n", i)
            end = len(chars) if end < 0 else end
            chars[i:end] = " " * (end - i)
            i = end
            continue
        if text.startswith("/*", i):
            end = text.find("*/", i + 2)
            end = len(chars) if end < 0 else end + 2
            chars[i:end] = " " * (end - i)
            i = end
            continue
        i += 1
    return "".join(chars)


def _ts_dynamic_imports(text: str) -> List[Tuple[Optional[str], bool]]:
    """Return actual dynamic imports as (literal specifier, computed)."""
    source = _ts_without_comments(text)
    result: List[Tuple[Optional[str], bool]] = []

    def in_jsx_text(offset: int) -> bool:
        last_close = source.rfind(">", 0, offset)
        if last_close < 0:
            return False
        last_open = source.rfind("<", 0, last_close)
        if last_open < 0:
            return False
        tag = source[last_open : last_close + 1]
        stripped_tag = tag.strip()
        if (
            not re.fullmatch(r"</?[A-Za-z][^>]*>", stripped_tag)
            or stripped_tag.startswith("</")
            or stripped_tag.endswith("/>")
        ):
            return False
        since_tag = source[last_close + 1 : offset]
        visible = since_tag.lstrip()
        return bool(
            visible
            and (visible[0].isalpha() or visible[0] in "'")
            and "<" not in since_tag
            and "{" not in since_tag
            and ";" not in since_tag
        )

    def template_expressions(offset: int) -> Tuple[List[str], int]:
        expressions: List[str] = []
        cursor = offset + 1
        while cursor < len(source):
            if source[cursor] == "\\":
                cursor += 2
                continue
            if source[cursor] == "`":
                return expressions, cursor + 1
            if source.startswith("${", cursor):
                start = cursor + 2
                cursor = start
                depth = 1
                nested_quote: Optional[str] = None
                while cursor < len(source) and depth:
                    char = source[cursor]
                    if nested_quote:
                        if char == "\\":
                            cursor += 2
                            continue
                        if char == nested_quote:
                            nested_quote = None
                    elif char in ("'", '"', "`"):
                        nested_quote = char
                    elif char == "{":
                        depth += 1
                    elif char == "}":
                        depth -= 1
                        if depth == 0:
                            expressions.append(source[start:cursor])
                    cursor += 1
                continue
            cursor += 1
        return expressions, cursor

    i = 0
    quote: Optional[str] = None
    while i < len(source):
        char = source[i]
        if quote:
            if char == "\\":
                i += 2
                continue
            if char == quote:
                quote = None
            i += 1
            continue
        if char == "`":
            expressions, i = template_expressions(i)
            for expression in expressions:
                result.extend(_ts_dynamic_imports(expression))
            continue
        if char in ("'", '"'):
            quote = char
            i += 1
            continue
        if source.startswith("import", i):
            before_ok = i == 0 or not (
                source[i - 1].isalnum() or source[i - 1] in "_$."
            )
            end_word = i + len("import")
            after_ok = end_word == len(source) or not (
                source[end_word].isalnum() or source[end_word] in "_$"
            )
            cursor = end_word
            while cursor < len(source) and source[cursor].isspace():
                cursor += 1
            if (
                before_ok
                and not in_jsx_text(i)
                and after_ok
                and cursor < len(source)
                and source[cursor] == "("
            ):
                cursor += 1
                while cursor < len(source) and source[cursor].isspace():
                    cursor += 1
                if cursor < len(source) and source[cursor] in ("'", '"', "`"):
                    delimiter = source[cursor]
                    cursor += 1
                    start = cursor
                    escaped = False
                    while cursor < len(source):
                        if source[cursor] == delimiter and not escaped:
                            break
                        escaped = source[cursor] == "\\" and not escaped
                        if source[cursor] != "\\":
                            escaped = False
                        cursor += 1
                    specifier = source[start:cursor]
                    computed = delimiter == "`" and "${" in specifier
                    result.append((None if computed else specifier, computed))
                else:
                    result.append((None, True))
                i = min(cursor + 1, len(source))
                continue
        i += 1
    return result


def _extract_ts_imports(text: str) -> Set[str]:
    source = _ts_without_comments(text)
    return {spec for spec in _TS_IMPORT_RE.findall(source) if "${" not in spec}


def _ts_relative_base(spec: str, importer: str) -> Optional[str]:
    if spec.startswith("@/"):
        base = "app/src/" + spec[2:]
    elif spec.startswith("."):
        importer_dir = posixpath.dirname(importer)
        base = posixpath.normpath(posixpath.join(importer_dir, spec))
    else:
        return None
    # Query/hash suffixes are bundler syntax, not part of the repository path.
    # They remain unsupported below, but normalizing them lets a changed asset
    # still trigger the conservative uncertainty fallback.
    base = re.split(r"[?#]", base, maxsplit=1)[0]
    for emitted_suffix in (".js", ".jsx", ".mjs", ".cjs"):
        if base.endswith(emitted_suffix):
            base = base[: -len(emitted_suffix)]
            break
    return base.replace("\\", "/")


def _resolve_ts_import(
    spec: str,
    importer: str,
    ts_files: Set[str],
    asset_files: Optional[Set[str]] = None,
) -> Optional[str]:
    base = _ts_relative_base(spec, importer)
    if base is None:
        return None  # external package
    for suffix in ("", ".ts", ".tsx", "/index.ts", "/index.tsx"):
        candidate = base + suffix
        if candidate in ts_files:
            return candidate
    # Asset imports must name their supported extension. Query/hash forms and
    # extensionless guesses stay unresolved so changed inputs take the safe
    # broadening path instead of being treated as a proven edge.
    if not re.search(r"[?#]", spec) and base.endswith((".css", ".json")):
        if base in (asset_files or set()):
            return base
    return None


def build_ts_reverse_graph(
    repo: Path,
    ts_files: Set[str],
    uncertainty: Optional[List[Dict[str, str]]] = None,
    asset_files: Optional[Set[str]] = None,
) -> Dict[str, Set[str]]:
    reverse: Dict[str, Set[str]] = {}
    for f in sorted(ts_files):
        full = repo / f
        if not full.exists():
            continue
        try:
            text = full.read_text(errors="ignore")
        except OSError:
            if uncertainty is not None:
                uncertainty.append({"reason": "typescript_unreadable", "path": f})
            continue
        for spec in _extract_ts_imports(text):
            target = _resolve_ts_import(spec, f, ts_files, asset_files)
            if target and target != f:
                reverse.setdefault(target, set()).add(f)
            elif spec.startswith((".", "@/")) and uncertainty is not None:
                candidate = _ts_relative_base(spec, f) or spec
                uncertainty.append(
                    {
                        "reason": "typescript_local_import_unresolved",
                        "path": f,
                        "detail": spec,
                        "candidate": candidate,
                    }
                )
        for _specifier, computed in _ts_dynamic_imports(text):
            if computed and uncertainty is not None:
                uncertainty.append({"reason": "typescript_dynamic_import_unresolved", "path": f})
    return reverse


def area_for_ts_path(path: str, app_map: Dict[str, Any]) -> Optional[str]:
    for area_name, area in (app_map.get("areas") or {}).items():
        if any_glob_match(path, area.get("sources") or []):
            return area_name
    return None


def mock_owners_of(test_map: Dict[str, Any]) -> Dict[str, List[str]]:
    """`app.mock_owners`: mock file -> the areas whose journeys reach its
    exported commands or data (TA-1-4e14). A mock not listed here, and not
    itself `shared_infrastructure`, is unowned: a change to it still
    broadens (the `mock_hit` fallback in `handle_fixture`/`handle_path`)."""
    return dict((test_map.get("app") or {}).get("mock_owners") or {})


def e2e_files_naming(repo: Path, path: str, all_files: Iterable[str]) -> Set[str]:
    """Every file under `app/e2e/**` whose text names the mock at `path` by
    its module stem (`mocks/<stem>`). An e2e spec reaches an attributed
    mock's data through the real running app (a scene flag, a fixture),
    almost never an import, so this is a text scan — the same technique
    `handle_fixture`'s `text_contains_any` already uses for fixture
    consumers — rather than an import-graph lookup."""
    needle = f"mocks/{Path(path).stem}"
    hits: Set[str] = set()
    for f in all_files:
        if not glob_match(f, "app/e2e/**"):
            continue
        full = repo / f
        if not full.exists():
            continue
        try:
            text = full.read_text(errors="ignore")
        except OSError:
            continue
        if needle in text:
            hits.add(f)
    return hits


def resolve_journey_specs(journey: str, e2e_test_files: Set[str]) -> Set[str]:
    """A journey name (possibly a `*` glob, e.g. `usage-*`) to the real
    `app/e2e/*.spec.ts` files it names — without this, journeys select no
    runner at all and a single app source change yields no Playwright
    command."""
    patterns = [f"app/e2e/{journey}.spec.ts", f"app/e2e/{journey}.journey.spec.ts"]
    return {f for f in e2e_test_files if any(glob_match(f, p) for p in patterns)}


# ------------------------------------------------------------ selection


def text_contains_any(text: str, needles: Iterable[str]) -> bool:
    return any(n in text for n in needles)


def fixture_parent_candidates(path: str) -> List[str]:
    parts_path = Path(path)
    candidates = [path]
    cur = parts_path.parent
    while str(cur) not in (".", "tests"):
        candidates.append(str(cur))
        if cur == cur.parent:
            break
        cur = cur.parent
    return candidates


# --- argv command construction (F9) ---------------------------------


def _split_env_and_argv(tokens: List[str]) -> Tuple[Dict[str, str], List[str]]:
    env: Dict[str, str] = {}
    i = 0
    assignment_re = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
    while i < len(tokens) and assignment_re.match(tokens[i]):
        key, _, value = tokens[i].partition("=")
        env[key] = value
        i += 1
    return env, tokens[i:]


def _template_to_argv_cwd_env(template: str) -> Tuple[List[str], Optional[str], Dict[str, str]]:
    if "&&" in template:
        parts = [p.strip() for p in template.split("&&")]
        cwd = None
        for p in parts[:-1]:
            if p.startswith("cd "):
                cwd = p[3:].strip()
        tokens = shlex.split(parts[-1])
    else:
        cwd = None
        tokens = shlex.split(template)
    env, argv = _split_env_and_argv(tokens)
    return argv, cwd, env


def _substitute_repeated(argv: List[str], placeholder: str, items: List[str]) -> List[str]:
    result: List[str] = []
    for i, tok in enumerate(argv):
        if tok != placeholder:
            result.append(tok)
            continue
        if i > 0 and argv[i - 1].startswith("--") and result and result[-1] == argv[i - 1]:
            flag = result.pop()
            for item in items:
                result.append(flag)
                result.append(item)
        else:
            result.extend(items)
    return result


def _drop_placeholder(argv: List[str], placeholder: str) -> List[str]:
    """Remove a bare `{files}`-style token entirely: a broadened runner's
    "run everything" invocation takes no file arguments at all."""
    return [tok for tok in argv if tok != placeholder]


def _relative_to_cwd(paths: Iterable[str], cwd: Optional[str]) -> List[str]:
    """Repo-relative selection paths, made relative to the command's own
    `cwd` (e.g. `app`) so the resulting argv actually resolves there."""
    if not cwd:
        return sorted(paths)
    prefix = cwd.rstrip("/") + "/"
    return sorted(p[len(prefix) :] if p.startswith(prefix) else p for p in paths)


def build_commands(
    test_map: Dict[str, Any], selections: Dict[str, Any], broaden: Dict[str, Optional[str]]
) -> List[Dict[str, Any]]:
    runners = test_map.get("runners", {})
    commands: List[Dict[str, Any]] = []

    if selections.get("python") or broaden.get("python"):
        argv, cwd, env = _template_to_argv_cwd_env(runners.get("python", {}).get("command", ""))
        if broaden.get("python"):
            argv = _substitute_repeated(argv, "{selectors}", ["tests/"])
        else:
            argv = _substitute_repeated(argv, "{selectors}", sorted(selections["python"]))
        commands.append({"runner": "python", "argv": argv, "cwd": cwd, "env": env})

    if selections.get("vitest") or broaden.get("vitest"):
        argv, cwd, env = _template_to_argv_cwd_env(runners.get("vitest", {}).get("command", ""))
        if broaden.get("vitest"):
            argv = _drop_placeholder(argv, "{files}")
        else:
            files = _relative_to_cwd(selections["vitest"], cwd)
            argv = _substitute_repeated(argv, "{files}", files)
        commands.append({"runner": "vitest", "argv": argv, "cwd": cwd, "env": env})

    e2e_files = [x for x in selections.get("e2e", []) if x.endswith(".spec.ts")]
    if e2e_files or broaden.get("e2e"):
        argv, cwd, env = _template_to_argv_cwd_env(runners.get("e2e", {}).get("command", ""))
        if broaden.get("e2e"):
            argv = _drop_placeholder(argv, "{files}")
        else:
            files = _relative_to_cwd(e2e_files, cwd)
            argv = _substitute_repeated(argv, "{files}", files)
        commands.append({"runner": "e2e", "argv": argv, "cwd": cwd, "env": env})

    if selections.get("cargo"):
        argv, cwd, env = _template_to_argv_cwd_env(runners.get("cargo", {}).get("command", ""))
        commands.append({"runner": "cargo", "argv": argv, "cwd": cwd, "env": env})

    if selections.get("integration"):
        argv, cwd, env = _template_to_argv_cwd_env(
            runners.get("integration", {}).get("command", "")
        )
        argv = _substitute_repeated(argv, "{cases}", sorted(selections["integration"]))
        # `{tmp}` is an isolated-home placeholder, never a literal path: a
        # fresh directory per selection, shared by HOME/SKILL_HUB_HOME/
        # PYTHONUSERBASE and the evidence dir, exactly like a real
        # `hub integration validate` run needs (docs/agents/recovery.md).
        tmp_home = tempfile.mkdtemp(prefix="skt-integration-home-")
        env = {k: (tmp_home if v == "{tmp}" else v) for k, v in env.items()}
        argv = [tmp_home if t == "{evidence}" else t for t in argv]
        commands.append({"runner": "integration", "argv": argv, "cwd": cwd, "env": env})

    return commands


def build_static_commands(
    test_map: Dict[str, Any],
    changed_paths: Iterable[str],
    selections: Dict[str, Any],
) -> List[Dict[str, Any]]:
    """Return applicable static checks without changing test ``commands``."""
    paths = list(changed_paths)
    active = {
        "python": any(path.endswith(".py") for path in paths)
        or bool(selections.get("python")),
        "vitest": any(path.startswith("app/") for path in paths)
        or bool(selections.get("vitest"))
        or bool(selections.get("e2e")),
    }
    commands: List[Dict[str, Any]] = []
    seen: Set[Tuple[Tuple[str, ...], Optional[str], Tuple[Tuple[str, str], ...]]] = set()
    for runner in ("python", "vitest"):
        if not active[runner]:
            continue
        definitions = ((test_map.get("runners") or {}).get(runner) or {}).get("static") or []
        if not isinstance(definitions, list) or not all(isinstance(item, str) for item in definitions):
            raise ToolError(f"runners.{runner}.static must be a list of command strings")
        for index, definition in enumerate(definitions):
            parts = [part.strip() for part in definition.split("&&")]
            if len(parts) > 2 or (len(parts) == 2 and shlex.split(parts[0])[:1] != ["cd"]):
                raise ToolError(f"unsupported runners.{runner}.static command: {definition}")
            if len(parts) == 2 and len(shlex.split(parts[0])) != 2:
                raise ToolError(f"unsupported runners.{runner}.static command: {definition}")
            argv, cwd, env = _template_to_argv_cwd_env(definition)
            shell_tokens = {"|", "||", ";", ">", ">>", "<", "&"}
            if (
                not argv
                or any("{" in token or "}" in token for token in argv)
                or any(token in shell_tokens for token in argv)
            ):
                raise ToolError(f"unsupported runners.{runner}.static command: {definition}")
            identity = (tuple(argv), cwd, tuple(sorted(env.items())))
            if identity in seen:
                continue
            seen.add(identity)
            commands.append(
                {
                    "id": f"{runner}-static-{index + 1}",
                    "runner": f"{runner}-static",
                    "argv": argv,
                    "cwd": cwd,
                    "env": env,
                }
            )
    return commands


# --------------------------------------------------------- obligations

_SUBPARSER_METHODS = ("add_subparsers", "add_parser")


def subparser_paths(text: str) -> Set[Tuple[str, ...]]:
    """Every argparse subcommand PATH an `add_parser` call declares in
    `text`: a top-level `sub.add_parser("list")` gives `("list",)`; a
    nested `harn_sub.add_parser("emit-schema")`, where `harn_sub` came
    from `p_harn.add_subparsers()` and `p_harn` from
    `sub.add_parser("harnesses")`, gives `("harnesses", "emit-schema")`.

    AST-only, single pass over `Call` nodes in source order (`lineno`,
    `col_offset`), tracking two name -> path maps as it goes: `parsers`
    (a parser variable's own path) and `subs` (the path a subparser-action
    variable's future `add_parser` calls extend). Only the plain
    `X.method(...)` shape is recognized — `X` must be a bare name. A
    variable never seen as an assignment target (a function parameter,
    such as `sub` in `def register(sub): ...`) defaults to the empty path,
    i.e. top level — the same as a name that was never an
    `add_subparsers()` result. A non-literal first argument (the `alias`
    loop in `skill_hub/entrypoints/cli/agent_docs.py`, where `alias` is a
    loop variable, not a string) is skipped: no path, no `parsers` entry.
    """
    try:
        tree = ast.parse(text)
    except SyntaxError:
        return set()

    assign_target: Dict[int, str] = {}
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.Assign)
            and len(node.targets) == 1
            and isinstance(node.targets[0], ast.Name)
        ):
            assign_target[id(node.value)] = node.targets[0].id

    calls = [
        n
        for n in ast.walk(tree)
        if isinstance(n, ast.Call)
        and isinstance(n.func, ast.Attribute)
        and n.func.attr in _SUBPARSER_METHODS
        and isinstance(n.func.value, ast.Name)
    ]
    calls.sort(key=lambda n: (n.lineno, n.col_offset))

    parsers: Dict[str, Tuple[str, ...]] = {}
    subs: Dict[str, Tuple[str, ...]] = {}
    paths: Set[Tuple[str, ...]] = set()

    for call in calls:
        assert isinstance(call.func, ast.Attribute) and isinstance(call.func.value, ast.Name)
        obj_name = call.func.value.id
        target = assign_target.get(id(call))
        if call.func.attr == "add_subparsers":
            if target:
                subs[target] = parsers.get(obj_name, ())
            continue
        if not call.args:
            continue
        first = call.args[0]
        if not (isinstance(first, ast.Constant) and isinstance(first.value, str)):
            continue
        path = subs.get(obj_name, ()) + (first.value,)
        paths.add(path)
        if target:
            parsers[target] = path

    return paths


def argv_sequences(text: str) -> List[List[str]]:
    """Every ordered run of string-literal elements from a `List`/`Tuple`
    literal, or of string-literal POSITIONAL arguments of a `Call`
    (`_run(monkeypatch, capsys, "hook", "list")` -> `["hook", "list"]`,
    skipping the leading non-string fixtures) — one sequence per node, in
    source order not required. AST-only: a comment or a docstring
    mentioning the same words never contributes here."""
    try:
        tree = ast.parse(text)
    except SyntaxError:
        return []
    sequences: List[List[str]] = []
    for node in ast.walk(tree):
        if isinstance(node, (ast.List, ast.Tuple)):
            strs = [e.value for e in node.elts if isinstance(e, ast.Constant) and isinstance(e.value, str)]
            if strs:
                sequences.append(strs)
        elif isinstance(node, ast.Call):
            strs = [a.value for a in node.args if isinstance(a, ast.Constant) and isinstance(a.value, str)]
            if strs:
                sequences.append(strs)
    return sequences


def _contiguous_subsequence(sequence: List[str], path: Tuple[str, ...]) -> bool:
    n = len(path)
    if n == 0 or n > len(sequence):
        return False
    return any(tuple(sequence[i : i + n]) == path for i in range(len(sequence) - n + 1))


def _find_argv_evidence(
    repo: Path,
    path: Tuple[str, ...],
    python_test_files: Iterable[str],
    cache: Optional[Dict[str, List[List[str]]]] = None,
) -> List[str]:
    """`cache` (test file -> its `argv_sequences`) lets one `compute_obligations`
    call parse each test file once, not once per new subcommand."""
    if cache is None:
        cache = {}
    evidence: List[str] = []
    for t in sorted(python_test_files):
        if t not in cache:
            full = repo / t
            try:
                cache[t] = argv_sequences(full.read_text(errors="ignore")) if full.exists() else []
            except OSError:
                cache[t] = []
        if any(_contiguous_subsequence(seq, path) for seq in cache[t]):
            evidence.append(t)
    return evidence


def _read_subparser_paths(full: Path) -> Set[Tuple[str, ...]]:
    if not full.exists():
        return set()
    try:
        return subparser_paths(full.read_text(errors="ignore"))
    except OSError:
        return set()


def _find_waiver(
    waivers: Iterable[Dict[str, Any]], kind: str, path: str, subcommand: Optional[str] = None
) -> Optional[Dict[str, Any]]:
    for w in waivers:
        if w.get("kind") != kind or w.get("path") != path:
            continue
        if kind == "argv_evidence" and w.get("subcommand") != subcommand:
            continue
        # A waiver with no reason (empty string, whitespace-only, or the
        # key missing) is not a real waiver — a reasoned exception is the
        # whole point (testing/test-map.yaml's `obligations_waived`
        # comment), so treat it as absent and fall through to the normal
        # met/unmet evidence check instead of silently waiving the item.
        if not str(w.get("reason") or "").strip():
            continue
        return w
    return None


def compute_obligations(
    repo: Path,
    base_repo: Optional[Path],
    test_map: Dict[str, Any],
    added: Set[str],
    touched: Set[str],
    ts_reverse: Dict[str, Set[str]],
    vitest_test_files: Set[str],
    python_test_files: Set[str],
    base_files: Iterable[str] = (),
    renamed_from: Optional[Dict[str, str]] = None,
) -> List[Dict[str, Any]]:
    """Conservative selector obligations: a NEW screen/component needs a
    direct vitest importer; a NEW CLI subparser needs argv evidence in a
    Python test. Missing the `obligations` map key turns this off
    entirely — an unconfigured repository (every synthetic-repo test
    fixture that predates TA-1-obligations) behaves exactly as before.

    "New" means absent from EVERY `subparser_sources` file at base
    (`base_files`), not just from the same path: a renamed CLI module
    (`renamed_from`, new path -> base path) or a subcommand moved between
    two modules declares nothing new, and must not demand argv evidence
    for every subcommand it carries."""
    config = test_map.get("obligations")
    if not config:
        return []
    waivers = test_map.get("obligations_waived") or []
    items: List[Dict[str, Any]] = []

    component_sources = config.get("component_sources") or []
    for p in sorted(added):
        if not any_glob_match(p, component_sources):
            continue
        evidence = sorted(ts_reverse.get(p, set()) & vitest_test_files)
        waiver = _find_waiver(waivers, "vitest_importer", p)
        if waiver:
            status, reason = "waived", str(waiver.get("reason") or "")
        elif evidence:
            status, reason = "met", ""
        else:
            status, reason = "unmet", "no vitest test file imports this new component directly"
        items.append(
            {
                "kind": "vitest_importer",
                "path": p,
                "status": status,
                "evidence": evidence,
                "reason": reason,
            }
        )

    subparser_sources = config.get("subparser_sources") or []
    if base_repo is not None:
        base_known: Set[Tuple[str, ...]] = set()
        for b in sorted(base_files):
            if b.endswith(".py") and any_glob_match(b, subparser_sources):
                base_known |= _read_subparser_paths(base_repo / b)
        argv_cache: Dict[str, List[List[str]]] = {}
        for p in sorted(touched):
            if not p.endswith(".py") or not any_glob_match(p, subparser_sources):
                continue
            head_full = repo / p
            if not head_full.exists():
                continue
            try:
                head_text = head_full.read_text(errors="ignore")
            except OSError:
                continue
            # The same path and the rename source are read directly as well,
            # so an empty `base_files` (an unreadable base snapshot) still
            # sees the file's own history.
            known = base_known | _read_subparser_paths(base_repo / p)
            source = (renamed_from or {}).get(p)
            if source:
                known |= _read_subparser_paths(base_repo / source)
            new_paths = subparser_paths(head_text) - known
            for path in sorted(new_paths):
                subcommand = " ".join(path)
                evidence = _find_argv_evidence(repo, path, python_test_files, argv_cache)
                waiver = _find_waiver(waivers, "argv_evidence", p, subcommand)
                if waiver:
                    status, reason = "waived", str(waiver.get("reason") or "")
                elif evidence:
                    status, reason = "met", ""
                else:
                    status, reason = "unmet", f"no python test asserts the argv sequence for {subcommand!r}"
                items.append(
                    {
                        "kind": "argv_evidence",
                        "path": p,
                        "subcommand": subcommand,
                        "status": status,
                        "evidence": evidence,
                        "reason": reason,
                    }
                )

    return items


class OwnershipGraphs:
    """The import-graph/index building blocks `select` and the area-test
    ownership computation both need, over one file set. Building these is
    not cheap (a full-repo AST walk); computed once and shared.
    """

    def __init__(self, repo: Path, test_map: Dict[str, Any], targets: Dict[str, Any], all_files: List[str]):
        self.uncertainty: List[Dict[str, str]] = []
        self.python_files = _python_files(all_files, targets)
        self.python_test_files = {f for f in all_files if glob_match(f, "tests/test_*.py")}
        self.ts_files = _ts_files(all_files)
        self.ts_asset_files = _ts_asset_files(all_files)
        self.vitest_test_files = {
            f for f in self.ts_files if f.endswith(".test.ts") or f.endswith(".test.tsx")
        }
        self.e2e_test_files = {f for f in all_files if glob_match(f, "app/e2e/*.spec.ts")}
        self.py_reverse = build_python_reverse_graph(
            repo, self.python_files, self.python_test_files, self.uncertainty
        )
        self.ts_reverse = build_ts_reverse_graph(
            repo, self.ts_files, self.uncertainty, self.ts_asset_files
        )
        self.facade_index = build_facade_index(repo, targets)
        self.subprocess_index = build_subprocess_index(repo, targets)
        self.group_tests_from_hub, self.spawner_composition = compute_hub_reference_hits(
            repo, self.python_test_files, self.facade_index, self.subprocess_index
        )


def select(repo: Path, base: str, head: Optional[str], worktree: bool) -> Dict[str, Any]:
    """Select against exact endpoint snapshots, unioning old/new graphs."""
    base_commit = rev_parse(repo, base)
    if base_commit is None or not commit_exists(repo, base):
        return _select(repo, repo, None, base, head, worktree)
    with tempfile.TemporaryDirectory(prefix="skt-scope-base-") as base_tmp:
        base_repo = Path(base_tmp)
        _snapshot_repo(repo, base_commit, base_repo)
        if worktree:
            return _select(repo, repo, base_repo, base, head, worktree)
        effective_ref = head or "HEAD"
        if not commit_exists(repo, effective_ref):
            return _select(repo, repo, base_repo, base, head, worktree)
        with tempfile.TemporaryDirectory(prefix="skt-scope-head-") as head_tmp:
            head_repo = Path(head_tmp)
            _snapshot_repo(repo, effective_ref, head_repo)
            return _select(repo, head_repo, base_repo, base, head, worktree)


def _merge_reverse(
    current: Dict[str, Set[str]], previous: Dict[str, Set[str]]
) -> Dict[str, Set[str]]:
    merged = {key: set(value) for key, value in current.items()}
    for key, value in previous.items():
        merged.setdefault(key, set()).update(value)
    return merged


def _union_snapshot_config(current: Any, previous: Any) -> Any:
    if isinstance(current, dict) and isinstance(previous, dict):
        merged = {
            key: _union_snapshot_config(value, previous[key])
            if key in previous
            else value
            for key, value in current.items()
        }
        merged.update({key: value for key, value in previous.items() if key not in current})
        return merged
    if isinstance(current, list) and isinstance(previous, list):
        return current + [item for item in previous if item not in current]
    return current


def _select(
    source_repo: Path,
    repo: Path,
    base_repo: Optional[Path],
    base: str,
    head: Optional[str],
    worktree: bool,
) -> Dict[str, Any]:
    test_map = load_test_map(repo)
    targets = load_targets(repo)
    base_map: Optional[Dict[str, Any]] = None
    base_targets: Optional[Dict[str, Any]] = None
    if base_repo is not None:
        base_map = load_test_map(base_repo)
        base_targets = load_targets(base_repo)
        test_map = _union_snapshot_config(test_map, base_map)
        targets = _union_snapshot_config(targets, base_targets)
    cross_readers = cross_readers_of(test_map)
    mock_owners = mock_owners_of(test_map)

    # Missing history (a shallow CI checkout, a typo, a squashed base) must
    # not abort silently or select nothing. Treat the base as unknown: broaden
    # every runner and say why.
    base_ok, _ = git_ok(source_repo, "rev-parse", "--verify", "--quiet", f"{base}^{{commit}}")
    base_unresolvable = not base_ok
    changes = [] if base_unresolvable else collect_changes(source_repo, base, head, worktree)
    dirty = is_dirty(source_repo)
    snapshot = "worktree" if worktree else (rev_parse(source_repo, head or "HEAD") or (head or "HEAD"))

    all_files = (
        list_working_files(source_repo)
        if worktree
        else list_tracked_files(source_repo, head or "HEAD")
    )
    rust_files = {f for f in all_files if glob_match(f, "app/src-tauri/**/*.rs")}

    graphs = OwnershipGraphs(repo, test_map, targets, all_files)
    base_files: List[str] = []
    if base_repo is not None:
        try:
            assert base_map is not None and base_targets is not None
            base_files = list_tracked_files(source_repo, base)
            base_graphs = OwnershipGraphs(base_repo, base_map, base_targets, base_files)
            graphs.python_files |= base_graphs.python_files
            graphs.python_test_files |= base_graphs.python_test_files
            graphs.ts_files |= base_graphs.ts_files
            graphs.vitest_test_files |= base_graphs.vitest_test_files
            graphs.e2e_test_files |= base_graphs.e2e_test_files
            graphs.py_reverse = _merge_reverse(graphs.py_reverse, base_graphs.py_reverse)
            graphs.ts_reverse = _merge_reverse(graphs.ts_reverse, base_graphs.ts_reverse)
            graphs.uncertainty.extend(base_graphs.uncertainty)
            for group, tests in base_graphs.group_tests_from_hub.items():
                graphs.group_tests_from_hub.setdefault(group, set()).update(tests)
            graphs.spawner_composition |= base_graphs.spawner_composition
        except (OSError, ToolError, yaml.YAMLError, json.JSONDecodeError) as exc:
            graphs.uncertainty.append(
                {"reason": "base_snapshot_unreadable", "path": base, "detail": str(exc)}
            )
    python_files = graphs.python_files
    python_test_files = graphs.python_test_files
    ts_files = graphs.ts_files
    vitest_test_files = graphs.vitest_test_files
    e2e_test_files = graphs.e2e_test_files
    py_reverse = graphs.py_reverse
    ts_reverse = graphs.ts_reverse
    group_tests_from_hub = graphs.group_tests_from_hub
    spawner_composition = graphs.spawner_composition
    build_rs_rel = (test_map.get("rust") or {}).get("rerun_inputs_from")
    build_rs_inputs = parse_build_rs_rerun_inputs(repo, build_rs_rel) if build_rs_rel else set()

    changed_entries: List[Dict[str, Any]] = []
    deleted_tests: List[str] = []
    unknown: List[str] = []
    unknown_area: List[str] = []
    report_only: List[str] = []
    composition: Set[str] = set()
    broaden: Dict[str, Optional[str]] = {k: None for k in RUNNER_KEYS}
    selections: Dict[str, Any] = {
        "python": set(),
        "vitest": set(),
        "e2e": set(),
        "cargo": False,
        "integration": set(),
    }
    journeys: Set[str] = set()  # semantic signal, never counted as e2e files

    def broaden_runner(runner: str, reason: str) -> None:
        if broaden.get(runner) is None:
            broaden[runner] = reason

    def broaden_all(reason: str) -> None:
        for runner in RUNNER_KEYS:
            broaden_runner(runner, reason)

    changed_paths: List[str] = []
    any_python_source_changed = False
    any_hub_source_changed = False
    any_rust_source_changed = False
    added: Set[str] = set()  # status "A" only — obligations' component rule
    touched: Set[str] = set()  # anything but "D" — obligations' subparser rule

    def handle_fixture(path: str) -> None:
        candidates = fixture_parent_candidates(path)
        direct_py: Set[str] = set()
        direct_ts: Set[str] = set()
        direct_rs: Set[str] = set()
        for f in all_files:
            full = repo / f
            if not full.exists():
                continue
            pool: Set[str]
            if f.endswith(".py"):
                pool = direct_py
            elif f.endswith(".ts") or f.endswith(".tsx"):
                pool = direct_ts
            elif f.endswith(".rs"):
                pool = direct_rs
            else:
                continue
            try:
                text = full.read_text(errors="ignore")
            except OSError:
                continue
            if text_contains_any(text, candidates):
                pool.add(f)
        for cr in cross_readers:
            if any_glob_match(path, cr.get("reads") or []):
                if cr["runner"] == "python":
                    direct_py.add(cr["path"])
                elif cr["runner"] == "vitest":
                    direct_ts.add(cr["path"])
                elif cr["runner"] == "cargo":
                    direct_rs.add(cr["path"])
                elif cr["runner"] == "e2e":
                    selections["e2e"].add(cr["path"])

        py_owners: Set[str] = set()
        for c in direct_py:
            if c in python_test_files:
                py_owners.add(c)
            py_owners |= transitive_dependents(c, py_reverse, sinks=PY_GRAPH_SINKS) & python_test_files
        ts_owners: Set[str] = set()
        mock_hit = False
        for c in direct_ts:
            if glob_match(c, "app/src/mocks/**"):
                owner_areas = mock_owners.get(c)
                if owner_areas:
                    # TA-1-4e14: an attributed mock's consumer (a fixture)
                    # selects its owner areas' journeys, not every runner.
                    for a in owner_areas:
                        area_journeys = (
                            (test_map.get("app") or {}).get("areas", {}).get(a, {}).get("journeys")
                            or []
                        )
                        for j in area_journeys:
                            journeys.add(j)
                            selections["e2e"] |= resolve_journey_specs(j, e2e_test_files)
                else:
                    mock_hit = True
            if c in vitest_test_files:
                ts_owners.add(c)
            ts_owners |= transitive_dependents(c, ts_reverse) & vitest_test_files
        selections["python"] |= py_owners
        selections["vitest"] |= ts_owners
        if direct_rs:
            selections["cargo"] = True
        if mock_hit:
            broaden_runner("vitest", f"fixture consumer under app/src/mocks/**: {path}")
            broaden_runner("e2e", f"fixture consumer under app/src/mocks/**: {path}")

        # A consumer that is ITSELF shared infrastructure (setup.ts, a
        # conftest, a lockfile-adjacent script) propagates the same way a
        # direct change to it would: it loads once for the whole runner.
        shared = test_map.get("shared_infrastructure") or {}
        for c in direct_py:
            if any_glob_match(c, shared.get("python") or []):
                broaden_runner("python", f"fixture consumer is shared_infrastructure.python: {c}")
        for c in direct_ts:
            if any_glob_match(c, shared.get("vitest") or []):
                broaden_runner("vitest", f"fixture consumer is shared_infrastructure.vitest: {c}")
            if any_glob_match(c, shared.get("e2e") or []):
                broaden_runner("e2e", f"fixture consumer is shared_infrastructure.e2e: {c}")
        for c in direct_rs:
            if any_glob_match(c, shared.get("cargo") or []):
                broaden_runner("cargo", f"fixture consumer is shared_infrastructure.cargo: {c}")

    def handle_path(path: str, status: str) -> None:
        nonlocal any_python_source_changed, any_hub_source_changed, any_rust_source_changed, journeys
        kind = classify_kind(path, test_map)
        area: Optional[str] = None
        changed_paths.append(path)
        if status != "D":
            touched.add(path)
        if status == "A":
            added.add(path)

        if kind == "source" and path.endswith(".py"):
            any_python_source_changed = True
            if is_hub_source_path(path, targets):
                any_hub_source_changed = True
            group = find_group_for_path(path, targets)
            area = group
            owners: Set[str] = set()
            stem = Path(path).stem
            owners |= {
                t for t in python_test_files if fnmatch.fnmatch(Path(t).name, f"test_{stem}*.py")
            }
            overrides = (test_map.get("python") or {}).get("overrides") or {}
            owners |= set(overrides.get(path, []))
            for cr in cross_readers:
                if cr["runner"] == "python" and any_glob_match(path, cr.get("reads") or []):
                    owners.add(cr["path"])
            owners |= transitive_dependents(path, py_reverse, sinks=PY_GRAPH_SINKS) & python_test_files
            if group:
                owners |= group_tests_from_hub.get(group, set())
            selections["python"] |= owners
        elif kind == "source" and path.startswith("app/src/"):
            area = area_for_ts_path(path, test_map.get("app") or {})
            owners = (
                transitive_dependents(path, ts_reverse) & vitest_test_files
                if path.endswith((".ts", ".tsx", ".css", ".json"))
                else set()
            )
            for cr in cross_readers:
                if cr["runner"] == "vitest" and any_glob_match(path, cr.get("reads") or []):
                    name = cr["path"]
                    if name in vitest_test_files or name.endswith((".test.ts", ".test.tsx")):
                        owners.add(name)
            selections["vitest"] |= owners
            if path.startswith("app/src/test/"):
                # Test-support files (setup.ts, helpers.tsx, fixtures,
                # snapshots) own no area by design — they are vitest
                # scaffolding, not a screen or a journey. Treating "no
                # area" the same as a genuinely unowned lib would fan
                # this out to every journey in every area (it did: a
                # single helpers.tsx edit selected 81 of ~82 e2e specs).
                # The import graph above and shared_infrastructure.vitest
                # already cover the real vitest fallout; e2e is untouched
                # here unless a mocks/** cross_reader or shared_infra
                # entry says otherwise.
                pass
            elif mock_owners.get(path):
                # TA-1-4e14: an attributed mock (app.mock_owners) selects
                # its owner areas' journeys instead of broadening e2e. The
                # mock itself owns no single area glob, so `area` becomes
                # the first owner for the changed-entry record.
                mock_areas = mock_owners[path]
                area = mock_areas[0]
                for a in mock_areas:
                    area_journeys = (
                        (test_map.get("app") or {}).get("areas", {}).get(a, {}).get("journeys") or []
                    )
                    for j in area_journeys:
                        journeys.add(j)
                        selections["e2e"] |= resolve_journey_specs(j, e2e_test_files)
                for f in e2e_files_naming(repo, path, all_files):
                    if glob_match(f, "app/e2e/*.spec.ts"):
                        selections["e2e"].add(f)
                    else:
                        # A non-spec e2e file (a helper, a fixture module)
                        # naming the mock can change what every journey
                        # using it does; broaden e2e rather than guess.
                        broaden_runner("e2e", f"non-spec e2e file names attributed mock {path}: {f}")
            elif area is None:
                unknown_area.append(path)
                for a in (test_map.get("app") or {}).get("areas", {}).values():
                    for j in a.get("journeys") or []:
                        journeys.add(j)
                        selections["e2e"] |= resolve_journey_specs(j, e2e_test_files)
            else:
                area_journeys = (
                    (test_map.get("app") or {}).get("areas", {}).get(area, {}).get("journeys")
                    or []
                )
                for j in area_journeys:
                    journeys.add(j)
                    selections["e2e"] |= resolve_journey_specs(j, e2e_test_files)
        elif kind == "source" and path.endswith(".rs"):
            area = "rust"
            any_rust_source_changed = True
            selections["cargo"] = True
        elif kind == "source" and path.startswith("app/e2e/"):
            # A non-spec e2e file (a helper, a shared fixture module) can
            # change what every journey does, but has no import edge
            # python/vitest/cargo can see and no reason to rerun those
            # runners: broaden e2e alone, not every runner.
            area = "e2e"
            broaden_runner("e2e", f"e2e helper changed: {path}")
        elif kind == "source":
            # A cross_reader `reads` match on something no extension-
            # specific branch owns: a SKILL.md, the root AGENTS.md. The
            # reader itself is the selection.
            for cr in cross_readers:
                if any_glob_match(path, cr.get("reads") or []):
                    if cr["runner"] == "cargo":
                        selections["cargo"] = True
                    else:
                        selections[cr["runner"]].add(cr["path"])
        elif kind == "test":
            if glob_match(path, "app/e2e/*.spec.ts"):
                # The Python map guard enumerates every browser spec to keep
                # journey ownership complete. This remains an input when the
                # spec is deleted or renamed away as well.
                for cr in cross_readers:
                    if cr["runner"] == "python" and any_glob_match(path, cr.get("reads") or []):
                        selections["python"].add(cr["path"])
            if status == "D":
                # A deleted test file never enters a selection: pytest
                # (and vitest/playwright) exit non-zero on a missing path.
                deleted_tests.append(path)
            elif glob_match(path, "tests/test_*.py"):
                selections["python"].add(path)
            elif path.endswith(".test.ts") or path.endswith(".test.tsx"):
                selections["vitest"].add(path)
            elif glob_match(path, "app/e2e/*.spec.ts"):
                selections["e2e"].add(path)
        elif kind == "fixture":
            handle_fixture(path)
        elif kind in ("config", "runner", "workflow"):
            pass  # handled by shared_infrastructure below
        elif kind == "report_only":
            report_only.append(path)
        elif kind == "unknown":
            unknown.append(path)
            broaden_all(f"unknown path: {path}")

        shared = test_map.get("shared_infrastructure") or {}
        for runner in RUNNER_KEYS:
            if any_glob_match(path, shared.get(runner) or []):
                broaden_runner(runner, f"shared_infrastructure.{runner}: {path}")
        if any_glob_match(path, shared.get("all") or []):
            broaden_all(f"shared_infrastructure.all: {path}")

        if any_glob_match(path, (test_map.get("rust") or {}).get("runs_on") or []):
            selections["cargo"] = True
        if path in build_rs_inputs:
            selections["cargo"] = True
            broaden_runner("cargo", f"build.rs rerun input changed: {path}")

        changed_entries.append({"path": path, "kind": kind, "area": area, "status": status})

    renamed_from: Dict[str, str] = {}
    for status, old_path, new_path in changes:
        if status.startswith("R") and new_path:
            renamed_from[new_path] = old_path
            handle_path(old_path, "D")
            handle_path(new_path, "R")
        else:
            handle_path(old_path, status)

    obligations = compute_obligations(
        repo,
        base_repo,
        test_map,
        added,
        touched,
        ts_reverse,
        vitest_test_files,
        python_test_files,
        base_files=base_files,
        renamed_from=renamed_from,
    )

    uncertainty: List[Dict[str, str]] = []
    changed_set = set(changed_paths)
    for item in graphs.uncertainty:
        relevant = item.get("path") in changed_set
        candidate = item.get("candidate")
        if candidate:
            relevant = relevant or any(
                path == candidate
                or path.startswith(candidate.rstrip("/") + ".")
                or path.startswith(candidate.rstrip("/") + "/")
                for path in changed_set
            )
        if item.get("reason") == "typescript_dynamic_import_unresolved":
            relevant = relevant or any(
                path.startswith("app/src/") and path.endswith((".ts", ".tsx"))
                for path in changed_set
            )
        if item.get("reason") == "python_local_import_unresolved" and item.get("detail"):
            module_path = item["detail"].replace(".", "/")
            relevant = relevant or any(
                path in {module_path + ".py", module_path + "/__init__.py"}
                or path.startswith(module_path.rstrip("/") + "/")
                for path in changed_set
            )
        if not relevant:
            continue
        uncertainty.append(item)
        path = item.get("path", "")
        if path.endswith(".py"):
            broaden_runner("python", f"{item['reason']}: {path}")
        elif path.endswith((".ts", ".tsx")):
            broaden_runner("vitest", f"{item['reason']}: {path}")
            if path.startswith("app/src/"):
                broaden_runner("e2e", f"{item['reason']}: {path}")

    # Cargo (F4): a change to hub's own shipped Python also runs the Rust
    # suite, because command tests spawn the real hub.py — but
    # testing/scripts/** and scripts/** are not hub source.
    if any_hub_source_changed:
        selections["cargo"] = True

    # Composition tests: hub.py/sys.argv spawners with no recognizable
    # subcommand run on any Python source change.
    if any_python_source_changed:
        composition |= spawner_composition
        selections["python"] |= composition

    # Closure-ceiling broadening.
    py_ceiling = (test_map.get("python") or {}).get("closure_ceiling", 1.0)
    if python_test_files and len(selections["python"]) > py_ceiling * len(python_test_files):
        broaden_runner(
            "python",
            f"closure_ceiling: {len(selections['python'])}/{len(python_test_files)} "
            f"> {py_ceiling}",
        )

    app_ceiling = (test_map.get("app") or {}).get("closure_ceiling", 1.0)
    if vitest_test_files and len(selections["vitest"]) > app_ceiling * len(vitest_test_files):
        broaden_runner(
            "vitest",
            f"closure_ceiling: {len(selections['vitest'])}/{len(vitest_test_files)} "
            f"> {app_ceiling}",
        )

    # The real per-file owners before broadening replaces the list with
    # everything — used below so integration selector-intersection never
    # trivially matches every catalog case once python is broadened.
    raw_python_selection: Set[str] = set(selections["python"])

    # Apply broadening: replace file lists with the whole runner suite.
    if broaden["python"]:
        selections["python"] = set(python_test_files)
    if broaden["vitest"]:
        selections["vitest"] = set(vitest_test_files)
    if broaden["e2e"]:
        selections["e2e"] = set(e2e_test_files)
        journeys |= {
            j
            for a in (test_map.get("app") or {}).get("areas", {}).values()
            for j in (a.get("journeys") or [])
        }
    if broaden["cargo"]:
        selections["cargo"] = True

    # A deleted test file is never a valid selector — pytest, vitest and
    # Playwright all exit non-zero on a missing path — even if it slipped
    # in through broadening, a fixture reader, or a cross_reader hit.
    deleted_set = set(deleted_tests)
    selections["python"] -= deleted_set
    selections["vitest"] -= deleted_set
    selections["e2e"] -= deleted_set

    # Integration: catalog cases whose selector files intersect the
    # pytest files actually owned by a real change (never the broadened
    # everything-selected set, which would trivially match every case).
    # A broadened python selection instead picks by profile membership,
    # and only when the broadening was driven by an actual hub source
    # change — `testing/scripts/**` broadening python via shared
    # infrastructure is not evidence that hub's own suite needs it.
    integration_profile = "selected"
    sensitive_patterns = [
        "testing/test-map.yaml",
        "mutation/targets.yaml",
        "tests/integration_contracts/catalog.json",
        "skill_hub/domain/harnesses/**",
        "skill_hub/application/harnesses/**",
        "skill_hub/infrastructure/harnesses/**",
        "skill_hub/entrypoints/cli/harness.py",
        "testing/scripts/test_scope.py",
    ]
    if any(any_glob_match(path, sensitive_patterns) for path in changed_paths):
        integration_profile = "offline"

    catalog_path = repo / "tests" / "integration_contracts" / "catalog.json"
    if catalog_path.exists():
        try:
            catalog = json.loads(catalog_path.read_text())
        except json.JSONDecodeError:
            catalog = {"cases": []}
            uncertainty.append(
                {"reason": "integration_catalog_parse_failed", "path": str(catalog_path.relative_to(repo))}
            )
        broadened_python = broaden["python"] is not None
        blanket_quick = broadened_python and any_hub_source_changed
        for case in catalog.get("cases", []):
            selector_files = {sel.split("::", 1)[0] for sel in case.get("selectors", [])}
            matched = bool(selector_files & raw_python_selection)
            if blanket_quick and "quick" in (case.get("profiles") or []):
                matched = True
            if matched:
                selections["integration"].add(case["id"])
        if integration_profile == "offline":
            selections["integration"] = {
                case["id"]
                for case in catalog.get("cases", [])
                if "offline" in (case.get("profiles") or [])
            }
    elif integration_profile == "offline":
        uncertainty.append(
            {"reason": "integration_catalog_missing", "path": "tests/integration_contracts/catalog.json"}
        )

    if base_unresolvable:
        for runner in RUNNER_KEYS:
            broaden[runner] = broaden[runner] or f"base_unresolvable: {base}"
        selections["cargo"] = True
    commands = build_commands(test_map, selections, broaden)
    static_commands = build_static_commands(test_map, changed_paths, selections)

    # Record fingerprint (F5): every changed path, every selected test
    # file, the map and targets files themselves, and every
    # shared_infrastructure file belonging to a selected/broadened
    # runner — all read from the WORKING TREE, so dirty content counts.
    fingerprint_paths: Set[str] = (
        set(changed_paths) | selections["python"] | selections["vitest"] | selections["e2e"]
    )
    fingerprint_paths.add("testing/test-map.yaml")
    fingerprint_paths.add("mutation/targets.yaml")
    shared = test_map.get("shared_infrastructure") or {}
    for runner in RUNNER_KEYS:
        runner_active = bool(selections.get(runner)) or broaden.get(runner) is not None
        if runner_active:
            for p in shared.get(runner) or []:
                if "*" not in p and (repo / p).exists():
                    fingerprint_paths.add(p)

    hasher = hashlib.sha256()
    for p in sorted(fingerprint_paths):
        blob = blob_of_worktree(repo, p) or ""
        hasher.update(f"{p}:{blob}\n".encode())
    hasher.update(json.dumps(commands, sort_keys=True).encode())
    record_fingerprint = hasher.hexdigest()

    semantic = semantic_fingerprint(
        source_repo, ref=None if worktree else (head or "HEAD"), worktree=worktree
    )
    non_inert_changes = [e for e in changed_entries if e["kind"] not in ("report_only", "doc")]
    has_selection = (
        bool(selections["python"])
        or bool(selections["vitest"])
        or bool(selections["e2e"])
        or bool(journeys)
        or selections["cargo"]
        or bool(selections["integration"])
        or any(broaden.values())
    )
    reasons: List[str] = []
    if base_unresolvable:
        verdict = "needs_attention"
        reasons.append("base_unresolvable")
        uncertainty.append({"reason": "base_unresolvable", "path": base})
    elif uncertainty:
        verdict = "needs_attention"
        reasons.extend(sorted({item["reason"] for item in uncertainty}))
    elif non_inert_changes and not has_selection:
        verdict = "needs_attention"
        reasons.append("empty_selection")
    else:
        verdict = "ok"

    # An unmet obligation blocks the local runner regardless of which
    # branch above set the verdict — it is never folded into `uncertainty`
    # (that fallback broadens a runner and would turn every draft touching
    # a new screen or subparser into a full run, defeating the point of a
    # conservative, narrowly-scoped obligation).
    if any(item.get("status") == "unmet" for item in obligations):
        verdict = "needs_attention"
        reasons.append("unmet_obligations")

    return {
        "snapshot": snapshot,
        "dirty": dirty,
        "base": base,
        "head": head or "HEAD",
        "changed": changed_entries,
        "deleted_tests": sorted(set(deleted_tests)),
        "unknown": sorted(set(unknown)),
        "unknown_area": sorted(set(unknown_area)),
        "report_only": sorted(set(report_only)),
        "broaden": broaden,
        "composition": sorted(composition),
        "selections": {
            "python": sorted(selections["python"]),
            "vitest": sorted(selections["vitest"]),
            "e2e": sorted(selections["e2e"]),
            "cargo": bool(selections["cargo"]),
            "integration": sorted(selections["integration"]),
        },
        "journeys": sorted(journeys),
        "commands": commands,
        "static_commands": static_commands,
        "record_fingerprint": record_fingerprint,
        "uncertainty": uncertainty,
        "semantic_fingerprint": semantic,
        "integration_profile": integration_profile,
        "obligations": obligations,
        "verdict": verdict,
        "reasons": reasons,
    }


# ----------------------------------------------------------- record cmds


def record(repo: Path, selection_path: Path, results_path: Path) -> Dict[str, Any]:
    selection = json.loads(selection_path.read_text())
    results = json.loads(results_path.read_text())
    semantic = semantic_fingerprint(repo, worktree=True)
    if not _same_semantic_identity(selection.get("semantic_fingerprint"), semantic):
        raise ToolError("refusing to record: semantic inputs changed since selection")
    expected = {command.get("runner") for command in selection.get("commands", [])}
    for runner, result in results.items():
        if isinstance(result, dict) and result.get("exit") == 0:
            count = next(
                (
                    result[key]
                    for key in ("collected", "count", "test_count", "passed")
                    if isinstance(result.get(key), int)
                ),
                0,
            )
            if count <= 0:
                raise ToolError(f"refusing to record {runner}: expected count must be nonzero")
    for runner in sorted(expected):
        result = results.get(runner)
        if not isinstance(result, dict):
            raise ToolError(f"refusing to record {runner}: missing result")
        if result.get("exit") != 0:
            raise ToolError(f"refusing to record {runner}: execution did not succeed")
        count = next(
            (
                result[key]
                for key in ("collected", "count", "test_count", "passed")
                if isinstance(result.get(key), int)
            ),
            0,
        )
        if count <= 0:
            raise ToolError(f"refusing to record {runner}: expected count must be nonzero")
    inputs: Dict[str, str] = {}
    test_map = load_test_map(repo)
    for p in selection.get("changed", []):
        path = p["path"]
        if not _semantic_excluded(path, test_map):
            inputs[path] = blob_of_worktree(repo, path) or ""
    for runner_files in (
        selection.get("selections", {}).get("python", []),
        selection.get("selections", {}).get("vitest", []),
        selection.get("selections", {}).get("e2e", []),
    ):
        for f in runner_files:
            inputs[f] = blob_of_worktree(repo, f) or ""
    inputs["testing/test-map.yaml"] = blob_of_worktree(repo, "testing/test-map.yaml") or ""
    inputs["mutation/targets.yaml"] = blob_of_worktree(repo, "mutation/targets.yaml") or ""

    hasher = hashlib.sha256()
    for p in sorted(inputs):
        hasher.update(f"{p}:{inputs[p]}\n".encode())
    hasher.update(json.dumps(selection.get("commands", []), sort_keys=True).encode())
    hasher.update(json.dumps(results, sort_keys=True).encode())
    hasher.update(json.dumps(semantic, sort_keys=True).encode())

    return {
        "schema_version": RECORD_SCHEMA,
        "snapshot": selection.get("snapshot"),
        "commands": selection.get("commands", []),
        "results": results,
        "inputs": inputs,
        "semantic_fingerprint": semantic,
        "fingerprint": hasher.hexdigest(),
    }


def check_record(repo: Path, record_data: Dict[str, Any]) -> Dict[str, Any]:
    if record_data.get("schema_version") != RECORD_SCHEMA:
        return {"verdict": "stale", "changed": [], "reason": "schema_changed"}
    changed = []
    inputs = record_data.get("inputs", {})
    for path, blob in inputs.items():
        current = blob_of_worktree(repo, path) or ""
        if current != blob:
            changed.append(path)

    if changed:
        return {"verdict": "stale", "changed": sorted(changed)}

    stored_semantic = record_data.get("semantic_fingerprint")
    current_semantic = semantic_fingerprint(repo, worktree=True)
    if not _same_semantic_identity(stored_semantic, current_semantic):
        return {
            "verdict": "stale",
            "changed": ["semantic_fingerprint"],
            "reason": "semantic_inputs_changed",
        }

    # No input file moved, but `commands`/`results`/`fingerprint` are
    # stored verbatim in the record and never re-derived from disk — a
    # tampered one changes nothing blob_of_worktree can see. Recompute
    # the same hash `record` would have produced from the record's OWN
    # stored fields; a mismatch means the record no longer matches
    # itself.
    hasher = hashlib.sha256()
    for p in sorted(inputs):
        hasher.update(f"{p}:{inputs[p]}\n".encode())
    hasher.update(json.dumps(record_data.get("commands", []), sort_keys=True).encode())
    hasher.update(json.dumps(record_data.get("results", {}), sort_keys=True).encode())
    hasher.update(json.dumps(stored_semantic, sort_keys=True).encode())
    recomputed = hasher.hexdigest()
    stored = record_data.get("fingerprint")
    if stored is None or stored != recomputed:
        # A record without its fingerprint is treated as tampered: deleting
        # the field must not defeat the guard.
        return {"verdict": "stale", "changed": [], "reason": "record_tampered"}

    return {"verdict": "fresh", "changed": []}


# ---------------------------------------------------------- audit-scope


def discover_manifests(repo: Path) -> List[Tuple[Path, Dict[str, Any]]]:
    result: List[Tuple[Path, Dict[str, Any]]] = []
    audits_dir = repo / "testing" / "audits"
    if not audits_dir.exists():
        return result
    for manifest_path in sorted(audits_dir.glob("*/manifest.json")):
        try:
            data = json.loads(manifest_path.read_text())
        except json.JSONDecodeError:
            continue
        result.append((manifest_path, data))
    return result


def manifest_eligible(
    manifest: Dict[str, Any],
    current_map_version: Optional[int],
    current_strategy_version: Optional[int],
    compatible_map_versions: Iterable[int],
) -> bool:
    if manifest.get("status") != "complete":
        return False
    if manifest.get("strategy_version") != current_strategy_version:
        return False
    map_version = manifest.get("map_version")
    if map_version != current_map_version and map_version not in set(compatible_map_versions):
        return False
    if isinstance(map_version, int) and isinstance(current_map_version, int):
        if map_version > current_map_version:
            return False  # future versions are rejected
    areas = manifest.get("areas") or {}
    if not areas:
        return False
    for area in areas.values():
        if "reviewed_fingerprint" not in area and "fingerprint" not in area:
            return False
        if "paths" not in area:
            return False
    return True


def build_areas(test_map: Dict[str, Any], targets: Dict[str, Any]) -> Dict[str, List[str]]:
    """Each area's SOURCE globs only. The tests an area owns are never a
    blanket `tests/test_*.py` — see `compute_area_test_ownership` — except
    for `integration-catalog` and `infra`, whose "ownership" really is
    naming convention / a literal path, not inference.
    """
    areas: Dict[str, List[str]] = {}
    for group_name, group in (targets.get("groups") or {}).items():
        globs = []
        for p in group.get("paths") or []:
            globs.append(p if p.endswith(".py") else p.rstrip("/") + "/**")
        areas[group_name] = globs
    for area_name, area in (test_map.get("app") or {}).get("areas", {}).items():
        globs = list(area.get("sources") or [])
        areas[f"app:{area_name}"] = globs
    areas["rust"] = list((test_map.get("rust") or {}).get("sources") or ["app/src-tauri/**"])
    infra_globs: List[str] = []
    for v in (test_map.get("shared_infrastructure") or {}).values():
        infra_globs.extend(v)
    infra_globs.append(".github/workflows/**")
    infra_globs.append("tests/conftest.py")
    areas["infra"] = infra_globs
    areas["integration-catalog"] = [
        "tests/integration_contracts/catalog.json",
        "tests/test_integration_*.py",
    ]
    return areas


def _group_module_files(group: Dict[str, Any], python_files: Set[str]) -> Set[str]:
    files: Set[str] = set()
    for p in group.get("paths") or []:
        if p.endswith(".py"):
            if p in python_files:
                files.add(p)
        else:
            files |= {f for f in python_files if f == p or f.startswith(p.rstrip("/") + "/")}
    return files


def compute_area_test_ownership(
    repo: Path, test_map: Dict[str, Any], targets: Dict[str, Any]
) -> Dict[str, Set[str]]:
    """area_name -> the test files that area OWNS, beyond its source
    globs: Python groups by convention, overrides, DIRECT importers (a
    test that imports a module of the group, one hop — not `select`'s
    full transitive closure) and facade/subprocess-family attribution;
    app areas by the vitest import graph from their sources plus their
    journeys' spec files. Computed once from the current tracked tree —
    like `select`, this tool never reconstructs an import graph at a
    historical revision.

    Deliberately narrower than `select`'s closure: `select` stays
    conservative (over-select rather than miss a real dependency) for a
    live change, but "ownership" for audit/fingerprint purposes needs a
    tight boundary. Full transitivity here still fans out through core
    modules many `hub_cli` slices share (harness_operation_context.py
    alone reaches 161 of 214 real tests transitively, even with hub.py
    sunk) — direct reachability keeps an area's fingerprint meaningful.
    """
    all_files = list_tracked_files(repo, "HEAD")
    graphs = OwnershipGraphs(repo, test_map, targets, all_files)
    overrides = (test_map.get("python") or {}).get("overrides") or {}
    cross_readers = cross_readers_of(test_map)

    ownership: Dict[str, Set[str]] = {}

    for group_name, group in (targets.get("groups") or {}).items():
        owned: Set[str] = set()
        for module_file in _group_module_files(group, graphs.python_files):
            stem = Path(module_file).stem
            owned |= {
                t
                for t in graphs.python_test_files
                if fnmatch.fnmatch(Path(t).name, f"test_{stem}*.py")
            }
            owned |= graphs.py_reverse.get(module_file, set()) & graphs.python_test_files
            owned |= set(overrides.get(module_file, []))
            for cr in cross_readers:
                if cr["runner"] == "python" and any_glob_match(module_file, cr.get("reads") or []):
                    owned.add(cr["path"])
        owned |= graphs.group_tests_from_hub.get(group_name, set())
        ownership[group_name] = owned

    for area_name, area in (test_map.get("app") or {}).get("areas", {}).items():
        owned = set()
        source_globs = area.get("sources") or []
        for src in graphs.ts_files:
            if any_glob_match(src, source_globs):
                # Direct importers only — same reasoning as the Python
                # groups above (a shared hook/component otherwise fans an
                # area out to most of the vitest suite).
                owned |= graphs.ts_reverse.get(src, set()) & graphs.vitest_test_files
        for j in area.get("journeys") or []:
            owned |= resolve_journey_specs(j, graphs.e2e_test_files)
        ownership[f"app:{area_name}"] = owned

    return ownership


def build_areas_with_ownership(
    repo: Path, test_map: Dict[str, Any], targets: Dict[str, Any]
) -> Tuple[Dict[str, List[str]], Dict[str, Set[str]]]:
    """`build_areas`'s source globs, plus each area's extra owned test
    paths (never expressible as a glob), plus a synthetic `unowned-tests`
    area covering every test file of every runner (pytest, vitest, e2e)
    that no area's globs or ownership covers — so a test can never
    silently vanish, whichever runner it belongs to.
    """
    area_globs = build_areas(test_map, targets)
    ownership = compute_area_test_ownership(repo, test_map, targets)

    all_files = list_tracked_files(repo, "HEAD")
    all_tests = {f for f in all_files if glob_match(f, "tests/test_*.py")}
    all_tests |= {f for f in all_files if f.endswith((".test.ts", ".test.tsx"))}
    all_tests |= {f for f in all_files if glob_match(f, "app/e2e/*.spec.ts")}

    covered: Set[str] = set()
    for globs in area_globs.values():
        covered |= {t for t in all_tests if any_glob_match(t, globs)}
    for extra in ownership.values():
        covered |= extra & all_tests

    area_globs["unowned-tests"] = []
    ownership["unowned-tests"] = all_tests - covered
    return area_globs, ownership


def area_fingerprint(
    repo: Path, ref: str, globs: List[str], extra_paths: Iterable[str] = ()
) -> Tuple[str, Dict[str, str]]:
    files = list_tracked_files(repo, ref)
    file_set = set(files)
    matched = sorted({f for f in files if any_glob_match(f, globs)} | (file_set & set(extra_paths)))
    paths: Dict[str, str] = {}
    hasher = hashlib.sha256()
    for f in matched:
        blob = blob_of_ref(repo, f, ref) or ""
        paths[f] = blob
        hasher.update(f"{f}:{blob}\n".encode())
    return hasher.hexdigest(), paths


def resolve_since(repo: Path, since: str) -> str:
    rev = rev_parse(repo, since)
    if rev:
        return rev
    ok, out = git_ok(repo, "rev-list", "-1", f"--before={since}", "HEAD")
    if ok and out.strip():
        return out.strip()
    raise ToolError(f"cannot resolve --since {since!r}")


def pick_baseline(
    repo: Path, eligible: List[Tuple[Path, Dict[str, Any]]], head: str
) -> Tuple[Path, Dict[str, Any]]:
    def is_ancestor_baseline(item: Tuple[Path, Dict[str, Any]]) -> bool:
        rev = item[1].get("reviewed_revision")
        return bool(rev and commit_exists(repo, rev) and is_ancestor(repo, rev, head))

    ancestors = [item for item in eligible if is_ancestor_baseline(item)]
    pool = ancestors if ancestors else eligible
    return max(pool, key=lambda item: item[1].get("sequence", 0))


def audit_scope(
    repo: Path,
    since_last: bool,
    full: bool,
    since: Optional[str],
    areas_filter: Optional[List[str]],
) -> Dict[str, Any]:
    test_map = load_test_map(repo)
    targets = load_targets(repo)
    current_map_version = test_map.get("map_version")
    current_strategy_version = test_map.get("strategy_version")
    compatible_map_versions = test_map.get("compatible_map_versions") or []
    dirty = is_dirty(repo)
    head = rev_parse(repo, "HEAD") or "HEAD"
    areas, area_extra = build_areas_with_ownership(repo, test_map, targets)

    def area_touched(area_name: str, globs: List[str], changed_paths: List[str]) -> bool:
        if any(any_glob_match(c, globs) for c in changed_paths):
            return True
        extra = area_extra.get(area_name, set())
        return any(c in extra for c in changed_paths)

    manifests = discover_manifests(repo)
    eligible = [
        (path, data)
        for path, data in manifests
        if manifest_eligible(
            data, current_map_version, current_strategy_version, compatible_map_versions
        )
    ]

    baseline_path: Optional[Path] = None
    baseline: Optional[Dict[str, Any]] = None

    if since_last:
        if not eligible:
            return {"verdict": "bootstrap_required"}
        baseline_path, baseline = pick_baseline(repo, eligible, head)
    elif full:
        pass
    elif since:
        resolved = resolve_since(repo, since)
        since_result: Dict[str, Any] = {
            "verdict": "ok",
            "kind": "revision" if resolved == since else "date",
            "dirty": dirty,
            "baseline": None,
            "reviewed_revision": head,
            "resolved_commit": resolved,
            "history": "ancestor",
            "areas": {},
        }
        changed = git(repo, "diff", "--name-only", resolved, head).splitlines()
        # Same payload shape as --since-last/--full: every area carries
        # both fingerprints, not just the ones in scope.
        for area_name, globs in areas.items():
            extra = area_extra.get(area_name, set())
            reviewed_fp, _reviewed_paths = area_fingerprint(repo, resolved, globs, extra)
            current_fp, _current_paths = area_fingerprint(repo, head, globs, extra)
            if area_touched(area_name, globs, changed):
                since_result["areas"][area_name] = {
                    "status": "in_scope",
                    "reviewed_fingerprint": current_fp,
                    "current_fingerprint": current_fp,
                }
            else:
                since_result["areas"][area_name] = {
                    "status": "carried",
                    "carried_from": f"since:{since}",
                    "reviewed_fingerprint": reviewed_fp,
                    "current_fingerprint": current_fp,
                }
        return since_result
    else:
        raise ToolError("one of --since-last, --full, --since is required")

    result: Dict[str, Any] = {
        "verdict": "ok",
        "dirty": dirty,
        "baseline": _repo_relative(repo, baseline_path) if baseline_path else None,
        "reviewed_revision": baseline.get("reviewed_revision") if baseline else None,
        "areas": {},
    }

    if full or baseline is None:
        result["kind"] = "full"
        result["history"] = "content_only" if baseline is not None else "full"
        for area_name, globs in areas.items():
            fp, _paths = area_fingerprint(repo, head, globs, area_extra.get(area_name, set()))
            result["areas"][area_name] = {
                "status": "in_scope",
                "reviewed_fingerprint": fp,
                "current_fingerprint": fp,
            }
        return result

    result["kind"] = "incremental"
    reviewed_rev = baseline.get("reviewed_revision")
    ancestor = (
        reviewed_rev is not None
        and commit_exists(repo, reviewed_rev)
        and is_ancestor(repo, reviewed_rev, head)
    )
    shallow = is_shallow_repo(repo)

    if ancestor:
        assert reviewed_rev is not None
        result["history"] = "ancestor"
        changed = git(repo, "diff", "--name-only", reviewed_rev, head).splitlines()
        in_scope = set()
        for area_name, globs in areas.items():
            if area_touched(area_name, globs, changed):
                in_scope.add(area_name)
        for area_name, globs in areas.items():
            extra = area_extra.get(area_name, set())
            if area_name in in_scope:
                fp, _paths = area_fingerprint(repo, head, globs, extra)
                result["areas"][area_name] = {
                    "status": "in_scope",
                    "reviewed_fingerprint": fp,
                    "current_fingerprint": fp,
                }
            else:
                baseline_fp = (baseline.get("areas", {}).get(area_name) or {}).get(
                    "fingerprint"
                ) or (baseline.get("areas", {}).get(area_name) or {}).get("reviewed_fingerprint")
                current_fp, _paths = area_fingerprint(repo, head, globs, extra)
                result["areas"][area_name] = {
                    "status": "carried",
                    "carried_from": str(baseline_path),
                    "reviewed_fingerprint": baseline_fp,
                    "current_fingerprint": current_fp,
                }
    else:
        result["history"] = "shallow" if shallow else "content_only"
        for area_name, globs in areas.items():
            current_fp, _paths = area_fingerprint(repo, head, globs, area_extra.get(area_name, set()))
            baseline_area = (baseline.get("areas", {}) or {}).get(area_name) or {}
            baseline_fp = baseline_area.get("fingerprint") or baseline_area.get(
                "reviewed_fingerprint"
            )
            if current_fp != baseline_fp:
                result["areas"][area_name] = {
                    "status": "in_scope",
                    "reason": "content_changed_no_ancestry",
                    "reviewed_fingerprint": current_fp,
                    "current_fingerprint": current_fp,
                }
            else:
                result["areas"][area_name] = {
                    "status": "carried",
                    "carried_from": str(baseline_path),
                    "reviewed_fingerprint": baseline_fp,
                    "current_fingerprint": current_fp,
                }

    if areas_filter:
        narrowed = {}
        for area_name, info in result["areas"].items():
            if area_name in areas_filter:
                narrowed[area_name] = info
            else:
                narrowed[area_name] = {
                    "status": "carried",
                    "carried_from": str(baseline_path),
                    "reviewed_fingerprint": info.get("reviewed_fingerprint")
                    or info.get("fingerprint"),
                    "current_fingerprint": info.get("current_fingerprint"),
                }
        result["areas"] = narrowed

    if baseline.get("findings"):
        result["baseline_findings"] = [f["id"] for f in baseline["findings"]]

    return result


# ------------------------------------------------------------- manifest


def allocate_finding_id(sequence: int, existing_ids: Iterable[str]) -> str:
    import os

    existing = set(existing_ids)
    while True:
        candidate = f"TA-{sequence}-{os.urandom(2).hex()}"
        if candidate not in existing:
            return candidate


def validate_predecessor_chain(repo: Path, path: Path, data: Dict[str, Any]) -> List[str]:
    reasons: List[str] = []
    predecessor = data.get("predecessor")
    if not predecessor:
        return reasons
    predecessor_path = repo / predecessor if not Path(predecessor).is_absolute() else Path(predecessor)
    if not predecessor_path.exists():
        reasons.append(f"predecessor does not exist: {predecessor}")
        return reasons
    try:
        predecessor_data = json.loads(predecessor_path.read_text())
    except json.JSONDecodeError:
        reasons.append(f"predecessor is malformed json: {predecessor}")
        return reasons
    this_seq = data.get("sequence")
    pred_seq = predecessor_data.get("sequence")
    if isinstance(this_seq, int) and isinstance(pred_seq, int) and this_seq <= pred_seq:
        reasons.append(
            f"sequence does not advance past predecessor: {this_seq} <= {pred_seq}"
        )
    return reasons


def _repo_relative(repo: Path, path: Path) -> str:
    """A manifest path as it should be recorded: relative to the repo when it
    lives inside it. An absolute machine path in a committed manifest is a
    leak and breaks the predecessor chain on any other checkout."""
    try:
        return path.resolve().relative_to(repo.resolve()).as_posix()
    except ValueError:
        return str(path)


def _manifest_path_for(repo: Path, ref: str) -> Path:
    return repo / ref if not Path(ref).is_absolute() else Path(ref)


def _load_ancestor_chain(repo: Path, data: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Every ancestor manifest reachable via `predecessor`, oldest first.

    Cycle-safe: stops at a manifest already visited or unreadable rather
    than looping forever.
    """
    chain: List[Dict[str, Any]] = []
    seen: Set[str] = set()
    current = data
    while True:
        predecessor = current.get("predecessor")
        if not predecessor or predecessor in seen:
            break
        seen.add(predecessor)
        predecessor_path = _manifest_path_for(repo, predecessor)
        if not predecessor_path.exists():
            break
        try:
            predecessor_data = json.loads(predecessor_path.read_text())
        except json.JSONDecodeError:
            break
        chain.append(predecessor_data)
        current = predecessor_data
    chain.reverse()  # oldest first
    return chain


def reconcile_predecessor_findings(repo: Path, data: Dict[str, Any]) -> List[str]:
    """Union of findings from every ancestor manifest (F8): fold each
    ancestor's findings oldest to newest so a later status (fixed,
    superseded) overrides an earlier one (open, reopened) for the same
    id. Anything still `open`/`reopened` as of the immediate predecessor
    must appear in `data` — a finding closed earlier need not reappear,
    but one silently dropped while still open fails validation.
    """
    reasons: List[str] = []
    if not data.get("predecessor"):
        return reasons
    chain = _load_ancestor_chain(repo, data)
    if not chain:
        return reasons  # missing/malformed predecessor already reported

    last_status: Dict[str, str] = {}
    for manifest in chain:
        for f in manifest.get("findings") or []:
            fid = f.get("id")
            if fid:
                last_status[fid] = f.get("status")

    current_ids = {f.get("id") for f in data.get("findings") or []}
    for fid, status in last_status.items():
        if status in ("open", "reopened") and fid not in current_ids:
            reasons.append(f"missing baseline finding: {fid}")
    return reasons


def recompute_area_paths(repo: Path, data: Dict[str, Any]) -> List[str]:
    """F7: every area's `paths` must equal a fresh `git ls-tree -r
    <reviewed_revision>` filtered by that area's current globs, and its
    `reviewed_fingerprint` must match the recomputed fingerprint. A
    manifest that claims paths the tree does not have (or hides ones it
    does) is invalid, not just unreconciled.
    """
    reasons: List[str] = []
    reviewed_revision = data.get("reviewed_revision")
    if not reviewed_revision or not commit_exists(repo, reviewed_revision):
        return reasons  # already reported separately
    try:
        test_map = load_test_map(repo)
        targets = load_targets(repo)
    except ToolError:
        return reasons
    areas, area_extra = build_areas_with_ownership(repo, test_map, targets)
    for area_name, area in (data.get("areas") or {}).items():
        globs = areas.get(area_name)
        if globs is None or "paths" not in area:
            continue
        recomputed_fingerprint, recomputed_paths = area_fingerprint(
            repo, reviewed_revision, globs, area_extra.get(area_name, set())
        )
        stored_paths = area.get("paths") or {}
        if recomputed_paths != stored_paths:
            reasons.append(
                f"area {area_name} paths do not match git ls-tree at {reviewed_revision}"
            )
        stored_fingerprint = area.get("reviewed_fingerprint") or area.get("fingerprint")
        if stored_fingerprint is not None and stored_fingerprint != recomputed_fingerprint:
            reasons.append(f"area {area_name} reviewed_fingerprint does not match its paths")
    return reasons


def _import_harness_validation() -> Any:
    """Lazily import `harness_validation` from THIS checkout (never
    `hub`) to re-read/compare reports exactly as `hub integration
    validate` would. Import happens inside a function so a synthetic
    repo with no package `harness_validation.py` never pays for it unless a
    manifest actually references a report.
    """
    if str(REPO_ROOT) not in sys.path:
        sys.path.insert(0, str(REPO_ROOT))
    from skill_hub.infrastructure.harnesses import harness_validation  # noqa: PLC0415

    return harness_validation


def _read_report_via_harness_validation(report_path: Path) -> Dict[str, Any]:
    return _import_harness_validation().read_report(report_path)  # type: ignore[no-any-return]


def reverify_integration_evidence(repo: Path, data: Dict[str, Any]) -> List[str]:
    """F7: an `integration` execution_evidence entry whose `report` path
    exists is re-read through `read_report`; its captured/effective
    verdicts, missing requirements and freshness must match what is
    freshly computed, or the entry must say `self_reported: true`. A
    `compared_to` entry additionally needs `compare_reports` to actually
    be possible (matching case revision/environment) or must declare
    itself `inconclusive` — an omitted case is never silently "fixed".
    """
    reasons: List[str] = []
    for entry in data.get("execution_evidence") or []:
        if entry.get("runner") != "integration":
            continue
        report_rel = entry.get("report")
        if not report_rel:
            continue
        report_path = repo / report_rel
        if not report_path.exists():
            continue
        if entry.get("self_reported"):
            continue
        try:
            report = _read_report_via_harness_validation(report_path)
        except Exception as exc:  # noqa: BLE001 - any failure invalidates the entry
            reasons.append(f"integration report failed re-validation ({report_rel}): {exc}")
            continue
        checks = {
            "captured_verdict": report.get("evidence_verdict"),
            "effective_verdict": report.get("effective_evidence_verdict"),
            "missing_requirements": report.get("missing_requirements"),
            "effective_missing_requirements": report.get("effective_missing_requirements"),
            "freshness": report.get("freshness"),
        }
        for field, fresh_value in checks.items():
            if entry.get(field) != fresh_value:
                reasons.append(
                    f"integration report {report_rel} {field} is stale: "
                    f"stored={entry.get(field)!r} recomputed={fresh_value!r}"
                )

        compared_to = entry.get("compared_to")
        if compared_to:
            prior_path = repo / compared_to
            comparison_ok = False
            if not prior_path.exists():
                reasons.append(
                    f"integration report {report_rel} compared_to {compared_to} does not exist"
                )
            else:
                try:
                    prior_report = _read_report_via_harness_validation(prior_path)
                    _import_harness_validation().compare_reports(report, prior_report)
                    comparison_ok = True
                except Exception:  # noqa: BLE001 - falls through to inconclusive below
                    comparison_ok = False
            if not comparison_ok and entry.get("comparison") != "inconclusive":
                reasons.append(
                    f"integration report {report_rel} compared_to {compared_to} is not "
                    "comparable (mismatched case revision/environment) and is not "
                    "declared comparison: inconclusive"
                )
    return reasons


def validate_manifest(repo: Path, path: Path) -> Dict[str, Any]:
    reasons: List[str] = []
    try:
        data = json.loads(path.read_text())
    except json.JSONDecodeError as exc:
        return {"path": str(path), "verdict": "invalid", "reasons": [f"malformed json: {exc}"]}

    required = [
        "schema_version",
        "strategy_version",
        "map_version",
        "sequence",
        "status",
        "scope",
        "reviewed_revision",
        "dirty",
        "history",
        "areas",
        "execution_evidence",
        "findings",
        "gaps",
    ]
    for field in required:
        if field not in data:
            reasons.append(f"missing field: {field}")
    if reasons:
        return {"path": str(path), "verdict": "invalid", "reasons": reasons}

    # reviewed_revision resolves to a real commit (a stale/foreign sha is
    # never "ok" just because it is 40 hex characters), and is never null
    # — a manifest with no revision reviewed nothing. When it IS missing,
    # `recompute_area_paths` below has nothing to check against, so an
    # empty `paths` on a reviewed area is the only signal left that
    # nothing was actually reviewed (a legitimately empty area under a
    # VALID reviewed_revision is instead caught, correctly, by the
    # ls-tree mismatch in `recompute_area_paths`).
    reviewed_revision = data.get("reviewed_revision")
    revision_missing = not reviewed_revision
    if revision_missing:
        reasons.append("reviewed_revision is null")
    elif not commit_exists(repo, reviewed_revision):
        revision_missing = True
        reasons.append(f"reviewed_revision does not resolve: {reviewed_revision}")

    if revision_missing:
        for area_name, area in (data.get("areas") or {}).items():
            if area.get("status") in ("reviewed", "in_progress", "in_scope") and not area.get("paths"):
                reasons.append(f"area {area_name} is reviewed but has empty paths")

    findings = data.get("findings") or []
    ids_seen = {f.get("id") for f in findings}
    seen_twice: Set[str] = set()
    counted: Set[str] = set()
    for f in findings:
        fid = f.get("id")
        if fid in counted:
            seen_twice.add(fid)
        counted.add(fid)
        if not fid or not FINDING_ID_RE.match(fid):
            reasons.append(f"finding id has the wrong shape: {fid}")
        status = f.get("status")
        if status not in FINDING_STATUSES:
            reasons.append(f"finding {fid} has invalid status: {status}")
        if status == "fixed" and not f.get("fixed_revision"):
            reasons.append(f"finding {fid} is fixed without a fixed_revision")
        if status == "superseded":
            target = f.get("superseded_by")
            if not target or target not in ids_seen:
                reasons.append(f"finding {fid} superseded_by names no existing id: {target}")
    for fid in seen_twice:
        reasons.append(f"duplicate finding id: {fid}")

    reasons.extend(validate_predecessor_chain(repo, path, data))
    reasons.extend(reconcile_predecessor_findings(repo, data))
    reasons.extend(recompute_area_paths(repo, data))
    reasons.extend(reverify_integration_evidence(repo, data))

    gaps_areas = {g.get("area") for g in data.get("gaps") or []}
    if data.get("status") == "complete":
        if data.get("dirty"):
            reasons.append("status is complete but dirty is true")
        for area_name, area in (data.get("areas") or {}).items():
            if area.get("status") == "in_progress":
                reasons.append(f"status is complete but area {area_name} is in_progress")
            if area.get("status") == "carried" and area_name not in gaps_areas:
                reviewed_fp = area.get("reviewed_fingerprint")
                current_fp = area.get("current_fingerprint")
                if reviewed_fp is not None and current_fp is not None and reviewed_fp != current_fp:
                    reasons.append(
                        f"area {area_name} carried with a differing fingerprint but no gaps entry"
                    )

    for area_name, area in (data.get("areas") or {}).items():
        if area.get("status") == "carried":
            target = area.get("carried_from")
            if not target:
                reasons.append(f"area {area_name} is carried without a carried_from")
            elif not target.startswith("since:") and not (repo / target).exists() and not Path(target).exists():
                reasons.append(f"area {area_name} carried_from target does not exist: {target}")

    verdict = "invalid" if reasons else "ok"
    return {"path": str(path), "verdict": verdict, "reasons": reasons}


def manifest_new(
    repo: Path,
    scope_payload: Dict[str, Any],
    out_dir: Path,
    test_map: Dict[str, Any],
    targets: Dict[str, Any],
) -> Dict[str, Any]:
    head = rev_parse(repo, "HEAD")
    if not head:
        raise ToolError("cannot resolve HEAD to write a manifest")
    area_globs, area_extra = build_areas_with_ownership(repo, test_map, targets)
    payload_areas = scope_payload.get("areas") or {}

    areas: Dict[str, Any] = {}
    for area_name, globs in area_globs.items():
        fingerprint, paths = area_fingerprint(repo, head, globs, area_extra.get(area_name, set()))
        info = payload_areas.get(area_name) or {}
        # In-scope areas start as in_progress; the auditor promotes each to
        # reviewed after reading it, and validate refuses complete while any
        # area is still in_progress.
        status = "in_progress" if info.get("status") == "in_scope" else "carried"
        entry: Dict[str, Any] = {
            "status": status,
            "reviewed_fingerprint": fingerprint,
            "current_fingerprint": fingerprint,
            "path_count": len(paths),
            "paths": paths,
        }
        if status == "carried":
            # A narrowed area keeps the baseline's own reviewed
            # fingerprint when the payload has one; otherwise (--full,
            # or a baseline that never reviewed it either) the fresh
            # one computed above is the only fingerprint there is.
            if info.get("reviewed_fingerprint"):
                entry["reviewed_fingerprint"] = info["reviewed_fingerprint"]
            carried_from = info.get("carried_from") or scope_payload.get("baseline")
            if carried_from:
                entry["carried_from"] = carried_from
        areas[area_name] = entry

    baseline = scope_payload.get("baseline")
    sequence = 1
    if baseline:
        baseline_path = _manifest_path_for(repo, baseline)
        if baseline_path.exists():
            try:
                baseline_data = json.loads(baseline_path.read_text())
                sequence = (baseline_data.get("sequence") or 0) + 1
            except json.JSONDecodeError:
                pass

    manifest: Dict[str, Any] = {
        "schema_version": 1,
        "strategy_version": test_map.get("strategy_version"),
        "map_version": test_map.get("map_version"),
        "sequence": sequence,
        "predecessor": baseline,
        "status": "in_progress",
        "scope": {
            "kind": scope_payload.get("kind", "incremental"),
            "requested": None,
            "resolved_commit": scope_payload.get("resolved_commit"),
            "baseline": baseline,
        },
        "reviewed_revision": head,
        "dirty": is_dirty(repo),
        "history": scope_payload.get("history"),
        "completed_at": None,
        "areas": areas,
        "execution_evidence": [],
        "findings": [],
        "gaps": [],
    }
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "manifest.json"
    out_path.write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest


# ------------------------------------------------------------------- cli


def add_repo_arg(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--repo", type=Path, default=REPO_ROOT)


def cmd_select(args: argparse.Namespace) -> int:
    payload = select(args.repo, args.base, args.head, args.worktree)
    print(json.dumps(payload, indent=2 if not args.json else None))
    return 0


def cmd_fingerprint(args: argparse.Namespace) -> int:
    payload = semantic_fingerprint(args.repo, ref=args.ref, worktree=args.worktree)
    print(json.dumps(payload, indent=None if args.json else 2))
    return 0


def cmd_record(args: argparse.Namespace) -> int:
    try:
        result = record(args.repo, args.__dict__["from"], args.results)
    except ToolError as exc:
        print(json.dumps({"verdict": "error", "reason": str(exc)}))
        return 0
    args.o.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({"verdict": "ok", "path": str(args.o)}))
    return 0


def cmd_check_record(args: argparse.Namespace) -> int:
    record_data = json.loads(args.record.read_text())
    result = check_record(args.repo, record_data)
    print(json.dumps(result))
    return 0


def cmd_audit_scope(args: argparse.Namespace) -> int:
    areas_filter = args.areas.split(",") if args.areas else None
    payload = audit_scope(args.repo, args.since_last, args.full, args.since, areas_filter)
    print(json.dumps(payload, indent=2 if not args.json else None))
    return 0


def cmd_manifest_validate(args: argparse.Namespace) -> int:
    results = [validate_manifest(args.repo, p) for p in args.paths]
    if args.json:
        # A --json read always exits 0 with a verdict in the payload; the
        # caller decides what an "invalid" entry means. A single path is
        # one object, matching the skill's documented example — several
        # paths still return a list.
        payload: Any = results[0] if len(results) == 1 else results
        print(json.dumps(payload, indent=2))
        return 0
    any_invalid = False
    for result in results:
        if result["verdict"] == "invalid":
            any_invalid = True
            print(f"invalid: {result['path']}")
            for reason in result["reasons"]:
                print(f"  - {reason}")
        else:
            print(f"{result['verdict']}: {result['path']}")
    # A shell caller must not be able to miss an invalid manifest by only
    # checking $?, the way it could when this always exited 0.
    return 1 if any_invalid else 0


def cmd_manifest_new(args: argparse.Namespace) -> int:
    scope_payload = json.loads(args.scope.read_text())
    test_map = load_test_map(args.repo)
    targets = load_targets(args.repo)
    manifest = manifest_new(args.repo, scope_payload, args.o, test_map, targets)
    if args.json:
        print(json.dumps({"verdict": "ok", "manifest": manifest}, indent=2))
        return 0
    areas = manifest.get("areas") or {}
    total_paths = sum(area.get("path_count", 0) for area in areas.values())
    unowned_paths = (areas.get("unowned-tests") or {}).get("paths") or {}
    unowned_pytest = sum(1 for p in unowned_paths if glob_match(p, "tests/test_*.py"))
    unowned_vitest = sum(1 for p in unowned_paths if p.endswith((".test.ts", ".test.tsx")))
    unowned_e2e = sum(1 for p in unowned_paths if glob_match(p, "app/e2e/*.spec.ts"))
    out_path = args.o / "manifest.json"
    print(f"ok: wrote {out_path}")
    print(f"areas: {len(areas)}")
    print(f"total paths: {total_paths}")
    print(
        f"unowned-tests: {len(unowned_paths)} "
        f"(pytest={unowned_pytest}, vitest={unowned_vitest}, e2e={unowned_e2e})"
    )
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="test_scope.py")
    sub = parser.add_subparsers(dest="command", required=True)

    p_select = sub.add_parser("select")
    add_repo_arg(p_select)
    p_select.add_argument("--base", default="HEAD~1")
    p_select.add_argument("--head", default=None)
    p_select.add_argument("--worktree", action="store_true")
    p_select.add_argument("--json", action="store_true")
    p_select.set_defaults(func=cmd_select)

    p_fingerprint = sub.add_parser("fingerprint")
    add_repo_arg(p_fingerprint)
    fingerprint_source = p_fingerprint.add_mutually_exclusive_group(required=True)
    fingerprint_source.add_argument("--ref")
    fingerprint_source.add_argument("--worktree", action="store_true")
    p_fingerprint.add_argument("--json", action="store_true")
    p_fingerprint.set_defaults(func=cmd_fingerprint)

    p_record = sub.add_parser("record")
    add_repo_arg(p_record)
    p_record.add_argument("--from", dest="from", type=Path, required=True)
    p_record.add_argument("--results", type=Path, required=True)
    p_record.add_argument("-o", type=Path, required=True)
    p_record.set_defaults(func=cmd_record)

    p_check = sub.add_parser("check-record")
    add_repo_arg(p_check)
    p_check.add_argument("record", type=Path)
    p_check.set_defaults(func=cmd_check_record)

    p_audit = sub.add_parser("audit-scope")
    add_repo_arg(p_audit)
    group = p_audit.add_mutually_exclusive_group(required=True)
    group.add_argument("--since-last", action="store_true")
    group.add_argument("--since", default=None)
    group.add_argument("--full", action="store_true")
    p_audit.add_argument("--areas", default=None)
    p_audit.add_argument("--json", action="store_true")
    p_audit.set_defaults(func=cmd_audit_scope)

    p_manifest = sub.add_parser("manifest")
    manifest_sub = p_manifest.add_subparsers(dest="manifest_command", required=True)

    p_validate = manifest_sub.add_parser("validate")
    add_repo_arg(p_validate)
    p_validate.add_argument("paths", type=Path, nargs="+")
    p_validate.add_argument("--json", action="store_true")
    p_validate.set_defaults(func=cmd_manifest_validate)

    p_new = manifest_sub.add_parser("new")
    add_repo_arg(p_new)
    p_new.add_argument("--scope", type=Path, required=True)
    p_new.add_argument("-o", type=Path, required=True)
    p_new.add_argument("--json", action="store_true")
    p_new.set_defaults(func=cmd_manifest_new)

    return parser


def main(argv: Optional[List[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except ToolError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
