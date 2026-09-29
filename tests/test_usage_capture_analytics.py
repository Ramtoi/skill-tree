"""Durable capture analytics are ordered and contain no raw excerpts."""

from __future__ import annotations

import json
from pathlib import Path

from skill_hub.application.usage.usage_capture_enrichment import CaptureEnrichmentContext, enrich_capture_batch
from skill_hub.infrastructure.usage.usage_inspection_claude import capture_claude_source
from skill_hub.infrastructure.usage.usage_inspection_codex import capture_codex_source
from skill_hub.infrastructure.usage.usage_inspection_store import InspectionStore

SESSION = "aaaaaaaa-1111-4111-8111-111111111111"


def test_claude_messages_and_seeds_persist_in_native_order(tmp_data_home, tmp_path: Path):
    path = tmp_path / f"{SESSION}.jsonl"
    rows = [
        {
            "type": "user",
            "timestamp": "2026-09-17T08:00:00Z",
            "sessionId": SESSION,
            "message": {"role": "user", "content": "token Bearer abcdefghijkl"},
        },
        {
            "type": "assistant",
            "timestamp": "2026-09-17T08:00:00Z",
            "sessionId": SESSION,
            "message": {
                "id": "one",
                "role": "assistant",
                "content": [
                    {"type": "text", "text": "ok"},
                    {"type": "tool_use", "id": "call", "name": "Read", "input": {"file_path": "/private/a.py"}},
                ],
                "usage": {"input_tokens": 3},
            },
        },
    ]
    path.write_text("".join(json.dumps(row) + "\n" for row in rows))
    batch = enrich_capture_batch(capture_claude_source(path), CaptureEnrichmentContext.empty())
    with InspectionStore.open() as store:
        store.merge_capture(batch)
        messages = store.db.execute(
            "SELECT source_ordinal,excerpt FROM messages ORDER BY source_ordinal,block_ordinal,role_ordinal"
        ).fetchall()
        tool = store.db.execute("SELECT activity_class,read_file_hash FROM tool_calls").fetchone()
        assert [row[0] for row in messages] == [0, 1]
        assert "abcdefghijkl" not in messages[0][1]
        assert tool[0] == "read" and tool[1].startswith("path:")


def test_codex_token_only_capture_uses_a_token_first_turn_carrier(tmp_data_home, tmp_path: Path):
    path = tmp_path / f"rollout-{SESSION}.jsonl"
    path.write_text(
        json.dumps(
            {
                "type": "token_usage_record",
                "timestamp": "2026-09-17T08:00:00Z",
                "payload": {"thread_token_usage": {"input_tokens": 11, "cache_write_input_tokens": 2}},
            }
        )
        + "\n"
    )
    batch = capture_codex_source(path)
    assert batch.messages == ()
    assert batch.token_samples[0].first_turn_input_total == 13


def test_codex_event_mirror_only_carries_first_turn_once(tmp_path: Path):
    path = tmp_path / f"rollout-{SESSION}.jsonl"
    path.write_text(
        json.dumps(
            {
                "type": "event_msg",
                "timestamp": "2026-09-17T08:00:00Z",
                "payload": {
                    "type": "token_count",
                    "info": {"total_token_usage": {"input_tokens": 7, "cached_input_tokens": 3}},
                },
            }
        )
        + "\n"
    )
    batch = capture_codex_source(path)
    assert [(sample.origin, sample.first_turn_input_total) for sample in batch.token_samples] == [("event_mirror", 10)]


def test_project_context_classifies_project_verify_prefix(tmp_path: Path):
    path = tmp_path / f"{SESSION}.jsonl"
    project = tmp_path / "project"
    project.mkdir()
    path.write_text(
        json.dumps(
            {
                "type": "assistant",
                "timestamp": "2026-09-17T08:00:00Z",
                "sessionId": SESSION,
                "cwd": str(project),
                "message": {
                    "role": "assistant",
                    "content": [
                        {"type": "tool_use", "id": "verify", "name": "Bash", "input": {"command": "custom-verify"}}
                    ],
                },
            }
        )
        + "\n"
    )
    batch = enrich_capture_batch(
        capture_claude_source(path),
        CaptureEnrichmentContext.from_registry(
            {"projects": {"project": {"path": str(project), "analytics": {"verify_prefixes": ["custom-verify"]}}}}
        ),
    )
    assert batch.source.project_key == "project"
    assert batch.source.working_directory_hint is None
    assert batch.tool_calls[0].activity_class == "verify"


def test_claude_user_records_skip_tool_results_and_keep_text_and_command(tmp_path: Path):
    path = tmp_path / f"{SESSION}.jsonl"
    rows = [
        {
            "type": "user",
            "timestamp": "2026-09-17T08:00:00Z",
            "sessionId": SESSION,
            "message": {"content": [{"type": "tool_result", "tool_use_id": "call", "content": "ignored"}]},
        },
        {
            "type": "user",
            "timestamp": "2026-09-17T08:00:01Z",
            "sessionId": SESSION,
            "stackedExpansion": True,
            "message": {"content": [{"type": "text", "text": "first "}, {"type": "text", "text": "second"}]},
        },
        {
            "type": "user",
            "timestamp": "2026-09-17T08:00:02Z",
            "sessionId": SESSION,
            "message": {"content": "<command-name>/compact</command-name> compact now"},
        },
    ]
    path.write_text("".join(json.dumps(row) + "\n" for row in rows))
    batch = enrich_capture_batch(capture_claude_source(path), CaptureEnrichmentContext.empty())
    assert [(message.text_len, message.stacked, message.kind) for message in batch.messages] == [
        (6, True, "human_turn"),
        (49, False, "slash_command"),
    ]
    assert [seed.kind for seed in batch.event_seeds] == ["human_turn", "slash_command", "compaction"]


def test_long_native_command_is_classified_before_body_retention(tmp_data_home, tmp_path: Path):
    path = tmp_path / f"rollout-{SESSION}.jsonl"
    command = "pytest " + "x" * 20_000
    path.write_text(
        json.dumps(
            {
                "type": "function_call",
                "timestamp": "2026-09-17T08:00:00Z",
                "payload": {"call_id": "call", "name": "shell_command", "arguments": json.dumps({"command": command})},
            }
        )
        + "\n"
    )
    batch = enrich_capture_batch(capture_codex_source(path), CaptureEnrichmentContext.empty())
    assert batch.tool_calls[0].activity_class == "verify"
    with InspectionStore.open() as store:
        store.merge_capture(batch)
        assert store.db.execute("SELECT activity_class FROM tool_calls").fetchone()[0] == "verify"


def test_context_snapshots_registry_and_emits_child_invocation(tmp_path: Path):
    project = tmp_path / "project"
    project.mkdir()
    registry = {"projects": {"project": {"path": str(project)}}, "skills": {}}
    context = CaptureEnrichmentContext.from_registry(registry)
    registry["projects"]["project"]["analytics"] = {"verify_prefixes": ["mutated"]}
    assert "project" in context.registry["projects"]
    assert any(root.is_relative_to(project) for root in context.skill_roots)
    path = tmp_path / f"{SESSION}.jsonl"
    path.write_text(
        json.dumps(
            {
                "type": "assistant",
                "timestamp": "2026-09-17T08:00:00Z",
                "sessionId": SESSION,
                "message": {
                    "role": "assistant",
                    "content": [
                        {"type": "tool_use", "id": "agent", "name": "Agent", "input": {"subagent_type": "review"}}
                    ],
                },
            }
        )
        + "\n"
    )
    batch = enrich_capture_batch(capture_claude_source(path), context)
    assert [(seed.kind, seed.name) for seed in batch.event_seeds] == [("child_invocation", "review")]


def test_codex_user_skill_mentions_persist_registered_keys_and_safe_count(tmp_path: Path):
    path = tmp_path / f"rollout-{SESSION}.jsonl"
    text = "skills/alpha/SKILL.md skills/alpha/ skills/private-name/"
    path.write_text(
        json.dumps(
            {
                "type": "event_msg",
                "timestamp": "2026-09-17T08:00:00Z",
                "payload": {"type": "user_message", "message": text},
            }
        )
        + "\n"
    )
    batch = enrich_capture_batch(
        capture_codex_source(path), CaptureEnrichmentContext.from_registry({"skills": {"alpha": {}}})
    )
    facts = [(seed.kind, seed.name, seed.invoker, seed.count) for seed in batch.event_seeds]
    assert ("skill_mentions", None, "user", 2) in facts
    assert ("skill", "alpha", "user", 1) in facts
    assert all(seed.name != "private-name" for seed in batch.event_seeds)


def test_codex_late_user_skill_mentions_are_classified_before_excerpt_redaction(tmp_data_home, tmp_path: Path):
    path = tmp_path / f"rollout-{SESSION}.jsonl"
    raw_text = "x" * 250 + " /private/skills/alpha/SKILL.md skills/unregistered/"
    path.write_text(
        json.dumps(
            {
                "type": "event_msg",
                "timestamp": "2026-09-17T08:00:00Z",
                "payload": {"type": "user_message", "message": raw_text},
            }
        )
        + "\n"
    )
    batch = enrich_capture_batch(
        capture_codex_source(path), CaptureEnrichmentContext.from_registry({"skills": {"alpha": {}}})
    )
    assert ("skill_mentions", None, "user", 2) in [
        (seed.kind, seed.name, seed.invoker, seed.count) for seed in batch.event_seeds
    ]
    assert ("skill", "alpha") in [(seed.kind, seed.name) for seed in batch.event_seeds]
    assert all("unregistered" not in (seed.name or "") for seed in batch.event_seeds)
    assert all("/private/" not in message.excerpt for message in batch.messages)
    assert all(message.excerpt_hint is None for message in batch.messages)
    with InspectionStore.open() as store:
        store.merge_capture(batch)
        persisted = store.db.execute("SELECT excerpt FROM messages").fetchone()[0]
        names = [row[0] for row in store.db.execute("SELECT name FROM summary_event_seeds")]
    assert "/private/" not in persisted and "unregistered" not in persisted
    assert all("unregistered" not in (name or "") for name in names)


def test_claude_user_legacy_edge_shapes(tmp_path: Path):
    path = tmp_path / f"{SESSION}.jsonl"
    rows = [
        {
            "type": "user",
            "timestamp": "2026-09-17T08:00:00Z",
            "sessionId": SESSION,
            "isMeta": "true",
            "message": {"content": "skip"},
        },
        {
            "type": "user",
            "timestamp": "2026-09-17T08:00:01Z",
            "sessionId": SESSION,
            "message": {"content": [{"type": "image"}]},
        },
        {
            "type": "user",
            "timestamp": "2026-09-17T08:00:02Z",
            "sessionId": SESSION,
            "message": {"content": [{"type": "text", "text": "<command-name>/compact</command-name>"}]},
        },
        {
            "type": "user",
            "timestamp": "2026-09-17T08:00:03Z",
            "sessionId": SESSION,
            "toolUseResult": {},
            "message": {"content": [{"type": "text", "text": "skip result"}]},
        },
    ]
    path.write_text("".join(json.dumps(row) + "\n" for row in rows))
    batch = capture_claude_source(path)
    assert [(message.kind, message.text_len) for message in batch.messages] == [("human_turn", 0), ("human_turn", 37)]
    assert [seed.kind for seed in batch.event_seeds] == ["human_turn", "human_turn"]


def test_codex_reasoning_and_mcp_item_have_durable_safe_facts(tmp_path: Path):
    path = tmp_path / f"rollout-{SESSION}.jsonl"
    rows = [
        {
            "type": "token_usage_record",
            "timestamp": "2026-09-17T08:00:00Z",
            "payload": {"usage": {"input_tokens": 2}, "reasoning_output_tokens": 9},
        },
        {
            "type": "event_msg",
            "timestamp": "2026-09-17T08:00:01Z",
            "payload": {"type": "item", "item": {"type": "McpToolCall", "server": "touchpoint", "tool": "get_goal"}},
        },
    ]
    path.write_text("".join(json.dumps(row) + "\n" for row in rows))
    batch = enrich_capture_batch(capture_codex_source(path), CaptureEnrichmentContext.empty())
    assert ("thinking", 9) in [(seed.kind, seed.count) for seed in batch.event_seeds]
    assert batch.tool_calls == ()
    assert ("activity", "external") in [(seed.kind, seed.name) for seed in batch.event_seeds]
    assert ("tool", "touchpoint/get_goal") in [(seed.kind, seed.name) for seed in batch.event_seeds]


def test_claude_confirmed_subagent_seed_has_type_and_resolved_model(tmp_path: Path):
    path = tmp_path / f"{SESSION}.jsonl"
    rows = [
        {
            "type": "assistant",
            "timestamp": "2026-09-17T08:00:00Z",
            "sessionId": SESSION,
            "message": {
                "role": "assistant",
                "content": [{"type": "tool_use", "id": "agent", "name": "Agent", "input": {"subagent_type": "review"}}],
            },
        },
        {
            "type": "user",
            "timestamp": "2026-09-17T08:00:01Z",
            "sessionId": SESSION,
            "toolUseResult": {"agentId": "child", "resolvedModel": "claude-sonnet"},
            "message": {"content": [{"type": "tool_result", "tool_use_id": "agent", "content": "done"}]},
        },
    ]
    path.write_text("".join(json.dumps(row) + "\n" for row in rows))
    batch = capture_claude_source(path)
    assert ("subagent", "review", "claude-sonnet") in [(seed.kind, seed.name, seed.model) for seed in batch.event_seeds]


def test_codex_runtime_items_capture_legacy_structural_facts(tmp_path: Path):
    path = tmp_path / f"rollout-{SESSION}.jsonl"

    def event(item, at):
        return {"type": "event_msg", "timestamp": at, "payload": {"type": "item", "item": item}}

    rows = [
        event(
            {
                "type": "CommandExecution",
                "command": "ignored",
                "parsed_cmd": [{"type": "read", "path": "/repo/a"}, {"type": "other"}],
            },
            "2026-09-17T08:00:00Z",
        ),
        event({"type": "FileChange", "changes": {"/repo/b": {}}}, "2026-09-17T08:00:01Z"),
        event({"type": "ImageView"}, "2026-09-17T08:00:02Z"),
        event({"type": "Extension"}, "2026-09-17T08:00:03Z"),
        event({"type": "SubAgentActivity", "name": "worker"}, "2026-09-17T08:00:04Z"),
        event({"type": "CollabAgentToolCall", "name": "peer"}, "2026-09-17T08:00:05Z"),
        event({"type": "ContextCompaction"}, "2026-09-17T08:00:06Z"),
        {
            "type": "response_item",
            "timestamp": "2026-09-17T08:00:07Z",
            "payload": {"item": {"type": "Extension", "name": "response-extension"}},
        },
    ]
    path.write_text("".join(json.dumps(row) + "\n" for row in rows))
    batch = enrich_capture_batch(capture_codex_source(path), CaptureEnrichmentContext.empty())
    activity = [seed.name for seed in batch.event_seeds if seed.kind == "activity"]
    assert activity.count("read") == 2 and activity.count("edit") == 1
    assert activity.count("operate") == 3 and activity.count("delegate") == 2
    assert any(seed.kind == "read_file" and seed.name.startswith("path:") for seed in batch.event_seeds)
    assert ("edit_file", "path:" + __import__("hashlib").sha256(b"/repo/b").hexdigest()) in [
        (seed.kind, seed.name) for seed in batch.event_seeds
    ]
    assert [seed.kind for seed in batch.event_seeds].count("compaction") == 1
    assert {"worker", "peer"} <= {seed.name for seed in batch.event_seeds if seed.kind == "tool"}
