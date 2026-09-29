"""Agent Docs Snippets — reusable instruction blocks for agent doc files.

A snippet is a markdown instruction block stored at ``<data_home>/snippets/
<name>.md`` (YAML frontmatter + body). Applying one APPENDS its body to a
target agent doc file (``CLAUDE.md`` / ``AGENTS.md`` / nested docs) inside
hub-owned HTML-comment markers; removing excises that block.

There is NO separate tracking state. Every status is DERIVED by scanning file
content for marker blocks and comparing them against the library:

    applied   — block intact, matches the library version
    modified  — user edited the text inside the markers (wins over outdated)
    outdated  — block intact + matches what was applied, but the library
                snippet has since changed (offer "update")
    orphaned  — an intact block whose snippet no longer exists in the library
    (damaged) — an unpaired start/end marker line; not a block status, a
                file-level warning the user fixes by hand in the editor.

Marker format (hub-owned — never hand-authored):

    <!-- skill-tree:snippet id=<name> v=<version> sha=<applied-hash> -->
    …body…
    <!-- skill-tree:snippet:end id=<name> -->

``sha`` fingerprints the LIBRARY body at apply time (first 12 hex chars of
sha256 over the normalized body). That single field is what lets a pure scan
distinguish modified (in-file body hash ≠ sha) from outdated (in-file body
hash == sha, but sha ≠ current library hash). ``v`` is display-only.
"""

from __future__ import annotations

import hashlib
import os
import re
import shutil
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import yaml

from skill_hub.infrastructure.filesystem import agent_docs as _agent_docs

SNIPPETS_DIRNAME = "snippets"
MARKER_PREFIX = "<!-- skill-tree:snippet"
# Marker ownership is intentionally a narrow, line-oriented grammar.  The
# regular expressions are anchored and are matched only against a complete
# line with its line ending removed.  A marker-shaped HTML comment that does
# not match this grammar is a fail-closed diagnostic (unless it is inside an
# already-open block body).  Ordinary prose can name the marker token.
START_RE = re.compile(
    r"^<!-- skill-tree:snippet id=([a-z0-9][a-z0-9-]*) v=([^\s]+) sha=([a-z0-9]+) -->$"
)
END_RE = re.compile(r"^<!-- skill-tree:snippet:end id=([a-z0-9][a-z0-9-]*) -->$")
NAME_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")

AGENT_DOC_BASENAMES = ("CLAUDE.md", "AGENTS.md", "AGENT.md")
# Root files apply may create when absent; everything else must already exist.
KNOWN_ROOT_RELS = ("AGENTS.md", "CLAUDE.md", "AGENT.md")
# Root pairs kept byte-identical under a mirror binding.
MIRROR_PAIRS = (("CLAUDE.md", "AGENTS.md"), ("CLAUDE.md", "AGENT.md"))

MAX_SCAN_DEPTH = 8
MAX_SCAN_FILES = 500
_SKIP_DIRS = {
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    "__pycache__",
    ".venv",
    "venv",
}
_KEEP_HIDDEN_DIRS = {".claude", ".agents", ".pi", ".codex"}

STATUSES = ("applied", "modified", "outdated", "orphaned")


class SnippetError(Exception):
    """User-facing validation/operation error (CLI maps it to fail())."""


class SnippetMarkerError(SnippetError):
    """A write cannot continue because snippet-marker ownership is ambiguous."""

    def __init__(self, diagnostics: list[dict]):
        self.diagnostics = diagnostics
        lines = ", ".join(str(item["line"]) for item in diagnostics)
        location = f"line {lines}" if len(diagnostics) == 1 else f"lines {lines}"
        super().__init__(
            f"Snippet marker ownership is blocked at {location}. "
            "Repair the marker by hand before Hub writes."
        )


# ─────────────────────────────────────────────────────────────────────────────
# Hashing + body normalization
# ─────────────────────────────────────────────────────────────────────────────


def normalize_body(text: str) -> str:
    """CRLF→LF and trailing-whitespace trim — absorbs common editor noise."""
    return (text or "").replace("\r\n", "\n").rstrip()


def snip_hash(text: str) -> str:
    """First 12 hex chars of sha256 over the normalized body."""
    return hashlib.sha256(normalize_body(text).encode("utf-8")).hexdigest()[:12]


# ─────────────────────────────────────────────────────────────────────────────
# Library storage (<data_home>/snippets/<name>.md)
# ─────────────────────────────────────────────────────────────────────────────


@dataclass
class Snippet:
    name: str
    description: str = ""
    tags: list[str] = field(default_factory=list)
    version: int = 1
    body: str = ""
    created: str = ""
    updated: str = ""

    def to_dict(self, with_body: bool = True) -> dict:
        out = {
            "name": self.name,
            "description": self.description,
            "tags": list(self.tags),
            "version": self.version,
            "created": self.created,
            "updated": self.updated,
            "hash": snip_hash(self.body),
        }
        if with_body:
            out["body"] = self.body
        return out


def snippets_dir(data_home: Path) -> Path:
    d = data_home / SNIPPETS_DIRNAME
    d.mkdir(parents=True, exist_ok=True)
    return d


def normalize_tags(tags) -> list[str]:
    """Lowercase, strip, dedupe (order-preserving)."""
    out: list[str] = []
    for t in tags or []:
        t = str(t).strip().lower()
        if t and t not in out:
            out.append(t)
    return out


def validate_name(name: str) -> Optional[str]:
    if not name:
        return "Name is required."
    if not NAME_RE.match(name):
        return "Use lowercase kebab-case (letters, digits, single hyphens)."
    return None


def validate_body(body: str) -> Optional[str]:
    """Reject marker-like lines — they would corrupt pair location in targets."""
    for i, line in enumerate((body or "").split("\n"), start=1):
        if line.lstrip().startswith(MARKER_PREFIX):
            return f"Body line {i} looks like a snippet marker ({MARKER_PREFIX}…); not allowed inside a snippet body."
    return None


def _snippet_path(dirpath: Path, name: str) -> Path:
    return dirpath / f"{name}.md"


def load_snippet(path: Path) -> Optional[Snippet]:
    if not path.is_file():
        return None
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None
    meta: dict = {}
    body = text
    if text.lstrip().startswith("---"):
        parts = text.split("---", 2)
        if len(parts) >= 3:
            try:
                parsed = yaml.safe_load(parts[1]) or {}
                if isinstance(parsed, dict):
                    meta = parsed
                    body = parts[2].lstrip("\n")
            except yaml.YAMLError:
                pass
    try:
        version = int(meta.get("version", 1))
    except (TypeError, ValueError):
        version = 1
    return Snippet(
        name=path.stem,
        description=str(meta.get("description") or ""),
        tags=normalize_tags(meta.get("tags")),
        version=max(1, version),
        body=body.rstrip() + ("\n" if body.strip() else ""),
        created=str(meta.get("created") or ""),
        updated=str(meta.get("updated") or ""),
    )


def save_snippet(dirpath: Path, snippet: Snippet) -> Path:
    front = {
        "description": snippet.description,
        "tags": list(snippet.tags),
        "version": snippet.version,
    }
    if snippet.created:
        front["created"] = snippet.created
    if snippet.updated:
        front["updated"] = snippet.updated
    text = (
        "---\n"
        + yaml.dump(front, default_flow_style=False, allow_unicode=True, sort_keys=False)
        + "---\n"
        + normalize_body(snippet.body)
        + "\n"
    )
    path = _snippet_path(dirpath, snippet.name)
    tmp = path.with_suffix(".md.tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)
    return path


def list_snippets(
    dirpath: Path, tag: Optional[str] = None, query: Optional[str] = None
) -> list[Snippet]:
    out: list[Snippet] = []
    if not dirpath.is_dir():
        return out
    for p in sorted(dirpath.glob("*.md")):
        s = load_snippet(p)
        if s is None:
            continue
        if tag and tag.strip().lower() not in s.tags:
            continue
        if query:
            q = query.strip().lower()
            hay = "\n".join([s.name, s.description, s.body]).lower()
            if q not in hay:
                continue
        out.append(s)
    return out


def get_snippet(dirpath: Path, name: str) -> Optional[Snippet]:
    return load_snippet(_snippet_path(dirpath, name))


def library_by_name(dirpath: Path) -> dict[str, Snippet]:
    return {s.name: s for s in list_snippets(dirpath)}


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S")


def create_snippet(
    dirpath: Path,
    name: str,
    description: str = "",
    tags=None,
    body: str = "",
) -> Snippet:
    err = validate_name(name)
    if err:
        raise SnippetError(err)
    if _snippet_path(dirpath, name).exists():
        raise SnippetError(f'A snippet named "{name}" already exists.')
    err = validate_body(body)
    if err:
        raise SnippetError(err)
    snippet = Snippet(
        name=name,
        description=description or "",
        tags=normalize_tags(tags),
        version=1,
        body=normalize_body(body) + ("\n" if (body or "").strip() else ""),
        created=_now(),
        updated=_now(),
    )
    save_snippet(dirpath, snippet)
    return snippet


def edit_snippet(
    dirpath: Path,
    name: str,
    description: Optional[str] = None,
    tags=None,
    body: Optional[str] = None,
) -> tuple[Snippet, bool]:
    """Patch a snippet. The name is immutable (it is the marker id).

    Returns ``(snippet, body_changed)`` — the body change auto-bumps ``version``.
    """
    snippet = get_snippet(dirpath, name)
    if snippet is None:
        raise SnippetError(f'No snippet named "{name}".')
    body_changed = False
    if description is not None:
        snippet.description = description
    if tags is not None:
        snippet.tags = normalize_tags(tags)
    if body is not None:
        err = validate_body(body)
        if err:
            raise SnippetError(err)
        if normalize_body(body) != normalize_body(snippet.body):
            body_changed = True
            snippet.version += 1
        snippet.body = normalize_body(body) + ("\n" if body.strip() else "")
    snippet.updated = _now()
    save_snippet(dirpath, snippet)
    return snippet, body_changed


def delete_snippet(dirpath: Path, name: str) -> None:
    path = _snippet_path(dirpath, name)
    if not path.exists():
        raise SnippetError(f'No snippet named "{name}".')
    path.unlink()


# ─────────────────────────────────────────────────────────────────────────────
# Marker engine (port of the design-handoff engine, sha256 in place of FNV)
# ─────────────────────────────────────────────────────────────────────────────


def start_marker(name: str, version, sha: str) -> str:
    return f"<!-- skill-tree:snippet id={name} v={version} sha={sha} -->"


def end_marker(name: str) -> str:
    return f"<!-- skill-tree:snippet:end id={name} -->"


def build_block(snippet: Snippet) -> str:
    body = normalize_body(snippet.body)
    sha = snip_hash(snippet.body)
    return (
        start_marker(snippet.name, snippet.version, sha)
        + "\n"
        + body
        + "\n"
        + end_marker(snippet.name)
    )


def scan_content(content: str) -> dict:
    """Strictly scan complete, Hub-owned marker blocks.

    Markers must be unindented standalone lines, with either LF or CRLF line
    endings.  A marker-shaped comment outside a complete block is malformed if
    it does not match the grammar.  Ordinary prose can name the marker token.
    Marker-looking text *inside* a complete block is user body text.  ``blocks``
    retain character offsets and exact text so layout repair can move them
    without changing their bytes.
    """
    content = content or ""
    lines = content.splitlines(keepends=True)
    # splitlines does not represent a final empty logical line, which is fine:
    # markers must have visible line content.
    blocks: list[dict] = []
    damaged: list[dict] = []
    open_block: Optional[dict] = None
    offset = 0
    seen: set[str] = set()
    for i, raw in enumerate(lines):
        line = raw[:-2] if raw.endswith("\r\n") else raw[:-1] if raw.endswith("\n") else raw
        start = START_RE.fullmatch(line)
        end = END_RE.fullmatch(line)
        marker_shaped = line.lstrip().startswith(MARKER_PREFIX)
        if open_block:
            if start:
                damaged.append({"kind": "nested-start", "name": start.group(1), "line": i + 1})
                damaged.append({"kind": "incomplete-block", "name": open_block["name"], "line": open_block["start_line"] + 1})  # noqa: E501
                open_block = None
            elif end:
                if open_block["name"] != end.group(1):
                    damaged.append({"kind": "mismatched-end", "name": end.group(1), "line": i + 1})
                    damaged.append({"kind": "incomplete-block", "name": open_block["name"], "line": open_block["start_line"] + 1})  # noqa: E501
                else:
                    block = {
                        "name": open_block["name"], "version": open_block["version"],
                        "applied_sha": open_block["sha"],
                        "body": content[open_block["body_start"]:offset].rstrip("\r\n"),
                        "start_line": open_block["start_line"], "end_line": i,
                        "start": open_block["start"], "end": offset + len(raw),
                        "text": content[open_block["start"]:offset + len(raw)],
                    }
                    if block["name"] in seen:
                        damaged.append({"kind": "duplicate-id", "name": block["name"], "line": i + 1})
                    else:
                        seen.add(block["name"])
                        blocks.append(block)
                open_block = None
            # all other marker-like text within a body is body text by design.
        elif start:
            open_block = {"name": start.group(1), "version": start.group(2), "sha": start.group(3),
                          "start_line": i, "start": offset, "body_start": offset + len(raw)}
        elif end:
            damaged.append({"kind": "unmatched-end", "name": end.group(1), "line": i + 1})
        elif marker_shaped:
            damaged.append({"kind": "malformed-token", "name": None, "line": i + 1})
        offset += len(raw)
    if open_block:
        damaged.append({"kind": "incomplete-block", "name": open_block["name"], "line": open_block["start_line"] + 1})
    placement = "blocked" if damaged else "none"
    if blocks and not damaged:
        last = blocks[-1]
        # A canonical region has only whitespace after the last block, and no
        # non-whitespace gap between owned blocks.
        canonical = not content[last["end"]:].strip()
        if canonical:
            for left, right in zip(blocks, blocks[1:]):
                if content[left["end"]:right["start"]].strip():
                    canonical = False
                    break
        placement = "canonical" if canonical else "misplaced"
    return {"blocks": blocks, "damaged": damaged, "diagnostics": damaged, "placement": placement}


def _require_safe(content: str) -> dict:
    scanned = scan_content(content)
    if scanned["diagnostics"]:
        raise SnippetMarkerError(scanned["diagnostics"])
    return scanned


def reconcile_snippet_region(content: str) -> dict:
    """Return content with valid Hub blocks as one stable trailing region.

    Complete blocks are copied verbatim in encounter order; ordinary content
    remains in order ahead of them.  Structural ambiguity raises before any
    caller can create a backup or write a file.
    """
    scanned = _require_safe(content)
    blocks = scanned["blocks"]
    if not blocks:
        return {"content": content, "changed": False, **scanned}
    prose_parts: list[str] = []
    cursor = 0
    for block in blocks:
        prose_parts.append(content[cursor:block["start"]])
        cursor = block["end"]
    prose_parts.append(content[cursor:])
    prose = "".join(prose_parts)
    newline = "\r\n" if "\r\n" in content and "\n" not in content.replace("\r\n", "") else "\n"
    prose = prose.rstrip(" \t\r\n")
    block_texts = [b["text"].rstrip("\r\n") for b in blocks]
    canonical = (prose + (newline * 2 if prose else "") + (newline * 2).join(block_texts) + newline)
    changed = canonical != content
    result = scan_content(canonical)
    return {"content": canonical, "changed": changed, **result}


def status_of_block(block: dict, library: dict[str, Snippet]) -> str:
    """Pure function of file content + library — `modified` wins over `outdated`."""
    lib = library.get(block["name"])
    if lib is None:
        return "orphaned"
    if snip_hash(block["body"]) != block["applied_sha"]:
        return "modified"
    if block["applied_sha"] != snip_hash(lib.body):
        return "outdated"
    return "applied"


def append_block(content: str, block_text: str) -> str:
    newline = "\r\n" if "\r\n" in content and "\n" not in content.replace("\r\n", "") else "\n"
    base = content.rstrip("\r\n")
    return (base + newline * 2 if base else "") + block_text.replace("\n", newline) + newline


def excise_block(content: str, block: dict) -> str:
    """Remove one validated block by its exact scanner offsets."""
    before, after = content[:block["start"]], content[block["end"]:]
    # ``append_block`` owns one of the two separating newlines.  Give it back
    # when removing a clean terminal block so apply→remove restores prose.
    if not after and before.endswith("\r\n\r\n"):
        before = before[:-2]
    elif not after and before.endswith("\n\n"):
        before = before[:-1]
    return before + after


def replace_block(content: str, block: dict, new_block_text: str) -> str:
    newline = "\r\n" if "\r\n" in content and "\n" not in content.replace("\r\n", "") else "\n"
    return content[:block["start"]] + new_block_text.replace("\n", newline) + content[block["end"]:]


# ─────────────────────────────────────────────────────────────────────────────
# Target resolution + validation (registered projects only)
# ─────────────────────────────────────────────────────────────────────────────


def resolve_target(
    registry: dict,
    project_name: str,
    rel: Optional[str],
    installed: Optional[set[str]] = None,
    for_apply: bool = False,
) -> dict:
    """Resolve ``(project, rel)`` to a validated target.

    Returns ``{"project", "rel", "root", "path", "exists"}``.
    Raises SnippetError on: unknown project, path escape, non-agent-doc
    basename, missing file (non-known-root), derived-pointer / symlink target.
    """
    projects = (registry or {}).get("projects") or {}
    if project_name not in projects:
        raise SnippetError(f"Unknown project '{project_name}'.")
    proj = projects[project_name]
    root = Path(proj["path"]).expanduser()

    if not rel:
        res = _agent_docs.resolve_canonical_root(proj, registry, installed=installed)
        rel = res["canonical"] or _agent_docs.CANONICAL

    rel = rel.strip().lstrip("/")
    p = Path(rel)
    if p.is_absolute() or any(part in ("..", "") for part in p.parts):
        raise SnippetError(f"Invalid target path '{rel}': must be project-relative.")
    if p.name not in AGENT_DOC_BASENAMES:
        raise SnippetError(
            f"'{rel}' is not an agent doc file (expected basename one of: "
            + ", ".join(AGENT_DOC_BASENAMES)
            + ")."
        )
    target = root / p
    try:
        if root.resolve() not in target.resolve().parents and target.resolve() != root.resolve():
            raise SnippetError(f"Target '{rel}' escapes the project root.")
    except OSError as exc:
        raise SnippetError(f"Cannot resolve target '{rel}': {exc}") from exc

    if target.is_symlink():
        # Derived/pointer file — apply to the source instead.
        link = None
        try:
            link = os.readlink(target)
        except OSError:
            pass
        hint = f" Apply to '{link}' instead." if link else ""
        raise SnippetError(f"'{rel}' is a symlink (derived file), not a valid target.{hint}")

    exists = target.is_file()
    if not exists:
        creatable = for_apply and rel in KNOWN_ROOT_RELS
        if not creatable:
            raise SnippetError(f"Target file '{rel}' does not exist in {project_name}.")

    if exists and p.name == _agent_docs.CLAUDE and len(p.parts) == 1:
        klass = _agent_docs.classify_claude(root)
        if klass in ("derived-symlink", "derived-import"):
            raise SnippetError(
                f"'{rel}' is a derived pointer to {_agent_docs.CANONICAL}. "
                f"Apply to the canonical '{_agent_docs.CANONICAL}' instead."
            )

    return {
        "project": project_name,
        "rel": str(p),
        "root": root,
        "path": target,
        "exists": exists,
    }


# ─────────────────────────────────────────────────────────────────────────────
# Scan-based discovery (no sidecar — file content is the only truth)
# ─────────────────────────────────────────────────────────────────────────────


def iter_agent_doc_files(root: Path):
    """Yield project-relative paths of real (non-symlink) agent doc files.

    Bounded walk: depth ≤ MAX_SCAN_DEPTH, ≤ MAX_SCAN_FILES yields, heavy and
    hidden dirs pruned (hub-relevant dot-dirs kept).
    """
    root = root.expanduser()
    if not root.is_dir():
        return
    count = 0
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        reldir = Path(dirpath).relative_to(root)
        depth = len(reldir.parts)
        if depth >= MAX_SCAN_DEPTH:
            dirnames[:] = []
        else:
            dirnames[:] = sorted(
                d
                for d in dirnames
                if d not in _SKIP_DIRS
                and (not d.startswith(".") or d in _KEEP_HIDDEN_DIRS)
            )
        for fname in sorted(filenames):
            if fname not in AGENT_DOC_BASENAMES:
                continue
            fpath = Path(dirpath) / fname
            if fpath.is_symlink():
                continue
            yield str(reldir / fname) if reldir.parts else fname
            count += 1
            if count >= MAX_SCAN_FILES:
                return


def scan_project(
    project_name: str, proj_cfg: dict, library: dict[str, Snippet]
) -> dict:
    """Scan one project's agent docs. Returns ``{"locations": [...], "damaged": [...]}``."""
    root = Path(proj_cfg["path"]).expanduser()
    locations: list[dict] = []
    damaged: list[dict] = []
    for rel in iter_agent_doc_files(root):
        try:
            content = (root / rel).read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        res = scan_content(content)
        for b in res["blocks"]:
            locations.append(
                {
                    "project": project_name,
                    "rel": rel,
                    "path": str(root / rel),
                    "snippet": b["name"],
                    "version": b["version"],
                    "applied_sha": b["applied_sha"],
                    "status": status_of_block(b, library),
                    "placement": res["placement"],
                }
            )
        for d in res["damaged"]:
            damaged.append({"project": project_name, "rel": rel, **d})
    return {"locations": locations, "damaged": damaged}


def scan_all(registry: dict, library: dict[str, Snippet]) -> dict:
    locations: list[dict] = []
    damaged: list[dict] = []
    for name, cfg in ((registry or {}).get("projects") or {}).items():
        res = scan_project(name, cfg, library)
        locations.extend(res["locations"])
        damaged.extend(res["damaged"])
    return {"locations": locations, "damaged": damaged}


def applied_locations(registry: dict, library: dict[str, Snippet], name: str) -> list[dict]:
    return [
        loc for loc in scan_all(registry, library)["locations"] if loc["snippet"] == name
    ]


def usage_rollup(locs: list[dict]) -> dict:
    """Roll-up: count + worst status (for the library list pip).

    Takes an already-filtered location list so callers that already have one
    scan's worth of locations (e.g. grouped by snippet) don't have to re-walk
    the filesystem per snippet.
    """
    if any(l["status"] == "modified" for l in locs):
        summary = "modified"
    elif any(l["status"] == "outdated" for l in locs):
        summary = "outdated"
    elif locs:
        summary = "applied"
    else:
        summary = "none"
    return {
        "count": len(locs),
        "summary": summary,
        "outdated_count": sum(1 for l in locs if l["status"] == "outdated"),
        "locations": locs,
    }


def snippet_usage(registry: dict, library: dict[str, Snippet], name: str) -> dict:
    """Roll-up for ONE snippet. Walks the whole tree — callers listing many
    snippets should walk once via `scan_all` and call `usage_rollup` per
    snippet instead (see `cmd_snippet_list`)."""
    return usage_rollup(applied_locations(registry, library, name))


# ─────────────────────────────────────────────────────────────────────────────
# Mutations (backup-first, atomic, mirror-aware)
# ─────────────────────────────────────────────────────────────────────────────


def _backup_target(path: Path, project_name: str, rel: str, backups_root: Path) -> Optional[str]:
    if not path.is_file():
        return None
    dest_dir = backups_root / "snippets" / project_name
    dest_dir.mkdir(parents=True, exist_ok=True)
    ts = time.strftime("%Y%m%d-%H%M%S")
    flat = rel.replace(os.sep, "__").replace("/", "__")
    dest = dest_dir / f"{ts}-{flat}"
    n = 1
    while dest.exists():
        dest = dest_dir / f"{ts}-{n}-{flat}"
        n += 1
    shutil.copy2(path, dest, follow_symlinks=True)
    return str(dest)


def _atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".hub-tmp")
    tmp.write_text(content, encoding="utf-8")
    os.replace(tmp, path)


def _proposed_content(pre: str, mutate) -> tuple[dict, str]:
    """Preflight existing ownership, mutate, then validate/reconcile output."""
    scan = _require_safe(pre)
    proposed = mutate(scan)
    reconciled = reconcile_snippet_region(proposed)
    return scan, reconciled["content"]


def _sync_mirror(
    root: Path, rel: str, pre_content: str, new_content: str,
    project_name: str, backups_root: Path,
) -> list[dict]:
    """Keep a mirror-bound partner root byte-identical after a mutation.

    A mirror binding is recognized on disk: both root files exist as real
    files and were byte-identical before the write. Returns the synced
    partners as ``[{"rel", "backup"}]``.
    """
    synced: list[dict] = []
    for a, b in MIRROR_PAIRS:
        if rel not in (a, b):
            continue
        partner_rel = b if rel == a else a
        partner = root / partner_rel
        if partner.is_symlink() or not partner.is_file():
            continue
        try:
            partner_txt = partner.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        if partner_txt != pre_content:
            continue
        backup = _backup_target(partner, project_name, partner_rel, backups_root)
        _atomic_write(partner, new_content)
        synced.append({"rel": partner_rel, "backup": backup})
    return synced


def _preflight_mirrors(root: Path, rel: str, pre_content: str) -> None:
    """Reject a mutation before its backup/write if its bound mirror is unsafe."""
    for a, b in MIRROR_PAIRS:
        if rel not in (a, b):
            continue
        partner = root / (b if rel == a else a)
        if partner.is_symlink() or not partner.is_file():
            continue
        try:
            partner_text = partner.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        if partner_text == pre_content:
            _require_safe(partner_text)


def reconcile_snippet_file(
    registry: dict,
    library: dict[str, Snippet],
    backups_root: Path,
    project_name: str,
    rel: Optional[str] = None,
    *,
    apply: bool = False,
    installed: Optional[set[str]] = None,
) -> dict:
    """Preview or apply a trailing-region repair for one registered target."""
    target = resolve_target(registry, project_name, rel, installed=installed)
    pre = target["path"].read_text(encoding="utf-8")
    result = reconcile_snippet_region(pre)
    payload = {
        "action": "reconcile", "project": project_name, "rel": target["rel"],
        "path": str(target["path"]), "placement": scan_content(pre)["placement"],
        "changed": result["changed"], "diagnostics": result["diagnostics"],
        "applied": False, "backup": None,
    }
    if apply and result["changed"]:
        _preflight_mirrors(target["root"], target["rel"], pre)
        payload["backup"] = _backup_target(target["path"], project_name, target["rel"], backups_root)
        _atomic_write(target["path"], result["content"])
        payload["mirrored"] = _sync_mirror(target["root"], target["rel"], pre, result["content"], project_name, backups_root)  # noqa: E501
        payload["applied"] = True
    return payload


def apply_snippet(
    registry: dict,
    library: dict[str, Snippet],
    backups_root: Path,
    name: str,
    project_name: str,
    rel: Optional[str] = None,
    installed: Optional[set[str]] = None,
) -> dict:
    snippet = library.get(name)
    if snippet is None:
        raise SnippetError(f'No snippet named "{name}".')
    target = resolve_target(registry, project_name, rel, installed=installed, for_apply=True)
    pre = target["path"].read_text(encoding="utf-8") if target["exists"] else ""
    scanned = _require_safe(pre)
    if any(b["name"] == name for b in scanned["blocks"]):
        raise SnippetError(
            f'"{name}" is already applied to {target["rel"]} — use `hub snippet update` to refresh it.'
        )
    _, new = _proposed_content(pre, lambda _scan: append_block(pre, build_block(snippet)))
    _preflight_mirrors(target["root"], target["rel"], pre)
    backup = _backup_target(target["path"], project_name, target["rel"], backups_root)
    _atomic_write(target["path"], new)
    mirrored = _sync_mirror(
        target["root"], target["rel"], pre, new, project_name, backups_root
    )
    return {
        "action": "apply",
        "snippet": name,
        "project": project_name,
        "rel": target["rel"],
        "path": str(target["path"]),
        "created": not target["exists"],
        "version": snippet.version,
        "backup": backup,
        "mirrored": mirrored,
    }


def _find_block(content: str, name: str, rel: str) -> dict:
    res = _require_safe(content)
    block = next((b for b in res["blocks"] if b["name"] == name), None)
    if block is None:
        raise SnippetError(f'"{name}" is not applied to {rel}.')
    return block


def remove_snippet(
    registry: dict,
    library: dict[str, Snippet],
    backups_root: Path,
    name: str,
    project_name: str,
    rel: Optional[str] = None,
    force: bool = False,
    installed: Optional[set[str]] = None,
) -> dict:
    target = resolve_target(registry, project_name, rel, installed=installed)
    pre = target["path"].read_text(encoding="utf-8")
    block = _find_block(pre, name, target["rel"])
    status = status_of_block(block, library)
    if status == "modified" and not force:
        raise SnippetError(
            f'The "{name}" block in {target["rel"]} was edited after apply — '
            f"removing would discard those edits. Re-run with --force to remove anyway."
        )
    _, new = _proposed_content(pre, lambda _scan: excise_block(pre, block))
    _preflight_mirrors(target["root"], target["rel"], pre)
    backup = _backup_target(target["path"], project_name, target["rel"], backups_root)
    _atomic_write(target["path"], new)
    mirrored = _sync_mirror(
        target["root"], target["rel"], pre, new, project_name, backups_root
    )
    return {
        "action": "remove",
        "snippet": name,
        "project": project_name,
        "rel": target["rel"],
        "path": str(target["path"]),
        "status_before": status,
        "backup": backup,
        "mirrored": mirrored,
    }


def update_snippet_in_file(
    registry: dict,
    library: dict[str, Snippet],
    backups_root: Path,
    name: str,
    project_name: str,
    rel: Optional[str] = None,
    force: bool = False,
    installed: Optional[set[str]] = None,
) -> dict:
    snippet = library.get(name)
    if snippet is None:
        raise SnippetError(f'No snippet named "{name}" — orphaned blocks cannot be updated.')
    target = resolve_target(registry, project_name, rel, installed=installed)
    pre = target["path"].read_text(encoding="utf-8")
    block = _find_block(pre, name, target["rel"])
    status = status_of_block(block, library)
    if status == "modified" and not force:
        raise SnippetError(
            f'The "{name}" block in {target["rel"]} was edited after apply — '
            f"updating would discard those edits. Re-run with --force to update anyway."
        )
    _, new = _proposed_content(pre, lambda _scan: replace_block(pre, block, build_block(snippet)))
    _preflight_mirrors(target["root"], target["rel"], pre)
    backup = _backup_target(target["path"], project_name, target["rel"], backups_root)
    _atomic_write(target["path"], new)
    mirrored = _sync_mirror(
        target["root"], target["rel"], pre, new, project_name, backups_root
    )
    return {
        "action": "update",
        "snippet": name,
        "project": project_name,
        "rel": target["rel"],
        "path": str(target["path"]),
        "status_before": status,
        "version": snippet.version,
        "backup": backup,
        "mirrored": mirrored,
    }


def update_everywhere(
    registry: dict,
    library: dict[str, Snippet],
    backups_root: Path,
    name: str,
    installed: Optional[set[str]] = None,
) -> dict:
    """Refresh every outdated location; skip modified ones (report them)."""
    if name not in library:
        raise SnippetError(f'No snippet named "{name}".')
    refreshed: list[dict] = []
    skipped: list[dict] = []
    for loc in applied_locations(registry, library, name):
        if loc["status"] == "outdated":
            res = update_snippet_in_file(
                registry,
                library,
                backups_root,
                name,
                loc["project"],
                loc["rel"],
                installed=installed,
            )
            refreshed.append(res)
        elif loc["status"] == "modified":
            skipped.append(loc)
    return {"action": "update-everywhere", "snippet": name, "refreshed": refreshed, "skipped": skipped}


def _line_ending(line: str) -> str:
    """The line ending ("", "\\n", or "\\r\\n") of a keepends() line."""
    if line.endswith("\r\n"):
        return "\r\n"
    if line.endswith("\n"):
        return "\n"
    return ""


def rename_snippet(
    registry: dict,
    dirpath: Path,
    backups_root: Path,
    old: str,
    new: str,
    installed: Optional[set[str]] = None,
) -> dict:
    """Rename a snippet and rewrite its marker id in every applied block.

    A snippet's name IS the marker id embedded in every applied block across
    project agent-doc files, so renaming the library entry alone would strand
    every existing block under the old id. Applied locations are collected
    BEFORE the library file is renamed (their on-disk content still names
    ``old``); the library rename happens next (a plain ``os.rename``, no
    frontmatter or version change — the name is only the file stem); each
    location is then rewritten independently.

    Contract on partial failure: this is per-file error-isolated, same as
    every other snippet mutation. A location that cannot be rewritten (a
    damaged file, a permissions error, a mirror partner already rewritten
    earlier in this same loop) is appended to ``errors`` and skipped — it
    NEVER unwinds the already-renamed library file. Such a block simply keeps
    its old marker id; since the library no longer has a snippet named
    ``old``, the scan-derived status system reads it as ORPHANED afterwards —
    an honest, visible failure mode rather than a silent one. A location
    whose block had already vanished by the time this loop re-read it (the
    mirror-partner case above) is instead appended to ``skipped`` — neither a
    success nor a failure, just nothing left to do there.

    Before any of that, a PRE-FLIGHT pass (below) rejects the whole rename
    up front if any target already carries a marker literally named ``new``
    — writing the rename into that file would produce a file with TWO blocks
    sharing one id, which every later snippet write to it (including the
    undo) would then refuse to touch. Aborting before ``old`` is renamed
    keeps that case a clean no-op instead of a partial, hard-to-recover mess.
    """
    # M1: `old` must be a real kebab-case slug BEFORE it is ever used to build
    # a filesystem path — `_snippet_path` does a plain string join, so an
    # unvalidated `old` like "../victim" would let this function move an
    # arbitrary file into the library. The message deliberately matches the
    # ordinary "unknown snippet" case rather than naming the mechanics.
    if validate_name(old) is not None or get_snippet(dirpath, old) is None:
        raise SnippetError(f'No snippet named "{old}".')
    err = validate_name(new)
    if err:
        raise SnippetError(err)
    if new == old:
        raise SnippetError(f'"{new}" is already the current name.')
    if _snippet_path(dirpath, new).exists():
        raise SnippetError(f'A snippet named "{new}" already exists.')

    # Collect BEFORE the rename — the scan still finds blocks named `old`.
    library = library_by_name(dirpath)
    locs = applied_locations(registry, library, old)

    # C1(a) pre-flight: a target may already carry an untouched marker block
    # literally named `new` (e.g. a snippet deleted with `--force`, whose
    # in-file block was left behind as orphaned, then reused as this rename's
    # target name). Splicing `old` -> `new` into that same file would then
    # leave TWO blocks named `new` — `scan_content` treats the second as a
    # `duplicate-id` diagnostic, which blocks every future write to that file
    # (including a later undo). Reject the whole rename before `old` is ever
    # renamed rather than let that happen. A file that can't be read/scanned
    # here is NOT this pre-flight's concern — it falls through to the
    # per-file `errors` handling in the main loop below, same as always.
    conflicts: list[str] = []
    for loc in locs:
        try:
            conflict_target = resolve_target(registry, loc["project"], loc["rel"], installed=installed)
            conflict_pre = conflict_target["path"].read_text(encoding="utf-8")
            conflict_scanned = _require_safe(conflict_pre)
        except (SnippetError, OSError):
            continue
        if any(b["name"] == new for b in conflict_scanned["blocks"]):
            conflicts.append(f'{loc["project"]}/{loc["rel"]}')
    if conflicts:
        raise SnippetError(
            f'Marker id "{new}" already exists in {", ".join(conflicts)} — remove that block first.'
        )

    os.rename(_snippet_path(dirpath, old), _snippet_path(dirpath, new))

    renamed: list[dict] = []
    errors: list[dict] = []
    skipped: list[dict] = []
    for loc in locs:
        project_name = loc["project"]
        rel = loc["rel"]
        try:
            target = resolve_target(registry, project_name, rel, installed=installed)
            pre = target["path"].read_text(encoding="utf-8")
            # Re-scan fresh: a damaged file becomes a caught error entry, not
            # a crash (`_require_safe` raises SnippetError on ownership
            # violations, which the outer except below catches per-file).
            scanned = _require_safe(pre)
            block = next((b for b in scanned["blocks"] if b["name"] == old), None)
            if block is None:
                # A mirror-bound partner (`_sync_mirror`) may already have
                # rewritten this exact file earlier in this same loop —
                # `scan_all` lists CLAUDE.md and AGENTS.md as separate
                # locations when both are real files. Nothing left to do.
                skipped.append(
                    {
                        "project": project_name,
                        "rel": rel,
                        "reason": (
                            f'no block named "{old}" on re-read (mirror partner '
                            "already rewritten, or the file changed since the scan)"
                        ),
                    }
                )
                continue
            # Build the new block from the block's OWN in-file v=/sha= —
            # they may be older than the library's; preserving them exactly
            # keeps applied/outdated/modified status stable across a rename.
            lines = block["text"].splitlines(keepends=True)
            new_lines = (
                [start_marker(new, block["version"], block["applied_sha"]) + _line_ending(lines[0])]
                + lines[1:-1]
                + [end_marker(new) + _line_ending(lines[-1])]
            )
            new_text = "".join(new_lines)
            new_content = pre[: block["start"]] + new_text + pre[block["end"] :]
            # C1(b) belt: re-validate the PROPOSED content before writing it.
            # The pre-flight above already checked for a `new`-named conflict
            # at scan time; this catches the same class of problem (or any
            # other ownership violation) introduced in the window between
            # that scan and this write — a caught per-file error instead of
            # a written-but-blocked duplicate-id file.
            _require_safe(new_content)
            _preflight_mirrors(target["root"], target["rel"], pre)
            backup = _backup_target(target["path"], project_name, target["rel"], backups_root)
            _atomic_write(target["path"], new_content)
            mirrored = _sync_mirror(
                target["root"], target["rel"], pre, new_content, project_name, backups_root
            )
            renamed.append(
                {
                    "project": project_name,
                    "rel": target["rel"],
                    "path": str(target["path"]),
                    "backup": backup,
                    "mirrored": mirrored,
                }
            )
        except (SnippetError, OSError) as exc:
            errors.append({"project": project_name, "rel": rel, "error": str(exc)})

    return {
        "action": "rename",
        "from": old,
        "to": new,
        "renamed": renamed,
        "errors": errors,
        "skipped": skipped,
    }
