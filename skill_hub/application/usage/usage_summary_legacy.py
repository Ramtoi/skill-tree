"""Caller-transactional storage for sanitized legacy Usage summaries."""

from __future__ import annotations

import hashlib
import json
import math
import re
import sqlite3
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from skill_hub.domain.usage import usage_classify

_ID_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,512}$")
_ATOM_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$")
_COMPOUND_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$")
_DIGEST_RE = re.compile(r"^[0-9a-f]{64}$")
EXCERPT_REDACTION_VERSION = 1
_TOP_LEVEL = frozenset({
    "schema_version", "harness", "session_id", "project", "started_at", "last_activity_at",
    "frozen", "loadout_hash", "loadout_assumed", "tokens", "first_turn_input_total",
    "cache_hit_ratio", "steering_count", "activity", "thinking_text_share", "files_read",
    "files_edited", "tracked_files", "subagents", "skills", "intent_excerpt", "events",
    "compactions", "parent_session_id", "inspection", "excerpt_redaction_version",
    "summary_provenance", "capture_coverage",
})
_TOKEN_KEYS = frozenset({"input", "output", "cache_creation", "cache_read", "total", "subagent_total"})
_ACTIVITY_KEYS = frozenset({"read", "edit", "verify", "operate", "delegate", "skill", "external"})
_EVENT_KEYS = frozenset({
    "at", "kind", "name", "excerpt", "tokens", "thinking_len", "output_text_len", "model",
    "invoker", "activity", "edited_without_verify", "stacked", "interrupted", "token_delta",
    "additive",
})
_SUBAGENT_KEYS = frozenset({"id", "subagent_type", "model", "role", "count", "tokens"})
_SKILL_KEYS = frozenset({"key", "invoker", "count"})


@dataclass(frozen=True)
class ImportResult:
    status: str
    digest: str | None = None


def install_schema(db: sqlite3.Connection) -> None:
    """Install the additive summary table inside the caller's transaction."""
    _require_transaction(db)
    db.execute(
        """
        CREATE TABLE IF NOT EXISTS legacy_session_summaries (
            harness TEXT NOT NULL,
            session_id TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            payload_digest TEXT NOT NULL,
            legacy_schema_version INTEGER NOT NULL,
            imported_at TEXT NOT NULL,
            superseded_at TEXT,
            PRIMARY KEY(harness, session_id)
        )
        """
    )
    db.execute(
        "CREATE INDEX IF NOT EXISTS legacy_session_summaries_available "
        "ON legacy_session_summaries(superseded_at, harness, session_id)"
    )


def import_summary(
    db: sqlite3.Connection,
    summary: object,
    *,
    imported_at: str,
    legacy_schema_version: int = 1,
) -> ImportResult:
    """Store one valid legacy summary without creating canonical capture facts."""
    _require_transaction(db)
    if not isinstance(imported_at, str) or not imported_at:
        raise ValueError("invalid import time")
    if not _is_int(legacy_schema_version) or legacy_schema_version < 1:
        raise ValueError("invalid legacy schema version")
    if not isinstance(summary, dict):
        raise ValueError("summary must be an object")
    provenance = summary.get("summary_provenance")
    coverage = summary.get("capture_coverage")
    if provenance == "canonical":
        return ImportResult("skipped_canonical_export")
    if provenance is not None or coverage is not None:
        if provenance != "legacy_import" or coverage != "unavailable":
            raise ValueError("invalid summary provenance")
    payload = _sanitize_summary(summary)
    key = (payload["harness"], payload["session_id"])
    digest = _digest(payload)
    existing = db.execute(
        "SELECT payload_digest,superseded_at FROM legacy_session_summaries WHERE harness=? AND session_id=?",
        key,
    ).fetchone()
    if existing is not None:
        if existing["superseded_at"] is not None:
            return ImportResult("skipped_superseded", digest)
        if str(existing["payload_digest"]) == digest:
            return ImportResult("unchanged", digest)
        return ImportResult("conflict", digest)
    db.execute(
        """
        INSERT INTO legacy_session_summaries(
            harness,session_id,payload_json,payload_digest,legacy_schema_version,imported_at,superseded_at
        ) VALUES (?,?,?,?,?,?,NULL)
        """,
        (*key, _json(payload), digest, legacy_schema_version, imported_at),
    )
    return ImportResult("imported", digest)


def available_summaries(db: sqlite3.Connection) -> list[dict[str, Any]]:
    """Return available imports in deterministic key order with legacy provenance."""
    rows = db.execute(
        """
        SELECT payload_json FROM legacy_session_summaries
        WHERE superseded_at IS NULL
        ORDER BY harness,session_id
        """
    ).fetchall()
    result: list[dict[str, Any]] = []
    for row in rows:
        payload = json.loads(str(row["payload_json"]))
        result.append({**payload, "summary_provenance": "legacy_import", "capture_coverage": "unavailable"})
    return result


def mark_superseded(db: sqlite3.Connection, harness: str, session_id: str, *, at: str) -> bool:
    """Remove one legacy row from effective selection in the caller's transaction."""
    _require_transaction(db)
    _validate_id(harness, "harness")
    _validate_id(session_id, "session id")
    if not isinstance(at, str) or not at:
        raise ValueError("invalid supersession time")
    result = db.execute(
        """
        UPDATE legacy_session_summaries SET superseded_at=?
        WHERE harness=? AND session_id=? AND superseded_at IS NULL
        """,
        (at, harness, session_id),
    )
    return result.rowcount == 1


def _sanitize_summary(summary: dict[str, Any]) -> dict[str, Any]:
    unknown = set(summary) - _TOP_LEVEL
    if unknown:
        raise ValueError("unknown summary field")
    _validate_id(summary.get("harness"), "harness")
    _validate_id(summary.get("session_id"), "session id")
    result: dict[str, Any] = {"harness": summary["harness"], "session_id": summary["session_id"]}
    for key in (
        "schema_version", "first_turn_input_total", "steering_count", "files_read",
        "files_edited", "tracked_files", "compactions",
    ):
        if key in summary:
            result[key] = _optional_int(summary[key], key)
    if "project" in summary:
        result["project"] = _optional_atom(summary["project"], "project")
    for key in ("started_at", "last_activity_at"):
        if key in summary:
            result[key] = _optional_timestamp(summary[key], key)
    if "loadout_hash" in summary:
        result["loadout_hash"] = _optional_digest(summary["loadout_hash"], "loadout hash")
    if "parent_session_id" in summary:
        result["parent_session_id"] = _optional_id(summary["parent_session_id"], "parent session id")
    for key in ("frozen", "loadout_assumed"):
        if key in summary:
            result[key] = _optional_bool(summary[key], key)
    for key in ("cache_hit_ratio", "thinking_text_share"):
        if key in summary:
            result[key] = _optional_ratio(summary[key], key)
    if "tokens" in summary:
        result["tokens"] = _sanitize_tokens(summary["tokens"])
    if "activity" in summary:
        result["activity"] = _sanitize_activity(summary["activity"])
    if "intent_excerpt" in summary:
        result["intent_excerpt"] = _sanitize_excerpt(summary["intent_excerpt"], "intent excerpt")
    if "events" in summary:
        result["events"] = _sanitize_events(summary["events"])
    if "subagents" in summary:
        result["subagents"] = _sanitize_subagents(summary["subagents"])
    if "skills" in summary:
        result["skills"] = _sanitize_skills(summary["skills"])
    if "excerpt_redaction_version" in summary:
        _required_int(summary["excerpt_redaction_version"], "excerpt redaction version")
        result["excerpt_redaction_version"] = EXCERPT_REDACTION_VERSION
    return result


def _sanitize_tokens(value: object) -> dict[str, int]:
    if not isinstance(value, dict) or set(value) - _TOKEN_KEYS:
        raise ValueError("invalid tokens")
    return {key: _required_int(item, f"tokens.{key}") for key, item in value.items()}


def _sanitize_activity(value: object) -> dict[str, int]:
    if not isinstance(value, dict) or set(value) - _ACTIVITY_KEYS:
        raise ValueError("invalid activity")
    return {key: _required_int(item, f"activity.{key}") for key, item in value.items()}


def _sanitize_events(value: object) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        raise ValueError("invalid events")
    result = []
    for event in value:
        if not isinstance(event, dict) or set(event) - _EVENT_KEYS:
            raise ValueError("invalid event")
        clean: dict[str, Any] = {}
        if "at" in event:
            clean["at"] = _optional_timestamp(event["at"], "event.at")
        for key in ("kind", "model", "invoker"):
            if key in event:
                clean[key] = _optional_atom(event[key], f"event.{key}")
        if "name" in event:
            clean["name"] = _optional_compound_name(event["name"], "event.name")
        if "excerpt" in event:
            clean["excerpt"] = _sanitize_excerpt(event["excerpt"], "event excerpt")
        if "tokens" in event:
            clean["tokens"] = _sanitize_tokens(event["tokens"])
        if "activity" in event:
            clean["activity"] = _sanitize_activity(event["activity"])
        for key in ("thinking_len", "output_text_len", "token_delta"):
            if key in event:
                clean[key] = _required_int(event[key], f"event.{key}")
        for key in ("edited_without_verify", "stacked", "interrupted", "additive"):
            if key in event:
                clean[key] = _optional_bool(event[key], f"event.{key}")
        result.append(clean)
    return result


def _sanitize_subagents(value: object) -> list[dict[str, Any]] | None:
    if value is None:
        return None
    if not isinstance(value, list):
        raise ValueError("invalid subagents")
    result = []
    for item in value:
        if not isinstance(item, dict) or set(item) - _SUBAGENT_KEYS:
            raise ValueError("invalid subagent")
        clean: dict[str, Any] = {}
        if "id" in item:
            clean["id"] = _optional_id(item["id"], "subagent.id")
        for key in ("subagent_type", "model", "role"):
            if key in item:
                clean[key] = _optional_atom(item[key], f"subagent.{key}")
        if "count" in item:
            clean["count"] = _required_int(item["count"], "subagent.count")
        if "tokens" in item:
            clean["tokens"] = _required_int(item["tokens"], "subagent.tokens")
        result.append(clean)
    return result


def _sanitize_skills(value: object) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        raise ValueError("invalid skills")
    result = []
    for item in value:
        if not isinstance(item, dict) or set(item) - _SKILL_KEYS:
            raise ValueError("invalid skill")
        result.append({
            "key": _required_compound_name(item.get("key"), "skill key"),
            "invoker": _required_atom(item.get("invoker"), "skill invoker"),
            "count": _required_int(item.get("count"), "skill.count"),
        })
    return result


def _sanitize_excerpt(value: object, field: str) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError(f"invalid {field}")
    return usage_classify.redact_excerpt(value)


def _required_int(value: object, field: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise ValueError(f"invalid {field}")
    return value


def _optional_int(value: object, field: str) -> int | None:
    if value is None:
        return None
    return _required_int(value, field)


def _optional_ratio(value: object, field: str) -> float | int | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
        raise ValueError(f"invalid {field}")
    return value


def _optional_string(value: object, field: str) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError(f"invalid {field}")
    return value


def _optional_atom(value: object, field: str) -> str | None:
    if value is None:
        return None
    return _required_atom(value, field)


def _required_atom(value: object, field: str) -> str:
    if not isinstance(value, str) or not _ATOM_RE.fullmatch(value):
        raise ValueError(f"invalid {field}")
    return value


def _optional_compound_name(value: object, field: str) -> str | None:
    if value is None:
        return None
    return _required_compound_name(value, field)


def _required_compound_name(value: object, field: str) -> str:
    if not isinstance(value, str) or not _COMPOUND_NAME_RE.fullmatch(value):
        raise ValueError(f"invalid {field}")
    if "/" in value:
        segments = value.split("/")
        if len(segments) != 2 or any(":" in segment or not _ATOM_RE.fullmatch(segment) for segment in segments):
            raise ValueError(f"invalid {field}")
    elif ":" in value:
        segments = value.split(":")
        if len(segments) != 2 or any(not _ATOM_RE.fullmatch(segment) for segment in segments):
            raise ValueError(f"invalid {field}")
    return value


def _optional_id(value: object, field: str) -> str | None:
    if value is None:
        return None
    _validate_id(value, field)
    return str(value)


def _optional_digest(value: object, field: str) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or not _DIGEST_RE.fullmatch(value):
        raise ValueError(f"invalid {field}")
    return value


def _optional_timestamp(value: object, field: str) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError(f"invalid {field}")
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError(f"invalid {field}") from exc
    return value


def _optional_bool(value: object, field: str) -> bool | None:
    if value is None:
        return None
    if not isinstance(value, bool):
        raise ValueError(f"invalid {field}")
    return value


def _validate_id(value: object, field: str) -> None:
    if not isinstance(value, str) or not _ID_RE.fullmatch(value):
        raise ValueError(f"invalid {field}")


def _is_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _digest(payload: dict[str, Any]) -> str:
    return hashlib.sha256(_json(payload).encode("utf-8")).hexdigest()


def _require_transaction(db: sqlite3.Connection) -> None:
    if not db.in_transaction:
        raise RuntimeError("caller transaction required")
