"""Public host identity behavior across inline and dedicated child sources."""

from __future__ import annotations

import json
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path

import pytest

from skill_hub.application.usage.usage_inspection import index_payload, merge_capture, mutate_pin, prune_bodies
from skill_hub.infrastructure.usage.usage_inspection_claude import capture_claude_source


@pytest.fixture(params=[False, True], ids=["legacy", "published"], autouse=True)
def capture_binding(request, monkeypatch):
    if not request.param:
        return
    from skill_hub.application.usage.usage_inspection_scan import _reader_policy
    from skill_hub.domain.usage.usage_inspection_capture import ReaderBinding

    original = capture_claude_source

    def bound(*args, **kwargs):
        batch = original(*args, **kwargs)
        evidence = batch.source.reader_source_evidence
        assert evidence is not None
        return replace(batch, source=replace(
            batch.source, reader_binding=ReaderBinding(_reader_policy("claude-code"), evidence)
        ))

    monkeypatch.setattr(__name__ + ".capture_claude_source", bound)


CHILD = "shortagent"


def _write(path: Path, records: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(json.dumps(record) for record in records) + "\n")


def _records(*, inline: bool) -> list[dict]:
    side = {"isSidechain": True, "agentId": CHILD} if inline else {}
    return [
        {"type": "cost-state", "totalLinesAdded": 4, "totalLinesRemoved": 0, **side},
        {
            "type": "assistant", "uuid": "child-call-record", **side,
            "message": {"id": "child-message", "usage": {"input_tokens": 71}, "content": [
                {"type": "tool_use", "id": "child-call", "name": "Bash", "input": {"command": "echo child"}},
            ]},
        },
        {
            "type": "user", "uuid": "child-result-record", **side,
            "message": {"content": [{"type": "tool_result", "tool_use_id": "child-call", "content": "child result"}]},
        },
    ]


def _capture(path: Path, *, inline: bool, status: str = "active"):
    _write(path, _records(inline=inline))
    batch = capture_claude_source(path)
    return replace(batch, source=replace(batch.source, status=status))


def _child(payload: dict) -> dict:
    return next(agent for agent in payload["sessions"][0]["agents"] if agent["session_id"] == CHILD)


def test_public_child_identity_pin_and_selected_dedicated_observation(tmp_data_home, tmp_path):
    root = tmp_path / "root.jsonl"
    dedicated = tmp_path / "root" / "subagents" / f"agent-{CHILD}.jsonl"
    assert merge_capture(_capture(root, inline=True)).outcome == "captured"
    first = _child(index_payload())
    public_run_id = first["run_id"]
    assert mutate_pin("claude-code", root.stem, public_run_id, "add")["ok"]

    assert merge_capture(_capture(dedicated, inline=False)).outcome == "captured"
    after = _child(index_payload())
    assert after["run_id"] == public_run_id
    assert after["native"]["own"]["tool_calls"] == 1
    assert after["scopes"]["own"]["tokens"]["total"] == 71
    assert mutate_pin("claude-code", root.stem, public_run_id, "remove")["ok"]


def test_pin_protects_bodies_of_both_members_then_unpin_prunes_them(tmp_data_home, tmp_path):
    root = tmp_path / "root.jsonl"
    dedicated = tmp_path / "root" / "subagents" / f"agent-{CHILD}.jsonl"
    merge_capture(_capture(root, inline=True))
    public_run_id = _child(index_payload())["run_id"]
    merge_capture(_capture(dedicated, inline=False))
    assert mutate_pin("claude-code", root.stem, public_run_id, "add")["ok"]
    protected = prune_bodies(older_than=1, max_store_bytes=2**40, now=datetime(2030, 1, 1, tzinfo=timezone.utc))
    assert protected["ok"]
    assert protected["parts_pruned"] == 0

    assert mutate_pin("claude-code", root.stem, public_run_id, "remove")["ok"]
    pruned = prune_bodies(older_than=1, max_store_bytes=2**40, now=datetime(2030, 1, 1, tzinfo=timezone.utc))
    assert pruned["ok"]
    assert pruned["parts_pruned"] >= 2


def test_incomplete_dedicated_source_is_selected_without_inline_fallback(tmp_data_home, tmp_path):
    root = tmp_path / "root.jsonl"
    dedicated = tmp_path / "root" / "subagents" / f"agent-{CHILD}.jsonl"
    merge_capture(_capture(root, inline=True))
    _write(dedicated, [])
    empty = capture_claude_source(dedicated)
    assert merge_capture(replace(empty, source=replace(empty.source, status="incomplete"))).outcome == "incomplete"
    child = _child(index_payload())
    assert child["status"] == "partial"
    assert child["native"]["own"]["tool_calls"] is None
    assert child["scopes"]["own"]["tokens"]["total"] is None


def test_timeline_uses_selected_member_and_public_run_ids(tmp_data_home, tmp_path):
    from skill_hub.infrastructure.usage.usage_inspection_store import InspectionStore

    root = tmp_path / "root.jsonl"
    dedicated = tmp_path / "root" / "subagents" / f"agent-{CHILD}.jsonl"
    merge_capture(_capture(root, inline=True))
    merge_capture(_capture(dedicated, inline=False))
    public_id = _child(index_payload())["run_id"]
    with InspectionStore.open() as store:
        payload = store.inspection_payload("claude-code", root.stem)
    assert payload["ok"]
    child_events = [
        event for event in payload["timeline"]["events"]
        if event["kind"] in ("tool_started", "tool_result")
    ]
    assert len(child_events) == 2
    assert {event["run_id"] for event in child_events} == {public_id}


def test_removed_pinned_child_keeps_retained_body_protection(tmp_data_home, tmp_path):
    root = tmp_path / "root.jsonl"
    merge_capture(_capture(root, inline=True))
    public_id = _child(index_payload())["run_id"]
    assert mutate_pin("claude-code", root.stem, public_id, "add")["ok"]
    _write(root, [{
        "type": "assistant", "uuid": "new-root-only",
        "message": {"role": "assistant", "content": []},
    }])
    merge_capture(capture_claude_source(root))
    protected = prune_bodies(older_than=1, max_store_bytes=2**40, now=datetime(2030, 1, 1, tzinfo=timezone.utc))
    assert protected["ok"]
    assert protected["parts_pruned"] == 0
