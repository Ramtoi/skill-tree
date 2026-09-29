from __future__ import annotations

import ctypes
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import pytest

from skill_hub.application.harnesses.harness_runtime import (
    InventoryRequest,
    RunnerResult,
    _WindowsJob,
    executable_fingerprint,
    inventory,
    read_inventory_cache,
    revalidate_identity,
    write_inventory_cache,
)
from skill_hub.domain.harnesses.harness_adapter_api import Version


def test_windows_job_close_failure_preserves_handle() -> None:
    class Kernel:
        def CloseHandle(self, handle):
            assert handle == "fixture-handle"
            return 0

    job = _WindowsJob("fixture-handle", Kernel())
    with pytest.raises(OSError):
        job.close()
    assert job.handle == "fixture-handle"


def _executable(path: Path) -> None:
    path.write_text("binary")
    path.chmod(0o755)


def test_inventory_uses_allowlisted_runner_and_deduplicates_aliases(tmp_path: Path) -> None:
    binary = tmp_path / "opencode"
    _executable(binary)
    alias_dir = tmp_path / "aliases"
    alias_dir.mkdir()
    (alias_dir / "opencode").symlink_to(binary)
    calls = []

    def runner(argv, timeout, max_output):
        calls.append((tuple(argv), timeout, max_output))
        return RunnerResult(0, "opencode 1.18.31\n")

    request = InventoryRequest(
        harnesses=("opencode",), path=os.pathsep.join((str(tmp_path), str(alias_dir))), fallback_dirs=()
    )
    found = inventory(request, runner)
    assert len(found.identities) == 1
    assert found.identities[0].version == Version(1, 18, 31)
    assert calls == [((str(binary), "--version"), request.timeout_seconds, request.max_output_bytes)]


def test_inventory_bounds_output_and_records_unknown_or_failed_probes(tmp_path: Path) -> None:
    binary = tmp_path / "codex"
    _executable(binary)

    def runner(argv, timeout, max_output):
        return RunnerResult(2, "custom-build " + "x" * 1000, "failure")

    request = InventoryRequest(harnesses=("codex",), path=str(tmp_path), fallback_dirs=(), max_output_bytes=24)
    identity = inventory(request, runner).identities[0]
    assert identity.version is None
    assert identity.probe is not None and identity.probe.status == "failed"
    assert identity.probe.truncated and len(identity.raw_version.encode()) <= 24


def test_inventory_rejects_non_finite_timeout() -> None:
    with pytest.raises(ValueError):
        InventoryRequest(timeout_seconds=float("nan"))
    with pytest.raises(ValueError):
        InventoryRequest(timeout_seconds=float("inf"))


def test_truncated_successful_output_cannot_claim_a_version(tmp_path: Path) -> None:
    binary = tmp_path / "opencode"
    _executable(binary)

    def runner(argv, timeout, max_output):
        return RunnerResult(0, "opencode 1.18.31" + "x" * 100, truncated=True)

    request = InventoryRequest(harnesses=("opencode",), path=str(tmp_path), fallback_dirs=())
    identity = inventory(request, runner).identities[0]
    assert identity.version is None and identity.probe is not None and identity.probe.truncated


def test_known_claude_version_suffix_is_parsed(tmp_path: Path) -> None:
    binary = tmp_path / "claude"
    _executable(binary)
    request = InventoryRequest(harnesses=("claude-code",), path=str(tmp_path), fallback_dirs=())
    identity = inventory(request, lambda *args: RunnerResult(0, "2.1.19 (Claude Code)\n")).identities[0]
    assert identity.version == Version(2, 1, 19)


def test_non_executable_candidate_is_ignored(tmp_path: Path) -> None:
    binary = tmp_path / "codex"
    binary.write_text("not executable")
    request = InventoryRequest(harnesses=("codex",), path=str(tmp_path), fallback_dirs=())
    assert inventory(request, lambda *args: RunnerResult(0, "0.1.0")).identities == ()


def test_unsupported_shell_wrapper_is_reported_without_runner_invocation(tmp_path: Path) -> None:
    wrapper = tmp_path / "opencode.sh"
    wrapper.write_text("#!/bin/sh\necho 1.18.31\n")
    wrapper.chmod(0o755)
    calls = []
    request = InventoryRequest(harnesses=("opencode",), path=str(tmp_path), fallback_dirs=())
    identity = inventory(request, lambda *args: calls.append(args)).identities[0]
    assert calls == []
    assert identity.probe is not None and identity.probe.status == "unsupported_wrapper"


def test_marker_is_config_evidence_and_never_a_version(tmp_path: Path) -> None:
    marker = tmp_path / "opencode-config"
    marker.mkdir()
    request = InventoryRequest(
        harnesses=("opencode",), path="", fallback_dirs=(), marker_dirs={"opencode": (str(marker),)}
    )
    identity = inventory(request, lambda *args: RunnerResult(0, "never")).identities[0]
    assert identity.version is None and identity.evidence == "directory_marker"


def test_marker_with_executable_enriches_config_fingerprint_without_ambiguity(tmp_path: Path) -> None:
    binary = tmp_path / "opencode"
    _executable(binary)
    marker = tmp_path / "config"
    marker.mkdir()
    request = InventoryRequest(
        harnesses=("opencode",),
        path=str(tmp_path),
        fallback_dirs=(),
        marker_dirs={"opencode": (str(marker),)},
    )
    identities = inventory(request, lambda *args: RunnerResult(0, "1.18.31")).identities
    assert len(identities) == 1 and identities[0].config_fingerprint is not None


def test_cache_reads_never_probe_and_changed_fingerprint_invalidates(tmp_path: Path) -> None:
    binary = tmp_path / "opencode"
    _executable(binary)
    request = InventoryRequest(harnesses=("opencode",), path=str(tmp_path), fallback_dirs=())
    calls = []
    found = inventory(request, lambda *args: (calls.append(args) or RunnerResult(0, "1.18.31")))
    cache_path = tmp_path / "cache" / "inventory.json"
    write_inventory_cache(found, cache_path)
    cached = read_inventory_cache(cache_path, request)
    assert cached is not None and not calls[1:]
    assert revalidate_identity(cached.identities[0])
    binary.write_text("changed binary")
    assert executable_fingerprint(str(binary)) != found.identities[0].executable_fingerprint
    assert read_inventory_cache(cache_path, request) is None


def test_observed_at_uses_injected_utc_clock_and_round_trips_cache(tmp_path: Path) -> None:
    binary = tmp_path / "opencode"
    _executable(binary)
    request = InventoryRequest(harnesses=("opencode",), path=str(tmp_path), fallback_dirs=())
    observed = datetime(2026, 9, 16, 14, 30, tzinfo=timezone.utc)
    found = inventory(request, lambda *args: RunnerResult(0, "1.18.31"), clock=lambda: observed)
    assert found.observed_at == "2026-09-16T14:30:00+00:00"
    assert found.identities[0].observed_at == found.observed_at
    cache_path = tmp_path / "cache" / "inventory.json"
    write_inventory_cache(found, cache_path)
    cached = read_inventory_cache(cache_path, request)
    assert cached is not None and cached.observed_at == found.observed_at
    assert cached.identities[0].probe is not None
    assert cached.identities[0].probe.observed_at == found.observed_at


@pytest.mark.skipif(os.name == "nt", reason="extensionless POSIX shebang fixture")
def test_default_runner_reaps_synthetic_descendant(tmp_path: Path, monkeypatch) -> None:
    child_pid_file = tmp_path / "child.pid"
    binary = tmp_path / "codex"
    binary.write_text(
        "#!/usr/bin/env python3\n"
        "import os, pathlib, subprocess, sys, time\n"
        "path = pathlib.Path(os.environ['CHILD_PID_FILE'])\n"
        "child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'])\n"
        "path.write_text(str(child.pid))\n"
        "print('codex 0.142.2', flush=True)\n"
    )
    binary.chmod(0o755)
    monkeypatch.setenv("CHILD_PID_FILE", str(child_pid_file))
    request = InventoryRequest(harnesses=("codex",), path=str(tmp_path), fallback_dirs=(), timeout_seconds=2)
    identity = inventory(request).identities[0]
    assert identity.version == Version(0, 142, 2)
    child_pid = int(child_pid_file.read_text())
    for _ in range(20):
        try:
            os.kill(child_pid, 0)
        except OSError:
            break
        time.sleep(0.01)
    else:
        raise AssertionError("synthetic descendant survived probe cleanup")


@pytest.mark.skipif(os.name == "nt", reason="POSIX process-group proof")
def test_default_runner_kills_descendant_ignoring_sigterm(tmp_path: Path, monkeypatch) -> None:
    child_pid_file = tmp_path / "child.pid"
    binary = tmp_path / "codex"
    binary.write_text(
        "#!/usr/bin/env python3\n"
        "import os, pathlib, signal, subprocess, sys, time\n"
        "path = pathlib.Path(os.environ['CHILD_PID_FILE'])\n"
        "child = subprocess.Popen([sys.executable, '-c', "
        "\"import os, pathlib, signal, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); "
        "pathlib.Path(os.environ['CHILD_READY_FILE']).write_text('ready'); time.sleep(30)\"])\n"
        "ready = pathlib.Path(os.environ['CHILD_READY_FILE'])\n"
        "deadline = time.time() + 2\n"
        "while not ready.exists() and time.time() < deadline: time.sleep(0.01)\n"
        "if not ready.exists(): raise SystemExit('child did not become ready')\n"
        "path.write_text(str(child.pid))\n"
        "print('codex 0.142.2', flush=True)\n"
    )
    binary.chmod(0o755)
    monkeypatch.setenv("CHILD_PID_FILE", str(child_pid_file))
    monkeypatch.setenv("CHILD_READY_FILE", str(tmp_path / "child.ready"))
    request = InventoryRequest(harnesses=("codex",), path=str(tmp_path), fallback_dirs=())
    identity = inventory(request).identities[0]
    assert identity.version == Version(0, 142, 2)
    child_pid = int(child_pid_file.read_text())
    for _ in range(20):
        try:
            os.kill(child_pid, 0)
        except OSError:
            break
        time.sleep(0.01)
    else:
        raise AssertionError("SIGTERM-ignoring descendant survived probe cleanup")


@pytest.mark.skipif(os.name != "nt", reason="Windows Job Object proof")
def test_windows_runner_reaps_synthetic_descendant(tmp_path: Path, monkeypatch) -> None:
    child_pid_file = tmp_path / "child.pid"
    helper = tmp_path / "probe_helper.py"
    helper.write_text(
        "import os, pathlib, subprocess, sys\n"
        "path = pathlib.Path(os.environ['CHILD_PID_FILE'])\n"
        "child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'])\n"
        "path.write_text(str(child.pid))\n"
        "print('codex 0.142.2', flush=True)\n"
    )
    wrapper = tmp_path / "codex.cmd"
    wrapper.write_text('@echo off\n"%s" "%s" --version\n' % (sys.executable, helper))
    monkeypatch.setenv("CHILD_PID_FILE", str(child_pid_file))
    request = InventoryRequest(
        harnesses=("codex",), path=str(tmp_path), fallback_dirs=(), os_name="Windows", timeout_seconds=2
    )
    identity = inventory(request).identities[0]
    assert identity.version == Version(0, 142, 2)
    child_pid = int(child_pid_file.read_text())
    kernel32 = getattr(ctypes, "WinDLL")("kernel32", use_last_error=True)
    get_last_error = getattr(ctypes, "get_last_error")
    open_process = kernel32.OpenProcess
    open_process.argtypes = [ctypes.c_uint32, ctypes.c_int, ctypes.c_uint32]
    open_process.restype = ctypes.c_void_p
    wait_for_single_object = kernel32.WaitForSingleObject
    wait_for_single_object.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
    wait_for_single_object.restype = ctypes.c_uint32
    close_handle = kernel32.CloseHandle
    close_handle.argtypes = [ctypes.c_void_p]
    close_handle.restype = ctypes.c_int
    for _ in range(20):
        handle = open_process(0x00100000, 0, child_pid)  # SYNCHRONIZE
        if not handle:
            error = get_last_error()
            if error == 87:  # ERROR_INVALID_PARAMETER: process no longer exists
                break
            raise AssertionError("OpenProcess failed with unexpected error %s" % error)
        try:
            wait_result = wait_for_single_object(handle, 0)
            if wait_result == 0:  # WAIT_OBJECT_0: exited
                break
            if wait_result == 0xFFFFFFFF:  # WAIT_FAILED
                raise AssertionError("WaitForSingleObject failed")
        finally:
            close_handle(handle)
        time.sleep(0.01)
    else:
        raise AssertionError("synthetic Windows descendant survived probe cleanup")


def test_cache_invalidates_when_a_new_candidate_appears_without_probing(tmp_path: Path) -> None:
    binary = tmp_path / "opencode"
    _executable(binary)
    request = InventoryRequest(harnesses=("opencode",), path=str(tmp_path), fallback_dirs=())
    found = inventory(request, lambda *args: RunnerResult(0, "1.18.31"))
    cache_path = tmp_path / "cache" / "inventory.json"
    write_inventory_cache(found, cache_path)
    second = tmp_path / ("opencode.cmd" if os.name == "nt" else "opencode.sh")
    _executable(second)
    assert read_inventory_cache(cache_path, request) is None


@pytest.mark.parametrize(
    "raw, expected", [("Darwin", "macos"), ("Linux", "linux"), ("Windows", "windows"), ("win32", "windows")]
)
def test_inventory_normalizes_os_names_for_catalog_dimensions(tmp_path: Path, raw: str, expected: str) -> None:
    marker = tmp_path / "config"
    marker.mkdir()
    request = InventoryRequest(
        harnesses=("codex",), path="", fallback_dirs=(), os_name=raw, marker_dirs={"codex": (str(marker),)}
    )
    result = inventory(request, lambda *args: RunnerResult(0, "must not probe"))
    assert result.identities[0].os_name == expected
