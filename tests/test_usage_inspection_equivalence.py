"""Whole-file and resumed Usage inspection capture equivalence journeys."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Callable

import hub
from skill_hub import hub_core
from skill_hub.application.usage import usage_inspection
from skill_hub.domain.usage.usage_inspection_capture import SourceCursor
from skill_hub.infrastructure.usage.usage_inspection_store import InspectionStore

ROOT = "11111111-1111-4111-8111-111111111111"
CHILD = "22222222-2222-4222-8222-222222222222"
CLAUDE = "33333333-3333-4333-8333-333333333333"


def _write(path: Path, records: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(json.dumps(record, ensure_ascii=False) for record in records) + "\n")


def _switch_home(monkeypatch, home: Path) -> None:
    home.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("SKILL_HUB_HOME", str(home))
    monkeypatch.delenv("SKILL_HUB_DIR", raising=False)
    monkeypatch.delenv("SKILL_HUB_CODE", raising=False)
    monkeypatch.setattr(hub_core, "_DATA_HOME_CACHE", None)
    monkeypatch.setattr(hub, "_DATA_HOME_CACHE", None)


def _capture(
    monkeypatch,
    home: Path,
    path: Path,
    parser: Callable,
    cursor: SourceCursor | None = None,
) -> SourceCursor:
    _switch_home(monkeypatch, home)
    with InspectionStore.open() as store:
        batch = parser(path, cursor)
        result = store.merge_capture(batch)
        assert result.outcome in {"captured", "incomplete", "unchanged"}
        return store.source_cursor(batch.source.source_id)


def _stale_cursor(monkeypatch, home: Path, source_id: str) -> SourceCursor:
    _switch_home(monkeypatch, home)
    with InspectionStore.open() as store:
        store.db.execute("UPDATE sources SET resume_version=0 WHERE source_id=?", (source_id,))
        store.db.commit()
        return store.source_cursor(source_id)


def _body_ids(payload: dict) -> set[str]:
    ids: set[str] = set()
    for item in payload.get("tool_calls", {}).get("items", []):
        for side in ("input_parts", "result_parts"):
            ids.update(str(part["body_id"]) for part in item.get(side, []) if part.get("body_id"))
    for change in payload.get("changes", []):
        patch = change.get("patch") or {}
        if patch.get("body_id"):
            ids.add(str(patch["body_id"]))
    return ids


def _snapshot(monkeypatch, home: Path, harness: str, session_ids: list[str]) -> dict:
    _switch_home(monkeypatch, home)
    index = usage_inspection.index_payload()
    sessions: dict[str, dict] = {}
    body_ids: set[str] = set()
    for session_id in session_ids:
        views = {
            view: usage_inspection.inspection_payload(harness, session_id, view)
            for view in ("overview", "tools", "changes")
        }
        body_ids.update(_body_ids(views["overview"]))
        body_ids.update(_body_ids(views["tools"]))
        body_ids.update(_body_ids(views["changes"]))
        sessions[session_id] = views
    bodies = {
        body_id: usage_inspection.read_body_for_session(harness, session_ids[0], body_id)
        for body_id in sorted(body_ids)
    }
    return {"index": index, "sessions": sessions, "bodies": bodies}


def _codex_meta(session_id: str, *, parent: str | None = None) -> dict:
    payload: dict[str, object] = {"id": session_id, "cwd": "/workspace/equivalence"}
    if parent is not None:
        payload["parent_thread_id"] = parent
    return {"timestamp": "2026-01-01T00:00:00Z", "type": "session_meta", "payload": payload}


def _turn(session_id: str, turn_id: str, model: str) -> dict:
    return {
        "timestamp": "2026-01-01T00:00:01Z",
        "type": "turn_context",
        "payload": {"turn_id": turn_id, "model": model, "thread_id": session_id},
    }


def _native_token(session_id: str, response_id: str, turn_id: str) -> dict:
    return {
        "timestamp": "2026-01-01T00:00:02Z",
        "type": "token_usage_record",
        "payload": {
            "response_id": response_id,
            "thread_id": session_id,
            "turn_id": turn_id,
            "usage": {"input_tokens": 100, "output_tokens": 10, "total_tokens": 110},
        },
    }


def _mirror_token(session_id: str, token_id: str) -> dict:
    return {
        "id": token_id,
        "timestamp": "2026-01-01T00:00:02Z",
        "type": "event_msg",
        "payload": {
            "id": token_id,
            "type": "token_count",
            "thread_id": session_id,
            "info": {
                "total_token_usage": {
                    "input_tokens": 100,
                    "output_tokens": 10,
                    "cached_input_tokens": 0,
                    "cache_write_input_tokens": 0,
                    "total_tokens": 110,
                }
            },
        },
    }


def _function_call(call_id: str, name: str, arguments: str) -> dict:
    return {
        "timestamp": "2026-01-01T00:00:03Z",
        "type": "response_item",
        "payload": {
            "type": "function_call",
            "call_id": call_id,
            "name": name,
            "arguments": arguments,
        },
    }


def _function_output(call_id: str, output: str) -> dict:
    return {
        "timestamp": "2026-01-01T00:00:04Z",
        "type": "response_item",
        "payload": {
            "type": "function_call_output",
            "call_id": call_id,
            "output": output,
            "success": True,
        },
    }


def _codex_paths(tmp_path: Path) -> tuple[Path, Path]:
    root = tmp_path / "codex"
    return root / "root.jsonl", root / "child.jsonl"


def _run_codex_equivalence(
    monkeypatch,
    tmp_path: Path,
    home_incremental: Path,
    home_full: Path,
    *,
    mirror_first: bool,
) -> tuple[dict, dict]:
    from skill_hub.infrastructure.usage.usage_inspection_codex import capture_codex_source

    root_path, child_path = _codex_paths(tmp_path)
    initial_root = [_codex_meta(ROOT), _turn(ROOT, "turn-1", "model-a")]
    if mirror_first:
        root_suffix = [
            _turn(ROOT, "turn-2", "model-b"),
            _mirror_token(ROOT, "token-1"),
            _native_token(ROOT, "token-1", "turn-1"),
            _native_token(ROOT, "token-2", "turn-2"),
        ]
    else:
        root_suffix = [
            _turn(ROOT, "turn-2", "model-b"),
            _native_token(ROOT, "token-1", "turn-1"),
            _mirror_token(ROOT, "token-1"),
            _native_token(ROOT, "token-2", "turn-2"),
        ]
    initial_child = [_codex_meta(CHILD, parent=ROOT), _turn(CHILD, "child-turn", "model-child")]
    child_suffix = [
        _native_token(CHILD, "child-token", "child-turn"),
        _function_call("child-call", "shell", '{"command":"printf child"}'),
        _function_output("child-call", "child output"),
    ]
    _write(root_path, initial_root)
    _write(child_path, initial_child)

    cursors_a = {
        path: _capture(monkeypatch, home_incremental, path, capture_codex_source) for path in (root_path, child_path)
    }
    cursors_b = {path: _capture(monkeypatch, home_full, path, capture_codex_source) for path in (root_path, child_path)}
    # Commit each record separately so a late native sample must replace an
    # already persisted mirror, and the opposite arrival order cannot double count.
    for record in root_suffix:
        with root_path.open("a") as stream:
            stream.write(json.dumps(record, ensure_ascii=False) + "\n")
        cursors_a[root_path] = _capture(
            monkeypatch, home_incremental, root_path, capture_codex_source, cursors_a[root_path]
        )
    child_path.write_text(
        child_path.read_text() + "".join(json.dumps(record, ensure_ascii=False) + "\n" for record in child_suffix)
    )
    for path in (root_path, child_path):
        _capture(monkeypatch, home_incremental, path, capture_codex_source, cursors_a[path])
        stale = _stale_cursor(monkeypatch, home_full, cursors_b[path].source_id)
        _capture(monkeypatch, home_full, path, capture_codex_source, stale)
    return (
        _snapshot(monkeypatch, home_incremental, "codex", [ROOT, CHILD]),
        _snapshot(monkeypatch, home_full, "codex", [ROOT, CHILD]),
    )


def test_codex_incremental_equals_stale_full_reparse_in_both_token_arrival_orders(tmp_data_home, tmp_path, monkeypatch):
    for mirror_first in (False, True):
        incremental, full = _run_codex_equivalence(
            monkeypatch,
            tmp_path / ("mirror-first" if mirror_first else "native-first"),
            tmp_path / ("home-a" if mirror_first else "home-c"),
            tmp_path / ("home-b" if mirror_first else "home-d"),
            mirror_first=mirror_first,
        )
        assert incremental == full
        overview = incremental["sessions"][ROOT]["overview"]
        assert len(overview["runs"]) == 2
        assert overview["session"]["summary"]["subtree"]["tokens"]["total"] == 330
        assert overview["runs"][1]["parent_id"] == overview["runs"][0]["id"]


def _claude_tool(timestamp: str, native_id: str, name: str, input_value: dict) -> dict:
    return {
        "type": "assistant",
        "uuid": f"assistant-{native_id}",
        "timestamp": timestamp,
        "sessionId": CLAUDE,
        "isSidechain": False,
        "message": {
            "id": f"message-{native_id}",
            "model": "claude-model",
            "role": "assistant",
            "type": "message",
            "content": [{"type": "tool_use", "id": native_id, "name": name, "input": input_value}],
        },
    }


def _claude_result(timestamp: str, native_id: str, content: str) -> dict:
    return {
        "type": "user",
        "uuid": f"result-{native_id}",
        "timestamp": timestamp,
        "sessionId": CLAUDE,
        "isSidechain": False,
        "message": {
            "role": "user",
            "content": [{"type": "tool_result", "tool_use_id": native_id, "content": content}],
        },
    }


def test_delayed_claude_edit_and_pr_outputs_match_stale_full_reparse(tmp_data_home, tmp_path, monkeypatch):
    from skill_hub.infrastructure.usage.usage_inspection_claude import capture_claude_source

    path = tmp_path / "claude" / f"{CLAUDE}.jsonl"
    initial = [
        _claude_tool(
            "2026-01-01T00:00:00Z", "edit-call", "Edit", {"file_path": "demo.txt", "old_string": "a", "new_string": "b"}
        ),
        _claude_tool("2026-01-01T00:00:01Z", "pr-call", "Bash", {"command": "gh pr create --repo example/skill-hub"}),
        _claude_tool(
            "2026-01-01T00:00:02Z", "wrong-pr-call", "Bash", {"command": "gh pr create --repo example/skill-hub"}
        ),
    ]
    suffix = [
        _claude_result("2026-01-01T00:01:00Z", "edit-call", "edited"),
        _claude_result("2026-01-01T00:01:01Z", "pr-call", "https://github.com/example/skill-hub/pull/17"),
        _claude_result("2026-01-01T00:01:02Z", "wrong-pr-call", "https://github.com/other/repo/pull/99"),
    ]
    _write(path, initial)
    home_a = tmp_path / "claude-home-a"
    home_b = tmp_path / "claude-home-b"
    cursor_a = _capture(monkeypatch, home_a, path, capture_claude_source)
    cursor_b = _capture(monkeypatch, home_b, path, capture_claude_source)
    path.write_text(path.read_text() + "".join(json.dumps(record, ensure_ascii=False) + "\n" for record in suffix))
    _capture(monkeypatch, home_a, path, capture_claude_source, cursor_a)
    stale = _stale_cursor(monkeypatch, home_b, cursor_b.source_id)
    _capture(monkeypatch, home_b, path, capture_claude_source, stale)

    incremental = _snapshot(monkeypatch, home_a, "claude-code", [CLAUDE])
    full = _snapshot(monkeypatch, home_b, "claude-code", [CLAUDE])
    assert incremental == full
    overview = incremental["sessions"][CLAUDE]["overview"]
    assert len(overview["prs"]) == 1
    assert overview["prs"][0]["number"] == 17
    edit = next(item for item in overview["tool_calls"]["items"] if item["tool"]["name"] == "Edit")
    assert edit["execution"] == "completed"
    assert edit["result_parts"]
    assert any(part.get("body_id") for part in edit["input_parts"])
