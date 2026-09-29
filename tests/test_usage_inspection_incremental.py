from __future__ import annotations

import json
from pathlib import Path

from skill_hub.application.usage.usage_inspection import merge_capture
from skill_hub.infrastructure.usage.usage_inspection_codex import capture_codex_source
from skill_hub.infrastructure.usage.usage_inspection_store import InspectionStore


def _record(kind: str, **payload: object) -> dict:
    return {"timestamp": "2026-01-01T00:00:00Z", "type": kind, "payload": payload}


def test_suffix_capture_keeps_cursor_and_does_not_store_invocation_body(tmp_data_home, tmp_path: Path):
    path = tmp_path / "rollout-session.jsonl"
    path.write_text(
        "".join(
            json.dumps(item) + "\n"
            for item in (
                _record("session_meta", id="session"),
                _record(
                    "response_item",
                    type="function_call",
                    call_id="call",
                    name="shell",
                    arguments='{"command":"printf secret"}',
                ),
            )
        )
    )
    first = capture_codex_source(path)
    assert merge_capture(first).outcome == "captured"
    cursor = InspectionStore.open().source_cursor(first.source.source_id)
    path.write_text(
        path.read_text()
        + json.dumps(_record("response_item", type="function_call_output", call_id="call", output="done"))
        + "\n"
    )
    second = capture_codex_source(path, cursor)
    assert second.source.offset_start == cursor.offset
    assert second.source.offset_end == path.stat().st_size
    assert len(second.tool_calls) == 1
    assert second.tool_calls[0].input_parts == ()
    assert second.tool_calls[0].result_parts
    assert "printf secret" not in second.source.resume_state


def test_partial_final_line_waits_for_completion(tmp_data_home, tmp_path: Path):
    path = tmp_path / "rollout-session.jsonl"
    path.write_text(json.dumps(_record("session_meta", id="session")) + "\n{")
    first = capture_codex_source(path)
    assert first.source.offset_end < path.stat().st_size
    assert first.source.status == "incomplete"
    assert merge_capture(first).outcome == "incomplete"
