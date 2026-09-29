from __future__ import annotations

import os
import subprocess
import sys
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

from skill_hub.infrastructure.harnesses import harness_execution_supervisor as supervisor


def test_launch_preserves_target_io_and_applies_linux_memory_limit(tmp_path: Path) -> None:
    if os.name != "posix" or supervisor.platform.system() == "Darwin":
        pytest.skip("RLIMIT_AS is a Linux contract")
    code = "import resource; print(resource.getrlimit(resource.RLIMIT_AS)[0], flush=True)"
    with supervisor.launch([sys.executable, "-c", code], cwd=tmp_path, env=os.environ.copy(),
                           memory_bytes=64 * 1024 * 1024, lock_path=tmp_path / "slot") as child:
        assert child.process.stdout is not None
        assert int(child.process.stdout.readline()) == 64 * 1024 * 1024
        assert child.process.wait(timeout=3) == 0
        assert child.memory_mode == "rlimit_as"


def test_oversized_allocation_is_killed_by_linux_limit(tmp_path: Path) -> None:
    if os.name != "posix" or supervisor.platform.system() == "Darwin":
        pytest.skip("RLIMIT_AS is a Linux contract")
    code = "bytearray(96 * 1024 * 1024); print('unexpected', flush=True)"
    with supervisor.launch([sys.executable, "-c", code], cwd=tmp_path, env=os.environ.copy(),
                           memory_bytes=32 * 1024 * 1024, lock_path=tmp_path / "slot") as child:
        assert child.process.wait(timeout=5) != 0
        assert child.process.stdout is not None
        assert child.process.stdout.read() == b""


def test_close_cleans_descendant_after_leader_exit_on_linux(tmp_path: Path) -> None:
    if supervisor.platform.system() != "Linux":
        pytest.skip("process-group cleanup contract is Linux-specific")
    pid_file = tmp_path / "child.pid"
    ready = tmp_path / "child.ready"
    sentinel = tmp_path / "late-sentinel"
    child_code = (
        "import signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); "
        f"open({str(ready)!r},'w').close(); "
        f"time.sleep(1); open({str(sentinel)!r},'w').close()"
    )
    code = (
        "import os,subprocess,time; "
        f"p=subprocess.Popen([{sys.executable!r},'-c',{child_code!r}]); "
        f"open({str(pid_file)!r},'w').write(str(p.pid))"
    )
    child = supervisor.launch(
        [sys.executable, "-c", code], cwd=tmp_path, env=os.environ.copy(), lock_path=tmp_path / "slot"
    )
    try:
        assert child.process.wait(timeout=3) == 0
        for _ in range(500):
            if ready.exists() and pid_file.exists():
                break
            time.sleep(0.01)
        assert ready.exists() and pid_file.exists()
        descendant_pid = int(pid_file.read_text())
        assert child.close() is True
        time.sleep(1.5)
        assert not sentinel.exists(), descendant_pid
    finally:
        child.close()


def test_close_escalates_after_leader_exits_and_descendant_ignores_term(monkeypatch: pytest.MonkeyPatch) -> None:
    signals: list[int] = []

    class Process:
        pid = 123

        def poll(self) -> int:
            return 0

        def wait(self, timeout: float) -> int:
            return 0

    class Slot:
        released = False

        def release(self) -> None:
            self.released = True

    monkeypatch.setattr(supervisor, "os", SimpleNamespace(name="posix", killpg=lambda _pid, sig: signals.append(sig)))
    monkeypatch.setattr(supervisor, "signal", SimpleNamespace(SIGTERM=15, SIGKILL=9))
    managed = supervisor.SupervisedProcess(Process(), "rlimit_as", 1, Slot())  # type: ignore[arg-type]
    assert managed.close() is True
    assert signals == [supervisor.signal.SIGTERM, supervisor.signal.SIGKILL]


def test_second_process_is_rejected_until_holder_closes(tmp_path: Path) -> None:
    if supervisor.platform.system() == "Darwin":
        pytest.skip("macOS supervision is intentionally fail-closed")
    lock = tmp_path / "slot"
    with supervisor.launch([sys.executable, "-c", "import time; time.sleep(0.2)"], cwd=tmp_path,
                           env=os.environ.copy(), lock_path=lock) as holder:
        with pytest.raises(supervisor.SupervisionError, match="already in use"):
            supervisor.launch([sys.executable, "-c", "pass"], cwd=tmp_path, env=os.environ.copy(), lock_path=lock)
        holder.process.wait(timeout=3)
    with supervisor.launch(
        [sys.executable, "-c", "pass"], cwd=tmp_path, env=os.environ.copy(), lock_path=lock
    ) as child:
        assert child.process.wait(timeout=3) == 0


def test_execution_slot_is_testable_without_process_supervision(tmp_path: Path) -> None:
    lock = tmp_path / "slot"
    with supervisor.execution_slot(lock):
        with pytest.raises(supervisor.SupervisionError, match="already in use"):
            with supervisor.execution_slot(lock):
                pass
    with supervisor.execution_slot(lock):
        pass


def test_execution_slot_rejects_another_os_process(tmp_path: Path) -> None:
    script = (
        "import sys,time\n"
        "sys.path.insert(0, sys.argv[1])\n"
        "from skill_hub.infrastructure.harnesses.harness_execution_supervisor import execution_slot\n"
        "with execution_slot(sys.argv[2]):\n"
        " print('held', flush=True); time.sleep(1)\n"
    )
    repo = str(Path(__file__).resolve().parent.parent)
    lock = tmp_path / "process-slot"
    holder = subprocess.Popen([sys.executable, "-c", script, repo, str(lock)], stdout=subprocess.PIPE, text=True)
    try:
        assert holder.stdout is not None and holder.stdout.readline().strip() == "held"
        with pytest.raises(supervisor.SupervisionError, match="already in use"):
            with supervisor.execution_slot(lock):
                pass
    finally:
        holder.wait(timeout=3)


def test_default_execution_slot_is_shared_across_data_homes(tmp_path: Path) -> None:
    script = (
        "import os,sys,time\n"
        "sys.path.insert(0, sys.argv[1]); os.environ['SKILL_HUB_HOME']=sys.argv[3]\n"
        "from skill_hub.infrastructure.harnesses.harness_execution_supervisor import execution_slot\n"
        "with execution_slot(): print('held', flush=True); time.sleep(1)\n"
    )
    repo = str(Path(__file__).resolve().parent.parent)
    temp_a = tmp_path / "tmp-a"
    temp_b = tmp_path / "tmp-b"
    temp_a.mkdir()
    temp_b.mkdir()
    holder_env = {**os.environ, "SKILL_HUB_HOME": str(tmp_path / "home-a"), "TMPDIR": str(temp_a), "TEMP": str(temp_a)}
    holder = subprocess.Popen(
        [sys.executable, "-c", script, repo, "unused", str(tmp_path / "home-a")],
        stdout=subprocess.PIPE, text=True,
        env=holder_env,
    )
    try:
        assert holder.stdout is not None and holder.stdout.readline().strip() == "held"
        other_env = {
            **os.environ, "SKILL_HUB_HOME": str(tmp_path / "home-b"),
            "TMPDIR": str(temp_b), "TEMP": str(temp_b),
        }
        probe = subprocess.run(
            [
                sys.executable,
                "-c",
                "import sys; sys.path.insert(0, sys.argv[1]); "
                "from skill_hub.infrastructure.harnesses.harness_execution_supervisor "
                "import execution_slot,SupervisionError; "
                "\ntry:\n with execution_slot(): pass\nexcept SupervisionError:\n print('busy')",
                repo,
            ],
            capture_output=True,
            text=True,
            env=other_env,
            check=False,
        )
        assert probe.stdout.strip() == "busy"
    finally:
        holder.wait(timeout=3)


def test_invalid_memory_is_rejected_before_slot_acquisition(tmp_path: Path) -> None:
    with pytest.raises(supervisor.SupervisionError, match="positive integer"):
        supervisor.launch([sys.executable, "-c", "raise SystemExit(99)"], cwd=tmp_path, env=os.environ.copy(),
                          memory_bytes=0, lock_path=tmp_path / "slot")


def test_macos_fails_before_target_starts(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    marker = tmp_path / "started"
    monkeypatch.setattr(supervisor.platform, "system", lambda: "Darwin")
    with pytest.raises(supervisor.SupervisionError, match="unavailable on macOS"):
        supervisor.launch([sys.executable, "-c", f"open({str(marker)!r}, 'w').close()"], cwd=tmp_path,
                          env=os.environ.copy(), lock_path=tmp_path / "slot")
    assert not marker.exists()


@pytest.mark.skipif(sys.platform != "darwin", reason="actual macOS boundary")
def test_actual_macos_fails_closed_before_target_starts(tmp_path: Path) -> None:
    marker = tmp_path / "started"
    with pytest.raises(supervisor.SupervisionError, match="unavailable on macOS"):
        supervisor.launch([sys.executable, "-c", f"open({str(marker)!r}, 'w').close()"], cwd=tmp_path,
                          env=os.environ.copy(), lock_path=tmp_path / "slot")
    assert not marker.exists()


@pytest.mark.skipif(os.name != "nt", reason="actual Windows Job Object boundary")
def test_windows_target_exit_code_and_virtual_alloc_limit(tmp_path: Path) -> None:
    with supervisor.launch(
        [sys.executable, "-c", "raise SystemExit(23)"], cwd=tmp_path, env=os.environ.copy(),
        memory_bytes=64 * 1024 * 1024, lock_path=tmp_path / "exit-slot",
    ) as child:
        assert child.process.wait(timeout=5) == 23

    code = (
        "import ctypes; "
        "k=ctypes.windll.kernel32; k.VirtualAlloc.restype=ctypes.c_void_p; "
        "p=k.VirtualAlloc(None,268435456,0x3000,0x04); "
        "raise SystemExit(0 if p else 1)"
    )
    with supervisor.launch(
        [sys.executable, "-c", code], cwd=tmp_path, env=os.environ.copy(),
        memory_bytes=64 * 1024 * 1024, lock_path=tmp_path / "memory-slot",
    ) as child:
        assert child.process.wait(timeout=5) != 0


@pytest.mark.skipif(os.name != "nt", reason="actual Windows Job Object boundary")
def test_windows_job_kills_descendant_before_late_sentinel(tmp_path: Path) -> None:
    ready = tmp_path / "child.ready"
    sentinel = tmp_path / "late-sentinel"
    child_code = (
        f"open({str(ready)!r},'w').close(); import time; time.sleep(2); "
        f"open({str(sentinel)!r},'w').close()"
    )
    code = (
        "import subprocess,sys,time; "
        f"subprocess.Popen([sys.executable,'-c',{child_code!r}]); "
        "time.sleep(30)"
    )
    child = supervisor.launch(
        [sys.executable, "-c", code], cwd=tmp_path, env=os.environ.copy(),
        memory_bytes=128 * 1024 * 1024, lock_path=tmp_path / "job-slot",
    )
    try:
        for _ in range(500):
            if ready.exists():
                break
            time.sleep(0.01)
        assert ready.exists()
        assert child.close() is True
        time.sleep(2.5)
        assert not sentinel.exists()
    finally:
        child.close()


@pytest.mark.skipif(os.name != "nt", reason="actual Windows Job Object boundary")
def test_windows_job_kills_descendant_after_leader_exits(tmp_path: Path) -> None:
    ready = tmp_path / "child.ready"
    sentinel = tmp_path / "late-sentinel"
    child_code = (
        f"open({str(ready)!r},'w').close(); import time; time.sleep(2); "
        f"open({str(sentinel)!r},'w').close()"
    )
    code = (
        "import subprocess,sys; "
        f"subprocess.Popen([sys.executable,'-c',{child_code!r}]);"
    )
    child = supervisor.launch(
        [sys.executable, "-c", code], cwd=tmp_path, env=os.environ.copy(),
        memory_bytes=128 * 1024 * 1024, lock_path=tmp_path / "leader-exit-slot",
    )
    try:
        assert child.process.wait(timeout=5) == 0
        for _ in range(500):
            if ready.exists():
                break
            time.sleep(0.01)
        assert ready.exists()
        assert child.close() is True
        time.sleep(2.5)
        assert not sentinel.exists()
    finally:
        child.close()


def test_windows_job_close_failure_retains_slot_until_retry(monkeypatch: pytest.MonkeyPatch) -> None:
    class Kernel:
        def __init__(self) -> None:
            self.calls = 0

        def CloseHandle(self, _handle: int) -> bool:
            self.calls += 1
            return self.calls >= 4

    class Slot:
        releases = 0

        def release(self) -> None:
            self.releases += 1

    class Process:
        def poll(self) -> int:
            return 0

        def wait(self, timeout: float) -> int:
            return 0

    monkeypatch.setattr(supervisor.os, "name", "nt")
    slot = Slot()
    job = supervisor._WindowsJob(123, Kernel())
    managed = supervisor.SupervisedProcess(Process(), "windows-job", 1, slot, job)  # type: ignore[arg-type]
    assert managed.close() is False
    assert slot.releases == 0
    assert job.handle == 123
    assert managed.close() is True
    assert slot.releases == 1
