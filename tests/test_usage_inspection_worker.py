"""Portable bounded parsing tests for the Usage inspection pass."""

from __future__ import annotations

import json
import multiprocessing
import os
import pickle
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

import skill_hub.application.usage.usage_inspection_scan as usage_inspection_scan
import skill_hub.infrastructure.usage.usage_inspection_claude as usage_inspection_claude
from skill_hub.domain.harnesses.harness_usage_api import ReaderRef, SourceProbe
from skill_hub.domain.usage.usage_inspection_capture import SourceCursor
from skill_hub.infrastructure.usage.usage_capture_io import source_fingerprint

CLAUDE_READER_REF = ReaderRef(
    usage_inspection_claude.READER_ID,
    usage_inspection_claude.READER_REVISION,
    usage_inspection_claude.CAPTURE_CONTRACT_VERSION,
)


def _claude_source(path: Path, session_id: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    records = [
        {
            "type": "user",
            "uuid": f"{session_id}-user",
            "timestamp": "2026-09-17T10:00:00Z",
            "sessionId": session_id,
            "isSidechain": False,
            "message": {"role": "user", "content": "portable fixture"},
        },
        {
            "type": "assistant",
            "uuid": f"{session_id}-assistant",
            "timestamp": "2026-09-17T10:00:01Z",
            "sessionId": session_id,
            "isSidechain": False,
            "message": {
                "id": f"message-{session_id}",
                "model": "portable-model",
                "role": "assistant",
                "type": "message",
                "content": [{"type": "text", "text": "captured"}],
            },
        },
    ]
    path.write_text("".join(json.dumps(record) + "\n" for record in records))


def _blocking_worker(
    harness: str, path: str, cursor, deadline: float, result_path: str, reader_ref: ReaderRef
) -> None:
    del harness, path, cursor, deadline, result_path, reader_ref
    time.sleep(30)


def _keyboard_interrupt_worker(
    harness: str, path: str, cursor, deadline: float, result_path: str, reader_ref: ReaderRef
) -> None:
    del harness, path, cursor, deadline, reader_ref
    Path(result_path).write_bytes(
        pickle.dumps(("error", ("KeyboardInterrupt", "cancelled")))
    )


def _malformed_result_worker(
    harness: str, path: str, cursor, deadline: float, result_path: str, reader_ref: ReaderRef
) -> None:
    del harness, path, cursor, deadline, reader_ref
    Path(result_path).write_bytes(b"not a pickle")


def _no_result_worker(
    harness: str, path: str, cursor, deadline: float, result_path: str, reader_ref: ReaderRef
) -> None:
    del harness, path, cursor, deadline, result_path, reader_ref


def _seed_and_ref_worker(
    harness: str,
    path: str,
    cursor,
    deadline: float,
    result_path: str,
    reader_ref: ReaderRef,
    probe_seed: SourceProbe,
) -> None:
    del harness, cursor, deadline
    marker = Path(path).with_suffix(".seed")
    marker.write_text(
        json.dumps(
            {
                "reader": [reader_ref.reader_id, reader_ref.revision, reader_ref.contract_version],
                "source": probe_seed.source_id,
                "prefix": probe_seed.raw_prefix.decode("utf-8"),
            }
        )
    )
    Path(result_path).write_bytes(pickle.dumps(("error", ("ValueError", "seed inspected"))))


def _startup_marker_worker(
    harness: str, path: str, cursor, deadline: float, result_path: str, reader_ref: ReaderRef
) -> None:
    del harness, cursor, deadline, result_path, reader_ref
    Path(path).with_suffix(".startup-ran").write_text("ran")


def _slow_isolation() -> None:
    time.sleep(30)


def _failed_isolation() -> None:
    raise OSError("setsid failed")


def _successful_descendant_worker(
    harness: str, path: str, cursor, deadline: float, result_path: str, reader_ref: ReaderRef
) -> None:
    del harness, cursor, deadline, reader_ref
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
    source = Path(path)
    source.with_suffix(".success-descendant.pid").write_text(str(child.pid))
    Path(result_path).write_bytes(pickle.dumps(("result", "ok")))


def _successful_worker(
    harness: str, path: str, cursor, deadline: float, result_path: str, reader_ref: ReaderRef
) -> None:
    del harness, path, cursor, deadline, reader_ref
    Path(result_path).write_bytes(pickle.dumps(("result", "ok")))


def _exception_descendant_worker(
    harness: str, path: str, cursor, deadline: float, result_path: str, reader_ref: ReaderRef
) -> None:
    del harness, cursor, deadline, result_path, reader_ref
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
    source = Path(path)
    source.with_suffix(".exception-descendant.pid").write_text(str(child.pid))
    raise RuntimeError("target failed")


def _descendant_worker(
    harness: str, path: str, cursor, deadline: float, result_path: str, reader_ref: ReaderRef
) -> None:
    del harness, cursor, deadline, result_path, reader_ref
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
    source = Path(path)
    source.with_suffix(".descendant.pid").write_text(str(child.pid))
    source.with_suffix(".descendant.ready").write_text("ready")
    while True:
        time.sleep(1)


def _abrupt_exit_descendant_worker(
    harness: str, path: str, cursor, deadline: float, result_path: str, reader_ref: ReaderRef
) -> None:
    del harness, cursor, deadline, result_path, reader_ref
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
    source = Path(path)
    source.with_suffix(".abrupt-descendant.pid").write_text(str(child.pid))
    os._exit(0)


def _pid_alive(pid: int) -> bool:
    if os.name == "nt":
        try:
            completed = subprocess.run(
                ["tasklist", "/FI", f"PID eq {pid}"],
                check=False,
                capture_output=True,
                text=True,
                timeout=2.0,
            )
        except (OSError, subprocess.TimeoutExpired):
            return True
        if completed.returncode != 0:
            return True
        return any(
            len(parts) >= 2 and parts[1] == str(pid)
            for line in completed.stdout.splitlines()
            for parts in [line.strip().split()]
        )
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _terminate_pid(pid: int) -> None:
    if os.name == "nt":
        subprocess.run(
            ["taskkill", "/PID", str(pid), "/T", "/F"],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        return
    try:
        os.kill(pid, 9)
    except ProcessLookupError:
        pass


def test_portable_worker_times_out_one_source_and_captures_healthy_source(
    tmp_data_home, tmp_path, monkeypatch
):
    """A spawned parser is bounded per source and cannot block its siblings."""
    root = tmp_path / "claude"
    blocked_id = "aaaaaaaa-1111-4111-8111-111111111111"
    healthy_id = "bbbbbbbb-2222-4222-8222-222222222222"
    blocked = root / f"{blocked_id}.jsonl"
    healthy = root / f"{healthy_id}.jsonl"
    _claude_source(blocked, blocked_id)
    _claude_source(healthy, healthy_id)
    # Discover the blocked fixture first; the healthy source still must run.
    blocked.touch()
    original = usage_inspection_scan._portable_parse

    def use_blocking_target(
        harness, path, cursor, seconds, *, worker_target=None, reader_ref=None
    ):
        target = _blocking_worker if path == blocked else worker_target
        return original(
            harness,
            path,
            cursor,
            min(seconds, 0.2) if path == blocked else seconds,
            worker_target=target or usage_inspection_scan._portable_parse_worker,
            reader_ref=reader_ref,
        )

    monkeypatch.setattr(usage_inspection_scan, "_signal_guard_available", lambda: False)
    monkeypatch.setattr(usage_inspection_scan, "_portable_parse", use_blocking_target)
    monkeypatch.setattr(usage_inspection_scan.tempfile, "tempdir", str(tmp_path))
    started = time.monotonic()
    result = usage_inspection_scan.capture_pass(
        {"claude-code": root}, budget_seconds=10
    )
    assert time.monotonic() - started < 15

    assert result["sources_total"] == 2
    assert result["sources_processed"] == 2
    assert result["sources_done"] == 1
    assert result["sources_incomplete"] == 1
    assert result["sources_pending"] == 0
    assert any(error["kind"] == "TimeoutError" for error in result["errors"])
    assert not list(tmp_path.glob("hub-usage-parse-*"))
    assert not multiprocessing.active_children()
    with usage_inspection_scan.usage_inspection._store() as store:
        assert store.db.execute(
            "SELECT 1 FROM sessions WHERE session_id=?", (healthy_id,)
        ).fetchone()
        assert store.db.execute(
            "SELECT 1 FROM sessions WHERE session_id=?", (blocked_id,)
        ).fetchone() is None


def test_portable_worker_uses_real_claude_parser_and_cleans_result_file(
    tmp_data_home, tmp_path, monkeypatch
):
    session_id = "cccccccc-3333-4333-8333-333333333333"
    source = tmp_path / f"{session_id}.jsonl"
    _claude_source(source, session_id)
    monkeypatch.setattr(usage_inspection_scan, "_signal_guard_available", lambda: False)
    monkeypatch.setattr(usage_inspection_scan.tempfile, "tempdir", str(tmp_path))

    result = usage_inspection_scan._portable_parse(
        "claude-code",
        source,
        SourceCursor("claude-code:test", "", 0, 0, source_fingerprint(source)),
        5.0,
        reader_ref=CLAUDE_READER_REF,
    )

    assert result.source.source_session_id == session_id
    assert result.source.status == "active"
    assert not list(tmp_path.glob("hub-usage-parse-*"))


def test_portable_worker_transfers_bounded_seed_with_exact_reader_ref(
    tmp_path
):
    session_id = "dddddddd-4444-4444-8444-444444444444"
    source = tmp_path / f"{session_id}.jsonl"
    _claude_source(source, session_id)
    seed = SourceProbe(
        "claude-code:test", source_fingerprint(source), b'{"seed":true}\n',
        ({"seed": True},), 15, 15, 1, "eof",
    )
    try:
        usage_inspection_scan._portable_parse(
            "claude-code",
            source,
            SourceCursor("claude-code:test", "", 0, 0, source_fingerprint(source)),
            5.0,
            worker_target=_seed_and_ref_worker,
            reader_ref=CLAUDE_READER_REF,
            probe_seed=seed,
        )
    except ValueError as exc:
        assert str(exc) == "seed inspected"
    else:
        raise AssertionError("seed inspection worker unexpectedly succeeded")
    markers = list(tmp_path.glob("*.seed"))
    assert len(markers) == 1
    marker = json.loads(markers[0].read_text())
    assert marker == {
        "reader": [CLAUDE_READER_REF.reader_id, CLAUDE_READER_REF.revision, CLAUDE_READER_REF.contract_version],
        "source": "claude-code:test",
        "prefix": '{"seed":true}\n',
    }


def test_portable_worker_reports_malformed_or_missing_result_explicitly(
    tmp_data_home, tmp_path
):
    source = tmp_path / "source.jsonl"
    source.write_text("{}\n")
    cursor = usage_inspection_scan.SourceCursor(
        "claude-code:test", "", 0, 0, source_fingerprint(source)
    )
    for target in (_malformed_result_worker, _no_result_worker):
        try:
            usage_inspection_scan._portable_parse(
                "claude-code",
                source,
                cursor,
                10.0,
                worker_target=target,
                reader_ref=CLAUDE_READER_REF,
            )
        except RuntimeError as exc:
            assert str(exc) == "portable_parser_no_result"
        else:
            raise AssertionError("portable parser accepted an invalid worker result")


def test_portable_worker_cancels_before_target_when_startup_deadline_expires(
    tmp_data_home, tmp_path
):
    source = tmp_path / "startup.jsonl"
    source.write_text("{}\n")
    cursor = SourceCursor("claude-code:test", "", 0, 0, source_fingerprint(source))

    try:
        usage_inspection_scan._portable_parse(
            "claude-code",
            source,
            cursor,
            0.05,
            worker_target=_startup_marker_worker,
            worker_isolation=_slow_isolation,
            reader_ref=CLAUDE_READER_REF,
        )
    except TimeoutError:
        pass
    else:
        raise AssertionError("startup deadline did not cancel the worker")
    assert not source.with_suffix(".startup-ran").exists()


def test_portable_worker_fails_closed_when_isolation_cannot_be_established(
    tmp_data_home, tmp_path
):
    source = tmp_path / "isolation.jsonl"
    source.write_text("{}\n")
    cursor = SourceCursor("claude-code:test", "", 0, 0, source_fingerprint(source))

    try:
        usage_inspection_scan._portable_parse(
            "claude-code",
            source,
            cursor,
            5.0,
            worker_target=_startup_marker_worker,
            worker_isolation=_failed_isolation,
            reader_ref=CLAUDE_READER_REF,
        )
    except RuntimeError as exc:
        assert str(exc) == "portable_parser_isolation_failed"
    else:
        raise AssertionError("portable parser ran after isolation failure")
    assert not source.with_suffix(".startup-ran").exists()


def test_portable_worker_cleans_descendant_after_successful_result(
    tmp_data_home, tmp_path
):
    source = tmp_path / "successful.jsonl"
    source.write_text("{}\n")
    cursor = SourceCursor("claude-code:test", "", 0, 0, source_fingerprint(source))
    descendant_pid = None
    try:
        result = usage_inspection_scan._portable_parse(
            "claude-code",
            source,
            cursor,
            5.0,
            worker_target=_successful_descendant_worker,
            reader_ref=CLAUDE_READER_REF,
        )
        assert result == "ok"
        descendant_pid = int(source.with_suffix(".success-descendant.pid").read_text())
        deadline = time.monotonic() + 3
        while _pid_alive(descendant_pid) and time.monotonic() < deadline:
            time.sleep(0.05)
        assert not _pid_alive(descendant_pid)
    finally:
        if descendant_pid is not None and _pid_alive(descendant_pid):
            _terminate_pid(descendant_pid)


def test_portable_worker_reports_windows_tree_cleanup_failure(monkeypatch):
    class Worker:
        pid = 1234

        def is_alive(self):
            return False

        def join(self, _timeout):
            return None

    class Tree:
        def terminate_and_close(self):
            return False

    class WindowsView:
        name = "nt"

        def __getattr__(self, name):
            return getattr(os, name)

    with monkeypatch.context() as context:
        context.setattr(usage_inspection_scan, "os", WindowsView())
        try:
            usage_inspection_scan._stop_portable_worker(Worker(), process_tree=Tree())
        except RuntimeError as exc:
            error = str(exc)
        else:
            raise AssertionError("Windows tree cleanup failure was not classified")
    assert error == "portable_parser_cleanup_failed"


@pytest.mark.skipif(os.name != "posix", reason="POSIX process-group permission boundary")
def test_portable_worker_reports_process_group_cleanup_permission_failure(monkeypatch):
    class Worker:
        pid = 1234

        def is_alive(self):
            return False

        def join(self, _timeout):
            return None

    with monkeypatch.context() as context:
        def deny_killpg(*_args):
            raise PermissionError("denied")

        context.setattr(usage_inspection_scan.os, "killpg", deny_killpg)
        try:
            usage_inspection_scan._stop_portable_worker(Worker(), group_id=1234)
        except RuntimeError as exc:
            error = str(exc)
        else:
            raise AssertionError("process-group permission failure was treated as cleanup success")
    assert error == "portable_parser_cleanup_failed"


def test_portable_worker_fails_closed_when_windows_tree_bind_fails(
    tmp_data_home, tmp_path, monkeypatch
):
    source = tmp_path / "bind-failure.jsonl"
    source.write_text("{}\n")
    cursor = SourceCursor("claude-code:test", "", 0, 0, source_fingerprint(source))
    class WindowsView:
        name = "nt"

        def __getattr__(self, name):
            return getattr(os, name)

    with monkeypatch.context() as context:
        context.setattr(usage_inspection_scan, "os", WindowsView())
        context.setattr(
            usage_inspection_scan.harness_execution_supervisor,
            "windows_process_tree_for_pid",
            lambda _pid: (_ for _ in ()).throw(OSError("bind failed")),
        )
        try:
            usage_inspection_scan._portable_parse(
                "claude-code",
                source,
                cursor,
                5.0,
                worker_target=_startup_marker_worker,
                reader_ref=CLAUDE_READER_REF,
            )
        except RuntimeError as exc:
            error = str(exc)
        else:
            raise AssertionError("parser ran after Windows tree bind failure")
    assert error == "portable_parser_isolation_failed"
    assert not source.with_suffix(".startup-ran").exists()


def test_portable_worker_cleans_descendant_after_abrupt_leader_exit(
    tmp_data_home, tmp_path
):
    source = tmp_path / "abrupt.jsonl"
    source.write_text("{}\n")
    cursor = SourceCursor("claude-code:test", "", 0, 0, source_fingerprint(source))
    try:
        try:
            usage_inspection_scan._portable_parse(
                "claude-code", source, cursor, 5.0,
                worker_target=_abrupt_exit_descendant_worker,
                reader_ref=CLAUDE_READER_REF,
            )
        except RuntimeError as exc:
            assert str(exc) in {"portable_parser_no_result", "portable_parser_cleanup_failed"}
        else:
            raise AssertionError("abrupt worker exit produced a result")
        descendant_pid = int(source.with_suffix(".abrupt-descendant.pid").read_text())
        deadline = time.monotonic() + 3
        while _pid_alive(descendant_pid) and time.monotonic() < deadline:
            time.sleep(0.05)
        assert not _pid_alive(descendant_pid)
    finally:
        pid_file = source.with_suffix(".abrupt-descendant.pid")
        if pid_file.exists():
            pid = int(pid_file.read_text())
            if _pid_alive(pid):
                _terminate_pid(pid)


def test_portable_worker_reports_cleanup_failure_before_returning_result(
    tmp_data_home, tmp_path, monkeypatch
):
    source = tmp_path / "cleanup.jsonl"
    source.write_text("{}\n")
    cursor = SourceCursor("claude-code:test", "", 0, 0, source_fingerprint(source))
    original = usage_inspection_scan._stop_portable_worker

    def fail_after_cleanup(worker, group_id=None, process_tree=None):
        original(worker, group_id, process_tree)
        raise RuntimeError("portable_parser_cleanup_failed")

    monkeypatch.setattr(usage_inspection_scan, "_stop_portable_worker", fail_after_cleanup)
    try:
        usage_inspection_scan._portable_parse(
            "claude-code",
            source,
            cursor,
            5.0,
            worker_target=_successful_worker,
            reader_ref=CLAUDE_READER_REF,
        )
    except RuntimeError as exc:
        assert str(exc) == "portable_parser_cleanup_failed"
    else:
        raise AssertionError("portable parser returned a result after cleanup failed")


def test_portable_worker_keeps_leader_for_cleanup_after_target_exception(
    tmp_data_home, tmp_path
):
    source = tmp_path / "exception.jsonl"
    source.write_text("{}\n")
    cursor = SourceCursor("claude-code:test", "", 0, 0, source_fingerprint(source))
    descendant_pid = None
    try:
        try:
            usage_inspection_scan._portable_parse(
                "claude-code", source, cursor, 5.0,
                worker_target=_exception_descendant_worker,
                reader_ref=CLAUDE_READER_REF,
            )
        except RuntimeError as exc:
            assert str(exc) == "portable_parser_worker_failed"
        else:
            raise AssertionError("target exception was not reported")
        descendant_pid = int(source.with_suffix(".exception-descendant.pid").read_text())
        deadline = time.monotonic() + 3
        while _pid_alive(descendant_pid) and time.monotonic() < deadline:
            time.sleep(0.05)
        assert not _pid_alive(descendant_pid)
    finally:
        if descendant_pid is not None and _pid_alive(descendant_pid):
            _terminate_pid(descendant_pid)


def test_keyboard_interrupt_cancels_pass_without_advancing_cursor(
    tmp_data_home, tmp_path, monkeypatch
):
    root = tmp_path / "claude"
    session_id = "dddddddd-4444-4444-8444-444444444444"
    source = root / f"{session_id}.jsonl"
    _claude_source(source, session_id)
    original = usage_inspection_scan._portable_parse

    def cancelled(harness, path, cursor, seconds, *, worker_target=None, reader_ref=None):
        return original(
            harness,
            path,
            cursor,
            seconds,
            worker_target=_keyboard_interrupt_worker,
            reader_ref=reader_ref,
        )

    monkeypatch.setattr(usage_inspection_scan, "_signal_guard_available", lambda: False)
    monkeypatch.setattr(usage_inspection_scan, "_portable_parse", cancelled)
    monkeypatch.setattr(usage_inspection_scan.tempfile, "tempdir", str(tmp_path))
    result = usage_inspection_scan.capture_pass(
        {"claude-code": root}, budget_seconds=10.0
    )

    assert result["state"] == "cancelled"
    assert result["sources_processed"] == 1
    assert result["sources_done"] == 0
    assert result["sources_pending"] == 1
    assert result["sources_incomplete"] == 0
    assert not list(tmp_path.glob("hub-usage-parse-*"))
    with usage_inspection_scan.usage_inspection._store() as store:
        assert store.db.execute(
            "SELECT 1 FROM sources"
        ).fetchone() is None


def test_timeout_kills_spawned_worker_descendants_and_cleans_tempdir(
    tmp_data_home, tmp_path, monkeypatch
):
    """A timed out worker cannot leave its child process behind."""
    source = tmp_path / "eeeeeeee-5555-4555-8555-555555555555.jsonl"
    _claude_source(source, source.stem)
    original = usage_inspection_scan._portable_parse
    outcome: dict[str, BaseException] = {}
    if os.name == "posix":
        # Reproduce the reviewed race: a cleanup-time group lookup can lose
        # the worker's group identity after startup. The repaired path uses
        # the validated handshake identity instead of sampling again.
        monkeypatch.setattr(
            usage_inspection_scan, "_worker_process_group", lambda worker: None
        )

    def run_parse() -> None:
        try:
            original(
                "claude-code",
                source,
                SourceCursor("claude-code:test", "", 0, 0, source_fingerprint(source)),
                2.0,
                worker_target=_descendant_worker,
                reader_ref=CLAUDE_READER_REF,
            )
        except BaseException as exc:  # Assert the worker's bounded failure below.
            outcome["error"] = exc

    monkeypatch.setattr(usage_inspection_scan.tempfile, "tempdir", str(tmp_path))
    thread = threading.Thread(target=run_parse)
    thread.start()
    ready = source.with_suffix(".descendant.ready")
    started = time.monotonic()
    while not ready.exists() and time.monotonic() - started < 5:
        time.sleep(0.02)
    assert ready.exists(), "spawned worker did not launch its descendant"
    descendant_pid = int(source.with_suffix(".descendant.pid").read_text())
    try:
        thread.join(8)
        assert not thread.is_alive()
        assert isinstance(outcome.get("error"), TimeoutError)
        assert not list(tmp_path.glob("hub-usage-parse-*"))
        deadline = time.monotonic() + 3
        while _pid_alive(descendant_pid) and time.monotonic() < deadline:
            time.sleep(0.05)
        assert not _pid_alive(descendant_pid)
    finally:
        if _pid_alive(descendant_pid):
            _terminate_pid(descendant_pid)


@pytest.mark.skipif(os.name != "posix", reason="POSIX process-group ownership")
def test_group_cleanup_keeps_leader_unreaped_until_hard_kill(monkeypatch):
    signals = []

    class Worker:
        pid = 123456

        def is_alive(self):
            assert signals == [usage_inspection_scan.signal.SIGKILL]
            return False

        def join(self, timeout):
            assert signals == [usage_inspection_scan.signal.SIGKILL]

    monkeypatch.setattr(usage_inspection_scan.os, "killpg", lambda group, sig: signals.append(sig))
    monkeypatch.setattr(usage_inspection_scan.time, "sleep", lambda seconds: None)
    usage_inspection_scan._stop_portable_worker(Worker(), group_id=Worker.pid)
    assert signals == [usage_inspection_scan.signal.SIGKILL]


@pytest.mark.skipif(os.name != "posix", reason="POSIX process-group ownership")
def test_group_hard_kill_permission_error_remains_fail_closed(monkeypatch):
    class Worker:
        pid = 123456

        def is_alive(self):
            return False

        def join(self, timeout):
            pass

    def denied(group, sig):
        assert group == Worker.pid
        assert sig == usage_inspection_scan.signal.SIGKILL
        raise PermissionError("group cleanup denied")

    monkeypatch.setattr(usage_inspection_scan.os, "killpg", denied)
    with pytest.raises(RuntimeError, match="portable_parser_cleanup_failed"):
        usage_inspection_scan._stop_portable_worker(Worker(), group_id=Worker.pid)
