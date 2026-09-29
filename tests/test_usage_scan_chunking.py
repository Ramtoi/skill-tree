from __future__ import annotations

import json
import os
import time
from contextlib import nullcontext
from pathlib import Path

import pytest

from skill_hub import hub_core
from skill_hub.infrastructure.usage import usage_scan


def _blocking_worker(
    harness: str, path: str, cursor, deadline: float, result_path: str, reader_ref
) -> None:
    del harness, path, cursor, deadline, result_path, reader_ref
    time.sleep(30)


def _blocking_resolve_worker(*args) -> None:
    del args
    time.sleep(30)


def _source(path: Path, session_id: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    records = [
        {
            "type": "user",
            "uuid": f"{session_id}-user",
            "timestamp": "2026-01-01T00:00:00Z",
            "sessionId": session_id,
            "cwd": "/workspace",
            "message": {"role": "user", "content": "hello"},
        },
        {
            "type": "assistant",
            "uuid": f"{session_id}-assistant",
            "timestamp": "2026-01-01T00:00:01Z",
            "sessionId": session_id,
            "cwd": "/workspace",
            "message": {
                "id": f"message-{session_id}",
                "model": "fixture-model",
                "role": "assistant",
                "content": [{"type": "text", "text": "done"}],
                "usage": {"input_tokens": 1, "output_tokens": 1},
            },
        },
    ]
    path.write_text("".join(json.dumps(record) + "\n" for record in records))


def _use_direct_reader_path(monkeypatch):
    """Keep in-process test doubles local without requiring POSIX signals.

    Real signal timeouts and spawned worker isolation have separate tests.
    """
    from skill_hub.application.usage import usage_inspection_scan

    monkeypatch.setattr(usage_inspection_scan, "_signal_guard_available", lambda: True)
    monkeypatch.setattr(
        usage_inspection_scan, "_source_guard",
        lambda seconds: nullcontext(time.monotonic() + seconds),
    )


def test_chunks_resume_one_pass_and_unchanged_sources_do_not_consume_quota(tmp_data_home):
    (hub_core.data_home() / "registry.yaml").write_text(
        "version: '1'\nharnesses_global: []\nprojects: {}\nskills: {}\nbundles: {}\n"
    )
    root = Path(os.environ["SKILL_HUB_CLAUDE_HOME"]) / "projects" / "-usage-chunking"
    paths = []
    for index in range(3):
        session_id = f"{index + 1:08d}-1111-4111-8111-111111111111"
        path = root / f"{session_id}.jsonl"
        _source(path, session_id)
        os.utime(path, ns=(10_000_000_000 + index, 20_000_000_000 + index))
        paths.append(path)

    first = usage_scan.scan_sessions(max_sources=2, order="path")
    inspection = first["inspection"]
    assert first["ok"] is True
    assert inspection["sources_total"] == 3
    assert inspection["sources_done"] == 2
    assert inspection["sources_pending"] == 1
    assert inspection["sources_incomplete"] == 0
    assert inspection["sources_skipped_unchanged"] == 0

    second = usage_scan.scan_sessions(max_sources=2, order="path", scan_id=inspection["scan_id"])
    resumed = second["inspection"]
    assert second["ok"] is True
    assert resumed["sources_total"] == 3
    assert resumed["sources_done"] == 3
    assert resumed["sources_pending"] == 0
    assert resumed["sources_incomplete"] == 0
    assert resumed["sources_skipped_unchanged"] == 2
    assert resumed["bytes_read"] == paths[2].stat().st_size


def _inventory(count: int) -> list[Path]:
    (hub_core.data_home() / "registry.yaml").write_text("version: '1'\nprojects: {}\nskills: {}\nbundles: {}\n")
    paths = []
    for index in range(count):
        session = f"{index + 1:08d}-1111-4111-8111-111111111111"
        path = Path(os.environ["SKILL_HUB_CLAUDE_HOME"]) / "projects" / "-chunks" / f"{session}.jsonl"
        _source(path, session)
        os.utime(path, ns=((count - index) * 10**9, (count - index) * 10**9))
        paths.append(path)
    return paths


def test_portable_capture_forwards_the_selected_reader_reference(tmp_data_home, monkeypatch):
    _inventory(1)
    from skill_hub.application.usage import usage_inspection_scan
    from skill_hub.infrastructure.usage import usage_inspection_claude

    original_parse = usage_inspection_scan._portable_parse
    observed = []
    seeds = []

    def portable_parse(
        harness,
        path,
        cursor,
        seconds,
        *,
        worker_target=usage_inspection_scan._portable_parse_worker,
        reader_ref=None,
        probe_seed=None,
    ):
        observed.append(reader_ref)
        seeds.append(probe_seed)
        return original_parse(
            harness,
            path,
            cursor,
            seconds,
            worker_target=worker_target,
            reader_ref=reader_ref,
            probe_seed=probe_seed,
        )

    monkeypatch.setattr(usage_inspection_scan, "_signal_guard_available", lambda: False)
    monkeypatch.setattr(usage_inspection_scan, "_portable_parse", portable_parse)
    result = usage_scan.scan_sessions(harness="claude-code", budget_seconds=10)["inspection"]

    assert result["state"] == "complete"
    assert len(observed) == 1
    assert observed[0].reader_id == usage_inspection_claude.READER_ID
    assert observed[0].revision == usage_inspection_claude.READER_REVISION
    assert observed[0].contract_version == usage_inspection_claude.CAPTURE_CONTRACT_VERSION
    assert seeds[0] is not None
    assert seeds[0].source_id.startswith("claude-code:")
    assert seeds[0].snapshot is not None


def test_five_sources_three_chunks_one_connection_and_one_retention_pass(tmp_data_home, monkeypatch):
    from skill_hub.application.usage import usage_summary_export
    from skill_hub.infrastructure.usage.usage_inspection_store import InspectionStore

    _inventory(5)
    opens = []
    projections = []
    prunes = []
    open_store = InspectionStore.open.__func__
    project = usage_summary_export.refresh_and_export
    prune = InspectionStore.prune_bodies

    def opened(cls):
        opens.append(True)
        return open_store(cls)

    def projected(store, **kwargs):
        projections.append(store)
        return project(store, **kwargs)

    def pruned(self, **kwargs):
        prunes.append(kwargs)
        return prune(self, **kwargs)

    monkeypatch.setattr(InspectionStore, "open", classmethod(opened))
    monkeypatch.setattr(usage_summary_export, "refresh_and_export", projected)
    monkeypatch.setattr(InspectionStore, "prune_bodies", pruned)
    scan_id = None
    for done, pending in ((2, 3), (4, 1), (5, 0)):
        before = len(opens)
        result = usage_scan.scan_sessions(harness="claude-code", max_sources=2, scan_id=scan_id)["inspection"]
        scan_id = result["scan_id"]
        assert (result["sources_done"], result["sources_pending"], result["sources_incomplete"]) == (done, pending, 0)
        assert len(opens) - before == result["store_opens"] == 1
    assert len(projections) == 3
    assert all(store is not None for store in projections)
    assert len(prunes) == 1
    assert result["state"] == "complete"
    unchanged = usage_scan.scan_sessions(harness="claude-code", scan_id=scan_id)["inspection"]
    assert unchanged["bytes_read"] == 0
    assert unchanged["sources_processed"] == 0
    assert unchanged["sources_skipped_unchanged"] == 5
    assert len(prunes) == 1


def test_host_guard_interrupts_a_blocked_source_and_keeps_healthy_work(tmp_data_home, monkeypatch):
    paths = _inventory(2)
    from skill_hub.application.usage import usage_inspection_scan

    original_parse = usage_inspection_scan._portable_parse

    def portable_parse(
        harness,
        path,
        cursor,
        seconds,
        *,
        worker_target=usage_inspection_scan._portable_parse_worker,
        reader_ref=None,
    ):
        target = _blocking_worker if path == paths[0] else worker_target
        return original_parse(
            harness,
            path,
            cursor,
            min(seconds, 0.2) if path == paths[0] else seconds,
            worker_target=target,
            reader_ref=reader_ref,
        )

    monkeypatch.setattr(usage_inspection_scan, "_signal_guard_available", lambda: False)
    monkeypatch.setattr(usage_inspection_scan, "_portable_parse", portable_parse)
    started = time.monotonic()
    # Give the healthy spawned worker a realistic startup budget; the blocked
    # worker remains capped at 0.2s by the process-safe seam above.
    first = usage_scan.scan_sessions(harness="claude-code", budget_seconds=5.0)["inspection"]
    assert time.monotonic() - started < 3
    assert (first["sources_done"], first["sources_pending"], first["sources_incomplete"]) == (1, 0, 1)
    assert first["errors"][0]["kind"] == "TimeoutError"
    assert first["errors"][0]["file"] == paths[0].name
    assert first["errors"][0]["last_successful_cursor"]["offset"] == 0
    assert first["state"] == "stopped"
    continued = usage_scan.scan_sessions(harness="claude-code", scan_id=first["scan_id"])["inspection"]
    assert continued["sources_processed"] == 0
    assert continued["sources_incomplete"] == 1
    assert continued["errors"] == first["errors"]


def test_portable_preflight_bounds_blocked_probe_and_keeps_healthy_work(
    tmp_data_home, monkeypatch
):
    paths = _inventory(2)
    from skill_hub.application.usage import usage_inspection_scan

    original = usage_inspection_scan._portable_resolve_generation

    def resolve(store, scan_id, catalog, source, cursor, seconds):
        if source.path == paths[0]:
            return usage_inspection_scan._portable_call(
                min(seconds, 0.2),
                worker_target=_blocking_resolve_worker,
                worker_args=lambda deadline, result_path: (deadline, result_path),
            )
        return original(store, scan_id, catalog, source, cursor, seconds)

    monkeypatch.setattr(usage_inspection_scan, "_signal_guard_available", lambda: False)
    monkeypatch.setattr(usage_inspection_scan, "_portable_resolve_generation", resolve)
    started = time.monotonic()
    result = usage_scan.scan_sessions(harness="claude-code", budget_seconds=5)["inspection"]

    assert time.monotonic() - started < 3
    assert (result["sources_done"], result["sources_incomplete"]) == (1, 1)
    assert result["errors"][0]["kind"] == "TimeoutError"


def test_preflight_seed_decodes_unchanged_prefix_once(tmp_data_home, monkeypatch):
    _inventory(1)
    _use_direct_reader_path(monkeypatch)
    from skill_hub.infrastructure.usage import usage_reader_context

    decode = usage_reader_context.decode_jsonl_records
    calls = 0

    def counted(*args, **kwargs):
        nonlocal calls
        calls += 1
        return decode(*args, **kwargs)

    monkeypatch.setattr(usage_reader_context, "decode_jsonl_records", counted)
    result = usage_scan.scan_sessions(harness="claude-code")["inspection"]

    assert result["state"] == "complete"
    assert calls == 1


@pytest.mark.parametrize("signal_path", [False, True])
def test_zero_budget_starts_no_probe_or_capture_work(tmp_data_home, monkeypatch, signal_path):
    paths = _inventory(2)
    from skill_hub.application.usage import usage_inspection_scan

    def forbidden(*args, **kwargs):
        pytest.fail("zero-budget scan started probe or capture work")

    monkeypatch.setattr(usage_inspection_scan, "_signal_guard_available", lambda: signal_path)
    monkeypatch.setattr(usage_inspection_scan, "_resolve_generation_reader", forbidden)
    monkeypatch.setattr(usage_inspection_scan, "_portable_resolve_generation", forbidden)
    monkeypatch.setattr(usage_inspection_scan, "_portable_parse", forbidden)
    result = usage_scan.scan_sessions(budget_seconds=0)["inspection"]
    assert result["state"] == "stopped"
    assert (result["sources_done"], result["sources_pending"], result["sources_incomplete"]) == (0, 0, 2)
    assert {error["file"] for error in result["errors"]} == {path.name for path in paths}
    assert {error["kind"] for error in result["errors"]} == {"TimeoutError"}


def test_signal_preflight_timeout_is_not_retried_as_legacy(tmp_data_home, monkeypatch):
    import hashlib

    from skill_hub.application.usage import usage_inspection_scan
    from skill_hub.infrastructure.usage import usage_inspection_claude

    if not usage_inspection_scan._signal_guard_available():
        pytest.skip("signal guard is unavailable on this platform")
    paths = _inventory(2)
    blocked_id = "claude-code:" + hashlib.sha256(str(paths[0]).encode()).hexdigest()
    recognize = usage_inspection_claude.recognize_source
    guard = usage_inspection_scan._source_guard
    blocked_calls = 0
    guard_calls = 0

    def bounded_guard(seconds):
        nonlocal guard_calls
        guard_calls += 1
        return guard(0.03 if guard_calls == 1 else seconds)

    def blocked(probe):
        nonlocal blocked_calls
        if probe.source_id == blocked_id:
            blocked_calls += 1
            time.sleep(0.1)
        return recognize(probe)

    monkeypatch.setattr(usage_inspection_scan, "_source_guard", bounded_guard)
    monkeypatch.setattr(usage_inspection_claude, "recognize_source", blocked)
    result = usage_scan.scan_sessions(harness="claude-code", order="path", budget_seconds=5)["inspection"]
    assert blocked_calls == 1
    assert (result["sources_done"], result["sources_incomplete"]) == (1, 1)
    assert result["errors"][0]["kind"] == "TimeoutError"


@pytest.mark.parametrize("malformed_type", [{}, []])
def test_malformed_type_before_valid_claude_records_does_not_abort_scan(
    tmp_data_home, malformed_type
):
    path = _inventory(1)[0]
    path.write_text(json.dumps({"type": malformed_type}) + "\n" + path.read_text())
    result = usage_scan.scan_sessions(harness="claude-code")["inspection"]
    assert result["state"] == "complete"
    assert result["sources_done"] == 1


def test_transient_probe_change_is_source_local_and_healthy_source_completes(
    tmp_data_home, monkeypatch
):
    paths = _inventory(2)
    from skill_hub.application.usage import usage_inspection_scan

    _use_direct_reader_path(monkeypatch)
    from skill_hub.domain.usage.usage_inspection_capture import SourceChangedError

    original = usage_inspection_scan._resolve_generation_reader
    changed_source = f"claude-code:{__import__('hashlib').sha256(str(paths[0]).encode()).hexdigest()}"

    def resolve(store, scan_id, catalog, source, cursor, deadline):
        if source.source_id == changed_source:
            raise SourceChangedError("controlled source change")
        return original(store, scan_id, catalog, source, cursor, deadline)

    monkeypatch.setattr(usage_inspection_scan, "_resolve_generation_reader", resolve)
    result = usage_scan.scan_sessions(harness="claude-code", order="path")["inspection"]

    assert result["state"] == "stopped"
    assert (result["sources_done"], result["sources_incomplete"]) == (1, 1)
    assert result["errors"][0]["kind"] == "SourceChangedError"


def test_preflight_permission_error_is_source_local_and_healthy_source_completes(
    tmp_data_home, monkeypatch
):
    paths = _inventory(2)
    from skill_hub.application.usage import usage_inspection_scan

    _use_direct_reader_path(monkeypatch)

    probe = usage_inspection_scan.probe_source
    blocked_name = paths[0].name

    def permission(host, deadline=None):
        if host.source_path.name == blocked_name:
            raise PermissionError("controlled preflight denial")
        return probe(host, deadline=deadline)

    monkeypatch.setattr(usage_inspection_scan, "probe_source", permission)
    result = usage_scan.scan_sessions(harness="claude-code", order="path")["inspection"]

    assert result["state"] == "stopped"
    assert (result["sources_done"], result["sources_incomplete"]) == (1, 1)
    assert result["errors"][0]["kind"] == "PermissionError"


def test_cancelled_pass_resumes_and_completed_bookkeeping_retires(tmp_data_home, monkeypatch):
    from skill_hub.application.usage import usage_inspection
    from skill_hub.infrastructure.usage.usage_inspection_store import InspectionStore

    _inventory(3)
    capture = usage_inspection.capture_scan_source
    attempts = 0

    def interrupted(source, build, store=None, reader_policy=None, enrichment=None):
        nonlocal attempts
        attempts += 1
        if attempts == 2:
            raise KeyboardInterrupt
        return capture(source, build, store, reader_policy, enrichment)

    with monkeypatch.context() as patch:
        patch.setattr(usage_inspection, "capture_scan_source", interrupted)
        stopped = usage_scan.scan_sessions()["inspection"]
    assert stopped["state"] == "cancelled"
    assert stopped["sources_done"] == 1
    assert stopped["sources_pending"] == 2
    resumed = usage_scan.scan_sessions(scan_id=stopped["scan_id"])["inspection"]
    assert resumed["scan_id"] == stopped["scan_id"]
    assert resumed["state"] == "complete"
    assert resumed["sources_done"] == 3
    fresh = usage_scan.scan_sessions()["inspection"]
    assert fresh["scan_id"] != resumed["scan_id"]
    with InspectionStore.open() as store:
        assert store.db.execute("SELECT COUNT(*) FROM scan_passes").fetchone()[0] == 1
        assert store.db.execute("SELECT COUNT(*) FROM sources").fetchone()[0] == 3


def test_new_pass_retries_failure_but_changed_file_does_not_bypass_retry(tmp_data_home, monkeypatch):
    paths = _inventory(1)
    from skill_hub.application.usage import usage_inspection_scan

    with monkeypatch.context() as patch:
        def failed(
            harness,
            path,
            cursor,
            seconds,
            *,
            worker_target=usage_inspection_scan._portable_parse_worker,
            reader_ref=None,
        ):
            raise TimeoutError("failed source")

        patch.setattr(usage_inspection_scan, "_signal_guard_available", lambda: False)
        patch.setattr(usage_inspection_scan, "_portable_parse", failed)
        failed_pass = usage_scan.scan_sessions()["inspection"]
    with paths[0].open("a") as stream:
        stream.write("{}\n")
    continuation = usage_scan.scan_sessions(scan_id=failed_pass["scan_id"])["inspection"]
    assert continuation["sources_processed"] == 0
    assert continuation["sources_incomplete"] == 1
    fresh = usage_scan.scan_sessions()["inspection"]
    assert fresh["sources_processed"] == 1
    assert fresh["sources_done"] == 1
    assert fresh["errors"] == []


def test_completed_partial_tail_resumes_same_pass_without_retry(tmp_data_home):
    from skill_hub.infrastructure.usage.usage_inspection_store import InspectionStore

    path = _inventory(1)[0]
    record = {
        "type": "assistant",
        "uuid": "completed-tail",
        "sessionId": path.stem,
        "timestamp": "2026-01-01T00:00:02Z",
        "message": {
            "role": "assistant",
            "content": [{"type": "tool_use", "id": "tail-call", "name": "Bash", "input": {"command": "pwd"}}],
        },
    }
    with path.open("a") as stream:
        stream.write(json.dumps(record))
    partial = usage_scan.scan_sessions()["inspection"]
    assert partial["sources_incomplete"] == 1
    assert partial["errors"][0]["kind"] == "partial_source"
    expected_cursor = path.stat().st_size - len(json.dumps(record).encode())
    assert partial["errors"][0]["last_successful_cursor"]["offset"] == expected_cursor
    unchanged = usage_scan.scan_sessions(scan_id=partial["scan_id"])["inspection"]
    assert unchanged["sources_processed"] == 0
    with path.open("a") as stream:
        stream.write("\n")
    completed = usage_scan.scan_sessions(scan_id=partial["scan_id"])["inspection"]
    assert completed["sources_processed"] == 1
    assert completed["sources_done"] == 1
    assert completed["errors"] == []
    assert completed["state"] == "complete"
    repeated = usage_scan.scan_sessions(scan_id=partial["scan_id"])["inspection"]
    assert repeated["sources_processed"] == 0
    with InspectionStore.open() as store:
        assert store.db.execute("SELECT COUNT(*) FROM tool_calls").fetchone()[0] == 1


@pytest.mark.parametrize(
    "column,value",
    [
        ("resume_state", ""),
        ("resume_state", "{"),
        ("resume_state", '{"version": 0}'),
        ("reader_id", "obsolete_reader"),
        ("resume_version", 0),
        ("reader_revision", 0),
        ("normalization_version", 0),
    ],
)
def test_stale_reader_state_backfills_once_and_preserves_pin(tmp_data_home, column, value):
    from skill_hub.application.usage import usage_inspection
    from skill_hub.infrastructure.usage.usage_inspection_store import InspectionStore

    path = _inventory(1)[0]
    original = usage_scan.scan_sessions()["inspection"]
    assert original["state"] == "complete"
    assert usage_inspection.mutate_pin("claude-code", path.stem, None, "add")["ok"] is True
    with InspectionStore.open() as store:
        events = [tuple(row) for row in store.db.execute("SELECT event_id FROM events ORDER BY event_id")]
        store.db.execute(f"UPDATE sources SET {column}=?", (value,))
        store.db.commit()
    backfill = usage_scan.scan_sessions()["inspection"]
    assert backfill["sources_processed"] == 1
    assert backfill["bytes_read"] == path.stat().st_size
    assert backfill["state"] == "complete"
    assert usage_inspection.list_pins()["items"][0]["session_id"] == path.stem
    with InspectionStore.open() as store:
        assert [tuple(row) for row in store.db.execute("SELECT event_id FROM events ORDER BY event_id")] == events
    unchanged = usage_scan.scan_sessions(scan_id=backfill["scan_id"])["inspection"]
    assert unchanged["sources_skipped_unchanged"] == 1
    assert unchanged["bytes_read"] == 0
