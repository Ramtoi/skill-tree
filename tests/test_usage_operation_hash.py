from __future__ import annotations

import hashlib
import json
import sqlite3
from dataclasses import replace
from pathlib import Path

import pytest

from skill_hub.application.usage.usage_inspection import merge_capture
from skill_hub.domain.usage.usage_inspection_capture import (
    BodyPartInput,
    CaptureBatch,
    RootResolution,
    RunInput,
    SourceFingerprint,
    SourceInput,
    ToolCallInput,
    operation_hash,
)
from skill_hub.infrastructure.usage.usage_inspection_codex import capture_codex_source
from skill_hub.infrastructure.usage.usage_inspection_store import InspectionStore, db_path


def _batch(source_id: str = "source:test", signature: str = "git status") -> CaptureBatch:
    label = "test" if source_id == "source:test" else "second"
    source = SourceInput(
        source_id,
        "claude-code",
        "session",
        source_id,
        0,
        0,
        3,
        SourceFingerprint(None, None, 3, 1, "prefix", "boundary"),
        "active",
    )
    part = BodyPartInput("part:" + source_id, "invocation", "available", "text/plain", b"abc", None)
    tool = ToolCallInput(
        "call:" + label, "run:test", "native-" + label, None, "Bash", "local", signature, "pending", (part,), ()
    )
    return CaptureBatch(
        1,
        "2026-01-01T00:00:00Z",
        RootResolution("claude-code", "session", "session", None, "root"),
        source,
        (RunInput("run:test", "session", "native", None, None, (), None, None),),
        (),
        (tool,),
    )


def _codex_source(path: Path, value: str) -> None:
    path.write_text(
        json.dumps({"type": "session_meta", "payload": {"id": "session"}})
        + "\n"
        + json.dumps(
            {
                "type": "response_item",
                "payload": {"type": "custom_tool_call", "call_id": "call", "name": "shell", "input": value},
            }
        )
        + "\n",
        encoding="utf-8",
    )


def test_raw_op_prefixes_are_hashed_even_when_they_look_prehashed(tmp_path):
    raw = "op:secret"
    hash_looking = "op:" + "a" * 64
    assert operation_hash(raw) == "op:" + hashlib.sha256(raw.encode()).hexdigest()
    assert operation_hash(hash_looking) == "op:" + hashlib.sha256(hash_looking.encode()).hexdigest()
    with pytest.raises(ValueError, match="invalid prehashed"):
        operation_hash(raw, already_hashed=True)
    hashed = operation_hash(raw)
    assert operation_hash(hashed, already_hashed=True) == hashed

    for value in (raw, hash_looking):
        path = tmp_path / f"{len(value)}.jsonl"
        _codex_source(path, value)
        batch = capture_codex_source(path)
        assert batch.tool_calls[0].operation_signature == operation_hash(value)
        assert batch.tool_calls[0].operation_signature_hashed is True


def test_store_direct_inputs_are_raw_by_default(tmp_data_home):
    raw = "op:secret"
    batch = _batch(signature=raw)
    merge_capture(batch)
    with InspectionStore.open() as store:
        row = store.db.execute("SELECT operation_signature FROM tool_calls").fetchone()
        assert row[0] == operation_hash(raw)


def test_v1_migration_hashes_all_legacy_signatures(tmp_data_home):
    first = _batch()
    second = _batch("source:second", "op:" + "b" * 64)
    merge_capture(first)
    merge_capture(second)
    with sqlite3.connect(db_path()) as db:
        db.execute("UPDATE tool_calls SET operation_signature='op:secret' WHERE call_id='call:test'")
        db.execute("UPDATE tool_calls SET operation_signature=? WHERE call_id='call:second'", ("op:" + "b" * 64,))
        db.execute("ALTER TABLE tool_calls DROP COLUMN operation_summary")
        db.execute("UPDATE metadata SET value='1' WHERE key='schema_version'")
        db.commit()
    with InspectionStore.open() as store:
        rows = store.db.execute("SELECT call_id,operation_signature FROM tool_calls ORDER BY call_id").fetchall()
        assert [tuple(row) for row in rows] == [
            ("call:second", operation_hash("op:" + "b" * 64)),
            ("call:test", operation_hash("op:secret")),
        ]


def test_resumed_hash_keeps_call_identity_and_does_not_duplicate_input(tmp_path, tmp_data_home):
    path = tmp_path / "session.jsonl"
    path.write_text(
        json.dumps({"type": "session_meta", "payload": {"id": "session"}})
        + "\n"
        + json.dumps(
            {
                "type": "response_item",
                "payload": {"type": "custom_tool_call", "call_id": "call", "name": "shell", "input": "op:secret"},
            }
        )
        + "\n",
        encoding="utf-8",
    )
    first = capture_codex_source(path)
    merge_capture(first)
    with InspectionStore.open() as store:
        cursor = store.source_cursor(first.source.source_id)
    with path.open("a", encoding="utf-8") as fh:
        fh.write(
            json.dumps(
                {
                    "type": "response_item",
                    "payload": {"type": "custom_tool_call_output", "call_id": "call", "output": "ok"},
                }
            )
            + "\n"
        )
    resumed = capture_codex_source(path, cursor)
    merge_capture(resumed)
    with InspectionStore.open() as store:
        rows = store.db.execute("SELECT call_id,operation_signature FROM tool_calls").fetchall()
        parts = store.db.execute("SELECT side FROM tool_parts WHERE call_id=? ORDER BY side", (rows[0][0],)).fetchall()
        assert [tuple(row) for row in rows] == [(first.tool_calls[0].call_id, operation_hash("op:secret"))]
        assert [row[0] for row in parts] == ["input", "result"]


def test_old_reader_cursor_reparses_hash_looking_raw_input(tmp_path, tmp_data_home):
    raw = "op:" + "a" * 64
    path = tmp_path / "session.jsonl"
    _codex_source(path, raw)
    first = capture_codex_source(path)
    merge_capture(first)
    with InspectionStore.open() as store:
        current = store.source_cursor(first.source.source_id)
    old_cursor = replace(current, reader_revision=2)
    reparsed = capture_codex_source(path, old_cursor)
    assert reparsed.tool_calls[0].call_id == first.tool_calls[0].call_id
    assert reparsed.tool_calls[0].operation_signature == operation_hash(raw)
