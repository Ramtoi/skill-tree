"""Canonical Codex rollout capture contracts."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from skill_hub.application.usage.usage_inspection import index_payload, inspection_payload, merge_capture
from skill_hub.infrastructure.usage.usage_inspection_codex import CodexIdentityError, capture_codex_source
from skill_hub.infrastructure.usage.usage_inspection_store import InspectionStore

SESSION = "11111111-2222-4333-8444-555555555555"


def _path(session_id: str = SESSION) -> Path:
    return (
        Path.home() / ".codex" / "sessions" / "2026" / "09" / "01"
        / f"rollout-2026-09-01T10-00-00-{session_id}.jsonl"
    )


def _write(path: Path, records: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(json.dumps(record) for record in records) + "\n")


def _meta(session_id: str, *, parent: str | None = None) -> dict:
    payload = {"id": session_id, "cwd": "/tmp/project"}
    if parent is not None:
        payload["parent_thread_id"] = parent
    return {"type": "session_meta", "payload": payload}


def _token(response_id: str, total: int, *, thread: str = SESSION, at: str = "2026-09-01T10:00:02Z") -> dict:
    # Keep buckets consistent with total_tokens; the canonical reader caps
    # cache-read overlap with input_tokens using the authoritative total.
    quarter = total // 4
    return {
        "timestamp": at,
        "type": "token_usage_record",
        "payload": {
            "response_id": response_id,
            "thread_id": thread,
            "usage": {
                "input_tokens": quarter,
                "output_tokens": quarter + total % 4,
                "cached_input_tokens": quarter,
                "cache_write_input_tokens": quarter,
                "total_tokens": total,
            },
        },
    }


def _merge(path: Path):
    batch = capture_codex_source(path)
    assert merge_capture(batch).outcome == "captured"
    return batch


def test_codex_capture_preserves_identity_tokens_and_redacts_paths(tmp_data_home, tmp_path):
    path = _path()
    private = tmp_path / "secret.py"
    _write(path, [
        _meta(SESSION),
        {"type": "event_msg", "payload": {"type": "user_message", "message": f"inspect {private}"}},
        _token("r1", 100), _token("r2", 200),
    ])
    batch = _merge(path)
    assert batch.source.source_session_id == SESSION
    assert [sample.total for sample in batch.token_samples] == [100, 200]
    overview = inspection_payload("codex", SESSION, "overview")
    assert overview["ok"] is True
    assert overview["session"]["summary"]["own"]["tokens"]["total"] == 300
    encoded = json.dumps(overview)
    assert str(tmp_path) not in encoded and "secret.py" not in encoded


def test_codex_identity_mismatch_is_typed_and_does_not_publish(tmp_data_home):
    path = _path()
    _write(path, [_meta("99999999-2222-4333-8444-555555555555")])
    with pytest.raises(CodexIdentityError) as error:
        capture_codex_source(path)
    assert error.value.kind == "identity_mismatch"
    with InspectionStore.open() as store:
        assert store.db.execute("SELECT COUNT(*) FROM sources").fetchone()[0] == 0


def test_codex_native_tokens_filter_foreign_threads_and_duplicate_samples(tmp_data_home):
    path = _path()
    _write(path, [
        _meta(SESSION), _token("same", 100), _token("same", 100), _token("next", 50),
        _token("foreign", 900, thread="other"),
    ])
    batch = _merge(path)
    assert len(batch.token_samples) == 3
    own = inspection_payload("codex", SESSION, "overview")["session"]["summary"]["own"]["tokens"]
    assert own["total"] == 150
    root = index_payload()["sessions"][0]
    assert root["scopes"]["subtree"]["tokens"]["total"] == 1050


def test_codex_child_scope_is_retained_and_parent_summary_is_idempotent(tmp_data_home):
    child = "33333333-2222-4222-8222-222222222222"
    parent = _path(SESSION)
    child_path = _path(child)
    _write(parent, [_meta(SESSION), _token("root", 10)])
    _write(child_path, [_meta(child, parent=SESSION), _token("child", 40, thread=child)])
    _merge(parent)
    child_batch = _merge(child_path)
    assert child_batch.root.parent_session_id == SESSION
    child_view = inspection_payload("codex", child, "overview")
    assert child_view["ok"] is True
    child_run = next(run for run in child_view["runs"] if run["id"] == child_batch.runs[0].run_id)
    assert child_run["scopes"]["own"]["tokens"]["total"] == 40
    root = index_payload()["sessions"][0]
    assert root["session_id"] == SESSION
    assert root["agents"][0]["session_id"] == child
    assert root["scopes"]["subtree"]["tokens"]["total"] == 50


def test_codex_incremental_append_is_captured_once(tmp_data_home):
    path = _path()
    _write(path, [_meta(SESSION), _token("first", 10)])
    first = _merge(path)
    with path.open("a") as stream:
        stream.write(json.dumps(_token("second", 5)) + "\n")
    with InspectionStore.open() as store:
        cursor = store.source_cursor(first.source.source_id)
    resumed = capture_codex_source(path, cursor)
    assert [sample.total for sample in resumed.token_samples] == [5]
    assert merge_capture(resumed).outcome == "captured"
    assert inspection_payload("codex", SESSION, "overview")["session"]["summary"]["own"]["tokens"]["total"] == 15
    with InspectionStore.open() as store:
        unchanged = capture_codex_source(path, store.source_cursor(first.source.source_id))
    assert merge_capture(unchanged).outcome == "unchanged"


def test_codex_identity_failure_on_append_preserves_cursor(tmp_data_home):
    path = _path()
    _write(path, [_meta(SESSION), {"type": "event_msg", "payload": {"type": "user_message", "message": "first"}}])
    first = _merge(path)
    with path.open("a") as stream:
        stream.write(json.dumps(_meta("99999999-2222-4333-8444-555555555555")) + "\n")
    with InspectionStore.open() as store:
        cursor = store.source_cursor(first.source.source_id)
    with pytest.raises(CodexIdentityError):
        capture_codex_source(path, cursor)
    with InspectionStore.open() as store:
        after = store.source_cursor(first.source.source_id)
    assert after.offset == cursor.offset


def test_codex_event_mirror_is_used_when_native_tokens_are_absent(tmp_data_home):
    path = _path()
    _write(path, [
        _meta(SESSION),
        {"type": "event_msg", "payload": {"type": "token_count", "info": {
            "total_token_usage": {"input_tokens": 20, "output_tokens": 5},
        }}},
    ])
    batch = _merge(path)
    assert [(sample.origin, sample.first_turn_input_total) for sample in batch.token_samples] == [("event_mirror", 20)]
    assert inspection_payload("codex", SESSION, "overview")["session"]["summary"]["own"]["tokens"]["total"] == 25


def test_codex_inherited_parent_tokens_do_not_enter_child_scope(tmp_data_home):
    child = "44444444-2222-4222-8222-222222222222"
    path = _path(child)
    _write(path, [
        _meta(child, parent=SESSION), _token("child", 10, thread=child),
        _token("inherited", 90, thread=SESSION),
    ])
    batch = _merge(path)
    assert [sample.total for sample in batch.token_samples] == [10]
    assert batch.root.parent_session_id == SESSION
    child_run = next(
        run for run in inspection_payload("codex", child, "overview")["runs"]
        if run["id"] == batch.runs[0].run_id
    )
    assert child_run["scopes"]["own"]["tokens"]["total"] == 10


def test_codex_missing_session_meta_token_only_rollout_is_supported(tmp_data_home):
    path = _path()
    _write(path, [_token("token-only", 25)])
    batch = _merge(path)
    assert batch.source.source_session_id == SESSION
    assert inspection_payload("codex", SESSION, "overview")["ok"] is True


def test_portable_codex_identity_error_keeps_kind_without_publication(tmp_data_home, monkeypatch):
    from skill_hub.application.usage import usage_inspection_scan

    path = _path()
    _write(path, [_meta("99999999-2222-4333-8444-555555555555")])
    monkeypatch.setattr(usage_inspection_scan, "_signal_guard_available", lambda: False)

    result = usage_inspection_scan.capture_pass({"codex": path.parent})

    assert len(result["errors"]) == 1
    assert result["errors"][0]["file"] == path.name
    assert result["errors"][0]["kind"] == "identity_mismatch"
    with InspectionStore.open() as store:
        assert store.db.execute("SELECT COUNT(*) FROM sources").fetchone()[0] == 0
