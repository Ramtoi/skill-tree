"""Pin aliases remain attached to one logical child across reader upgrades."""

from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path

from skill_hub.application.usage.usage_inspection import index_payload, list_pins, merge_capture, mutate_pin
from skill_hub.infrastructure.usage.usage_inspection_claude import capture_claude_source

CHILD = "shortagent"


def _records(*, inline: bool) -> list[dict]:
    side = {"isSidechain": True, "agentId": CHILD} if inline else {}
    return [{
        "type": "assistant", "uuid": "child-record", **side,
        "message": {"id": "child-message", "content": [{
            "type": "tool_use", "id": "child-call", "name": "Bash", "input": {"command": "echo child"},
        }]},
    }]


def _capture(path: Path, *, inline: bool, legacy: bool = False):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(record) + "\n" for record in _records(inline=inline)))
    batch = capture_claude_source(path)
    if legacy:
        batch = replace(
            batch,
            source=replace(batch.source, reader_revision=4),
            runs=tuple(replace(run, native_ref=None) for run in batch.runs),
        )
    return batch


def _child(payload: dict, root_session: str) -> dict:
    session = next(item for item in payload["sessions"] if item["session_id"] == root_session)
    return next(agent for agent in session["agents"] if agent["session_id"] == CHILD)


def _reparse(path: Path, old_batch):
    from skill_hub.infrastructure.usage.usage_inspection_store import InspectionStore

    with InspectionStore.open() as store:
        cursor = store.source_cursor(old_batch.source.source_id)
    return capture_claude_source(path, cursor)


def test_legacy_physical_pin_can_be_removed_by_logical_alias(tmp_data_home, tmp_path):
    root = tmp_path / "root.jsonl"
    child = tmp_path / "root" / "subagents" / f"agent-{CHILD}.jsonl"
    unrelated = tmp_path / "unrelated.jsonl"
    legacy_root = _capture(root, inline=True, legacy=True)
    legacy_child = _capture(child, inline=False, legacy=True)
    unrelated_batch = _capture(unrelated, inline=True, legacy=True)
    merge_capture(legacy_root)
    merge_capture(legacy_child)
    merge_capture(unrelated_batch)
    legacy_pin_id = legacy_child.runs[0].run_id
    unrelated_pin_id = unrelated_batch.runs[0].run_id
    assert mutate_pin("claude-code", root.stem, legacy_pin_id, "add")["ok"]
    assert mutate_pin("claude-code", unrelated.stem, unrelated_pin_id, "add")["ok"]

    for path, old_batch in ((root, legacy_root), (child, legacy_child), (unrelated, unrelated_batch)):
        cursor_batch = _reparse(path, old_batch)
        assert merge_capture(cursor_batch).outcome == "captured"

    logical_id = _child(index_payload(), root.stem)["run_id"]
    assert mutate_pin("claude-code", root.stem, logical_id, "remove")["ok"]
    remaining = list_pins()["items"]
    assert len(remaining) == 1
    assert remaining[0]["session_id"] == unrelated.stem


def test_adding_both_physical_and_logical_aliases_keeps_one_pin(tmp_data_home, tmp_path):
    root = tmp_path / "root.jsonl"
    child = tmp_path / "root" / "subagents" / f"agent-{CHILD}.jsonl"
    legacy_root = _capture(root, inline=True, legacy=True)
    legacy_child = _capture(child, inline=False, legacy=True)
    merge_capture(legacy_root)
    merge_capture(legacy_child)
    legacy_id = legacy_child.runs[0].run_id
    assert mutate_pin("claude-code", root.stem, legacy_id, "add")["ok"]

    assert merge_capture(_reparse(root, legacy_root)).outcome == "captured"
    assert merge_capture(_reparse(child, legacy_child)).outcome == "captured"
    logical_id = _child(index_payload(), root.stem)["run_id"]
    assert mutate_pin("claude-code", root.stem, logical_id, "add")["ok"]
    pins = list_pins()["items"]
    assert len(pins) == 1
