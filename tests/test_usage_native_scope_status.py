from __future__ import annotations

import json
from dataclasses import replace

import pytest

from skill_hub.application.usage.usage_inspection import index_payload, merge_capture
from skill_hub.domain.usage.usage_inspection_capture import (
    CaptureBatch,
    EventInput,
    PrInput,
    RootResolution,
    RunInput,
    SourceFingerprint,
    SourceInput,
)
from skill_hub.infrastructure.usage.usage_inspection_claude import capture_claude_source
from skill_hub.infrastructure.usage.usage_inspection_store import InspectionStore


def test_incomplete_capture_is_partial_and_complete_recapture_restores_available(tmp_data_home):
    source = SourceInput(
        "source:partial",
        "claude-code",
        "partial",
        "generation:partial",
        0,
        0,
        0,
        SourceFingerprint(None, None, 0, 1, "p", "b"),
        "incomplete",
    )
    run = RunInput("run:partial", "partial", "native", None, None, (), None, None, (), 10, 0, 20, "feature/x")
    root = RootResolution("claude-code", "partial", "partial", None, "root")
    batch = CaptureBatch(1, "2026-01-01T00:00:00Z", root, source, (run,))
    assert merge_capture(batch).outcome == "incomplete"
    assert index_payload()["sessions"][0]["status"] == "partial"
    assert index_payload()["sessions"][0]["native"]["own"]["status"] == "partial"

    complete = replace(batch, source=replace(source, status="active", expected_revision=1))
    assert merge_capture(complete).outcome == "captured"
    assert index_payload()["sessions"][0]["status"] == "available"


def test_inline_claude_sidechain_has_child_native_scope_and_own_pr(tmp_data_home, tmp_path):
    path = tmp_path / "root.jsonl"
    records = [
        {"type": "cost-state", "totalLinesAdded": 10, "totalLinesRemoved": 1, "totalDuration": 100},
        {
            "type": "assistant",
            "uuid": "root-tool",
            "timestamp": "2026-01-01T00:00:01Z",
            "message": {"content": [{"type": "tool_use", "id": "root-call", "name": "Read", "input": {}}]},
        },
        {
            "type": "assistant",
            "uuid": "child-tool",
            "timestamp": "2026-01-01T00:00:02Z",
            "isSidechain": True,
            "agentId": "agent-child",
            "message": {
                "content": [
                    {
                        "type": "tool_use",
                        "id": "child-call",
                        "name": "Bash",
                        "input": {
                            "command": "gh pr create --repo acme/repo",
                        },
                    }
                ]
            },
        },
        {
            "type": "user",
            "uuid": "child-result",
            "timestamp": "2026-01-01T00:00:03Z",
            "isSidechain": True,
            "agentId": "agent-child",
            "message": {
                "content": [
                    {
                        "type": "tool_result",
                        "tool_use_id": "child-call",
                        "content": "https://github.com/acme/repo/pull/12",
                    }
                ]
            },
        },
        {
            "type": "cost-state",
            "totalLinesAdded": 4,
            "totalLinesRemoved": 0,
            "totalDuration": 40,
            "isSidechain": True,
            "agentId": "agent-child",
        },
    ]
    path.write_text("\n".join(json.dumps(record) for record in records) + "\n")
    merge_capture(capture_claude_source(path))
    item = index_payload()["sessions"][0]
    assert item["native"]["own"]["lines_added"] == 10
    assert item["native"]["children"]["tool_calls"] == 1
    assert item["native"]["subtree"]["tool_calls"] == 2
    assert item["native"]["children"]["lines_added"] == 4
    assert item["native"]["subtree"]["lines_added"] == 14
    assert item["agents"]
    child = item["agents"][0]
    assert child["native"]["own"]["tool_calls"] == 1
    assert child["latest_pr"]["number"] == 12
    assert item["latest_pr"]["number"] == 12


def test_missing_root_stays_unavailable_when_later_child_source_merges(tmp_data_home):
    fingerprint = SourceFingerprint(None, None, 0, 1, "p", "b")
    root = RootResolution("claude-code", "root-missing", "root-missing", None, "root")
    source_a = SourceInput("source:a", "claude-code", "root-missing", "epoch:a", 0, 0, 0, fingerprint, "active")
    batch_a = CaptureBatch(
        1,
        "2026-01-01T00:00:00Z",
        root,
        source_a,
        (RunInput("run:a", "root-missing", "root", None, None, (), None, None, (), 2, 0, 1, None),),
    )
    merge_capture(batch_a)
    with InspectionStore.open() as store:
        assert store.mark_missing_sources("claude-code", set()) == 1
        store.db.commit()
    child_root = RootResolution("claude-code", "child-later", "root-missing", "root-missing", "child")
    source_b = SourceInput("source:b", "claude-code", "child-later", "epoch:b", 0, 0, 0, fingerprint, "active")
    batch_b = CaptureBatch(
        2,
        "2026-01-01T00:00:01Z",
        child_root,
        source_b,
        (RunInput("run:b", "child-later", "child", "run:a", "agent", (), None, None, (), 1, 0, 1, None),),
    )
    merge_capture(batch_b)
    item = index_payload()["sessions"][0]
    assert item["status"] == "unavailable"


@pytest.mark.parametrize("child_first", [False, True])
def test_separate_child_source_exposes_native_facts_without_double_counting_inline(
    tmp_data_home, tmp_path, child_first
):
    root_dir = tmp_path / "root"
    child_dir = root_dir / "subagents"
    child_dir.mkdir(parents=True)
    child_id = "123e4567-e89b-12d3-a456-426614174000"
    root_path = root_dir / "root.jsonl"
    inline = [
        {"type": "cost-state", "totalLinesAdded": 10, "totalLinesRemoved": 1, "totalDuration": 100},
        {
            "type": "assistant",
            "uuid": "r",
            "message": {"content": [{"type": "tool_use", "id": "root-call", "name": "Read", "input": {}}]},
        },
        {
            "type": "assistant",
            "uuid": "c",
            "isSidechain": True,
            "agentId": child_id,
            "message": {
                "content": [
                    {"type": "tool_use", "id": "child-call", "name": "Bash", "input": {"command": "echo child"}}
                ]
            },
        },
        {
            "type": "user",
            "uuid": "cr",
            "isSidechain": True,
            "agentId": child_id,
            "message": {"content": [{"type": "tool_result", "tool_use_id": "child-call", "content": "child"}]},
        },
        {
            "type": "cost-state",
            "totalLinesAdded": 4,
            "totalLinesRemoved": 0,
            "totalDuration": 40,
            "isSidechain": True,
            "agentId": child_id,
        },
    ]
    root_path.write_text("\n".join(json.dumps(item) for item in inline) + "\n")
    child_path = child_dir / f"agent-{child_id}.jsonl"
    child_records = [
        {"type": "cost-state", "totalLinesAdded": 4, "totalLinesRemoved": 0, "totalDuration": 40},
        {
            "type": "assistant",
            "uuid": "sc",
            "message": {
                "content": [
                    {"type": "tool_use", "id": "child-call", "name": "Bash", "input": {"command": "echo child"}}
                ]
            },
        },
        {
            "type": "user",
            "uuid": "scr",
            "message": {"content": [{"type": "tool_result", "tool_use_id": "child-call", "content": "child"}]},
        },
    ]
    child_path.write_text("\n".join(json.dumps(item) for item in child_records) + "\n")
    for source_path in (child_path, root_path) if child_first else (root_path, child_path):
        merge_capture(capture_claude_source(source_path))
    item = index_payload()["sessions"][0]
    child = next(agent for agent in item["agents"] if agent["session_id"] == child_id)
    assert item["native"]["children"]["tool_calls"] == 1
    assert item["native"]["children"]["lines_added"] == 4
    assert len(item["agents"]) == 1
    assert child["native"]["own"]["lines_added"] == 4
    assert child["native"]["own"]["tool_calls"] == 1


def test_separate_child_source_legacy_pr_without_change_evidence_is_retained(tmp_data_home):
    fingerprint = SourceFingerprint(None, None, 0, 1, "p", "b")
    root = RootResolution("claude-code", "legacy-root", "legacy-root", None, "root")
    source = SourceInput(
        "source:legacy-root", "claude-code", "legacy-root", "epoch:legacy-root", 0, 0, 0, fingerprint, "active"
    )
    merge_capture(
        CaptureBatch(
            1,
            "2026-01-01T00:00:00Z",
            root,
            source,
            (RunInput("run:legacy-root", "legacy-root", "root", None, None, (), None, None, (), 0, 0, 0, None),),
        )
    )
    child_root = RootResolution("claude-code", "legacy-child", "legacy-root", "legacy-root", "child")
    child_source = SourceInput(
        "source:legacy-child", "claude-code", "legacy-child", "epoch:legacy-child", 0, 0, 0, fingerprint, "active"
    )
    child_run = RunInput(
        "run:legacy-child", "legacy-child", "child", "run:legacy-root", "agent", (), None, None, (), 0, 0, 0, None
    )
    pr = PrInput(
        "pr:legacy",
        "epoch:legacy-child",
        "event:legacy-pr",
        "acme/repo",
        8,
        "https://github.com/acme/repo/pull/8",
        "created",
        "2026-01-01T00:00:01Z",
    )
    other = replace(
        pr,
        pr_id="pr:other",
        source_event_id="event:other-pr",
        number=9,
        url="https://github.com/acme/repo/pull/9",
        evidenced_at="2026-01-01T00:00:02Z",
    )
    event = EventInput(
        "event:other-pr",
        "epoch:legacy-child",
        "other-pr",
        "2026-01-01T00:00:02Z",
        "pr_link",
        "digest",
        "run:grandchild",
    )
    grandchild = RunInput("run:grandchild", "grandchild", "grandchild", child_run.run_id, "agent", (), None, None)
    merge_capture(
        CaptureBatch(
            2,
            "2026-01-01T00:00:02Z",
            child_root,
            child_source,
            (child_run, grandchild),
            prs=(pr, other),
            events=(event,),
        )
    )
    item = index_payload()["sessions"][0]
    child = next(agent for agent in item["agents"] if agent["session_id"] == "legacy-child")
    assert child["latest_pr"]["number"] == 8
    assert [item["number"] for item in child["prs"]] == [8]
    assert item["latest_pr"]["number"] == 9


def test_same_short_child_id_is_isolated_between_root_sessions(tmp_data_home, tmp_path):
    for root_id, amount in (("root-one", 11), ("root-two", 29)):
        path = tmp_path / f"{root_id}.jsonl"
        record = {
            "type": "assistant",
            "uuid": "record-child",
            "isSidechain": True,
            "agentId": "short-child",
            "message": {
                "id": "same-native-message",
                "model": "fixture-model",
                "usage": {"input_tokens": amount},
                "content": [
                    {
                        "type": "tool_use",
                        "id": "same-native-call",
                        "name": "Bash",
                        "input": {"command": f"echo {root_id}"},
                    }
                ],
            },
        }
        path.write_text(json.dumps(record) + "\n")
        merge_capture(capture_claude_source(path))
    items = {item["session_id"]: item for item in index_payload()["sessions"]}
    assert len(items["root-one"]["agents"]) == 1
    assert len(items["root-two"]["agents"]) == 1
    first = items["root-one"]["agents"][0]
    second = items["root-two"]["agents"][0]
    assert first["run_id"] != second["run_id"]
    assert first["scopes"]["own"]["tokens"]["input"] == 11
    assert second["scopes"]["own"]["tokens"]["input"] == 29


def test_dedicated_children_with_same_filename_keep_roots_and_body_access_isolated(tmp_data_home, tmp_path):
    roots = []
    for root_id, amount in (("dedicated-one", 11), ("dedicated-two", 29)):
        root = tmp_path / f"{root_id}.jsonl"
        root.write_text("{}\n")
        merge_capture(capture_claude_source(root))
        path = tmp_path / root_id / "subagents" / "agent-short-child.jsonl"
        path.parent.mkdir(parents=True)
        record = {
            "type": "assistant",
            "uuid": "same-record",
            "message": {
                "id": "same-message",
                "usage": {"input_tokens": amount},
                "content": [
                    {"type": "tool_use", "id": "same-call", "name": "Bash", "input": {"command": f"echo {root_id}"}}
                ],
            },
        }
        path.write_text(json.dumps(record) + "\n")
        merge_capture(capture_claude_source(path))
        roots.append(root_id)
    items = {item["session_id"]: item for item in index_payload()["sessions"]}
    for root, total in zip(roots, (11, 29)):
        assert len(items[root]["agents"]) == 1
        assert items[root]["scopes"]["children"]["tokens"]["total"] == total
    with InspectionStore.open() as store:
        own = store.inspection_payload("claude-code", roots[1], view="tools")["items"]
        assert len(own) == 1
        body_id = own[0]["input_parts"][0]["body_id"]
        assert store.body_access_for_session("claude-code", roots[1], body_id)[0] == "available"
        assert store.body_access_for_session("claude-code", roots[0], body_id)[0] == "unavailable"
