"""Caller-transactional canonical Usage summary storage and selection."""

from __future__ import annotations

import hashlib
import json
import re
import sqlite3
from collections.abc import Mapping
from datetime import datetime
from typing import Any

from skill_hub.application.usage import usage_summary, usage_summary_legacy

_IDENT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$")
_DIGEST = re.compile(r"^[0-9a-f]{64}$")


def install_schema(db: sqlite3.Connection) -> None:
    """Install projection tables inside the caller's existing transaction."""
    _require_transaction(db)
    usage_summary_legacy.install_schema(db)
    db.execute(
        """
        CREATE TABLE IF NOT EXISTS canonical_session_summaries (
            harness TEXT NOT NULL,
            session_id TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            payload_digest TEXT NOT NULL,
            context_digest TEXT NOT NULL,
            revision INTEGER NOT NULL,
            PRIMARY KEY(harness, session_id)
        )
        """
    )
    db.execute(
        """
        CREATE TABLE IF NOT EXISTS usage_summary_contexts (
            scan_id TEXT PRIMARY KEY,
            context_json TEXT NOT NULL,
            context_digest TEXT NOT NULL
        )
        """
    )
    db.execute("CREATE TABLE IF NOT EXISTS usage_summary_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)")


def save_context(db: sqlite3.Connection, scan_id: str, context: Mapping[str, Any]) -> dict[str, Any]:
    """Persist one immutable, path-free reducer context for a scan pass."""
    _require_transaction(db)
    if not isinstance(scan_id, str) or not scan_id:
        raise ValueError("invalid scan id")
    clean = _validate_context(context)
    encoded = _json(clean)
    digest = _digest(clean)
    existing = db.execute(
        "SELECT context_json,context_digest FROM usage_summary_contexts WHERE scan_id=?", (scan_id,)
    ).fetchone()
    if existing is not None:
        if str(existing["context_digest"]) != digest:
            raise ValueError("summary context changed for scan")
        return json.loads(str(existing["context_json"]))
    db.execute(
        "INSERT INTO usage_summary_contexts(scan_id,context_json,context_digest) VALUES (?,?,?)",
        (scan_id, encoded, digest),
    )
    return clean


def load_context(db: sqlite3.Connection, scan_id: str) -> dict[str, Any] | None:
    """Load a persisted scan context without consulting live configuration."""
    row = db.execute("SELECT context_json FROM usage_summary_contexts WHERE scan_id=?", (scan_id,)).fetchone()
    return json.loads(str(row["context_json"])) if row is not None else None


def refresh_summaries(
    db: sqlite3.Connection,
    *,
    context: Mapping[str, Any],
    sessions: Mapping[tuple[str, str], Mapping[str, list[dict[str, Any]]]],
    revision: int,
    legacy_rows: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Import legacy rows, validate supplied canonical reductions, then upsert them atomically.

    Empty fact sets represent no published head and deliberately create no canonical row.
    """
    _require_transaction(db)
    clean_context = _validate_context(context)
    if not isinstance(revision, int) or isinstance(revision, bool) or revision < 0:
        raise ValueError("invalid summary revision")
    if not isinstance(legacy_rows, list):
        raise ValueError("legacy rows must be a list")
    imported_at = clean_context["now"]
    rejected_imports = 0
    imported_rows = 0
    imported = db.execute(
        "SELECT value FROM usage_summary_metadata WHERE key='legacy_import_complete'"
    ).fetchone()
    if imported is None:
        for row in legacy_rows:
            try:
                result = usage_summary_legacy.import_summary(db, row, imported_at=imported_at)
            except ValueError:
                rejected_imports += 1
                continue
            if result.status == "imported":
                imported_rows += 1
        db.execute(
            "INSERT INTO usage_summary_metadata(key,value) VALUES ('legacy_import_complete','1') "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value"
        )
        for metadata_key, value in (("last_import_rejected", rejected_imports), ("last_imported", imported_rows)):
            db.execute(
                "INSERT INTO usage_summary_metadata(key,value) VALUES (?,?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (metadata_key, str(value)),
            )

    reduced: dict[tuple[str, str], dict[str, Any]] = {}
    coverage_updates: dict[tuple[str, str], str] = {}
    now = datetime.fromisoformat(clean_context["now"].replace("Z", "+00:00"))
    for key, facts in sessions.items():
        harness, session_id = _session_key(key)
        if not _complete_coverage(facts):
            if _has_published_scope(facts, harness, session_id):
                coverage_updates[(harness, session_id)] = _coverage_status(facts)
            continue
        if not _has_head(facts, harness, session_id):
            continue
        project = _project_key(facts, harness, session_id)
        tracked_files = clean_context["tracked_files"].get(project) if harness == "claude-code" else None
        reduced[(harness, session_id)] = usage_summary.project_session(
            harness,
            session_id,
            facts=facts,
            registry=clean_context["registry"],
            loadout_rows=clean_context["loadout_rows"],
            now=now,
            tracked_files=tracked_files,
        )

    prepared = {
        key: (row, _json(row), _digest(row))
        for key, row in reduced.items()
    }
    context_digest = _digest(clean_context)
    for (harness, session_id), (_row, payload, payload_digest) in prepared.items():
        db.execute(
            """
            INSERT INTO canonical_session_summaries(
                harness,session_id,payload_json,payload_digest,context_digest,revision
            ) VALUES (?,?,?,?,?,?)
            ON CONFLICT(harness,session_id) DO UPDATE SET
                payload_json=excluded.payload_json,
                payload_digest=excluded.payload_digest,
                context_digest=excluded.context_digest,
                revision=excluded.revision
            """,
            (harness, session_id, payload, payload_digest, context_digest, revision),
        )
        usage_summary_legacy.mark_superseded(db, harness, session_id, at=imported_at)
    for (harness, session_id), coverage in coverage_updates.items():
        _update_existing_coverage(db, harness, session_id, coverage)
    return effective_summaries(db)


def effective_summaries(db: sqlite3.Connection) -> list[dict[str, Any]]:
    """Return canonical rows plus only legacy rows without a canonical replacement."""
    canonical = [
        json.loads(str(row["payload_json"]))
        for row in db.execute(
            "SELECT payload_json FROM canonical_session_summaries ORDER BY harness,session_id"
        ).fetchall()
    ]
    canonical_keys = {(row["harness"], row["session_id"]) for row in canonical}
    legacy = [
        row
        for row in usage_summary_legacy.available_summaries(db)
        if (row["harness"], row["session_id"]) not in canonical_keys
    ]
    return sorted([*canonical, *legacy], key=lambda row: (row["harness"], row["session_id"]))


def _validate_context(context: Mapping[str, Any]) -> dict[str, Any]:
    if not isinstance(context, Mapping) or set(context) != {"registry", "loadout_rows", "tracked_files", "now"}:
        raise ValueError("invalid summary context")
    registry = context["registry"]
    loadout_rows = context["loadout_rows"]
    tracked_files = context["tracked_files"]
    now = context["now"]
    if not isinstance(registry, Mapping) or set(registry) != {"skills"} or not isinstance(registry["skills"], Mapping):
        raise ValueError("invalid summary registry")
    if not all(isinstance(key, str) and _IDENT.fullmatch(key) for key in registry["skills"]):
        raise ValueError("invalid summary registry")
    if not isinstance(loadout_rows, list):
        raise ValueError("invalid summary loadouts")
    if not isinstance(tracked_files, Mapping) or any(
        not isinstance(project, str)
        or not _IDENT.fullmatch(project)
        or (value is not None and (not isinstance(value, int) or isinstance(value, bool) or value < 0))
        for project, value in tracked_files.items()
    ):
        raise ValueError("invalid tracked files")
    if not isinstance(now, str):
        raise ValueError("invalid summary clock")
    try:
        parsed_now = datetime.fromisoformat(now.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError("invalid summary clock") from exc
    if parsed_now.tzinfo is None or parsed_now.utcoffset() is None:
        raise ValueError("invalid summary clock")
    clean = {
        "registry": {"skills": {key: {} for key in registry["skills"]}},
        "loadout_rows": [_validate_loadout_row(row) for row in loadout_rows],
        "tracked_files": dict(tracked_files),
        "now": now,
    }
    try:
        _json(clean)
    except (TypeError, ValueError) as exc:
        raise ValueError("invalid summary context") from exc
    return clean


def _has_head(facts: Mapping[str, list[dict[str, Any]]], harness: str, session_id: str) -> bool:
    published_scope = _has_published_scope(facts, harness, session_id)
    root_run = any(
        isinstance(item, dict)
        and item.get("harness") == harness
        and item.get("source_session_id") == session_id
        and item.get("root_session_id") == session_id
        for item in facts.get("run", [])
    )
    return published_scope and root_run


def _has_published_scope(facts: Mapping[str, list[dict[str, Any]]], harness: str, session_id: str) -> bool:
    return any(
        isinstance(item, dict)
        and item.get("record_type") == "source_scope"
        and item.get("harness") == harness
        and item.get("source_session_id") == session_id
        and item.get("root_session_id") == session_id
        and item.get("_published") is True
        for item in facts.get("structural", [])
    )


def _complete_coverage(facts: Mapping[str, list[dict[str, Any]]]) -> bool:
    coverage = facts.get("coverage")
    return isinstance(coverage, list) and bool(coverage) and all(
        isinstance(item, dict) and item.get("status") == "complete" for item in coverage
    )


def _coverage_status(facts: Mapping[str, list[dict[str, Any]]]) -> str:
    coverage = facts.get("coverage")
    if not isinstance(coverage, list) or not coverage:
        return "unavailable"
    states = {item.get("status") for item in coverage if isinstance(item, dict)}
    return "partial" if states & {"complete", "partial"} else "unavailable"


def _update_existing_coverage(db: sqlite3.Connection, harness: str, session_id: str, coverage: str) -> None:
    row = db.execute(
        "SELECT payload_json FROM canonical_session_summaries WHERE harness=? AND session_id=?",
        (harness, session_id),
    ).fetchone()
    if row is None:
        return
    payload = json.loads(str(row["payload_json"]))
    payload["capture_coverage"] = coverage
    encoded = _json(payload)
    db.execute(
        "UPDATE canonical_session_summaries SET payload_json=?,payload_digest=? WHERE harness=? AND session_id=?",
        (encoded, _digest(payload), harness, session_id),
    )


def _validate_loadout_row(row: object) -> dict[str, Any]:
    if not isinstance(row, dict) or set(row) != {"schema_version", "at", "project", "harness", "skills", "mcp", "hash"}:
        raise ValueError("invalid summary loadout")
    if row["schema_version"] != 1 or not isinstance(row["at"], str):
        raise ValueError("invalid summary loadout")
    try:
        at = datetime.fromisoformat(row["at"].replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError("invalid summary loadout") from exc
    if at.tzinfo is None or at.utcoffset() is None:
        raise ValueError("invalid summary loadout")
    for key in ("project", "harness"):
        if not isinstance(row[key], str) or not _IDENT.fullmatch(row[key]):
            raise ValueError("invalid summary loadout")
    for key in ("skills", "mcp"):
        if not isinstance(row[key], list) or not all(
            isinstance(value, str) and _IDENT.fullmatch(value) for value in row[key]
        ):
            raise ValueError("invalid summary loadout")
    if not isinstance(row["hash"], str) or not _DIGEST.fullmatch(row["hash"]):
        raise ValueError("invalid summary loadout")
    return {
        "schema_version": 1,
        "at": row["at"],
        "project": row["project"],
        "harness": row["harness"],
        "skills": sorted(row["skills"]),
        "mcp": sorted(row["mcp"]),
        "hash": row["hash"],
    }


def _project_key(facts: Mapping[str, list[dict[str, Any]]], harness: str, session_id: str) -> str:
    for item in facts.get("structural", []):
        if (
            item.get("record_type") == "source_scope"
            and item.get("harness") == harness
            and item.get("root_session_id") == session_id
            and item.get("source_session_id") == session_id
            and isinstance(item.get("project_key"), str)
        ):
            return item["project_key"]
    return "unregistered"


def _session_key(value: object) -> tuple[str, str]:
    if (
        not isinstance(value, tuple)
        or len(value) != 2
        or not all(isinstance(item, str) and item for item in value)
    ):
        raise ValueError("invalid summary session key")
    return value


def _require_transaction(db: sqlite3.Connection) -> None:
    if not db.in_transaction:
        raise ValueError("caller transaction required")


def _json(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False)


def _digest(value: object) -> str:
    return hashlib.sha256(_json(value).encode()).hexdigest()
