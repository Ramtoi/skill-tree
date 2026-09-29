"""Fixed reader policy changes reparse unchanged bytes into a new publication."""

import json
from dataclasses import replace

from skill_hub.application.usage import usage_inspection, usage_inspection_scan
from skill_hub.domain.usage.usage_inspection_capture import CaptureSource
from skill_hub.infrastructure.usage.usage_inspection_claude import capture_claude_source
from skill_hub.infrastructure.usage.usage_inspection_store import InspectionStore

SESSION = "aaaaaaaa-1111-4111-8111-111111111111"


def _source(tmp_path):
    path = tmp_path / f"{SESSION}.jsonl"
    path.write_text(json.dumps({
        "type": "user", "sessionId": SESSION, "timestamp": "2026-09-17T08:00:00Z",
        "message": {"content": "full captured message"},
    }) + "\n")
    return path


def test_unbound_unchanged_source_gets_complete_publication(tmp_data_home, tmp_path):
    path = _source(tmp_path)
    batch = capture_claude_source(path)
    with InspectionStore.open() as store:
        store.merge_capture(batch)
        assert store.db.execute("SELECT COUNT(*) FROM source_heads").fetchone()[0] == 0
    result = usage_inspection_scan.capture_pass({"claude-code": tmp_path})
    assert result["errors"] == []
    assert result["bytes_read"] == path.stat().st_size
    with InspectionStore.open() as store:
        assert store.db.execute("SELECT COUNT(*) FROM source_heads").fetchone()[0] == 1
        from skill_hub.infrastructure.usage.usage_publication import current_facts
        assert [fact["text_len"] for fact in current_facts(store.db, "message")] == [21]


def test_changed_adapter_digest_reparses_unchanged_bytes(tmp_data_home, tmp_path):
    path = _source(tmp_path)
    first = usage_inspection_scan.capture_pass({"claude-code": tmp_path})
    assert first["errors"] == []
    policy = replace(usage_inspection_scan._reader_policy("claude-code"), adapter_digest="a" * 64)
    with InspectionStore.open() as store:
        source_id, old_head = store.db.execute("SELECT source_id,publication_id FROM source_heads").fetchone()
        offsets = []
        def build(cursor):
            offsets.append(cursor.offset)
            return capture_claude_source(path, cursor)
        result = usage_inspection.capture_scan_source(
            CaptureSource(source_id, "claude-code", SESSION), build, store, policy,
        )
        assert offsets == [0]
        assert result.outcome == "captured"
        assert store.db.execute("SELECT publication_id FROM source_heads").fetchone()[0] != old_head
        assert store.db.execute("SELECT COUNT(*) FROM source_versions WHERE state='complete'").fetchone()[0] == 2



def test_reappearing_source_restores_capture_availability(tmp_data_home, tmp_path):
    path = _source(tmp_path)
    first = usage_inspection_scan.capture_pass({"claude-code": tmp_path})
    assert first["errors"] == []
    with InspectionStore.open() as store:
        source_id = store.db.execute("SELECT source_id FROM source_heads").fetchone()[0]
        store.mark_missing_sources("claude-code", set())
        status = store.db.execute("SELECT status FROM sources WHERE source_id=?", (source_id,)).fetchone()[0]
        assert status == "unavailable"
    result = usage_inspection_scan.capture_pass({"claude-code": tmp_path})
    assert result["errors"] == []
    with InspectionStore.open() as store:
        assert store.db.execute("SELECT status FROM sources WHERE source_id=?", (source_id,)).fetchone()[0] == "active"
