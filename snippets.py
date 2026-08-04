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

import agent_docs as _agent_docs

SNIPPETS_DIRNAME = "snippets"
MARKER_PREFIX = "<!-- skill-tree:snippet"
START_RE = re.compile(
    r"<!--\s*skill-tree:snippet\s+id=([a-z0-9][a-z0-9-]*)\s+v=(\S+)\s+sha=([a-z0-9]+)\s*-->"
)
END_RE = re.compile(r"<!--\s*skill-tree:snippet:end\s+id=([a-z0-9][a-z0-9-]*)\s*-->")
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
    """Find marker blocks + damaged (unpaired) markers in file content.

    Returns ``{"blocks": [...], "damaged": [...]}`` where each block is
    ``{name, version, applied_sha, body, start_line, end_line}`` (0-based
    lines) and each damaged entry is ``{kind, name, line}`` (1-based line).
    """
    lines = (content or "").split("\n")
    blocks: list[dict] = []
    damaged: list[dict] = []
    open_block: Optional[dict] = None
    for i, line in enumerate(lines):
        s = START_RE.search(line)
        e = END_RE.search(line)
        if s:
            if open_block:
                damaged.append(
                    {
                        "kind": "unpaired-start",
                        "name": open_block["name"],
                        "line": open_block["start_line"] + 1,
                    }
                )
            open_block = {
                "name": s.group(1),
                "version": s.group(2),
                "sha": s.group(3),
                "start_line": i,
            }
        elif e:
            if open_block and open_block["name"] == e.group(1):
                body = "\n".join(lines[open_block["start_line"] + 1 : i])
                blocks.append(
                    {
                        "name": open_block["name"],
                        "version": open_block["version"],
                        "applied_sha": open_block["sha"],
                        "body": body,
                        "start_line": open_block["start_line"],
                        "end_line": i,
                    }
                )
                open_block = None
            elif open_block:
                damaged.append(
                    {
                        "kind": "unpaired-start",
                        "name": open_block["name"],
                        "line": open_block["start_line"] + 1,
                    }
                )
                damaged.append(
                    {"kind": "unpaired-end", "name": e.group(1), "line": i + 1}
                )
                open_block = None
            else:
                damaged.append(
                    {"kind": "unpaired-end", "name": e.group(1), "line": i + 1}
                )
    if open_block:
        damaged.append(
            {
                "kind": "unpaired-start",
                "name": open_block["name"],
                "line": open_block["start_line"] + 1,
            }
        )
    return {"blocks": blocks, "damaged": damaged}


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
    base = normalize_body(content)
    return (base + "\n\n" if base else "") + block_text + "\n"


def excise_block(content: str, block: dict) -> str:
    """Remove a block's lines, collapsing the separator it brought along."""
    lines = (content or "").split("\n")
    del lines[block["start_line"] : block["end_line"] + 1]
    next_text = re.sub(r"\n{3,}", "\n\n", "\n".join(lines))
    next_text = next_text.rstrip()
    return next_text + "\n" if next_text else ""


def replace_block(content: str, block: dict, new_block_text: str) -> str:
    lines = (content or "").split("\n")
    lines[block["start_line"] : block["end_line"] + 1] = new_block_text.split("\n")
    return "\n".join(lines).rstrip() + "\n"


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


def snippet_usage(registry: dict, library: dict[str, Snippet], name: str) -> dict:
    """Roll-up: count + worst status (for the library list pip)."""
    locs = applied_locations(registry, library, name)
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
    if any(b["name"] == name for b in scan_content(pre)["blocks"]):
        raise SnippetError(
            f'"{name}" is already applied to {target["rel"]} — use `hub snippet update` to refresh it.'
        )
    backup = _backup_target(target["path"], project_name, target["rel"], backups_root)
    new = append_block(pre, build_block(snippet))
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
    res = scan_content(content)
    block = next((b for b in res["blocks"] if b["name"] == name), None)
    if block is None:
        if any(d["name"] == name for d in res["damaged"]):
            raise SnippetError(
                f'The markers for "{name}" in {rel} are damaged (unpaired). '
                f"Automatic removal is not possible — clean the block up by hand in the editor."
            )
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
    backup = _backup_target(target["path"], project_name, target["rel"], backups_root)
    new = excise_block(pre, block)
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
    backup = _backup_target(target["path"], project_name, target["rel"], backups_root)
    new = replace_block(pre, block, build_block(snippet))
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
