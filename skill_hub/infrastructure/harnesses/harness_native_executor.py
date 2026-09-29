"""Explicit, bounded execution of reviewed native harness recipes.

This module is deliberately independent of the registry and host layers.  A
recipe is data supplied by a trusted caller, while the production table is
empty until a first-party command and proof have been reviewed.  The runner
therefore has no shell, import, or catalog escape hatch.
"""

from __future__ import annotations

import hashlib
import math
import os
import platform as platform_module
import re
import signal
import subprocess
import sys
import tempfile
import threading
import time
from collections.abc import Callable, Iterator, Mapping, Sequence
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from types import MappingProxyType
from typing import Any, Optional, Union

MAX_OUTPUT_BYTES = 16_384
MAX_LOG_BYTES = 4_096
MAX_PROOF_BYTES = 4_096
MAX_RETENTION_SECONDS = 86_400
_SHA256 = re.compile(r"^(?:sha256:)?[0-9a-f]{64}$")
_TOKEN = re.compile(r"^[A-Za-z0-9_.:/=-]{1,128}$")
_PLACEHOLDER = re.compile(r"\{([A-Za-z][A-Za-z0-9_]*)\}")
_SAFE_ENV = frozenset(
    {
        "PATH",
        "LANG",
        "LANGUAGE",
        "TERM",
        "TZ",
        "CI",
        "NO_COLOR",
        "SYSTEMROOT",
        "COMSPEC",
        "PATHEXT",
        "PROCESSOR_ARCHITECTURE",
        "PROCESSOR_ARCHITEW6432",
        "VIRTUAL_ENV",
    }
)


def _freeze(value: Any) -> Any:
    if isinstance(value, Mapping):
        return MappingProxyType({str(key): _freeze(item) for key, item in value.items()})
    if isinstance(value, (list, tuple)):
        return tuple(_freeze(item) for item in value)
    if isinstance(value, set):
        return frozenset(_freeze(item) for item in value)
    return value


def _maps(value: Mapping[str, Any]) -> Mapping[str, Any]:
    return MappingProxyType({str(key): _freeze(item) for key, item in value.items()})


def _digest(value: str) -> str:
    normalized = value.removeprefix("sha256:").lower()
    if not re.fullmatch(r"[0-9a-f]{64}", normalized):
        raise ValueError("digest must be a SHA-256 hex digest")
    return "sha256:" + normalized


@dataclass(frozen=True)
class NativeBinding:
    package_id: str
    release_version: str
    release_digest: str
    harness_id: str
    variant_id: str
    profile: str
    runtime_version: str
    installation_id: str

    def __post_init__(self) -> None:
        if any(not isinstance(value, str) or not value.strip() for value in (
            self.package_id,
            self.release_version,
            self.harness_id,
            self.variant_id,
            self.profile,
            self.runtime_version,
            self.installation_id,
        )):
            raise ValueError("native binding fields must be non-empty strings")
        object.__setattr__(self, "release_digest", _digest(self.release_digest))


@dataclass(frozen=True)
class NativeRuntimeIdentity:
    """The observed identity used by exact recipe selection."""

    package_id: str
    harness_id: str
    installation_id: str
    runtime_version: str
    release_version: str
    release_digest: str
    platform: str
    arch: str
    executable_path: str
    executable_sha256: str
    variant_id: str = "default"
    profile: str = "default"
    evidence: str = "probe"

    def __post_init__(self) -> None:
        if any(not isinstance(value, str) or not value.strip() for value in (
            self.package_id,
            self.harness_id,
            self.installation_id,
            self.runtime_version,
            self.release_version,
            self.platform,
            self.arch,
            self.executable_path,
            self.variant_id,
            self.profile,
        )):
            raise ValueError("runtime identity fields must be non-empty strings")
        object.__setattr__(self, "release_digest", _digest(self.release_digest))
        object.__setattr__(self, "executable_sha256", _digest(self.executable_sha256))
        if self.evidence not in {"probe", "fixture"}:
            raise ValueError("runtime identity evidence is not fresh")


@dataclass(frozen=True)
class NativeLimits:
    wall_seconds: float = 5.0
    max_turns: int = 0
    max_spend: float = 0.0
    memory_bytes: int = 536_870_912

    def __post_init__(self) -> None:
        if (
            isinstance(self.memory_bytes, bool) or not isinstance(self.memory_bytes, int)
            or not 0 < self.memory_bytes <= 8_589_934_592
        ):
            raise ValueError("memory_bytes must be a positive integer no greater than 8 GiB")
        if (
            isinstance(self.wall_seconds, bool)
            or not isinstance(self.wall_seconds, (int, float))
            or not math.isfinite(self.wall_seconds)
            or self.wall_seconds <= 0
            or self.wall_seconds > 3_600
        ):
            raise ValueError("wall_seconds must be finite and positive")
        if isinstance(self.max_turns, bool) or not isinstance(self.max_turns, int) or self.max_turns < 0:
            raise ValueError("native limits cannot be negative")
        if (
            isinstance(self.max_spend, bool)
            or not isinstance(self.max_spend, (int, float))
            or self.max_spend < 0
            or not math.isfinite(self.max_spend)
        ):
            raise ValueError("max_spend must be finite")

    @property
    def enforceable(self) -> bool:
        # Generic turn and spend meters are intentionally unavailable.  A
        # recipe may run only when it explicitly promises zero of each.
        return self.max_turns == 0 and self.max_spend == 0


@dataclass(frozen=True)
class NativeRecipe:
    recipe_id: str
    case_id: str
    binding: NativeBinding
    platform: str
    arch: str
    executable_sha256: str
    argv_template: tuple[str, ...]
    isolation: Mapping[str, Any]
    credential_requirement: Optional[str]
    proof_id: str
    retention: int
    limits: NativeLimits = field(default_factory=NativeLimits)

    def __post_init__(self) -> None:
        if not self.recipe_id or not self.case_id or not self.platform or not self.arch:
            raise ValueError("native recipe identity is incomplete")
        if not self.argv_template or any(not isinstance(token, str) or not token for token in self.argv_template):
            raise ValueError("argv_template must contain non-empty tokens")
        if not _SHA256.fullmatch(self.executable_sha256):
            raise ValueError("recipe executable_sha256 must be a SHA-256 digest")
        if not self.proof_id or self.proof_id not in PROOF_VERIFIERS:
            raise ValueError("unknown native proof verifier")
        if self.retention < 0 or self.retention > MAX_RETENTION_SECONDS:
            raise ValueError("retention is outside the bounded range")
        if not isinstance(self.isolation, Mapping):
            raise ValueError("isolation must be a mapping of declared roots")
        object.__setattr__(self, "argv_template", tuple(self.argv_template))
        object.__setattr__(self, "isolation", _maps(self.isolation))
        object.__setattr__(self, "executable_sha256", _digest(self.executable_sha256))


@dataclass(frozen=True)
class NativeAuthorization:
    approved: bool
    scope: str = "native"

    def __post_init__(self) -> None:
        if not isinstance(self.approved, bool):
            raise ValueError("authorization approval must be boolean")
        if self.scope != "native":
            raise ValueError("authorization scope must be native")


@dataclass(frozen=True)
class NativeRequest:
    recipe_id: str
    authorization: Union[NativeAuthorization, bool] = False
    credentials: Mapping[str, str] = field(default_factory=lambda: MappingProxyType({}), repr=False)

    def __post_init__(self) -> None:
        if not self.recipe_id:
            raise ValueError("recipe_id is required")
        if not isinstance(self.authorization, (NativeAuthorization, bool)):
            raise ValueError("authorization must be explicit")
        if isinstance(self.authorization, bool) is False and not isinstance(self.authorization, NativeAuthorization):
            raise ValueError("authorization must be explicit")
        if not isinstance(self.credentials, Mapping) or any(
            not isinstance(key, str) or not isinstance(value, str)
            for key, value in self.credentials.items()
        ):
            raise ValueError("credentials must be a string mapping")
        object.__setattr__(self, "credentials", MappingProxyType(dict(self.credentials)))


NativeExecutionRequest = NativeRequest


@dataclass(frozen=True)
class NativeResult:
    status: str
    reason: str
    elapsed_seconds: float
    evidence: Mapping[str, Any] = field(default_factory=lambda: MappingProxyType({}))
    logs: Mapping[str, str] = field(default_factory=lambda: MappingProxyType({}))
    proof: Mapping[str, Any] = field(default_factory=lambda: MappingProxyType({}))
    provenance: str = "fixture"

    def __post_init__(self) -> None:
        if self.status not in {"pass", "blocked", "fail", "inconclusive"}:
            raise ValueError("unknown native result status")
        if self.provenance not in {"fixture", "native"}:
            raise ValueError("unknown native result provenance")
        object.__setattr__(self, "evidence", _maps(self.evidence))
        object.__setattr__(self, "logs", _maps(self.logs))
        object.__setattr__(self, "proof", _maps(self.proof))


# No command, parser, or proof is production-approved yet.
NATIVE_RECIPES: Mapping[str, NativeRecipe] = MappingProxyType({})


class _Sandbox:
    def __init__(self, path: Path, cleanup: Callable[[], None]) -> None:
        self.path = path
        self.cleanup = cleanup
        self.cleanup_error: Optional[BaseException] = None
        self.cleanup_done = False


@contextmanager
def _temporary_sandbox(_: NativeRecipe) -> Iterator[_Sandbox]:
    path = Path(tempfile.mkdtemp(prefix="skill-hub-native-"))
    sandbox = _Sandbox(path, lambda: _remove_tree(path))
    try:
        yield sandbox
    finally:
        _cleanup_sandbox(sandbox)


@contextmanager
def _path_context(value: Any) -> Iterator[Any]:
    yield value


def _remove_tree(path: Path) -> None:
    import shutil

    try:
        shutil.rmtree(path)
    except FileNotFoundError:
        pass


def _cleanup_sandbox(sandbox: _Sandbox) -> Optional[BaseException]:
    if sandbox.cleanup_done:
        return sandbox.cleanup_error
    sandbox.cleanup_done = True
    last_error: Optional[BaseException] = None
    for attempt in range(3):
        try:
            sandbox.cleanup()
            sandbox.cleanup_error = None
            return None
        except (OSError, RuntimeError, TypeError) as exc:
            last_error = exc
            if attempt < 2:
                time.sleep(0.01)
    sandbox.cleanup_error = last_error
    return last_error


def _finish_sandbox_result(result: NativeResult, supplied: Any) -> NativeResult:
    if not isinstance(supplied, _Sandbox):
        return result
    cleanup_error = _cleanup_sandbox(supplied)
    if cleanup_error is None:
        return result
    return NativeResult(
        status="inconclusive",
        reason="sandbox cleanup failed: {}".format(type(cleanup_error).__name__),
        elapsed_seconds=result.elapsed_seconds,
        evidence=result.evidence,
        logs=result.logs,
        proof=result.proof,
        provenance=result.provenance,
    )


def _inside(root: Path, candidate: Path) -> bool:
    try:
        candidate.resolve().relative_to(root.resolve())
        return True
    except (OSError, ValueError):
        return False


def _fixture_sandbox_is_disposable(path: Path) -> bool:
    return _inside(Path(tempfile.gettempdir()), path)


def _declared_roots(recipe: NativeRecipe, sandbox: Path) -> tuple[dict[str, Path], Optional[str]]:
    roots: dict[str, Path] = {
        "sandbox": sandbox,
        "workspace": sandbox / "workspace",
        "home": sandbox / "home",
        "data": sandbox / "data",
        "config": sandbox / "config",
        "cache": sandbox / "cache",
        "tmp": sandbox / "tmp",
    }
    # Only ``roots`` is a path declaration.  The remaining isolation keys are
    # closed verifier metadata such as ``proof_path`` and ``proof_token``.
    declared = recipe.isolation.get("roots", {})
    if not isinstance(declared, Mapping):
        return {}, "recipe isolation roots are not a mapping"
    for name, relative in declared.items():
        if not isinstance(name, str) or not isinstance(relative, str) or not name:
            return {}, "recipe isolation root is malformed"
        candidate = (sandbox / relative).resolve()
        if not _inside(sandbox, candidate):
            return {}, "recipe isolation root escapes sandbox"
        roots[name] = candidate
    for path in roots.values():
        try:
            path.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            return {}, "could not create sandbox root: {}".format(type(exc).__name__)
    return roots, None


def _safe_environment(roots: Mapping[str, Path]) -> dict[str, str]:
    env = {key: value for key, value in os.environ.items() if key in _SAFE_ENV or key.startswith("LC_")}
    aliases = {
        "HOME": "home",
        "USERPROFILE": "home",
        "APPDATA": "config",
        "LOCALAPPDATA": "cache",
        "XDG_DATA_HOME": "data",
        "XDG_CONFIG_HOME": "config",
        "XDG_CACHE_HOME": "cache",
        "TMPDIR": "tmp",
        "TMP": "tmp",
        "TEMP": "tmp",
        "SKILL_HUB_HOME": "skill_hub",
        "CODEX_HOME": "codex_home",
        "SKILL_HUB_CLAUDE_HOME": "claude_home",
        "OPENCODE_CONFIG_DIR": "opencode_config",
    }
    for key, root_name in aliases.items():
        path = roots.get(root_name, roots.get(key.lower(), roots["sandbox"]))
        path.mkdir(parents=True, exist_ok=True)
        env[key] = str(path)
    env["SKILL_HUB_NATIVE_PROOF_PATH"] = str(roots["sandbox"] / "proof")
    env["SKILL_HUB_NATIVE_WORKSPACE"] = str(roots["workspace"])
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"
    return env


def _redact(text: str, sandbox: Path, secrets: Sequence[str]) -> str:
    output = text
    for secret in secrets:
        if secret:
            output = output.replace(secret, "<redacted>")
    output = output.replace(str(sandbox), "<sandbox>").replace(str(Path.home()), "<private-path>")
    output = re.sub(
        r"(?i)(api[_-]?key|token|secret|password|authorization)\s*[=:]\s*[^\s,;]+",
        r"\1=<redacted>",
        output,
    )
    encoded = output.encode("utf-8", errors="replace")
    if len(encoded) > MAX_LOG_BYTES:
        suffix = "\n<output truncated>"
        limit = MAX_LOG_BYTES - len(suffix.encode("utf-8"))
        return encoded[:limit].decode("utf-8", errors="ignore") + suffix
    return output


def _redact_proof(proof: Mapping[str, Any], sandbox: Path, secrets: Sequence[str]) -> Mapping[str, Any]:
    return {
        key: _redact(value, sandbox, secrets) if isinstance(value, str) else value
        for key, value in proof.items()
    }


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while True:
            chunk = stream.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return "sha256:" + digest.hexdigest()


def _identity_value(identity: object, *names: str) -> Optional[str]:
    for name in names:
        value = getattr(identity, name, None)
        if value is not None:
            text = str(value)
            if text:
                return text
    return None


def _canonical_platform(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    normalized = value.casefold()
    return {
        "darwin": "macos",
        "macos": "macos",
        "win32": "windows",
        "windows": "windows",
        "linux": "linux",
    }.get(normalized, normalized)


def _matches(recipe: NativeRecipe, identity: object, executable: Optional[Path] = None) -> Optional[str]:
    binding = recipe.binding
    values = {
        "package": _identity_value(identity, "package_id"),
        "harness": _identity_value(identity, "harness_id"),
        "installation": _identity_value(identity, "installation_id"),
        "runtime_version": _identity_value(identity, "runtime_version", "version"),
        "release_version": _identity_value(identity, "release_version"),
        "release_digest": _identity_value(identity, "release_digest"),
        "variant": _identity_value(identity, "variant_id", "profile"),
        "profile": _identity_value(identity, "profile"),
        "platform": _canonical_platform(_identity_value(identity, "platform", "os_name")),
        "arch": _identity_value(identity, "arch", "architecture"),
        "executable": _identity_value(identity, "executable_path"),
        "executable_sha256": _identity_value(identity, "executable_sha256", "executable_fingerprint"),
    }
    expected = {
        "package": binding.package_id,
        "harness": binding.harness_id,
        "installation": binding.installation_id,
        "runtime_version": binding.runtime_version,
        "release_version": binding.release_version,
        "release_digest": binding.release_digest,
        "variant": binding.variant_id,
        "profile": binding.profile,
        "platform": _canonical_platform(recipe.platform),
        "arch": recipe.arch,
        "executable_sha256": recipe.executable_sha256,
    }
    for key, wanted in expected.items():
        actual = values[key]
        if key in {"release_digest", "executable_sha256"}:
            try:
                actual = _digest(actual) if actual is not None else None
            except ValueError:
                actual = None
        if actual != wanted:
            return "runtime identity {} does not match recipe".format(key)
    executable = executable if executable is not None else Path(values["executable"] or "")
    if not executable.is_absolute():
        return "resolved executable path is not absolute"
    try:
        executable = executable.resolve()
        if not executable.is_file() or _file_sha256(executable) != recipe.executable_sha256:
            return "resolved executable digest is stale"
    except OSError:
        return "resolved executable is unavailable"
    return None


def _argv(recipe: NativeRecipe, roots: Mapping[str, Path], executable: Path) -> tuple[list[str], Optional[str]]:
    values = {name: str(path) for name, path in roots.items()}
    values["executable"] = str(executable)
    result: list[str] = []
    for token in recipe.argv_template:
        placeholders = _PLACEHOLDER.findall(token)
        for name in placeholders:
            if name not in values:
                return [], "argv contains undeclared sandbox placeholder"
        rendered = _PLACEHOLDER.sub(lambda match: values[match.group(1)], token)
        if "{" in rendered or "}" in rendered:
            return [], "argv contains malformed placeholder"
        result.append(rendered)
    if not result:
        return [], "argv must begin with the resolved executable"
    try:
        first = Path(result[0]).resolve()
        executable = executable.resolve()
    except OSError:
        return [], "argv must begin with the resolved executable"
    if first != executable:
        return [], "argv must begin with the resolved executable"
    result[0] = str(executable)
    return result, None


def _bounded_reader(stream: Any, output: bytearray, overflow: list[bool]) -> None:
    try:
        descriptor = stream.fileno()
    except (AttributeError, OSError, ValueError):
        return
    while True:
        try:
            chunk = os.read(descriptor, 4096)
        except (OSError, ValueError):
            return
        if not chunk:
            return
        remaining = MAX_OUTPUT_BYTES - len(output)
        if remaining > 0:
            output.extend(bytes(chunk)[:remaining])
        if len(chunk) > max(remaining, 0):
            overflow[0] = True


def _terminate_tree(process: subprocess.Popen[bytes]) -> bool:
    """Terminate a process group with bounded waits, including after success."""
    clean = True
    if os.name == "nt":
        try:
            taskkill = subprocess.run(
                ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=1,
                check=False,
            )
            if taskkill.returncode != 0:
                clean = False
        except (OSError, subprocess.TimeoutExpired):
            clean = False
        if process.poll() is None:
            try:
                process.kill()
            except OSError:
                clean = False
    else:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except OSError:
            try:
                process.kill()
            except OSError:
                clean = False
        try:
            process.wait(timeout=0.25)
        except subprocess.TimeoutExpired:
            pass
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except OSError:
            if process.poll() is None:
                try:
                    process.kill()
                except OSError:
                    clean = False
    try:
        process.wait(timeout=1)
    except (OSError, subprocess.TimeoutExpired):
        clean = False
    return clean


def _proof_artifact(recipe: NativeRecipe, roots: Mapping[str, Path], stdout: str, stderr: str) -> Mapping[str, Any]:
    raw_path = recipe.isolation.get("proof_path", "proof")
    token = recipe.isolation.get("proof_token")
    if not isinstance(raw_path, str) or (token is not None and not isinstance(token, str)):
        return {"verdict": "fail", "reason": "malformed proof declaration"}
    path = (roots["sandbox"] / raw_path).resolve()
    if not _inside(roots["sandbox"], path) or not path.is_file():
        return {"verdict": "fail", "reason": "expected proof artifact was not created"}
    try:
        with path.open("rb") as stream:
            data = stream.read(MAX_PROOF_BYTES + 1)
    except OSError:
        return {"verdict": "fail", "reason": "proof artifact could not be read"}
    if len(data) > MAX_PROOF_BYTES:
        return {"verdict": "fail", "reason": "proof artifact exceeded bound"}
    fragment = data.decode("utf-8", errors="replace").strip()
    if token is not None and fragment != token:
        return {"verdict": "fail", "reason": "proof artifact token did not match"}
    return {
        "verdict": "pass",
        "evidence_digest": "sha256:" + hashlib.sha256(data).hexdigest(),
        "fragment": fragment[:256],
    }


def _proof_token(recipe: NativeRecipe, roots: Mapping[str, Path], stdout: str, stderr: str) -> Mapping[str, Any]:
    token = recipe.isolation.get("proof_token")
    if not isinstance(token, str) or not _TOKEN.fullmatch(token):
        return {"verdict": "fail", "reason": "malformed proof token declaration"}
    observed = {line.strip() for line in (stdout + "\n" + stderr).splitlines()}
    if token not in observed:
        return {"verdict": "fail", "reason": "expected proof token was not observed"}
    return {
        "verdict": "pass",
        "evidence_digest": "sha256:" + hashlib.sha256(token.encode()).hexdigest(),
        "fragment": token,
    }


PROOF_VERIFIERS: Mapping[
    str, Callable[[NativeRecipe, Mapping[str, Path], str, str], Mapping[str, Any]]
] = MappingProxyType({"artifact": _proof_artifact, "token": _proof_token})


def _result(start: float, status: str, reason: str, *, evidence: Optional[Mapping[str, Any]] = None,
            logs: Optional[Mapping[str, str]] = None, proof: Optional[Mapping[str, Any]] = None,
            provenance: str = "fixture") -> NativeResult:
    return NativeResult(
        status=status,
        reason=reason,
        elapsed_seconds=round(max(0.0, time.monotonic() - start), 3),
        evidence=evidence or {},
        logs=logs or {},
        proof=proof or {},
        provenance=provenance,
    )


def execute_native(
    request: NativeRequest,
    recipes: Mapping[str, NativeRecipe],
    runtime_identity: object,
    sandbox_factory: Optional[Callable[[NativeRecipe], Any]] = None,
    *,
    supervisor: Optional[Callable[..., Any]] = None,
) -> NativeResult:
    """Execute one exact recipe after authorization and isolation preflight."""
    from skill_hub.infrastructure.harnesses import harness_execution_supervisor

    started = time.monotonic()
    provenance = "native" if recipes is NATIVE_RECIPES else "fixture"
    recipe = recipes.get(request.recipe_id)
    if not isinstance(recipe, NativeRecipe):
        return _result(started, "blocked", "unknown native recipe", provenance=provenance)
    if provenance == "native":
        if not isinstance(runtime_identity, NativeRuntimeIdentity) or runtime_identity.evidence != "probe":
            return _result(
                started,
                "blocked",
                "native execution requires a fresh typed probe identity",
                provenance=provenance,
            )
        if supervisor is not None:
            return _result(
                started, "blocked", "production execution requires the system supervisor", provenance=provenance
            )
        if sandbox_factory is not None:
            return _result(
                started,
                "blocked",
                "production execution requires the canonical disposable sandbox",
                provenance=provenance,
            )
    if not (request.authorization is True or (
        isinstance(request.authorization, NativeAuthorization) and request.authorization.approved
    )):
        return _result(started, "blocked", "explicit native authorization is required", provenance=provenance)
    if not recipe.limits.enforceable:
        return _result(started, "blocked", "turn or spend limit is not enforceably observable", provenance=provenance)
    if recipe.credential_requirement is not None and recipe.credential_requirement not in request.credentials:
        return _result(started, "blocked", "required ephemeral credential source is absent", provenance=provenance)
    executable = Path(_identity_value(runtime_identity, "executable_path") or "")
    if not executable.is_absolute():
        return _result(started, "blocked", "resolved executable path is not absolute", provenance=provenance)
    try:
        executable = executable.resolve(strict=True)
    except (OSError, RuntimeError):
        return _result(started, "blocked", "resolved executable is unavailable", provenance=provenance)
    mismatch = _matches(recipe, runtime_identity, executable)
    if mismatch is not None:
        return _result(started, "blocked", mismatch, provenance=provenance)
    if (
        _canonical_platform(recipe.platform) != _canonical_platform(sys.platform)
        or recipe.arch != platform_module.machine()
    ):
        return _result(started, "blocked", "recipe platform or architecture is not this host", provenance=provenance)

    factory = sandbox_factory or _temporary_sandbox
    try:
        sandbox_value = factory(recipe)
        is_manager = (
            not isinstance(sandbox_value, (str, bytes, os.PathLike))
            and hasattr(sandbox_value, "__enter__")
            and hasattr(sandbox_value, "__exit__")
        )
        manager = sandbox_value if is_manager else _path_context(sandbox_value)
        with manager as supplied:
            def finish(result: NativeResult) -> NativeResult:
                return _finish_sandbox_result(result, supplied)

            sandbox = supplied.path if isinstance(supplied, _Sandbox) else Path(supplied)
            if not sandbox.is_absolute():
                return finish(_result(started, "blocked", "sandbox path must be absolute", provenance=provenance))
            if provenance == "fixture" and not _fixture_sandbox_is_disposable(sandbox):
                return finish(_result(
                    started,
                    "blocked",
                    "fixture sandbox must be inside the temporary directory",
                    provenance=provenance,
                ))
            roots, root_error = _declared_roots(recipe, sandbox)
            if root_error is not None:
                return finish(_result(started, "blocked", root_error, provenance=provenance))
            argv, argv_error = _argv(recipe, roots, executable)
            if argv_error is not None:
                return finish(_result(started, "blocked", argv_error, provenance=provenance))
            env = _safe_environment(roots)
            secrets: list[str] = []
            if recipe.credential_requirement is not None:
                secret = request.credentials[recipe.credential_requirement]
                secrets.append(secret)
                env["SKILL_HUB_NATIVE_CREDENTIAL"] = secret
                credential_name = re.sub(r"[^A-Za-z0-9_]", "_", recipe.credential_requirement).upper()
                env["SKILL_HUB_NATIVE_CREDENTIAL_" + credential_name] = secret
            process: Optional[subprocess.Popen[bytes]] = None
            stdout = bytearray()
            stderr = bytearray()
            overflow = [False]
            cleaned = False
            supervised: Any = None
            job_close_ok = True
            out_thread: Optional[threading.Thread] = None
            err_thread: Optional[threading.Thread] = None
            try:
                supervised = (supervisor or harness_execution_supervisor.launch)(
                    argv, cwd=str(roots["workspace"]), env=env,
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                    memory_bytes=recipe.limits.memory_bytes,
                )
                process = supervised.process
                out_thread = threading.Thread(
                    target=_bounded_reader, args=(process.stdout, stdout, overflow), daemon=True
                )
                err_thread = threading.Thread(
                    target=_bounded_reader, args=(process.stderr, stderr, overflow), daemon=True
                )
                out_thread.start()
                err_thread.start()
                timed_out = False
                overflowed = False
                deadline = time.monotonic() + recipe.limits.wall_seconds
                while process.poll() is None:
                    if overflow[0]:
                        overflowed = True
                        break
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        timed_out = True
                        break
                    try:
                        process.wait(timeout=min(0.05, remaining))
                    except subprocess.TimeoutExpired:
                        continue
                cleanup_ok = supervised.close()
                cleaned = True
                out_thread.join(timeout=1)
                err_thread.join(timeout=1)
                readers_done = not out_thread.is_alive() and not err_thread.is_alive()
                if process.stdout is not None:
                    process.stdout.close()
                if process.stderr is not None:
                    process.stderr.close()
                stdout_text = _redact(stdout.decode("utf-8", errors="replace"), sandbox, secrets)
                stderr_text = _redact(stderr.decode("utf-8", errors="replace"), sandbox, secrets)
                logs = {"stdout": stdout_text, "stderr": stderr_text}
                evidence = {"provenance": provenance, "supervision": {
                    "max_parallel": 1, "memory_bytes": recipe.limits.memory_bytes,
                    "memory_mode": supervised.memory_mode, "memory_scope": "per_process",
                }}
                if timed_out:
                    return finish(_result(
                        started,
                        "inconclusive",
                        "native process timed out",
                        evidence=evidence,
                        logs=logs,
                        provenance=provenance,
                    ))
                if overflowed or overflow[0]:
                    return finish(_result(
                        started,
                        "fail",
                        "native output exceeded bound",
                        evidence=evidence,
                        logs=logs,
                        provenance=provenance,
                    ))
                if not cleanup_ok or not job_close_ok or not readers_done:
                    return finish(_result(
                        started,
                        "inconclusive",
                        "native process cleanup was incomplete",
                        evidence=evidence,
                        logs=logs,
                        provenance=provenance,
                    ))
                if process.returncode != 0:
                    return finish(_result(
                        started,
                        "fail",
                        "native process returned nonzero",
                        evidence=evidence,
                        logs=logs,
                        provenance=provenance,
                    ))
                proof = _redact_proof(
                    PROOF_VERIFIERS[recipe.proof_id](recipe, roots, stdout_text, stderr_text),
                    sandbox,
                    secrets,
                )
                evidence = dict(evidence)
                if proof.get("verdict") == "pass":
                    evidence.update({key: value for key, value in proof.items() if key != "fragment"})
                    return finish(_result(
                        started,
                        "pass",
                        "native proof verified",
                        evidence=evidence,
                        logs=logs,
                        proof=proof,
                        provenance=provenance,
                    ))
                return finish(_result(
                    started,
                    "fail",
                    str(proof.get("reason", "native proof failed")),
                    evidence=evidence,
                    logs=logs,
                    proof=proof,
                    provenance=provenance,
                ))
            except (KeyboardInterrupt, OSError, ValueError) as exc:
                if supervised is not None:
                    cleaned = supervised.close()
                for reader in (out_thread, err_thread):
                    if reader is not None:
                        reader.join(timeout=1)
                logs = {
                    "stdout": _redact(stdout.decode("utf-8", errors="replace"), sandbox, secrets),
                    "stderr": _redact(stderr.decode("utf-8", errors="replace"), sandbox, secrets),
                }
                if isinstance(exc, harness_execution_supervisor.SupervisionError):
                    status, reason = "blocked", str(exc)
                elif isinstance(exc, KeyboardInterrupt):
                    status, reason = "inconclusive", "native execution interrupted"
                else:
                    status, reason = "fail", "native process failed: {}".format(type(exc).__name__)
                if supervised is not None and not cleaned:
                    status, reason = "inconclusive", "native process cleanup was incomplete"
                return finish(_result(started, status, reason, logs=logs,
                                      evidence={"provenance": provenance}, provenance=provenance))
            finally:
                if supervised is not None and not cleaned:
                    supervised.close()
    except (OSError, TypeError, ValueError) as exc:
        return _result(started, "blocked", "sandbox setup failed: {}".format(type(exc).__name__), provenance=provenance)


__all__ = [
    "NATIVE_RECIPES",
    "NativeAuthorization",
    "NativeBinding",
    "NativeExecutionRequest",
    "NativeLimits",
    "NativeRecipe",
    "NativeRequest",
    "NativeResult",
    "NativeRuntimeIdentity",
    "execute_native",
]
