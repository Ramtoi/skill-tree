"""Storage contracts for source-owned Usage publications."""

from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path

from skill_hub.application.usage.usage_inspection_scan import _reader_policy
from skill_hub.domain.usage.usage_inspection_capture import ReaderBinding
from skill_hub.infrastructure.usage import usage_publication
from skill_hub.infrastructure.usage.usage_inspection_claude import capture_claude_source
from skill_hub.infrastructure.usage.usage_inspection_store import InspectionStore

ROOT = "aaaaaaaa-1111-4111-8111-111111111111"


def _write(path: Path, name: str) -> None:
    path.write_text(json.dumps({
        "type": "assistant", "sessionId": ROOT, "uuid": name,
        "timestamp": "2026-09-17T10:00:00Z",
        "message": {"role": "assistant", "content": [{
            "type": "tool_use", "id": name, "name": "Bash",
            "input": {"command": f"echo secret-{name}"},
        }]},
    }) + "\n")


def _bound(batch):
    evidence = batch.source.reader_source_evidence
    assert evidence is not None
    return replace(batch, source=replace(
        batch.source, reader_binding=ReaderBinding(_reader_policy("claude-code"), evidence)
    ))


def test_bound_capture_publishes_safe_current_facts(tmp_data_home, tmp_path: Path) -> None:
    path = tmp_path / f"{ROOT}.jsonl"
    _write(path, "first")
    with InspectionStore.open() as store:
        batch = _bound(capture_claude_source(path))
        store.merge_capture(batch)
        calls = usage_publication.current_facts(store.db, "call")
        assert len(calls) == 1
        assert calls[0]["tool_name"] == "Bash"
        assert "secret-first" not in json.dumps(calls[0])
        assert store.db.execute(
            "SELECT state FROM source_versions WHERE source_id=?", (batch.source.source_id,)
        ).fetchone()[0] == "complete"


def test_unbound_capture_stays_explicitly_outside_published_heads(tmp_data_home, tmp_path: Path) -> None:
    path = tmp_path / f"{ROOT}.jsonl"
    _write(path, "legacy")
    with InspectionStore.open() as store:
        batch = capture_claude_source(path)
        store.merge_capture(batch)
        assert store.db.execute(
            "SELECT 1 FROM source_heads WHERE source_id=?", (batch.source.source_id,)
        ).fetchone() is None


def test_partial_replacement_advances_cursor_without_moving_the_head(tmp_data_home, tmp_path: Path) -> None:
    path = tmp_path / f"{ROOT}.jsonl"
    _write(path, "old")
    with InspectionStore.open() as store:
        first = _bound(capture_claude_source(path))
        store.merge_capture(first)
        cursor = store.source_cursor(first.source.source_id)
        head = store.db.execute(
            "SELECT publication_id FROM source_heads WHERE source_id=?", (first.source.source_id,)
        ).fetchone()[0]
        revision = store.canonical_revision()
        _write(path, "new")
        pending = _bound(capture_claude_source(path, cursor))
        store.merge_capture(replace(pending, source=replace(pending.source, status="incomplete")))
        assert store.source_cursor(first.source.source_id).revision > cursor.revision
        assert store.canonical_revision() == revision
        assert store.db.execute(
            "SELECT publication_id FROM source_heads WHERE source_id=?", (first.source.source_id,)
        ).fetchone()[0] == head
        assert [fact["native_call_id"] for fact in usage_publication.current_facts(store.db, "call")] == ["old"]
