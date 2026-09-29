#!/usr/bin/env python3
"""usage_loadouts — the loadout history ledger.

Owns `<data_home>/state/usage/loadouts.jsonl`: one APPEND-ONLY row per
`(project, harness)` loadout change. A row is never rewritten and never
deleted by any wave-1 code path (design D2). Each row records the sorted
skill and MCP-server key lists active for that pair, and a hash of the two
lists so a caller can tell "did the loadout change" without comparing full
lists.

This module is a leaf: it imports `hub_core` and `harnesses` at module scope
only, never `import hub`. `usage_scan.py` imports this module (to resolve
`loadout_assumed` for a session); this module never imports `usage_scan`,
which is what keeps the two-module dependency a DAG instead of a cycle
(design D1).

Row shape (one JSON object per line, `json.dumps(row, sort_keys=True)`):

    {
      "schema_version": 1,
      "at": "2026-09-05T08:00:00Z",
      "project": "skill-hub",
      "harness": "claude-code",
      "skills": ["deliver-it", "proof-it"],
      "mcp": ["skill-tree"],
      "hash": "<64 hex>"
    }

See `openspec/changes/usage-loadout-analytics/design.md` D2 and D6.
"""

from __future__ import annotations

import datetime as _dt
import hashlib
import json
import os
from pathlib import Path
from typing import Callable, Optional

from skill_hub import hub_core
from skill_hub.infrastructure.harnesses import harnesses

#: Data-home-relative path of the ledger — a `backup.py:ManifestRow.entry`.
LOADOUTS_REL = "state/usage/loadouts.jsonl"


def loadouts_path() -> Path:
    return hub_core.data_home() / LOADOUTS_REL


# ─────────────────────────────────────────────────────────────────────────────
# Clock seam
# ─────────────────────────────────────────────────────────────────────────────


def clock_now() -> _dt.datetime:
    """The ONE `SKILL_HUB_NOW` clock seam for both ledgers: `SKILL_HUB_NOW`
    when set, the real UTC clock otherwise. `usage_scan.now()` delegates
    here (that module already imports this one for `loadout_at`, so this is
    the direction that avoids a cycle — design D1's DAG). A trailing
    literal `Z` is normalized to `+00:00` first: `datetime.fromisoformat`
    only accepts a bare `Z` suffix from Python 3.11, and this project's
    floor is 3.9."""
    raw = os.environ.get("SKILL_HUB_NOW")
    if raw:
        cleaned = raw[:-1] + "+00:00" if raw.endswith("Z") else raw
        dt = _dt.datetime.fromisoformat(cleaned)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=_dt.timezone.utc)
        return dt
    return _dt.datetime.now(_dt.timezone.utc)


def _iso(dt: _dt.datetime) -> str:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=_dt.timezone.utc)
    return dt.astimezone(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse_at(text: str) -> _dt.datetime:
    """Parse an `at`/`started_at` timestamp, `Z`-tolerant. R10: this ledger
    writes whole-second precision, `usage_scan._iso` writes milliseconds —
    two strings a second apart can otherwise invert (`Z` sorts after `.`).
    Every comparison against a stamped timestamp MUST go through this, never
    a raw string `<=`."""
    cleaned = text[:-1] + "+00:00" if text.endswith("Z") else text
    dt = _dt.datetime.fromisoformat(cleaned)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=_dt.timezone.utc)
    return dt


# ─────────────────────────────────────────────────────────────────────────────
# Row model — plain dicts (matches design D12's `list[dict]` signatures)
# ─────────────────────────────────────────────────────────────────────────────


def loadout_hash(skills: list, mcp: list) -> str:
    """`sha256(json.dumps({"skills": sorted, "mcp": sorted}, sort_keys=True))`.
    The hash depends on the two sorted lists and on nothing else (design D2)."""
    payload = json.dumps(
        {"skills": sorted(skills), "mcp": sorted(mcp)}, sort_keys=True
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _validate_row(data: object) -> dict:
    """Validate one decoded JSON line into the canonical row dict, or raise
    `ValueError`. Never raises anything else — `read_loadout_rows` only
    catches `(json.JSONDecodeError, ValueError, TypeError, KeyError)`."""
    if not isinstance(data, dict):
        raise ValueError("row is not a JSON object")
    at = str(data["at"])
    project = str(data["project"])
    if not project:
        raise ValueError("project must be a non-empty string")
    harness = str(data["harness"])
    if not harness:
        raise ValueError("harness must be a non-empty string")
    skills_raw = data.get("skills")
    if not isinstance(skills_raw, list) or not all(isinstance(s, str) for s in skills_raw):
        raise ValueError("skills must be a list of strings")
    mcp_raw = data.get("mcp")
    if not isinstance(mcp_raw, list) or not all(isinstance(s, str) for s in mcp_raw):
        raise ValueError("mcp must be a list of strings")
    row_hash = str(data["hash"])
    if len(row_hash) != 64:
        raise ValueError(f"bad hash {row_hash!r}")
    return {
        "schema_version": 1,
        "at": at,
        "project": project,
        "harness": harness,
        "skills": sorted(skills_raw),
        "mcp": sorted(mcp_raw),
        "hash": row_hash,
    }


def read_loadout_rows(path: Optional[Path] = None) -> tuple:
    """Read the ledger in file (= chronological, append) order. A malformed
    line is dropped — never raises — and named in the returned warnings
    list. A missing file reads as empty."""
    p = Path(path) if path is not None else loadouts_path()
    if not p.exists():
        return [], []
    rows: list = []
    warnings: list = []
    for lineno, raw_line in enumerate(p.read_text().splitlines(), start=1):
        line = raw_line.strip()
        if not line:
            continue
        try:
            data = json.loads(line)
            rows.append(_validate_row(data))
        except (json.JSONDecodeError, ValueError, TypeError, KeyError) as exc:
            warnings.append(f"{p}:{lineno}: dropped malformed loadout row ({exc})")
    return rows, warnings


def _append_row(path: Path, row: dict) -> None:
    """Append one row. The ledger is logically append-only, but the write
    itself is a whole-file atomic replace (sibling temp + `0o600` +
    `os.replace`), same convention as every other hub ledger — a half
    written new line can never be observed by a concurrent reader, and
    every earlier line is untouched byte-for-byte."""
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    line = json.dumps(row, sort_keys=True) + "\n"
    existing = path.read_text() if path.exists() else ""
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(existing + line)
    try:
        os.chmod(tmp, 0o600)
    except OSError:
        pass
    os.replace(tmp, path)


def loadout_at(rows: list, project: str, harness: str, at: str) -> Optional[dict]:
    """The loadout row in effect at timestamp `at` for `(project, harness)`:
    the LATEST row (by its own `at`) with `row["at"] <= at`. `None` when no
    such row exists for the pair — the caller then falls back to the FIRST
    row for the pair, or to `loadout_assumed`, per design D2.

    Compares PARSED datetimes, never raw strings (R10): this ledger's `at`
    and a session's `started_at` can carry different ISO precisions, and a
    lexical `<=` inverts within the same second (`Z` sorts after `.`)."""
    try:
        at_dt = _parse_at(at)
    except ValueError:
        return None
    best: Optional[tuple[_dt.datetime, dict]] = None
    for r in rows:
        if r.get("project") != project or r.get("harness") != harness:
            continue
        try:
            row_dt = _parse_at(r.get("at", ""))
        except ValueError:
            continue
        if row_dt > at_dt:
            continue
        if best is None or row_dt > best[0]:
            best = (row_dt, r)
    return best[1] if best else None


def first_loadout_for_pair(rows: list, project: str, harness: str) -> Optional[dict]:
    """The FIRST (earliest-appended) row for `(project, harness)`, or `None`.
    Used by `usage_scan` to fill `loadout_hash` when `loadout_assumed` is
    true (design D2: "loadout_hash is then the hash of the first loadout
    row for that pair if one exists, else null")."""
    for r in rows:
        if r.get("project") == project and r.get("harness") == harness:
            return r
    return None


def last_loadout_for_pair(rows: list, project: str, harness: str) -> Optional[dict]:
    """The LAST (most-recently-appended) row for `(project, harness)`, or
    `None`. `rows` is in file (= chronological append) order, so this walks
    from the end — explicit, rather than `first_loadout_for_pair` on a
    reversed list (R17)."""
    for r in reversed(rows):
        if r.get("project") == project and r.get("harness") == harness:
            return r
    return None


# ─────────────────────────────────────────────────────────────────────────────
# Sync-tail pass — "2e" (design D6)
# ─────────────────────────────────────────────────────────────────────────────


def run_loadout_pass(
    registry: dict,
    *,
    resolve_skills: Callable,
    installed: set,
    affinity: Callable,
    report: Optional[dict] = None,
    now: Optional[_dt.datetime] = None,
) -> dict:
    """Append one loadout row per `(project, harness)` whose resolved
    loadout hash changed since the last row for that pair.

    `resolve_skills(proj_cfg, registry) -> list[str]` returns the project's
    resolved active skill KEYS (design: "Resolved active skills =
    union(...)"). `affinity(skill_cfg) -> Optional[set[str]]` is
    `skill_meta.skill_affinity`. `installed` is the caller's own installed-
    harness set, passed explicitly rather than re-detected (design G15: a
    re-detect here could disagree with the rest of the sync run). `now`
    overrides the `clock_now()` seam when given; every row this call
    appends (any project, any harness) is stamped with the SAME timestamp —
    one call is one moment, not a race between the clock and however many
    pairs it touches (this is also what makes a two-machine backup/restore
    round trip byte-comparable when both sides fix `SKILL_HUB_NOW`).

    Never raises: every per-pair operation is isolated in its own error
    boundary, and a failure lands in `errors[]` as `{"file": None, "kind":
    type(exc).__name__}` — never `str(exc)`, which for a `json`/`OSError`
    can carry a path or file content (design G17)."""
    now_dt = now if now is not None else clock_now()
    at = _iso(now_dt)
    projects = registry.get("projects") or {}
    skills_registry = registry.get("skills") or {}
    appended = 0
    pairs = 0
    errors: list = []

    for project_name, proj_cfg in projects.items():
        if not isinstance(proj_cfg, dict):
            continue
        try:
            effective = harnesses.resolve_effective(proj_cfg, registry, installed=installed)
        except Exception as exc:  # noqa: BLE001 — never break the pass
            errors.append({"file": None, "kind": type(exc).__name__})
            continue

        try:
            resolved_names = list(resolve_skills(proj_cfg, registry) or [])
        except Exception as exc:  # noqa: BLE001
            errors.append({"file": None, "kind": type(exc).__name__})
            continue

        for harness_id in sorted(effective):
            pairs += 1
            try:
                skill_names: list = []
                mcp_names: list = []
                for name in resolved_names:
                    cfg = skills_registry.get(name)
                    if not isinstance(cfg, dict):
                        continue
                    aff = affinity(cfg)
                    if aff is not None and harness_id not in aff:
                        continue
                    if cfg.get("type") == "mcp-server":
                        mcp_names.append(name)
                    else:
                        skill_names.append(name)
                skill_names = sorted(set(skill_names))
                mcp_names = sorted(set(mcp_names))
                row_hash = loadout_hash(skill_names, mcp_names)

                with hub_core.data_home_lock():
                    existing_rows, _warnings = read_loadout_rows()
                    last = last_loadout_for_pair(existing_rows, project_name, harness_id)
                    if last is not None and last["hash"] == row_hash:
                        continue
                    new_row = {
                        "schema_version": 1,
                        "at": at,
                        "project": project_name,
                        "harness": harness_id,
                        "skills": skill_names,
                        "mcp": mcp_names,
                        "hash": row_hash,
                    }
                    _append_row(loadouts_path(), new_row)
                    appended += 1
            except Exception as exc:  # noqa: BLE001 — one bad pair never sinks the rest
                errors.append({"file": None, "kind": type(exc).__name__})

    result = {"appended": appended, "pairs": pairs, "errors": errors}
    if report is not None:
        report.setdefault("global", {})["loadouts"] = result
    return result
