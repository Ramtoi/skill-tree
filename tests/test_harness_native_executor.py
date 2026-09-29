from __future__ import annotations

import hashlib
import os
import platform
import subprocess
import sys
import tempfile
import time
from dataclasses import replace
from pathlib import Path
from types import MappingProxyType
from typing import Any

import pytest

from skill_hub.infrastructure.harnesses import harness_native_executor as native_executor
from skill_hub.infrastructure.harnesses.harness_native_executor import (
    NativeAuthorization,
    NativeBinding,
    NativeLimits,
    NativeRecipe,
    NativeRequest,
    NativeRuntimeIdentity,
    execute_native,
)
from tests.harness_supervision_helpers import fixture_launch


def _sha256(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def _binding() -> NativeBinding:
    return NativeBinding(
        package_id="fixture-package",
        release_version="1.0.0",
        release_digest="a" * 64,
        harness_id="fixture-harness",
        variant_id="default",
        profile="load",
        runtime_version="1.0.0",
        installation_id="fixture-installation",
    )


def _identity() -> NativeRuntimeIdentity:
    executable = Path(sys.executable).resolve()
    digest = _sha256(executable)
    return NativeRuntimeIdentity(
        package_id="fixture-package",
        harness_id="fixture-harness",
        installation_id="fixture-installation",
        runtime_version="1.0.0",
        release_version="1.0.0",
        release_digest="a" * 64,
        platform=sys.platform,
        arch=platform.machine(),
        executable_path=str(executable),
        executable_sha256=digest,
        variant_id="default",
        profile="load",
        evidence="fixture",
    )


def _recipe(*, code: str, proof_id: str = "artifact", limits: NativeLimits | None = None,
            isolation: dict[str, Any] | None = None, credential: str | None = None) -> NativeRecipe:
    return NativeRecipe(
        recipe_id="fixture-recipe",
        case_id="fixture-case",
        binding=_binding(),
        platform=sys.platform,
        arch=platform.machine(),
        executable_sha256=_identity().executable_sha256,
        argv_template=(sys.executable, "-c", code),
        isolation=isolation or {"roots": {"skill_hub": "skill-hub", "codex_home": "codex"}},
        credential_requirement=credential,
        proof_id=proof_id,
        retention=60,
        limits=limits or NativeLimits(wall_seconds=2),
    )


def _run(recipe: NativeRecipe, tmp_path: Path, *, identity: object | None = None, **kwargs: Any):
    return execute_native(
        NativeRequest("fixture-recipe", NativeAuthorization(True), kwargs.pop("credentials", {})),
        {"fixture-recipe": recipe},
        identity or _identity(),
        lambda _: tmp_path,
        supervisor=fixture_launch,
    )


def test_fixture_recipe_runs_in_redirected_roots_and_requires_closed_proof() -> None:
    code = (
        "import os; from pathlib import Path; "
        "assert Path(os.environ['HOME']).is_relative_to(Path(os.environ['SKILL_HUB_NATIVE_WORKSPACE']).parent); "
        "Path(os.environ['SKILL_HUB_NATIVE_PROOF_PATH']).write_text('READY', encoding='utf-8'); "
        "print('proof=READY secret=top-secret')"
    )
    # The executor deliberately accepts fixture sandboxes only below the
    # system disposable root.  Hosted CI configures pytest's basetemp below
    # its artifact directory, which is disposable but is not that root.
    with tempfile.TemporaryDirectory(prefix="skill-hub-native-fixture-") as sandbox:
        result = _run(
            _recipe(
                code=code,
                isolation={"roots": {"skill_hub": "skill-hub", "codex_home": "codex"},
                           "proof_token": "READY"},
            ),
            Path(sandbox),
            credentials={},
        )
    assert result.status == "pass"
    assert result.provenance == "fixture"
    assert result.proof["verdict"] == "pass"
    assert "top-secret" not in result.logs["stdout"]
    assert result.evidence["provenance"] == "fixture"


def test_exit_zero_without_proof_is_failure(tmp_path: Path) -> None:
    result = _run(_recipe(code="print('finished')"), tmp_path)
    assert result.status == "fail"
    assert "proof" in result.reason


def test_unknown_or_unauthorized_recipe_never_creates_a_process(tmp_path: Path) -> None:
    calls: list[str] = []
    request = NativeRequest("missing", False)
    result = execute_native(request, {}, _identity(), lambda _: calls.append("sandbox"))
    assert result.status == "blocked"
    assert calls == []

    recipe = _recipe(code="print('unexpected')")
    result = execute_native(NativeRequest("fixture-recipe", False), {"fixture-recipe": recipe}, _identity(),
                            lambda _: calls.append("sandbox"))
    assert result.status == "blocked"
    assert calls == []


@pytest.mark.parametrize(
    "change, reason",
    [
        ("runtime_version", "runtime identity runtime_version"),
        ("release_digest", "runtime identity release_digest"),
        ("executable_sha256", "runtime identity executable_sha256"),
    ],
)
def test_stale_identity_blocks_before_spawn(tmp_path: Path, change: str, reason: str) -> None:
    values = _identity().__dict__.copy()
    if change == "runtime_version":
        values[change] = "9.9.9"
    else:
        values[change] = "b" * 64
    stale = NativeRuntimeIdentity(**values)
    calls: list[str] = []
    result = execute_native(NativeRequest("fixture-recipe", True),
                            {"fixture-recipe": _recipe(code="print('unexpected')")}, stale,
                            lambda _: calls.append("sandbox"))
    assert result.status == "blocked"
    assert reason in result.reason
    assert calls == []


def test_nonzero_turn_or_spend_limits_are_blocked(tmp_path: Path) -> None:
    recipe = _recipe(code="print('unexpected')", limits=NativeLimits(wall_seconds=2, max_turns=1))
    result = _run(recipe, tmp_path)
    assert result.status == "blocked"
    assert "limit" in result.reason


def test_isolation_root_escape_and_missing_credential_are_blocked(tmp_path: Path) -> None:
    escaping = _recipe(code="print('unexpected')", isolation={"roots": {"bad": "../outside"}})
    result = _run(escaping, tmp_path)
    assert result.status == "blocked"
    assert "escapes" in result.reason

    credentialed = _recipe(code="print('unexpected')", credential="token")
    result = _run(credentialed, tmp_path)
    assert result.status == "blocked"
    assert "credential" in result.reason


def test_fixture_override_cannot_use_developer_home(tmp_path: Path) -> None:
    recipe = _recipe(code="print('unexpected')")
    result = execute_native(
        NativeRequest("fixture-recipe", True),
        {"fixture-recipe": recipe},
        _identity(),
        lambda _: Path("/") / "skill-hub-native-fixture",
    )
    assert result.status == "blocked"
    assert "temporary directory" in result.reason


def test_production_requires_probe_identity_and_canonical_sandbox(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    recipe = _recipe(code="print('unexpected')")
    production = MappingProxyType({"fixture-recipe": recipe})
    monkeypatch.setattr(native_executor, "NATIVE_RECIPES", production)
    request = NativeRequest("fixture-recipe", NativeAuthorization(True))

    fixture_identity = _identity()
    result = execute_native(request, production, fixture_identity, lambda _: tmp_path)
    assert result.status == "blocked"
    assert "typed probe identity" in result.reason

    result = execute_native(request, production, replace(_identity(), evidence="probe"), lambda _: tmp_path)
    assert result.status == "blocked"
    assert "canonical disposable sandbox" in result.reason


def test_token_verifier_is_closed_and_output_is_bounded(tmp_path: Path) -> None:
    token_recipe = _recipe(code="print('READY')", proof_id="token", isolation={"proof_token": "READY"})
    result = _run(token_recipe, tmp_path)
    assert result.status == "pass"

    noisy = _recipe(code="print('x' * 20000)")
    result = _run(noisy, tmp_path)
    assert result.status == "fail"
    assert "output" in result.reason
    assert len(result.logs["stdout"].encode()) <= 4_100


def test_named_ephemeral_credential_is_available_only_to_child_and_redacted(tmp_path: Path) -> None:
    code = (
        "import os; from pathlib import Path; "
        "assert os.environ['SKILL_HUB_NATIVE_CREDENTIAL_TOKEN'] == 'fixture-secret'; "
        "Path(os.environ['SKILL_HUB_NATIVE_PROOF_PATH']).write_text('READY'); "
        "print('token=fixture-secret')"
    )
    recipe = _recipe(
        code=code,
        isolation={"roots": {}, "proof_token": "READY"},
        credential="token",
    )
    result = _run(recipe, tmp_path, credentials={"token": "fixture-secret"})
    assert result.status == "pass"
    assert "fixture-secret" not in repr(result)


def test_timeout_is_bounded_and_returns_inconclusive(tmp_path: Path) -> None:
    started = time.monotonic()
    recipe = _recipe(code="import time; time.sleep(30)", limits=NativeLimits(0.1))
    result = _run(recipe, tmp_path)
    assert result.status == "inconclusive"
    assert "timed out" in result.reason
    assert time.monotonic() - started < 3


def test_keyboard_interrupt_after_spawn_is_cleaned(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    original_wait = subprocess.Popen.wait
    calls = 0

    def interrupt_once(process: subprocess.Popen[bytes], *args: Any, **kwargs: Any) -> int | None:
        nonlocal calls
        calls += 1
        if calls == 1:
            raise KeyboardInterrupt
        return original_wait(process, *args, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(subprocess.Popen, "wait", interrupt_once)
    result = _run(_recipe(code="import time; time.sleep(30)"), tmp_path)
    assert result.status == "inconclusive"
    assert "interrupted" in result.reason


def _pid_alive(pid: int) -> bool:
    if os.name != "nt":
        try:
            with Path("/proc") .joinpath(str(pid), "stat").open(encoding="utf-8") as stream:
                fields = stream.read().split()
            return len(fields) < 3 or fields[2] != "Z"
        except (FileNotFoundError, OSError):
            return False
    import ctypes
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)  # type: ignore[attr-defined]
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel32.WaitForSingleObject.restype = wintypes.DWORD
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle.restype = wintypes.BOOL
    handle = kernel32.OpenProcess(0x00100000, False, pid)
    if not handle:
        error = ctypes.get_last_error()  # type: ignore[attr-defined]
        if error == 87:
            return False
        raise AssertionError("OpenProcess failed: {}".format(error))
    try:
        state = kernel32.WaitForSingleObject(handle, 0)
        if state == 0xFFFFFFFF:
            raise AssertionError("WaitForSingleObject failed")
        return state == 0x00000102
    finally:
        kernel32.CloseHandle(handle)


def test_descendant_is_killed_after_parent_success(tmp_path: Path) -> None:
    child_code = (
        "import os, signal, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); "
        "open(os.path.join(os.environ['SKILL_HUB_NATIVE_WORKSPACE'], 'child.pid'), 'w').write(str(os.getpid())); "
        "time.sleep(30)"
    )
    parent_code = (
        "import os, subprocess, sys, time\n"
        "child = subprocess.Popen([sys.executable, '-c', "
        + repr(child_code)
        + "])\n"
        "pid = os.path.join(os.environ['SKILL_HUB_NATIVE_WORKSPACE'], 'child.pid')\n"
        "deadline = time.time() + 2\n"
        "while not os.path.exists(pid) and time.time() < deadline:\n"
        "    time.sleep(.01)\n"
        "print('READY')\n"
    )
    code = "exec(" + repr(parent_code) + ")"
    recipe = _recipe(code=code, proof_id="token", isolation={"proof_token": "READY"})
    result = _run(recipe, tmp_path)
    assert result.status == "pass", result.reason
    pid_file = tmp_path / "workspace" / "child.pid"
    assert pid_file.exists()
    pid = int(pid_file.read_text())
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline and _pid_alive(pid):
        time.sleep(0.02)
    assert not _pid_alive(pid)


def test_native_records_are_immutable() -> None:
    recipe = _recipe(code="print('READY')", proof_id="token", isolation={"proof_token": "READY"})
    with pytest.raises(TypeError):
        recipe.isolation["new"] = "value"  # type: ignore[index]


@pytest.mark.parametrize(
    ("recipe_platform", "identity_platform"),
    [("macos", "darwin"), ("windows", "win32"), ("linux", "linux")],
)
def test_platform_aliases_match_catalog_and_runtime_vocabularies(recipe_platform, identity_platform) -> None:
    recipe = replace(_recipe(code="print('READY')", proof_id="token", isolation={"proof_token": "READY"}),
                     platform=recipe_platform)
    identity = replace(_identity(), platform=identity_platform)
    assert native_executor._matches(recipe, identity) is None


@pytest.mark.skipif(os.name == "nt", reason="POSIX symlink fixture")
def test_symlinked_executable_identity_is_resolved_before_argv_validation(tmp_path: Path) -> None:
    target = Path(sys.executable).resolve()
    link = tmp_path / "opencode"
    link.symlink_to(target)
    recipe = replace(
        _recipe(code="print('READY')", proof_id="token", isolation={"proof_token": "READY"}),
        argv_template=(str(link), "-c", "print('READY')"),
    )
    identity = replace(_identity(), executable_path=str(link))
    result = _run(recipe, tmp_path, identity=identity)
    assert result.status == "pass", result.reason


def test_bounded_reader_reads_file_descriptor_without_buffered_stream_read() -> None:
    read_fd, write_fd = os.pipe()
    try:
        os.write(write_fd, b"fixture-output")
        os.close(write_fd)

        class Stream:
            def fileno(self) -> int:
                return read_fd

            def read(self, size: int) -> bytes:
                raise AssertionError("reader must avoid BufferedReader.read")

        output = bytearray()
        overflow = [False]
        native_executor._bounded_reader(Stream(), output, overflow)
        assert bytes(output) == b"fixture-output"
        assert overflow == [False]
    finally:
        try:
            os.close(read_fd)
        except OSError:
            pass


def test_relative_executable_identity_is_rejected_before_resolution(tmp_path):
    recipe = _recipe(code="print('READY')", proof_id="token", isolation={"proof_token": "READY"})
    result = _run(recipe, tmp_path, identity=replace(_identity(), executable_path="python"))
    assert result.status == "blocked"
    assert "not absolute" in result.reason


@pytest.mark.skipif(os.name == "nt", reason="POSIX symlink fixture")
def test_executable_symlink_cannot_retarget_after_digest_check(tmp_path, monkeypatch):
    target = Path(sys.executable).resolve()
    link = tmp_path / "runtime"
    link.symlink_to(target)
    other = tmp_path / "different-runtime"
    other.write_text("must never execute")
    recipe = replace(_recipe(code="print('READY')", proof_id="token", isolation={"proof_token": "READY"}),
                     argv_template=(str(link), "-c", "print('READY')"))
    original = native_executor._matches

    def matches(recipe, identity, executable=None):
        mismatch = original(recipe, identity, executable)
        link.unlink()
        link.symlink_to(other)
        return mismatch

    monkeypatch.setattr(native_executor, "_matches", matches)
    result = _run(recipe, tmp_path, identity=replace(_identity(), executable_path=str(link)))
    assert result.status == "blocked"
    assert "resolved executable" in result.reason


def test_native_environment_preserves_architecture_without_credentials(tmp_path, monkeypatch):
    monkeypatch.setenv("PROCESSOR_ARCHITECTURE", "AMD64")
    monkeypatch.setenv("PROCESSOR_ARCHITEW6432", "ARM64")
    monkeypatch.setenv("DEMO_API_TOKEN", "fixture-private-token")
    env = native_executor._safe_environment({"sandbox": tmp_path, "workspace": tmp_path / "workspace"})
    assert env["PROCESSOR_ARCHITECTURE"] == "AMD64"
    assert env["PROCESSOR_ARCHITEW6432"] == "ARM64"
    assert "DEMO_API_TOKEN" not in env
