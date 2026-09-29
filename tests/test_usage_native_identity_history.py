"""Historical identity repair must preserve evidence and explicit retention."""

from __future__ import annotations

import json
from dataclasses import replace
from datetime import datetime, timezone

from skill_hub.application.usage.usage_inspection import index_payload, merge_capture, mutate_pin, prune_bodies
from skill_hub.infrastructure.usage.usage_inspection_claude import capture_claude_source
from skill_hub.infrastructure.usage.usage_inspection_store import InspectionStore


def _write(path, records):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(record) + "\n" for record in records))


def _records(*, inline=False):
    child = {"isSidechain": True, "agentId": "short-child"} if inline else {}
    return [
        {
            "type": "assistant",
            "uuid": "call-record",
            "timestamp": "2020-01-01T00:00:00Z",
            **child,
            "message": {
                "id": "message-child",
                "usage": {"input_tokens": 71},
                "content": [
                    {"type": "tool_use", "id": "child-call", "name": "Bash", "input": {"command": "echo historical"}},
                ],
            },
        },
        {
            "type": "user",
            "uuid": "result-record",
            "timestamp": "2020-01-01T00:00:01Z",
            **child,
            "message": {
                "content": [{"type": "tool_result", "tool_use_id": "child-call", "content": "historical result"}]
            },
        },
    ]


def _legacy_capture(path):
    batch = capture_claude_source(path)
    return replace(
        batch,
        source=replace(batch.source, reader_revision=4),
        runs=tuple(replace(run, native_ref=None) for run in batch.runs),
        tool_calls=tuple(replace(
            tool,
            input_parts=tuple(replace(part, mirror_part_key=None) for part in tool.input_parts),
            result_parts=tuple(replace(part, mirror_part_key=None) for part in tool.result_parts),
        ) for tool in batch.tool_calls),
        changes=tuple(replace(
            change, body_parts=tuple(replace(part, mirror_part_key=None) for part in change.body_parts),
        ) for change in batch.changes),
    )


def test_legacy_member_pins_and_pruned_parts_survive_reader_identity_repair(tmp_data_home, tmp_path):
    root = tmp_path / "history-root.jsonl"
    child = tmp_path / "history-root" / "subagents" / "agent-short-child.jsonl"
    _write(root, _records(inline=True))
    _write(child, _records())
    legacy = [_legacy_capture(path) for path in (root, child)]
    for batch in legacy:
        assert merge_capture(batch).outcome == "captured"
    child_run = legacy[1].runs[0].run_id
    with InspectionStore.open() as store:
        old_ids = {row[0] for row in store.db.execute("SELECT run_id FROM runs")}
        old_calls = {row[0] for row in store.db.execute("SELECT call_id FROM tool_calls")}
    assert prune_bodies(older_than=1, max_store_bytes=2**40, now=datetime(2030, 1, 1, tzinfo=timezone.utc))["ok"]
    with InspectionStore.open() as store:
        pruned = [
            tuple(row)
            for row in store.db.execute(
                "SELECT call_id,side,ordinal,pruned_at FROM tool_parts "
                "WHERE status='pruned' ORDER BY call_id,side,ordinal"
            )
        ]
        retained_before = {tuple(row) for row in store.db.execute("SELECT body_id,seq,bytes FROM body_chunks")}
    assert pruned, "the fixture must contain actual pruned body rows"
    assert mutate_pin("claude-code", root.stem, child_run, "add")["ok"]
    with InspectionStore.open() as store:
        pins_before = [tuple(row) for row in store.db.execute("SELECT * FROM pins")]
    for path, old_batch in zip((root, child), legacy):
        with InspectionStore.open() as store:
            cursor = store.source_cursor(old_batch.source.source_id)
        replacement = capture_claude_source(path, cursor)
        assert replacement.source.offset_start == 0
        assert merge_capture(replacement).outcome == "captured"
    with InspectionStore.open() as store:
        assert old_ids <= {row[0] for row in store.db.execute("SELECT run_id FROM runs")}
        assert old_calls <= {row[0] for row in store.db.execute("SELECT call_id FROM tool_calls")}
        assert [tuple(row) for row in store.db.execute("SELECT * FROM pins")] == pins_before
        for call, side, ordinal, pruned_at in pruned:
            part = store.db.execute(
                "SELECT status,body_id,pruned_at FROM tool_parts WHERE call_id=? AND side=? AND ordinal=?",
                (call, side, ordinal),
            ).fetchone()
            assert tuple(part) == ("pruned", None, pruned_at)
        assert {tuple(row) for row in store.db.execute("SELECT body_id,seq,bytes FROM body_chunks")} == retained_before
        assert store.inspection_payload("claude-code", root.stem, run_id=child_run)["ok"]
    item = index_payload()["sessions"][0]
    assert len(item["agents"]) == 1
    assert item["scopes"]["children"]["tokens"]["total"] == 71


def test_new_mirror_inherits_exact_pruned_part_without_restoring_bytes(tmp_data_home, tmp_path):
    root = tmp_path / "mirror-root.jsonl"
    child = tmp_path / "mirror-root" / "subagents" / "agent-short-child.jsonl"
    _write(root, _records(inline=True))
    merge_capture(capture_claude_source(root))
    prune_bodies(older_than=1, max_store_bytes=2**40, now=datetime(2030, 1, 1, tzinfo=timezone.utc))
    _write(child, _records())
    merge_capture(capture_claude_source(child))
    with InspectionStore.open() as store:
        payload = store.inspection_payload("claude-code", root.stem)
        parts = payload["tool_calls"]["items"][0]["result_parts"]
        assert len(parts) == 1
        assert parts[0]["status"] == "pruned"
        assert "body_id" not in parts[0]
        assert parts[0]["pruned_at"] == "2030-01-01T00:00:00+00:00"
        assert store.db.execute("SELECT count(*) FROM tool_parts WHERE status='pruned'").fetchone()[0] == 2


def test_same_result_in_changed_operation_is_not_suppressed(tmp_data_home, tmp_path):
    root = tmp_path / "mirror-root.jsonl"
    child = tmp_path / "mirror-root" / "subagents" / "agent-short-child.jsonl"
    _write(root, _records(inline=True))
    merge_capture(capture_claude_source(root))
    prune_bodies(older_than=1, max_store_bytes=2**40, now=datetime(2030, 1, 1, tzinfo=timezone.utc))
    records = _records()
    records[0]["message"]["content"][0]["input"]["command"] = "echo different-operation"
    _write(child, records)
    merge_capture(capture_claude_source(child))
    with InspectionStore.open() as store:
        payload = store.inspection_payload("claude-code", root.stem)
        part = payload["tool_calls"]["items"][0]["result_parts"][0]
        assert part["status"] == "available"
        assert store.body_access_for_session("claude-code", root.stem, part["body_id"]) == ("available", None)


def test_same_native_child_and_result_under_other_root_remain_available(tmp_data_home, tmp_path):
    first = tmp_path / "first" / "subagents" / "agent-short-child.jsonl"
    other = tmp_path / "other" / "subagents" / "agent-short-child.jsonl"
    _write(first, _records())
    merge_capture(capture_claude_source(first))
    prune_bodies(older_than=1, max_store_bytes=2**40, now=datetime(2030, 1, 1, tzinfo=timezone.utc))
    _write(other, _records())
    merge_capture(capture_claude_source(other))
    with InspectionStore.open() as store:
        payload = store.inspection_payload("claude-code", "other")
        part = payload["tool_calls"]["items"][0]["result_parts"][0]
        assert part["status"] == "available"
        assert store.body_access_for_session("claude-code", "other", part["body_id"]) == ("available", None)
        assert store.body_access_for_session("claude-code", "first", part["body_id"])[0] == "pruned"


def test_unkeyed_mirror_is_unavailable_after_known_prune(tmp_data_home, tmp_path):
    root = tmp_path / "mirror-root.jsonl"
    child = tmp_path / "mirror-root" / "subagents" / "agent-short-child.jsonl"
    _write(root, _records(inline=True))
    merge_capture(capture_claude_source(root))
    prune_bodies(older_than=1, max_store_bytes=2**40, now=datetime(2030, 1, 1, tzinfo=timezone.utc))
    records = _records()
    records[1].pop("uuid")
    _write(child, records)
    merge_capture(capture_claude_source(child))
    with InspectionStore.open() as store:
        payload = store.inspection_payload("claude-code", root.stem)
        part = payload["tool_calls"]["items"][0]["result_parts"][0]
        assert part["status"] == "unavailable"
        assert "body_id" not in part
        assert payload["evidence"]["status"] == "partial"
        assert "retention provenance" in payload["evidence"]["notices"][0]


def test_tool_patch_mirror_keeps_change_body_pruned(tmp_data_home, tmp_path):
    root = tmp_path / "patch-root.jsonl"
    child = tmp_path / "patch-root" / "subagents" / "agent-short-child.jsonl"

    def records(inline):
        result = _records(inline=inline)
        call = result[0]["message"]["content"][0]
        call["name"] = "Write"
        call["input"] = {"file_path": "example.py", "content": "new content"}
        return result

    _write(root, records(True))
    merge_capture(capture_claude_source(root))
    prune_bodies(older_than=1, max_store_bytes=2**40, now=datetime(2030, 1, 1, tzinfo=timezone.utc))
    with InspectionStore.open() as store:
        retained = {tuple(row) for row in store.db.execute("SELECT body_id,seq,bytes FROM body_chunks")}
    _write(child, records(False))
    merge_capture(capture_claude_source(child))
    with InspectionStore.open() as store:
        selected = store._session_rows("claude-code", root.stem)
        child_id = next(row["run_id"] for row in selected if row["parent_run_id"])
        parts = store.db.execute(
            "SELECT p.status,p.body_id FROM change_parts p JOIN changes c ON c.change_id=p.change_id WHERE c.run_id=?",
            (child_id,),
        ).fetchall()
        assert parts
        assert all(tuple(part) == ("pruned", None) for part in parts)
        assert {tuple(row) for row in store.db.execute("SELECT body_id,seq,bytes FROM body_chunks")} == retained


def _write_records():
    records = _records()
    call = records[0]["message"]["content"][0]
    call["name"] = "Write"
    call["input"] = {"file_path": "example.py", "content": "new content"}
    return records


def test_legacy_dangling_change_parts_stay_unavailable_on_reparse(tmp_data_home, tmp_path):
    source = tmp_path / "legacy-write.jsonl"
    _write(source, _write_records())
    old = _legacy_capture(source)
    merge_capture(old)
    with InspectionStore.open() as store:
        body = store.db.execute("SELECT body_id FROM tool_parts WHERE side='result'").fetchone()[0]
        store.db.execute("DELETE FROM body_chunks WHERE body_id=?", (body,))
        store.db.execute("DELETE FROM bodies WHERE body_id=?", (body,))
        cursor = store.source_cursor(old.source.source_id)
    merge_capture(capture_claude_source(source, cursor))
    with InspectionStore.open() as store:
        assert store.db.execute("SELECT 1 FROM body_chunks WHERE body_id=?", (body,)).fetchone() is None
        parts = store.db.execute(
            "SELECT status,body_id FROM change_parts WHERE tombstone_body_id=?", (body,),
        ).fetchall()
        assert parts and all(tuple(part) == ("unavailable", None) for part in parts)
        evidence = store.inspection_payload("claude-code", source.stem)["evidence"]
        assert evidence["status"] == "partial"
        assert "retention provenance" in evidence["notices"][0]


def test_current_reader_backfills_exact_retained_part_keys(tmp_data_home, tmp_path):
    source = tmp_path / "legacy-write.jsonl"
    _write(source, _write_records())
    old = _legacy_capture(source)
    merge_capture(old)
    with InspectionStore.open() as store:
        for table in ("tool_parts", "change_parts"):
            keys = store.db.execute(f"SELECT mirror_part_key FROM {table}").fetchall()
            assert keys and all(row[0] is None for row in keys)
        cursor = store.source_cursor(old.source.source_id)
    merge_capture(capture_claude_source(source, cursor))
    with InspectionStore.open() as store:
        for table in ("tool_parts", "change_parts"):
            keys = store.db.execute(f"SELECT mirror_part_key FROM {table}").fetchall()
            assert keys and all(row[0] for row in keys)


def test_migration_restores_part_provenance_columns_in_both_tables(tmp_data_home):
    import sqlite3

    from skill_hub.infrastructure.usage.usage_inspection_store import db_path

    with InspectionStore.open():
        pass
    with sqlite3.connect(db_path()) as connection:
        for table in ("tool_parts", "change_parts"):
            for column in ("mirror_part_key", "tombstone_body_id"):
                connection.execute(f"ALTER TABLE {table} DROP COLUMN {column}")
    with InspectionStore.open() as store:
        for table in ("tool_parts", "change_parts"):
            columns = {row[1] for row in store.db.execute(f"PRAGMA table_info({table})")}
            assert {"mirror_part_key", "tombstone_body_id"} <= columns
