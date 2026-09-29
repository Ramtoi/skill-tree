"""A harness's user-global instruction doc can follow another harness's.

Every harness that has one (`Harness.global_doc` — `~/.claude/CLAUDE.md`,
`~/.codex/AGENTS.md`, `~/.pi/agent/AGENTS.md`,
`~/.config/opencode/AGENTS.md`) reads it on every session. Two harnesses can
read the SAME text by having one **follow** the other: the follower's doc
becomes a relative symlink resolving to the source harness's real file.

Same philosophy as project-root agent docs (see `agent_docs.py`'s module
docstring): the relationship is **self-describing on disk** — a plain
symlink, nothing in `registry.yaml`, no separate tracking store. Scanning the
filesystem is the only source of truth, which is why every mutation here
first re-derives `status()` rather than trusting a caller's claim about the
current state.

States, per harness (`status()`'s `state` field):

    missing     no file
    standalone  a regular file nobody follows
    source      a regular file at least one other harness follows
    follows     a symlink resolving to another harness's doc
    broken      a symlink whose target does not exist
    external    a symlink to somewhere that is not a harness doc (untouched)

Chains are not allowed: `link()` always resolves a `follows` source to its
real target before linking, so a follower's symlink always points directly at
a real file, never at another symlink.
"""

from __future__ import annotations

import os
import shutil
import time
from pathlib import Path
from typing import Any, Optional

from skill_hub.infrastructure.harnesses import harnesses as _harnesses

PREVIEW_CHARS = 400


# ─────────────────────────────────────────────────────────────────────────────
# Path resolution
# ─────────────────────────────────────────────────────────────────────────────


def _context_doc_path(context: Any, harness_id: str) -> Optional[Path]:
    """Resolve a document only from a supplied operation snapshot."""
    route_for = getattr(context, "route", None)
    if not callable(route_for):
        return None
    try:
        route = route_for(harness_id, "agent_docs")
    except (OSError, TypeError, ValueError, KeyError):
        return None
    if (getattr(route, "status", None) != "shadow"
            or getattr(route, "mode", "unavailable") != "legacy_shadow"):
        return None

    def as_path(value: Any) -> Optional[Path]:
        if value is None or isinstance(value, Path):
            return value
        try:
            return Path(value) if isinstance(value, (str, os.PathLike)) else None
        except TypeError:
            return None

    target = getattr(context, "doc_target", None)
    if callable(target):
        return as_path(target(harness_id))
    layout_for = getattr(context, "layout", None)
    layout = layout_for(harness_id) if callable(layout_for) else None
    if layout is None:
        return None
    target = getattr(layout, "doc_target", None)
    value = target() if callable(target) else getattr(layout, "global_doc", None)
    return as_path(value)


def doc_path(harness_id: str, *, context: Any = None) -> Optional[Path]:
    """Env-aware user-global instruction-doc path for a harness id, or None.

    `Harness.global_doc` hardcodes `~` and honors no env var, so the two
    harnesses that DO have an overridable home get rebased onto it; the rest
    fall back to plain `~` expansion (which `$HOME` isolation already
    covers). Moved here from `backup.harness_global_doc` — `backup.py` now
    imports this function (kept there as a thin alias so nothing else
    breaks).
    """
    if context is not None:
        return _context_doc_path(context, harness_id)
    h = _harnesses.HARNESSES.get(harness_id)
    if h is None or h.global_doc is None:
        return None
    # `Harness.global_doc` is a PurePath.  `str(PureWindowsPath(...))` uses
    # backslashes, while the templates below are written with POSIX-style
    # separators.  Normalize through `as_posix()` before matching so the
    # Claude/Codex env-home overrides work on every host platform.
    raw = h.global_doc.as_posix()
    try:
        from skill_hub.infrastructure.harnesses import subagents

        if harness_id == "claude-code" and raw.startswith("~/.claude/"):
            return subagents.claude_home() / raw[len("~/.claude/") :]
        if harness_id == "codex" and raw.startswith("~/.codex/"):
            from skill_hub.infrastructure.harnesses import subagent_codex

            return subagent_codex.codex_home() / raw[len("~/.codex/") :]
    except Exception:
        pass
    return Path(raw).expanduser()


def _known_harness_ids(context: Any = None) -> list:
    if context is not None:
        return sorted(str(h) for h in getattr(context, "harness_ids", ()))
    return sorted(h_id for h_id, h in _harnesses.HARNESSES.items() if h.global_doc is not None)


def _all_doc_paths(context: Any = None) -> dict:
    """`{harness_id: Path}` for every harness with a global-doc concept and a
    resolvable path (should be every one of them — `doc_path` only returns
    `None` for an unknown id or a harness without the concept)."""
    out = {}
    for h_id in _known_harness_ids(context):
        p = doc_path(h_id, context=context)
        if p is not None:
            out[h_id] = p
    return out


# ─────────────────────────────────────────────────────────────────────────────
# Status detection (read-only)
# ─────────────────────────────────────────────────────────────────────────────


def _classify_one(h_id: str, p: Path, all_paths: dict) -> dict:
    """Raw per-harness classification, before followers are cross-linked.

    Returns ``{"path", "state", "follows", "bytes"}``. ``state`` is one of
    ``missing`` / ``standalone`` / ``follows`` / ``broken`` / ``external`` —
    ``source`` is derived afterward once every harness's followers are known.
    """
    info: dict[str, Any] = {
        "path": str(p), "state": "missing", "follows": None, "bytes": None
    }

    if p.is_symlink():
        try:
            raw_target = os.readlink(p)
        except OSError:
            info["state"] = "broken"
            return info
        target_abs = os.path.normpath(os.path.join(str(p.parent), raw_target))
        matched = None
        for other_id, other_path in all_paths.items():
            if other_id == h_id:
                continue
            if os.path.normpath(str(other_path)) == target_abs:
                matched = other_id
                break
        if matched is None:
            info["state"] = "external"
            return info
        info["follows"] = matched
        info["state"] = "follows" if Path(target_abs).exists() else "broken"
        return info

    if p.exists():
        info["state"] = "standalone"
        try:
            info["bytes"] = p.stat().st_size
        except OSError:
            info["bytes"] = None
        return info

    return info


def status(harness_ids: Optional[list] = None, *, context: Any = None,
           operation_context: Any = None) -> list:
    """`[{"harness", "label", "path", "state", "follows", "followers",
    "bytes"}]`, one row per requested harness (default: every harness that
    has a global-doc concept), sorted by id.

    Read-only — never touches disk beyond stat/readlink.
    """
    context = context if context is not None else operation_context
    all_paths = _all_doc_paths(context)
    if harness_ids is None:
        wanted = _known_harness_ids(context) if context is not None else sorted(all_paths)
    else:
        wanted = list(harness_ids)
        for h_id in wanted:
            if context is not None:
                if h_id not in _known_harness_ids(context):
                    raise ValueError(f"Unknown harness: {h_id}")
                if doc_path(h_id, context=context) is None:
                    continue
                continue
            h = _harnesses.HARNESSES.get(h_id)
            if h is None:
                raise ValueError(f"Unknown harness: {h_id}")
            if h.global_doc is None:
                raise ValueError(f"Harness {h_id} has no user-global instruction file")

    raw = {h_id: _classify_one(h_id, p, all_paths) for h_id, p in all_paths.items()}

    followers_map: dict = {h_id: [] for h_id in all_paths}
    for h_id, info in raw.items():
        if info["state"] == "follows" and info["follows"]:
            followers_map.setdefault(info["follows"], []).append(h_id)

    out = []
    for h_id in wanted:
        row_info = raw.get(h_id)
        if row_info is None:
            out.append({
                "harness": h_id,
                "label": h_id,
                "path": None,
                "state": "unavailable",
                "follows": None,
                "followers": [],
                "bytes": None,
            })
            continue
        if context is not None:
            layout = context.layout(h_id) if callable(getattr(context, "layout", None)) else None
            label = getattr(layout, "label", h_id) if layout is not None else h_id
        else:
            label = _harnesses.HARNESSES[h_id].label
        followers = sorted(followers_map.get(h_id, []))
        state = row_info["state"]
        if state == "standalone" and followers:
            state = "source"
        out.append(
            {
                "harness": h_id,
                "label": label,
                "path": row_info["path"],
                "state": state,
                "follows": row_info["follows"],
                "followers": followers,
                "bytes": row_info["bytes"],
            }
        )
    return out


def _row_by_id(harness_id: str, rows: list) -> Optional[dict]:
    for row in rows:
        if row["harness"] == harness_id:
            return row
    return None


# ─────────────────────────────────────────────────────────────────────────────
# Mutations
# ─────────────────────────────────────────────────────────────────────────────


def _read_bytes(p: Path) -> bytes:
    """The doc's raw bytes. Every COPY and every APPEND in this module goes
    through bytes, never decoded text: a global doc is a user file that may
    hold any encoding (or plain mojibake), and a decode-with-replace
    round-trip rewrites those bytes as U+FFFD — silent corruption of a file
    the user did not ask us to rewrite."""
    return p.read_bytes()


def _decode(data: bytes) -> str:
    """Lossy decode for DISPLAY only (the conflict preview) and for the
    is-it-empty test. Never write the result back — see `_read_bytes`."""
    return data.decode("utf-8", errors="replace")


def _backup_doc(p: Path, harness_id: str, backups_root: Path) -> Optional[str]:
    """Copy `p`'s current bytes (or, for a symlink, its raw link-target text)
    to `<backups_root>/global-docs/<harness_id>/<YYYYMMDD-HHMMSS>.md`. Returns
    the backup path as a str, or None when there is nothing on disk to back
    up (a `missing` doc)."""
    backup_dir = backups_root / "global-docs" / harness_id
    backup_dir.mkdir(parents=True, exist_ok=True)
    ts = time.strftime("%Y%m%d-%H%M%S")
    backup_path = backup_dir / f"{ts}.md"
    n = 1
    while backup_path.exists():
        backup_path = backup_dir / f"{ts}-{n}.md"
        n += 1
    if p.is_symlink():
        try:
            target_text = os.readlink(p)
        except OSError:
            target_text = ""
        backup_path.write_text(target_text, encoding="utf-8")
        return str(backup_path)
    if p.exists():
        shutil.copy2(p, backup_path)
        return str(backup_path)
    return None


def _create_link(follower_path: Path, source_path: Path) -> None:
    """Replace `follower_path` (whatever is there — nothing, a symlink, or a
    regular file the caller already backed up) with a RELATIVE symlink to
    `source_path`, so a backup restore onto another home keeps working."""
    follower_path.parent.mkdir(parents=True, exist_ok=True)
    if follower_path.is_symlink() or follower_path.exists():
        follower_path.unlink()
    rel = os.path.relpath(source_path, follower_path.parent)
    os.symlink(rel, follower_path)


def link(
    follower: str,
    source: str,
    *,
    on_conflict: Optional[str] = None,
    backups_root: Path,
    context: Any = None,
    operation_context: Any = None,
) -> dict:
    """Make `follower`'s global doc follow `source`'s.

    Returns a dict. Success: ``{"follower", "source", "changed",
    "resolved_source"?, "backup"?}``. Failure: ``{"error": <code>, ...}`` —
    ``"conflict"`` is the only recoverable one (retry with `on_conflict`);
    the CLI maps it to exit code 2, everything else to exit 1.

    `backup` names the FOLLOWER's pre-link backup. `on_conflict="merge"` also
    rewrites the SOURCE file, so that one is backed up too (same
    `<backups_root>/global-docs/<source-id>/` layout); it is not reported,
    because the return shape is a fixed contract the app parses.
    """
    context = context if context is not None else operation_context
    if on_conflict not in (None, "replace", "merge"):
        return {"error": "invalid_on_conflict", "value": on_conflict}

    rows = status(context=context)
    follower_row = _row_by_id(follower, rows)
    if follower_row is None:
        return {"error": "unknown_harness", "harness": follower}
    source_row = _row_by_id(source, rows)
    if source_row is None:
        return {"error": "unknown_harness", "harness": source}

    # Before anything else, so `link x --to x` always says so — whatever state
    # x's own doc is in. (The same check runs again after chain resolution:
    # that one catches the CYCLE `link a --to b` where b already follows a.)
    if follower == source:
        return {"error": "same_harness", "harness": follower}

    resolved_source = source
    if source_row["state"] == "follows" and source_row["follows"]:
        resolved_source = source_row["follows"]
        source_row = _row_by_id(resolved_source, rows)
        if source_row is None:
            return {"error": "unknown_harness", "harness": resolved_source}

    if source_row["state"] == "external":
        return {"error": "external_link", "harness": resolved_source}
    if source_row["state"] not in ("standalone", "source"):
        # missing or broken — nothing real to point at
        return {"error": "source_missing", "harness": resolved_source}

    if follower == resolved_source:
        return {"error": "same_harness", "harness": follower}

    if follower_row["state"] == "external":
        return {"error": "external_link", "harness": follower}

    follower_path = doc_path(follower, context=context)
    source_path = doc_path(resolved_source, context=context)
    if follower_path is None or source_path is None:  # pragma: no cover — status() already validated
        return {"error": "unknown_harness", "harness": follower if follower_path is None else resolved_source}

    # `status()` says "a real file exists here", which a DIRECTORY at the doc
    # path also satisfies. Never point a follower at one.
    if not source_path.is_file():
        return {"error": "source_not_a_file", "harness": resolved_source, "path": str(source_path)}

    result = {"follower": follower, "source": resolved_source}
    if resolved_source != source:
        result["resolved_source"] = resolved_source

    try:
        if follower_row["state"] == "follows":
            if follower_row["follows"] == resolved_source:
                return {**result, "changed": False}
            _create_link(follower_path, source_path)
            return {**result, "changed": True, "backup": None}

        if follower_row["state"] in ("missing", "broken"):
            _create_link(follower_path, source_path)
            return {**result, "changed": True, "backup": None}

        # standalone or source — a real file on disk
        if follower_row["state"] == "source" and follower_row["followers"]:
            return {
                "error": "has_followers",
                "harness": follower,
                "followers": follower_row["followers"],
            }

        raw = _read_bytes(follower_path)
        is_empty = _decode(raw).strip() == ""

        if not is_empty and on_conflict is None:
            return {
                "error": "conflict",
                "harness": follower,
                "existing_bytes": len(raw),
                "preview": _decode(raw)[:PREVIEW_CHARS],
            }

        backup_path = _backup_doc(follower_path, follower, backups_root)

        if not is_empty and on_conflict == "merge":
            source_raw = _read_bytes(source_path)
            if raw not in source_raw:
                # The merge REWRITES someone else's doc — back it up first.
                _backup_doc(source_path, resolved_source, backups_root)
                source_path.write_bytes(source_raw + b"\n\n" + raw)

        _create_link(follower_path, source_path)
    except OSError as exc:
        # A read-only dotfile dir, a directory where a doc should be, a
        # vanished file — report it as data, so `--json` output stays
        # parseable instead of becoming a traceback on stderr.
        return {"error": "io_error", "harness": follower, "detail": str(exc)}
    return {**result, "changed": True, "backup": backup_path}


def unlink(harness: str, *, backups_root: Path, context: Any = None,
           operation_context: Any = None) -> dict:
    """Detach `harness`'s global doc from what it follows, replacing the
    symlink with a real file holding the current shared text (an empty file
    for a `broken` link).

    Returns ``{"changed": True, "harness", "bytes", "backup"}`` on success,
    or ``{"error": <code>, ...}``.
    """
    context = context if context is not None else operation_context
    rows = status(context=context)
    row = _row_by_id(harness, rows)
    if row is None:
        return {"error": "unknown_harness", "harness": harness}
    if row["state"] not in ("follows", "broken"):
        return {"error": "not_a_follower", "harness": harness, "state": row["state"]}

    p = doc_path(harness, context=context)
    if p is None:  # pragma: no cover — status() already validated
        return {"error": "unknown_harness", "harness": harness}

    try:
        data = b""
        if row["state"] == "follows" and row["follows"]:
            target_path = doc_path(row["follows"], context=context)
            # Bytes, not decoded text: the detached copy must be identical to
            # what the harnesses were sharing a second ago.
            if target_path is not None and target_path.is_file():
                data = _read_bytes(target_path)

        backup_path = _backup_doc(p, harness, backups_root)
        p.unlink()
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
    except OSError as exc:
        return {"error": "io_error", "harness": harness, "detail": str(exc)}
    return {
        "changed": True,
        "harness": harness,
        "bytes": len(data),
        "backup": backup_path,
    }
