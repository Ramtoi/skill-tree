from __future__ import annotations

import json
import sqlite3
import subprocess
from dataclasses import replace

import pytest

from skill_hub.application.usage.usage_inspection import (
    index_payload,
    inspection_payload,
    list_pins,
    merge_capture,
    mutate_pin,
    prune_bodies,
    read_body_for_session,
)
from skill_hub.domain.usage.usage_inspection_capture import (
    BodyPartInput,
    CaptureBatch,
    ChangeInput,
    EventInput,
    PrInput,
    RootResolution,
    RunInput,
    SourceFingerprint,
    SourceInput,
    TokenSampleInput,
    ToolCallInput,
    body_identity,
    operation_hash,
)
from skill_hub.infrastructure.usage.usage_capture_io import capture_attachment, capture_revision_patch
from skill_hub.infrastructure.usage.usage_inspection_claude import capture_claude_source
from skill_hub.infrastructure.usage.usage_inspection_codex import capture_codex_source
from skill_hub.infrastructure.usage.usage_inspection_store import InspectionStore, InspectionStoreError, db_path


def _batch(revision: int = 0, data: bytes = b"abc") -> CaptureBatch:
    fp = SourceFingerprint(None, None, 3, 1, "prefix", "boundary")
    source = SourceInput("source:test", "claude-code", "session", "generation:test", revision, 0, 3, fp, "active")
    root = RootResolution("claude-code", "session", "session", None, "root")
    run = RunInput("run:test", "session", "native", None, None, (), None, None)
    part = BodyPartInput("part:test", "invocation", "available", "text/plain", data, None)
    tool = ToolCallInput(
        "call:test", "run:test", "native-call", None, "Bash", "local", "git status", "pending", (part,), ()
    )
    return CaptureBatch(1, "2026-01-01T00:00:00Z", root, source, (run,), (), (tool,))


def test_capture_read_and_session_membership(tmp_data_home):
    result = merge_capture(_batch())
    assert result.outcome == "captured"
    payload = inspection_payload("claude-code", "session", "overview")
    body_id = payload["tool_calls"]["items"][0]["input_parts"][0]["body_id"]
    body = read_body_for_session("claude-code", "session", body_id)
    assert body["ok"] is True
    assert body["chunks"][0]["base64"] == "YWJj"
    assert read_body_for_session("claude-code", "other", body_id)["reason"] == "unavailable"


def test_index_projects_native_cost_state_and_canonical_tool_breakdown(tmp_data_home):
    base = _batch()
    run = replace(
        base.runs[0], native_lines_added=7, native_lines_removed=2,
        native_duration_ms=1234, native_branch="feature/canonical",
    )
    second = replace(base.tool_calls[0], call_id="call:second", native_call_id="native-second", tool_name="Read")
    merge_capture(replace(base, runs=(run,), tool_calls=(base.tool_calls[0], second)))
    item = index_payload()["sessions"][0]
    assert item["native"]["own"] == {
        "lines_added": 7, "lines_removed": 2, "duration_ms": 1234,
        "branch": "feature/canonical", "tool_calls": 2,
        "tool_breakdown": [{"name": "Bash", "count": 1}, {"name": "Read", "count": 1}],
        "status": "observed", "field_status": {
            "lines_added": "observed", "lines_removed": "observed", "duration_ms": "observed",
            "branch": "observed", "tool_calls": "observed", "tool_breakdown": "observed",
        },
    }
    assert item["native"]["children"]["status"] == "unavailable"


def test_index_keeps_observed_zero_distinct_from_unavailable_native_facts(tmp_data_home, tmp_path):
    source = tmp_path / "observed-zero.jsonl"
    source.write_text(json.dumps({
        "type": "cost-state", "totalLinesAdded": 0, "totalLinesRemoved": 0, "totalDuration": 0,
    }) + "\n")
    merge_capture(capture_claude_source(source))
    native = index_payload()["sessions"][0]["native"]["own"]
    assert native["lines_added"] == 0
    assert native["duration_ms"] == 0
    assert native["tool_calls"] == 0
    assert native["status"] == "observed"


def test_claude_cost_state_facts_survive_capture_and_body_prune(tmp_data_home, tmp_path):
    path = tmp_path / "native.jsonl"
    records = [
        {"type": "cost-state", "totalLinesAdded": 11, "totalLinesRemoved": 3, "totalDuration": 9000},
        {
            "type": "assistant", "uuid": "a", "timestamp": "2026-01-01T00:00:01Z",
            "message": {
                "content": [{
                    "type": "tool_use", "id": "tool", "name": "Write",
                    "input": {"path": "x", "content": "secret"},
                }],
            },
        },
    ]
    path.write_text("\n".join(json.dumps(item) for item in records) + "\n")
    batch = capture_claude_source(path)
    assert merge_capture(batch).outcome == "captured"
    native = index_payload()["sessions"][0]["native"]["own"]
    assert native["lines_added"] == 11
    assert native["lines_removed"] == 3
    assert native["duration_ms"] == 9000
    assert native["tool_calls"] == 1


def test_index_agent_native_projection_does_not_copy_root_totals(tmp_data_home):
    base = _batch()
    child = RunInput("run:child", "child", "child", "run:test", "agent", (), None, None, (), 4, 1, 50, "child/branch")
    root = replace(base.runs[0], native_lines_added=10, native_duration_ms=100)
    child_tool = replace(base.tool_calls[0], call_id="call:child", run_id="run:child", native_call_id="child-native")
    merge_capture(replace(base, runs=(root,), tool_calls=(base.tool_calls[0],)))
    child_source = replace(
        base.source, source_id="source:child", source_session_id="child", generation_id="generation:child"
    )
    child_root = replace(
        base.root, source_session_id="child", root_session_id="session",
        parent_session_id="session", state="child",
    )
    merge_capture(replace(base, root=child_root, source=child_source, runs=(child,), tool_calls=(child_tool,)))
    item = index_payload()["sessions"][0]
    agent = item["agents"][0]
    assert agent["native"]["own"]["lines_added"] == 4
    assert agent["native"]["own"]["duration_ms"] == 50
    assert item["native"]["own"]["lines_added"] == 10
    assert item["native"]["subtree"]["lines_added"] == 14


def test_native_branch_is_safe_and_legacy_empty_capture_is_unavailable(tmp_data_home, tmp_path):
    path = tmp_path / "unsafe.jsonl"
    path.write_text(json.dumps({"type": "user", "gitBranch": "/workspace/private\\secret"}) + "\n")
    batch = capture_claude_source(path)
    merge_capture(batch)
    native = index_payload()["sessions"][0]["native"]["own"]
    assert native["branch"] is None
    assert native["tool_calls"] == 0
    assert native["field_status"]["tool_calls"] == "observed"


def test_claude_native_cost_state_append_and_prune_keep_latest_projection(tmp_data_home, tmp_path):
    path = tmp_path / "append.jsonl"
    path.write_text(json.dumps({
        "type": "cost-state", "totalLinesAdded": 4,
        "totalLinesRemoved": 1, "totalDuration": 10,
    }) + "\n")
    with path.open("a") as stream:
        for record in [
            {"type": "assistant", "uuid": "call", "timestamp": "2026-01-01T00:00:00Z", "message": {
                "content": [{"type": "tool_use", "id": "read", "name": "Read", "input": {"file_path": "fixture.txt"}}]
            }},
            {"type": "user", "uuid": "result", "timestamp": "2026-01-01T00:00:01Z", "message": {
                "content": [{"type": "tool_result", "tool_use_id": "read", "content": "prunable fixture result"}]
            }},
        ]:
            stream.write(json.dumps(record) + "\n")
    first = capture_claude_source(path)
    merge_capture(first)
    with InspectionStore.open() as store:
        cursor = store.source_cursor(first.source.source_id)
    with path.open("a") as stream:
        stream.write(json.dumps({
            "type": "cost-state", "totalLinesAdded": 9,
            "totalLinesRemoved": 2, "totalDuration": 20,
        }) + "\n")
    merge_capture(capture_claude_source(path, cursor))
    native = index_payload()["sessions"][0]["native"]["own"]
    assert (native["lines_added"], native["lines_removed"], native["duration_ms"]) == (9, 2, 20)
    with InspectionStore.open() as store:
        body_id = store.db.execute(
            "SELECT body_id FROM tool_parts WHERE side='result' AND body_id IS NOT NULL"
        ).fetchone()[0]
        assert store.db.execute("SELECT 1 FROM body_chunks WHERE body_id=?", (body_id,)).fetchone()
    assert prune_bodies(older_than=0, max_store_bytes=2**40)["ok"] is True
    with InspectionStore.open() as store:
        assert store.db.execute("SELECT 1 FROM body_chunks WHERE body_id=?", (body_id,)).fetchone() is None
        assert store.db.execute("SELECT status FROM tool_parts WHERE side='result'").fetchone()[0] == "pruned"
    assert index_payload()["sessions"][0]["native"]["own"]["lines_added"] == 9


def test_schema_v2_migration_backfills_native_facts_once_and_keeps_pin(tmp_data_home, tmp_path):
    path = tmp_path / "migration.jsonl"
    path.write_text(json.dumps({
        "type": "cost-state", "totalLinesAdded": 6,
        "totalLinesRemoved": 2, "totalDuration": 30,
    }) + "\n")
    first = capture_claude_source(path)
    merge_capture(first)
    assert mutate_pin("claude-code", "migration", first.runs[0].run_id, "add")["ok"] is True
    with sqlite3.connect(db_path()) as db:
        db.execute("ALTER TABLE runs DROP COLUMN native_facts")
        db.execute("UPDATE metadata SET value='2' WHERE key='schema_version'")
        db.execute("UPDATE sources SET reader_revision=3")
        db.commit()
    with InspectionStore.open() as store:
        cursor = store.source_cursor(first.source.source_id)
        columns = {row[1] for row in store.db.execute("PRAGMA table_info(runs)")}
    assert "native_facts" in columns
    repaired = merge_capture(capture_claude_source(path, cursor))
    assert repaired.outcome == "captured"
    assert index_payload()["sessions"][0]["native"]["own"]["lines_added"] == 6
    assert list_pins()["items"][0]["run_id"] == first.runs[0].run_id
    with InspectionStore.open() as store:
        cursor = store.source_cursor(first.source.source_id)
    assert merge_capture(capture_claude_source(path, cursor)).outcome == "unchanged"


def test_failed_native_reparse_preserves_last_successful_facts(tmp_data_home, tmp_path, monkeypatch):
    path = tmp_path / "failed-reparse.jsonl"
    path.write_text(json.dumps({
        "type": "cost-state", "totalLinesAdded": 8,
        "totalLinesRemoved": 1, "totalDuration": 40,
    }) + "\n")
    first = capture_claude_source(path)
    merge_capture(first)
    with InspectionStore.open() as store:
        cursor = store.source_cursor(first.source.source_id)
    monkeypatch.setattr(
        "skill_hub.infrastructure.usage.usage_inspection_claude.snapshot_fingerprint_matches", lambda *_args: False
    )
    with pytest.raises(RuntimeError, match="source changed"):
        capture_claude_source(path, cursor)
    native = index_payload()["sessions"][0]["native"]["own"]
    assert (native["lines_added"], native["lines_removed"], native["duration_ms"]) == (8, 1, 40)


def test_disappeared_source_marks_availability_without_erasing_native_facts(tmp_data_home, tmp_path):
    path = tmp_path / "disappeared.jsonl"
    path.write_text(json.dumps({
        "type": "cost-state", "totalLinesAdded": 5,
        "totalLinesRemoved": 0, "totalDuration": 12,
    }) + "\n")
    batch = capture_claude_source(path)
    merge_capture(batch)
    with InspectionStore.open() as store:
        assert store.mark_missing_sources("claude-code", set()) == 1
        store.db.commit()
    item = index_payload()["sessions"][0]
    assert item["status"] == "unavailable"
    assert item["native"]["own"]["lines_added"] == 5
    assert item["native"]["own"]["field_status"]["lines_added"] == "observed"


def test_body_membership_is_harness_qualified_for_tools_and_changes(tmp_data_home):
    base = _batch()
    change_body = BodyPartInput("change-part", "patch", "available", "text/plain", b"patch", None)
    claude = replace(
        base,
        changes=(ChangeInput(
            "change:test", "run:test", "generation:test", "event:test", None,
            "session_edit", "captured", None, None, None, None, (), (change_body,),
        ),),
    )
    merge_capture(claude)
    overview = inspection_payload("claude-code", "session", "overview")
    tool_body = overview["tool_calls"]["items"][0]["input_parts"][0]["body_id"]
    change_body_id = overview["changes"][0]["patch"]["body_id"]
    codex_source = replace(
        base.source, source_id="codex-source:test", harness="codex", generation_id="generation:codex"
    )
    codex_root = replace(base.root, harness="codex")
    codex_run = replace(base.runs[0], run_id="codex-run")
    codex = replace(
        base,
        root=codex_root,
        source=codex_source,
        runs=(codex_run,),
        tool_calls=(replace(
            base.tool_calls[0], run_id="codex-run", call_id="codex-call",
            input_parts=(replace(base.tool_calls[0].input_parts[0], bytes_value=b"codex"),),
        ),),
        changes=(),
    )
    merge_capture(codex)
    assert read_body_for_session("codex", "session", tool_body)["reason"] == "unavailable"
    assert read_body_for_session("codex", "session", change_body_id)["reason"] == "unavailable"


def test_version_one_reads_do_not_create_migration_backup(tmp_data_home, monkeypatch):
    merge_capture(_batch())
    called = False

    def unexpected_backup(_path, _destination):
        nonlocal called
        called = True

    monkeypatch.setattr(InspectionStore, "_backup_database", staticmethod(unexpected_backup))
    assert __import__("skill_hub.application.usage.usage_inspection", fromlist=["*"]).index_payload()["ok"] is True
    assert called is False


def test_codex_parser_repair_replays_unchanged_source_once_and_keeps_pin_body(tmp_data_home, tmp_path):
    path = tmp_path / "rollout-session.jsonl"
    path.write_text("\n".join([
        json.dumps({"type": "session_meta", "payload": {"id": "session"}}),
        json.dumps({"type": "response_item", "payload": {
            "type": "custom_tool_call", "call_id": "call", "name": "shell", "input": "{}"
        }}),
    ]) + "\n")
    batch = capture_codex_source(path)
    assert merge_capture(batch).outcome == "captured"
    body_id = inspection_payload("codex", "session", "overview")["tool_calls"]["items"][0]["input_parts"][0]["body_id"]
    assert mutate_pin("codex", "session", batch.runs[0].run_id, "add")["ok"] is True
    with sqlite3.connect(db_path()) as db:
        db.execute("UPDATE sources SET parser_version=1")
        db.commit()
    cursor = InspectionStore.open().source_cursor(batch.source.source_id)
    repaired = capture_codex_source(path, cursor)
    assert merge_capture(repaired).outcome == "captured"
    assert read_body_for_session("codex", "session", body_id)["ok"] is True
    assert list_pins()["items"][0]["run_id"] == batch.runs[0].run_id
    cursor = InspectionStore.open().source_cursor(batch.source.source_id)
    assert merge_capture(capture_codex_source(path, cursor)).outcome == "unchanged"


def test_body_pages_preserve_binary_chunks_and_pins(tmp_data_home):
    data = ("å" * 40000).encode() + b"\x00\xff"
    # Edit input is tier B, so this exercises paging independently of the
    # durable request-input cap tested by the retention fixtures.
    base = _batch(data=data)
    merge_capture(replace(base, tool_calls=(replace(base.tool_calls[0], tool_name="Edit"),)))
    overview = inspection_payload("claude-code", "session", "overview")
    body_id = overview["tool_calls"]["items"][0]["input_parts"][0]["body_id"]
    first = read_body_for_session("claude-code", "session", body_id, limit_chunks=1)
    second = read_body_for_session("claude-code", "session", body_id, first["next_after_chunk"], 4)
    import base64
    tail = b"".join(base64.b64decode(c["base64"]) for c in second["chunks"])
    assert base64.b64decode(first["chunks"][0]["base64"]) + tail == data
    assert mutate_pin("claude-code", "session", "run:test", "add")["ok"] is True
    assert list_pins()["items"][0]["run_id"] == "run:test"
    assert mutate_pin("claude-code", "session", "run:test", "remove")["ok"] is True


def test_associated_pr_changes_do_not_inflate_run_edit_count(tmp_data_home):
    base = _batch()
    patch = ChangeInput(
        "change:patch", "run:test", "generation:test", "event:patch", "call:test",
        "tool_patch", "confirmed", None, None, None, None, (), (),
    )
    prs = tuple(
        ChangeInput(
            f"change:pr:{number}", "run:test", "generation:test", f"event:pr:{number}", None,
            "pr_change", "associated", "github.com/acme/demo", None, None, None, (), (),
        )
        for number in range(1, 4)
    )
    merge_capture(replace(base, changes=(patch, *prs)))
    run = inspection_payload("claude-code", "session", "overview")["runs"][0]
    assert run["edits"] == 1


def test_tool_pages_follow_recorded_time_before_opaque_id(tmp_data_home):
    base = _batch()
    early = replace(base.tool_calls[0], call_id="call:z", at="2026-01-01T00:00:01Z")
    late = replace(base.tool_calls[0], call_id="call:a", at="2026-01-01T00:00:02Z", native_call_id="late")
    merge_capture(replace(base, tool_calls=(early, late)))
    payload = inspection_payload("claude-code", "session", "tools", limit=1)
    assert [item["at"] for item in payload["tool_calls"]["items"]] == ["2026-01-01T00:00:01Z"]
    next_page = inspection_payload(
        "claude-code", "session", "tools", after=payload["tool_calls"]["next_after"], limit=1
    )
    assert [item["at"] for item in next_page["tool_calls"]["items"]] == ["2026-01-01T00:00:02Z"]


def test_rewritten_tool_body_keeps_prior_bytes_inspectable(tmp_data_home):
    merge_capture(_batch(data=b"old"))
    first = inspection_payload("claude-code", "session", "overview")
    old_id = first["tool_calls"]["items"][0]["input_parts"][0]["body_id"]
    assert merge_capture(_batch(revision=1, data=b"new")).outcome == "captured"
    updated = inspection_payload("claude-code", "session", "overview")
    parts = updated["tool_calls"]["items"][0]["input_parts"]
    assert len(parts) == 2
    assert any(part["retained_version"] for part in parts)
    assert read_body_for_session("claude-code", "session", old_id)["ok"] is True


def test_rewritten_multipart_part_preserves_siblings_and_reactivates_prior_body(tmp_data_home):
    base = _batch()
    content = BodyPartInput("content", "content", "available", "text/plain", b"content", None)
    metadata = BodyPartInput("metadata", "metadata", "available", "application/json", b"{}", None)
    attachment_a = BodyPartInput(
        "attachment-a", "attachment", "available", "text/plain", b"A", "/session/tool-results/a"
    )
    attachment_b = BodyPartInput(
        "attachment-b", "attachment", "available", "text/plain", b"B", "/session/tool-results/b"
    )

    def with_parts(revision: int, attachment: bytes) -> CaptureBatch:
        parts = (content, metadata, replace(attachment_a, bytes_value=attachment), attachment_b)
        tool = replace(base.tool_calls[0], result_parts=parts)
        return replace(base, source=replace(base.source, expected_revision=revision), tool_calls=(tool,))

    merge_capture(with_parts(0, b"A"))
    initial = inspection_payload("claude-code", "session", "overview")["tool_calls"]["items"][0]["result_parts"]
    content_id, metadata_id, attachment_a_id, attachment_b_id = (part["body_id"] for part in initial)
    assert all(part["retained_version"] is False for part in initial)

    merge_capture(with_parts(1, b"A2"))
    rewritten = inspection_payload("claude-code", "session", "overview")["tool_calls"]["items"][0]["result_parts"]
    assert len(rewritten) == 5
    assert [part["retained_version"] for part in rewritten if part["kind"] != "attachment"] == [False, False]
    attachments = [part for part in rewritten if part["kind"] == "attachment"]
    assert sum(part["body_id"] == attachment_a_id and part["retained_version"] for part in attachments) == 1
    assert sum(part["body_id"] == attachment_b_id and not part["retained_version"] for part in attachments) == 1
    new_a_id = body_identity(b"A2")
    assert sum(part["body_id"] == new_a_id and not part["retained_version"] for part in attachments) == 1

    merge_capture(with_parts(2, b"A"))
    returned = inspection_payload("claude-code", "session", "overview")["tool_calls"]["items"][0]["result_parts"]
    assert len(returned) == 5
    assert sum(part["body_id"] == attachment_a_id and not part["retained_version"] for part in returned) == 1
    assert sum(part["body_id"] == new_a_id and part["retained_version"] for part in returned) == 1
    assert sum(part["body_id"] == metadata_id and not part["retained_version"] for part in returned) == 1
    assert sum(part["body_id"] == attachment_b_id and not part["retained_version"] for part in returned) == 1
    for body_id in (content_id, metadata_id, attachment_a_id, attachment_b_id, new_a_id):
        assert read_body_for_session("claude-code", "session", body_id)["ok"] is True


def test_stale_source_revision_requires_retry(tmp_data_home):
    assert merge_capture(_batch()).outcome == "captured"
    stale = merge_capture(_batch())
    assert stale.outcome == "retry_required"
    assert merge_capture(_batch(revision=1)).outcome == "unchanged"


def test_attachment_confinement_accepts_session_root_and_rejects_sibling(tmp_path):
    root = tmp_path / "session"
    results = root / "tool-results"
    results.mkdir(parents=True)
    good = results / "out.txt"
    good.write_bytes(b"result")
    sibling = tmp_path / "sibling" / "out.txt"
    sibling.parent.mkdir()
    sibling.write_bytes(b"private")
    assert capture_attachment(good, results).bytes_value == b"result"
    rejected = capture_attachment(sibling, results)
    assert rejected.status == "unavailable"
    assert rejected.bytes_value is None


def test_attachment_confinement_rejects_symlink_component(tmp_path):
    root = tmp_path / "session" / "tool-results"
    root.mkdir(parents=True)
    private = tmp_path / "private"
    private.mkdir()
    (private / "secret.txt").write_bytes(b"secret")
    (root / "link").symlink_to(private, target_is_directory=True)
    captured = capture_attachment(root / "link" / "secret.txt", root)
    assert captured.status == "unavailable"
    assert captured.bytes_value is None


def test_run_correlated_activity_and_timeline(tmp_data_home):
    batch = _batch()
    events = (
        EventInput("event:start", "generation:test", "start", "2026-01-01T00:00:00Z", "wait_started", "h", "run:test"),
        EventInput("event:end", "generation:test", "end", "2026-01-01T00:00:02Z", "wait_result", "h2", "run:test"),
    )
    merge_capture(CaptureBatch(1, batch.captured_at, batch.root, batch.source, batch.runs, (), (), events))
    payload = inspection_payload("claude-code", "session", "overview")
    run = payload["runs"][0]
    assert run["activity_intervals"] == []
    assert payload["timeline"]["events"][0]["run_id"] == "run:test"
    assert payload["timeline"]["wait_intervals"] == [{
        "start": "2026-01-01T00:00:00Z", "end": "2026-01-01T00:00:02Z", "run_id": "run:test", "status": "observed"
    }]
    assert run["scopes"]["own"]["timing"]["active_ms"] is None


def test_overlapping_tool_activity_is_correlated_and_union_counted(tmp_data_home):
    batch = _batch()
    events = (
        EventInput(
            "event:a:start", "generation:test", "a", "2026-01-01T00:00:00Z",
            "tool_started", "a", "run:test", "a",
        ),
        EventInput(
            "event:b:start", "generation:test", "b", "2026-01-01T00:00:01Z",
            "tool_started", "b", "run:test", "b",
        ),
        EventInput(
            "event:b:end", "generation:test", "b2", "2026-01-01T00:00:03Z",
            "tool_result", "b2", "run:test", "b",
        ),
        EventInput(
            "event:a:end", "generation:test", "a2", "2026-01-01T00:00:04Z",
            "tool_result", "a2", "run:test", "a",
        ),
    )
    merge_capture(CaptureBatch(1, batch.captured_at, batch.root, batch.source, batch.runs, (), (), events))
    run = inspection_payload("claude-code", "session", "overview")["runs"][0]
    assert run["activity_intervals"] == [
        {"start": "2026-01-01T00:00:00Z", "end": "2026-01-01T00:00:04Z", "status": "observed"},
        {"start": "2026-01-01T00:00:01Z", "end": "2026-01-01T00:00:03Z", "status": "observed"},
    ]
    assert run["scopes"]["own"]["timing"]["active_ms"] == 4000


def test_recorded_revision_patch_disables_external_diff(tmp_path, monkeypatch):
    repo = tmp_path / "repo"
    repo.mkdir()
    def git(*args):
        return subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, text=True)
    git("init", "-q")
    git("config", "user.email", "test@example.com")
    git("config", "user.name", "Test")
    (repo / "demo.txt").write_text("before\n")
    git("add", ".")
    git("commit", "-qm", "base")
    base = git("rev-parse", "HEAD").stdout.strip()
    (repo / "demo.txt").write_text("after\n")
    git("commit", "-qam", "head")
    head = git("rev-parse", "HEAD").stdout.strip()
    helper = tmp_path / "external-diff-called"
    script = tmp_path / "external-diff"
    script.write_text(f"#!/bin/sh\ntouch {helper}\nexit 1\n")
    script.chmod(0o700)
    monkeypatch.setenv("GIT_EXTERNAL_DIFF", str(script))
    change = capture_revision_patch(
        repo, run_id="run:test", source_epoch="epoch:test", source_event_id="event:patch",
        repository_id="repo", revision_id=head, base_id=base,
    )
    assert change.attribution == "captured"
    assert change.body_parts[0].bytes_value and b"after" in change.body_parts[0].bytes_value
    assert not helper.exists()


def test_child_external_result_uses_parent_tool_results_root(tmp_path):
    parent = tmp_path / "root"
    child_dir = parent / "subagents"
    results = parent / "tool-results"
    child_dir.mkdir(parents=True)
    results.mkdir()
    attachment = results / "result.txt"
    attachment.write_bytes(b"child output")
    child = child_dir / "agent-a.jsonl"
    records = [
        {"type": "assistant", "uuid": "a", "timestamp": "2026-01-01T00:00:00Z", "isSidechain": True,
         "agentId": "agent-a", "message": {"id": "m", "model": "claude-sonnet-5",
         "usage": {"input_tokens": 1, "output_tokens": 2}, "content": [{"type": "tool_use",
         "id": "tool-a", "name": "Bash", "input": {"command": "cat result.txt"}}]}},
        {"type": "user", "uuid": "b", "timestamp": "2026-01-01T00:00:01Z",
         "message": {"content": [{"type": "tool_result", "tool_use_id": "tool-a",
         "content": "child output"}]}, "toolUseResult": {"persistedOutputPath": str(attachment),
         "stdout": "child output"}},
    ]
    child.write_text("\n".join(json.dumps(item) for item in records) + "\n")
    batch = capture_claude_source(child)
    part = batch.tool_calls[0].result_parts[-1]
    assert part.status == "external_file"
    assert part.bytes_value == b"child output"


def test_many_repository_prs_and_pin_index_survive_reopen(tmp_data_home):
    batch = _batch()
    prs = tuple(
        PrInput(
            f"pr:{index}", "generation:test", f"event:pr:{index}", f"github.com/org{index}/repo",
            index, f"https://github.com/org{index}/repo/pull/{index}", "associated", f"2026-01-01T00:00:{index:02d}Z",
        )
        for index in range(1, 22)
    )
    merge_capture(CaptureBatch(1, batch.captured_at, batch.root, batch.source, batch.runs, (), (), (), (), (), prs))
    index = __import__("skill_hub.application.usage.usage_inspection", fromlist=["*"]).index_payload()
    assert index["sessions"][0]["additional_pr_count"] == 20
    assert mutate_pin("claude-code", "session", None, "add")["ok"] is True
    reopened = list_pins()
    assert reopened["items"][0]["run_id"] is None
    assert "body_id" not in json.dumps(reopened)


def test_pr_projection_deduplicates_evidence_by_repository_and_number(tmp_data_home):
    batch = _batch()
    prs = (
        PrInput(
            "pr:mention", "generation:test", "event:mention", "github.com/acme/demo", 42,
            "https://github.com/acme/demo/pull/42", "associated", "2026-01-01T00:00:01Z",
        ),
        PrInput(
            "pr:created", "generation:test", "event:created", "github.com/acme/demo", 42,
            "https://github.com/acme/demo/pull/42", "created", "2026-01-01T00:00:02Z",
        ),
        PrInput(
            "pr:other", "generation:test", "event:other", "github.com/acme/other", 42,
            "https://github.com/acme/other/pull/42", "associated", "2026-01-01T00:00:03Z",
        ),
    )
    merge_capture(replace(batch, prs=prs))
    overview = inspection_payload("claude-code", "session", "overview")
    assert {(pr["repository_id"], pr["number"]) for pr in overview["prs"]} == {
        ("github.com/acme/demo", 42),
        ("github.com/acme/other", 42),
    }
    demo_pr = next(pr for pr in overview["prs"] if pr["repository_id"] == "github.com/acme/demo")
    assert demo_pr["relationship"] == "created"
    indexed = __import__("skill_hub.application.usage.usage_inspection", fromlist=["*"]).index_payload()["sessions"][0]
    assert indexed["additional_pr_count"] == 1
    assert indexed["latest_pr"]["repository_id"] == "github.com/acme/other"
    assert indexed["latest_pr"]["last_evidenced_at"] == "2026-01-01T00:00:03Z"


def test_known_model_cost_reads_the_bundled_pricing_file(tmp_data_home):
    batch = _batch()
    sample = TokenSampleInput(
        "run:test", "sample:priced", "claude-sonnet-5", 10, 5, 0, 0,
        False, False, batch.captured_at,
    )
    merge_capture(replace(batch, token_samples=(sample,)))
    scope = inspection_payload("claude-code", "session", "overview")["session"]["summary"]["own"]
    assert scope["cost"]["status"] == "known"
    assert scope["cost"]["value"] == pytest.approx(0.00007)


def test_unknown_model_cost_is_unpriced_not_zero(tmp_data_home):
    batch = _batch()
    sample = TokenSampleInput(
        "run:test", "sample:unknown", "future-model", 10, 5, 0, 0,
        False, False, batch.captured_at,
    )
    merge_capture(CaptureBatch(
        1, batch.captured_at, batch.root, batch.source, batch.runs,
        (sample,), (), (), (), (), (),
    ))
    scope = inspection_payload("claude-code", "session", "overview")["session"]["summary"]["own"]
    assert scope["cost"]["value"] is None
    assert scope["cost"]["status"] == "unpriced"


def test_scope_without_token_evidence_stays_unavailable(tmp_data_home):
    merge_capture(_batch())
    summary = inspection_payload("claude-code", "session", "overview")["session"]["summary"]
    assert summary["own"]["tokens"]["status"] == "unavailable"
    assert summary["subtree"]["tokens"]["status"] == "unavailable"


def test_cumulative_token_reset_starts_a_new_accounting_epoch(tmp_data_home):
    first = _batch()
    first_sample = TokenSampleInput(
        "run:test", "sample:first", "future-model", 100, 10, 0, 0, True, False, first.captured_at
    )
    merge_capture(CaptureBatch(
        1, first.captured_at, first.root, first.source, first.runs,
        (first_sample,), first.tool_calls,
    ))
    fp = SourceFingerprint(None, None, 4, 2, "prefix2", "boundary2")
    source = SourceInput("source:test", "claude-code", "session", "generation:test", 1, 3, 4, fp, "active")
    second_sample = TokenSampleInput(
        "run:test", "sample:second", "future-model", 10, 2, 0, 0, True, False, first.captured_at
    )
    merge_capture(CaptureBatch(1, first.captured_at, first.root, source, first.runs, (second_sample,)))
    scope = inspection_payload("claude-code", "session", "overview")["session"]["summary"]["own"]
    assert scope["tokens"]["total"] == 122
    assert scope["tokens"]["status"] == "partial"
    assert scope["evidence"] == [{"kind": "accounting_reset", "status": "observed"}]


def test_failed_codex_patch_preserves_attempted_attribution(tmp_path):
    path = tmp_path / "rollout-session.jsonl"
    records = [
        {"type": "session_meta", "payload": {"id": "session"}},
        {
            "type": "response_item", "payload": {
                "type": "custom_tool_call", "call_id": "patch", "name": "apply_patch",
                "input": "*** Begin Patch\n*** Update File: demo.txt\n*** End Patch",
            },
        },
        {
            "type": "response_item", "payload": {
                "type": "custom_tool_call_output", "call_id": "patch",
                "success": False, "output": "failed",
            },
        },
    ]
    path.write_text("\n".join(json.dumps(record) for record in records) + "\n")
    batch = capture_codex_source(path)
    assert batch.tool_calls[0].execution == "failed"
    assert batch.changes[0].attribution == "attempted"


def test_attachment_confinement_rejects_fifo_without_blocking(tmp_path):
    root = tmp_path / "session" / "tool-results"
    root.mkdir(parents=True)
    fifo = root / "stream"
    __import__("os").mkfifo(fifo)
    captured = capture_attachment(fifo, root)
    assert captured.status == "unavailable"
    assert captured.bytes_value is None


def test_inspection_future_schema_is_rejected_without_migration(tmp_data_home):
    path = db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(path) as db:
        db.execute("CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        db.execute("INSERT INTO metadata VALUES ('schema_version', '999')")
    with pytest.raises(InspectionStoreError) as caught:
        InspectionStore.open()
    assert caught.value.reason == "inspection_version_unsupported"


def test_schema6_migration_preserves_reader_evidence_cursor_and_pass_state(tmp_data_home):
    batch = _batch()
    batch = replace(
        batch,
        source=replace(batch.source, resume_state='{"cursor":"keep"}', resume_version=7),
    )
    assert merge_capture(batch).outcome == "captured"
    pass_id = "scan:schema6"
    evidence = '{"format_fingerprint":"fp","native_format":"claude-jsonl","producer":"claude-code"}'
    with InspectionStore.open() as store:
        store.db.execute(
            "INSERT INTO scan_passes"
            "(scan_id,started_at,updated_at,state,harnesses,reader_bindings,"
            "reader_policy_bindings,capture_context_digest,errors) VALUES (?,?,?,?,?,?,?,?,?)",
            (pass_id, "start", "update", "running", '["claude-code"]',
             '{"claude-code":{"reader":"usage_inspection_claude","revision":1}}',
             "{}", "context:old", "[]"),
        )
        store.db.execute(
            "INSERT INTO reader_policies(binding_digest,policy_json) VALUES (?,?)",
            ("binding:old", '{"reader_id":"usage_inspection_claude"}'),
        )
        store.db.execute(
            "INSERT INTO reader_binding_observations"
            "(source_id,generation_id,binding_digest,source_evidence_json) VALUES (?,?,?,?)",
            (batch.source.source_id, batch.source.generation_id, "binding:old", evidence),
        )
        store.db.execute("UPDATE metadata SET value='6' WHERE key='schema_version'")
        expected_cursor = store.source_cursor(batch.source.source_id)
        expected_pass = store.db.execute(
            "SELECT state,reader_bindings,reader_policy_bindings,capture_context_digest,errors "
            "FROM scan_passes WHERE scan_id=?", (pass_id,)
        ).fetchone()

    with InspectionStore.open() as store:
        cursor = store.source_cursor(batch.source.source_id)
        assert cursor.resume_state == expected_cursor.resume_state == '{"cursor":"keep"}'
        assert cursor.resume_version == expected_cursor.resume_version == 7
        row = store.db.execute(
            "SELECT state,reader_bindings,reader_policy_bindings,capture_context_digest,errors "
            "FROM scan_passes WHERE scan_id=?", (pass_id,)
        ).fetchone()
        assert tuple(row) == tuple(expected_pass)
        assert store.db.execute(
            "SELECT source_evidence_json FROM reader_binding_observations "
            "WHERE binding_digest=?", ("binding:old",)
        ).fetchone()[0] == evidence
        assert store.db.execute("SELECT value FROM metadata WHERE key='schema_version'").fetchone()[0] == "7"
    assert db_path().with_name("inspection.sqlite3.migration-backup").exists()


def test_inspection_corrupt_file_is_preserved(tmp_data_home):
    path = db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    original = b"not a sqlite database"
    path.write_bytes(original)
    assert __import__("skill_hub.application.usage.usage_inspection", fromlist=["*"]).index_payload() == {
        "ok": False,
        "reason": "inspection_corrupt",
    }
    assert path.read_bytes() == original


def test_inspection_migration_failure_restores_sqlite_backup(tmp_data_home, monkeypatch):
    assert merge_capture(_batch()).outcome == "captured"
    assert mutate_pin("claude-code", "session", None, "add")["ok"] is True
    path = db_path()
    body_id = inspection_payload("claude-code", "session", "overview")[
        "tool_calls"
    ]["items"][0]["input_parts"][0]["body_id"]
    with InspectionStore.open() as before_store:
        before_revision = before_store.canonical_revision()
    original_migrate = InspectionStore._migrate
    original_needs_migration = InspectionStore._needs_migration

    def fail(_db):
        _db.execute("UPDATE metadata SET value='999' WHERE key='canonical_revision'")
        raise sqlite3.DatabaseError("injected migration failure")

    monkeypatch.setattr(InspectionStore, "_migrate", staticmethod(fail))
    monkeypatch.setattr(InspectionStore, "_needs_migration", staticmethod(lambda _db: True))
    with pytest.raises(InspectionStoreError) as caught:
        InspectionStore.open()
    assert caught.value.reason == "inspection_corrupt"
    monkeypatch.setattr(InspectionStore, "_migrate", staticmethod(original_migrate))
    monkeypatch.setattr(InspectionStore, "_needs_migration", staticmethod(original_needs_migration))
    with InspectionStore.open() as store:
        assert store.source_cursor("source:test").revision == 1
        assert store.db.execute("SELECT 1 FROM pins WHERE run_id='session'").fetchone() is not None
        assert store.canonical_revision() == before_revision
        assert store.read_body(body_id)["ok"] is True


def test_tool_identity_lookup_has_bounded_work_with_large_history(tmp_data_home):
    """One incoming tool must not visit every previously captured call."""
    with InspectionStore.open() as store:
        store.db.execute("BEGIN")
        signature = operation_hash("git status")
        store.db.executemany(
            "INSERT INTO tool_calls("
            "call_id,run_id,native_call_id,at,tool_name,tool_kind,"
                "operation_signature,operation_summary,collision_of,execution,source_epoch,evidence) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    (f"call:{i}", f"run:{i}", f"native:{i}", None, "Bash", "local", signature, "Bash", None,
                     "pending", "generation:test", "[]")
                    for i in range(5_000)
                ),
        )
        store.db.execute("COMMIT")
        steps = 0

        def budget():
            nonlocal steps
            steps += 100
            return int(steps > 1_000)

        store.db.set_progress_handler(budget, 100)
        try:
            for i in (4_999, 5_000):
                tool = replace(_batch().tool_calls[0], call_id=f"call:{i}",
                               run_id=f"run:{i}", native_call_id=f"native:{i}")
                assert store._call_key(tool) == tool.call_id
        finally:
            store.db.set_progress_handler(None, 0)


def test_existing_capture_gets_lookup_indexes_without_rebuilding_evidence(tmp_data_home, monkeypatch):
    merge_capture(_batch())
    mutate_pin("claude-code", "session", None, "add")
    before = inspection_payload("claude-code", "session", "overview")
    body_id = before["tool_calls"]["items"][0]["input_parts"][0]["body_id"]
    with InspectionStore.open() as store:
        for name in ("tool_calls_run_native", "events_run_at", "events_epoch_at"):
            store.db.execute(f"DROP INDEX IF EXISTS {name}")
        revision = store.canonical_revision()

    def unexpected_backup(*_args):
        pytest.fail("Adding a lookup index must not copy the retained transcript database")

    monkeypatch.setattr(InspectionStore, "_backup_database", staticmethod(unexpected_backup))
    for _ in range(2):
        with InspectionStore.open() as store:
            plan = store.db.execute(
                "EXPLAIN QUERY PLAN SELECT run_id,tool_name,tool_kind,operation_signature "
                "FROM tool_calls WHERE run_id=? AND native_call_id=? ORDER BY rowid LIMIT 1",
                ("run:test", "native-call"),
            ).fetchall()
            assert any("SEARCH tool_calls" in row[3] for row in plan)
            event_indexes = {row[1] for row in store.db.execute("PRAGMA index_list(events)")}
            assert {"events_run_at", "events_epoch_at"} <= event_indexes
            assert store.canonical_revision() == revision
            assert store.read_body(body_id)["chunks"][0]["base64"] == "YWJj"
        assert inspection_payload("claude-code", "session", "overview") == before
        assert list_pins()["items"]


def test_migration_hashes_legacy_operations_and_caps_existing_input(tmp_data_home):
    """Schema v1 metadata is migrated without retaining invocation copies."""
    legacy = _batch(data=b"short")
    merge_capture(legacy)
    path = db_path()
    with sqlite3.connect(path) as db:
        db.row_factory = sqlite3.Row
        body_id = db.execute("SELECT body_id FROM tool_parts WHERE side='input'").fetchone()[0]
        legacy_body = "body:legacy-large"
        value = b"x" * 20_000
        db.execute(
            "INSERT INTO bodies(body_id,status,content_type,total_bytes,pruned_at) VALUES (?,?,?,?,NULL)",
            (legacy_body, "available", "text/plain", len(value)),
        )
        db.execute("INSERT INTO body_chunks(body_id,seq,bytes) VALUES (?,?,?)", (legacy_body, 0, value))
        db.execute("UPDATE tool_parts SET body_id=?,bytes=? WHERE side='input'", (legacy_body, len(value)))
        db.execute(
            "UPDATE tool_calls SET operation_signature=? WHERE call_id=?",
            ('{"command":"secret migration payload"}', legacy.tool_calls[0].call_id),
        )
        db.execute("DROP INDEX IF EXISTS tool_parts_retention")
        db.execute("DROP INDEX IF EXISTS change_parts_retention")
        db.execute("DROP INDEX IF EXISTS tool_parts_eligibility")
        db.execute("DROP INDEX IF EXISTS change_parts_eligibility")
        for table, columns in {
            "sources": (
                "committed_prefix_sha256", "committed_boundary_sha256", "resume_state",
                "resume_version", "reader_id", "reader_revision", "normalization_version",
            ),
            "tool_calls": ("operation_summary", "collision_of"),
            "tool_parts": ("retention_tier", "pruned_at"),
            "change_parts": ("retention_tier", "pruned_at"),
            "bodies": ("pruned_at",),
        }.items():
            for column in columns:
                db.execute(f"ALTER TABLE {table} DROP COLUMN {column}")
        db.execute("DROP TABLE scan_pass_sources")
        db.execute("DROP TABLE scan_passes")
        db.execute("UPDATE metadata SET value='1' WHERE key='schema_version'")
        db.commit()

    with InspectionStore.open() as store:
        call = store.db.execute("SELECT operation_signature,operation_summary FROM tool_calls").fetchone()
        part = store.db.execute("SELECT status,bytes,body_id FROM tool_parts WHERE side='input'").fetchone()
        assert call[0].startswith("op:")
        assert "secret migration payload" not in (call[1] or "")
        assert part[0] == "truncated"
        assert part[1] == 16_384
        assert store.read_body(part[2])["total_bytes"] == 16_384
    assert path.with_name(path.name + ".migration-backup").exists()


def test_native_token_samples_exclude_event_mirrors(tmp_data_home):
    base = _batch()
    samples = (
        TokenSampleInput(
            "run:test", "mirror", "model", 100, 0, 0, 0, False, False,
            base.captured_at, origin="event_mirror",
        ),
        TokenSampleInput(
            "run:test", "native", "model", 7, 3, 0, 0, False, False,
            base.captured_at, origin="native",
        ),
    )
    merge_capture(replace(base, token_samples=samples))
    scope = inspection_payload("claude-code", "session", "overview")["session"]["summary"]["own"]
    assert scope["tokens"]["total"] == 10


@pytest.mark.parametrize("view", ["index", "overview"])
def test_inspection_reads_do_not_scan_unrelated_event_history(tmp_data_home, view):
    merge_capture(_batch())
    with InspectionStore.open() as store:
        def read():
            if view == "index":
                return store.index_payload()
            return store.inspection_payload("claude-code", "session", "overview")

        expected = read()
        store.db.execute("BEGIN")
        store.db.executemany(
            "INSERT INTO events(event_id,source_epoch,source_record_id,at,kind,payload_hash,run_id,correlation_id) "
            "VALUES (?,?,?,?,?,?,?,?)",
            ((f"event:other:{i}", "generation:other", str(i), "2026-01-01T00:00:00Z",
              "tool_started", "hash", "run:other", f"call:other:{i}") for i in range(10_000)),
        )
        store.db.execute("COMMIT")
        steps = 0

        def budget():
            nonlocal steps
            steps += 100
            return int(steps > 10_000)

        store.db.set_progress_handler(budget, 100)
        try:
            assert read() == expected
        finally:
            store.db.set_progress_handler(None, 0)


def _codex_rollout(path, session, tokens, parent=None):
    meta = {"id": session}
    if parent:
        meta["source"] = {"subagent": {"thread_spawn": {"parent_thread_id": parent, "agent_role": "reviewer"}}}
    records = [
        {"type": "session_meta", "payload": meta},
        {
            "type": "response_item",
            "payload": {
                "type": "custom_tool_call",
                "call_id": session + "-call",
                "name": "shell",
                "input": "retained " + session,
            },
        },
        {
            "type": "token_usage_record",
            "payload": {
                "thread_id": session,
                "response_id": session + "-response",
                "usage": {"input_tokens": tokens, "output_tokens": 0},
            },
        },
    ]
    if parent:
        # Forked rollouts can retain their parent's old header after the own
        # header. v1 used that header for IDs and ownership.
        records.insert(1, {"type": "session_meta", "payload": {"id": parent}})
    path.write_text("\n".join(json.dumps(record) for record in records) + "\n")
    return capture_codex_source(path)


def test_codex_native_tokens_win_over_event_mirror_and_skip_parent(tmp_data_home, tmp_path):
    path = tmp_path / "rollout-child.jsonl"
    _codex_rollout(path, "child", 10, "parent")
    with path.open("a") as stream:
        for record in [
            {
                "type": "token_usage_record",
                "payload": {"thread_id": "parent", "response_id": "parent", "usage": {"input_tokens": 90}},
            },
            {
                "type": "token_usage_record",
                "payload": {"thread_id": "child", "response_id": "second", "usage": {"input_tokens": 20}},
            },
            {
                "type": "event_msg",
                "payload": {
                    "type": "token_count",
                    "info": {"total_token_usage": {"input_tokens": 30, "output_tokens": 0}},
                },
            },
        ]:
            stream.write(json.dumps(record) + "\n")
    batch = capture_codex_source(path)
    merge_capture(batch)
    with InspectionStore.open() as store:
        assert store._run_tokens(batch.runs[0].run_id)["tokens"]["tokens"]["total"] == 30
        assert batch.runs[0].role == "reviewer"
        root = store.index_payload()["sessions"][0]
        assert root["session_id"] == "parent"
        assert [(agent["session_id"], agent["run_id"]) for agent in root["agents"]] == [("child", batch.runs[0].run_id)]
        assert root["agents"][0]["native"]["own"]["tool_calls"] == 1


def test_codex_legacy_attribution_repair_preserves_parent_evidence(tmp_data_home, tmp_path):
    parent = _codex_rollout(tmp_path / "rollout-parent.jsonl", "parent", 100)
    child_path = tmp_path / "rollout-child.jsonl"
    child = _codex_rollout(child_path, "child", 20, "parent")
    parent_run = parent.runs[0].run_id
    child_run = child.runs[0].run_id
    # Simulate a v1 capture whose inherited metadata attributed the child to
    # its parent. The old schema did not record sample provenance.
    legacy = replace(
        child,
        root=parent.root,
        source=replace(child.source, source_session_id="parent", parser_version=1),
        runs=parent.runs,
        token_samples=tuple(
            replace(sample, run_id=parent_run, sample_id="legacy-child-sample") for sample in child.token_samples
        ),
        tool_calls=tuple(replace(tool, run_id=parent_run) for tool in child.tool_calls),
    )
    merge_capture(parent)
    merge_capture(legacy)
    mutate_pin("codex", "parent", parent_run, "add")
    with InspectionStore.open() as store:
        bodies = store.db.execute("SELECT body_id FROM tool_parts ORDER BY body_id").fetchall()
        body_values = {row[0]: store.read_body(row[0]) for row in bodies}
        cursor = store.source_cursor(child.source.source_id)
    assert merge_capture(capture_codex_source(child_path, cursor)).outcome == "captured"
    with InspectionStore.open() as store:
        assert store._run_tokens(parent_run)["tokens"]["tokens"]["total"] == 100
        assert store._run_tokens(child_run)["tokens"]["tokens"]["total"] == 20
        assert store.db.execute("SELECT COUNT(*) FROM token_samples WHERE parser_version=1").fetchone()[0] == 1
        assert (
            store.db.execute(
                "SELECT run_id FROM tool_calls WHERE call_id=?", (child.tool_calls[0].call_id,)
            ).fetchone()[0]
            == child_run
        )
        assert {key: store.read_body(key) for key in body_values} == body_values
        assert store.index_payload()["sessions"][0]["scopes"]["subtree"]["tokens"]["total"] == 120
        cursor = store.source_cursor(child.source.source_id)
    assert list_pins()["items"][0]["run_id"] == parent_run
    assert merge_capture(capture_codex_source(child_path, cursor)).outcome == "unchanged"


def test_old_inspection_schema_preserves_missing_codex_source_as_unavailable(tmp_data_home, tmp_path):
    batch = _codex_rollout(tmp_path / "rollout-removed.jsonl", "removed", 40)
    merge_capture(batch)
    mutate_pin("codex", "removed", None, "add")
    with sqlite3.connect(db_path()) as db:
        db.execute("ALTER TABLE sources DROP COLUMN parser_version")
        db.execute("ALTER TABLE token_samples DROP COLUMN source_epoch")
        db.execute("ALTER TABLE token_samples DROP COLUMN parser_version")
    with InspectionStore.open() as store:
        assert store.source_cursor(batch.source.source_id).revision == 1
        scope = store._run_tokens(batch.runs[0].run_id)["tokens"]
        assert scope["tokens"]["status"] == "unavailable"
        assert scope["evidence"] == [{"kind": "legacy_codex_accounting", "status": "unavailable"}]
        assert store.db.execute("SELECT input FROM token_samples").fetchone()[0] == 40
        body_id = store.db.execute("SELECT body_id FROM tool_parts").fetchone()[0]
        assert store.read_body(body_id)["ok"]
    assert list_pins()["items"][0]["root_type"] == "session"


def test_foreign_native_record_does_not_hide_own_event_usage(tmp_data_home, tmp_path):
    path = tmp_path / "rollout-root.jsonl"
    records = [
        {"type": "session_meta", "payload": {"id": "root"}},
        {"type": "token_usage_record", "payload": {
            "thread_id": "child", "response_id": "child-response", "usage": {"input_tokens": 90},
        }},
        {"type": "event_msg", "payload": {"type": "token_count", "info": {
            "total_token_usage": {"input_tokens": 30, "output_tokens": 0},
        }}},
    ]
    path.write_text("\n".join(json.dumps(record) for record in records) + "\n")
    batch = capture_codex_source(path)
    merge_capture(batch)
    with InspectionStore.open() as store:
        assert store._run_tokens(batch.runs[0].run_id)["tokens"]["tokens"]["total"] == 30


def test_incomplete_native_tail_cannot_prove_zero_tool_calls(tmp_data_home, tmp_path):
    path = tmp_path / "incomplete-native.jsonl"
    prefix = json.dumps({"type": "cost-state", "totalLinesAdded": 7}) + "\n"
    tool = json.dumps({"type": "assistant", "uuid": "tool-message", "message": {
        "content": [{"type": "tool_use", "id": "tool", "name": "Read", "input": {"path": "fixture"}}]
    }})
    path.write_text(prefix + tool[:20])
    first = capture_claude_source(path)
    assert merge_capture(first).outcome == "incomplete"
    item = index_payload()["sessions"][0]
    for scope in ("own", "subtree"):
        assert item["native"][scope]["tool_calls"] is None
        assert item["native"][scope]["field_status"]["tool_calls"] == "unavailable"
    with InspectionStore.open() as store:
        cursor = store.source_cursor(first.source.source_id)
    with path.open("a") as stream:
        stream.write(tool[20:] + "\n")
    assert merge_capture(capture_claude_source(path, cursor)).outcome == "captured"
    own = index_payload()["sessions"][0]["native"]["own"]
    assert own["tool_calls"] == 1
    assert own["field_status"]["tool_calls"] == "observed"


def test_native_zero_observation_survives_missing_source(tmp_data_home, tmp_path):
    path = tmp_path / "zero-native.jsonl"
    path.write_text(json.dumps({"type": "cost-state", "totalLinesAdded": 7}) + "\n")
    merge_capture(capture_claude_source(path))
    with InspectionStore.open() as store:
        store.mark_missing_sources("claude-code", set())
        store.db.commit()
    item = index_payload()["sessions"][0]
    assert item["status"] == "unavailable"
    assert item["native"]["own"]["tool_calls"] == 0
    assert item["native"]["own"]["field_status"]["tool_calls"] == "observed"


def test_overview_memo_is_scoped_to_one_payload_build(tmp_data_home):
    """Per-run reads are cached only while one payload is built. The cached
    build must equal an uncached one, and the cache must not outlive it so a
    later capture merge never reads stale token samples."""
    merge_capture(_batch())
    with InspectionStore.open() as store:
        cached = store.inspection_payload("claude-code", "session", "overview")
        assert store._run_tokens_memo is None and store._run_activity_memo is None
        uncached = store._inspection_payload("claude-code", "session", "overview", None, None, 100)
        assert cached == uncached
        indexes = {row[0] for row in store.db.execute("SELECT name FROM sqlite_master WHERE type='index'").fetchall()}
        assert "changes_run_id" in indexes
        explain = store.db.execute("EXPLAIN QUERY PLAN SELECT count(*) FROM changes WHERE run_id=?", ("run:test",))
        plan = [row[3] for row in explain.fetchall()]
        assert any("changes_run_id" in step for step in plan), plan
