"""Synthetic Codex rollout coverage for the B1 field contract and privacy pins."""

from __future__ import annotations

import json
import os
from pathlib import Path

import yaml

from skill_hub import hub_core
from skill_hub.infrastructure.usage import usage_scan
from skill_hub.infrastructure.usage import usage_scan_codex as codex
from skill_hub.infrastructure.usage.usage_inspection_store import InspectionStore

SESSION = "11111111-2222-4333-8444-555555555555"


def _claude_projects_root() -> Path:
    return Path(os.environ["SKILL_HUB_CLAUDE_HOME"]) / "projects"


def _codex_sessions_root() -> Path:
    return Path(os.environ["CODEX_HOME"]) / "sessions"


def _seed(tmp_path: Path) -> Path:
    project = tmp_path / "project"
    project.mkdir()
    (hub_core.data_home() / "registry.yaml").write_text(
        yaml.safe_dump({"projects": {"demo": {"path": str(project)}}, "skills": {"known": {}}})
    )
    return project


def _write(project: Path, records: list[dict]) -> Path:
    path = _codex_sessions_root() / "2026" / "09" / "01" / f"rollout-2026-09-01T10-00-00-{SESSION}.jsonl"
    path.parent.mkdir(parents=True)
    path.write_text("\n".join(json.dumps(r) for r in records) + "\n")
    return path


def _write_at(session_id: str, records: list[dict]) -> Path:
    path = _codex_sessions_root() / "2026" / "09" / "01" / (
        f"rollout-2026-09-01T10-00-00-{session_id}.jsonl"
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(json.dumps(r) for r in records) + "\n")
    return path


def _tokens(response: str, total: int, *, thread: str = SESSION) -> dict:
    usage = {
        "input_tokens": total // 10,
        "output_tokens": total // 5,
        "cached_input_tokens": total // 10,
        "cache_write_input_tokens": total // 10,
        "total_tokens": total,
    }
    return {
        "timestamp": "2026-09-01T10:00:02.000Z",
        "type": "token_usage_record",
        "payload": {"response_id": response, "thread_id": thread, "turn_id": "turn-1", "usage": usage},
    }


def test_codex_rollout_emits_contract_fields_and_redacts_transient_text(tmp_data_home, tmp_path):
    project = _seed(tmp_path)
    records = [
        {
            "timestamp": "2026-09-01T10:00:00.000Z",
            "type": "session_meta",
            "payload": {"id": SESSION, "cwd": str(project)},
        },
        {
            "timestamp": "2026-09-01T10:00:01.000Z",
            "type": "turn_context",
            "payload": {"turn_id": "turn-1", "model": "gpt-test", "cwd": str(project)},
        },
        {
            "timestamp": "2026-09-01T10:00:01.500Z",
            "type": "event_msg",
            "payload": {
                "type": "user_message",
                "message": f"use skills/known/ and inspect {project}/secret.py --token=private",
            },
        },
        {
            "timestamp": "2026-09-01T10:00:02.000Z",
            "type": "event_msg",
            "payload": {
                "type": "item_completed",
                "turn_id": "turn-1",
                "item": {"type": "FileChange", "changes": {str(project / "secret.py"): {"type": "update"}}},
            },
        },
        _tokens("r1", 100),
        _tokens("r1", 100),
        _tokens("r2", 200),
        {
            "timestamp": "2026-09-01T10:00:04.000Z",
            "type": "compacted",
            "payload": {
                "latest_token_usage_record": {
                    "response_id": "r3",
                    "thread_id": SESSION,
                    "usage": {
                        "input_tokens": 10,
                        "output_tokens": 20,
                        "cached_input_tokens": 10,
                        "cache_write_input_tokens": 10,
                        "total_tokens": 50,
                    },
                }
            },
        },
    ]
    _write(project, records)
    result = codex.scan_sessions(now=codex._dt.datetime(2026, 9, 1, tzinfo=codex._dt.timezone.utc))
    assert result["rows_written"] == 1
    row = json.loads((hub_core.data_home() / codex.SESSIONS_REL).read_text())
    assert {
        "schema_version",
        "harness",
        "session_id",
        "project",
        "started_at",
        "last_activity_at",
        "frozen",
        "tokens",
        "activity",
        "skills",
        "intent_excerpt",
        "events",
        "compactions",
        "parent_session_id",
    } <= set(row)
    assert row["tokens"]["total"] == 350
    assert row["tokens"]["subagent_total"] == 0
    assert row["skills"] == [{"count": 1, "invoker": "user", "key": "known"}]
    private = json.dumps(row)
    assert str(project) not in private and "secret.py" not in private
    assert "private" not in private


def test_codex_identity_mismatch_does_not_publish_source(tmp_data_home, tmp_path):
    project = _seed(tmp_path)
    path = _write(
        project,
        [{"type": "session_meta", "payload": {"id": "99999999-2222-4333-8444-555555555555", "cwd": str(project)}}],
    )
    result = codex.scan_sessions()
    assert result["errors"] == [{"file": path.name, "kind": "identity_mismatch", "harness": "codex"}]
    with InspectionStore.open() as store:
        assert store.db.execute("SELECT COUNT(*) FROM sources").fetchone()[0] == 0


def test_codex_tokens_are_root_only_and_epoch_maxima_are_lifetime_totals(tmp_data_home, tmp_path):
    project = _seed(tmp_path)
    first = _tokens("a1", 100, thread=SESSION)
    first["payload"]["turn_token_usage"] = {
        "input_tokens": 5,
        "cached_input_tokens": 7,
        "cache_write_input_tokens": 9,
    }
    records = [
        {"type": "session_meta", "payload": {"id": SESSION, "cwd": str(project)}},
        {"type": "turn_context", "payload": {"turn_id": "a", "model": "m-a"}},
        {"type": "turn_context", "payload": {"turn_id": "b", "model": "m-b"}},
        {
            "timestamp": "2026-09-01T10:00:01Z",
            "type": "event_msg",
            "payload": {
                "type": "item_completed",
                "turn_id": "a",
                "item": {"type": "McpToolCall", "server": "srv", "tool": "run"},
            },
        },
        {
            "timestamp": "2026-09-01T10:00:02Z",
            "type": "event_msg",
            "payload": {
                "type": "item_completed",
                "turn_id": "b",
                "item": {"type": "ContextCompaction"},
            },
        },
        {
            "timestamp": "2026-09-01T10:00:03Z",
            "type": "event_msg",
            "payload": {
                "type": "item_completed",
                "turn_id": "a",
                "item": {"type": "Reasoning"},
            },
        },
        {
            "timestamp": "2026-09-01T10:00:04Z",
            "type": "event_msg",
            "payload": {
                "type": "item_completed",
                "turn_id": "b",
                "item": {"type": "AgentMessage"},
            },
        },
        first,
        _tokens("a1", 100, thread=SESSION),
        _tokens("a2", 50, thread=SESSION),
        _tokens("a3", 120, thread=SESSION),
        _tokens("b1", 40, thread="thread-b"),
    ]
    _write(project, records)
    codex.scan_sessions()
    row = json.loads((hub_core.data_home() / codex.SESSIONS_REL).read_text())
    assert row["tokens"]["total"] == 270
    assert row["tokens"]["subagent_total"] == 40
    assert row["first_turn_input_total"] == 21
    assert {event["model"] for event in row["events"] if event["kind"] == "tool"} == {"m-a"}
    assert {event["name"] for event in row["events"] if event["kind"] == "tool"} == {"srv/run"}
    assert not any(event["kind"] == "human_turn" for event in row["events"])


def test_codex_finalization_is_pure_across_appended_equal_timestamp_events(tmp_data_home, tmp_path):
    project = _seed(tmp_path)
    path = _write(
        project,
        [
            {"type": "session_meta", "payload": {"id": SESSION, "cwd": str(project)}},
            {
                "timestamp": "2026-09-01T10:00:02.000Z",
                "type": "event_msg",
                "payload": {"type": "user_message", "message": "use skills/known/"},
            },
            _tokens("first", 10),
        ],
    )
    scan_now = codex._dt.datetime(2026, 9, 1, 12, tzinfo=codex._dt.timezone.utc)
    codex.scan_sessions(now=scan_now)
    first_row = json.loads((hub_core.data_home() / codex.SESSIONS_REL).read_text())
    with InspectionStore.open() as store:
        first_messages = [
            tuple(item)
            for item in store.db.execute(
                "SELECT message_id,source_ordinal,at,excerpt FROM messages "
                "ORDER BY source_ordinal,block_ordinal,role_ordinal"
            ).fetchall()
        ]
    assert sum(event["token_delta"] for event in first_row["events"]) == first_row["tokens"]["total"] == 10

    with path.open("a") as handle:
        handle.write(json.dumps(_tokens("second", 5)) + "\n")
        handle.write(json.dumps({
            "timestamp": "2026-09-01T10:00:02.000Z",
            "type": "event_msg",
            "payload": {"type": "user_message", "message": "use skills/known/ again"},
        }) + "\n")
    codex.scan_sessions(now=scan_now)
    second_row = json.loads((hub_core.data_home() / codex.SESSIONS_REL).read_text())
    with InspectionStore.open() as store:
        second_messages = [
            tuple(item)
            for item in store.db.execute(
                "SELECT message_id,source_ordinal,at,excerpt FROM messages "
                "ORDER BY source_ordinal,block_ordinal,role_ordinal"
            ).fetchall()
        ]
    assert second_messages[: len(first_messages)] == first_messages
    assert sum(event["token_delta"] for event in second_row["events"]) == second_row["tokens"]["total"] == 15
    assert max(event["token_delta"] for event in second_row["events"]) <= 15


def test_legacy_cursor_does_not_override_canonical_source_state(tmp_data_home, tmp_path):
    project = _seed(tmp_path)
    root = _claude_projects_root()
    transcript = root / "slug" / f"{SESSION}.jsonl"
    subagent = root / "slug" / SESSION / "subagents" / "agent-a.jsonl"
    outside = tmp_path / "outside.jsonl"
    cursor = hub_core.data_home() / codex.CURSOR_REL
    cursor.parent.mkdir(parents=True, exist_ok=True)
    cursor.write_text(
        json.dumps(
            {
                "files": {
                    str(transcript): {"offset": 1, "acc": {}, "frozen": True},
                    str(subagent): {"offset": 2, "acc": {}},
                    str(outside): {"offset": 3},
                }
            }
        )
    )
    path = _write(project, [{"type": "session_meta", "payload": {"id": SESSION, "cwd": str(project)}}])
    codex.scan_sessions()
    with InspectionStore.open() as store:
        row = store.db.execute(
            "SELECT offset,source_session_id FROM sources WHERE harness='codex'"
        ).fetchone()
    assert tuple(row) == (path.stat().st_size, SESSION)


def test_session_payload_routes_transcript_presence_by_harness(tmp_data_home, tmp_path):
    from skill_hub.infrastructure.usage import usage_scan

    claude_id = "22222222-2222-4222-8222-222222222222"
    claude_path = _claude_projects_root() / "slug" / f"{claude_id}.jsonl"
    codex_path = _codex_sessions_root() / "2026" / "09" / f"rollout-x-{SESSION}.jsonl"
    claude_path.parent.mkdir(parents=True, exist_ok=True)
    codex_path.parent.mkdir(parents=True, exist_ok=True)
    claude_path.write_text("{}\n")
    codex_path.write_text("{}\n")
    ledger = hub_core.data_home() / usage_scan.SESSIONS_REL
    ledger.parent.mkdir(parents=True, exist_ok=True)
    rows = [
        {
            "schema_version": 1,
            "session_id": claude_id,
            "harness": "claude-code",
            "project": "unregistered",
            "started_at": None,
            "last_activity_at": None,
            "frozen": False,
            "tokens": {},
            "activity": {},
            "skills": [],
            "events": [],
            "subagents": [],
        },
        {
            "schema_version": 1,
            "session_id": SESSION,
            "harness": "codex",
            "project": "unregistered",
            "started_at": None,
            "last_activity_at": None,
            "frozen": False,
            "tokens": {},
            "activity": {},
            "skills": [],
            "events": [],
            "subagents": [],
        },
    ]
    ledger.write_text("".join(json.dumps(row) + "\n" for row in rows))
    assert usage_scan.session_payload(claude_id, {})["transcript_present"] is True
    assert usage_scan.session_payload(SESSION, {})["transcript_present"] is True


def test_codex_child_row_is_retained_and_parent_aggregate_is_idempotent(tmp_data_home, tmp_path):
    project = _seed(tmp_path)
    child = "33333333-2222-4222-8222-222222222222"
    root = _codex_sessions_root() / "2026" / "09" / "01"
    root.mkdir(parents=True, exist_ok=True)
    parent_path = root / f"rollout-parent-{SESSION}.jsonl"
    child_path = root / f"rollout-child-{child}.jsonl"
    parent_path.write_text(
        json.dumps(
            {
                "timestamp": "2026-09-01T10:00:00Z",
                "type": "session_meta",
                "payload": {"id": SESSION, "cwd": str(project)},
            }
        )
        + "\n"
    )
    child_path.write_text(
        json.dumps(
            {
                "timestamp": "2026-09-01T10:00:01Z",
                "type": "session_meta",
                "payload": {"id": child, "cwd": str(project), "parent_thread_id": SESSION, "agent_role": "worker"},
            }
        )
        + "\n"
        + json.dumps(_tokens("c1", 40, thread=child))
        + "\n"
    )
    codex.scan_sessions()
    rows_path = hub_core.data_home() / codex.SESSIONS_REL
    rows = {row["session_id"]: row for row in json.loads("[" + ",".join(rows_path.read_text().splitlines()) + "]")}
    assert rows[child]["parent_session_id"] == SESSION
    assert rows[child]["tokens"]["total"] == 40
    assert rows[SESSION]["tokens"]["subagent_total"] == 40
    assert rows[SESSION]["subagents"][0]["role"] == "worker"
    codex.scan_sessions()
    rows_again = {
        row["session_id"]: row for row in json.loads("[" + ",".join(rows_path.read_text().splitlines()) + "]")
    }
    assert rows_again[SESSION]["tokens"]["subagent_total"] == 40


def test_codex_missing_session_meta_uses_filename_identity(tmp_data_home, tmp_path):
    project = _seed(tmp_path)
    path = _write(project, [{
        "timestamp": "2026-09-01T10:00:01Z",
        "type": "event_msg",
        "payload": {"type": "user_message", "message": "headerless"},
    }])
    result = codex.scan_sessions()
    assert result["ok"] is True
    assert result["errors"] == []
    row = json.loads((hub_core.data_home() / codex.SESSIONS_REL).read_text())
    assert row["session_id"] == SESSION
    assert [event["kind"] for event in row["events"]] == ["human_turn"]
    with InspectionStore.open() as store:
        source = store.db.execute(
            "SELECT source_session_id,offset FROM sources WHERE harness='codex'"
        ).fetchone()
    assert tuple(source) == (SESSION, path.stat().st_size)


def test_codex_nested_parent_and_inherited_records_keep_child_identity(tmp_data_home, tmp_path):
    project = _seed(tmp_path)
    child = "44444444-2222-4222-8222-222222222222"
    parent = SESSION
    path = _write_at(
        child,
        [
            {"type": "session_meta", "payload": {"id": child, "cwd": str(project), "source": {
                "subagent": {"thread_spawn": {"parent_thread_id": parent, "thread_id": child}}
            }}},
            _tokens("child", 10, thread=child),
            _tokens("inherited", 90, thread=parent),
            {"type": "session_meta", "payload": {"id": parent, "cwd": str(project)}},
        ],
    )
    codex.scan_sessions()
    rows = {row["session_id"]: row for row in (
        json.loads(line) for line in (hub_core.data_home() / codex.SESSIONS_REL).read_text().splitlines()
    )}
    assert rows[child]["parent_session_id"] == parent
    assert rows[child]["tokens"]["total"] == 10


def test_codex_forked_from_without_parent_is_standalone(tmp_data_home, tmp_path):
    project = _seed(tmp_path)
    path = _write(project, [{"type": "session_meta", "payload": {
        "id": SESSION, "forked_from_id": "parent", "cwd": str(project)
    }}, _tokens("own", 7, thread=SESSION)])
    codex.scan_sessions()
    row = json.loads((hub_core.data_home() / codex.SESSIONS_REL).read_text())
    assert row["parent_session_id"] is None


def test_codex_recursive_descendants_and_cycles_are_bounded(tmp_data_home, tmp_path):
    project = _seed(tmp_path)
    child = "55555555-2222-4222-8222-222222222222"
    grandchild = "66666666-2222-4222-8222-222222222222"
    cycle = "77777777-2222-4222-8222-222222222222"
    _write_at(SESSION, [{"type": "session_meta", "payload": {"id": SESSION, "cwd": str(project)}},
                        _tokens("root", 10, thread=SESSION), _tokens("inline-child", 20, thread=child),
                        _tokens("inline-grand", 30, thread=grandchild)])
    _write_at(child, [{"type": "session_meta", "payload": {
        "id": child, "cwd": str(project), "parent_thread_id": SESSION
    }}, _tokens("child", 20, thread=child)])
    _write_at(grandchild, [{"type": "session_meta", "payload": {
        "id": grandchild, "cwd": str(project), "parent_thread_id": child
    }}, _tokens("inline-grand", 30, thread=grandchild)])
    _write_at(cycle, [{"type": "session_meta", "payload": {
        "id": cycle, "cwd": str(project), "parent_thread_id": cycle
    }}, _tokens("cycle", 5, thread=cycle)])
    codex.scan_sessions()
    rows = {row["session_id"]: row for row in (
        json.loads(line) for line in (hub_core.data_home() / codex.SESSIONS_REL).read_text().splitlines()
    )}
    assert rows[SESSION]["tokens"]["subagent_total"] == 50


def test_stale_reader_reparse_restores_child_total_once(tmp_data_home, tmp_path):
    project = _seed(tmp_path)
    child = "88888888-2222-4222-8222-222222222222"
    parent_path = _write_at(SESSION, [
        {"type": "session_meta", "payload": {"id": SESSION, "cwd": str(project)}}, _tokens("root", 10)
    ])
    child_path = _write_at(child, [
        {"type": "session_meta", "payload": {
            "id": child, "cwd": str(project), "parent_thread_id": SESSION
        }}, _tokens("child", 20, thread=child)
    ])
    codex.scan_sessions(now=codex._dt.datetime(2026, 9, 10, tzinfo=codex._dt.timezone.utc))
    with InspectionStore.open() as store:
        store.db.execute("UPDATE sources SET reader_revision=5 WHERE harness='codex'")
        store.db.commit()
    repaired = codex.scan_sessions(now=codex._dt.datetime(2026, 9, 10, tzinfo=codex._dt.timezone.utc))
    rows_path = hub_core.data_home() / codex.SESSIONS_REL
    rows = {row["session_id"]: row for row in (json.loads(line) for line in rows_path.read_text().splitlines())}
    assert repaired["reparsed"] == 2
    assert rows[SESSION]["tokens"]["subagent_total"] == 20
    before = rows_path.read_text()
    second = codex.scan_sessions(now=codex._dt.datetime(2026, 9, 10, tzinfo=codex._dt.timezone.utc))
    assert second["reparsed"] == 0
    assert rows_path.read_text() == before


def test_codex_rollout_with_only_foreign_thread_has_zero_own_total(tmp_data_home, tmp_path):
    project = _seed(tmp_path)
    _write_at(SESSION, [
        {"type": "session_meta", "payload": {"id": SESSION, "cwd": str(project)}},
        _tokens("foreign", 5, thread="other-thread"),
    ])
    codex.scan_sessions()
    row = json.loads((hub_core.data_home() / codex.SESSIONS_REL).read_text())
    assert row["tokens"]["total"] == 0
    assert row["tokens"]["subagent_total"] == 5


def test_f1_summary_is_published_from_committed_canonical_source(tmp_data_home, tmp_path):
    project = _seed(tmp_path)
    path = _write(project, [{"type": "session_meta", "payload": {"id": SESSION, "cwd": str(project)}}])
    codex.scan_sessions()
    ledger = hub_core.data_home() / codex.SESSIONS_REL
    assert json.loads(ledger.read_text())["session_id"] == SESSION
    assert ".tmp" not in ledger.read_text()
    with InspectionStore.open() as store:
        assert store.db.execute("SELECT offset FROM sources").fetchone()[0] == path.stat().st_size
    assert codex.scan_sessions()["rows_written"] == 0
    assert json.loads(ledger.read_text())["session_id"] == SESSION


def test_f2_identity_retry_does_not_mutate_accumulator(tmp_data_home, tmp_path):
    project = _seed(tmp_path)
    path = _write(
        project,
        [
            {"type": "session_meta", "payload": {"id": SESSION, "cwd": str(project)}},
            {
                "timestamp": "2026-09-01T10:00:01Z",
                "type": "event_msg",
                "payload": {"type": "user_message", "message": "first"},
            },
        ],
    )
    codex.scan_sessions()
    baseline = json.loads((hub_core.data_home() / codex.SESSIONS_REL).read_text())
    original_offset = path.stat().st_size
    with path.open("a") as fh:
        fh.write(json.dumps({"type": "session_meta", "payload": {"id": "99999999-2222-4333-8444-555555555555"}}) + "\n")
    snapshots = []
    for _ in range(3):
        codex.scan_sessions()
        snapshots.append(json.loads((hub_core.data_home() / codex.SESSIONS_REL).read_text()))
    for snapshot in snapshots:
        assert snapshot["tokens"] == baseline["tokens"]
        assert snapshot["activity"] == baseline["activity"]
        assert snapshot["events"] == baseline["events"]
        assert snapshot["capture_coverage"] == "partial"
    with InspectionStore.open() as store:
        assert store.db.execute("SELECT offset FROM sources").fetchone()[0] == original_offset


def test_f3_delta_and_snapshot_token_contracts_are_disjoint_and_deduplicated(tmp_data_home, tmp_path):
    project = _seed(tmp_path)
    def snapshot(rid, total):
        return {
            "timestamp": f"2026-09-01T10:00:{total:02d}Z",
            "type": "token_usage_record",
            "payload": {
                "response_id": rid,
                "thread_id": SESSION,
                "thread_token_usage": {"total_tokens": total},
            },
        }
    records = [
        {"type": "session_meta", "payload": {"id": SESSION, "cwd": str(project)}},
        {
            "type": "token_usage_record",
            "payload": {"response_id": "d1", "thread_id": SESSION, "usage": {"total_tokens": 100}},
        },
        {
            "type": "token_usage_record",
            "payload": {"response_id": "d2", "thread_id": SESSION, "usage": {"total_tokens": 50}},
        },
        {
            "type": "token_usage_record",
            "payload": {"response_id": "d3", "thread_id": SESSION, "usage": {"total_tokens": 120}},
        },
        snapshot("s1", 100),
        snapshot("s1", 100),
        snapshot("s2", 250),
        {
            "timestamp": "2026-09-01T10:01:00Z",
            "type": "compacted",
            "payload": {
                "latest_token_usage_record": {
                    "response_id": "s3",
                    "thread_id": SESSION,
                    "thread_token_usage": {"total_tokens": 60},
                }
            },
        },
    ]
    _write(project, records)
    codex.scan_sessions()
    row = json.loads((hub_core.data_home() / codex.SESSIONS_REL).read_text())
    assert row["tokens"]["total"] == 580


def test_codex_cumulative_thread_total_survives_model_switch(tmp_data_home, tmp_path):
    project = _seed(tmp_path)

    def snapshot(response: str, total: int, turn: str, timestamp: str) -> dict:
        return {
            "timestamp": timestamp,
            "type": "token_usage_record",
            "payload": {
                "response_id": response,
                "thread_id": SESSION,
                "turn_id": turn,
                "thread_token_usage": {"total_tokens": total},
            },
        }

    def tool(turn: str, timestamp: str, name: str) -> dict:
        return {
            "timestamp": timestamp,
            "type": "event_msg",
            "payload": {
                "type": "item_completed",
                "turn_id": turn,
                "item": {"type": "McpToolCall", "server": "srv", "tool": name},
            },
        }

    records = [
        {"type": "session_meta", "payload": {"id": SESSION, "cwd": str(project)}},
        {"timestamp": "2026-09-01T10:00:00Z", "type": "turn_context", "payload": {"turn_id": "a", "model": "m-a"}},
        snapshot("a", 100, "a", "2026-09-01T10:00:01Z"),
        tool("a", "2026-09-01T10:00:02Z", "first"),
        {"timestamp": "2026-09-01T10:00:03Z", "type": "turn_context", "payload": {"turn_id": "b", "model": "m-b"}},
        snapshot("b", 150, "b", "2026-09-01T10:00:04Z"),
        tool("b", "2026-09-01T10:00:05Z", "second"),
    ]
    _write(project, records)

    codex.scan_sessions()
    row = json.loads((hub_core.data_home() / codex.SESSIONS_REL).read_text())
    tool_events = [event for event in row["events"] if event["kind"] == "tool"]

    assert row["tokens"]["total"] == 150
    assert sum(event["token_delta"] for event in row["events"]) == 150
    assert [(event["model"], event["token_delta"]) for event in tool_events] == [("m-a", 100), ("m-b", 50)]


def test_f4_events_bucket_real_tokens_activity_text_and_human_invoker(tmp_data_home, tmp_path):
    project = _seed(tmp_path)
    records = [
        {"timestamp": "2026-09-01T10:00:00Z", "type": "session_meta", "payload": {"id": SESSION, "cwd": str(project)}},
        {
            "timestamp": "2026-09-01T10:00:01Z",
            "type": "event_msg",
            "payload": {"type": "user_message", "message": "one"},
        },
        {
            "timestamp": "2026-09-01T10:00:02Z",
            "type": "token_usage_record",
            "payload": {"response_id": "e1", "thread_id": SESSION, "usage": {"total_tokens": 100}},
        },
        {
            "timestamp": "2026-09-01T10:00:03Z",
            "type": "event_msg",
            "payload": {"type": "item_completed", "item": {"type": "FileChange", "changes": {"/tmp/x": {}}}},
        },
        {
            "timestamp": "2026-09-01T10:00:04Z",
            "type": "event_msg",
            "payload": {"type": "user_message", "message": "two"},
        },
        {
            "timestamp": "2026-09-01T10:00:05Z",
            "type": "token_usage_record",
            "payload": {"response_id": "e2", "thread_id": SESSION, "usage": {"total_tokens": 50}},
        },
    ]
    _write(project, records)
    codex.scan_sessions()
    row = json.loads((hub_core.data_home() / codex.SESSIONS_REL).read_text())
    assert sum(event["token_delta"] for event in row["events"]) == row["tokens"]["total"] == 150
    human = [event for event in row["events"] if event["kind"] == "human_turn"]
    assert len(human) == 2 and all(event["invoker"] == "you" for event in human)
    assert all(
        event["token_delta"] or event["output_text_len"] or sum(event["activity"].values()) for event in row["events"]
    )


def test_f5_frozen_parent_captures_later_child_growth(tmp_data_home, tmp_path):
    project = _seed(tmp_path)
    child = "33333333-2222-4222-8222-222222222222"
    root = _codex_sessions_root() / "2026" / "09" / "01"
    root.mkdir(parents=True, exist_ok=True)
    (root / f"rollout-parent-{SESSION}.jsonl").write_text(
        json.dumps(
            {
                "timestamp": "2026-09-01T10:00:00Z",
                "type": "session_meta",
                "payload": {"id": SESSION, "cwd": str(project)},
            }
        )
        + "\n"
    )
    child_path = root / f"rollout-child-{child}.jsonl"
    child_path.write_text(
        json.dumps(
            {
                "timestamp": "2026-09-01T10:00:01Z",
                "type": "session_meta",
                "payload": {"id": child, "cwd": str(project), "parent_thread_id": SESSION},
            }
        )
        + "\n"
    )
    now = codex._dt.datetime(2026, 9, 5, tzinfo=codex._dt.timezone.utc)
    codex.scan_sessions(now=now)
    ledger = hub_core.data_home() / codex.SESSIONS_REL
    before = next(line for line in ledger.read_text().splitlines() if json.loads(line)["session_id"] == SESSION)
    child_path.write_text(child_path.read_text() + json.dumps(_tokens("late", 40, thread=child)) + "\n")
    result = codex.scan_sessions(now=codex._dt.datetime(2026, 9, 6, tzinfo=codex._dt.timezone.utc))
    after = next(line for line in ledger.read_text().splitlines() if json.loads(line)["session_id"] == SESSION)
    assert json.loads(before)["frozen"] is True
    assert json.loads(before)["tokens"]["subagent_total"] == 0
    assert json.loads(after)["tokens"]["subagent_total"] == 40
    assert result["frozen_appended"] >= 1


def test_f7_first_turn_is_not_steering_even_when_excerpt_is_empty(tmp_data_home, tmp_path):
    project = _seed(tmp_path)
    records = [
        {"type": "session_meta", "payload": {"id": SESSION, "cwd": str(project)}},
        {"timestamp": "2026-09-01T10:00:01Z", "type": "event_msg", "payload": {"type": "user_message", "message": ""}},
        {
            "timestamp": "2026-09-01T10:00:02Z",
            "type": "event_msg",
            "payload": {"type": "user_message", "message": "second"},
        },
    ]
    _write(project, records)
    codex.scan_sessions()
    row = json.loads((hub_core.data_home() / codex.SESSIONS_REL).read_text())
    assert row["steering_count"] == 1


def test_combined_scan_keeps_existing_project_session_visible(tmp_data_home, tmp_path):
    """A Codex pass must not turn an already scanned Claude session into an empty UI."""
    project = _seed(tmp_path)
    now = codex._dt.datetime(2026, 9, 1, 12, tzinfo=codex._dt.timezone.utc)
    claude_id = "aaaaaaaa-2222-4333-8444-555555555555"
    usage_scan._write_session_rows(usage_scan.sessions_path(), [{
        "harness": "claude-code", "session_id": claude_id, "project": "demo",
        "started_at": "2026-09-01T10:00:00Z", "last_activity_at": "2026-09-01T10:01:00Z",
        "frozen": True, "tokens": {"total": 123}, "events": [],
    }])
    _write(project, [{"type": "session_meta", "payload": {"id": SESSION, "cwd": str(project)}}])
    registry = hub_core.load_registry()
    for _ in range(2):
        result = usage_scan.scan_sessions(now=now)
        assert result["ok"] is True
        assert result["last_scan_at"] == "2026-09-01T12:00:00.000Z"
        assert usage_scan.last_scan_at() == result["last_scan_at"]
        payload = usage_scan.session_payload(claude_id, registry, harness="claude-code")
        assert payload["ok"] is True
        assert payload["last_scan_at"] == result["last_scan_at"]
        assert payload["summary"]["tokens_total"] == 123


def test_codex_fork_inherited_metadata_preserves_child_identity(tmp_data_home, tmp_path):
    project = _seed(tmp_path)
    parent = "99999999-2222-4333-8444-555555555555"
    now = codex._dt.datetime(2026, 9, 1, 12, tzinfo=codex._dt.timezone.utc)
    records = [
        {"type": "session_meta", "payload": {
            "id": SESSION, "session_id": parent, "forked_from_id": parent,
            "parent_thread_id": parent, "agent_role": "explorer", "cwd": str(project),
        }},
        {"type": "session_meta", "payload": {"id": parent, "cwd": "/inherited/parent"}},
        _tokens("child-response", 100),
    ]
    path = _write(project, records)
    result = codex.scan_sessions(now=now)
    assert result["ok"] is True
    assert result["errors"] == []
    row = json.loads((hub_core.data_home() / codex.SESSIONS_REL).read_text())
    assert row["session_id"] == SESSION
    assert row["parent_session_id"] == parent
    assert row["project"] == "demo"
    assert row["tokens"]["total"] == 100
    with InspectionStore.open() as store:
        stored = store.db.execute(
            "SELECT s.offset,r.role FROM sources s JOIN runs r "
            "ON r.source_session_id=s.source_session_id WHERE s.harness='codex'"
        ).fetchone()
    assert tuple(stored) == (path.stat().st_size, "explorer")
    with path.open("a") as fh:
        fh.write(json.dumps(_tokens("child-next-response", 50)) + "\n")
    assert codex.scan_sessions(now=now)["ok"] is True
    row = json.loads((hub_core.data_home() / codex.SESSIONS_REL).read_text())
    assert row["tokens"]["total"] == 150
    assert codex.scan_sessions(now=now)["rows_written"] == 0


def test_combined_scan_names_codex_identity_error(tmp_data_home, tmp_path):
    project = _seed(tmp_path)
    path = _write(project, [{"type": "session_meta", "payload": {"id": "wrong"}}])
    result = usage_scan.scan_sessions()
    assert result["ok"] is False
    assert result["stopped_on"] == path.name
    assert result["errors"] == [{"file": path.name, "kind": "identity_mismatch", "harness": "codex"}]


def test_inherited_parent_records_do_not_move_child_activity_window(tmp_data_home, tmp_path):
    project = _seed(tmp_path)
    parent = "22222222-2222-4222-8222-222222222222"
    records = [
        {"type": "session_meta", "timestamp": "2026-09-01T10:00:00Z", "payload": {
            "id": SESSION, "cwd": str(project), "parent_thread_id": parent,
        }},
        {"type": "session_meta", "timestamp": "2026-08-01T10:00:00Z", "payload": {"id": parent}},
        {**_tokens("copied", 90, thread=parent), "timestamp": "2026-08-01T10:01:00Z"},
        {"type": "compacted", "timestamp": "2026-08-01T10:02:00Z", "payload": {
            "latest_token_usage_record": _tokens("compacted-parent", 100, thread=parent)["payload"],
        }},
        _tokens("own", 10),
    ]
    _write(project, records)
    codex.scan_sessions()
    row = json.loads((hub_core.data_home() / codex.SESSIONS_REL).read_text())
    assert row["tokens"]["subagent_total"] == 0
    assert row["started_at"] == "2026-09-01T10:00:00Z"
    assert row["tokens"]["total"] == 10


def test_foreign_token_before_root_does_not_consume_first_turn(tmp_data_home, tmp_path):
    project = _seed(tmp_path)
    _write(project, [
        {"type": "session_meta", "payload": {"id": SESSION, "cwd": str(project)}},
        _tokens("child-first", 100, thread="foreign-child"),
        _tokens("root-first", 50),
    ])
    assert codex.scan_sessions()["ok"]
    row = next(row for row in usage_scan.read_session_rows()[0] if row["session_id"] == SESSION)
    assert row["first_turn_input_total"] == 15
    assert row["tokens"]["total"] == 50
    assert row["tokens"]["subagent_total"] == 100
