"""Inspection requests decode only the selected published source family."""

from __future__ import annotations

import json
from dataclasses import replace

from skill_hub.application.usage import usage_publication_reads
from skill_hub.application.usage.usage_inspection_scan import _reader_policy
from skill_hub.domain.usage.usage_inspection_capture import ReaderBinding
from skill_hub.infrastructure.usage.usage_inspection_claude import capture_claude_source
from skill_hub.infrastructure.usage.usage_inspection_store import InspectionStore


def _capture(path, session_id):
    path.write_text(json.dumps({
        "type": "assistant", "sessionId": session_id, "uuid": "event",
        "timestamp": "2026-09-17T10:00:00Z",
        "message": {"role": "assistant", "content": [
            {"type": "tool_use", "id": "call", "name": "Bash", "input": {"command": "echo example"}},
        ]},
    }) + "\n")
    batch = capture_claude_source(path)
    assert batch.source.reader_source_evidence is not None
    return replace(batch, source=replace(batch.source, reader_binding=ReaderBinding(
        _reader_policy("claude-code"), batch.source.reader_source_evidence
    )))


def test_overview_does_not_decode_unrelated_published_history(tmp_data_home, tmp_path, monkeypatch):
    target = "selected-root"
    selected = _capture(tmp_path / f"{target}.jsonl", target)
    with InspectionStore.open() as store:
        store.merge_capture(selected)
        for index in range(100):
            name = f"unrelated-{index}"
            store.merge_capture(_capture(tmp_path / f"{name}.jsonl", name))

    decoded = []
    original = usage_publication_reads._decode

    def counted(rows, *, published):
        decoded.extend(str(row["source_id"]) for row in rows)
        return original(rows, published=published)

    monkeypatch.setattr(usage_publication_reads, "_decode", counted)
    with InspectionStore.open() as store:
        overview = store.inspection_payload("claude-code", target)
        assert overview["ok"]
        assert overview["tool_calls"]["total"] == 1
    assert decoded
    assert set(decoded) == {selected.source.source_id}
    assert len(decoded) < 100
