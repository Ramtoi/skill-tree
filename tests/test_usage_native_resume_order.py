"""Native invocation order survives an output captured in a later chunk."""

import json

import pytest

from skill_hub.domain.usage.usage_inspection_capture import SourceCursor
from skill_hub.infrastructure.usage.usage_inspection_claude import capture_claude_source
from skill_hub.infrastructure.usage.usage_inspection_codex import capture_codex_source

SESSION = "aaaaaaaa-1111-4111-8111-111111111111"


@pytest.mark.parametrize("harness", ["claude-code", "codex"])
def test_later_result_preserves_invocation_position(tmp_path, harness):
    at = "2026-09-17T08:00:00Z"
    if harness == "claude-code":
        parser = capture_claude_source
        rows = [
            {"type": "user", "timestamp": at, "sessionId": SESSION, "message": {"content": "start"}},
            {"type": "assistant", "timestamp": at, "sessionId": SESSION, "message": {
                "role": "assistant", "content": [
                    {"type": "text", "text": "running"},
                    {"type": "tool_use", "id": "call", "name": "Bash", "input": {"command": "pwd"}},
                ],
            }},
        ]
        result = {"type": "user", "timestamp": at, "sessionId": SESSION, "message": {
            "content": [{"type": "tool_result", "tool_use_id": "call", "content": "done"}],
        }}
        expected = (1, 1)
    else:
        parser = capture_codex_source
        rows = [
            {"type": "session_meta", "timestamp": at, "payload": {"id": SESSION}},
            {"type": "function_call", "timestamp": at, "payload": {
                "call_id": "call", "name": "shell_command", "arguments": json.dumps({"command": "pwd"}),
            }},
        ]
        result = {"type": "function_call_output", "timestamp": at, "payload": {
            "call_id": "call", "output": "done",
        }}
        expected = (1, 0)
    path = tmp_path / f"{SESSION}.jsonl"
    path.write_text("".join(json.dumps(row) + "\n" for row in rows))
    first = parser(path)
    source = first.source
    cursor = SourceCursor(
        source.source_id, source.generation_id, 1, source.offset_end, source.fingerprint,
        source.committed_prefix_sha256, source.committed_boundary_sha256,
        source.resume_state, source.resume_version, source.reader_id,
        source.reader_revision, source.normalization_version,
    )
    with path.open("a") as stream:
        stream.write(json.dumps(result) + "\n")
    resumed = parser(path, cursor)
    assert resumed.source.offset_start == source.offset_end
    assert len(resumed.tool_calls) == 1
    call = resumed.tool_calls[0]
    assert call.execution == "completed"
    assert (call.source_ordinal, call.block_ordinal) == expected
    assert resumed.events[-1].source_ordinal == 2


def test_runtime_summary_items_do_not_invent_native_tool_calls(tmp_path):
    path = tmp_path / f"{SESSION}.jsonl"
    path.write_text(json.dumps({
        "type": "event_msg", "timestamp": "2026-09-17T08:00:00Z",
        "payload": {"type": "item", "item": {
            "type": "CommandExecution", "command": "cat file",
            "parsed_cmd": [{"type": "read", "path": "/repo/a"}, {"type": "read", "path": "/repo/b"}],
        }},
    }) + "\n")
    batch = capture_codex_source(path)
    assert batch.tool_calls == ()
    assert sum(seed.count for seed in batch.event_seeds if seed.kind == "activity" and seed.name == "read") == 2


def test_compaction_token_boundary_and_runtime_model_survive_wrapping(tmp_path):
    path = tmp_path / f"{SESSION}.jsonl"
    records = [
        {"type": "turn_context", "payload": {"turn_id": "turn", "model": "gpt-5.6"}},
        {"type": "compacted", "timestamp": "2026-09-17T08:00:00Z", "payload": {
            "turn_id": "turn", "latest_token_usage_record": {
                "response_id": "response", "thread_id": SESSION,
                "thread_token_usage": {"input_tokens": 20, "output_tokens": 5, "total_tokens": 25},
            },
        }},
        {"type": "response_item", "timestamp": "2026-09-17T08:00:01Z", "payload": {
            "type": "response.output_item.done", "item": {"type": "Extension", "name": "extension"},
        }},
        {"type": "event_msg", "timestamp": "2026-09-17T08:00:02Z", "payload": {
            "turn_id": "turn", "item": {"type": "ContextCompaction"},
        }},
    ]
    path.write_text("".join(json.dumps(row) + "\n" for row in records))
    batch = capture_codex_source(path)
    assert [(sample.input, sample.output, sample.epoch_marker) for sample in batch.token_samples] == [(20, 5, True)]
    assert [(seed.name, seed.model) for seed in batch.event_seeds if seed.kind == "tool"] == [("extension", "gpt-5.6")]
    assert sum(seed.kind == "compaction" for seed in batch.event_seeds) == 1


@pytest.mark.parametrize("creation,read", [
    ("cache_write_input_tokens", "cached_input_tokens"),
    ("cache_creation_input_tokens", "cache_read_input_tokens"),
])
def test_turn_token_cache_aliases_preserve_first_turn(tmp_path, creation, read):
    path = tmp_path / f"{SESSION}.jsonl"
    path.write_text(json.dumps({
        "type": "token_usage_record", "payload": {
            "response_id": "first", "usage": {"input_tokens": 100},
            "turn_token_usage": {"input_tokens": 10, creation: 3, read: 4},
        },
    }) + "\n")
    assert capture_codex_source(path).token_samples[0].first_turn_input_total == 17
