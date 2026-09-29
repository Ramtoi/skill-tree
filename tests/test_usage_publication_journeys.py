"""Published Usage facts stay separate from capture progress and history."""

from __future__ import annotations

import json
from dataclasses import replace

from skill_hub.application.usage.usage_inspection import (
    inspection_payload,
    list_pins,
    mutate_pin,
    read_body_for_session,
)
from skill_hub.application.usage.usage_inspection_scan import _reader_policy
from skill_hub.domain.usage.usage_inspection_capture import ReaderBinding
from skill_hub.infrastructure.usage.usage_inspection_claude import capture_claude_source
from skill_hub.infrastructure.usage.usage_inspection_store import InspectionStore

ROOT = "aaaaaaaa-1111-4111-8111-111111111111"


def _write(path, name):
    records = [
        {
            "type": "assistant",
            "sessionId": ROOT,
            "uuid": f"assistant-{name}",
            "timestamp": "2026-09-17T10:00:00Z",
            "message": {
                "role": "assistant",
                "content": [
                    {
                        "type": "tool_use",
                        "id": name,
                        "name": "Bash",
                        "input": {"command": f"echo {name}"},
                    }
                ],
            },
        },
        {
            "type": "user",
            "sessionId": ROOT,
            "uuid": f"result-{name}",
            "timestamp": "2026-09-17T10:00:01Z",
            "message": {
                "role": "user",
                "content": [
                    {
                        "type": "tool_result",
                        "tool_use_id": name,
                        "content": f"retained result {name}",
                    }
                ],
            },
        },
    ]
    path.write_text("".join(json.dumps(record) + "\n" for record in records))


def _bound(batch):
    evidence = batch.source.reader_source_evidence
    assert evidence is not None
    return replace(
        batch, source=replace(batch.source, reader_binding=ReaderBinding(_reader_policy("claude-code"), evidence))
    )


def _tools():
    return inspection_payload("claude-code", ROOT, "tools")["tool_calls"]["items"]


def test_replacement_hides_removed_calls_but_keeps_authorized_history(tmp_data_home, tmp_path):
    path = tmp_path / f"{ROOT}.jsonl"
    _write(path, "old")
    with InspectionStore.open() as store:
        first = _bound(capture_claude_source(path))
        store.merge_capture(first)
        cursor = store.source_cursor(first.source.source_id)
    old = _tools()[0]
    body_id = old["result_parts"][0]["body_id"]
    assert mutate_pin("claude-code", ROOT, None, "add")["ok"]
    _write(path, "new")
    with InspectionStore.open() as store:
        store.merge_capture(_bound(capture_claude_source(path, cursor)))
    assert len(_tools()) == 1
    assert _tools()[0]["id"] != old["id"]
    assert read_body_for_session("claude-code", ROOT, body_id)["ok"]
    assert list_pins()["items"][0]["session_id"] == ROOT


def test_incomplete_replacement_does_not_publish_new_calls(tmp_data_home, tmp_path):
    path = tmp_path / f"{ROOT}.jsonl"
    _write(path, "old")
    with InspectionStore.open() as store:
        first = _bound(capture_claude_source(path))
        store.merge_capture(first)
        cursor = store.source_cursor(first.source.source_id)
    old_ids = [item["id"] for item in _tools()]
    _write(path, "new")
    pending = _bound(capture_claude_source(path, cursor))
    pending = replace(pending, source=replace(pending.source, status="incomplete"))
    with InspectionStore.open() as store:
        store.merge_capture(pending)
    assert [item["id"] for item in _tools()] == old_ids


def test_complete_empty_replacement_does_not_fall_back_to_historical_calls(tmp_data_home, tmp_path):
    path = tmp_path / f"{ROOT}.jsonl"
    _write(path, "old")
    with InspectionStore.open() as store:
        first = _bound(capture_claude_source(path))
        store.merge_capture(first)
        cursor = store.source_cursor(first.source.source_id)
    path.write_text(json.dumps({
        "type": "assistant", "sessionId": ROOT, "uuid": "empty",
        "timestamp": "2026-09-17T10:01:00Z",
        "message": {"role": "assistant", "content": []},
    }) + "\n")
    with InspectionStore.open() as store:
        store.merge_capture(_bound(capture_claude_source(path, cursor)))
    assert _tools() == []
    overview = inspection_payload("claude-code", ROOT, "overview")
    assert overview["timeline"]["events"] == []


def test_incomplete_reparent_preserves_published_root_and_timeline(tmp_data_home, tmp_path):
    path = tmp_path / f"{ROOT}.jsonl"
    _write(path, "old")
    with InspectionStore.open() as store:
        first = _bound(capture_claude_source(path))
        store.merge_capture(first)
        cursor = store.source_cursor(first.source.source_id)
    before = inspection_payload("claude-code", ROOT, "overview")
    body_id = before["tool_calls"]["items"][0]["result_parts"][0]["body_id"]
    assert mutate_pin("claude-code", ROOT, None, "add")["ok"]
    _write(path, "new")
    pending = _bound(capture_claude_source(path, cursor))
    parent = "bbbbbbbb-2222-4222-8222-222222222222"
    pending = replace(
        pending,
        root=replace(pending.root, root_session_id=parent, parent_session_id=parent, state="child"),
        source=replace(pending.source, status="incomplete"),
    )
    with InspectionStore.open() as store:
        store.merge_capture(pending)
    after = inspection_payload("claude-code", ROOT, "overview")
    assert after["session"]["key"] == before["session"]["key"]
    assert after["timeline"] == before["timeline"]
    assert [row["id"] for row in after["tool_calls"]["items"]] == [row["id"] for row in before["tool_calls"]["items"]]
    assert read_body_for_session("claude-code", ROOT, body_id)["ok"]
    assert list_pins()["items"][0]["session_id"] == ROOT


def test_initial_partial_dedicated_child_keeps_summary_coverage_partial(tmp_data_home, tmp_path):
    from test_usage_identity_public_contract import CHILD, _capture

    root = tmp_path / "root.jsonl"
    dedicated = tmp_path / "root" / "subagents" / f"agent-{CHILD}.jsonl"
    with InspectionStore.open() as store:
        store.merge_capture(_bound(_capture(root, inline=True)))
        dedicated.parent.mkdir(parents=True, exist_ok=True)
        dedicated.write_text("")
        partial = _bound(capture_claude_source(dedicated))
        store.merge_capture(replace(partial, source=replace(partial.source, status="incomplete")))
        facts = store.summary_facts("claude-code", "root")
        assert {row["status"] for row in facts["coverage"]} == {"complete", "partial"}
        assert not facts["token"]
