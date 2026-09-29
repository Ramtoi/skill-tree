"""Legacy Usage summaries retain only their safe historical summary shape."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

from skill_hub.application.usage import usage_summary_legacy as legacy

GOLDEN = (
    Path(__file__).parent / "fixtures" / "usage" / "wave3_golden" / "input" / "legacy"
    / "claude-code-legacy-only.json"
)
GOLDEN_ROWS = Path(__file__).parent / "fixtures" / "usage" / "wave3_golden" / "expected" / "session_rows.json"


def _db() -> sqlite3.Connection:
    db = sqlite3.connect(":memory:", isolation_level=None)
    db.row_factory = sqlite3.Row
    db.execute("BEGIN")
    legacy.install_schema(db)
    db.commit()
    return db


def _import(db: sqlite3.Connection, row: dict, *, at: str = "2026-09-17T12:00:00.000Z"):
    db.execute("BEGIN")
    try:
        result = legacy.import_summary(db, row, imported_at=at)
    except Exception:
        db.rollback()
        raise
    db.commit()
    return result


def test_import_preserves_the_sparse_missing_source_golden_summary() -> None:
    db = _db()
    row = json.loads(GOLDEN.read_text())

    result = _import(db, row)

    assert result.status == "imported"
    assert legacy.available_summaries(db) == [{
        **row,
        "summary_provenance": "legacy_import",
        "capture_coverage": "unavailable",
    }]
    assert [item[0] for item in db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")] == [
        "legacy_session_summaries"
    ]


def test_import_accepts_every_recorded_golden_summary_shape() -> None:
    db = _db()
    rows = []
    for line in GOLDEN_ROWS.read_text().splitlines():
        row = json.loads(line)
        row.pop("inspection", None)
        row.setdefault("frozen", False)
        rows.append(row)

    assert [_import(db, row).status for row in rows] == ["imported"] * len(rows)
    stored = legacy.available_summaries(db)
    assert [(row["harness"], row["session_id"]) for row in stored] == sorted(
        (row["harness"], row["session_id"]) for row in rows
    )
    assert all(row["excerpt_redaction_version"] == 1 for row in stored)
    assert all("inspection" not in row for row in stored)


def test_import_redacts_excerpts_and_rejects_unknown_or_body_shaped_payloads(tmp_path: Path) -> None:
    db = _db()
    row = json.loads(GOLDEN.read_text())
    secret = "Bearer abcdefghijklmnopqrstuvwxyz"
    row["intent_excerpt"] = f"open {tmp_path / 'private.py'} with {secret}"
    row["events"][0]["excerpt"] = secret
    row["inspection"] = {"raw_body": "derived projection is not legacy evidence"}

    _import(db, row)
    stored = legacy.available_summaries(db)[0]
    rendered = json.dumps(stored)
    assert str(tmp_path) not in rendered
    assert "abcdefghijklmnopqrstuvwxyz" not in rendered
    assert stored["intent_excerpt"].endswith("[redacted]")
    assert "inspection" not in stored

    for unsafe in (
        {**row, "body": "raw transcript"},
        {**row, "events": [{**row["events"][0], "raw_body": "raw transcript"}]},
        {**row, "project": str(tmp_path / "private-project")},
        {**row, "parent_session_id": str(tmp_path / "private-parent")},
        {**row, "loadout_hash": str(tmp_path / "private-hash")},
        {**row, "events": [{**row["events"][0], "name": str(tmp_path / "private-tool")}]},
        {**row, "events": [{**row["events"][0], "model": str(tmp_path / "private-model")}]},
        {**row, "unknown": {"value": 1}},
    ):
        with pytest.raises(ValueError):
            _import(db, unsafe)


def test_thinking_share_allows_real_values_above_one_and_rejects_nan() -> None:
    db = _db()
    row = json.loads(GOLDEN.read_text())

    assert _import(db, {**row, "thinking_text_share": 2.5}).status == "imported"
    with pytest.raises(ValueError):
        _import(db, {**row, "session_id": "other", "thinking_text_share": float("nan")})


def test_timestamp_and_digest_fields_are_not_unvalidated_strings() -> None:
    db = _db()
    row = json.loads(GOLDEN.read_text())

    for invalid in (
        {**row, "started_at": "not-a-timestamp"},
        {**row, "loadout_hash": "not-a-digest"},
    ):
        with pytest.raises(ValueError):
            _import(db, invalid)


def test_provenance_only_accepts_legacy_imports_and_skips_canonical_exports() -> None:
    db = _db()
    row = json.loads(GOLDEN.read_text())

    assert _import(db, {
        **row,
        "session_id": "legacy-import",
        "summary_provenance": "legacy_import",
        "capture_coverage": "unavailable",
    }).status == "imported"
    assert _import(db, {
        **row,
        "session_id": "canonical-export",
        "summary_provenance": "canonical",
        "capture_coverage": "complete",
    }).status == "skipped_canonical_export"
    for invalid in (
        {**row, "summary_provenance": "legacy_import", "capture_coverage": "partial"},
        {**row, "summary_provenance": "other", "capture_coverage": "unavailable"},
        {**row, "capture_coverage": "complete"},
    ):
        with pytest.raises(ValueError):
            _import(db, invalid)


def test_compound_names_allow_one_server_tool_or_namespace_pair_only() -> None:
    db = _db()
    row = json.loads(GOLDEN.read_text())
    valid = {
        **row,
        "session_id": "valid-compound",
        "events": [{**row["events"][0], "name": "touchpoint/get_goal"}],
        "skills": [{"key": "team:review", "invoker": "model", "count": 1}],
    }

    assert _import(db, valid).status == "imported"
    stored = legacy.available_summaries(db)[0]
    assert stored["events"][0]["name"] == "touchpoint/get_goal"
    assert stored["skills"] == [{"key": "team:review", "invoker": "model", "count": 1}]
    for unsafe_name in ("repo/private/transcript.jsonl", "C:/private/secret", "team:review:raw"):
        with pytest.raises(ValueError):
            _import(db, {**row, "events": [{**row["events"][0], "name": unsafe_name}]})


def test_duplicate_conflict_is_deterministic_and_canonical_exports_are_skipped() -> None:
    db = _db()
    row = json.loads(GOLDEN.read_text())

    assert _import(db, row).status == "imported"
    assert _import(db, row).status == "unchanged"
    assert _import(db, {**row, "project": "other"}).status == "conflict"
    assert _import(db, {**row, "session_id": "other", "summary_provenance": "canonical"}).status == (
        "skipped_canonical_export"
    )
    assert [(item["harness"], item["session_id"]) for item in legacy.available_summaries(db)] == [
        ("claude-code", row["session_id"])
    ]


def test_supersession_is_caller_transactional_and_never_resurrects_imports() -> None:
    db = _db()
    row = json.loads(GOLDEN.read_text())
    _import(db, row)

    db.execute("BEGIN")
    assert legacy.mark_superseded(db, row["harness"], row["session_id"], at="2026-09-18T00:00:00.000Z") is True
    db.rollback()
    assert len(legacy.available_summaries(db)) == 1

    db.execute("BEGIN")
    assert legacy.mark_superseded(db, row["harness"], row["session_id"], at="2026-09-18T00:00:00.000Z") is True
    db.commit()
    assert legacy.available_summaries(db) == []
    assert _import(db, row).status == "skipped_superseded"
    assert legacy.available_summaries(db) == []
