"""Tests for the five new `hub usage …` CLI reads (`scan-sessions`,
`project`, `session`, `footprint`, `findings`) and `hub project analytics`
(usage-loadout-analytics wave 1, design D7) — the WIRING layer over the
three committed leaves (`usage_scan.py`, `usage_loadouts.py`,
`usage_footprint.py`).

This file tests marshalling: argparse wiring, exit codes, and payload key
shapes. The classification/composition/finding-detection LOGIC itself is
already unit-tested directly against those three leaves in their own test
files — this file never re-derives an expectation about THEIR behavior from
a code run; it only pins the CLI's own contract (D7: every read exits 0
with its verdict in the payload, never `_usage_fail`).

Every test sets `SKILL_HUB_NOW` via `monkeypatch.setenv` so the clock seam
(`usage_scan.now`) is fixed and every payload here is reproducible.
"""
# ruff: noqa: E501

from __future__ import annotations

import base64
import datetime as dt
import json
import os
import sys
from pathlib import Path
from types import SimpleNamespace

import yaml

import hub
from skill_hub import hub_core
from skill_hub.application.usage import usage_history
from skill_hub.entrypoints.cli import usage as usage_cli
from skill_hub.infrastructure.usage import usage_loadouts, usage_scan

NOW = "2026-09-07T12:00:00Z"
#: `usage_scan._iso` always renders millisecond precision on write, even
#: when `SKILL_HUB_NOW` (above) was set without it.
NOW_ISO = "2026-09-07T12:00:00.000Z"
SESSION_ID = "aaaaaaaa-2222-4222-8222-222222222222"
SESSION_STARTED = "2026-09-06T10:00:00.000Z"
SESSION_ENDED = "2026-09-06T10:45:00.000Z"

#: A session id + a FIXED, non-tmp-path `cwd` for the `scan-sessions` fixture
#: only: that payload's `bytes_read` counts the literal bytes of the
#: transcript line it reads, so the transcript content must never embed a
#: pytest tmp path — the checked-in fixture would then differ on every future
#: run's differently-named tmp directory. A `cwd` outside every registered
#: project resolves to the (harmless, path-free) "unregistered" bucket.
SCAN_SESSION_ID = "bbbbbbbb-3333-4333-8333-333333333333"
SCAN_SLUG_DIR = "-fixture-project"
SCAN_CWD = "/workspace/scratch"

#: The session id for the `session.json` fixture only (review finding R21):
#: a real scan of a rich transcript, kept separate from `SESSION_ID`'s
#: hand-seeded single-event scenario.
KINDS_SESSION_ID = "cccccccc-4444-4444-8444-444444444444"
CODEX_SESSION_ID = "dddddddd-5555-4555-8555-555555555555"

FIXTURE_DIR = Path(__file__).parent / "fixtures" / "usage"


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────


def _seed_registry(tmp_path: Path) -> Path:
    """Seed the project, detector marker and configured transcript directory."""
    # Installation detection still uses the declared default marker.
    (Path.home() / ".claude" / "projects").mkdir(parents=True, exist_ok=True)
    (Path(os.environ["SKILL_HUB_CLAUDE_HOME"]) / "projects").mkdir(parents=True, exist_ok=True)

    project_path = tmp_path / "alpha"
    project_path.mkdir(exist_ok=True)

    skill_src = hub_core.data_home() / "skills" / "brainstorm"
    skill_src.mkdir(parents=True, exist_ok=True)
    (skill_src / "SKILL.md").write_text(
        "---\nname: brainstorm\ndescription: brainstorm ideas\n---\nbody\n"
    )

    registry = {
        "version": "1",
        "harnesses_global": ["claude-code"],
        "skills": {
            "brainstorm": {
                "version": "1.0.0",
                "description": "brainstorm ideas",
                "source": str(skill_src),
                "type": "claude-skill",
                "scope": "portable",
            }
        },
        "projects": {
            "alpha": {
                "path": str(project_path),
                "enabled": ["brainstorm"],
                "bundles": [],
                "harnesses": [],
            }
        },
        "bundles": {},
    }
    (hub_core.data_home() / "registry.yaml").write_text(
        yaml.safe_dump(registry, sort_keys=False)
    )
    return project_path


def _session_row(*, harness: str = "claude-code", session_id: str = SESSION_ID) -> dict:
    """One fully-populated row matching design D2's schema exactly, written
    straight to the ledger — bypassing the scanner (already unit-tested in
    `tests/test_usage_scan.py`), so this file controls every field."""
    return {
        "schema_version": 1,
        "harness": harness,
        "session_id": session_id,
        "project": "alpha",
        "started_at": SESSION_STARTED,
        "last_activity_at": SESSION_ENDED,
        "frozen": False,
        "loadout_hash": None,
        "loadout_assumed": True,
        "tokens": {
            "input": 4,
            "output": 200,
            "cache_creation": 500,
            "cache_read": 9000,
            "total": 9704,
            "subagent_total": 0,
        },
        "first_turn_input_total": 9504,
        "cache_hit_ratio": 0.9,
        "steering_count": 2,
        "activity": {
            "read": 3,
            "edit": 1,
            "verify": 0,
            "operate": 1,
            "delegate": 0,
            "skill": 1,
            "external": 0,
        },
        "thinking_text_share": 0.1,
        "files_read": 4,
        "files_edited": 1,
        "tracked_files": None,
        "subagents": [],
        "skills": [{"key": "brainstorm", "invoker": "model", "count": 1}],
        "intent_excerpt": "help me ship this",
        "events": [
            {
                "kind": "human_turn",
                "at": SESSION_STARTED,
                "token_delta": 200,
                "tokens": {"input": 4, "output": 200, "cache_creation": 500, "cache_read": 9000},
                "thinking_len": 20,
                "output_text_len": 200,
                "name": None,
                "model": None,
                "invoker": "you",
                "excerpt": "help me ship this",
                "activity": {
                    "read": 3, "edit": 1, "verify": 0, "operate": 1,
                    "delegate": 0, "skill": 1, "external": 0,
                },
                "edited_without_verify": True,
            }
        ],
    }


def _write_rows(rows: list) -> None:
    path = usage_scan.sessions_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    text = "".join(json.dumps(r, sort_keys=True) + "\n" for r in rows)
    path.write_text(text)


def _write_loadout_rows(rows: list) -> None:
    path = usage_loadouts.loadouts_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(r, sort_keys=True) + "\n" for r in rows))


def _run(monkeypatch, capsys, *argv):
    """Drive the REAL parser — a wiring bug in argparse (a bad `dest`, a
    dropped elif) is invisible to a direct handler call (`hub_cli/AGENTS.md`)."""
    monkeypatch.setattr(sys, "argv", ["hub", *argv])
    hub.main()
    return capsys.readouterr().out


def _seed_scan_transcript() -> None:
    """One real, minimal transcript file for the `scan-sessions` payload
    fixture only — a fixed session id + a fixed `SCAN_CWD` (never a tmp
    path), so the file's byte length, and therefore `bytes_read`, is the
    same on every future run, not just within one run."""
    slug_dir = Path(os.environ["SKILL_HUB_CLAUDE_HOME"]) / "projects" / SCAN_SLUG_DIR
    slug_dir.mkdir(parents=True, exist_ok=True)
    records = [
        {
            "type": "user",
            "uuid": "u-1",
            "timestamp": "2026-09-06T10:00:00.000Z",
            "sessionId": SCAN_SESSION_ID,
            "cwd": SCAN_CWD,
            "isSidechain": False,
            "message": {"role": "user", "content": "Please help me ship this."},
            "isMeta": False,
        },
        {
            "type": "assistant",
            "uuid": "u-2",
            "timestamp": "2026-09-06T10:00:05.000Z",
            "sessionId": SCAN_SESSION_ID,
            "cwd": SCAN_CWD,
            "isSidechain": False,
            "message": {
                "id": "msg_1",
                "model": "claude-sonnet-5",
                "role": "assistant",
                "type": "message",
                "content": [
                    {"type": "text", "text": "Sure, I will help."},
                    {"type": "tool_use", "id": "toolu_skill", "name": "Skill", "input": {"skill": "brainstorm"}},
                    {"type": "tool_use", "id": "toolu_goals", "name": "mcp__touchpoint__list_goals", "input": {}},
                    {"type": "tool_use", "id": "toolu_goal", "name": "mcp__touchpoint__get_goal", "input": {}},
                ],
                "usage": {
                    "input_tokens": 2,
                    "output_tokens": 120,
                    "cache_creation_input_tokens": 400,
                    "cache_read_input_tokens": 800,
                },
            },
        },
    ]
    text = "\n".join(json.dumps(r) for r in records) + "\n"
    (slug_dir / f"{SCAN_SESSION_ID}.jsonl").write_text(text)


def _seed_codex_fixture_transcript(project_path: Path) -> None:
    root = Path(os.environ["CODEX_HOME"]) / "sessions" / "2026" / "09" / "07"
    root.mkdir(parents=True, exist_ok=True)
    skill_path = "/workspace/alpha/skills/brainstorm/SKILL.md"
    records = [
        {"timestamp": "2026-09-07T11:00:00.000Z", "type": "session_meta",
         "payload": {"id": CODEX_SESSION_ID, "cwd": str(project_path)}},
        {"timestamp": "2026-09-07T11:00:01.000Z", "type": "turn_context",
         "payload": {"turn_id": "turn-1", "model": "gpt-test", "cwd": str(project_path)}},
        {"timestamp": "2026-09-07T11:00:02.000Z", "type": "event_msg",
         "payload": {"type": "item_completed", "turn_id": "turn-1",
                      "item": {"type": "CommandExecution", "command": f"cat {skill_path}",
                               "parsed_cmd": [{"type": "read", "path": skill_path}]} }},
        {"timestamp": "2026-09-07T11:00:03.000Z", "type": "token_usage_record",
         "payload": {"response_id": "codex-r1", "thread_id": CODEX_SESSION_ID,
                      "turn_id": "turn-1", "usage": {"input_tokens": 3, "output_tokens": 12,
                      "total_tokens": 15}}},
    ]
    path = root / f"rollout-2026-09-07T11-00-00-{CODEX_SESSION_ID}.jsonl"
    path.write_text("\n".join(json.dumps(r) for r in records) + "\n")


def _seed_codex_inspection_transcript() -> None:
    session_id = SCAN_SESSION_ID
    root = Path(os.environ["CODEX_HOME"]) / "sessions" / "2026" / "09" / "07"
    root.mkdir(parents=True, exist_ok=True)
    records = [
        {"type": "session_meta", "timestamp": NOW_ISO, "payload": {"id": session_id, "cwd": SCAN_CWD}},
        {"type": "response_item", "timestamp": NOW_ISO, "payload": {
            "type": "function_call", "call_id": "fixture-call", "name": "shell",
            "arguments": "{\"command\":\"git status\"}",
        }},
        {"type": "response_item", "timestamp": NOW_ISO, "payload": {
            "type": "function_call_output", "call_id": "fixture-call", "output": "codex output",
        }},
    ]
    (root / f"rollout-{session_id}.jsonl").write_text("\n".join(json.dumps(record) for record in records) + "\n")


def _reset_scan_state() -> None:
    """Delete the sessions ledger + cursor sidecar so the next
    `scan-sessions` call is a genuine first (full) scan again — needed to
    prove the fixture is byte-identical across two INDEPENDENT full scans of
    the same unchanged transcript, since a real second scan over an
    unchanged cursor would report `files_scanned: 0` instead."""
    data_home = hub_core.data_home()
    (data_home / "state" / "usage" / "sessions.jsonl").unlink(missing_ok=True)
    (data_home / "state" / "usage" / "scan-cursor.json").unlink(missing_ok=True)
    (data_home / "state" / "usage" / "inspection.sqlite3").unlink(missing_ok=True)
    (data_home / "state" / "usage" / "inspection-retention.json").unlink(missing_ok=True)


# ─────────────────────────────────────────────────────────────────────────────
# hub usage scan-sessions
# ─────────────────────────────────────────────────────────────────────────────


def test_scan_sessions_json_shape(tmp_data_home, tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("SKILL_HUB_NOW", NOW)
    _seed_registry(tmp_path)

    out = _run(monkeypatch, capsys, "usage", "scan-sessions", "--json")
    payload = json.loads(out)

    assert payload["ok"] is True
    assert set(payload.keys()) == {
        "ok", "rows_written", "rows_frozen", "frozen_appended", "files_scanned",
        "files_skipped", "bytes_read", "sessions_unregistered", "stopped_on",
        "errors", "last_scan_at", "malformed_rows_dropped", "reparsed", "harnesses", "inspection",
    }
    assert payload["errors"] == []
    assert set(payload["harnesses"]) == {"claude-code", "codex"}
    assert set(payload["harnesses"]["claude-code"]) == {
        "files_scanned", "files_new", "files_appended", "files_replaced",
        "rows_written", "frozen_appended", "reparsed", "errors",
    }
    assert set(payload["harnesses"]["codex"]) == set(payload["harnesses"]["claude-code"])
    assert payload["stopped_on"] is None
    assert payload["last_scan_at"] == NOW_ISO
    assert payload["malformed_rows_dropped"] == 0


def test_scan_sessions_payload_fixture_matches_the_checked_in_file(
    tmp_data_home, tmp_path, monkeypatch, capsys
):
    """The fifth checked-in payload wave 2's mock needs (task 1.50 addendum):
    a real `scan-sessions` result over one minimal, fixed-content transcript.
    Two INDEPENDENT full scans (state reset between them — see
    `_reset_scan_state`) must be byte-identical before this is trusted as a
    fixture."""
    monkeypatch.setenv("SKILL_HUB_NOW", NOW)
    project_path = _seed_registry(tmp_path)
    _seed_scan_transcript()
    _seed_codex_fixture_transcript(project_path)

    first = _run(monkeypatch, capsys, "usage", "scan-sessions", "--json")
    _reset_scan_state()
    second = _run(monkeypatch, capsys, "usage", "scan-sessions", "--json")
    first_payload, second_payload = json.loads(first), json.loads(second)
    assert first_payload["inspection"]["scan_id"] != second_payload["inspection"]["scan_id"]
    # A pass identity is intentionally opaque and unique. All capture counts,
    # failures, completion states, and retention results remain deterministic.
    first_payload["inspection"]["scan_id"] = second_payload["inspection"]["scan_id"] = "<scan-id>"
    assert first_payload == second_payload

    payload = first_payload
    assert payload["ok"] is True
    assert payload["rows_written"] == 2
    assert payload["files_scanned"] == 2
    assert payload["sessions_unregistered"] == 1  # SCAN_CWD matches no registered project
    claude = json.loads(_run(monkeypatch, capsys, "usage", "session", SCAN_SESSION_ID, "--json"))
    assert {event["name"] for event in claude["events"] if event["kind"] == "tool"} == {
        "touchpoint/list_goals", "touchpoint/get_goal"
    }

    # `bytes_read` counts the seeded Codex rollout, which embeds
    # `str(project_path)` twice (its session cwd and its turn cwd), so the raw
    # number follows the pytest temp path's length and differs between a Mac
    # and the Linux CI runner. Pin the fixture to the path-independent part.
    stable = first_payload
    stable["bytes_read"] -= 2 * len(str(project_path))
    stable["inspection"]["bytes_read"] -= 2 * len(str(project_path))
    # SQLite page allocation is engine-dependent, unlike reclaimed body bytes.
    retention = stable["inspection"]["retention"]
    for field in ("physical_bytes_before", "physical_bytes_after", "logical_allocation_before", "logical_allocation_after"):
        assert isinstance(retention[field], int) and retention[field] > 0
        retention[field] = 0
    _compare_or_refresh_fixture("scan-sessions", json.dumps(stable, indent=2) + "\n")


def test_inspection_contract_fixture_matches_real_isolated_scan(tmp_data_home, tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("SKILL_HUB_NOW", NOW)
    _seed_registry(tmp_path)
    _seed_scan_transcript()
    _run(monkeypatch, capsys, "usage", "scan-sessions", "--json")
    from skill_hub.application.usage import usage_inspection

    expected = json.loads((FIXTURE_DIR / "inspection-session.json").read_text())
    index = usage_inspection.index_payload()
    assert index["ok"] is True
    assert set(index) == set(expected["index"])
    assert {
        "harness", "session_id", "root_session_id", "run_id", "scopes", "latest_pr", "pinned"
    } <= set(index["sessions"][0])
    session_id = index["sessions"][0]["session_id"]
    overview = usage_inspection.inspection_payload("claude-code", session_id, "overview")
    assert overview["ok"] is True
    assert set(overview) == set(expected["overview"])
    assert {"session", "runs", "timeline", "tool_calls", "changes", "prs", "pins", "evidence"} <= set(overview)


def test_inspection_fixture_carries_real_codex_overview_tools_and_body(tmp_data_home, tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("SKILL_HUB_NOW", NOW)
    _seed_registry(tmp_path)
    _seed_codex_inspection_transcript()
    _run(monkeypatch, capsys, "usage", "scan-sessions", "--json")
    import base64

    from skill_hub.application.usage import usage_inspection

    expected = json.loads((FIXTURE_DIR / "inspection-session.json").read_text())["codex"]
    session_id = expected["session_id"]
    overview = usage_inspection.inspection_payload("codex", session_id, "overview")
    assert set(expected["overview"]["required_keys"]) <= set(overview)
    tools = overview["tool_calls"]
    assert tools["total"] == expected["tools"]["total"]
    assert tools["items"][0]["operation"]["summary"] == expected["tools"]["operation_summary"]
    body_id = tools["items"][0]["result_parts"][0]["body_id"]
    body = usage_inspection.read_body_for_session("codex", session_id, body_id)
    content = b"".join(base64.b64decode(chunk["base64"]) for chunk in body["chunks"])
    assert content.decode() == expected["body"]["text"]
    assert body["content_type"] == expected["body"]["content_type"]
    missing = usage_inspection.inspection_payload("codex", expected["missing_session_id"], "overview")
    assert missing["reason"] == "not_captured"


def _normalize_inspection(value, call_aliases=None):
    call_aliases = call_aliases or {}
    if isinstance(value, dict):
        return {
            key: (
                "<captured-event>"
                if key == "id" and isinstance(item, str) and item.startswith("event:")
                else "<captured-change>"
                if key == "id" and isinstance(item, str) and item.startswith("change:")
                else _normalize_inspection(item, call_aliases)
            )
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [_normalize_inspection(item, call_aliases) for item in value]
    if isinstance(value, str) and value in call_aliases:
        return call_aliases[value]
    if isinstance(value, str) and value.startswith("epoch:"):
        return "<captured-epoch>"
    return value


def test_dump_real_both_harness_payloads_once(tmp_data_home, tmp_path, monkeypatch, capsys):
    """Compare complete normalized public payloads for both harnesses."""
    monkeypatch.setenv("SKILL_HUB_NOW", NOW)
    project = _seed_registry(tmp_path)
    claude_id = "eeeeeeee-6666-4666-8666-666666666666"
    claude_dir = Path(os.environ["SKILL_HUB_CLAUDE_HOME"]) / "projects" / SCAN_SLUG_DIR
    claude_dir.mkdir(parents=True, exist_ok=True)
    _write = [
        {
            "type": "assistant", "uuid": "claude-use", "timestamp": "2026-09-07T12:00:01.000Z",
            "sessionId": claude_id, "isSidechain": False,
            "message": {
                "id": "claude-msg", "model": "claude-sonnet-5",
                "usage": {"input_tokens": 4, "output_tokens": 5,
                          "cache_creation_input_tokens": 2, "cache_read_input_tokens": 8},
                "content": [{
                    "type": "tool_use", "id": "claude-tool", "name": "Bash",
                    "input": {"command": "git status"},
                }],
            },
        },
        {
            "type": "user", "uuid": "claude-result", "timestamp": "2026-09-07T12:00:02.000Z",
            "sessionId": claude_id, "isSidechain": False,
            "message": {"content": [{"type": "tool_result", "tool_use_id": "claude-tool", "content": "ok"}]},
            "toolUseResult": {"stdout": "ok", "exit_code": 0},
        },
        {
            "type": "assistant", "uuid": "claude-edit", "timestamp": "2026-09-07T12:10:01.000Z",
            "sessionId": claude_id, "isSidechain": False,
            "message": {"id": "claude-edit-msg", "model": "claude-sonnet-5", "content": [{"type": "tool_use", "id": "claude-edit-tool", "name": "Edit", "input": {"file_path": "demo.txt", "old_string": "a", "new_string": "b"}}]},
        },
        {
            "type": "user", "uuid": "claude-edit-result", "timestamp": "2026-09-07T12:10:02.000Z",
            "sessionId": claude_id, "isSidechain": False,
            "message": {"content": [{"type": "tool_result", "tool_use_id": "claude-edit-tool", "content": "edited"}]},
            "toolUseResult": {"stdout": "edited", "exit_code": 0},
        },
    ]
    (claude_dir / f"{claude_id}.jsonl").write_text("\n".join(json.dumps(item) for item in _write) + "\n")
    claude_child_id = "11111111-8888-4888-8888-888888888888"
    child_dir = claude_dir / claude_id / "subagents"
    child_dir.mkdir(parents=True, exist_ok=True)
    child_records = [
        {"type": "assistant", "uuid": "claude-child", "timestamp": "2026-09-07T12:00:03.000Z", "sessionId": claude_id, "isSidechain": True, "agentId": claude_child_id, "message": {"id": "child-msg", "model": "claude-sonnet-5", "usage": {"input_tokens": 3, "output_tokens": 7}, "content": [{"type": "tool_use", "id": "child-tool", "name": "Bash", "input": {"command": "printf child"}}]}},
        {"type": "user", "uuid": "claude-child-result", "timestamp": "2026-09-07T12:00:04.000Z", "sessionId": claude_id, "isSidechain": True, "agentId": claude_child_id, "message": {"content": [{"type": "tool_result", "tool_use_id": "child-tool", "content": "child"}]}, "toolUseResult": {"stdout": "child", "exit_code": 0}},
    ]
    (child_dir / f"agent-{claude_child_id}.jsonl").write_text("\n".join(json.dumps(item) for item in child_records) + "\n")
    codex_id = "ffffffff-7777-4777-8777-777777777777"
    codex_dir = Path(os.environ["CODEX_HOME"]) / "sessions" / "2026" / "09" / "07"
    codex_dir.mkdir(parents=True, exist_ok=True)
    codex_records = [
        {"type": "session_meta", "timestamp": NOW_ISO, "payload": {"id": codex_id, "cwd": str(project)}},
        {"type": "response_item", "timestamp": "2026-09-07T12:00:01.000Z", "payload": {
            "type": "function_call", "call_id": "codex-tool", "name": "exec_command",
            "arguments": "{\"cmd\":\"git status\",\"workdir\":\"/workspace/skill-hub\"}",
        }},
        {"type": "response_item", "timestamp": "2026-09-07T12:00:02.000Z", "payload": {
            "type": "function_call_output", "call_id": "codex-tool", "output": "ok", "exit_code": 0,
        }},
        {"type": "response_item", "timestamp": "2026-09-07T12:00:05.000Z", "payload": {"type": "custom_tool_call", "call_id": "codex-patch", "name": "apply_patch", "input": "*** Begin Patch\n*** Update File: demo.txt\n*** End Patch"}},
        {"type": "response_item", "timestamp": "2026-09-07T12:00:06.000Z", "payload": {"type": "custom_tool_call_output", "call_id": "codex-patch", "output": "{\"success\":true}"}},
        {"type": "response_item", "timestamp": "2026-09-07T12:10:05.000Z", "payload": {"type": "function_call", "call_id": "codex-pr", "name": "shell", "arguments": "{\"command\":\"gh pr create --repo acme/demo\"}"}},
        {"type": "response_item", "timestamp": "2026-09-07T12:10:06.000Z", "payload": {"type": "function_call_output", "call_id": "codex-pr", "output": "https://github.com/acme/demo/pull/42", "exit_code": 0}},
        {"type": "response_item", "timestamp": "2026-09-07T12:11:05.000Z", "payload": {"type": "function_call", "call_id": "codex-pr-review", "name": "shell", "arguments": "{\"command\":\"gh pr review --repo acme/demo --approve\"}"}},
        {"type": "response_item", "timestamp": "2026-09-07T12:11:06.000Z", "payload": {"type": "function_call_output", "call_id": "codex-pr-review", "output": "https://github.com/acme/demo/pull/43", "exit_code": 0}},
        {"type": "response_item", "timestamp": "2026-09-07T12:12:05.000Z", "payload": {"type": "function_call", "call_id": "codex-pr-other", "name": "shell", "arguments": "{\"command\":\"gh pr create --repo acme/other\"}"}},
        {"type": "response_item", "timestamp": "2026-09-07T12:12:06.000Z", "payload": {"type": "function_call_output", "call_id": "codex-pr-other", "output": "https://github.com/acme/other/pull/42", "exit_code": 0}},
    ]
    (codex_dir / f"rollout-{codex_id}.jsonl").write_text("\n".join(json.dumps(item) for item in codex_records) + "\n")
    codex_child_id = "22222222-9999-4999-8999-999999999999"
    (codex_dir / f"rollout-{codex_child_id}.jsonl").write_text("\n".join(json.dumps(item) for item in [
        {"type": "session_meta", "timestamp": "2026-09-07T12:00:03.000Z", "payload": {"id": codex_child_id, "cwd": str(project), "source": {"subagent": {"thread_spawn": {"parent_thread_id": codex_id, "thread_id": codex_child_id}}}}},
        {"type": "response_item", "timestamp": "2026-09-07T12:00:03.000Z", "payload": {"type": "function_call", "call_id": "codex-child-tool", "name": "shell", "arguments": "{\"command\":\"printf child\"}"}},
        {"type": "response_item", "timestamp": "2026-09-07T12:00:04.000Z", "payload": {"type": "function_call_output", "call_id": "codex-child-tool", "output": "child", "exit_code": 0}},
    ]) + "\n")
    _run(monkeypatch, capsys, "usage", "scan-sessions", "--json")
    from skill_hub.application.usage import usage_inspection
    payload = {}
    for harness, session_id in (("claude-code", claude_id), ("codex", codex_id)):
        overview = usage_inspection.inspection_payload(harness, session_id, "overview")
        if harness == "claude-code":
            assert len([run for run in overview["runs"] if run["parent_id"] is None]) == 1
            assert len(overview["runs"]) == 2
            assert overview["session"]["summary"]["own"]["tokens"]["total"] == 19
            assert overview["session"]["summary"]["subtree"]["tokens"]["total"] == 29
        else:
            main = next(run for run in overview["runs"] if run["parent_id"] is None)
            child_run = next(run for run in overview["runs"] if run["parent_id"] is not None)
            assert main["worktree"]["locations"] == [{
                "id": "/workspace/skill-hub", "label": "/workspace/skill-hub", "basis": "command_workdir"
            }]
            assert child_run["scopes"]["own"]["tokens"]["status"] == "unavailable"
            assert child_run["scopes"]["subtree"]["tokens"]["status"] == "unavailable"
            assert len(overview["prs"]) >= 2
            assert overview["timeline"]["gaps"]
        agent = next((run for run in overview.get("runs", []) if run.get("parent_id")), None)
        pin = usage_inspection.mutate_pin(harness, session_id, agent["id"] if agent else None, "add")
        overview = usage_inspection.inspection_payload(harness, session_id, "overview")
        item = {
            "session_id": session_id,
            "overview": overview,
            "tools": usage_inspection.inspection_payload(harness, session_id, "tools"),
            "changes": usage_inspection.inspection_payload(harness, session_id, "changes"),
            "pins": usage_inspection.list_pins(),
            "pin_mutation": pin,
        }
        body_id = item["tools"]["items"][0]["result_parts"][0]["body_id"]
        item["body"] = usage_inspection.read_body_for_session(harness, session_id, body_id)
        body_ids: set[str] = set()
        def collect(value: object) -> None:
            if isinstance(value, dict):
                if isinstance(value.get("body_id"), str):
                    body_ids.add(value["body_id"])
                for child in value.values():
                    collect(child)
            elif isinstance(value, list):
                for child in value:
                    collect(child)
        collect(overview)
        item["bodies"] = {body: usage_inspection.read_body_for_session(harness, session_id, body) for body in sorted(body_ids)}
        tool_patch = next(change for change in overview["changes"] if change["kind"] == "tool_patch")
        patch_body_id = tool_patch["patch"]["body_id"]
        patch_bytes = b"".join(
            base64.b64decode(chunk["base64"]) for chunk in item["bodies"][patch_body_id]["chunks"]
        )
        if harness == "claude-code":
            assert b"file_path" in patch_bytes and b"demo.txt" in patch_bytes
        else:
            assert b"*** Update File: demo.txt" in patch_bytes
        payload[harness] = item
    assert set(payload) == {"claude-code", "codex"}
    for captured in payload.values():
        assert captured["tools"]["items"]
        assert captured["changes"]["changes"]
        assert captured["bodies"]
    payload["index"] = usage_inspection.index_payload()
    # Physical call identity includes the disposable source path. Normalize only
    # those call IDs, preserving distinct calls and their shared references.
    # Logical run IDs remain exact, so fixture comparison still checks identity.
    call_aliases = {}
    for harness in ("claude-code", "codex"):
        calls = payload[harness]["tools"]["items"]
        assert len({call["id"] for call in calls}) == len(calls)
        for ordinal, call in enumerate(calls):
            if call["id"].startswith("identity:"):
                assert call["id"] not in call_aliases
                call_aliases[call["id"]] = f"<captured-call:{harness}:{ordinal}>"
    # Coverage is an additive Usage3 contract; keep the delivered body fixture exact.
    for root in payload["index"]["sessions"]:
        for item in [root, *root.get("agents", [])]:
            assert item.pop("summary_provenance") == "canonical"
            assert item.pop("capture_coverage") == "complete"
    normalized = _normalize_inspection(payload, call_aliases)
    fixture_path = FIXTURE_DIR / "inspection-captured.json"
    if os.environ.get("WRITE_INSPECTION_FIXTURE"):
        fixture_path.write_text(json.dumps(normalized, indent=2, sort_keys=True) + "\n")
    else:
        expected = json.loads(fixture_path.read_text())
        assert normalized == expected
        shared = json.loads((FIXTURE_DIR / "inspection-session.json").read_text())["captured_contract"]
        assert normalized == shared


# ─────────────────────────────────────────────────────────────────────────────
# TA-1-3061: `hub usage pin` — the argv layer is unpinned. useUsageInspection.ts
# reads these payloads only from a mocked dispatch, and the pytest side only
# tests the domain functions, so a renamed dest or a dropped elif in
# `cmd_usage_pin` would return the silent `unavailable` fallback with both
# suites still green. These four cases drive the real parser.
# ─────────────────────────────────────────────────────────────────────────────


def _seed_pinnable_session(monkeypatch, capsys) -> None:
    _seed_scan_transcript()
    _run(monkeypatch, capsys, "usage", "scan-sessions", "--json")


def test_usage_pin_add_reached_through_hub_main_argv(tmp_data_home, tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("SKILL_HUB_NOW", NOW)
    _seed_registry(tmp_path)
    _seed_pinnable_session(monkeypatch, capsys)

    out = _run(monkeypatch, capsys, "usage", "pin", "add", SCAN_SESSION_ID, "--harness", "claude-code", "--json")
    payload = json.loads(out)
    assert payload["ok"] is True


def test_usage_pin_list_with_after_and_limit_reached_through_hub_main_argv(
    tmp_data_home, tmp_path, monkeypatch, capsys
):
    monkeypatch.setenv("SKILL_HUB_NOW", NOW)
    _seed_registry(tmp_path)
    _seed_pinnable_session(monkeypatch, capsys)
    _run(monkeypatch, capsys, "usage", "pin", "add", SCAN_SESSION_ID, "--harness", "claude-code", "--json")

    out = _run(monkeypatch, capsys, "usage", "pin", "list", "--limit", "50", "--json")
    payload = json.loads(out)
    assert payload["ok"] is True
    assert any(item["session_id"] == SCAN_SESSION_ID for item in payload["items"])

    out = _run(monkeypatch, capsys, "usage", "pin", "list", "--after", SCAN_SESSION_ID, "--limit", "50", "--json")
    payload = json.loads(out)
    assert payload["ok"] is True


def test_usage_pin_remove_reached_through_hub_main_argv(tmp_data_home, tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("SKILL_HUB_NOW", NOW)
    _seed_registry(tmp_path)
    _seed_pinnable_session(monkeypatch, capsys)
    _run(monkeypatch, capsys, "usage", "pin", "add", SCAN_SESSION_ID, "--harness", "claude-code", "--json")

    out = _run(monkeypatch, capsys, "usage", "pin", "remove", SCAN_SESSION_ID, "--harness", "claude-code", "--json")
    payload = json.loads(out)
    assert payload["ok"] is True

    out = _run(monkeypatch, capsys, "usage", "pin", "list", "--limit", "50", "--json")
    payload = json.loads(out)
    assert all(item["session_id"] != SCAN_SESSION_ID for item in payload["items"])


def test_usage_pin_unrecognised_action_is_an_error_not_a_silent_unavailable(
    tmp_data_home, tmp_path, monkeypatch, capsys
):
    """`cmd_usage_pin` falls to `{"ok": False, "reason": "unavailable"}` for any
    dest it does not recognise (a bad `pin_action`, e.g. from a renamed dest).
    The finding's fourth case pins that this is treated as an error, not a
    quietly accepted result — assert directly against `cmd_usage_pin`, since
    argparse itself refuses an unknown `pin` sub-verb before dispatch."""
    monkeypatch.setenv("SKILL_HUB_NOW", NOW)
    _seed_registry(tmp_path)
    from types import SimpleNamespace

    usage_cli.cmd_usage_pin(SimpleNamespace(pin_action="bogus", json=True))
    payload = json.loads(capsys.readouterr().out)
    assert payload["ok"] is False
    assert payload["reason"] == "unavailable"


# ─────────────────────────────────────────────────────────────────────────────
# hub usage project
# ─────────────────────────────────────────────────────────────────────────────


def test_usage_project_json_shape(tmp_data_home, tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("SKILL_HUB_NOW", NOW)
    _seed_registry(tmp_path)
    _write_rows([_session_row()])
    _write_loadout_rows(
        [
            {
                "schema_version": 1,
                "at": "2026-09-05T08:00:00Z",
                "project": "alpha",
                "harness": "claude-code",
                "skills": ["brainstorm"],
                "mcp": [],
                "hash": "a" * 64,
            },
            {
                "schema_version": 1,
                "at": "2026-09-06T08:00:00Z",
                "project": "alpha",
                "harness": "claude-code",
                "skills": ["brainstorm", "other"],
                "mcp": [],
                "hash": "b" * 64,
            },
        ]
    )

    out = _run(monkeypatch, capsys, "usage", "project", "alpha", "--json")
    payload = json.loads(out)

    assert payload["ok"] is True
    assert set(payload.keys()) == {
        "ok", "project", "window", "findings_window", "last_scan_at",
        "harnesses", "footprint", "utilization", "subagents", "outcomes",
        "findings", "sessions", "not_analysed",
    }
    assert payload["project"] == "alpha"
    assert payload["window"] == 30
    assert payload["findings_window"] == 30
    assert payload["harnesses"] == ["claude-code"]
    assert len(payload["sessions"]) == 1
    assert payload["sessions"][0]["session_id"] == SESSION_ID
    assert payload["sessions"][0]["analysed"] is True
    assert payload["not_analysed"] == []

    # The verification finding's trigger counts (fix round): outcome_metrics
    # now reports how many sessions edited and how many of those never
    # verified, so the finding can fire independently of the derived ratio.
    outcomes = payload["outcomes"]
    assert outcomes["editing_sessions"] == 1
    assert outcomes["unverified_editing_sessions"] == 1

    # The per-skill footprint finding's numbers (fix round): each utilization
    # row is enriched with the skill's own footprint byte count and the
    # harnesses whose composition includes it.
    utilization = {row["key"]: row for row in payload["utilization"]}
    assert utilization["brainstorm"]["footprint_bytes"] == 56
    assert utilization["brainstorm"]["harnesses"] == ["claude-code"]


def test_usage_timeline_cli_forwards_project_filter(tmp_data_home, tmp_path, monkeypatch, capsys):
    _seed_registry(tmp_path)
    alpha = _session_row()
    alpha["events"] = [{"kind": "skill", "name": "brainstorm", "at": "2026-09-01T09:00:00Z"}]
    _write_rows([
        alpha,
        {**_session_row(), "session_id": "other", "project": "beta"},
    ])
    out = _run(monkeypatch, capsys, "usage", "timeline", "--project", "alpha", "--json")
    payload = json.loads(out)
    assert payload["project"] == "alpha"
    assert [day["date"] for day in payload["days"]] == ["2026-09-01"]


def test_usage_project_window_choice_leaves_findings_window_fixed_at_30(
    tmp_data_home, tmp_path, monkeypatch, capsys
):
    monkeypatch.setenv("SKILL_HUB_NOW", NOW)
    _seed_registry(tmp_path)
    _write_rows([_session_row()])

    out = _run(monkeypatch, capsys, "usage", "project", "alpha", "--window", "90", "--json")
    payload = json.loads(out)

    assert payload["window"] == 90
    assert payload["findings_window"] == 30  # design D9: findings are fixed at 30 days


def test_usage_project_unknown_name_is_not_found_and_still_exits_zero(
    tmp_data_home, tmp_path, monkeypatch, capsys
):
    monkeypatch.setenv("SKILL_HUB_NOW", NOW)
    _seed_registry(tmp_path)

    out = _run(monkeypatch, capsys, "usage", "project", "does-not-exist", "--json")
    payload = json.loads(out)

    assert payload == {"ok": False, "reason": "not_found", "project": "does-not-exist"}


# ─────────────────────────────────────────────────────────────────────────────
# hub usage session
# ─────────────────────────────────────────────────────────────────────────────


def test_usage_session_json_shape(tmp_data_home, tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("SKILL_HUB_NOW", NOW)
    _seed_registry(tmp_path)
    _write_rows([_session_row()])

    out = _run(monkeypatch, capsys, "usage", "session", SESSION_ID, "--json")
    payload = json.loads(out)

    assert payload["ok"] is True
    assert set(payload.keys()) == {
        "ok", "session_id", "harness", "project", "window", "last_scan_at",
        "transcript_present", "summary", "intent_excerpt", "events", "subagents",
    }
    assert payload["session_id"] == SESSION_ID
    assert payload["harness"] == "claude-code"
    assert payload["project"] == "alpha"
    assert payload["window"] is None
    assert payload["transcript_present"] is False  # no real transcript on disk
    assert set(payload["summary"].keys()) == {
        "tokens_total", "cache_hit_ratio", "steering_count", "duration_minutes",
        "activity", "thinking_text_share", "subagent_token_share", "loadout_assumed",
    }

    # Fix round: every event now carries its own segment token components and
    # thinking/output text lengths, so a segment's cache ratio and thinking
    # share can be derived per-segment instead of only per-session.
    event = payload["events"][0]
    assert set(event.keys()) >= {"tokens", "thinking_len", "output_text_len"}
    assert set(event["tokens"].keys()) == {"input", "output", "cache_creation", "cache_read"}


def test_usage_session_not_found(tmp_data_home, tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("SKILL_HUB_NOW", NOW)
    _seed_registry(tmp_path)

    out = _run(monkeypatch, capsys, "usage", "session", "no-such-session", "--json")
    assert json.loads(out) == {"ok": False, "reason": "not_found"}


def test_usage_session_ambiguous_without_harness(tmp_data_home, tmp_path, monkeypatch, capsys):
    """Two rows share a session id under different harnesses (design D7,
    G22) — without `--harness` the read reports `ambiguous`, never guesses."""
    monkeypatch.setenv("SKILL_HUB_NOW", NOW)
    _seed_registry(tmp_path)
    _write_rows([_session_row(harness="claude-code"), _session_row(harness="codex")])

    out = _run(monkeypatch, capsys, "usage", "session", SESSION_ID, "--json")
    assert json.loads(out) == {"ok": False, "reason": "ambiguous"}

    out = _run(monkeypatch, capsys, "usage", "session", SESSION_ID, "--harness", "codex", "--json")
    payload = json.loads(out)
    assert payload["ok"] is True
    assert payload["harness"] == "codex"


def _seed_kinds_registry(tmp_path: Path) -> Path:
    """A second, self-contained project + two skills, for the `session`
    fixture only (review finding R21: the fixture must pin every event
    kind, not only `human_turn`). Kept separate from `_seed_registry`'s
    single-skill scenario so the other four fixtures never see it."""
    project_path = tmp_path / "kinds"
    project_path.mkdir(exist_ok=True)

    brainstorm_src = hub_core.data_home() / "skills" / "brainstorm"
    brainstorm_src.mkdir(parents=True, exist_ok=True)
    (brainstorm_src / "SKILL.md").write_text(
        "---\nname: brainstorm\ndescription: brainstorm ideas\n---\nbody\n"
    )

    # A real skill dir + a project-local symlink into it, so a Bash call can
    # resolve through the harness's `.claude/skills/` link (design D4) — the
    # same shape `tests/test_usage_scan.py`'s `_seed_unslop_script` builds.
    unslop_real_dir = tmp_path / "skill-real" / "unslop"
    (unslop_real_dir / "scripts").mkdir(parents=True, exist_ok=True)
    (unslop_real_dir / "scripts" / "foo.sh").write_text("#!/bin/sh\necho hi\n")
    claude_skills_dir = project_path / ".claude" / "skills"
    claude_skills_dir.mkdir(parents=True, exist_ok=True)
    (claude_skills_dir / "unslop").symlink_to(unslop_real_dir)

    registry = {
        "version": "1",
        "harnesses_global": ["claude-code"],
        "skills": {
            "brainstorm": {
                "version": "1.0.0",
                "description": "brainstorm ideas",
                "source": str(brainstorm_src),
                "type": "claude-skill",
                "scope": "portable",
            },
            "unslop": {
                "version": "1.0.0",
                "description": "unslop writing",
                "source": str(unslop_real_dir),
                "type": "claude-skill",
                "scope": "portable",
            },
        },
        "projects": {
            "kinds": {
                "path": str(project_path),
                "enabled": ["brainstorm", "unslop"],
                "bundles": [],
                "harnesses": [],
            }
        },
        "bundles": {},
    }
    (hub_core.data_home() / "registry.yaml").write_text(
        yaml.safe_dump(registry, sort_keys=False)
    )
    return project_path


def _seed_rich_kinds_transcript(project_path: Path) -> None:
    """One session covering every event kind (review finding R21): a plain
    human turn (`human_turn`), a slash command (`slash_command`), a
    model-invoked `Skill` tool call (`skill`), a Bash call resolved to a
    registry skill's own script (`script`), and an `Agent` tool call plus
    its matching `tool_result` (`subagent`). The record shapes reuse the
    ones `tests/test_usage_scan.py`'s synthetic tree builder established."""
    slug_dir = Path(os.environ["SKILL_HUB_CLAUDE_HOME"]) / "projects" / "-kinds-project"
    slug_dir.mkdir(parents=True, exist_ok=True)
    cwd = str(project_path)
    sid = KINDS_SESSION_ID
    records = [
        {
            "type": "user", "uuid": "u-1", "timestamp": "2026-09-05T09:00:00.000Z",
            "sessionId": sid, "cwd": cwd, "isSidechain": False,
            "message": {"role": "user", "content": "Please help me ship this."},
            "isMeta": False,
        },
        {
            "type": "assistant", "uuid": "u-2", "timestamp": "2026-09-05T09:00:05.000Z",
            "sessionId": sid, "cwd": cwd, "isSidechain": False,
            "message": {
                "id": "msg_1", "model": "claude-sonnet-5", "role": "assistant", "type": "message",
                "content": [
                    {"type": "text", "text": "On it."},
                    {"type": "tool_use", "id": "toolu_skill", "name": "Skill", "input": {"skill": "brainstorm"}},
                ],
                "usage": {
                    "input_tokens": 2, "output_tokens": 80,
                    "cache_creation_input_tokens": 300, "cache_read_input_tokens": 600,
                },
            },
        },
        {
            "type": "user", "uuid": "u-3", "timestamp": "2026-09-05T09:01:00.000Z",
            "sessionId": sid, "cwd": cwd, "isSidechain": False,
            "message": {
                "role": "user",
                "content": (
                    "<command-name>brainstorm</command-name>"
                    "<command-message>Brainstorm</command-message><command-args></command-args>"
                ),
            },
            "isMeta": False,
        },
        {
            "type": "assistant", "uuid": "u-4", "timestamp": "2026-09-05T09:01:30.000Z",
            "sessionId": sid, "cwd": cwd, "isSidechain": False,
            "message": {
                "id": "msg_2", "model": "claude-sonnet-5", "role": "assistant", "type": "message",
                "content": [
                    {
                        "type": "tool_use", "id": "toolu_bash", "name": "Bash",
                        "input": {"command": "bash " + cwd + "/.claude/skills/unslop/scripts/foo.sh"},
                    }
                ],
                "usage": {
                    "input_tokens": 2, "output_tokens": 10,
                    "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0,
                },
            },
        },
        {
            "type": "assistant", "uuid": "u-5", "timestamp": "2026-09-05T09:02:00.000Z",
            "sessionId": sid, "cwd": cwd, "isSidechain": False,
            "message": {
                "id": "msg_3", "model": "claude-sonnet-5", "role": "assistant", "type": "message",
                "content": [
                    {
                        "type": "tool_use", "id": "toolu_agent", "name": "Agent",
                        "input": {"subagent_type": "orch-planner", "model": "claude-opus-5"},
                    }
                ],
                "usage": {
                    "input_tokens": 2, "output_tokens": 5,
                    "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0,
                },
            },
        },
        {
            "type": "user", "uuid": "u-6", "timestamp": "2026-09-05T09:02:05.000Z",
            "sessionId": sid, "cwd": cwd, "isSidechain": False,
            "message": {
                "role": "user",
                "content": [{"type": "tool_result", "tool_use_id": "toolu_agent", "content": "ok"}],
            },
            "isMeta": False,
            "toolUseResult": {
                "agentId": "dddddddd-5555-4555-8555-555555555555",
                "resolvedModel": "claude-opus-5",
            },
        },
    ]
    text = "\n".join(json.dumps(r) for r in records) + "\n"
    (slug_dir / (sid + ".jsonl")).write_text(text)


def test_session_payload_fixture_matches_the_checked_in_file(
    tmp_data_home, tmp_path, monkeypatch, capsys
):
    """Review finding R21: the checked-in `session.json` fixture must pin
    every event kind, not only the simple `human_turn` shape. Built from a
    REAL transcript scan (never a hand-seeded row), so `human_turn`,
    `slash_command`, `skill`, `script`, and `subagent` all genuinely appear.
    Two independent full scans (state reset between them) must be
    byte-identical before this is trusted as a fixture."""
    monkeypatch.setenv("SKILL_HUB_NOW", NOW)
    project_path = _seed_kinds_registry(tmp_path)
    _seed_rich_kinds_transcript(project_path)

    _run(monkeypatch, capsys, "usage", "scan-sessions", "--json")
    first = _run(monkeypatch, capsys, "usage", "session", KINDS_SESSION_ID, "--json")
    _reset_scan_state()
    _run(monkeypatch, capsys, "usage", "scan-sessions", "--json")
    second = _run(monkeypatch, capsys, "usage", "session", KINDS_SESSION_ID, "--json")
    assert first == second, "the session payload is not deterministic across two fresh scans"

    payload = json.loads(first)
    assert payload["ok"] is True
    kinds = {event["kind"] for event in payload["events"]}
    assert kinds == {"human_turn", "slash_command", "skill", "script", "subagent"}, kinds

    _compare_or_refresh_fixture("session", first)


# ─────────────────────────────────────────────────────────────────────────────
# hub usage footprint
# ─────────────────────────────────────────────────────────────────────────────


def test_usage_footprint_json_shape(tmp_data_home, tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("SKILL_HUB_NOW", NOW)
    _seed_registry(tmp_path)

    out = _run(monkeypatch, capsys, "usage", "footprint", "alpha", "--json")
    payload = json.loads(out)

    assert payload["ok"] is True
    assert set(payload.keys()) == {"ok", "project", "harnesses", "window", "last_scan_at"}
    assert payload["project"] == "alpha"
    assert payload["window"] is None
    assert "claude-code" in payload["harnesses"]
    block = payload["harnesses"]["claude-code"]
    # Wave 3 (design D15.3): the footprint payload is a superset of the
    # `project` payload's block. The three composition keys live here only.
    assert set(block.keys()) == {
        "parts",
        "unknown",
        "bytes_total",
        "approx_tokens",
        "skill_lines",
        "discoverable",
        "discoverable_bytes",
        "discoverable_truncated",
    }


def test_usage_footprint_unknown_project(tmp_data_home, tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("SKILL_HUB_NOW", NOW)
    _seed_registry(tmp_path)

    out = _run(monkeypatch, capsys, "usage", "footprint", "does-not-exist", "--json")
    assert json.loads(out) == {"ok": False, "reason": "not_found", "project": "does-not-exist"}


# ─────────────────────────────────────────────────────────────────────────────
# hub usage findings
# ─────────────────────────────────────────────────────────────────────────────


def test_usage_findings_json_shape(tmp_data_home, tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("SKILL_HUB_NOW", NOW)
    _seed_registry(tmp_path)
    _write_rows([_session_row()])

    out = _run(monkeypatch, capsys, "usage", "findings", "--json")
    payload = json.loads(out)

    assert payload["ok"] is True
    assert set(payload.keys()) == {"ok", "window", "findings_window", "last_scan_at", "findings", "analysed_sessions"}
    assert payload["window"] == 30
    assert payload["findings_window"] == 30
    assert isinstance(payload["findings"], list)


def test_usage_findings_narrowed_to_one_project(tmp_data_home, tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("SKILL_HUB_NOW", NOW)
    _seed_registry(tmp_path)
    _write_rows([_session_row()])

    out = _run(monkeypatch, capsys, "usage", "findings", "--project", "alpha", "--json")
    payload = json.loads(out)
    assert payload["ok"] is True
    assert all(f["project"] == "alpha" for f in payload["findings"])


def test_usage_findings_unknown_project_is_not_found(tmp_data_home, tmp_path, monkeypatch, capsys):
    """Review fix (R9): an explicit, unknown `--project` must not read as a
    clean `ok: true, findings: []` — it exits 0 with `ok: false,
    reason: not_found`, same as `project`/`footprint`/`session`."""
    monkeypatch.setenv("SKILL_HUB_NOW", NOW)
    _seed_registry(tmp_path)

    out = _run(monkeypatch, capsys, "usage", "findings", "--project", "no-such-project", "--json")
    payload = json.loads(out)
    assert payload["ok"] is False
    assert payload["reason"] == "not_found"


def test_usage_loadouts_projects_and_redacts_source_lists(tmp_data_home, tmp_path, monkeypatch, capsys):
    _seed_registry(tmp_path)
    initial = {
        "schema_version": 1,
        "at": "2026-09-05T08:00:00Z",
        "project": "alpha",
        "harness": "claude-code",
        "skills": ["brainstorm"],
        "mcp": ["secret-mcp"],
        "hash": "a" * 64,
    }
    changed = {**initial, "at": "2026-09-06T08:00:00Z", "skills": ["brainstorm", "other"], "hash": "b" * 64}
    other = {**initial, "project": "other", "hash": "c" * 64}
    _write_loadout_rows([changed, other, initial])
    payload = json.loads(_run(monkeypatch, capsys, "usage", "loadouts", "alpha", "--json"))
    assert payload["ok"] is True
    assert [row["kind"] for row in payload["rows"]] == ["initial", "changed"]
    assert set(payload["rows"][0]) == {"at", "harness", "hash", "skill_count", "mcp_count", "kind"}
    assert all("skills" not in row and "mcp" not in row for row in payload["rows"])


def test_usage_loadouts_empty_project_is_ok(tmp_data_home, tmp_path, monkeypatch, capsys):
    _seed_registry(tmp_path)
    payload = json.loads(_run(monkeypatch, capsys, "usage", "loadouts", "alpha", "--json"))
    assert payload == {"ok": True, "project": "alpha", "rows": []}


# ─────────────────────────────────────────────────────────────────────────────
# hub project analytics
# ─────────────────────────────────────────────────────────────────────────────


def test_project_analytics_read_is_empty_by_default(tmp_data_home, tmp_path, monkeypatch, capsys):
    _seed_registry(tmp_path)
    out = _run(monkeypatch, capsys, "project", "analytics", "alpha", "--json")
    assert json.loads(out) == {"project": "alpha", "verify_prefixes": []}


def test_project_analytics_add_verify_prefix_persists_and_reads_back(
    tmp_data_home, tmp_path, monkeypatch, capsys
):
    _seed_registry(tmp_path)
    _run(
        monkeypatch, capsys, "project", "analytics", "alpha",
        "--add-verify-prefix", "hub app build --install", "--json",
    )
    _run(
        monkeypatch, capsys, "project", "analytics", "alpha",
        "--add-verify-prefix", "npm run test:bundle", "--json",
    )

    reg = yaml.safe_load((hub_core.data_home() / "registry.yaml").read_text())
    assert reg["projects"]["alpha"]["analytics"]["verify_prefixes"] == [
        "hub app build --install", "npm run test:bundle",
    ]

    out = _run(monkeypatch, capsys, "project", "analytics", "alpha", "--json")
    assert json.loads(out) == {
        "project": "alpha",
        "verify_prefixes": ["hub app build --install", "npm run test:bundle"],
    }


def test_project_analytics_verify_prefixes_replaces_and_empty_string_clears(
    tmp_data_home, tmp_path, monkeypatch, capsys
):
    _seed_registry(tmp_path)
    _run(monkeypatch, capsys, "project", "analytics", "alpha", "--verify-prefixes", "a,b", "--json")
    reg = yaml.safe_load((hub_core.data_home() / "registry.yaml").read_text())
    assert reg["projects"]["alpha"]["analytics"]["verify_prefixes"] == ["a", "b"]

    _run(monkeypatch, capsys, "project", "analytics", "alpha", "--verify-prefixes", "", "--json")
    reg = yaml.safe_load((hub_core.data_home() / "registry.yaml").read_text())
    assert "analytics" not in reg["projects"]["alpha"]


# ─────────────────────────────────────────────────────────────────────────────
# hub sync never scans (design D6, task 1.49)
# ─────────────────────────────────────────────────────────────────────────────


def test_hub_sync_never_scans_transcripts(tmp_data_home, tmp_path, monkeypatch, capsys):
    """`hub sync` runs the "2e" loadout pass, never the transcript scanner:
    a real (if minimal) transcript file sits on disk throughout, and neither
    the sessions ledger nor the cursor sidecar exists after `hub sync` — only
    an explicit `hub usage scan-sessions` ever creates them."""
    monkeypatch.setenv("SKILL_HUB_NOW", NOW)
    project_path = _seed_registry(tmp_path)

    slug_dir = Path(os.environ["SKILL_HUB_CLAUDE_HOME"]) / "projects" / "-fake-project"
    slug_dir.mkdir(parents=True, exist_ok=True)
    (slug_dir / (SESSION_ID + ".jsonl")).write_text(
        json.dumps(
            {
                "type": "user",
                "uuid": "u-1",
                "timestamp": SESSION_STARTED,
                "sessionId": SESSION_ID,
                "cwd": str(project_path),
                "isSidechain": False,
                "message": {"role": "user", "content": "hello"},
                "isMeta": False,
            }
        )
        + "\n"
    )

    monkeypatch.setattr(sys, "argv", ["hub", "sync"])
    hub.main()
    capsys.readouterr()

    data_home = hub_core.data_home()
    assert not (data_home / "state" / "usage" / "sessions.jsonl").exists()
    assert not (data_home / "state" / "usage" / "scan-cursor.json").exists()

    rows, warnings = usage_loadouts.read_loadout_rows()
    assert warnings == []
    assert len(rows) == 1
    assert rows[0]["project"] == "alpha"
    assert rows[0]["harness"] == "claude-code"
    assert rows[0]["skills"] == ["brainstorm"]


# ─────────────────────────────────────────────────────────────────────────────
# Checked-in payload fixtures for wave 2 (task 1.50)
# ─────────────────────────────────────────────────────────────────────────────


def _generate_payloads(monkeypatch, capsys) -> dict:
    # `session` is generated separately by
    # `test_session_payload_fixture_matches_the_checked_in_file`, from a real
    # scan rich enough to cover every event kind (review finding R21) — the
    # simple hand-seeded row this fixture set otherwise shares cannot.
    outputs = {}
    _reset_scan_state()
    _run(monkeypatch, capsys, "usage", "scan-sessions", "--json")
    timeline = json.loads(_run(monkeypatch, capsys, "usage", "timeline", "--json"))
    # The legacy timeline fixture predates the optional project echo; keep
    # that fixture stable while the CLI contract is asserted separately.
    timeline.pop("project", None)
    outputs["timeline"] = json.dumps(timeline, indent=2) + "\n"
    outputs["codex-session"] = _run(
        monkeypatch, capsys, "usage", "session", CODEX_SESSION_ID, "--harness", "codex", "--json"
    )
    # Seed the legacy-reader fixture in a fresh disposable store. After import,
    # overwriting JSONL must never override authoritative SQLite summaries.
    _reset_scan_state()
    _write_rows([_session_row()])
    usage_scan.cursor_path().write_text(json.dumps({"last_scan_at": NOW_ISO, "files": {}}))
    outputs["project"] = _run(monkeypatch, capsys, "usage", "project", "alpha", "--json")
    outputs["footprint"] = _run(monkeypatch, capsys, "usage", "footprint", "alpha", "--json")
    outputs["findings"] = _run(monkeypatch, capsys, "usage", "findings", "--json")
    outputs["loadouts"] = _run(monkeypatch, capsys, "usage", "loadouts", "alpha", "--json")
    monkeypatch.setattr(usage_history, "_utc_now_iso", lambda: NOW_ISO)
    usage_history.write_rows(
        usage_history.history_path(),
        [
            usage_history.UsageRow(
                date="2026-09-06", agent="claude", model="m", input=1, output=2,
                cache_creation=3, cache_read=4, total=10, cost_usd=0.1,
                source="ccusage", scanner="fixture", captured_at=NOW_ISO, sessions=2,
            ),
            usage_history.UsageRow(
                date="2026-09-05", agent="claude", model="m", input=1, output=2,
                cache_creation=3, cache_read=4, total=10, cost_usd=0.1,
                source="ccusage", scanner="fixture", captured_at=NOW_ISO,
            ),
        ],
    )
    # The history horizon uses the CLI clock separately from generated_at.
    # Freeze both so the checked-in fixture does not expire at midnight.
    monkeypatch.setattr(usage_cli, "_dt", SimpleNamespace(
        datetime=SimpleNamespace(now=lambda _tz: dt.datetime.fromisoformat(NOW.replace("Z", "+00:00"))),
        timezone=dt.timezone,
    ))
    outputs["history"] = _run(monkeypatch, capsys, "usage", "history", "--json")
    return outputs


def _compare_or_refresh_fixture(name: str, text: str) -> None:
    """Compare `text` against `tests/fixtures/usage/<name>.json`, or (re)write
    it when `USAGE_FIXTURE_REFRESH=1` is set. Shared by every checked-in
    payload fixture (task 1.50)."""
    refresh = os.environ.get("USAGE_FIXTURE_REFRESH") == "1"
    FIXTURE_DIR.mkdir(parents=True, exist_ok=True)
    fixture_path = FIXTURE_DIR / f"{name}.json"
    if refresh:
        fixture_path.write_text(text)
        return
    assert fixture_path.exists(), (
        f"{fixture_path} is missing — run this test once with "
        "USAGE_FIXTURE_REFRESH=1 to create it"
    )
    checked_in = fixture_path.read_text()
    assert text == checked_in, (
        f"tests/fixtures/usage/{name}.json is stale — re-run this test with "
        "USAGE_FIXTURE_REFRESH=1 and review the diff before committing it"
    )


def test_payload_fixtures_match_the_checked_in_files(
    tmp_data_home, tmp_path, monkeypatch, capsys
):
    """Runs the generator TWICE and asserts byte equality between the two
    runs (design D10 G3) — proof that the clock seam and the harness-relative
    paths actually removed every source of non-determinism. Then compares
    against the checked-in files under `tests/fixtures/usage/`, refreshing
    them when `USAGE_FIXTURE_REFRESH=1` is set."""
    monkeypatch.setenv("SKILL_HUB_NOW", NOW)
    project_path = _seed_registry(tmp_path)
    _seed_scan_transcript()
    _seed_codex_fixture_transcript(project_path)
    _write_loadout_rows([
        {
            "schema_version": 1,
            "at": "2026-09-05T08:00:00Z",
            "project": "alpha",
            "harness": "claude-code",
            "skills": ["brainstorm"],
            "mcp": [],
            "hash": "a" * 64,
        },
        {
            "schema_version": 1,
            "at": "2026-09-06T08:00:00Z",
            "project": "alpha",
            "harness": "claude-code",
            "skills": ["brainstorm", "other"],
            "mcp": [],
            "hash": "b" * 64,
        },
    ])
    scan_payload = json.loads(_run(monkeypatch, capsys, "usage", "scan-sessions", "--json"))
    assert scan_payload["rows_written"] == 2

    first = _generate_payloads(monkeypatch, capsys)
    second = _generate_payloads(monkeypatch, capsys)
    assert first == second, "the payload generator is not deterministic across two runs"

    for name, text in first.items():
        _compare_or_refresh_fixture(name, text)
