"""Source append and race contracts through capture and committed store state."""

from __future__ import annotations

import importlib
import json
from pathlib import Path

import pytest

from skill_hub.infrastructure.usage.usage_inspection_store import InspectionStore

SESSION = "aaaaaaaa-1111-4111-8111-111111111111"


def _line(value: dict) -> bytes:
    return (json.dumps(value, separators=(",", ":")) + "\n").encode()


def _records(harness: str) -> tuple[bytes, bytes]:
    at = "2026-09-16T12:00:00Z"
    if harness == "claude":
        start = {
            "type": "assistant",
            "timestamp": at,
            "sessionId": SESSION,
            "message": {
                "id": "message-1",
                "role": "assistant",
                "content": [
                    {"type": "tool_use", "id": "call-1", "name": "Bash", "input": {"command": "printf retained"}}
                ],
            },
        }
        end = {
            "type": "user",
            "timestamp": at,
            "sessionId": SESSION,
            "message": {
                "role": "user",
                "content": [{"type": "tool_result", "tool_use_id": "call-1", "content": "retained"}],
            },
        }
        return _line(start), _line(end)
    meta = {"type": "session_meta", "timestamp": at, "payload": {"id": SESSION}}
    start = {
        "type": "response_item",
        "timestamp": at,
        "payload": {
            "type": "function_call",
            "call_id": "call-1",
            "name": "shell",
            "arguments": '{"command":"printf retained"}',
        },
    }
    end = {
        "type": "response_item",
        "timestamp": at,
        "payload": {"type": "function_call_output", "call_id": "call-1", "output": "retained"},
    }
    return _line(meta) + _line(start), _line(end)


def _parser(harness: str):
    module = importlib.import_module(f"skill_hub.infrastructure.usage.usage_inspection_{harness}")
    return module, getattr(module, f"capture_{harness}_source")


@pytest.mark.parametrize("harness", ["claude", "codex"])
@pytest.mark.parametrize("initial_size", [2048, 4096, 8192])
def test_short_and_boundary_appends_keep_epoch_and_evidence(
    tmp_data_home, tmp_path: Path, harness: str, initial_size: int
):
    _, capture = _parser(harness)
    path = tmp_path / f"{SESSION}.jsonl"
    start, end = _records(harness)
    # JSONL whitespace is valid and makes the previous physical size exact.
    initial = start[:-1] + b" " * (initial_size - len(start)) + b"\n"
    assert len(initial) == initial_size
    path.write_bytes(initial)
    with InspectionStore.open() as store:
        first = capture(path)
        store.merge_capture(first)
        cursor = store.source_cursor(first.source.source_id)
        event_ids = {row[0] for row in store.db.execute("SELECT event_id FROM events")}
        path.write_bytes(initial + end)
        suffix = capture(path, cursor)
        assert suffix.source.generation_id == cursor.generation_id
        assert suffix.source.offset_start == initial_size
        assert suffix.source.offset_end == initial_size + len(end)
        result = store.merge_capture(suffix)
        assert result.bytes_read == len(end)
        assert event_ids <= {row[0] for row in store.db.execute("SELECT event_id FROM events")}
        assert store.db.execute("SELECT COUNT(*) FROM sources").fetchone()[0] == 1
        assert store.db.execute("SELECT COUNT(*) FROM tool_calls").fetchone()[0] == 1
        assert store.db.execute("SELECT COUNT(*) FROM tool_parts WHERE side='result'").fetchone()[0] == 1


@pytest.mark.parametrize("harness", ["claude", "codex"])
@pytest.mark.parametrize("mutation", ["rewrite", "replace", "middle_rewrite"])
def test_changed_source_after_read_cannot_advance_commit(
    tmp_data_home, tmp_path: Path, monkeypatch, harness: str, mutation: str
):
    module, capture = _parser(harness)
    path = tmp_path / f"{SESSION}.jsonl"
    start, end = _records(harness)
    if mutation == "middle_rewrite":
        start = start[:-1] + b" " * 12000 + b"\n"
    path.write_bytes(start)
    with InspectionStore.open() as store:
        first = capture(path)
        store.merge_capture(first)
        cursor = store.source_cursor(first.source.source_id)
        events_before = list(store.db.execute("SELECT event_id FROM events ORDER BY event_id"))
        path.write_bytes(start + end)
        original_read = module.read_complete_suffix

        def racing_read(*args, **kwargs):
            result = original_read(*args, **kwargs)
            if mutation == "middle_rewrite":
                changed = start[:6000] + b"\t" + start[6001:] + end
            else:
                changed = (start + end).replace(b"printf retained", b"printf replaced")
            if mutation == "replace":
                replacement = path.with_suffix(".replacement")
                replacement.write_bytes(changed)
                replacement.replace(path)
            else:
                path.write_bytes(changed)
            return result

        monkeypatch.setattr(module, "read_complete_suffix", racing_read)
        # The capture boundary may reject by exception or return an uncommittable
        # batch; either way, durable evidence and the cursor must stay intact.
        try:
            store.merge_capture(capture(path, cursor))
        except (OSError, ValueError, RuntimeError):
            pass
        assert store.source_cursor(first.source.source_id) == cursor
        assert list(store.db.execute("SELECT event_id FROM events ORDER BY event_id")) == events_before


@pytest.mark.parametrize("harness", ["claude", "codex"])
def test_growth_after_read_commits_only_snapshot_then_captures_tail(
    tmp_data_home, tmp_path: Path, monkeypatch, harness: str
):
    module, capture = _parser(harness)
    path = tmp_path / f"{SESSION}.jsonl"
    start, end = _records(harness)
    path.write_bytes(start)
    with InspectionStore.open() as store:
        first = capture(path)
        store.merge_capture(first)
        cursor = store.source_cursor(first.source.source_id)
        original_read = module.read_complete_suffix

        def growing_read(*args, **kwargs):
            result = original_read(*args, **kwargs)
            path.write_bytes(start + end)
            return result

        with monkeypatch.context() as patch:
            patch.setattr(module, "read_complete_suffix", growing_read)
            snapshot = capture(path, cursor)
        store.merge_capture(snapshot)
        after_snapshot = store.source_cursor(first.source.source_id)
        assert after_snapshot.offset == len(start)
        suffix = capture(path, after_snapshot)
        assert suffix.source.generation_id == cursor.generation_id
        assert suffix.source.offset_start == len(start)
        store.merge_capture(suffix)
        assert store.source_cursor(first.source.source_id).offset == len(start + end)
        assert store.db.execute("SELECT COUNT(*) FROM tool_parts WHERE side='result'").fetchone()[0] == 1


@pytest.mark.parametrize("harness", ["claude", "codex"])
def test_stale_resume_backfill_preserves_partial_tail(tmp_data_home, tmp_path: Path, harness: str):
    _, capture = _parser(harness)
    path = tmp_path / f"{SESSION}.jsonl"
    start, end = _records(harness)
    path.write_bytes(start)
    with InspectionStore.open() as store:
        first = capture(path)
        store.merge_capture(first)
        store.db.execute("UPDATE sources SET resume_version=0 WHERE source_id=?", (first.source.source_id,))
        stale = store.source_cursor(first.source.source_id)
        path.write_bytes(start + end[:-3])
        backfill = capture(path, stale)
        assert backfill.source.offset_end == len(start)
        assert backfill.source.status == "incomplete"
        store.merge_capture(backfill)
        cursor = store.source_cursor(first.source.source_id)
        assert cursor.generation_id == stale.generation_id
        assert cursor.offset == len(start)
        path.write_bytes(start + end)
        completed = capture(path, cursor)
        store.merge_capture(completed)
        assert store.source_cursor(first.source.source_id).offset == len(start + end)
        assert store.db.execute("SELECT COUNT(*) FROM tool_calls").fetchone()[0] == 1
        assert store.db.execute("SELECT COUNT(*) FROM tool_parts WHERE side='result'").fetchone()[0] == 1


def test_expired_source_deadline_does_not_start_revision_git(tmp_data_home, tmp_path, monkeypatch):
    import time

    import skill_hub.infrastructure.usage.usage_capture_io as usage_capture_io

    def unexpected_git(*args, **kwargs):
        raise AssertionError("expired source started Git")

    monkeypatch.setattr(usage_capture_io.subprocess, "run", unexpected_git)
    change = usage_capture_io.capture_revision_patch(
        tmp_path, run_id="run", source_epoch="epoch", source_event_id="event",
        repository_id="repo", revision_id="new", base_id="old",
        deadline=time.monotonic() - 1,
    )
    assert change.body_parts[0].status == "unavailable"
