"""Public scan/persist/read retention journeys for Usage inspection."""

from __future__ import annotations

import base64
import json
import os
from datetime import datetime, timezone
from pathlib import Path

import yaml

from skill_hub import hub_core
from skill_hub.application.usage import usage_inspection
from skill_hub.infrastructure.usage import usage_scan

CLAUDE_SESSION = "aaaaaaaa-1111-4111-8111-111111111111"
CODEX_SESSION = "bbbbbbbb-2222-4222-8222-222222222222"
CODEX_CHILD = "cccccccc-3333-4333-8333-333333333333"


def _seed_project(tmp_path: Path) -> Path:
    project = tmp_path / "project"
    project.mkdir()
    (hub_core.data_home() / "registry.yaml").write_text(
        yaml.safe_dump({"projects": {"synthetic": {"path": str(project)}}, "skills": {}})
    )
    return project


def _write_jsonl(path: Path, records: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(json.dumps(record, ensure_ascii=False) for record in records) + "\n")


def _scan(harness: str) -> dict:
    return usage_scan.scan_sessions(
        harness=harness,
        now=datetime(2026, 1, 10, tzinfo=timezone.utc),
    )


def _claude_assistant(
    timestamp: str,
    message_id: str,
    content: list[dict],
    *,
    usage: dict | None = None,
) -> dict:
    message = {
        "id": message_id,
        "model": "claude-sonnet-5",
        "role": "assistant",
        "type": "message",
        "content": content,
    }
    if usage is not None:
        message["usage"] = usage
    return {
        "type": "assistant",
        "uuid": f"uuid-{message_id}",
        "timestamp": timestamp,
        "sessionId": CLAUDE_SESSION,
        "isSidechain": False,
        "message": message,
    }


def _claude_result(timestamp: str, native_call_id: str, output: str) -> dict:
    return {
        "type": "user",
        "uuid": f"result-{native_call_id}-{timestamp}",
        "timestamp": timestamp,
        "sessionId": CLAUDE_SESSION,
        "isSidechain": False,
        "message": {
            "role": "user",
            "content": [{"type": "tool_result", "tool_use_id": native_call_id, "content": output}],
        },
    }


def _codex_meta(
    session_id: str,
    project: Path,
    *,
    parent: str | None = None,
    nested_spawn: bool = False,
) -> dict:
    payload: dict = {"id": session_id, "cwd": str(project)}
    if parent is not None:
        if nested_spawn:
            payload["source"] = {
                "subagent": {"thread_spawn": {"parent_thread_id": parent, "thread_id": session_id}}
            }
        else:
            payload["parent_thread_id"] = parent
    return {"timestamp": "2026-01-01T00:00:00Z", "type": "session_meta", "payload": payload}


def _codex_token(
    timestamp: str,
    response_id: str,
    session_id: str,
    *,
    input_tokens: int,
    output_tokens: int,
    cached_input_tokens: int,
    total_tokens: int,
) -> dict:
    return {
        "timestamp": timestamp,
        "type": "event_msg",
        "payload": {
            "id": f"token-{response_id}",
            "type": "token_count",
            "thread_id": session_id,
            "info": {
                "total_token_usage": {
                    "input_tokens": input_tokens,
                    "output_tokens": output_tokens,
                    "cached_input_tokens": cached_input_tokens,
                    "cache_write_input_tokens": 0,
                    "total_tokens": total_tokens,
                }
            },
        },
    }


def _codex_call(
    timestamp: str,
    call_id: str,
    command: str,
    output: str | None = None,
) -> list[dict]:
    records = [
        {
            "timestamp": timestamp,
            "type": "response_item",
            "payload": {
                "type": "function_call",
                "call_id": call_id,
                "name": "shell",
                "arguments": json.dumps({"command": command}, ensure_ascii=False),
            },
        }
    ]
    if output is not None:
        records.append(
            {
                "timestamp": timestamp,
                "type": "response_item",
                "payload": {
                    "type": "function_call_output",
                    "call_id": call_id,
                    "output": output,
                },
            }
        )
    return records


def _codex_output(timestamp: str, call_id: str, output: str) -> dict:
    return {
        "timestamp": timestamp,
        "type": "response_item",
        "payload": {"type": "function_call_output", "call_id": call_id, "output": output},
    }


def _rollout_path(session_id: str) -> Path:
    filename = f"rollout-2026-01-01T00-00-00-{session_id}.jsonl"
    return Path(os.environ["CODEX_HOME"]) / "sessions" / "2026" / "01" / "01" / filename


def _tokens(scope: dict) -> dict:
    return scope["tokens"]


def _own_total(harness: str, session_id: str) -> int:
    overview = usage_inspection.inspection_payload(harness, session_id, "overview")
    return _tokens(overview["session"]["summary"]["own"])["total"]


def _tool_items(harness: str, session_id: str) -> list[dict]:
    pages: list[dict] = []
    after = None
    while True:
        payload = usage_inspection.inspection_payload(harness, session_id, "tools", after=after)
        pages.extend(payload["items"])
        after = payload.get("next_after")
        if after is None:
            return pages


def _read_all_body(harness: str, session_id: str, body_id: str) -> bytes:
    chunks: list[bytes] = []
    after = None
    while True:
        payload = usage_inspection.read_body_for_session(harness, session_id, body_id, after, 1)
        assert payload["ok"] is True
        chunks.extend(base64.b64decode(chunk["base64"]) for chunk in payload["chunks"])
        after = payload["next_after_chunk"]
        if after is None:
            return b"".join(chunks)


def test_delayed_claude_and_codex_results_are_resumable_and_idempotent(tmp_data_home, tmp_path):
    project = _seed_project(tmp_path)
    claude_path = (
        Path(os.environ["SKILL_HUB_CLAUDE_HOME"])
        / "projects"
        / "synthetic"
        / f"{CLAUDE_SESSION}.jsonl"
    )
    claude_path.parent.mkdir(parents=True, exist_ok=True)
    _write_jsonl(
        claude_path,
        [
            _claude_assistant(
                "2026-01-01T00:00:00Z",
                "claude-message",
                [{"type": "tool_use", "id": "claude-call", "name": "Bash", "input": {"command": "printf first"}}],
                usage={
                    "input_tokens": 10,
                    "output_tokens": 5,
                    "cache_creation_input_tokens": 2,
                    "cache_read_input_tokens": 3,
                },
            )
        ],
    )
    codex_path = _rollout_path(CODEX_SESSION)
    _write_jsonl(
        codex_path,
        [
            _codex_meta(CODEX_SESSION, project),
            *_codex_call("2026-01-01T00:00:00Z", "codex-call", "printf first"),
            _codex_token(
                "2026-01-01T00:00:01Z",
                "codex-token-1",
                CODEX_SESSION,
                input_tokens=1000,
                output_tokens=100,
                cached_input_tokens=800,
                total_tokens=1100,
            ),
        ],
    )

    for harness, session_id in (("claude-code", CLAUDE_SESSION), ("codex", CODEX_SESSION)):
        first = _scan(harness)
        assert first["inspection"]["errors"] == []
        initial = usage_inspection.inspection_payload(harness, session_id, "overview")
        assert initial["ok"] is True
        initial_tools = _tool_items(harness, session_id)
        assert len(initial_tools) == 1
        assert initial_tools[0]["result_parts"] == []
        before_tokens = _tokens(initial["session"]["summary"]["own"])

        if harness == "claude-code":
            claude_path.write_text(
                claude_path.read_text()
                + json.dumps(_claude_result("2026-01-05T00:00:00Z", "claude-call", "delayed Claude output"))
                + "\n"
            )
        else:
            codex_path.write_text(
                codex_path.read_text()
                + "\n".join(
                    json.dumps(record, ensure_ascii=False)
                    for record in [
                        _codex_output("2026-01-05T00:00:00Z", "codex-call", "delayed Codex output"),
                        _codex_token(
                            "2026-01-05T00:00:01Z",
                            "codex-token-2",
                            CODEX_SESSION,
                            input_tokens=1300,
                            output_tokens=130,
                            cached_input_tokens=1000,
                            total_tokens=1430,
                        ),
                    ]
                )
                + "\n"
            )

        resumed = _scan(harness)
        assert resumed["inspection"]["errors"] == []
        updated = usage_inspection.inspection_payload(harness, session_id, "overview")
        updated_tools = _tool_items(harness, session_id)
        assert updated["ok"] is True
        assert len(updated_tools) == 1
        assert len(updated_tools[0]["result_parts"]) == 1
        expected_total = 20 if harness == "claude-code" else 1430
        assert _tokens(updated["session"]["summary"]["own"])["total"] == expected_total
        assert _tokens(updated["session"]["summary"]["own"])["total"] >= before_tokens["total"]

        replay = _scan(harness)
        assert replay["inspection"]["errors"] == []
        replayed = usage_inspection.inspection_payload(harness, session_id, "overview")
        assert replayed["session"]["summary"] == updated["session"]["summary"]
        assert _tool_items(harness, session_id) == updated_tools


def test_child_activity_updates_parent_subtree_and_survives_source_removal(tmp_data_home, tmp_path):
    project = _seed_project(tmp_path)
    parent_path = _rollout_path(CODEX_SESSION)
    child_path = _rollout_path(CODEX_CHILD)
    _write_jsonl(
        parent_path,
        [
            _codex_meta(CODEX_SESSION, project),
            _codex_token(
                "2026-01-01T00:00:01Z",
                "parent-token",
                CODEX_SESSION,
                input_tokens=1000,
                output_tokens=100,
                cached_input_tokens=800,
                total_tokens=1100,
            ),
        ],
    )
    _write_jsonl(
        child_path,
        [
            _codex_meta(CODEX_CHILD, project, parent=CODEX_SESSION, nested_spawn=True),
            *_codex_call("2026-01-01T00:00:02Z", "child-call", "printf child", "child output"),
            _codex_token(
                "2026-01-01T00:00:03Z",
                "child-token-1",
                CODEX_CHILD,
                input_tokens=200,
                output_tokens=20,
                cached_input_tokens=150,
                total_tokens=220,
            ),
        ],
    )
    _scan("codex")
    before = usage_inspection.inspection_payload("codex", CODEX_SESSION, "overview")
    assert before["ok"] is True
    child_run = next(run for run in before["runs"] if run["parent_id"] is not None)
    before_child = _tokens(child_run["scopes"]["own"])
    before_parent_subtree = _tokens(before["session"]["summary"]["subtree"])
    assert _tokens(before["session"]["summary"]["own"])["total"] == 1100
    assert before_child["total"] == 220
    assert before_parent_subtree["total"] == 1320

    with child_path.open("a") as handle:
        handle.write(
            json.dumps(
                _codex_token(
                    "2026-01-05T00:00:00Z",
                    "child-token-2",
                    CODEX_CHILD,
                    input_tokens=500,
                    output_tokens=50,
                    cached_input_tokens=400,
                    total_tokens=550,
                )
            )
            + "\n"
        )
    _scan("codex")
    _scan("codex")
    after = usage_inspection.inspection_payload("codex", CODEX_SESSION, "overview")
    child_after = next(run for run in after["runs"] if run["id"] == child_run["id"])
    assert _tokens(child_after["scopes"]["own"])["total"] == 550
    assert _tokens(after["session"]["summary"]["subtree"])["total"] == 1650

    body_id = after["tool_calls"]["items"][0]["result_parts"][0]["body_id"]
    parent_path.unlink()
    child_path.unlink()
    _scan("codex")
    retained = usage_inspection.read_body_for_session("codex", CODEX_SESSION, body_id)
    assert retained["ok"] is True
    assert base64.b64decode(retained["chunks"][0]["base64"]) == b"child output"
    assert usage_inspection.inspection_payload("codex", CODEX_SESSION, "overview")["evidence"]["status"] == "complete"


def test_more_than_500_tools_and_unicode_body_are_fully_retained_after_removal(tmp_data_home, tmp_path):
    project = _seed_project(tmp_path)
    path = _rollout_path(CODEX_SESSION)
    unicode_output = ("雪だるま ☃️ — café — \x00 — " * 3000).encode("utf-8")
    records = [_codex_meta(CODEX_SESSION, project)]
    for index in range(501):
        output = unicode_output.decode("utf-8") if index == 500 else f"output-{index}"
        records.extend(
            _codex_call(
                f"2026-01-01T00:00:{index % 60:02d}Z",
                f"bulk-{index:04d}",
                f"printf {index}",
                output,
            )
        )
    _write_jsonl(path, records)
    _scan("codex")

    items = _tool_items("codex", CODEX_SESSION)
    assert len(items) == 501
    assert len({item["id"] for item in items}) == 501
    target = next(item for item in items if "printf 500" in item["operation"]["summary"])
    body_id = target["result_parts"][0]["body_id"]
    assert _read_all_body("codex", CODEX_SESSION, body_id) == unicode_output

    path.unlink()
    assert _read_all_body("codex", CODEX_SESSION, body_id) == unicode_output


def test_reused_native_call_id_keeps_previous_evidence_and_collision_separate(tmp_data_home, tmp_path):
    project = _seed_project(tmp_path)
    path = _rollout_path(CODEX_SESSION)
    _write_jsonl(
        path,
        [
            _codex_meta(CODEX_SESSION, project),
            *_codex_call("2026-01-01T00:00:01Z", "reused", "printf one", "one"),
            _codex_token(
                "2026-01-01T00:00:02Z",
                "reused-token",
                CODEX_SESSION,
                input_tokens=100,
                output_tokens=10,
                cached_input_tokens=80,
                total_tokens=110,
            ),
        ],
    )
    _scan("codex")
    first = _tool_items("codex", CODEX_SESSION)
    assert len(first) == 1
    old_body = first[0]["result_parts"][0]["body_id"]
    first_total = _own_total("codex", CODEX_SESSION)

    _write_jsonl(
        path,
        [
            _codex_meta(CODEX_SESSION, project),
            *_codex_call("2026-01-02T00:00:01Z", "reused", "printf two", "two"),
            _codex_token(
                "2026-01-02T00:00:02Z",
                "reused-token",
                CODEX_SESSION,
                input_tokens=100,
                output_tokens=10,
                cached_input_tokens=80,
                total_tokens=110,
            ),
        ],
    )
    _scan("codex")
    replaced = _tool_items("codex", CODEX_SESSION)
    assert len(replaced) == 1
    assert replaced[0]["id"] != first[0]["id"]
    replaced_total = _own_total("codex", CODEX_SESSION)
    assert replaced_total == first_total
    assert _read_all_body("codex", CODEX_SESSION, old_body) == b"one"
    assert any("collision" in item["evidence"] for item in replaced)

    _scan("codex")
    replay = _tool_items("codex", CODEX_SESSION)
    assert len(replay) == 1
    assert _own_total("codex", CODEX_SESSION) == first_total
    assert {item["result_parts"][0]["body_id"] for item in replay} == {
        item["result_parts"][0]["body_id"] for item in replaced
    }
