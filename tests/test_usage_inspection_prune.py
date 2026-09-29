"""Focused retention contracts for the canonical inspection store."""

from __future__ import annotations

import base64
import hashlib
import json
import sqlite3
from dataclasses import replace
from datetime import datetime, timezone

from test_usage_inspection_store import _batch

from skill_hub.application.usage.usage_inspection import (
    inspection_payload,
    merge_capture,
    prune_bodies,
    read_body_for_session,
)
from skill_hub.domain.usage.usage_inspection_capture import BodyPartInput, EventInput
from skill_hub.infrastructure.usage.usage_inspection_codex import capture_codex_source
from skill_hub.infrastructure.usage.usage_inspection_store import InspectionStore, db_path


def _body(payload: dict, side: str, index: int = 0) -> str:
    return payload["tool_calls"]["items"][0][f"{side}_parts"][index]["body_id"]


def test_prune_detaches_old_results_and_keeps_durable_inputs(tmp_data_home):
    batch = _batch()
    result = BodyPartInput("result", "result", "available", "text/plain", b"old result", None)
    tool = replace(batch.tool_calls[0], result_parts=(result,))
    merge_capture(replace(batch, tool_calls=(tool,)))
    before = inspection_payload("claude-code", "session", "overview")
    input_id = _body(before, "input")
    result_id = _body(before, "result")

    outcome = prune_bodies(older_than=1, max_store_bytes=2**40)

    assert outcome["ok"] is True
    assert outcome["bodies_pruned"] == 1
    assert outcome["bytes_freed"] == len(b"old result")
    assert outcome["sessions_touched"] == 1
    after = inspection_payload("claude-code", "session", "overview")
    assert _body(after, "input") == input_id
    assert after["tool_calls"]["items"][0]["result_parts"][0]["status"] == "pruned"
    assert read_body_for_session("claude-code", "session", input_id)["ok"] is True
    assert read_body_for_session("claude-code", "session", result_id) == {
        "ok": False,
        "reason": "pruned",
        "pruned_at": after["tool_calls"]["items"][0]["result_parts"][0]["pruned_at"],
    }


def test_dry_run_does_not_change_parts_or_bodies(tmp_data_home):
    batch = _batch()
    result = BodyPartInput("result", "result", "available", "text/plain", b"old result", None)
    merge_capture(replace(batch, tool_calls=(replace(batch.tool_calls[0], result_parts=(result,)),)))
    before = inspection_payload("claude-code", "session", "overview")
    result_id = _body(before, "result")

    outcome = prune_bodies(older_than=1, max_store_bytes=2**40, dry_run=True)

    assert outcome["dry_run"] is True
    assert outcome["bodies_pruned"] == 1
    assert inspection_payload("claude-code", "session", "overview") == before
    body = read_body_for_session("claude-code", "session", result_id)
    assert body["ok"] is True
    assert base64.b64decode(body["chunks"][0]["base64"]) == b"old result"


def test_shared_body_detaches_prunable_reference_and_keeps_durable_body(tmp_data_home):
    batch = _batch(data=b"shared")
    result = BodyPartInput("result", "result", "available", "text/plain", b"shared", None)
    merge_capture(replace(batch, tool_calls=(replace(batch.tool_calls[0], result_parts=(result,)),)))
    before = inspection_payload("claude-code", "session", "overview")
    input_id = _body(before, "input")
    result_id = _body(before, "result")
    assert input_id == result_id

    outcome = prune_bodies(older_than=1, max_store_bytes=2**40)

    assert outcome["bodies_pruned"] == 0
    assert read_body_for_session("claude-code", "session", input_id)["ok"] is True
    after = inspection_payload("claude-code", "session", "overview")
    assert after["tool_calls"]["items"][0]["result_parts"][0]["status"] == "pruned"
    assert read_body_for_session("claude-code", "session", result_id)["ok"] is True


def test_pruned_session_cannot_read_body_retained_by_other_session(tmp_data_home):
    base = _batch(data=b"durable input")
    old_result = BodyPartInput("result", "result", "available", "text/plain", b"shared", None)
    session_a = replace(
        base,
        tool_calls=(replace(base.tool_calls[0], result_parts=(old_result,)),),
    )
    session_b = replace(
        base,
        source=replace(base.source, source_id="source:b", generation_id="generation:b", source_session_id="session-b"),
        root=replace(base.root, source_session_id="session-b", root_session_id="session-b"),
        runs=(replace(base.runs[0], run_id="run:b", source_session_id="session-b"),),
        tool_calls=(replace(
            base.tool_calls[0],
            call_id="call:b",
            native_call_id="native-b",
            run_id="run:b",
            input_parts=(replace(base.tool_calls[0].input_parts[0], part_id="part:b", bytes_value=b"shared"),),
            result_parts=(),
        ),),
    )
    merge_capture(session_a)
    merge_capture(session_b)
    body_id = _body(inspection_payload("claude-code", "session", "overview"), "result")

    outcome = prune_bodies(older_than=1, max_store_bytes=2**40, now=datetime(2026, 1, 10, tzinfo=timezone.utc))

    assert outcome["parts_pruned"] == 1
    stale = read_body_for_session("claude-code", "session", body_id)
    assert stale["reason"] == "pruned"
    assert stale["pruned_at"] == "2026-01-10T00:00:00+00:00"
    assert read_body_for_session("claude-code", "session-b", body_id)["ok"] is True


def test_shared_body_detaches_old_reference_but_keeps_young_reference(tmp_data_home):
    base = _batch(data=b"shared")
    base = replace(base, tool_calls=(replace(base.tool_calls[0], tool_name="Edit"),))
    merge_capture(base)
    young_tool = replace(
        base.tool_calls[0],
        call_id="call:young",
        native_call_id="native-young",
        at="2026-01-09T00:00:00Z",
    )
    merge_capture(replace(base, source=replace(base.source, expected_revision=1), tool_calls=(young_tool,)))

    outcome = prune_bodies(older_than=2, max_store_bytes=2**40, now=datetime(2026, 1, 10, tzinfo=timezone.utc))

    assert outcome["parts_pruned"] == 1
    payload = inspection_payload("claude-code", "session", "overview")
    parts = {item["id"]: item for item in payload["tool_calls"]["items"]}
    assert parts["call:young"]["input_parts"][0]["status"] == "available"
    assert parts["call:test"]["input_parts"][0]["status"] == "pruned"
    young_body_id = parts["call:young"]["input_parts"][0]["body_id"]
    assert read_body_for_session("claude-code", "session", young_body_id)["ok"] is True


def test_repeated_cap_prune_does_not_reselect_detached_bodies(tmp_data_home):
    base = _batch(data=b"old body")
    merge_capture(replace(base, tool_calls=(replace(base.tool_calls[0], tool_name="Edit"),)))
    second = replace(
        base,
        source=replace(base.source, expected_revision=1),
        tool_calls=(replace(
            base.tool_calls[0], call_id="call:second", native_call_id="native-second", tool_name="Edit",
            input_parts=(replace(base.tool_calls[0].input_parts[0], part_id="part:second"),),
        ),),
    )
    merge_capture(second)
    first = prune_bodies(older_than=10_000, max_store_bytes=0)
    again = prune_bodies(older_than=10_000, max_store_bytes=0)

    assert first["parts_pruned"] == 2
    assert first["bytes_freed"] > 0
    assert again["parts_pruned"] == 0
    assert again["bytes_freed"] == 0


def test_cap_reports_permanent_durable_bytes_even_after_vacuum(tmp_data_home):
    merge_capture(_batch(data=b"durable"))

    outcome = prune_bodies(max_store_bytes=0, vacuum=True)

    assert outcome["bodies_pruned"] == 0
    assert outcome["unmet_target"] is True
    assert outcome["unmet_target_bytes"] > 0


def test_pinned_session_exempts_all_runs_in_its_subtree(tmp_data_home):
    batch = _batch()
    result = BodyPartInput("result", "result", "available", "text/plain", b"old result", None)
    merge_capture(replace(batch, tool_calls=(replace(batch.tool_calls[0], result_parts=(result,)),)))
    from skill_hub.application.usage.usage_inspection import mutate_pin

    assert mutate_pin("claude-code", "session", None, "add")["ok"] is True
    before = inspection_payload("claude-code", "session", "overview")
    result_id = _body(before, "result")
    outcome = prune_bodies(older_than=1, max_store_bytes=2**40)

    assert outcome["bodies_pruned"] == 0
    assert outcome["pinned_exempt"] == 2
    assert read_body_for_session("claude-code", "session", result_id)["ok"] is True


def test_rescan_does_not_rehydrate_a_pruned_part(tmp_data_home):
    batch = _batch()
    result = BodyPartInput("result", "result", "available", "text/plain", b"old result", None)
    first = replace(batch, tool_calls=(replace(batch.tool_calls[0], result_parts=(result,)),))
    merge_capture(first)
    result_id = _body(inspection_payload("claude-code", "session", "overview"), "result")
    prune_bodies(older_than=1, max_store_bytes=2**40)

    replay = replace(first, source=replace(first.source, expected_revision=1))
    assert merge_capture(replay).outcome == "unchanged"
    part = inspection_payload("claude-code", "session", "overview")["tool_calls"]["items"][0]["result_parts"][0]
    assert part["status"] == "pruned"
    assert "body_id" not in part
    assert read_body_for_session("claude-code", "session", result_id)["reason"] == "pruned"


def test_result_age_uses_its_evidence_event_time(tmp_data_home):
    batch = _batch()
    result = BodyPartInput("result", "result", "available", "text/plain", b"late result", None)
    tool = replace(batch.tool_calls[0], at="2026-01-01T00:00:00Z", result_parts=(result,))
    event = EventInput(
        "event:result", "generation:test", "record:result", "2026-01-09T00:00:00Z",
        "tool_result", "hash", "run:test", "native-call",
    )
    merge_capture(replace(batch, tool_calls=(tool,), events=(event,)))
    outcome = prune_bodies(older_than=2, max_store_bytes=2**40, now=datetime(2026, 1, 10, tzinfo=timezone.utc))

    assert outcome["bodies_pruned"] == 0
    result_part = inspection_payload("claude-code", "session", "overview")["tool_calls"]["items"][0]["result_parts"][0]
    assert result_part["status"] == "available"


def test_migration_uses_retained_result_event_time_over_old_call_time(tmp_data_home):
    base = _batch()
    result = BodyPartInput("result", "result", "available", "text/plain", b"old result", None)
    tool = replace(base.tool_calls[0], at="2026-01-01T00:00:00Z", result_parts=(result,))
    old_event = EventInput(
        "event:old-result", "generation:test", "record:old-result", "2026-01-01T00:00:00Z",
        "tool_result", "hash", "run:test", "native-call",
    )
    merge_capture(replace(base, tool_calls=(tool,), events=(old_event,)))
    newer = replace(
        base,
        source=replace(base.source, source_id="source:new", generation_id="generation:new"),
        runs=(replace(base.runs[0], run_id="run:new"),),
        tool_calls=(replace(
            tool,
            run_id="run:new",
            at="2026-01-09T00:00:00Z",
            result_parts=(replace(result, part_id="result:new", bytes_value=b"new result"),),
        ),),
        events=(EventInput(
            "event:new-result", "generation:new", "record:new-result", "2026-01-09T00:00:00Z",
            "tool_result", "hash", "run:new", "native-call",
        ),),
    )
    merge_capture(newer)
    with sqlite3.connect(db_path()) as db:
        db.execute("DROP INDEX IF EXISTS tool_parts_eligibility")
        db.execute("ALTER TABLE tool_parts DROP COLUMN evidenced_at")
        db.execute("UPDATE metadata SET value='1' WHERE key='schema_version'")
        db.commit()

    with InspectionStore.open() as store:
        evidence = {
            row[0]: row[1]
            for row in store.db.execute(
                "SELECT c.run_id,p.evidenced_at FROM tool_parts p "
                "JOIN tool_calls c ON c.call_id=p.call_id WHERE p.side='result'"
            ).fetchall()
        }
    assert evidence["run:test"] == "2026-01-01T00:00:00Z"
    assert evidence["run:new"] == "2026-01-09T00:00:00Z"
    outcome = prune_bodies(older_than=2, max_store_bytes=2**40, now=datetime(2026, 1, 10, tzinfo=timezone.utc))
    assert outcome["parts_pruned"] == 1
    with InspectionStore.open() as store:
        statuses = {
            row[0]: row[1]
            for row in store.db.execute(
                "SELECT c.run_id,p.status FROM tool_parts p "
                "JOIN tool_calls c ON c.call_id=p.call_id WHERE p.side='result'"
            ).fetchall()
        }
    assert statuses["run:test"] == "pruned"
    assert statuses["run:new"] == "available"


def test_migration_keeps_recent_result_when_call_started_long_ago(tmp_data_home):
    base = _batch()
    result = BodyPartInput("result", "result", "available", "text/plain", b"recent result", None)
    tool = replace(base.tool_calls[0], at="2026-01-01T00:00:00Z", result_parts=(result,))
    event = EventInput(
        "event:recent-result", "generation:test", "record:recent-result", "2026-01-09T00:00:00Z",
        "tool_result", "hash", "run:test", "native-call",
    )
    merge_capture(replace(base, tool_calls=(tool,), events=(event,)))
    with sqlite3.connect(db_path()) as db:
        db.execute("DROP INDEX IF EXISTS tool_parts_eligibility")
        db.execute("ALTER TABLE tool_parts DROP COLUMN evidenced_at")
        db.execute("UPDATE metadata SET value='1' WHERE key='schema_version'")
        db.commit()

    with InspectionStore.open() as store:
        evidence = store.db.execute(
            "SELECT evidenced_at FROM tool_parts WHERE side='result'"
        ).fetchone()[0]
    assert evidence == "2026-01-09T00:00:00Z"
    outcome = prune_bodies(older_than=2, max_store_bytes=2**40, now=datetime(2026, 1, 10, tzinfo=timezone.utc))
    assert outcome["parts_pruned"] == 0


def test_replacement_generation_does_not_rehydrate_pruned_patch(tmp_data_home, tmp_path):
    path = tmp_path / "rollout-session.jsonl"

    def write_patch(timestamp: str, content: str) -> None:
        records = [
            {"type": "session_meta", "payload": {"id": "session"}},
            {
                "type": "event_msg",
                "id": "patch-id",
                "timestamp": timestamp,
                "payload": {
                    "type": "patch_apply_end",
                    "success": True,
                    "changes": {"file.txt": content},
                },
            },
        ]
        path.write_text("\n".join(json.dumps(record) for record in records) + "\n")

    write_patch("2026-01-01T00:00:00Z", "old patch")
    first = capture_codex_source(path)
    merge_capture(first)
    with InspectionStore.open() as store:
        cursor = store.source_cursor(first.source.source_id)
        first_change = store.db.execute(
            "SELECT change_id,part_id,body_id,status FROM change_parts"
        ).fetchone()
    assert first_change[3] == "available"
    outcome = prune_bodies(older_than=2, max_store_bytes=2**40, now=datetime(2026, 1, 10, tzinfo=timezone.utc))
    assert outcome["bodies_pruned"] == 1

    write_patch("2026-01-10T00:00:00Z", "replacement patch")
    replacement = capture_codex_source(path, cursor)
    assert replacement.source.generation_id != first.source.generation_id
    assert replacement.changes[0].change_id == first.changes[0].change_id
    assert replacement.changes[0].body_parts[0].part_id != first.changes[0].body_parts[0].part_id
    merge_capture(replacement)

    with InspectionStore.open() as store:
        current = store.db.execute(
            "SELECT part_id,body_id,status FROM change_parts WHERE change_id=?",
            (first_change[0],),
        ).fetchone()
        assert current[0] == first_change[1]
        assert current[1] is None
        assert current[2] == "pruned"


def test_dry_run_old_schema_does_not_write_database_or_migration_backup(tmp_data_home):
    merge_capture(_batch())
    with sqlite3.connect(db_path()) as db:
        db.execute("UPDATE metadata SET value='1' WHERE key='schema_version'")
        db.commit()

    def snapshot() -> dict[str, str]:
        return {
            str(path.relative_to(tmp_data_home)): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in tmp_data_home.rglob("*")
            if path.is_file()
        }

    before = snapshot()
    outcome = prune_bodies(older_than=1, max_store_bytes=2**40, dry_run=True)
    assert outcome == {"ok": False, "reason": "inspection_migration_required"}
    assert snapshot() == before
    assert not db_path().with_name(db_path().name + ".migration-backup").exists()


def test_dry_run_empty_store_does_not_create_files(tmp_data_home):
    before = {str(path.relative_to(tmp_data_home)) for path in tmp_data_home.rglob("*") if path.is_file()}
    assert prune_bodies(dry_run=True)["ok"] is True
    after = {str(path.relative_to(tmp_data_home)) for path in tmp_data_home.rglob("*") if path.is_file()}
    assert after == before
