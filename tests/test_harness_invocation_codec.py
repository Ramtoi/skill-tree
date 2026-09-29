"""Portable SDK boundary for native invocation capabilities."""

import os
import shutil
import subprocess
import sys
from dataclasses import FrozenInstanceError
from pathlib import Path

import pytest
import ruamel.yaml

from skill_hub.domain.harnesses.harness_adapter_api import InvocationNativeCodec, NativeInvocationError
from skill_hub.infrastructure.harnesses.harness_bundled_invocation import (
    codex_implicit,
    render_codex_policy,
    resolve_capability,
    yaml_backend,
)


@pytest.mark.parametrize("harness,mode,profile,support,implicit,explicit", [
    ("claude-code", "model-only", "unknown", "enforced", "enabled", "hidden"),
    ("pi", "model-only", "unknown", "unsupported", "enabled", "available"),
    ("codex", "user-only", "unknown", "enforced", "disabled", "available"),
    # TA-1-7f2c: these two used to be pinned only inside a subprocess `-c`
    # script whose own pytest-visible assertion was about importability, so a
    # regression in either branch was invisible to coverage and mutation
    # tooling. Pinned here, in process, alongside the rest of the table.
    ("codex", "model-only", "unknown", "unsupported", "enabled", "available"),
    ("codex", "auto", "unknown", "native", "enabled", "available"),
    ("opencode", "user-only", "opencode-v1.18.31", "unsupported", "enabled", "available"),
    ("opencode", "user-only", "opencode-v1.18.31-command-eligible", "enforced", "disabled", "available"),
    ("opencode", "auto", "unverified-new-release", "unknown", "unknown", "unknown"),
    ("unknown", "auto", "unknown", "unknown", "unknown", "unknown"),
])
def test_native_invocation_support_boundaries(harness, mode, profile, support, implicit, explicit):
    result = resolve_capability(harness, mode, profile=profile)
    assert (result.support, result.implicit_behavior, result.explicit_behavior) == (support, implicit, explicit)


def test_capability_is_immutable_and_preserves_host_reason():
    result = resolve_capability("codex", "model-only", reason_code="host-precondition")
    assert result.reason_code == "host-precondition"
    assert isinstance(result.limitations, tuple)
    with pytest.raises(FrozenInstanceError):
        result.support = "enforced"
    assert resolve_capability("codex", "auto", source_implicit=False).implicit_behavior == "disabled"


def test_native_invocation_imports_with_sdk_only(tmp_path):
    """Import-only obligation (host modules absent from PYTHONPATH); the
    trailing call is deliberately the harness-independent 'unknown' branch,
    stable regardless of any codex/opencode rule change, so this test carries
    only its import obligation. The codec's real rule table lives in
    ``test_native_invocation_support_boundaries`` above (TA-1-7f2c)."""
    root = Path(__file__).resolve().parents[1]
    for name in (
        "skill_hub/domain/harnesses/harness_adapter_api.py",
        "skill_hub/infrastructure/harnesses/harness_bundled_invocation.py",
    ):
        (tmp_path / name).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(root / name, tmp_path / name)
    env = dict(os.environ, PYTHONPATH=str(tmp_path))
    completed = subprocess.run([
        sys.executable, "-S", "-c",
        "from skill_hub.infrastructure.harnesses.harness_bundled_invocation import resolve_capability; "
        "assert resolve_capability('unknown', 'auto').support == 'unknown'",
    ], cwd=tmp_path, env=env, capture_output=True, text=True, timeout=10)
    assert completed.returncode == 0, completed.stderr


def test_bundled_resolver_implements_callable_sdk_contract():
    codec: InvocationNativeCodec = resolve_capability
    assert codec("pi", "model-only").support == "unsupported"


def test_bundled_codex_codec_round_trips_native_bytes_with_explicit_backend():
    source = b"# retain\r\npolicy:\r\n  allow_implicit_invocation: true\r\n"

    rendered = render_codex_policy(
        source, "user-only", yaml_factory=lambda: yaml_backend(ruamel.yaml.YAML)
    )

    assert rendered is not None
    assert rendered.startswith(b"# retain\r\n")
    assert b"allow_implicit_invocation: false\r\n" in rendered
    assert codex_implicit(rendered) is False


def test_bundled_codex_codec_reports_missing_round_trip_backend():
    with pytest.raises(NativeInvocationError) as exc_info:
        render_codex_policy(b"policy: {}\n", "user-only", yaml_factory=None)

    assert exc_info.value.code == "yaml-backend-unavailable"


def test_bundled_codec_imports_without_yaml_dependency(tmp_path):
    """Import-only obligation (no yaml dependency on PYTHONPATH); same
    harness-independent trailing call as the sdk-only import test above, kept
    as a separate test because it covers a different dependency set."""
    root = Path(__file__).resolve().parents[1]
    for name in (
        "skill_hub/domain/harnesses/harness_adapter_api.py",
        "skill_hub/infrastructure/harnesses/harness_bundled_invocation.py",
    ):
        (tmp_path / name).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(root / name, tmp_path / name)
    env = dict(os.environ, PYTHONPATH=str(tmp_path))
    completed = subprocess.run(
        [
            sys.executable,
            "-S",
            "-c",
            "from skill_hub.infrastructure.harnesses.harness_bundled_invocation import resolve_capability; "
            "assert resolve_capability('unknown', 'auto').support == 'unknown'",
        ],
        cwd=tmp_path,
        env=env,
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert completed.returncode == 0, completed.stderr


def test_bundled_codec_renders_with_copied_pure_python_yaml(tmp_path):
    root = Path(__file__).resolve().parents[1]
    for name in (
        "skill_hub/domain/harnesses/harness_adapter_api.py",
        "skill_hub/infrastructure/harnesses/harness_bundled_invocation.py",
    ):
        (tmp_path / name).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(root / name, tmp_path / name)

    yaml_package = Path(ruamel.yaml.__file__).parents[1]

    def ignore_native(_directory: str, names: list[str]) -> list[str]:
        return [name for name in names if Path(name).suffix.lower() in {".so", ".pyd", ".dll"}]

    shutil.copytree(yaml_package, tmp_path / "ruamel", ignore=ignore_native)
    env = dict(os.environ, PYTHONPATH=str(tmp_path))
    completed = subprocess.run(
        [
            sys.executable,
            "-S",
            "-c",
            "from skill_hub.infrastructure.harnesses.harness_bundled_invocation import render_codex_policy; "
            "source=b'policy: {allow_implicit_invocation: true}\\n'; "
            "result=render_codex_policy(source, 'user-only'); "
            "assert b'allow_implicit_invocation: false' in result",
        ],
        cwd=tmp_path,
        env=env,
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert completed.returncode == 0, completed.stderr
