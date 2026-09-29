"""Bounded runtime inventory and cache helpers.

The collector is intentionally explicit about every source it reads.  It never
installs, activates, or writes unless a caller supplies a cache destination.
"""

from __future__ import annotations

import ctypes
import hashlib
import json
import math
import os
import platform
import re
import signal
import subprocess
import tempfile
import threading
from ctypes import wintypes
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from types import MappingProxyType
from typing import Any, Callable, Iterable, Mapping, Optional, Sequence, Tuple

from skill_hub.domain.harnesses.harness_adapter_api import ProbeOutcome, RuntimeIdentity, Version

CACHE_SCHEMA_VERSION = 1
DEFAULT_MAX_OUTPUT_BYTES = 8192
DEFAULT_TIMEOUT_SECONDS = 3.0
KNOWN_FALLBACK_DIRS = (
    "~/.local/bin",
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "~/.bun/bin",
    "~/.volta/bin",
    "~/.npm-global/bin",
)
HARNESS_EXECUTABLES = {
    "claude-code": ("claude",),
    "codex": ("codex",),
    "pi": ("pi",),
    "opencode": ("opencode",),
}
UNSUPPORTED_WRAPPER_SUFFIXES = frozenset({".sh", ".bash", ".zsh", ".fish", ".ps1"})


class _WindowsJob:
    def __init__(self, handle: Any, kernel32: Any) -> None:
        self.handle = handle
        self.kernel32 = kernel32

    def close(self) -> None:
        if self.handle:
            if not self.kernel32.CloseHandle(self.handle):
                error = getattr(ctypes, "get_last_error", lambda: 0)()
                raise OSError(error, "CloseHandle failed")
            self.handle = None


def _windows_job_for(process: subprocess.Popen[Any]) -> Optional[_WindowsJob]:
    """Assign a probe process to a kill-on-close Windows Job Object."""
    if os.name != "nt":
        return None
    win_dll = getattr(ctypes, "WinDLL")
    win_error = getattr(ctypes, "WinError")
    get_last_error = getattr(ctypes, "get_last_error")
    kernel32 = win_dll("kernel32", use_last_error=True)

    class BasicLimitInformation(ctypes.Structure):
        _fields_ = [
            ("PerProcessUserTimeLimit", ctypes.c_longlong),
            ("PerJobUserTimeLimit", ctypes.c_longlong),
            ("LimitFlags", wintypes.DWORD),
            ("MinimumWorkingSetSize", ctypes.c_size_t),
            ("MaximumWorkingSetSize", ctypes.c_size_t),
            ("ActiveProcessLimit", wintypes.DWORD),
            ("Affinity", ctypes.c_size_t),
            ("PriorityClass", wintypes.DWORD),
            ("SchedulingClass", wintypes.DWORD),
        ]

    class IoCounters(ctypes.Structure):
        _fields_ = [(name, ctypes.c_ulonglong) for name in (
            "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
            "ReadTransferCount", "WriteTransferCount", "OtherTransferCount",
        )]

    class ExtendedLimitInformation(ctypes.Structure):
        _fields_ = [
            ("BasicLimitInformation", BasicLimitInformation),
            ("IoInfo", IoCounters),
            ("ProcessMemoryLimit", ctypes.c_size_t),
            ("JobMemoryLimit", ctypes.c_size_t),
            ("PeakProcessMemoryUsed", ctypes.c_size_t),
            ("PeakJobMemoryUsed", ctypes.c_size_t),
        ]

    kernel32.CreateJobObjectW.argtypes = [wintypes.LPVOID, wintypes.LPCWSTR]
    kernel32.CreateJobObjectW.restype = wintypes.HANDLE
    kernel32.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, wintypes.LPVOID, wintypes.DWORD]
    kernel32.SetInformationJobObject.restype = wintypes.BOOL
    kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    kernel32.AssignProcessToJobObject.restype = wintypes.BOOL
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle.restype = wintypes.BOOL
    handle = kernel32.CreateJobObjectW(None, None)
    if not handle:
        raise win_error(get_last_error())
    job = _WindowsJob(handle, kernel32)
    try:
        limits = ExtendedLimitInformation()
        limits.BasicLimitInformation.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not kernel32.SetInformationJobObject(
            handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)
        ) or not kernel32.AssignProcessToJobObject(handle, wintypes.HANDLE(getattr(process, "_handle"))):
            raise win_error(get_last_error())
    except BaseException:
        job.close()
        raise
    return job


@dataclass(frozen=True)
class InventoryRequest:
    """Explicit collection inputs; no registry or user home is consulted."""

    harnesses: Tuple[str, ...] = tuple(HARNESS_EXECUTABLES)
    path: Optional[str] = None
    fallback_dirs: Tuple[str, ...] = KNOWN_FALLBACK_DIRS
    home_overrides: Mapping[str, str] = field(default_factory=lambda: MappingProxyType({}))
    marker_dirs: Mapping[str, Tuple[str, ...]] = field(default_factory=lambda: MappingProxyType({}))
    config_paths: Mapping[str, Tuple[str, ...]] = field(default_factory=lambda: MappingProxyType({}))
    os_name: Optional[str] = None
    os_version: Optional[str] = None
    architecture: Optional[str] = None
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS
    max_output_bytes: int = DEFAULT_MAX_OUTPUT_BYTES

    def __post_init__(self) -> None:
        object.__setattr__(self, "harnesses", tuple(dict.fromkeys(self.harnesses)))
        object.__setattr__(self, "fallback_dirs", tuple(self.fallback_dirs))
        object.__setattr__(self, "home_overrides", MappingProxyType(dict(self.home_overrides)))
        object.__setattr__(
            self,
            "marker_dirs",
            MappingProxyType({key: tuple(value) for key, value in self.marker_dirs.items()}),
        )
        object.__setattr__(
            self,
            "config_paths",
            MappingProxyType({key: tuple(value) for key, value in self.config_paths.items()}),
        )
        if (
            not math.isfinite(self.timeout_seconds)
            or self.timeout_seconds <= 0
            or self.max_output_bytes <= 0
        ):
            raise ValueError("inventory bounds must be positive")


@dataclass(frozen=True)
class RunnerResult:
    returncode: Optional[int]
    stdout: str = ""
    stderr: str = ""
    timed_out: bool = False
    error: Optional[str] = None
    truncated: bool = False


ProbeRunner = Callable[[Sequence[str], float, int], RunnerResult]
Clock = Callable[[], datetime]


def _utc_observed_at(clock: Optional[Clock]) -> str:
    value = (clock or (lambda: datetime.now(timezone.utc)))()
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat()


@dataclass(frozen=True)
class RuntimeInventory:
    identities: Tuple[RuntimeIdentity, ...]
    request_fingerprint: str
    schema_version: int = CACHE_SCHEMA_VERSION
    observed_at: Optional[str] = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "identities", tuple(self.identities))


def _expand_path(raw: str, home: Optional[str]) -> Path:
    if raw.startswith("~/") and home is not None:
        return Path(home) / raw[2:]
    return Path(raw).expanduser()


def _platform_name(request: InventoryRequest) -> str:
    name = (request.os_name or platform.system()).casefold()
    return {"darwin": "macos", "win32": "windows"}.get(name, name)


def _candidate_names(name: str, request: InventoryRequest) -> Tuple[str, ...]:
    if _platform_name(request).startswith("win"):
        return (name, name + ".exe", name + ".cmd")
    return (name, name + ".sh", name + ".bash", name + ".zsh", name + ".fish")


def _unsupported_wrapper(path: str) -> bool:
    suffix = Path(path).suffix.casefold()
    if suffix in UNSUPPORTED_WRAPPER_SUFFIXES:
        return True
    try:
        with Path(path).open("rb") as stream:
            prefix = stream.read(160).lower()
    except OSError:
        return False
    return prefix.startswith(b"#!") and any(token in prefix for token in (b"/sh", b"/bash", b"/zsh", b"/fish"))


def _request_fingerprint(request: InventoryRequest) -> str:
    payload = {
        "schema": CACHE_SCHEMA_VERSION,
        "harnesses": sorted(request.harnesses),
        "path": request.path if request.path is not None else os.environ.get("PATH", ""),
        "fallback": list(request.fallback_dirs),
        "homes": dict(sorted(request.home_overrides.items())),
        "markers": {key: list(value) for key, value in sorted(request.marker_dirs.items())},
        "config_paths": {key: list(value) for key, value in sorted(request.config_paths.items())},
        "os": _platform_name(request),
        "os_version": request.os_version or platform.release(),
        "arch": request.architecture or platform.machine(),
    }
    data = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(data).hexdigest()


def executable_fingerprint(path: Optional[str]) -> Optional[str]:
    """Return a stable bounded fingerprint for a candidate executable."""
    if not path:
        return None
    target = Path(path)
    try:
        stat = target.stat()
        digest = hashlib.sha256()
        with target.open("rb") as stream:
            digest.update(stream.read(1024 * 1024))
        digest.update(f"\0{stat.st_size}\0{stat.st_mtime_ns}".encode())
        return "sha256:" + digest.hexdigest()
    except OSError:
        return None


def _config_fingerprint(request: InventoryRequest, harness_id: str) -> str:
    paths = request.marker_dirs.get(harness_id, ()) + request.config_paths.get(harness_id, ())
    payload: list[Any] = []
    for raw in paths:
        path = _expand_path(raw, request.home_overrides.get(harness_id))
        try:
            stat = path.stat()
            payload.append((str(path), stat.st_size, stat.st_mtime_ns, path.is_dir()))
        except OSError:
            payload.append((str(path), None))
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


def _parse_version(output: str, harness_id: str) -> Optional[Version]:
    line = output.strip()
    labels = {
        # Claude documents ``claude --version`` as ``<version> (Claude Code)``.
        "claude-code": r"(?:claude(?:\s+code)?)?",
        "codex": r"(?:codex(?:-cli)?)?",
        "pi": r"(?:pi)?",
        "opencode": r"(?:opencode)?",
    }
    label = labels.get(harness_id)
    if label is None:
        return None
    suffix = r"\s*\(Claude Code\)" if harness_id == "claude-code" else r""
    match = re.fullmatch(
        label + r"\s*[vV]?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)" + suffix + r"\s*",
        line,
        re.IGNORECASE,
    )
    return Version.parse(match.group(1)) if match is not None else None


def _bounded(value: str, limit: int) -> Tuple[str, bool]:
    encoded = value.encode("utf-8", errors="replace")
    if len(encoded) <= limit:
        return value, False
    return encoded[:limit].decode("utf-8", errors="ignore"), True


def _terminate_process_tree(process: subprocess.Popen[Any], job: Optional[_WindowsJob] = None) -> None:
    """Best-effort tree cleanup with a bounded final reap."""
    try:
        if os.name == "nt":
            try:
                subprocess.run(
                    ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    timeout=1,
                    check=False,
                )
            except (OSError, subprocess.TimeoutExpired):
                pass
            if process.poll() is None:
                try:
                    process.kill()
                except OSError:
                    pass
        else:
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except OSError:
                try:
                    process.kill()
                except OSError:
                    pass
            try:
                process.wait(timeout=0.5)
            except subprocess.TimeoutExpired:
                pass
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except OSError:
                try:
                    process.kill()
                except OSError:
                    pass
        try:
            process.wait(timeout=1)
        except subprocess.TimeoutExpired:
            pass
    finally:
        if job is not None:
            job.close()


def _default_runner(argv: Sequence[str], timeout_seconds: float, max_output_bytes: int) -> RunnerResult:
    """Run exactly one allowlisted version command and reap its process tree."""
    if len(argv) != 2 or argv[1] != "--version" or Path(argv[0]).suffix.casefold() in UNSUPPORTED_WRAPPER_SUFFIXES:
        return RunnerResult(None, error="probe command is not allowlisted")
    process: Optional[subprocess.Popen[bytes]] = None
    job: Optional[_WindowsJob] = None
    cleaned = False
    try:
        kwargs: dict[str, Any] = {
            "stdout": subprocess.PIPE,
            "stderr": subprocess.PIPE,
            "text": False,
            "start_new_session": os.name != "nt",
        }
        if os.name == "nt":
            kwargs["creationflags"] = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        process = subprocess.Popen(list(argv), **kwargs)
        try:
            job = _windows_job_for(process)
        except BaseException:
            _terminate_process_tree(process)
            raise
        stdout_chunks: list[bytes] = []
        stderr_chunks: list[bytes] = []
        output_truncated = [False]

        def drain(stream: Any, chunks: list[bytes]) -> None:
            while True:
                chunk = stream.read(4096)
                if not chunk:
                    return
                encoded = bytes(chunk)
                current = sum(len(item) for item in chunks)
                if current < max_output_bytes:
                    remaining = max_output_bytes - current
                    if len(encoded) > remaining:
                        output_truncated[0] = True
                    chunks.append(encoded[:remaining])
                else:
                    output_truncated[0] = True

        stdout_thread = threading.Thread(target=drain, args=(process.stdout, stdout_chunks), daemon=True)
        stderr_thread = threading.Thread(target=drain, args=(process.stderr, stderr_chunks), daemon=True)
        stdout_thread.start()
        stderr_thread.start()
        try:
            process.wait(timeout=timeout_seconds)
        except subprocess.TimeoutExpired:
            _terminate_process_tree(process, job)
            cleaned = True
            stdout_thread.join(timeout=1)
            stderr_thread.join(timeout=1)
            return RunnerResult(
                process.returncode,
                b"".join(stdout_chunks).decode("utf-8", errors="replace"),
                b"".join(stderr_chunks).decode("utf-8", errors="replace"),
                timed_out=True,
                error="probe timeout",
                truncated=output_truncated[0],
            )
        _terminate_process_tree(process, job)
        cleaned = True
        stdout_thread.join(timeout=1)
        stderr_thread.join(timeout=1)
        return RunnerResult(
            process.returncode,
            b"".join(stdout_chunks).decode("utf-8", errors="replace"),
            b"".join(stderr_chunks).decode("utf-8", errors="replace"),
            truncated=output_truncated[0],
        )
    except (OSError, ValueError) as exc:
        return RunnerResult(None, error=str(exc))
    finally:
        if process is not None and not cleaned:
            _terminate_process_tree(process, job)


def _discover_paths(request: InventoryRequest) -> Iterable[Tuple[str, str]]:
    path_entries = (request.path if request.path is not None else os.environ.get("PATH", "")).split(os.pathsep)
    directories = [item for item in path_entries if item]
    directories.extend(request.fallback_dirs)
    seen_paths = set()
    for harness_id in request.harnesses:
        for raw_directory in directories:
            directory = _expand_path(raw_directory, request.home_overrides.get(harness_id))
            for executable in HARNESS_EXECUTABLES.get(harness_id, ()):
                for name in _candidate_names(executable, request):
                    path = directory / name
                    key = str(path.absolute())
                    if key in seen_paths or not path.is_file():
                        continue
                    if not _platform_name(request).startswith("win") and not os.access(path, os.X_OK):
                        continue
                    seen_paths.add(key)
                    yield harness_id, key


def _candidate_fingerprints(request: InventoryRequest) -> set[Tuple[str, Optional[str]]]:
    """Fingerprint candidates without probing or spawning a process."""
    return {(path, executable_fingerprint(path)) for _, path in _discover_paths(request)}


def _identity_from_candidate(
    harness_id: str, path: str, request: InventoryRequest, runner: ProbeRunner, observed_at: str
) -> RuntimeIdentity:
    if _unsupported_wrapper(path):
        outcome = ProbeOutcome(
            "unsupported_wrapper",
            error="shell wrapper is not an executable probe target",
            observed_at=observed_at,
        )
    else:
        result = runner((path, "--version"), request.timeout_seconds, request.max_output_bytes)
        combined = result.stdout or result.stderr or ""
        raw, truncated = _bounded(combined, request.max_output_bytes)
        version = (
            _parse_version(raw, harness_id)
            if not result.timed_out and result.returncode == 0 and not (result.truncated or truncated)
            else None
        )
        if result.timed_out:
            status = "timeout"
        elif result.returncode != 0:
            status = "failed"
        elif version is None:
            status = "unknown_version"
        else:
            status = "ok"
        outcome = ProbeOutcome(
            status=status,
            raw_output=raw,
            normalized_version=version,
            exit_code=result.returncode,
            error=result.error,
            timed_out=result.timed_out,
            truncated=result.truncated or truncated,
            observed_at=observed_at,
        )
    return RuntimeIdentity(
        harness_id=harness_id,
        installation_id=path,
        executable_path=path,
        raw_version=outcome.raw_output,
        version=outcome.normalized_version,
        environment="cli",
        os_name=_platform_name(request),
        os_version=request.os_version or platform.release(),
        architecture=request.architecture or platform.machine(),
        home_root=request.home_overrides.get(harness_id),
        config_root=request.home_overrides.get(harness_id),
        root_identity=str(Path(path).parent),
        probe=outcome,
        executable_fingerprint=executable_fingerprint(path),
        config_fingerprint=_config_fingerprint(request, harness_id),
        evidence="probe",
        observed_at=observed_at,
    )


def inventory(
    request: InventoryRequest, runner: Optional[ProbeRunner] = None, clock: Optional[Clock] = None
) -> RuntimeInventory:
    """Collect distinct CLI installations using an injected bounded runner."""
    if not isinstance(request, InventoryRequest):
        raise TypeError("inventory requires an explicit InventoryRequest")
    probe = runner or _default_runner
    observed_at = _utc_observed_at(clock)
    identities = []
    seen_realpaths = set()
    for harness_id, path in _discover_paths(request):
        try:
            real = str(Path(path).resolve())
        except OSError:
            real = path
        if real in seen_realpaths:
            continue
        seen_realpaths.add(real)
        identities.append(_identity_from_candidate(harness_id, path, request, probe, observed_at))
    # Markers are configuration evidence only.  They never provide a version
    # and never replace a discovered executable.
    for harness_id, paths in request.marker_dirs.items():
        if any(item.harness_id == harness_id and item.executable_path for item in identities):
            # The marker contributes to the executable identity's config
            # fingerprint; it is not a second installation target.
            continue
        for raw in paths:
            marker_path = _expand_path(raw, request.home_overrides.get(harness_id))
            if not marker_path.exists():
                continue
            identity_id = "marker:" + str(marker_path)
            if any(item.installation_id == identity_id for item in identities):
                continue
            identities.append(
                RuntimeIdentity(
                    harness_id=harness_id,
                    installation_id=identity_id,
                    environment="unknown",
                    os_name=_platform_name(request),
                    os_version=request.os_version,
                    architecture=request.architecture or platform.machine(),
                    config_root=str(marker_path),
                    root_identity=str(marker_path.parent),
                    config_fingerprint=_config_fingerprint(request, harness_id),
                    evidence="directory_marker",
                    observed_at=observed_at,
                )
            )
    return RuntimeInventory(tuple(identities), _request_fingerprint(request), observed_at=observed_at)


collect_inventory = inventory


def revalidate_identity(identity: RuntimeIdentity) -> bool:
    """Check evidence immediately before a caller performs a later write."""
    if identity.executable_path is None or identity.executable_fingerprint is None:
        return False
    return executable_fingerprint(identity.executable_path) == identity.executable_fingerprint


def _identity_payload(identity: RuntimeIdentity) -> dict:
    probe = identity.probe
    return {
        "harness_id": identity.harness_id,
        "installation_id": identity.installation_id,
        "executable_path": identity.executable_path,
        "raw_version": identity.raw_version,
        "version": str(identity.version) if identity.version else None,
        "build": identity.build,
        "channel": identity.channel,
        "environment": identity.environment,
        "os_name": identity.os_name,
        "os_version": identity.os_version,
        "architecture": identity.architecture,
        "home_root": identity.home_root,
        "config_root": identity.config_root,
        "root_identity": identity.root_identity,
        "executable_fingerprint": identity.executable_fingerprint,
        "config_fingerprint": identity.config_fingerprint,
        "profile": identity.profile,
        "evidence": identity.evidence,
        "probe": {
            "status": probe.status,
            "raw_output": probe.raw_output,
            "normalized_version": str(probe.normalized_version) if probe.normalized_version else None,
            "exit_code": probe.exit_code,
            "error": probe.error,
            "timed_out": probe.timed_out,
            "truncated": probe.truncated,
            "observed_at": probe.observed_at,
        }
        if probe
        else None,
        "observed_at": identity.observed_at,
    }


def _identity_from_payload(data: Mapping[str, Any]) -> RuntimeIdentity:
    probe_data = data.get("probe")
    probe = None
    if isinstance(probe_data, Mapping):
        probe = ProbeOutcome(
            status=str(probe_data.get("status", "failed")),
            raw_output=str(probe_data.get("raw_output", "")),
            normalized_version=Version.parse(probe_data.get("normalized_version")),
            exit_code=probe_data.get("exit_code"),
            error=probe_data.get("error"),
            timed_out=bool(probe_data.get("timed_out", False)),
            truncated=bool(probe_data.get("truncated", False)),
            observed_at=probe_data.get("observed_at"),
        )
    return RuntimeIdentity(
        harness_id=str(data["harness_id"]),
        installation_id=str(data["installation_id"]),
        executable_path=data.get("executable_path"),
        raw_version=str(data.get("raw_version", "")),
        version=Version.parse(data.get("version")),
        build=data.get("build"),
        channel=data.get("channel"),
        environment=str(data.get("environment", "unknown")),
        os_name=str(data.get("os_name", "unknown")),
        os_version=data.get("os_version"),
        architecture=str(data.get("architecture", "unknown")),
        home_root=data.get("home_root"),
        config_root=data.get("config_root"),
        root_identity=data.get("root_identity"),
        probe=probe,
        executable_fingerprint=data.get("executable_fingerprint"),
        config_fingerprint=data.get("config_fingerprint"),
        profile=data.get("profile"),
        evidence=str(data.get("evidence", "probe")),
        observed_at=data.get("observed_at"),
    )


def write_inventory_cache(inventory_value: RuntimeInventory, path: Path) -> None:
    """Atomically persist a caller-selected cache path."""
    payload = inventory_payload(inventory_value)
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=path.name + ".", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(payload, stream, sort_keys=True, separators=(",", ":"))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    except BaseException:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise


def inventory_payload(inventory_value: RuntimeInventory) -> dict:
    """Serialize one runtime observation for cache and CLI consumers."""
    return {
        "schema_version": inventory_value.schema_version,
        "request_fingerprint": inventory_value.request_fingerprint,
        "observed_at": inventory_value.observed_at,
        "identities": [_identity_payload(item) for item in inventory_value.identities],
    }


def _inventory_from_cache_data(data: object, request: InventoryRequest) -> Optional[RuntimeInventory]:
    if not isinstance(data, Mapping) or data.get("schema_version") != CACHE_SCHEMA_VERSION:
        return None
    if data.get("request_fingerprint") != _request_fingerprint(request):
        return None
    rows = data.get("identities")
    if not isinstance(rows, list) or any(not isinstance(row, Mapping) for row in rows):
        return None
    try:
        identities = tuple(_identity_from_payload(row) for row in rows)
    except (KeyError, TypeError, ValueError):
        return None
    cached_candidates = {
        (identity.executable_path, identity.executable_fingerprint)
        for identity in identities
        if identity.executable_path is not None
    }
    if cached_candidates != _candidate_fingerprints(request):
        return None
    for identity in identities:
        if identity.executable_path and revalidate_identity(identity) is False:
            return None
        if identity.config_fingerprint != _config_fingerprint(request, identity.harness_id):
            return None
    return RuntimeInventory(identities, str(data["request_fingerprint"]), observed_at=data.get("observed_at"))


def read_inventory_cache(
    path: Path,
    request: InventoryRequest,
    fallback_requests: Sequence[InventoryRequest] = (),
) -> Optional[RuntimeInventory]:
    """Read one fresh cache file, trying explicitly supplied request shapes.

    The fallback is for a targeted CLI refresh to reuse an exact subset cache
    when the canonical full-harness request is absent.  It never probes and
    never treats a cache containing another request as fresh.
    """
    try:
        with Path(path).open(encoding="utf-8") as stream:
            data = json.load(stream)
    except (OSError, ValueError, TypeError):
        return None
    for candidate in (request, *fallback_requests):
        result = _inventory_from_cache_data(data, candidate)
        if result is not None:
            return result
    return None


load_inventory_cache = read_inventory_cache
save_inventory_cache = write_inventory_cache
