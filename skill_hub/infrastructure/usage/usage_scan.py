#!/usr/bin/env python3
"""Usage scan facade, canonical summary readers, and legacy excerpt recovery.

Native decoding belongs to the canonical capture readers. SQLite owns current
summaries; sessions.jsonl is an atomic export and pre-import compatibility input.
The cursor sidecar is retained only for legacy recovery.
"""
# ruff: noqa: E501


from __future__ import annotations

import datetime as _dt
import json
import os
import sqlite3
import sys
import tempfile
from pathlib import Path
from typing import Optional

from skill_hub import hub_core
from skill_hub.application.usage.usage_source_layout import UsageLayout, capture_usage_layout, source_present
from skill_hub.domain.usage import usage_classify
from skill_hub.infrastructure.usage import usage_loadouts

SESSIONS_REL = "state/usage/sessions.jsonl"


CURSOR_REL = "state/usage/scan-cursor.json"


EXCERPT_REDACTION_VERSION = 1


SCANNED_HARNESSES: tuple[str, ...] = ("claude-code", "codex")


ACTIVITY_CLASSES: tuple[str, ...] = (
    "read",
    "edit",
    "verify",
    "operate",
    "delegate",
    "skill",
    "external",
)


def now() -> _dt.datetime:
    """Delegates to `usage_loadouts.clock_now()` — the ONE clock seam for
    both ledgers (design D2). `usage_scan` already imports `usage_loadouts`
    (for `loadout_at`), so this direction adds no cycle; a reverse import
    would."""
    return usage_loadouts.clock_now()


def _iso(dt: _dt.datetime) -> str:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=_dt.timezone.utc)
    return dt.astimezone(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def _parse_iso(text: str) -> _dt.datetime:
    cleaned = text[:-1] + "+00:00" if text.endswith("Z") else text
    dt = _dt.datetime.fromisoformat(cleaned)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=_dt.timezone.utc)
    return dt


def sessions_path() -> Path:
    return hub_core.data_home() / SESSIONS_REL


def cursor_path() -> Path:
    return hub_core.data_home() / CURSOR_REL


def transcript_root(layout: UsageLayout | None = None) -> Optional[Path]:
    """Return the captured Claude transcript root for a standalone call."""
    captured = layout if layout is not None else capture_usage_layout()
    return captured.root("claude-code")


def last_scan_at() -> Optional[str]:
    """Read the committed scan time, retaining pre-import sidecar compatibility."""
    from skill_hub.infrastructure.usage.usage_inspection_store import InspectionStore, InspectionStoreError, db_path

    def legacy_time():
        try:
            value = json.loads(cursor_path().read_text()).get("last_scan_at")
            return value if isinstance(value, str) else None
        except (OSError, ValueError, AttributeError):
            return None

    if not db_path().exists():
        return legacy_time()
    try:
        with hub_core.data_home_lock(), InspectionStore.open() as store:
            row = store.db.execute(
                "SELECT value FROM metadata WHERE key='summary_last_scan_at'"
            ).fetchone()
            if row is not None:
                return _iso(_parse_iso(str(row[0])))
            imported = store.db.execute(
                "SELECT value FROM usage_summary_metadata WHERE key='legacy_import_complete'"
            ).fetchone()
            return legacy_time() if imported is None else None
    except (InspectionStoreError, sqlite3.DatabaseError, OSError, ValueError):
        return None


def _empty_cursor() -> dict:
    return {"schema_version": 1, "last_scan_at": None, "files": {}}


def _read_cursor(layout: UsageLayout | None = None) -> dict:
    p = cursor_path()
    if not p.exists():
        return _empty_cursor()
    try:
        data = json.loads(p.read_text())
    except (OSError, ValueError):
        print(f"usage_scan: corrupt cursor at {p} — reading as empty", file=sys.stderr)
        return _empty_cursor()
    if not isinstance(data, dict):
        return _empty_cursor()
    files = data.get("files")
    if not isinstance(files, dict):
        files = {}
    normalized = {}
    captured = layout if layout is not None else capture_usage_layout()
    claude_root = captured.root("claude-code")
    resolved_root = claude_root.resolve() if claude_root is not None else None
    for key, value in files.items():
        new_key = key
        if isinstance(key, str) and os.path.isabs(key) and isinstance(value, dict) and resolved_root is not None:
            try:
                path = Path(key).resolve()
                new_key = f"claude-code:{path.relative_to(resolved_root)}"
            except ValueError:
                pass
        normalized[new_key] = value
    result = {
        "schema_version": 1,
        "last_scan_at": data.get("last_scan_at") if isinstance(data.get("last_scan_at"), str) else None,
        "files": normalized,
    }
    if "excerpt_redaction_version" in data:
        result["excerpt_redaction_version"] = data["excerpt_redaction_version"]
    if normalized != files:
        _write_cursor(result, captured)
    return result


def _write_cursor(cursor: dict, layout: UsageLayout | None = None) -> None:
    _redact_cursor_excerpts(cursor, layout)
    _write_usage_text(cursor_path(), json.dumps(cursor, sort_keys=True))


_REQUIRED_ROW_KEYS = ("harness", "session_id", "project", "started_at", "last_activity_at", "frozen")


def _validate_session_row(data: object) -> dict:
    if not isinstance(data, dict):
        raise ValueError("row is not a JSON object")
    for key in _REQUIRED_ROW_KEYS:
        if key not in data:
            raise ValueError(f"row is missing {key!r}")
    if not isinstance(data["harness"], str) or not data["harness"]:
        raise ValueError("harness must be a non-empty string")
    if not isinstance(data["session_id"], str) or not data["session_id"]:
        raise ValueError("session_id must be a non-empty string")
    return data


def _read_session_rows_file(path: Path) -> tuple:
    if not path.exists():
        return [], []
    rows, warnings = [], []
    for lineno, raw_line in enumerate(path.read_text().splitlines(), start=1):
        if not raw_line.strip():
            continue
        try:
            row = _validate_session_row(json.loads(raw_line))
            _redact_stored_excerpts(row)
            rows.append(row)
        except (ValueError, TypeError, KeyError) as exc:
            warnings.append(f"{path}:{lineno}: dropped malformed session row ({exc})")
    return rows, warnings


def read_session_rows(path: Optional[Path] = None) -> tuple:
    """Read committed summaries, or explicitly validate a legacy file.

    SQLite is authoritative for the normal read path. A caller that supplies
    a path explicitly requests file/recovery validation and retains the
    historical warning behavior. Before the import marker exists, the
    validated JSONL remains the compatible read path for existing homes.
    """
    if path is not None:
        return _read_session_rows_file(Path(path))

    from skill_hub.infrastructure.usage.usage_inspection_store import InspectionStore, InspectionStoreError, db_path

    if not db_path().exists():
        return _read_session_rows_file(sessions_path())
    try:
        with hub_core.data_home_lock(), InspectionStore.open() as store:
            store.db.execute("BEGIN")
            marker = store.db.execute(
                "SELECT value FROM usage_summary_metadata "
                "WHERE key='legacy_import_complete'"
            ).fetchone()
            if marker is None:
                return _read_session_rows_file(sessions_path())
            from skill_hub.application.usage import usage_summary_projection

            rows = usage_summary_projection.effective_summaries(store.db)
            warnings: list[str] = []
            rejected = store.db.execute(
                "SELECT value FROM usage_summary_metadata "
                "WHERE key='last_import_rejected'"
            ).fetchone()
            if rejected is not None:
                try:
                    count = int(rejected[0])
                except (TypeError, ValueError):
                    count = 0
                if count > 0:
                    warnings.append(f"SQLite summary import rejected {count} row(s)")
            return rows, warnings
    except (InspectionStoreError, sqlite3.DatabaseError, OSError, ValueError) as exc:
        return [], [f"inspection summary read failed ({exc})"]


def _write_session_rows(path: Path, rows: list) -> None:
    for row in rows:
        _redact_stored_excerpts(row)
        row["excerpt_redaction_version"] = EXCERPT_REDACTION_VERSION
    ordered = sorted(rows, key=lambda r: (r["harness"], r["session_id"]))
    text = "".join(json.dumps(r, sort_keys=True) + "\n" for r in ordered)
    _write_usage_text(path, text)


def _write_usage_text(path: Path, text: str) -> None:
    """Replace a usage file atomically; the temporary file is private from creation."""
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, name = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as handle:
            handle.write(text)
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)


def _redact_stored_excerpts(record: dict) -> int:
    """Scrub only excerpt fields, preserving counters and cursor offsets."""
    fields = [(record, "intent_excerpt")]
    events = record.get("events")
    if isinstance(events, list):
        for event in events:
            if isinstance(event, dict):
                fields.extend((event, key) for key in ("excerpt", "text"))
    changed = 0
    for obj, key in fields:
        value = obj.get(key)
        if isinstance(value, str):
            redacted = usage_classify.redact_excerpt_secrets(value)[:200]
            if redacted != value:
                obj[key] = redacted
                changed += 1
    return changed


def _redact_cursor_excerpts(cursor: dict, layout: UsageLayout | None = None) -> int:
    del layout
    changed = 0
    for entry in cursor.get("files", {}).values():
        if isinstance(entry, dict) and isinstance(entry.get("acc"), dict):
            changed += _redact_stored_excerpts(entry["acc"])
    cursor["excerpt_redaction_version"] = EXCERPT_REDACTION_VERSION
    return changed


def repair_excerpts(*, layout: UsageLayout | None = None) -> dict:
    """Repair persisted excerpts without reading transcripts or dropping malformed rows.

    Parse both files before replacing either. Each replacement is atomic and
    a retry is safe after a partial write failure. Report counts, never text.
    Writers also scrub every time, even when a version marker is present.
    """
    result = {"ok": True, "redaction_version": EXCERPT_REDACTION_VERSION,
              "fields_redacted": 0, "files_rewritten": 0}
    layout = layout if layout is not None else capture_usage_layout()
    with hub_core.data_home_lock():
        ledger_path = sessions_path()
        sidecar_path = cursor_path()
        rows = None
        cursor = None
        if ledger_path.exists():
            rows = [_validate_session_row(json.loads(line))
                    for line in ledger_path.read_text().splitlines() if line.strip()]
        if sidecar_path.exists():
            cursor = json.loads(sidecar_path.read_text())
            if not isinstance(cursor, dict) or not isinstance(cursor.get("files"), dict):
                raise ValueError("invalid usage cursor")

        if rows is not None:
            outdated = any(r.get("excerpt_redaction_version") != EXCERPT_REDACTION_VERSION for r in rows)
            changed = sum(_redact_stored_excerpts(row) for row in rows)
            if changed or outdated:
                _write_session_rows(ledger_path, rows)
                result["files_rewritten"] += 1
                result["fields_redacted"] += changed
        if cursor is not None:
            outdated = cursor.get("excerpt_redaction_version") != EXCERPT_REDACTION_VERSION
            changed = _redact_cursor_excerpts(cursor, layout)
            if changed or outdated:
                _write_cursor(cursor, layout)
                result["files_rewritten"] += 1
                result["fields_redacted"] += changed
    return result


def scan_sessions(
    *, harness: Optional[str] = None, now: Optional[_dt.datetime] = None,
    max_sources: int | None = None, order: str = "newest", budget_seconds: float | None = None,
    scan_id: str | None = None, retry_incomplete: bool = False,
    layout: UsageLayout | None = None,
) -> dict:
    """Decode native sources once and export successful canonical summaries."""
    from skill_hub.application.usage import usage_inspection_scan
    usage_layout = layout if layout is not None else capture_usage_layout()

    # Retired cursor data still needs the existing excerpt privacy repair.
    with hub_core.data_home_lock():
        if cursor_path().exists():
            try:
                legacy_cursor = json.loads(cursor_path().read_text())
            except (OSError, ValueError):
                legacy_cursor = None
            if isinstance(legacy_cursor, dict) and isinstance(legacy_cursor.get("files"), dict):
                outdated = legacy_cursor.get("excerpt_redaction_version") != EXCERPT_REDACTION_VERSION
                changed = _redact_cursor_excerpts(legacy_cursor, usage_layout)
                if outdated or changed:
                    _write_cursor(legacy_cursor, usage_layout)
    effective_now = now if now is not None else globals()["now"]()
    roots = usage_layout.roots()
    if harness in SCANNED_HARNESSES:
        roots = {harness: roots[harness]} if harness in roots else {}
    inspection = usage_inspection_scan.capture_pass(
        roots, max_sources=max_sources, order=order, budget_seconds=budget_seconds,
        scan_id=scan_id, retry_incomplete=retry_incomplete, now=effective_now,
        layout=usage_layout,
    )
    summary = inspection.pop("summary", {})
    accounting = inspection.pop("accounting", {})
    row_counts = summary.get("row_counts", {})
    harness_counts = {}
    errors: list[dict] = []
    for name, counts in accounting.items():
        harness_counts[name] = {
            "files_scanned": counts.get("processed", 0),
            "files_new": counts["new"], "files_appended": counts["appended"],
            "files_replaced": counts["replaced"],
            "rows_written": row_counts.get("by_harness", {}).get(name, 0),
            "frozen_appended": counts["frozen_growth"],
            "reparsed": counts["reparsed"], "errors": counts["errors"],
        }
        errors.extend(
            (
                {**error, "harness": name}
                if error.get("kind") == "replan_required"
                else {"file": error["file"], "kind": error["kind"], "harness": name}
            )
            for error in counts["error_details"]
        )
    # Pass-level failures have no physical source identity.
    source_error_ids = {error.get("source_id") for counts in accounting.values()
                        for error in counts["error_details"]}
    errors.extend(error for error in inspection["errors"]
                  if error.get("source_id") not in source_error_ids or "source_id" not in error)
    result = {
        "ok": not inspection["errors"],
        "rows_written": summary.get("rows_written", 0),
        "rows_frozen": row_counts.get("frozen", 0),
        "frozen_appended": sum(counts["frozen_growth"] for counts in accounting.values()),
        "reparsed": sum(counts["reparsed"] for counts in accounting.values()),
        "files_scanned": inspection["sources_processed"],
        "files_skipped": sum(counts["skipped"] for counts in accounting.values()),
        "bytes_read": inspection["bytes_read"],
        "sessions_unregistered": row_counts.get("unregistered", 0),
        "stopped_on": next((error["file"] for error in errors if "file" in error), None),
        "errors": errors,
        "malformed_rows_dropped": summary.get("malformed_rows_dropped", 0),
        "last_scan_at": _iso(effective_now),
        "harnesses": harness_counts,
        "inspection": inspection,
    }
    if inspection.get("state") == "replan_required":
        result.update(
            state="replan_required",
            partial=True,
            scan_id=inspection.get("scan_id"),
        )
    return result


def _capture_inspection(
    harness: str, *, rebuild: bool = True, layout: UsageLayout | None = None, **options
) -> dict:
    """Compatibility entry for direct inspection callers; projection stays canonical."""
    from skill_hub.application.usage import usage_inspection_scan
    captured = layout if layout is not None else capture_usage_layout()
    root = captured.root(harness)
    roots = {harness: root} if root is not None else {}
    return usage_inspection_scan.capture_pass(roots, layout=captured, **options)


def window_rows(rows: list, project: str, window_days: int, now: _dt.datetime) -> list:
    """Session rows for `project` in the inclusive UTC calendar window."""
    today = now.astimezone(_dt.timezone.utc).date()
    since = today - _dt.timedelta(days=window_days - 1)
    out = []
    for row in rows:
        if row.get("project") != project:
            continue
        started_at = row.get("started_at")
        if not isinstance(started_at, str):
            continue
        try:
            started_dt = _parse_iso(started_at)
        except ValueError:
            continue
        started_date = started_dt.astimezone(_dt.timezone.utc).date()
        if since <= started_date <= today:
            out.append(row)
    return out


def utilization_rows(
    rows: list,
    registry: dict,
    equipped: list,
    window_days: int,
    now: _dt.datetime,
    loadout_rows: Optional[list] = None,
) -> list:
    """One row per EQUIPPED skill key (count `0` allowed), aggregated over
    `rows` (already window-filtered by the caller — see `window_rows`).

    `trail` covers exactly `window_days` days, oldest first — sized from the
    caller's own window rather than a hard-coded 30 (R7), so `sum(trail) ==
    count` for any `--window` value; the design's own example happens to use
    the default 30-day window."""
    trail_len = window_days if window_days > 0 else 30
    per_key: dict = {
        key: {
            "key": key,
            "count": 0,
            "you": 0,
            "model": 0,
            "script": 0,
            "last_used_at": None,
            "trail": [0] * trail_len,
            "sessions_with_skill": 0,
        }
        for key in equipped
    }
    known_loadouts = {
        loadout.get("hash"): set(loadout.get("skills") or [])
        for loadout in (loadout_rows or [])
        if isinstance(loadout, dict) and isinstance(loadout.get("hash"), str)
    }
    for row in rows:
        session_skills = known_loadouts.get(row.get("loadout_hash"))
        if row.get("loadout_assumed") or not isinstance(row.get("loadout_hash"), str):
            session_skills = set(equipped)
        if session_skills is None:
            session_skills = set(equipped)
        for key in equipped:
            if key in session_skills:
                per_key[key]["sessions_with_skill"] += 1
        started_at = row.get("started_at")
        try:
            day_index = None
            if isinstance(started_at, str):
                started_dt = _parse_iso(started_at)
                days_ago = (now.date() - started_dt.date()).days
                if 0 <= days_ago < trail_len:
                    day_index = trail_len - 1 - days_ago
        except ValueError:
            day_index = None
        for skill_row in row.get("skills") or []:
            key = skill_row.get("key")
            if key not in per_key:
                continue
            invoker = skill_row.get("invoker")
            count = skill_row.get("count", 0)
            per_key[key]["count"] += count
            if invoker in ("you", "model", "script"):
                per_key[key][invoker] += count
            if isinstance(started_at, str):
                if per_key[key]["last_used_at"] is None or started_at > per_key[key]["last_used_at"]:
                    per_key[key]["last_used_at"] = started_at
            if day_index is not None:
                per_key[key]["trail"][day_index] += count

    return [per_key[key] for key in sorted(per_key)]


def outcome_metrics(rows: list, all_rows: list) -> dict:
    """Aggregate outcome metrics over `rows` (a project's window), plus
    `median_all_projects` computed from `all_rows`."""

    def _agg(subset: list) -> dict:
        n = len(subset)
        if n == 0:
            return {
                "sessions": 0,
                "tokens_per_session": None,
                "cache_hit_ratio": None,
                "steering_per_session": None,
                "subagent_token_share": None,
                "activity": {c: None for c in ACTIVITY_CLASSES},
                "thinking_text_share": None,
                "files_read_median": None,
                "files_edited_median": None,
                "verified_edit_session_ratio": None,
                "editing_sessions": 0,
                "unverified_editing_sessions": 0,
                "tracked_files": None,
            }
        cache_ratios = [r["cache_hit_ratio"] for r in subset if r.get("cache_hit_ratio") is not None]
        thinking_shares = [
            r["thinking_text_share"] for r in subset if r.get("thinking_text_share") is not None
        ]
        total_activity = {c: 0 for c in ACTIVITY_CLASSES}
        activity_sum = 0
        for r in subset:
            for c in ACTIVITY_CLASSES:
                v = (r.get("activity") or {}).get(c, 0)
                total_activity[c] += v
                activity_sum += v
        activity_share = (
            {c: (total_activity[c] / activity_sum if activity_sum else None) for c in ACTIVITY_CLASSES}
        )
        # R2: design D2 fixes `subagent_token_share = subagent_total /
        # (total + subagent_total)` — `total`, not `output`. `session_payload`
        # already computes it this way; the two must never disagree.
        total_parent = sum((r.get("tokens") or {}).get("total", 0) for r in subset)
        total_sub = sum((r.get("tokens") or {}).get("subagent_total", 0) for r in subset)
        denom = total_parent + total_sub
        files_read_list = sorted(r.get("files_read", 0) for r in subset)
        files_edited_list = sorted(r.get("files_edited", 0) for r in subset)
        editing = [r for r in subset if (r.get("activity") or {}).get("edit", 0) > 0]
        verified = [r for r in editing if (r.get("activity") or {}).get("verify", 0) > 0]
        unverified = [r for r in editing if (r.get("activity") or {}).get("verify", 0) == 0]
        tracked = next((r.get("tracked_files") for r in subset if r.get("tracked_files") is not None), None)
        return {
            "sessions": n,
            "tokens_per_session": int(round(total_parent / n)),
            "cache_hit_ratio": (sum(cache_ratios) / len(cache_ratios)) if cache_ratios else None,
            "steering_per_session": sum(r.get("steering_count", 0) for r in subset) / n,
            "subagent_token_share": (total_sub / denom) if denom else None,
            "activity": activity_share,
            "thinking_text_share": (sum(thinking_shares) / len(thinking_shares)) if thinking_shares else None,
            "files_read_median": _median(files_read_list),
            "files_edited_median": _median(files_edited_list),
            "verified_edit_session_ratio": (len(verified) / len(editing)) if editing else None,
            # `usage_footprint._verification_finding` reads these two counts
            # directly (design D9's verification trigger: fires when
            # `unverified_editing_sessions > 0` and
            # `editing_sessions >= VERIFY_MIN_EDIT_SESSIONS`).
            "editing_sessions": len(editing),
            "unverified_editing_sessions": len(unverified),
            "tracked_files": tracked,
        }

    outcomes = _agg(rows)
    outcomes["median_all_projects"] = {"activity": _agg(all_rows)["activity"]}
    return outcomes


def _median(values: list) -> Optional[float]:
    if not values:
        return None
    n = len(values)
    mid = n // 2
    if n % 2:
        return float(values[mid])
    return (values[mid - 1] + values[mid]) / 2.0


def session_payload(
    session_id: str,
    registry: dict,
    *,
    harness: Optional[str] = None,
    layout: UsageLayout | None = None,
) -> dict:
    """The `hub usage session <id>` payload body (design D7). Ambiguous
    (two rows sharing an id, no `--harness`) reports `{"ok": false, "reason":
    "ambiguous"}` rather than guessing."""
    captured = layout if layout is not None else capture_usage_layout()
    rows, _warnings = read_session_rows()
    matches = [
        r
        for r in rows
        if r.get("session_id") == session_id and (harness is None or r.get("harness") == harness)
    ]
    if not matches:
        return {"ok": False, "reason": "not_found"}
    if len(matches) > 1:
        return {"ok": False, "reason": "ambiguous"}
    row = matches[0]

    duration_minutes = None
    if row.get("started_at") and row.get("last_activity_at"):
        try:
            delta = _parse_iso(row["last_activity_at"]) - _parse_iso(row["started_at"])
            duration_minutes = round(delta.total_seconds() / 60)
        except ValueError:
            duration_minutes = None

    tokens = row.get("tokens") or {}
    total = tokens.get("total", 0)
    subagent_total = tokens.get("subagent_total", 0)
    denom = total + subagent_total

    transcript_present = source_present(captured, str(row.get("harness") or ""), session_id)

    summary = {
        "tokens_total": total,
        "cache_hit_ratio": row.get("cache_hit_ratio"),
        "steering_count": row.get("steering_count"),
        "duration_minutes": duration_minutes,
        "activity": row.get("activity"),
        "thinking_text_share": row.get("thinking_text_share"),
        "subagent_token_share": (subagent_total / denom) if denom else None,
        "loadout_assumed": row.get("loadout_assumed"),
    }
    if row.get("compactions"):
        summary["compactions"] = row["compactions"]
    payload = {
        "ok": True,
        "session_id": session_id,
        "harness": row.get("harness"),
        "project": row.get("project"),
        "window": None,
        "last_scan_at": last_scan_at(),
        "transcript_present": transcript_present,
        "summary": summary,
        "intent_excerpt": row.get("intent_excerpt"),
        "events": row.get("events"),
        "subagents": row.get("subagents"),
    }
    return payload
