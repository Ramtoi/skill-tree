"""Small, process-level resource supervision for native harness calls.

This module deliberately has no Skill Hub imports.  It owns one local execution
slot and applies a memory limit to the target process tree before the target
starts.
"""

from __future__ import annotations

import contextlib
import ctypes
import ctypes.wintypes
import json
import os
import platform
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Iterator, Mapping, Optional, Sequence

DEFAULT_MEMORY_BYTES = 512 * 1024 * 1024
MAX_MEMORY_BYTES = 8 * 1024 * 1024 * 1024
_SLOT_ERROR = "native execution slot is already in use"
_DARWIN_ERROR = "native execution memory supervision is unavailable on macOS"


class SupervisionError(OSError):
    """A stable, caller-facing failure before or during supervised launch."""


def _default_lock_path() -> Path:
    if os.name == "nt":
        user = os.environ.get("USERNAME") or "user"
    else:
        user = str(getattr(os, "getuid", lambda: "user")())
    safe_user = "".join(ch if ch.isalnum() or ch in "._-" else "_" for ch in user)
    # Do not consult TMPDIR/TEMP: independent callers must share this slot.
    root = Path("/tmp") if os.name != "nt" else Path(r"C:\Windows\Temp")
    return root / ("skill-hub-native-execution-" + safe_user + ".lock")


class _ExecutionSlot:
    def __init__(self, path: Path) -> None:
        self.path = path
        self._fd: Optional[int] = None

    def acquire(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._fd = os.open(str(self.path), os.O_RDWR | os.O_CREAT, 0o600)
        try:
            if os.name == "nt":
                import msvcrt

                os.lseek(self._fd, 0, os.SEEK_SET)
                if os.fstat(self._fd).st_size == 0:
                    os.write(self._fd, b"0")
                    os.lseek(self._fd, 0, os.SEEK_SET)
                try:
                    msvcrt.locking(self._fd, msvcrt.LK_NBLCK, 1)  # type: ignore[attr-defined]
                except OSError as exc:
                    raise SupervisionError(_SLOT_ERROR) from exc
            else:
                import fcntl

                try:
                    fcntl.flock(self._fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except OSError as exc:
                    raise SupervisionError(_SLOT_ERROR) from exc
        except BaseException:
            os.close(self._fd)
            self._fd = None
            raise

    def release(self) -> None:
        if self._fd is None:
            return
        fd, self._fd = self._fd, None
        try:
            if os.name == "nt":
                import msvcrt

                os.lseek(fd, 0, os.SEEK_SET)
                with contextlib.suppress(OSError):
                    msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)  # type: ignore[attr-defined]
            else:
                import fcntl

                with contextlib.suppress(OSError):
                    fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)


class _WindowsMutexSlot:
    def __init__(self) -> None:
        self._kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)  # type: ignore[attr-defined]
        self._kernel32.CreateMutexW.argtypes = [ctypes.wintypes.LPVOID, ctypes.wintypes.BOOL, ctypes.wintypes.LPCWSTR]
        self._kernel32.CreateMutexW.restype = ctypes.wintypes.HANDLE
        self._kernel32.ReleaseMutex.argtypes = [ctypes.wintypes.HANDLE]
        self._kernel32.ReleaseMutex.restype = ctypes.wintypes.BOOL
        self._kernel32.CloseHandle.argtypes = [ctypes.wintypes.HANDLE]
        self._kernel32.CloseHandle.restype = ctypes.wintypes.BOOL
        self._handle: Optional[int] = None

    @staticmethod
    def _user_name() -> str:
        advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)  # type: ignore[attr-defined]
        advapi32.GetUserNameW.argtypes = [ctypes.wintypes.LPWSTR, ctypes.POINTER(ctypes.wintypes.DWORD)]
        advapi32.GetUserNameW.restype = ctypes.wintypes.BOOL
        size = ctypes.wintypes.DWORD(256)
        buffer = ctypes.create_unicode_buffer(size.value)
        if advapi32.GetUserNameW(buffer, ctypes.byref(size)):
            return buffer.value
        return "current-user"

    def acquire(self) -> None:
        name = "Local\\SkillHubNativeExecutionSlot-" + self._user_name()
        handle = self._kernel32.CreateMutexW(None, True, name)
        if not handle:
            raise SupervisionError("could not create native execution mutex")
        if ctypes.get_last_error() == 183:  # type: ignore[attr-defined]
            self._kernel32.CloseHandle(handle)
            raise SupervisionError(_SLOT_ERROR)
        self._handle = handle

    def release(self) -> None:
        if self._handle is None:
            return
        handle, self._handle = self._handle, None
        self._kernel32.ReleaseMutex(handle)
        self._kernel32.CloseHandle(handle)


@contextlib.contextmanager
def execution_slot(lock_path: Optional[os.PathLike[str] | str] = None) -> Iterator[None]:
    """Take the shared nonblocking per-user native execution slot."""

    slot: Any
    if os.name == "nt" and lock_path is None:
        slot = _WindowsMutexSlot()
    else:
        slot = _ExecutionSlot(Path(lock_path) if lock_path is not None else _default_lock_path())
    slot.acquire()
    try:
        yield None
    finally:
        slot.release()


_LINUX_TRAMPOLINE = (
    "import json,os,resource,sys;"
    "m=int(sys.argv[1]);resource.setrlimit(resource.RLIMIT_AS,(m,m));"
    "os.execvpe(sys.argv[2],json.loads(sys.argv[3]),os.environ)"
)


class WindowsProcessTree:
    def __init__(self, handle: int, kernel32: Any) -> None:
        self.handle = handle
        self._kernel32 = kernel32

    def close(self) -> bool:
        if not self.handle:
            return True
        for _ in range(3):
            if self._kernel32.CloseHandle(self.handle):
                self.handle = 0
                return True
            time.sleep(0.05)
        return False

    def terminate_and_close(self) -> bool:
        """Terminate all assigned processes, then release the kill-on-close job."""
        if self.handle:
            terminate = getattr(self._kernel32, "TerminateJobObject", None)
            if terminate is not None:
                terminate(self.handle, 1)
        return self.close()


_WindowsJob = WindowsProcessTree


def _windows_process_tree_for_handle(process_handle: int, memory_bytes: int | None = None) -> WindowsProcessTree:
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)  # type: ignore[attr-defined]
    kernel32.CreateJobObjectW.restype = ctypes.wintypes.HANDLE
    kernel32.CreateJobObjectW.argtypes = [ctypes.wintypes.LPVOID, ctypes.wintypes.LPCWSTR]
    kernel32.SetInformationJobObject.argtypes = [
        ctypes.wintypes.HANDLE, ctypes.c_int, ctypes.wintypes.LPVOID, ctypes.wintypes.DWORD
    ]
    kernel32.SetInformationJobObject.restype = ctypes.wintypes.BOOL
    kernel32.AssignProcessToJobObject.argtypes = [ctypes.wintypes.HANDLE, ctypes.wintypes.HANDLE]
    kernel32.AssignProcessToJobObject.restype = ctypes.wintypes.BOOL
    kernel32.CloseHandle.argtypes = [ctypes.wintypes.HANDLE]
    kernel32.CloseHandle.restype = ctypes.wintypes.BOOL
    kernel32.TerminateJobObject.argtypes = [ctypes.wintypes.HANDLE, ctypes.wintypes.UINT]
    kernel32.TerminateJobObject.restype = ctypes.wintypes.BOOL
    handle = kernel32.CreateJobObjectW(None, None)
    if not handle:
        raise SupervisionError("could not create native execution job")

    class BasicLimit(ctypes.Structure):
        _fields_ = [("PerProcessUserTimeLimit", ctypes.c_longlong), ("PerJobUserTimeLimit", ctypes.c_longlong),
                    ("LimitFlags", ctypes.wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                    ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", ctypes.wintypes.DWORD),
                    ("Affinity", ctypes.c_size_t), ("PriorityClass", ctypes.wintypes.DWORD),
                    ("SchedulingClass", ctypes.wintypes.DWORD)]

    class IoCounters(ctypes.Structure):
        _fields_ = [
            (name, ctypes.c_uint64)
            for name in (
                "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
                "ReadTransferCount", "WriteTransferCount", "OtherTransferCount",
            )
        ]

    class Extended(ctypes.Structure):
        _fields_ = [("BasicLimitInformation", BasicLimit), ("IoInfo", IoCounters),
                    ("ProcessMemoryLimit", ctypes.c_size_t), ("JobMemoryLimit", ctypes.c_size_t),
                    ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t)]

    info = Extended()
    info.BasicLimitInformation.LimitFlags = 0x2000  # kill-on-close; breakaway remains disabled
    if memory_bytes is not None:
        info.BasicLimitInformation.LimitFlags |= 0x100 | 0x200  # process and job memory limits
        info.ProcessMemoryLimit = memory_bytes
        info.JobMemoryLimit = memory_bytes
    if not kernel32.SetInformationJobObject(handle, 9, ctypes.byref(info), ctypes.sizeof(info)):
        kernel32.CloseHandle(handle)
        raise SupervisionError("could not configure native execution job")
    if not kernel32.AssignProcessToJobObject(handle, ctypes.wintypes.HANDLE(process_handle)):
        kernel32.CloseHandle(handle)
        raise SupervisionError("could not assign native execution job")
    return WindowsProcessTree(handle, kernel32)


def windows_process_tree_for_pid(pid: int) -> WindowsProcessTree:
    """Create a kill-on-close Windows process tree for an existing PID."""
    if os.name != "nt":
        raise SupervisionError("Windows process trees are unavailable on this operating system")
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)  # type: ignore[attr-defined]
    kernel32.OpenProcess.argtypes = [ctypes.wintypes.DWORD, ctypes.wintypes.BOOL, ctypes.wintypes.DWORD]
    kernel32.OpenProcess.restype = ctypes.wintypes.HANDLE
    kernel32.CloseHandle.argtypes = [ctypes.wintypes.HANDLE]
    kernel32.CloseHandle.restype = ctypes.wintypes.BOOL
    process_handle = kernel32.OpenProcess(0x0100 | 0x0001, False, pid)
    if not process_handle:
        raise SupervisionError("could not open native worker process")
    try:
        return _windows_process_tree_for_handle(process_handle)
    finally:
        kernel32.CloseHandle(process_handle)


def _windows_job_for(process: subprocess.Popen[Any], memory_bytes: int) -> WindowsProcessTree:
    return _windows_process_tree_for_handle(process._handle, memory_bytes)  # type: ignore[attr-defined]


class SupervisedProcess:
    """A launched process plus its held slot and OS cleanup state."""

    def __init__(self, process: subprocess.Popen[Any], memory_mode: str, memory_bytes: int, slot: _ExecutionSlot,
                 job: Optional[WindowsProcessTree] = None) -> None:
        self.process = process
        self.memory_mode = memory_mode
        self.memory_bytes = memory_bytes
        self._slot = slot
        self._job = job
        self._closed = False

    def close(self) -> bool:
        if self._closed:
            return True
        if os.name == "nt":
            if self._job is not None and self._job.handle:
                if self.process.poll() is None:
                    self._job._kernel32.TerminateJobObject(self._job.handle, 1)
                    with contextlib.suppress(subprocess.TimeoutExpired):
                        self.process.wait(timeout=2)
                if not self._job.close():
                    return False
            with contextlib.suppress(Exception):
                self.process.wait(timeout=2)
        else:
            cleanup_ok = True
            try:
                os.killpg(self.process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            except OSError:
                cleanup_ok = False
            try:
                self.process.wait(timeout=0.5)
            except subprocess.TimeoutExpired:
                pass
            except OSError:
                cleanup_ok = False
            try:
                # The leader can exit while a descendant ignores SIGTERM.
                # Always reap the owned group after the bounded grace period.
                os.killpg(self.process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            except OSError:
                cleanup_ok = False
            try:
                self.process.wait(timeout=2)
            except (OSError, subprocess.TimeoutExpired):
                cleanup_ok = False
            if not cleanup_ok:
                return False
        self._slot.release()
        self._closed = True
        return True

    def __enter__(self) -> "SupervisedProcess":
        return self

    def __exit__(self, *_: Any) -> None:
        self.close()


def _validate_memory(memory_bytes: int) -> None:
    if isinstance(memory_bytes, bool) or not isinstance(memory_bytes, int) or not 0 < memory_bytes <= MAX_MEMORY_BYTES:
        raise SupervisionError("memory_bytes must be a positive integer no larger than 8 GiB")


def launch(argv: Sequence[str], *, cwd: os.PathLike[str] | str, env: Mapping[str, str],
           stdout: Any = subprocess.PIPE, stderr: Any = subprocess.PIPE,
           memory_bytes: int = DEFAULT_MEMORY_BYTES,
           lock_path: Optional[os.PathLike[str] | str] = None) -> SupervisedProcess:
    """Launch ``argv`` under a bounded process tree and one local slot."""

    if not argv:
        raise SupervisionError("argv must not be empty")
    _validate_memory(memory_bytes)
    system = platform.system()
    if system == "Darwin":
        raise SupervisionError(_DARWIN_ERROR)
    if system not in {"Linux", "Windows"}:
        raise SupervisionError("native execution memory supervision is unavailable on this operating system")
    slot: Any
    if os.name == "nt" and lock_path is None:
        slot = _WindowsMutexSlot()
    else:
        slot = _ExecutionSlot(Path(lock_path) if lock_path is not None else _default_lock_path())
    slot.acquire()
    process: Optional[subprocess.Popen[Any]] = None
    job: Optional[WindowsProcessTree] = None
    try:
        target = [os.fspath(part) for part in argv]
        if os.name == "nt":
            bootstrap = (
                "import json,os,subprocess,sys;"
                "token=sys.stdin.buffer.read(1);"
                "sys.exit(125 if token != b'1' else subprocess.Popen(json.loads(sys.argv[1]),env=os.environ).wait())"
            )
            process = subprocess.Popen([sys.executable, "-c", bootstrap, json.dumps(target)], cwd=cwd, env=dict(env),
                                       stdin=subprocess.PIPE, stdout=stdout, stderr=stderr,
                                       creationflags=getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0))
            job = _windows_job_for(process, memory_bytes)
            assert process.stdin is not None
            process.stdin.write(b"1")
            process.stdin.close()
            return SupervisedProcess(process, "windows-job", memory_bytes, slot, job)
        process = subprocess.Popen(
            [sys.executable, "-c", _LINUX_TRAMPOLINE, str(memory_bytes), target[0], json.dumps(target)],
            cwd=cwd, env=dict(env), stdout=stdout, stderr=stderr, start_new_session=True,
        )
        return SupervisedProcess(process, "rlimit_as", memory_bytes, slot)
    except BaseException:
        if process is not None:
            with contextlib.suppress(Exception):
                if os.name == "nt" and job is not None:
                    job._kernel32.TerminateJobObject(job.handle, 1)
                elif process.poll() is None:
                    process.kill()
                process.wait(timeout=2)
                for stream in (process.stdin, process.stdout, process.stderr):
                    if stream is not None:
                        stream.close()
        if job is not None:
            job.close()
        slot.release()
        raise
