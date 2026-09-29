from __future__ import annotations

import json

import pytest

from skill_hub.application.usage.usage_inspection import merge_capture
from skill_hub.domain.usage.usage_inspection_capture import SourceCursor
from skill_hub.infrastructure.usage.usage_inspection_claude import capture_claude_source


def _write(path, records):
    path.write_text("\n".join(json.dumps(item) for item in records) + "\n")


@pytest.mark.parametrize("child_id", ["agent-short", "123e4567-e89b-12d3-a456-426614174000"])
def test_inline_and_dedicated_child_share_native_reference(tmp_path, child_id):
    root = tmp_path / "root.jsonl"
    child_record = {
        "type": "assistant", "uuid": "child-record", "isSidechain": True, "agentId": child_id,
        "message": {"content": [{"type": "tool_use", "id": "child-call", "name": "Read", "input": {"path": "x"}}]},
    }
    _write(root, [child_record])
    inline = capture_claude_source(root)
    child = next(run for run in inline.runs if run.native_ref)
    assert child.native_ref.root_session_id == "root"
    assert child.native_ref.native_id == child_id
    assert child.native_ref.origin == "inline_sidechain"

    dedicated = tmp_path / "root" / "subagents" / f"agent-{child_id}.jsonl"
    dedicated.parent.mkdir(parents=True)
    _write(dedicated, [{**child_record, "isSidechain": False, "agentId": None}])
    source_run = capture_claude_source(dedicated).runs[0]
    assert source_run.native_ref.root_session_id == "root"
    assert source_run.native_ref.native_id == child_id
    assert source_run.native_ref.origin == "source"
    dedicated_call = capture_claude_source(dedicated).tool_calls[0]
    assert inline.tool_calls[0].input_parts[0].mirror_part_key == dedicated_call.input_parts[0].mirror_part_key


def test_sample_keys_use_message_id_uuid_then_ordinal(tmp_path):
    path = tmp_path / "samples.jsonl"
    _write(
        path,
        [
            {"type": "assistant", "uuid": "record-1", "message": {"id": "message-1", "usage": {"input_tokens": 1}}},
            {"type": "assistant", "uuid": "record-2", "message": {"usage": {"input_tokens": 2}}},
            {"type": "assistant", "message": {"usage": {"input_tokens": 3}}},
        ],
    )
    samples = capture_claude_source(path).token_samples
    assert [sample.native_sample_key for sample in samples] == ["message:message-1", "record:record-2", "ordinal:2"]


@pytest.mark.parametrize("invalid", ["/secret/path", "bad\\path", "bad id", "a" * 121])
def test_invalid_agent_id_has_no_native_reference(tmp_path, invalid):
    path = tmp_path / "invalid.jsonl"
    _write(path, [{"type": "assistant", "isSidechain": True, "agentId": invalid, "message": {"content": []}}])
    assert all(run.native_ref is None for run in capture_claude_source(path).runs)


def test_mirror_keys_follow_record_identity_and_body_role(tmp_path):
    records = [
        {"type": "assistant", "uuid": "same-record", "message": {"content": [
            {"type": "tool_use", "id": "call", "name": "Read", "input": {"path": "x"}},
        ]}},
        {"type": "user", "uuid": "same-result", "message": {"content": [
            {"type": "tool_result", "tool_use_id": "call", "content": "ok"},
        ]}},
    ]
    first, second = tmp_path / "first.jsonl", tmp_path / "second.jsonl"
    _write(first, records)
    _write(second, records)
    a, b = capture_claude_source(first).tool_calls[0], capture_claude_source(second).tool_calls[0]
    assert a.input_parts[0].mirror_part_key == b.input_parts[0].mirror_part_key
    assert a.result_parts[0].mirror_part_key == b.result_parts[0].mirror_part_key
    assert a.input_parts[0].mirror_part_key != a.result_parts[0].mirror_part_key

    missing = tmp_path / "missing.jsonl"
    _write(missing, [{"type": "assistant", "message": {"content": [
        {"type": "tool_use", "id": "call", "name": "Read", "input": {"path": "x"}},
    ]}}])
    assert capture_claude_source(missing).tool_calls[0].input_parts[0].mirror_part_key is None


def test_append_recovers_inline_child_reference_from_resume(tmp_data_home, tmp_path):
    path = tmp_path / "resume.jsonl"
    first = {
        "type": "assistant",
        "isSidechain": True,
        "agentId": "agent-late",
        "message": {"content": [{"type": "tool_use", "id": "late", "name": "Read", "input": {}}]},
    }
    _write(path, [first])
    batch = capture_claude_source(path)
    late = {
        "type": "user",
        "message": {"content": [{"type": "tool_result", "tool_use_id": "late", "content": "ok"}]},
    }
    merge_capture(batch)
    path.write_text(path.read_text() + json.dumps(late) + "\n")
    cursor = SourceCursor(
        batch.source.source_id,
        batch.source.generation_id,
        batch.source.expected_revision + 1,
        batch.source.offset_end,
        batch.source.fingerprint,
        batch.source.committed_prefix_sha256,
        batch.source.committed_boundary_sha256,
        batch.source.resume_state,
        batch.source.resume_version,
        batch.source.reader_id,
        batch.source.reader_revision,
        batch.source.normalization_version,
    )
    resumed = capture_claude_source(path, cursor)
    assert resumed.source.offset_start == batch.source.offset_end
    child = next(run for run in resumed.runs if run.native_ref)
    assert child.native_ref.native_id == "agent-late"
    assert child.native_ref.origin == "inline_sidechain"
    assert resumed.tool_calls[0].run_id == child.run_id
    assert resumed.tool_calls[0].result_parts


def test_unprefixed_child_filename_has_no_inferred_native_reference(tmp_path):
    path = tmp_path / "root" / "subagents" / "short-child.jsonl"
    path.parent.mkdir(parents=True)
    _write(path, [])
    assert all(run.native_ref is None for run in capture_claude_source(path).runs)
