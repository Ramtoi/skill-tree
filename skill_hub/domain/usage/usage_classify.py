"""Pure classifiers for the usage-analytics ledgers: tool class, Bash class,
project matching, script-to-skill resolution, and excerpt redaction.

A leaf module: at module scope it imports stdlib, `mcp_spec`, `sync_links`
and `skill_meta` only, never `hub`. Every function here is pure — no file
read beyond `sync_links.link_target_abs`'s single symlink read, no network,
no wall clock — so a TypeScript or Rust twin can mirror the rules from the
corpora in `tests/fixtures/usage_activity_corpus.json` and
`tests/fixtures/usage_project_match_corpus.json` without reading this file.
See `openspec/changes/usage-loadout-analytics/design.md` D2 to D4.
"""

from __future__ import annotations

import ntpath
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from skill_hub.domain.mcp import mcp_spec
from skill_hub.domain.skills import skill_meta
from skill_hub.infrastructure.filesystem import sync_links

# ─────────────────────────────────────────────────────────────────────────────
# Tool → activity class
# ─────────────────────────────────────────────────────────────────────────────

#: Explicit tool-name to class map. `Bash`/`BashOutput` are classified by
#: command prefix (see `_classify_bash`), an `mcp__`-prefixed tool is always
#: `external`, and a name absent here falls back to `operate`. Design D4.
TOOL_CLASS: dict[str, str] = {
    "Read": "read",
    "Grep": "read",
    "Glob": "read",
    "LS": "read",
    "NotebookRead": "read",
    "WebFetch": "read",
    "WebSearch": "read",
    "ToolSearch": "read",
    "Edit": "edit",
    "Write": "edit",
    "MultiEdit": "edit",
    "NotebookEdit": "edit",
    "Agent": "delegate",
    "SendMessage": "delegate",
    "TaskCreate": "delegate",
    "TaskUpdate": "delegate",
    "TaskGet": "delegate",
    "TaskList": "delegate",
    "TeamCreate": "delegate",
    "TeamDelete": "delegate",
    "TaskStop": "delegate",
    "Skill": "skill",
    "SlashCommand": "skill",
}

#: Checked before `READ_ONLY_BASH_PREFIXES`, longest prefix first. Design D4.
VERIFY_BASH_PREFIXES: tuple[str, ...] = (
    "pytest",
    "python3 -m pytest",
    "python -m pytest",
    "tox",
    "npm test",
    "npm run test",
    "npm run lint",
    "npm run test:bundle",
    "yarn test",
    "pnpm test",
    "vitest",
    "npx vitest",
    "jest",
    "npx jest",
    "tsc",
    "npx tsc",
    "eslint",
    "npx eslint",
    "playwright test",
    "npx playwright test",
    "ruff check",
    "ruff format --check",
    "python3 -m ruff",
    "mypy",
    "python3 -m mypy",
    "cargo test",
    "cargo check",
    "cargo clippy",
    "go test",
    "go vet",
    "make test",
    "make check",
    "gradle test",
    "./gradlew test",
    "rspec",
    "bundle exec rspec",
    "dotnet test",
    "swift test",
    "ctest",
    "pre-commit run",
)

#: Checked after `VERIFY_BASH_PREFIXES` (and after any caller-supplied
#: `extra_verify`), longest prefix first. Design D4.
READ_ONLY_BASH_PREFIXES: tuple[str, ...] = (
    "ls",
    "cat",
    "head",
    "tail",
    "wc",
    "stat",
    "file",
    "tree",
    "du",
    "df",
    "pwd",
    "echo",
    "which",
    "type",
    "env",
    "printenv",
    "date",
    "hostname",
    "whoami",
    "grep",
    "rg",
    "find",
    "sort",
    "uniq",
    "diff",
    "jq",
    "awk",
    "sed -n",
    "less",
    "more",
    "git status",
    "git log",
    "git diff",
    "git show",
    "git branch",
    "git ls-files",
    "git rev-parse",
    "git blame",
    "gh pr view",
    "gh run view",
    "gh pr checks",
    "openspec list",
    "openspec show",
    "openspec validate",
)


def _normalize_bash_command(command: str) -> str:
    """Strip leading whitespace, drop one leading `sudo `, and classify a
    pipeline by its first command only. Design D4."""
    text = command.lstrip()
    if text == "sudo" or text.startswith("sudo "):
        text = text[len("sudo"):].lstrip()
    text = text.split("|", 1)[0]
    # Collapse internal whitespace runs so a prefix check is a clean
    # whitespace-joined-token comparison, per design D4.
    return " ".join(text.split())


def _matches_bash_prefix(command: str, prefixes: tuple[str, ...]) -> bool:
    for prefix in sorted(prefixes, key=len, reverse=True):
        if command == prefix or command.startswith(prefix + " "):
            return True
    return False


def classify_tool(
    tool_name: str,
    tool_input: dict,
    *,
    extra_verify: tuple[str, ...] = (),
) -> str:
    """One of the seven activity classes for a tool call. Design D4.

    The `mcp__` rule is checked first, so an MCP tool can never fall through
    to `operate`. `Bash`/`BashOutput` are classified by the `command` value
    of `tool_input`, checking `extra_verify` before the built-in verify
    table, then the read-only table, defaulting to `operate`.
    """
    if tool_name.startswith("mcp__"):
        return "external"
    if tool_name in ("Bash", "BashOutput"):
        raw_command = tool_input.get("command") if isinstance(tool_input, dict) else None
        command = _normalize_bash_command(raw_command) if isinstance(raw_command, str) else ""
        if not command:
            return "operate"
        if extra_verify and _matches_bash_prefix(command, extra_verify):
            return "verify"
        if _matches_bash_prefix(command, VERIFY_BASH_PREFIXES):
            return "verify"
        if _matches_bash_prefix(command, READ_ONLY_BASH_PREFIXES):
            return "read"
        return "operate"
    return TOOL_CLASS.get(tool_name, "operate")


# ─────────────────────────────────────────────────────────────────────────────
# Excerpt redaction
# ─────────────────────────────────────────────────────────────────────────────

_WHITESPACE_RE = re.compile(r"\s+")

#: Applied AFTER the home-prefix substitution (design D2, G23): a path
#: preceded by a word character, `:` or `/` is excluded, so
#: `https://github.com/org/repo` is left untouched. Requires at least one
#: directory segment before the final one, so a bare `/tmp` is left untouched
#: too. A match right after `~` (a home-rooted remainder) is still found
#: here — `_collapse_abs_path` is what keeps its `/` separator, per review
#: R6: a home-rooted path becomes `~/<last segment>`, any other absolute
#: path becomes its last segment alone, and a bare `~` (no `/` follows it at
#: all) never matches this regex and stays `~`.
_ABS_PATH_RE = re.compile(r"(?<![\w:/])/(?:[\w.@+-]+/)+[\w.@+-]+")

# Windows paths turn up in excerpts captured from another machine. Keep these
# patterns separate from the POSIX rule above so a POSIX filename containing a
# literal backslash does not become a path merely because it resembles one.
_WINDOWS_DRIVE_OR_UNC_RE = re.compile(r"^(?:[A-Za-z]:[\\/]|\\\\|//)")
_WINDOWS_ABS_PATH_RE = re.compile(
    r"(?<![\w:/\\])(?:[A-Za-z]:[\\/]+(?:[\w.@+-]+[\\/]+)*[\w.@+-]+|"
    r"(?:\\\\|//)[\w.@+-]+[\\/]+[\w.@+-]+(?:[\\/]+[\w.@+-]+)*)"
)
_WINDOWS_TILDE_PATH_RE = re.compile(r"(?<=~)[\\/](?:[\w.@+-]+[\\/]+)*[\w.@+-]+")

_REDACTED = "[redacted]"

# Search inside prose, including quotes, Markdown and JSON. The MCP value
# classifier below intentionally checks whole values; it is not a prose scan.
# Keep the backup scanner independent so it can still catch redaction bugs.
_CREDENTIAL_LITERAL_RE = re.compile(
    r"github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9]+|"
    r"\bsk-[A-Za-z0-9_\-]{20,}|\bAKIA[0-9A-Z]{16}\b|"
    r"\bxox[baprs]-[A-Za-z0-9-]+"
)


def _collapse_abs_path(match: "re.Match[str]") -> str:
    last_segment = match.group(0).rsplit("/", 1)[-1]
    start = match.start()
    # Preceded by `~`: keep the `/` so `~` + `/<last segment>` reads as a
    # home-rooted path, not `~` fused onto the filename (R6).
    if start > 0 and match.string[start - 1] == "~":
        return "/" + last_segment
    return last_segment


def _collapse_windows_abs_path(match: "re.Match[str]") -> str:
    return re.split(r"[\\/]+", match.group(0))[-1]


def _collapse_windows_tilde_path(match: "re.Match[str]") -> str:
    return "/" + _collapse_windows_abs_path(match)


def _is_windows_path(text: str) -> bool:
    return bool(_WINDOWS_DRIVE_OR_UNC_RE.match(text))


def _windows_home_prefix_re(home: str) -> Optional[re.Pattern[str]]:
    """Match one Windows home spelling with either path separator."""
    if not _is_windows_path(home):
        return None
    if home.startswith(("\\\\", "//")):
        parts = [part for part in re.split(r"[\\/]+", home[2:]) if part]
        prefix = r"(?:\\\\|//)"
    else:
        parts = [part for part in re.split(r"[\\/]+", home) if part]
        prefix = ""
    if not parts:
        return None
    pattern = prefix + r"[\\/]+".join(re.escape(part) for part in parts)
    return re.compile(r"(?<![\w:/\\])" + pattern + r"(?=$|[\\/])", re.IGNORECASE)


def _token_is_secret(tok: str, prev: str) -> bool:
    """The token-and-bigram secret scan of design D2 (G11)."""
    if not tok:
        return False
    if mcp_spec.looks_like_secret("", tok):
        return True
    if mcp_spec.looks_like_secret(prev.rstrip(":="), tok):
        return True
    if mcp_spec.looks_like_secret("", f"{prev} {tok}"):
        return True
    if "=" in tok:
        left, right = tok.split("=", 1)
        if mcp_spec.looks_like_secret(left, right):
            return True
    return False


def redact_excerpt_secrets(text: str) -> str:
    """Mask credentials without changing an existing excerpt's paths or length limit."""
    text = _CREDENTIAL_LITERAL_RE.sub(_REDACTED, text)
    tokens = text.split(" ")
    out: list[str] = []
    prev = ""
    for tok in tokens:
        out.append(_REDACTED if _token_is_secret(tok, prev) else tok)
        prev = tok
    return " ".join(out)


def redact_excerpt(text: str, *, limit: int = 200) -> str:
    """Redact a prompt excerpt for the usage ledgers. Design D2.

    Order: collapse whitespace runs, mask the home directory with `~`,
    collapse a remaining absolute path to its last segment (a home-rooted
    remainder keeps its `/` — `~/notes/todo.md` becomes `~/todo.md`, not
    `~todo.md` — a bare `~` with nothing after it stays `~`, and any other
    absolute path collapses to its last segment alone), scan tokens for
    secrets, then truncate. Truncation runs last, so a token cut in half can
    never survive the secret scan.
    """
    collapsed = _WHITESPACE_RE.sub(" ", text)
    home = str(Path.home())
    windows_home_re = _windows_home_prefix_re(home)
    if windows_home_re is not None:
        collapsed = windows_home_re.sub("~", collapsed)
    elif home not in ("", "/", "\\"):
        collapsed = collapsed.replace(home, "~")
    collapsed = _ABS_PATH_RE.sub(_collapse_abs_path, collapsed)
    collapsed = _WINDOWS_TILDE_PATH_RE.sub(_collapse_windows_tilde_path, collapsed)
    collapsed = _WINDOWS_ABS_PATH_RE.sub(_collapse_windows_abs_path, collapsed)
    collapsed = redact_excerpt_secrets(collapsed)
    return collapsed[:limit]


@dataclass(frozen=True)
class TextSkillMentions:
    """Bounded skill facts: only registered names are safe for persistence."""

    registered_keys: tuple[str, ...]
    mention_count: int


def text_skill_mentions(text: str, registry: dict) -> TextSkillMentions:
    """Return the legacy unique path-shaped skill mention facts for text."""
    names = set(re.findall(r"skills/([^/\s]+)/SKILL\.md", text))
    names.update(re.findall(r"skills/([^/\s]+)/", text))
    skills = registry.get("skills") if isinstance(registry, dict) else {}
    registered = tuple(sorted(name for name in names if isinstance(skills, dict) and name in skills))
    return TextSkillMentions(registered, len(names))


# ─────────────────────────────────────────────────────────────────────────────
# Project matching
# ─────────────────────────────────────────────────────────────────────────────


def _extract_worktree_segment(cwd: str) -> Optional[str]:
    marker = "/worktrees/"
    idx = cwd.find(marker)
    if idx < 0:
        return None
    rest = cwd[idx + len(marker):]
    slash_idx = rest.find("/")
    if slash_idx < 0:
        return None
    seg = rest[:slash_idx]
    return seg or None


def match_project(cwd: str, projects: list[tuple[str, Path]]) -> Optional[str]:
    """Python mirror of Rust `match_hub_project`
    (`app/src-tauri/src/commands/usage_enrich.rs`). Design D3.

    Compares path COMPONENTS, not string prefixes; case sensitive; the
    deepest matching registered project wins, ties broken by the smaller
    name. With no component match, falls back to a `/worktrees/<seg>/`
    segment matched first against project names, then against each
    project's path leaf, smallest name winning either way.
    """
    cwd_parts = Path(cwd).parts
    best: Optional[tuple[int, str]] = None
    for name, path in projects:
        proj_parts = Path(path).parts
        if not proj_parts or len(proj_parts) > len(cwd_parts):
            continue
        if cwd_parts[: len(proj_parts)] == proj_parts:
            length = len(proj_parts)
            if best is None or length > best[0] or (length == best[0] and name < best[1]):
                best = (length, name)
    if best is not None:
        return best[1]

    seg = _extract_worktree_segment(cwd)
    if seg is None:
        return None
    name_matches = sorted(name for name, _ in projects if name == seg)
    if name_matches:
        return name_matches[0]
    leaf_matches = sorted(name for name, path in projects if Path(path).name == seg)
    if leaf_matches:
        return leaf_matches[0]
    return None


# ─────────────────────────────────────────────────────────────────────────────
# Script-to-skill resolution
# ─────────────────────────────────────────────────────────────────────────────

_VARIANT_MARKER = "/state/skill_variants/"


def _path_for_comparison(path: str) -> str:
    """Normalize case and separators for Windows path comparisons."""
    if os.name == "nt" or _is_windows_path(path):
        return ntpath.normcase(path).replace("\\", "/")
    return path


def _resolved_registry_path_for_comparison(path: Path) -> str:
    """Normalize a recognized Windows extended link target for matching.

    `os.readlink` can return an extended DOS or UNC spelling even when the
    registry retains the ordinary spelling. Device namespaces stay untouched.
    """
    text = str(path)
    folded = text.lower()
    unc_prefix = "\\\\?\\unc\\"
    if folded.startswith(unc_prefix):
        text = "\\\\" + text[len(unc_prefix) :]
    else:
        dos_prefix = "\\\\?\\"
        if folded.startswith(dos_prefix):
            ordinary = text[len(dos_prefix) :]
            if (
                len(ordinary) >= 3
                and ordinary[0].isalpha()
                and ordinary[1] == ":"
                and ordinary[2] in "\\/"
            ):
                text = ordinary
    return _path_for_comparison(text)


def _root_matches_token(token: str, root: Path) -> bool:
    token_for_comparison = _path_for_comparison(token)
    root_for_comparison = _path_for_comparison(str(root))
    return token_for_comparison == root_for_comparison or token_for_comparison.startswith(
        root_for_comparison.rstrip("/") + "/"
    )


def _path_below_root(token: str, root: Path) -> str:
    """The candidate suffix, taken from the original token after comparison."""
    root_text = str(root)
    if os.name == "nt" or _is_windows_path(token) or _is_windows_path(root_text):
        return token[len(root_text):].lstrip("\\/").replace("\\", "/")
    return token[len(root_text):].lstrip("/")


def _first_path_token(command: str, roots: list[Path]) -> Optional[str]:
    """The first whitespace token in `command` below one of `roots`. Design D4."""
    for tok in command.split():
        if any(_root_matches_token(tok, root) for root in roots):
            return tok
    return None


def _matching_root(token: str, roots: list[Path]) -> Optional[Path]:
    for root in roots:
        if _root_matches_token(token, root):
            return root
    return None


def _resolve_through_root_link(token: str, roots: list[Path]) -> Optional[Path]:
    """Map a candidate command path onto its real, hub-owned location.

    Takes the first path segment below the matched root and, when that
    segment is itself a symlink (a harness skills-dir entry), follows it
    with `sync_links.link_target_abs` and continues with that target. A
    segment that is not a symlink (an entry already under
    `hub_core.data_home()/skills` or `.../mcp-servers`) is used as-is —
    `link_target_abs` returns `None` for it, and this falls back to the
    segment path unchanged. Design D4.
    """
    root = _matching_root(token, roots)
    if root is None:
        return None
    rel = _path_below_root(token, root)
    if not rel:
        return None
    parts = rel.split("/", 1)
    first_segment = parts[0]
    if not first_segment:
        return None
    rest = parts[1] if len(parts) > 1 else ""
    link_path = root / first_segment
    target = sync_links.link_target_abs(link_path)
    base = Path(target) if target is not None else link_path
    return (base / rest) if rest else base


def _variant_key_from_path(path: Path) -> Optional[str]:
    """A path under `state/skill_variants/<key>@<mode>/` resolves to `<key>`
    directly, handled first per design D4: a skill name cannot contain `@`.
    """
    text = str(path).replace("\\", "/")
    idx = text.find(_VARIANT_MARKER)
    if idx < 0:
        return None
    rest = text[idx + len(_VARIANT_MARKER):]
    if not rest:
        return None
    segment = rest.split("/", 1)[0]
    if not segment:
        return None
    key = segment.rsplit("@", 1)[0]
    return key or None


def _match_registry_source(resolved: Path, registry: dict) -> Optional[str]:
    """Longest-path-prefix match of `resolved` against
    `{skill_meta.skill_source(cfg): key for key, cfg in registry["skills"]}`.
    Design D4.

    `skill_meta.skill_source` calls `hub_core.fail` (a `sys.exit`) for a
    registry entry with no `source:` — a broken-registry state elsewhere,
    not a reason for this read-only classifier to abort a scan. Each
    candidate is tried independently so one bad entry does not blank the
    rest of the index.
    """
    skills = registry.get("skills") if isinstance(registry, dict) else None
    if not isinstance(skills, dict):
        return None
    resolved_str = _resolved_registry_path_for_comparison(resolved)
    best: Optional[tuple[int, str]] = None
    for key, cfg in skills.items():
        if not isinstance(cfg, dict):
            continue
        try:
            source = skill_meta.skill_source(cfg)
        except SystemExit:
            continue
        source_str = _path_for_comparison(str(source))
        if resolved_str == source_str or resolved_str.startswith(source_str.rstrip("/") + "/"):
            length = len(source_str)
            if best is None or length > best[0]:
                best = (length, key)
    return best[1] if best else None


def script_skill_key(command: str, registry: dict, roots: list[Path]) -> Optional[str]:
    """The registry skill key a Bash `command` invokes, or `None`.

    `roots` is the caller-resolved root list of design D4, in order: each
    effective harness's `project_skills_dir` under the project path, each
    effective harness's `global_skills_dir`, `hub_core.data_home()/skills`,
    `hub_core.data_home()/mcp-servers`.
    """
    token = _first_path_token(command, roots)
    if token is None:
        return None
    resolved = _resolve_through_root_link(token, roots)
    if resolved is None:
        return None
    variant_key = _variant_key_from_path(resolved)
    if variant_key is not None:
        skills = registry.get("skills") if isinstance(registry, dict) else None
        if isinstance(skills, dict) and variant_key in skills:
            return variant_key
        return None
    return _match_registry_source(resolved, registry)
