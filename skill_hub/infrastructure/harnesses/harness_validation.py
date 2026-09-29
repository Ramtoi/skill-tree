#!/usr/bin/env python3
"""Offline integration contract runner.

The catalog is deliberately data driven, while execution remains a small
stdlib wrapper around pytest.  The runner is a development tool: isolation
protects the developer's home and credentials, but is not a security sandbox
for arbitrary tests.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import hashlib
import json
import math
import os
import platform
import re
import site
import subprocess
import sys
import tempfile
import threading
import time
import uuid
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

# Direct subprocess execution must also locate the package root.
sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from skill_hub.infrastructure.harnesses.harness_execution_supervisor import DEFAULT_MEMORY_BYTES, MAX_MEMORY_BYTES
from skill_hub.infrastructure.harnesses.harness_execution_supervisor import launch as _launch

REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_CATALOG = REPO_ROOT / "tests" / "integration_contracts" / "catalog.json"
SCHEMA_VERSION = 1
HARNESS_IDS = frozenset(("claude-code", "codex", "pi", "opencode"))
LAYERS = frozenset(("offline", "native", "runtime", "packaged"))
PROFILES = frozenset(("quick", "offline"))
REPORT_PROFILES = frozenset((*PROFILES, "native"))
PLATFORMS = frozenset(("macos", "linux", "windows"))
STATUSES = ("pass", "fail", "blocked", "unsupported", "inconclusive", "skipped")
FAILURE_CLASSES = frozenset(
    ("pass", "assertion", "error", "failure", "blocked", "skipped", "unsupported", "inconclusive")
)
MAX_LOG_BYTES = 16_384
MAX_JUNIT_BYTES = 65_536
JUNIT_ELEMENTS = frozenset((
    "testsuites", "testsuite", "testcase", "properties", "property",
    "failure", "error", "skipped", "system-out", "system-err",
))
JUNIT_ATTRIBUTES = frozenset((
    "name", "tests", "errors", "failures", "skipped", "disabled", "time",
    "timestamp", "hostname", "package", "id", "classname", "file", "line",
    "url", "type", "message", "value", "assertions", "status",
))
MAX_TIMEOUT_SECONDS = 3_600.0
MAX_RECIPE_TEXT = 240
MAX_RECIPE_BUDGET = 3_600.0
KNOWN_EVIDENCE = frozenset(
    ("legacy_offline", "offline_pytest", "offline_contract", "native", "native_runtime", "runtime", "packaged")
)
OFFLINE_EVIDENCE = frozenset(("legacy_offline", "offline_pytest", "offline_contract"))


_PROCESS_GUARD = r'''"""Offline integration process boundary (generated per case)."""
import os as _os
import pathlib as _pathlib
import re as _re
import shutil as _shutil
import subprocess as _subprocess

_HARNESS_NAMES = {"claude", "codex", "pi", "opencode"}
_ALLOWED = tuple(
    _pathlib.Path(p).resolve()
    for p in _os.environ.get("INTEGRATION_VALIDATION_ALLOWED_EXEC_ROOTS", "").split(_os.pathsep)
    if p
)

def _under(path):
    try:
        candidate = _pathlib.Path(path).resolve()
        return any(candidate == root or root in candidate.parents for root in _ALLOWED)
    except (OSError, ValueError):
        return False

def _check(command, shell=False):
    text = command if isinstance(command, str) else " ".join(str(x) for x in command)
    names = {part.lower() for part in _re.findall(r"[A-Za-z0-9_.-]+", text)}
    base_names = {name.rsplit(".", 1)[0] if name.endswith((".exe", ".cmd", ".bat")) else name for name in names}
    if not (base_names & _HARNESS_NAMES):
        return
    if shell:
        raise RuntimeError("offline runner blocked a shell command containing a real harness")
    first = command[0] if not isinstance(command, str) and command else command
    name = _pathlib.Path(str(first)).name.lower()
    if name.endswith((".exe", ".cmd", ".bat")):
        name = name.rsplit(".", 1)[0]
    if name not in _HARNESS_NAMES and any(part in {"bash", "sh", "zsh", "cmd", "powershell"} for part in base_names):
        raise RuntimeError("offline runner blocked a shell command containing a real harness")
    if name not in _HARNESS_NAMES:
        return
    resolved = str(first) if _pathlib.Path(str(first)).is_absolute() else (_shutil.which(str(first)) or "")
    if not resolved or not _under(resolved):
        raise RuntimeError("offline runner blocked harness executable: " + str(first))

_Popen = _subprocess.Popen
class _GuardedPopen(_Popen):
    def __init__(self, args, *a, **kw):
        _check(args, bool(kw.get("shell", False)))
        if kw.get("executable"):
            _check([kw["executable"]], False)
        super().__init__(args, *a, **kw)
_subprocess.Popen = _GuardedPopen
_os_system = _os.system
def _guarded_system(command):
    _check(command, True)
    return _os_system(command)
_os.system = _guarded_system
_os_popen = _os.popen
def _guarded_popen(command, *args, **kwargs):
    _check(command, True)
    return _os_popen(command, *args, **kwargs)
_os.popen = _guarded_popen
'''


class CatalogError(ValueError):
    """The catalog is malformed or contains an unsafe selector."""


def _as_path(value: Any, field: str) -> Path:
    if not isinstance(value, (str, os.PathLike)) or not str(value).strip():
        raise CatalogError("{} must be a non-empty path".format(field))
    return Path(value)


def _selector_path(selector: str) -> str:
    # A pytest node is a relative path followed by zero or more ``::`` parts.
    return selector.split("::", 1)[0]


def _validate_selector(selector: Any, repo_root: Path, *, case_id: str) -> str:
    if not isinstance(selector, str) or not selector.strip():
        raise CatalogError("case {} has an invalid selector".format(case_id))
    selector_parts = selector.split("::")
    if any(not part for part in selector_parts[1:]):
        raise CatalogError("case {} has an invalid selector {!r}".format(case_id, selector))
    path_text = _selector_path(selector)
    path = Path(path_text)
    if path.is_absolute() or ".." in path.parts or not path_text.endswith(".py"):
        raise CatalogError("case {} has an unsafe selector {!r}".format(case_id, selector))
    root = repo_root.resolve()
    candidate = (root / path).resolve()
    try:
        candidate.relative_to(root)
    except ValueError as exc:
        raise CatalogError("case {} selector escapes repo root".format(case_id)) from exc
    if not candidate.is_file():
        raise CatalogError("case {} selector file does not exist: {}".format(case_id, selector))
    return selector


def _bounded_text(value: Any, field: str, *, limit: int = MAX_RECIPE_TEXT) -> str:
    if not isinstance(value, str) or not value.strip():
        raise CatalogError("{} must be a non-empty string".format(field))
    value = value.strip()
    if len(value) > limit:
        raise CatalogError("{} is too long".format(field))
    return value


def _validate_recipe(value: Any, *, case_id: str) -> Optional[Dict[str, Any]]:
    if value is None:
        return None
    if not isinstance(value, dict):
        raise CatalogError("case {} recipe must be an object".format(case_id))
    required = ("executor", "disposable_home", "workspace", "expected_positive_proof", "retention_redaction")
    for key in required:
        if key not in value:
            raise CatalogError("case {} recipe missing {}".format(case_id, key))
    result: Dict[str, Any] = {
        "executor": _bounded_text(value["executor"], "case {} recipe.executor".format(case_id)),
        "disposable_home": _bounded_text(
            value["disposable_home"], "case {} recipe.disposable_home".format(case_id)
        ),
        "workspace": _bounded_text(value["workspace"], "case {} recipe.workspace".format(case_id)),
        "expected_positive_proof": _bounded_text(
            value["expected_positive_proof"], "case {} recipe.expected_positive_proof".format(case_id)
        ),
        "retention_redaction": _bounded_text(
            value["retention_redaction"], "case {} recipe.retention_redaction".format(case_id)
        ),
    }
    credential = value.get("credential_source")
    if credential is not None:
        result["credential_source"] = _bounded_text(
            credential, "case {} recipe.credential_source".format(case_id)
        )
    authorization = value.get("authorization")
    if not isinstance(authorization, dict):
        raise CatalogError("case {} recipe.authorization must be an object".format(case_id))
    bounded: Dict[str, Any] = {}
    for key in ("wall_time_seconds", "turns", "spend"):
        raw = authorization.get(key)
        if isinstance(raw, bool) or not isinstance(raw, (int, float)):
            raise CatalogError("case {} recipe.authorization.{} is invalid".format(case_id, key))
        if not math.isfinite(float(raw)) or raw <= 0 or raw > MAX_RECIPE_BUDGET:
            raise CatalogError("case {} recipe.authorization.{} is out of range".format(case_id, key))
        bounded[key] = raw
    result["authorization"] = bounded
    unknown = set(value) - set(result)
    if unknown:
        raise CatalogError("case {} recipe has unknown fields: {}".format(case_id, ", ".join(sorted(unknown))))
    return result


def load_catalog(path: Optional[Path] = None, repo_root: Optional[Path] = None) -> Dict[str, Any]:
    """Read and validate schema 1 catalog data.

    ``repo_root`` is explicit so tests can validate selectors in a disposable
    checkout.  The catalog path itself may be outside that checkout when a
    caller deliberately supplies a fixture catalog.
    """

    root = Path(repo_root or REPO_ROOT).resolve()
    catalog_path = Path(path) if path is not None else root / "tests" / "integration_contracts" / "catalog.json"
    try:
        raw = json.loads(catalog_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise CatalogError("cannot read catalog {}: {}".format(catalog_path, exc)) from exc
    if (
        not isinstance(raw, dict)
        or isinstance(raw.get("schema_version"), bool)
        or raw.get("schema_version") != SCHEMA_VERSION
    ):
        raise CatalogError("catalog schema_version must be {}".format(SCHEMA_VERSION))
    cases = raw.get("cases")
    if not isinstance(cases, list):
        raise CatalogError("catalog cases must be a list")

    seen: set[str] = set()
    validated: List[Dict[str, Any]] = []
    for index, item in enumerate(cases):
        if not isinstance(item, dict):
            raise CatalogError("case {} must be an object".format(index))
        case_id = item.get("id")
        if not isinstance(case_id, str) or not re.fullmatch(r"[a-z0-9][a-z0-9._-]*", case_id):
            raise CatalogError("case {} has an invalid id".format(index))
        if case_id in seen:
            raise CatalogError("duplicate case id {}".format(case_id))
        seen.add(case_id)
        description = item.get("description")
        if not isinstance(description, str) or not description.strip():
            raise CatalogError("case {} description must be non-empty".format(case_id))
        harnesses = item.get("harnesses")
        if (
            not isinstance(harnesses, list)
            or not harnesses
            or any(not isinstance(x, str) or x not in HARNESS_IDS for x in harnesses)
            or len(set(harnesses)) != len(harnesses)
        ):
            raise CatalogError("case {} has invalid harnesses".format(case_id))
        feature = item.get("feature")
        if not isinstance(feature, str) or not feature.strip():
            raise CatalogError("case {} feature must be non-empty".format(case_id))
        layer = item.get("layer")
        if layer not in LAYERS:
            raise CatalogError("case {} has invalid layer".format(case_id))
        profiles = item.get("profiles")
        if (
            not isinstance(profiles, list)
            or not profiles
            or any(not isinstance(x, str) or x not in PROFILES for x in profiles)
            or len(set(profiles)) != len(profiles)
        ):
            raise CatalogError("case {} has invalid profiles".format(case_id))
        platforms = item.get("platforms")
        if (
            not isinstance(platforms, list)
            or not platforms
            or any(not isinstance(x, str) or x not in PLATFORMS for x in platforms)
            or len(set(platforms)) != len(platforms)
        ):
            raise CatalogError("case {} has invalid platforms".format(case_id))
        selectors = item.get("selectors")
        if not isinstance(selectors, list):
            raise CatalogError("case {} has invalid selectors".format(case_id))
        for selector in selectors:
            _validate_selector(selector, root, case_id=case_id)
        if layer == "offline" and item.get("gap") is None and not selectors:
            raise CatalogError("offline case {} needs selectors".format(case_id))
        memory = item.get("memory_bytes", DEFAULT_MEMORY_BYTES)
        if isinstance(memory, bool) or not isinstance(memory, int) or not 0 < memory <= MAX_MEMORY_BYTES:
            raise CatalogError("case {} memory_bytes is out of range".format(case_id))
        item["memory_bytes"] = memory
        timeout = item.get("timeout_seconds")
        if isinstance(timeout, bool) or not isinstance(timeout, (int, float)):
            raise CatalogError("case {} timeout_seconds must be a number".format(case_id))
        if not math.isfinite(float(timeout)) or timeout <= 0 or timeout > MAX_TIMEOUT_SECONDS:
            raise CatalogError("case {} timeout_seconds is out of range".format(case_id))
        gap = item.get("gap")
        if gap is not None and (not isinstance(gap, str) or not gap.strip()):
            raise CatalogError("case {} gap must be null or a reason".format(case_id))
        revision = item.get("revision", "legacy")
        if not isinstance(revision, str) or not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", revision):
            raise CatalogError("case {} revision is invalid".format(case_id))
        required_evidence = item.get("required_evidence", ["legacy_offline"])
        if (
            not isinstance(required_evidence, list)
            or any(not isinstance(x, str) or not x.strip() or len(x) > 80 for x in required_evidence)
            or len(set(required_evidence)) != len(required_evidence)
        ):
            raise CatalogError("case {} required_evidence is invalid".format(case_id))
        recipe = _validate_recipe(item.get("recipe"), case_id=case_id)
        if "on_demand_recipe" in item:
            if recipe is not None:
                raise CatalogError("case {} has both recipe and on_demand_recipe".format(case_id))
            recipe = _validate_recipe(item["on_demand_recipe"], case_id=case_id)
        validated_case = dict(item)
        validated_case.update(
            {"revision": revision, "required_evidence": list(required_evidence), "recipe": recipe}
        )
        validated.append(validated_case)
    return {"schema_version": SCHEMA_VERSION, "cases": validated}


def _platform_id() -> str:
    if sys.platform == "darwin":
        return "macos"
    if os.name == "nt":
        return "windows"
    if sys.platform.startswith("linux"):
        return "linux"
    return sys.platform


def _select_cases(
    catalog: Mapping[str, Any],
    profile: Optional[str],
    harnesses: Sequence[str],
    features: Sequence[str],
    case_ids: Sequence[str],
) -> List[Dict[str, Any]]:
    if profile is not None and profile not in PROFILES:
        raise CatalogError("unknown profile {!r}".format(profile))
    unknown_harnesses = set(harnesses) - set(HARNESS_IDS)
    if unknown_harnesses:
        raise CatalogError("unknown harness selector(s): {}".format(", ".join(sorted(unknown_harnesses))))
    known = {str(c["id"]) for c in catalog["cases"]}
    unknown = set(case_ids) - known
    if unknown:
        raise CatalogError("unknown case id(s): {}".format(", ".join(sorted(unknown))))
    selected = []
    for case in catalog["cases"]:
        if profile is not None and profile not in case["profiles"]:
            continue
        if harnesses and not set(harnesses).intersection(case["harnesses"]):
            continue
        if features and case["feature"] not in features:
            continue
        if case_ids and case["id"] not in case_ids:
            continue
        selected.append(case)
    if not selected:
        raise CatalogError("no catalog cases match the selection")
    return selected


def _safe_name(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", value)[:100] or "case"


def _atomic_write(path: Path, contents: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".tmp-", dir=str(path.parent), text=True)
    try:
        if hasattr(os, "fchmod"):
            os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(contents)
        os.replace(temporary, path)
        os.chmod(path, 0o600)
    except BaseException:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise


def _git_metadata(root: Path) -> Tuple[Optional[str], Optional[bool]]:
    try:
        revision = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=str(root), capture_output=True, text=True, timeout=5, check=True
        ).stdout.strip()
        dirty = bool(
            subprocess.run(
                ["git", "status", "--porcelain"],
                cwd=str(root),
                capture_output=True,
                text=True,
                timeout=5,
                check=True,
            ).stdout.strip()
        )
        return revision, dirty
    except (OSError, subprocess.SubprocessError):
        return None, None


def _source_digest(root: Path) -> Optional[str]:
    """Hash bounded shipped Python inputs when a packaged tree has no Git metadata."""
    digest = hashlib.sha256()
    source_patterns = ("*.py", "skill_hub/**/*.py", "connectors/**/*.py")
    paths = sorted(
        {path for pattern in source_patterns for path in root.glob(pattern) if path.is_file()}
    )
    version = root / "VERSION"
    if version.is_file():
        paths.append(version)
    if not paths:
        return None
    try:
        for path in paths:
            relative = path.relative_to(root).as_posix().encode("utf-8")
            digest.update(len(relative).to_bytes(4, "big"))
            digest.update(relative)
            with path.open("rb") as stream:
                while chunk := stream.read(1024 * 1024):
                    digest.update(chunk)
        return "sha256:" + digest.hexdigest()
    except OSError:
        return None


def _native_host_metadata() -> Dict[str, Any]:
    """Capture host identity from the shipped code root, never caller repo input."""
    code_root = Path(__file__).resolve().parents[3]
    revision, dirty = _git_metadata(code_root)
    return {
        "git_revision": revision,
        "git_dirty": dirty,
        "source_digest": _source_digest(code_root),
    }


def _redact(text: str, root: Path, sandbox: Path, secret_values: Iterable[str]) -> str:
    output = text
    for value in secret_values:
        if value:
            output = output.replace(value, "<redacted>")
    for value in (str(root), str(sandbox), str(Path.home())):
        if value:
            output = output.replace(value, "<private-path>")
    output = re.sub(
        r"(?i)(api[_-]?key|token|secret|password|passwd|authorization)\s*[=:]\s*[^\s,;]+",
        r"\1=<redacted>",
        output,
    )
    return output


def _sanitized_env(sandbox: Path, root: Path) -> Tuple[Dict[str, str], List[str]]:
    deny_name = re.compile(
        r"(?i)(?:token|secret|password|passwd|credential|api[_-]?key|private[_-]?key|"
        r"access[_-]?key|authorization|^aws_)"
    )
    env: Dict[str, str] = {}
    secrets: List[str] = []
    safe_exact = {
        "PATH",
        "LANG",
        "LANGUAGE",
        "TERM",
        "TZ",
        "CI",
        "GITHUB_ACTIONS",
        "GITHUB_RUN_ID",
        "GITHUB_WORKFLOW",
        "NO_COLOR",
        "SYSTEMROOT",
        "COMSPEC",
        "PATHEXT",
        "PROCESSOR_ARCHITECTURE",
        "PROCESSOR_ARCHITEW6432",
        "VIRTUAL_ENV",
    }
    for key, value in os.environ.items():
        if deny_name.search(key):
            secrets.append(value)
        if key in safe_exact or key.startswith("LC_"):
            env[key] = value
    home = sandbox / "home"
    data = sandbox / "data"
    config = sandbox / "config"
    cache = sandbox / "cache"
    temporary = sandbox / "tmp"
    for directory in (home, data, config, cache, temporary):
        directory.mkdir(parents=True, exist_ok=True)
    # A disposable HOME disables Python's user-site discovery. Keep the
    # already selected interpreter's installed test tools available by adding
    # its site directory explicitly; do not inherit arbitrary PYTHONPATH.
    pythonpath = [str(root)]
    guard = sandbox / "sitecustomize.py"
    guard.write_text(_PROCESS_GUARD, encoding="utf-8")
    os.chmod(guard, 0o600)
    allowed_exec_roots = [sandbox]
    try:
        user_site = site.getusersitepackages()
    except (AttributeError, KeyError):
        user_site = ""
    if user_site:
        pythonpath.append(user_site)
    env.update(
        {
            "HOME": str(home),
            "USERPROFILE": str(home),
            "APPDATA": str(config),
            "LOCALAPPDATA": str(cache),
            "XDG_DATA_HOME": str(data),
            "XDG_CONFIG_HOME": str(config),
            "XDG_CACHE_HOME": str(cache),
            "TMPDIR": str(temporary),
            "TMP": str(temporary),
            "TEMP": str(temporary),
            "SKILL_HUB_HOME": str(data / "skill-hub"),
            "SKILL_HUB_CLAUDE_HOME": str(home / ".claude"),
            "CODEX_HOME": str(home / ".codex"),
            "PYTEST_DISABLE_PLUGIN_AUTOLOAD": "1",
            "PYTHONIOENCODING": "utf-8",
            "PYTHONUTF8": "1",
            "PYTHONPATH": os.pathsep.join([str(sandbox)] + pythonpath),
            "INTEGRATION_VALIDATION_ALLOWED_EXEC_ROOTS": os.pathsep.join(str(p) for p in allowed_exec_roots),
        }
    )
    return env, secrets


def _read_bounded(path: Path, root: Path, sandbox: Path, secrets: Sequence[str]) -> str:
    try:
        with path.open("rb") as handle:
            data = handle.read(MAX_LOG_BYTES + 1)
    except OSError as exc:
        return "<unable to read output: {}>".format(exc)
    suffix = "\n<output truncated>" if len(data) > MAX_LOG_BYTES else ""
    return _redact(data[:MAX_LOG_BYTES].decode("utf-8", "replace"), root, sandbox, secrets) + suffix


def _unavailable_junit_xml(reason: str) -> str:
    root = ET.Element("testsuite", {"name": "unavailable-evidence", "tests": "0"})
    ET.SubElement(root, "system-out").text = "unavailable-evidence:" + reason
    return ET.tostring(root, encoding="unicode") + "\n"


def _safe_junit_identifiers(parsed: ET.Element, root: Path, sandbox: Path, secrets: Sequence[str]) -> bool:
    for element in parsed.iter():
        if element.tag not in JUNIT_ELEMENTS or _redact(element.tag, root, sandbox, secrets) != element.tag:
            return False
        for name in element.attrib:
            if name not in JUNIT_ATTRIBUTES or _redact(name, root, sandbox, secrets) != name:
                return False
    return True


def _retained_junit_xml(junit: Path, root: Path, sandbox: Path, secrets: Sequence[str]) -> str:
    """Redact bounded JUnit fields and retain valid XML, never raw input."""
    try:
        with junit.open("rb") as handle:
            raw = handle.read(MAX_JUNIT_BYTES + 1)
    except OSError:
        return _unavailable_junit_xml("unreadable")
    if len(raw) > MAX_JUNIT_BYTES:
        return _unavailable_junit_xml("too-large")
    try:
        source = raw.decode("utf-8", "strict")
    except UnicodeDecodeError:
        return _unavailable_junit_xml("unsafe-encoding")
    if "\x00" in source:
        return _unavailable_junit_xml("unsafe-encoding")
    declaration = re.match(r"\s*<\?xml\s+([^?]*)\?>", source)
    if declaration:
        encoding = re.search(r"\bencoding\s*=\s*['\"]([^'\"]+)['\"]", declaration.group(1), re.I)
        if encoding and encoding.group(1).lower() not in {"utf-8", "utf8"}:
            return _unavailable_junit_xml("unsafe-encoding")
    if "<!" in source:
        return _unavailable_junit_xml("unsafe-xml")
    try:
        parsed = ET.fromstring(source)
    except ET.ParseError:
        return _unavailable_junit_xml("malformed")
    if not _safe_junit_identifiers(parsed, root, sandbox, secrets):
        return _unavailable_junit_xml("unsafe-identifiers")
    for element in parsed.iter():
        element.attrib = {key: _redact(value, root, sandbox, secrets) for key, value in element.attrib.items()}
        if element.text:
            element.text = _redact(element.text, root, sandbox, secrets)
        if element.tail:
            element.tail = _redact(element.tail, root, sandbox, secrets)
    try:
        retained = ET.tostring(parsed, encoding="unicode") + "\n"
    except (TypeError, ValueError):
        return _unavailable_junit_xml("serialization-failed")
    if len(retained.encode("utf-8")) > MAX_JUNIT_BYTES:
        return _unavailable_junit_xml("serialized-too-large")
    return retained


def _contains_marker(path: Path, marker: bytes) -> bool:
    """Find a marker without loading an unbounded child log into memory."""
    try:
        with path.open("rb") as handle:
            overlap = b""
            while True:
                chunk = handle.read(8192)
                if not chunk:
                    return marker in overlap
                window = overlap + chunk
                if marker in window:
                    return True
                overlap = window[-(len(marker) - 1) :]
    except OSError:
        return False


def _unlink_bounded(path: Path, *, timeout: float = 2.0) -> bool:
    """Remove a temporary evidence file after descendants release handles."""
    deadline = time.monotonic() + timeout
    while path.exists():
        try:
            path.unlink()
            return True
        except FileNotFoundError:
            return True
        except PermissionError:
            if time.monotonic() >= deadline:
                return False
            time.sleep(0.05)
        except OSError:
            return False
    return True


def _pytest_counts(junit: Path) -> Dict[str, int]:
    counts = {"collected": 0, "passed": 0, "failed": 0, "errors": 0, "skipped": 0, "xfailed": 0}
    root = _safe_junit_root(junit)
    if root is None:
        return counts
    for testcase in root.iter("testcase"):
        counts["collected"] += 1
        if testcase.find("failure") is not None:
            counts["failed"] += 1
        elif testcase.find("error") is not None:
            counts["errors"] += 1
        elif (skipped := testcase.find("skipped")) is not None:
            counts["skipped"] += 1
            if "xfail" in (skipped.attrib.get("type", "") + skipped.attrib.get("message", "")).lower():
                counts["xfailed"] += 1
        else:
            counts["passed"] += 1
    return counts


def _safe_junit_root(junit: Path) -> Optional[ET.Element]:
    """Parse bounded UTF-8 JUnit only after rejecting unsafe XML constructs."""
    try:
        with junit.open("rb") as handle:
            raw = handle.read(MAX_JUNIT_BYTES + 1)
        if len(raw) > MAX_JUNIT_BYTES:
            return None
        source = raw.decode("utf-8", "strict")
    except (OSError, UnicodeDecodeError):
        return None
    if "\x00" in source:
        return None
    declaration = re.match(r"\s*<\?xml\s+([^?]*)\?>", source)
    if declaration:
        encoding = re.search(r"\bencoding\s*=\s*['\"]([^'\"]+)['\"]", declaration.group(1), re.I)
        if encoding and encoding.group(1).lower() not in {"utf-8", "utf8"}:
            return None
    if "<!" in source:
        return None
    try:
        return ET.fromstring(source)
    except (ET.ParseError, ValueError):
        return None


def _pytest_failure_tests(junit: Path) -> List[str]:
    """Return bounded JUnit failure identities without messages or values."""
    root = _safe_junit_root(junit)
    if root is None:
        return []
    identities: List[str] = []
    for testcase in root.iter("testcase"):
        failure = testcase.find("failure")
        error = testcase.find("error")
        if failure is None and error is None:
            continue
        parts: List[str] = []
        for key in ("classname", "name"):
            value = testcase.attrib.get(key, "").strip()
            # Pytest parameter IDs may contain credentials or local paths.
            if key == "name":
                value = value.split("[", 1)[0]
            if not value:
                value = "unknown"
            elif "/" in value or "\\" in value:
                value = "<path>"
            else:
                value = re.sub(r"[^A-Za-z0-9_.:-]+", "_", value)[:80] or "unknown"
            parts.append(value)
        detail = failure if failure is not None else error
        if detail is None:
            continue
        failure_type = detail.attrib.get("type", "unknown").strip()
        if "/" in failure_type or "\\" in failure_type:
            failure_type = "<path>"
        failure_type = re.sub(r"[^A-Za-z0-9_.:-]+", "_", failure_type)[:80] or "unknown"
        parts.append(failure_type)
        identities.append(":".join(parts))
        if len(identities) == 16:
            break
    return identities


def _environment_family() -> str:
    """Stable comparison identity without a home path or volatile detail."""
    return "{}:{}:python{}".format(_platform_id(), platform.machine() or "unknown", sys.version_info[:2])


def _failure_identity(case: Mapping[str, Any], outcome: Mapping[str, Any]) -> Dict[str, str]:
    status = str(outcome.get("status", "inconclusive"))
    if status == "pass":
        failure_class, signature, signature_strength = "pass", "pass", "strong"
    elif status == "fail":
        counts = outcome.get("pytest")
        if isinstance(counts, dict) and counts.get("failed", 0):
            failure_class = "assertion"
        elif isinstance(counts, dict) and counts.get("errors", 0):
            failure_class = "error"
        else:
            failure_class = "failure"
        signature = str(outcome.get("reason", "unknown failure"))
        failure_tests = outcome.get("failure_tests")
        if isinstance(failure_tests, list) and all(isinstance(item, str) for item in failure_tests) and failure_tests:
            signature_strength = "strong"
            signature = "{}|tests:{}".format(signature, ";".join(failure_tests))
        else:
            signature_strength = "weak"
    elif status == "blocked":
        failure_class, signature, signature_strength = "blocked", str(outcome.get("reason", "blocked")), "strong"
    elif status == "skipped":
        failure_class, signature, signature_strength = "skipped", str(outcome.get("reason", "skipped")), "strong"
    elif status == "unsupported":
        failure_class, signature, signature_strength = (
            "unsupported", str(outcome.get("reason", "unsupported")), "strong"
        )
    else:
        failure_class, signature, signature_strength = (
            "inconclusive", str(outcome.get("reason", "inconclusive")), "strong"
        )
    # Reasons are intentionally reduced to bounded, non-local identity data.
    signature = re.sub(r"(?:[A-Za-z]:)?[/\\][^ ]+", "<path>", signature)
    signature = re.sub(r"\b20\d{2}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)?\b", "<time>", signature)
    signature = re.sub(r"\bexit\s+\d+\b", "exit <code>", signature, flags=re.IGNORECASE)
    signature = " ".join(signature.split())[:240] or "unknown"
    selectors = case.get("selectors")
    if (
        signature_strength == "weak"
        and isinstance(selectors, list)
        and all(isinstance(item, str) for item in selectors)
    ):
        signature = "{}|selectors:{}".format(signature, ",".join(selectors))[:240]
    revision = str(case.get("revision", "legacy"))
    layer = str(case.get("layer", "unknown"))
    environment = str(outcome.get("environment_family", "unknown"))
    identity = {
        "failure_class": failure_class,
        "failure_signature": signature,
        "failure_signature_strength": signature_strength,
        "revision": revision,
        "layer": layer,
        "environment_family": environment,
    }
    digest_input = "\x1f".join(
        (str(case.get("id", "")), revision, layer, environment, failure_class, signature)
    ).encode("utf-8")
    identity["failure_fingerprint"] = hashlib.sha256(digest_input).hexdigest()
    return identity


def _annotate_case(case: Mapping[str, Any], outcome: Dict[str, Any]) -> Dict[str, Any]:
    outcome.setdefault("revision", str(case.get("revision", "legacy")))
    outcome.setdefault("layer", str(case.get("layer", "unknown")))
    outcome.setdefault("environment_family", _environment_family())
    outcome.setdefault("required_evidence", list(case.get("required_evidence", ["legacy_offline"])))
    outcome.setdefault("recipe", case.get("recipe"))
    outcome.update(_failure_identity(case, outcome))
    return outcome


def _native_recipe_payload(recipe: Any) -> Optional[Dict[str, Any]]:
    """Persist only the immutable native recipe identity, never its command."""
    if recipe is None:
        return None
    binding = recipe.binding
    return {
        "recipe_id": recipe.recipe_id,
        "case_id": recipe.case_id,
        "package_id": binding.package_id,
        "release_version": binding.release_version,
        "release_digest": binding.release_digest,
        "harness_id": binding.harness_id,
        "variant_id": binding.variant_id,
        "profile": binding.profile,
        "runtime_version": binding.runtime_version,
        "installation_id": binding.installation_id,
        "platform": recipe.platform,
        "arch": recipe.arch,
        "executable_sha256": recipe.executable_sha256,
        "proof_id": recipe.proof_id,
        "memory_bytes": getattr(recipe.limits, "memory_bytes", None),
    }


def _native_identity_from_context(recipe: Any, context: Any, feature: str) -> Any:
    """Convert one verified context binding; never derive adapter data from a recipe."""
    from skill_hub.infrastructure.harnesses import harness_native_executor

    if context is None or getattr(context, "inventory_cache_state", None) != "fresh":
        return None
    decision = context.decision(recipe.binding.harness_id, feature)
    binding = getattr(decision, "binding", None)
    if (
        decision is None
        or getattr(decision, "status", None) != "supported"
        or getattr(decision, "validation_provenance", None) != "verified"
        or binding is None
        or (
            feature == "invocation"
            and context.trusted_invocation_profile(recipe.binding.harness_id) != binding.profile
        )
    ):
        return None
    expected = recipe.binding
    if any(
        (
            str(getattr(binding, field, None))
            if field in {"release_version", "runtime_version"}
            else getattr(binding, field, None)
        )
        != (
            str(getattr(expected, field, None))
            if field in {"release_version", "runtime_version"}
            else getattr(expected, field, None)
        )
        for field in (
            "package_id",
            "release_version",
            "release_digest",
            "harness_id",
            "variant_id",
            "profile",
            "runtime_version",
            "installation_id",
        )
    ):
        return None
    identity = getattr(binding, "runtime_identity", None)
    inventory = getattr(context, "inventory", None)
    if identity is None or inventory is None:
        return None
    observed_at = getattr(inventory, "observed_at", None)
    if not isinstance(observed_at, str) or not observed_at:
        return None
    if not any(item == identity for item in getattr(inventory, "identities", ())):
        return None
    executable_path = getattr(identity, "executable_path", None)
    cached_fingerprint = getattr(identity, "executable_fingerprint", None)
    if not isinstance(executable_path, str) or not isinstance(cached_fingerprint, str):
        return None
    try:
        from skill_hub.application.harnesses.harness_runtime import executable_fingerprint

        if executable_fingerprint(executable_path) != cached_fingerprint:
            return None
        digest = hashlib.sha256()
        with Path(executable_path).resolve().open("rb") as stream:
            while True:
                chunk = stream.read(1024 * 1024)
                if not chunk:
                    break
                digest.update(chunk)
        executable_sha256 = "sha256:" + digest.hexdigest()
    except OSError:
        return None
    values = {
        "package_id": binding.package_id,
        "harness_id": binding.harness_id,
        "installation_id": binding.installation_id,
        "runtime_version": str(binding.runtime_version),
        "release_version": str(binding.release_version),
        "release_digest": binding.release_digest,
        "platform": getattr(identity, "os_name", None),
        "arch": getattr(identity, "architecture", None),
        "executable_path": executable_path,
        "executable_sha256": executable_sha256,
        "variant_id": binding.variant_id,
        "profile": binding.profile,
        "evidence": getattr(identity, "evidence", None),
    }
    try:
        return harness_native_executor.NativeRuntimeIdentity(**values)
    except (TypeError, ValueError):
        return None


def _native_catalog(args: argparse.Namespace) -> Tuple[Optional[Dict[str, Any]], Optional[str], Optional[str]]:
    """Load the caller-selected audited catalog and its real file digest."""
    root = Path(getattr(args, "repo_root", None) or REPO_ROOT).resolve()
    selected_catalog = getattr(args, "catalog", None)
    catalog_path = (
        Path(selected_catalog)
        if selected_catalog is not None
        else root / "tests" / "integration_contracts" / "catalog.json"
    )
    try:
        catalog = load_catalog(catalog_path, root)
        digest = hashlib.sha256(catalog_path.read_bytes()).hexdigest()
    except (CatalogError, OSError, ValueError) as exc:
        return None, None, "native catalog unavailable: {}".format(exc)
    return catalog, digest, None


def _native_provenance(args: Any, recipe: Any, data: Optional[Mapping[str, Any]]) -> Mapping[str, Any]:
    if isinstance(data, Mapping):
        return data
    if recipe is None:
        return {"status": "not_collected"}
    from types import SimpleNamespace

    selected_args = SimpleNamespace(harness=[recipe.binding.harness_id], feature=[], case=[])
    try:
        from skill_hub.entrypoints.cli.integration import _provenance_data

        return _provenance_data(selected_args)
    except (OSError, TypeError, ValueError):
        return {"status": "not_collected"}


def _native_provenance_from_context(
    context: Any, host_version: Any, sdk_version: Any
) -> Mapping[str, Any]:
    """Project one captured context into the persisted provenance shape."""
    from skill_hub.application.harnesses import harness_operation_context

    serialize_context = getattr(harness_operation_context, "serialize_operation_context", None)
    if not callable(serialize_context):
        return {"status": "not_collected"}
    payload = serialize_context(context)
    inventory = getattr(context, "inventory", None)
    identities = [
        {
            "harness_id": item.harness_id,
            "installation_id": item.installation_id,
            "version": str(item.version) if item.version else ("unknown" if item.raw_version else None),
        }
        for item in getattr(inventory, "identities", ())
    ]
    decisions = []
    for harness_id, rows in payload.get("decisions", {}).items():
        for decision in rows:
            decisions.append({"harness_id": harness_id, **decision})
    fresh = getattr(context, "inventory_cache_state", None) == "fresh"
    return {
        "status": "cache" if fresh else "not_collected",
        "runtime": {
            "status": "fresh" if fresh else "missing_or_stale",
            "fingerprint": getattr(inventory, "request_fingerprint", None),
            "observed_at": getattr(inventory, "observed_at", None),
            "identities": identities,
        },
        "adapter": {
            "sdk_version": str(sdk_version) if sdk_version is not None else None,
            "host_version": str(host_version) if host_version is not None else None,
        },
        "catalog": {
            "generation": payload.get("catalog_generation"),
            "digest": payload.get("catalog_digest"),
        },
        "selected_decisions": decisions,
        "operation_context_id": payload.get("context_id"),
    }


_FRESHNESS_SECONDS = {"quick": 7 * 24 * 60 * 60, "offline": 7 * 24 * 60 * 60, "native": 24 * 60 * 60}


def _freshness(report: Mapping[str, Any], now: Optional[_dt.datetime] = None) -> Dict[str, Any]:
    profile = str(report.get("profile", ""))
    limit = _FRESHNESS_SECONDS.get(profile)
    metadata = report.get("metadata")
    metadata = metadata if isinstance(metadata, Mapping) else {}
    freshness = metadata.get("freshness")
    observed = freshness.get("observed_at") if isinstance(freshness, Mapping) else None
    if observed is None and profile in PROFILES:
        observed = report.get("finished_at")
    if not isinstance(observed, str) or not observed:
        status = "stale"
        return {"status": status, "reason": "freshness timestamp is missing", "max_age_seconds": limit}
    try:
        timestamp = _dt.datetime.fromisoformat(observed.replace("Z", "+00:00"))
    except ValueError:
        return {"status": "stale", "reason": "freshness timestamp is invalid", "max_age_seconds": limit}
    if timestamp.tzinfo is None:
        return {"status": "stale", "reason": "freshness timestamp has no timezone", "max_age_seconds": limit}
    current = now or _dt.datetime.now(_dt.timezone.utc)
    age = (current - timestamp).total_seconds()
    if age < 0:
        return {"status": "stale", "reason": "freshness timestamp is in the future", "max_age_seconds": limit}
    if limit is not None and age > limit:
        return {"status": "stale", "reason": "freshness window expired", "max_age_seconds": limit}
    return {"status": "fresh", "reason": None, "max_age_seconds": limit}


def _native_reproduction_argv(args: argparse.Namespace, catalog_path: Path, report_dir: Path) -> List[str]:
    argv = [
        sys.executable,
        str(Path(__file__).resolve()),
        "native",
        "--recipe",
        str(args.recipe),
        "--catalog",
        str(catalog_path),
        "--report-dir",
        str(report_dir),
    ]
    if getattr(args, "repo_root", None):
        argv.extend(["--repo-root", str(args.repo_root)])
    if bool(args.authorize_native):
        argv.append("--authorize-native")
    return argv


def _plain_evidence(value: Any) -> Any:
    """Convert immutable executor evidence to JSON without losing nested fields."""
    if isinstance(value, Mapping):
        return {key: _plain_evidence(item) for key, item in value.items()}
    if isinstance(value, (tuple, list)):
        return [_plain_evidence(item) for item in value]
    return value


def _native_run(
    args: argparse.Namespace,
    data: Optional[Mapping[str, Any]] = None,
    *,
    recipes: Optional[Mapping[str, Any]] = None,
    runtime_identity: Any = None,
    sandbox_factory: Any = None,
) -> int:
    """Allocate, persist, and execute one explicitly authorized native case."""
    from skill_hub.infrastructure.harnesses import harness_native_executor

    report_dir = Path(args.report_dir).resolve()
    report_dir.mkdir(parents=True, exist_ok=True)
    run_id = _dt.datetime.now(_dt.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ") + "-" + uuid.uuid4().hex[:8]
    run_path = report_dir / run_id
    run_path.mkdir(mode=0o700)
    production = recipes is None
    recipe_table: Mapping[str, Any] = (
        harness_native_executor.NATIVE_RECIPES if production else dict(recipes or {})
    )
    catalog: Optional[Dict[str, Any]] = None
    corpus_digest: Optional[str] = None
    catalog_error: Optional[str] = None
    catalog_path = Path(
        getattr(args, "catalog", None) or (REPO_ROOT / "tests" / "integration_contracts" / "catalog.json")
    )
    if production:
        catalog, corpus_digest, catalog_error = _native_catalog(args)
    recipe = recipe_table.get(args.recipe)
    audited_case = None
    if recipe is not None and catalog is not None:
        matches = [case for case in catalog["cases"] if case["id"] == recipe.case_id]
        if len(matches) != 1:
            catalog_error = "native recipe case is not present exactly once in the catalog"
        else:
            audited_case = matches[0]
            if not any(
                item in {"native", "native_runtime"}
                for item in audited_case.get("required_evidence", [])
            ):
                catalog_error = "native recipe case does not require native evidence"
    provenance: Mapping[str, Any] = (
        data if isinstance(data, Mapping) else {"status": "not_collected"}
    )
    host_metadata = _native_host_metadata()
    started_at = _dt.datetime.now(_dt.timezone.utc).isoformat()
    report: Dict[str, Any] = {
        "schema_version": 1,
        "run_id": run_id,
        "status": "running",
        "profile": "native",
        "started_at": started_at,
        "finished_at": None,
        "metadata": {
            "host_os": _platform_id(),
            "arch": platform.machine(),
            "python": platform.python_version(),
            "environment_family": _environment_family(),
            **host_metadata,
            "corpus_sha256": corpus_digest,
            "provenance": dict(provenance),
            "freshness": {
                "policy_seconds": _FRESHNESS_SECONDS["native"],
                "observed_at": started_at,
            },
            "reproduction_argv": _native_reproduction_argv(args, catalog_path, report_dir),
        },
        "selection": {"recipe": args.recipe, "authorized": bool(args.authorize_native)},
        "cases": [],
        "coverage_gaps": [],
        "summary": {},
    }
    if catalog_error is not None:
        report["selection_error"] = catalog_error
    case_id = recipe.case_id if recipe is not None else "native-" + _safe_name(args.recipe)
    case_layer = str(audited_case["layer"]) if audited_case is not None else "native"
    case_revision = str(audited_case["revision"]) if audited_case is not None else None
    case_environment = (
        str(audited_case.get("environment_family", _environment_family()))
        if audited_case is not None
        else _environment_family()
    )
    case_required = (
        list(audited_case.get("required_evidence", ["native"]))
        if audited_case is not None
        else ["native"]
    )
    row: Dict[str, Any] = {
        "id": case_id,
        "status": "blocked" if recipe is None or catalog_error is not None else "inconclusive",
        "reason": (
            catalog_error
            or "unknown native recipe"
            if recipe is None or catalog_error is not None
            else "pending native execution"
        ),
        "elapsed_seconds": 0.0,
        "selectors": [],
        "pytest": {"collected": 0, "passed": 0, "failed": 0, "errors": 0, "skipped": 0, "xfailed": 0},
        "logs": {"stdout": "", "stderr": ""},
        "evidence": {},
        **({"revision": case_revision} if case_revision is not None else {}),
        "layer": case_layer,
        "environment_family": case_environment,
        "required_evidence": case_required,
        "execution_kind": "native",
        "reproduction_argv": _native_reproduction_argv(args, catalog_path, report_dir),
        "native_recipe": _native_recipe_payload(recipe),
        "native_proof": {},
    }
    report["cases"] = [row]
    _write_report(run_path, report)
    if recipe is not None and catalog_error is None:
        result: Optional[harness_native_executor.NativeResult] = None
        try:
            if production:
                runtime_identity = None
                try:
                    from skill_hub import hub_core
                    from skill_hub.application.harnesses import harness_operation_context
                    from skill_hub.domain.harnesses.harness_adapter_api import SDK_VERSION, Version

                    build_context = getattr(harness_operation_context, "build_operation_context", None)
                    if not callable(build_context):
                        raise AttributeError("verified invocation context factory is unavailable")
                    feature = str(audited_case["feature"]) if audited_case is not None else "invocation"
                    host_version = Version.parse(hub_core.hub_version())
                    context = build_context(
                        hub_core.data_home(),
                        (recipe.binding.harness_id,),
                        requested_features=(feature,),
                        host_version=host_version,
                        sdk_version=SDK_VERSION,
                        needs_selection=False,
                    )
                    provenance = _native_provenance_from_context(context, host_version, SDK_VERSION)
                    # The same cache-only context supplies both the persisted
                    # provenance and the identity passed to the executor.  Do not
                    # allow a separately supplied identity to diverge from it.
                    runtime_identity = _native_identity_from_context(recipe, context, feature)
                except (ImportError, AttributeError, OSError, TypeError, ValueError):
                    provenance = {"status": "not_collected"}
            elif not isinstance(data, Mapping):
                provenance = _native_provenance(args, recipe, data)
            report["metadata"]["provenance"] = dict(provenance)
            _write_report(run_path, report)
            request = harness_native_executor.NativeRequest(
                recipe.recipe_id,
                harness_native_executor.NativeAuthorization(bool(args.authorize_native)),
            )
            result = harness_native_executor.execute_native(
                request,
                recipe_table,
                runtime_identity,
                sandbox_factory,
            )
        except KeyboardInterrupt:
            result = harness_native_executor.NativeResult(
                status="inconclusive",
                reason="native execution interrupted",
                elapsed_seconds=0.0,
                provenance="native" if production else "fixture",
            )
        assert result is not None
        row.update(
            {
                "status": result.status,
                "reason": result.reason,
                "elapsed_seconds": result.elapsed_seconds,
                "logs": dict(result.logs),
                "evidence": _plain_evidence(result.evidence),
                "execution_kind": result.provenance,
                "native_proof": {**dict(result.proof), "provenance": result.provenance},
            }
        )
    row = _annotate_case(row, row)
    report["cases"][0] = row
    interrupted = row.get("status") == "inconclusive" and "interrupt" in str(row.get("reason", "")).lower()
    report["status"] = "interrupted" if interrupted else "complete"
    report["finished_at"] = _dt.datetime.now(_dt.timezone.utc).isoformat()
    report["metadata"]["freshness"]["observed_at"] = report["finished_at"]
    _write_report(run_path, report)
    if args.json:
        print(json.dumps(report, indent=2, sort_keys=True))
    else:
        print(str(run_path))
    return 0 if report.get("effective_evidence_verdict") == "pass" else 1


def _runner_argv(case_id: str, root: Path, catalog_path: Path, report_parent: Path, profile: str) -> List[str]:
    return [
        sys.executable,
        str(Path(__file__).resolve()),
        "run",
        "--catalog",
        str(catalog_path),
        "--repo-root",
        str(root),
        "--report-dir",
        str(report_parent),
        "--profile",
        profile,
        "--case",
        case_id,
    ]


def _run_case(
    case: Mapping[str, Any], root: Path, run_path: Path, catalog_path: Path, profile: str
) -> Dict[str, Any]:
    case_id = str(case["id"])
    started = time.monotonic()
    case_dir = run_path / "evidence" / _safe_name(case_id)
    case_dir.mkdir(parents=True, exist_ok=True)
    sandbox = run_path / "isolation" / _safe_name(case_id)
    sandbox.mkdir(parents=True, exist_ok=True)
    junit_tmp = case_dir / "pytest.xml.tmp"
    stdout_tmp = case_dir / "stdout.tmp"
    stderr_tmp = case_dir / "stderr.tmp"
    pytest_argv = [
        sys.executable,
        "-m",
        "pytest",
        "--override-ini",
        "addopts=",
        "--basetemp",
        str(sandbox / "pytest"),
        "-s",
        "--junitxml",
        str(junit_tmp),
        *[str(s) for s in case["selectors"]],
    ]
    argv = _runner_argv(case_id, root, catalog_path, run_path.parent, profile)
    env, secrets = _sanitized_env(sandbox, root)
    result: Dict[str, Any] = {
        "id": case_id,
        "status": "inconclusive",
        "reason": "runner did not produce an outcome",
        "elapsed_seconds": 0.0,
        "selectors": list(case["selectors"]),
        "pytest": {"collected": 0, "passed": 0, "failed": 0, "errors": 0, "skipped": 0, "xfailed": 0},
        "logs": {"stdout": "", "stderr": ""},
        "reproduction_argv": argv,
        "pytest_argv": pytest_argv,
        "evidence": {},
    }
    proc: Optional[subprocess.Popen[Any]] = None
    supervised: Any = None
    output = {"stdout": bytearray(), "stderr": bytearray()}
    overflow = threading.Event()
    readers: List[threading.Thread] = []

    def read_output(stream: Any, target: bytearray) -> None:
        try:
            while True:
                chunk = stream.read(4096)
                if not chunk:
                    break
                room = MAX_LOG_BYTES - len(target)
                target.extend(chunk[:room])
                if len(chunk) > room:
                    overflow.set()
        finally:
            stream.close()
    try:
        try:
            supervised = _launch(
                pytest_argv, cwd=str(root), env=env,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                memory_bytes=case.get("memory_bytes", DEFAULT_MEMORY_BYTES),
            )
            proc = supervised.process
            result["supervision"] = {
                "max_parallel": 1, "memory_bytes": case.get("memory_bytes", DEFAULT_MEMORY_BYTES),
                "memory_mode": supervised.memory_mode, "memory_scope": "per_process",
            }
        except OSError as exc:
            result.update(status="blocked", reason="could not start pytest: {}".format(exc))
        else:
            for name in ("stdout", "stderr"):
                reader = threading.Thread(target=read_output, args=(getattr(proc, name), output[name]), daemon=True)
                reader.start()
                readers.append(reader)
            return_code: Optional[int] = None
            if result["status"] != "blocked":
                try:
                    deadline = started + float(case["timeout_seconds"])
                    while proc.poll() is None:
                        if overflow.is_set():
                            supervised.close()
                            break
                        if junit_tmp.exists() and junit_tmp.stat().st_size > MAX_JUNIT_BYTES:
                            overflow.set()
                            supervised.close()
                            break
                        if time.monotonic() >= deadline:
                            raise subprocess.TimeoutExpired(pytest_argv, float(case["timeout_seconds"]))
                        time.sleep(0.01)
                    return_code = proc.returncode
                    # Reap descendants before waiting for their inherited pipe handles.
                    supervised.close()
                except subprocess.TimeoutExpired:
                    supervised.close()
                    result.update(status="blocked", reason="pytest timed out")
                except KeyboardInterrupt:
                    supervised.close()
                    result.update(status="inconclusive", reason="run interrupted")
                    raise
            for reader in readers:
                reader.join(timeout=2)
            if overflow.is_set() or (junit_tmp.exists() and junit_tmp.stat().st_size > MAX_JUNIT_BYTES):
                result.update(status="fail", reason="pytest output exceeded bound")
                return_code = None
            if any(reader.is_alive() for reader in readers):
                result.update(status="inconclusive", reason="output reader cleanup incomplete")
                return_code = None
            counts = _pytest_counts(junit_tmp)
            result["pytest"] = counts
            result["failure_tests"] = _pytest_failure_tests(junit_tmp)
            if return_code is not None:
                boundary_blocked = False
                for captured in output.values():
                    boundary_blocked = boundary_blocked or b"offline runner blocked" in captured
                if boundary_blocked:
                    result.update(status="blocked", reason="offline process boundary blocked a harness executable")
                elif counts["collected"] == 0:
                    result.update(status="blocked", reason="pytest collected zero tests")
                elif counts["errors"] and counts["collected"]:
                    result.update(status="fail", reason="pytest reported an error")
                elif counts["failed"] or return_code != 0:
                    result.update(status="fail", reason="pytest reported a failure (exit {})".format(return_code))
                elif counts["skipped"]:
                    result.update(status="skipped", reason="pytest skipped or xfailed a selected test")
                else:
                    result.update(status="pass", reason="all selected pytest tests passed")
    except KeyboardInterrupt:
        raise
    finally:
        cleanup_incomplete = False
        if supervised is not None:
            try:
                cleanup_incomplete = not supervised.close()
            except (OSError, RuntimeError):
                cleanup_incomplete = True
        for reader in readers:
            reader.join(timeout=2)
        stdout_tmp.write_bytes(output["stdout"])
        stderr_tmp.write_bytes(output["stderr"])
        result["elapsed_seconds"] = round(time.monotonic() - started, 3)
        result["logs"] = {
            "stdout": _read_bounded(stdout_tmp, root, sandbox, secrets),
            "stderr": _read_bounded(stderr_tmp, root, sandbox, secrets),
        }
        for source, name in ((stdout_tmp, "stdout.log"), (stderr_tmp, "stderr.log")):
            if source.exists():
                _atomic_write(
                    case_dir / name,
                    _redact(_read_bounded(source, root, sandbox, secrets), root, sandbox, secrets),
                )
                cleanup_incomplete = not _unlink_bounded(source) or cleanup_incomplete
        if junit_tmp.exists():
            _atomic_write(case_dir / "junit.xml", _retained_junit_xml(junit_tmp, root, sandbox, secrets))
            cleanup_incomplete = not _unlink_bounded(junit_tmp) or cleanup_incomplete
        else:
            _atomic_write(case_dir / "junit.xml", _unavailable_junit_xml("missing"))
        if cleanup_incomplete:
            result.update(status="inconclusive", reason="process or evidence temporary file cleanup was incomplete")
        result["evidence"] = {
            "stdout": str((case_dir / "stdout.log").relative_to(run_path)),
            "stderr": str((case_dir / "stderr.log").relative_to(run_path)),
            "junitxml": str((case_dir / "junit.xml").relative_to(run_path)),
        }
    return result


def _coverage_gaps(cases: Sequence[Mapping[str, Any]], current: str) -> List[Dict[str, str]]:
    gaps = []
    for case in cases:
        reason = case.get("gap")
        if reason:
            gaps.append({"id": str(case["id"]), "reason": str(reason)})
        elif case.get("layer") != "offline":
            gaps.append({"id": str(case["id"]), "reason": "{} layer is outside offline profile".format(case["layer"])})
        elif current not in case.get("platforms", []):
            gaps.append(
                {"id": str(case["id"]), "reason": "case is not declared for observed {} platform".format(current)}
            )
    return gaps


def _markdown(report: Mapping[str, Any]) -> str:
    summary = report["summary"]
    lines = [
        "# Integration validation run",
        "",
        "- Run ID: `{}`".format(report["run_id"]),
        "- Status: `{}`".format(report["status"]),
        "- Profile: `{}`".format(report["profile"]),
        "- Captured evidence verdict: `{}`".format(report.get("evidence_verdict", "blocked")),
        "- Current evidence verdict: `{}`".format(report.get("effective_evidence_verdict", "blocked")),
        "- Freshness: `{}`".format(_freshness(report)["status"]),
        "- Git: `{}` (dirty: `{}`)".format(
            report["metadata"].get("git_revision") or "unknown", report["metadata"].get("git_dirty")
        ),
        "- Corpus SHA-256: `{}`".format(report["metadata"]["corpus_sha256"]),
        "",
        "## Outcomes",
        "",
        "| Case | Status | Reason | Elapsed |",
        "| --- | --- | --- | ---: |",
    ]
    for case in report["cases"]:
        lines.append(
            "| `{}` | `{}` | {} | {:.3f}s |".format(
                case["id"], case["status"], str(case["reason"]).replace("|", "\\|"), case["elapsed_seconds"]
            )
        )
    lines.extend(
        [
            "",
            "## Coverage gaps",
            "",
            "Offline runs do not certify native, runtime, packaged, or other OS coverage.",
        ]
    )
    if report.get("effective_missing_requirements", report.get("missing_requirements")):
        lines.extend(["", "Missing requirements:"])
        lines.extend(
            "- {}".format(item)
            for item in report.get("effective_missing_requirements", report["missing_requirements"])
        )
    if report["coverage_gaps"]:
        lines.extend("- `{}`: {}".format(g["id"], g["reason"]) for g in report["coverage_gaps"])
    else:
        lines.append("- None selected.")
    lines.extend(["", "Summary: {}".format(json.dumps(summary, sort_keys=True)), ""])
    return "\n".join(lines)


def _evidence_verdict(report: Mapping[str, Any]) -> Tuple[str, List[str]]:
    missing: List[str] = []
    selection_error = report.get("selection_error")
    if selection_error:
        missing.append("selection: {}".format(selection_error))
        return "fail", missing
    if report.get("status") != "complete":
        missing.append("report is not complete")
    cases = report.get("cases", [])
    if not cases:
        return "fail", missing + ["no selected cases"]
    if any(case.get("status") == "fail" for case in cases):
        missing.append("one or more selected cases failed")
        return "fail", missing
    for case in cases:
        case_id = str(case.get("id", "case"))
        status = case.get("status")
        if status != "pass":
            reason = case.get("reason")
            detail = str(status) if not reason or reason == status else "{} ({})".format(status, reason)
            missing.append("{}: {}".format(case_id, detail))
        required = case.get("required_evidence", [])
        if not isinstance(required, list):
            missing.append("{}: required evidence is missing".format(case_id))
            required = []
        unknown = [str(item) for item in required if item not in KNOWN_EVIDENCE]
        missing.extend("{}: unknown evidence requirement {}".format(case_id, item) for item in unknown)
        layer = case.get("layer")
        revision = case.get("revision")
        environment = case.get("environment_family")
        native_required = any(item not in OFFLINE_EVIDENCE for item in required)
        if status == "pass":
            execution_kind = case.get("execution_kind")
            if native_required and execution_kind != "native":
                missing.append(
                    "{}: offline runner cannot certify native evidence; "
                    "fixture provenance cannot certify native evidence".format(case_id)
                )
            elif execution_kind == "native":
                recipe_payload = case.get("native_recipe")
                if not isinstance(recipe_payload, dict) or recipe_payload.get("case_id") != case_id:
                    missing.append("{}: native recipe identity is missing or mismatched".format(case_id))
                proof = case.get("native_proof")
                if not isinstance(proof, dict) or proof.get("verdict") != "pass":
                    missing.append("{}: native proof is missing or failed".format(case_id))
                elif proof.get("provenance") != "native":
                    missing.append("{}: fixture provenance cannot certify native evidence".format(case_id))
                elif not isinstance(proof.get("evidence_digest"), str) or not re.fullmatch(
                    r"sha256:[0-9a-f]{64}", proof["evidence_digest"]
                ):
                    missing.append("{}: native proof digest is invalid".format(case_id))
            else:
                counts = case.get("pytest", {})
                if (
                    not isinstance(counts, dict)
                    or counts.get("collected", 0) <= 0
                    or counts.get("passed", 0) <= 0
                    or counts.get("passed", 0) != counts.get("collected", 0)
                    or any(counts.get(key, 0) != 0 for key in ("failed", "errors", "skipped", "xfailed"))
                ):
                    missing.append("{}: pytest counts do not prove a passing run".format(case_id))
                if layer != "offline":
                    missing.append("{}: {} evidence requires its native/runtime executor".format(case_id, layer))
                if native_required:
                    missing.append("{}: required evidence is unavailable in the offline runner".format(case_id))
            if not revision or revision == "legacy":
                missing.append("{}: versioned case revision is required".format(case_id))
            if not environment:
                missing.append("{}: environment identity is required".format(case_id))
    metadata = report.get("metadata")
    provenance = metadata.get("provenance") if isinstance(metadata, Mapping) else None
    if provenance is None:
        if any(case.get("status") == "pass" for case in cases):
            missing.append("adapter provenance is unavailable")
    elif not isinstance(provenance, dict):
        missing.append("adapter provenance is malformed")
    else:
        provenance_status = provenance.get("status")
        if provenance_status not in ("cache", "not_collected"):
            missing.append("adapter provenance status is invalid")
        elif provenance_status == "cache":
            runtime = provenance.get("runtime")
            if not isinstance(runtime, dict):
                missing.append("adapter provenance runtime is malformed")
            else:
                if runtime.get("status") != "fresh":
                    missing.append("adapter provenance runtime status is not fresh")
                fingerprint = runtime.get("fingerprint")
                if not isinstance(fingerprint, str) or not fingerprint or len(fingerprint) > 128:
                    missing.append("adapter provenance runtime fingerprint is invalid")
                identities = runtime.get("identities")
                if not isinstance(identities, list):
                    missing.append("adapter provenance runtime identities are malformed")
                else:
                    for identity in identities:
                        if (
                            not isinstance(identity, dict)
                            or not isinstance(identity.get("harness_id"), str)
                            or not identity["harness_id"]
                            or not isinstance(identity.get("installation_id"), str)
                            or not identity["installation_id"]
                            or (identity.get("version") is not None and not isinstance(identity["version"], str))
                        ):
                            missing.append("adapter provenance runtime identity is malformed")
                            break
            adapter = provenance.get("adapter")
            if not isinstance(adapter, dict):
                missing.append("adapter provenance adapter is malformed")
            else:
                for field in ("sdk_version", "host_version"):
                    if field not in adapter:
                        missing.append("adapter provenance is missing {}".format(field))
                        continue
                    value = adapter.get(field)
                    if value is not None and (not isinstance(value, str) or not value or len(value) > 64):
                        missing.append("adapter provenance {} is invalid".format(field))
            catalog_info = provenance.get("catalog")
            if not isinstance(catalog_info, dict):
                missing.append("adapter provenance catalog is malformed")
            else:
                generation = catalog_info.get("generation")
                if not isinstance(generation, str) or not generation or len(generation) > 128:
                    missing.append("adapter provenance catalog generation is invalid")
                digest = catalog_info.get("digest")
                if not isinstance(digest, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
                    missing.append("adapter provenance catalog digest is invalid")
            decisions = provenance.get("selected_decisions")
            if not isinstance(decisions, list) or any(
                not isinstance(decision, dict)
                or not isinstance(decision.get("harness_id"), str)
                or not decision["harness_id"]
                for decision in decisions
            ):
                missing.append("adapter provenance selected decisions are malformed")
        elif any(
            item not in OFFLINE_EVIDENCE
            for case in cases
            for item in (
                case.get("required_evidence", [])
                if isinstance(case.get("required_evidence", []), list)
                else []
            )
        ):
            missing.append("adapter provenance was not collected for non-offline evidence")
    gaps = report.get("coverage_gaps", [])
    if gaps:
        missing.extend("{}: {}".format(g.get("id", "gap"), g.get("reason", "coverage gap")) for g in gaps)
        missing.append("native/runtime/packaged evidence requires a fresh exact passing run")
    if missing:
        return "blocked", missing
    return "pass", []


def _effective_evidence(report: Mapping[str, Any], verdict: str, missing: Sequence[str]) -> Tuple[str, List[str]]:
    if verdict != "pass":
        return verdict, list(missing)
    gaps = list(missing)
    if report.get("profile") == "native":
        metadata = report.get("metadata", {})
        source = metadata.get("source_digest")
        if not isinstance(source, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", source):
            gaps.append("native host source identity is unavailable")
        for case in report.get("cases", []):
            argv = case.get("reproduction_argv")
            if not isinstance(argv, list) or not argv or any(not isinstance(v, str) for v in argv):
                gaps.append("native reproduction arguments are unavailable")
            supervision = case.get("evidence", {}).get("supervision", {})
            memory = supervision.get("memory_bytes")
            if (
                supervision.get("max_parallel") != 1
                or supervision.get("memory_mode") not in {"rlimit_as", "windows-job"}
                or isinstance(memory, bool) or not isinstance(memory, int) or memory <= 0
                or memory != (case.get("native_recipe") or {}).get("memory_bytes")
            ):
                gaps.append("native resource enforcement evidence is unavailable")
    freshness = _freshness(report)
    if freshness["status"] != "fresh":
        gaps.append("report freshness: {}".format(freshness["reason"]))
    return ("blocked", gaps) if gaps else (verdict, [])


def validate_report(report: Any) -> Dict[str, Any]:
    """Validate persisted reports, including all fields used by formatting."""
    if not isinstance(report, dict):
        raise ValueError("report must be an object")
    if isinstance(report.get("schema_version"), bool) or report.get("schema_version") != 1:
        raise ValueError("report schema_version must be 1")
    for key in ("run_id", "status", "profile"):
        if not isinstance(report.get(key), str) or not report[key]:
            raise ValueError("report {} must be a non-empty string".format(key))
    if report["status"] not in ("running", "complete", "interrupted"):
        raise ValueError("report status is invalid")
    selection_error = report.get("selection_error")
    if selection_error is not None and (not isinstance(selection_error, str) or not selection_error):
        raise ValueError("report selection_error must be a string")
    if report["profile"] not in REPORT_PROFILES and not selection_error:
        raise ValueError("report profile is invalid")
    metadata = report.get("metadata")
    if not isinstance(metadata, dict):
        raise ValueError("report metadata must be an object")
    digest = metadata.get("corpus_sha256")
    if digest is None and not selection_error:
        raise ValueError("report metadata.corpus_sha256 must be a string")
    if digest is not None and (not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest)):
        raise ValueError("report corpus digest is invalid")
    cases = report.get("cases")
    if not isinstance(cases, list):
        raise ValueError("report cases must be a list")
    seen_ids: set[str] = set()
    for case in cases:
        if not isinstance(case, dict):
            raise ValueError("report case must be an object")
        case_id = case.get("id")
        if not isinstance(case_id, str) or not case_id:
            raise ValueError("report case id must be a non-empty string")
        if case_id in seen_ids:
            raise ValueError("duplicate report case id {}".format(case_id))
        seen_ids.add(case_id)
        if case.get("status") not in STATUSES:
            raise ValueError("report case status is invalid")
        elapsed = case.get("elapsed_seconds")
        if (
            isinstance(elapsed, bool)
            or not isinstance(elapsed, (int, float))
            or not math.isfinite(float(elapsed))
            or elapsed < 0
        ):
            raise ValueError("report case elapsed_seconds must be finite and non-negative")
        if not isinstance(case.get("reason"), str):
            raise ValueError("report case reason must be a string")
        for key in ("revision", "layer", "environment_family", "failure_class", "failure_signature"):
            if key in case and (not isinstance(case[key], str) or len(case[key]) > 240):
                raise ValueError("report case {} is invalid".format(key))
        if "failure_class" in case and case["failure_class"] not in FAILURE_CLASSES:
            raise ValueError("report case failure_class is invalid")
        signature_strength = case.get("failure_signature_strength")
        if signature_strength is not None and signature_strength not in {"weak", "strong"}:
            raise ValueError("report case failure_signature_strength is invalid")
        failure_tests = case.get("failure_tests", [])
        if not isinstance(failure_tests, list) or any(
            not isinstance(item, str) or not item or len(item) > 240 for item in failure_tests
        ):
            raise ValueError("report case failure_tests are invalid")
        fingerprint = case.get("failure_fingerprint")
        if fingerprint is not None and (
            not isinstance(fingerprint, str) or not re.fullmatch(r"[0-9a-f]{64}", fingerprint)
        ):
            raise ValueError("report case failure_fingerprint is invalid")
        execution_kind = case.get("execution_kind")
        if execution_kind is not None and execution_kind not in {"fixture", "native"}:
            raise ValueError("report case execution_kind is invalid")
        native_recipe = case.get("native_recipe")
        if native_recipe is not None:
            if not isinstance(native_recipe, dict):
                raise ValueError("report case native_recipe must be an object")
            allowed_recipe_fields = {
                "recipe_id", "case_id", "package_id", "release_version", "release_digest",
                "harness_id", "variant_id", "profile", "runtime_version", "installation_id",
                "platform", "arch", "executable_sha256", "proof_id", "memory_bytes",
            }
            if (
                set(native_recipe) - allowed_recipe_fields
                or allowed_recipe_fields - {"memory_bytes"} - set(native_recipe)
            ):
                raise ValueError("report case native_recipe contains unsupported fields")
            recipe_fields = (
                "recipe_id", "case_id", "package_id", "release_version", "harness_id",
                "variant_id", "profile", "runtime_version", "installation_id", "platform",
                "arch", "proof_id",
            )
            for key in recipe_fields:
                value = native_recipe.get(key)
                if not isinstance(value, str) or not value or len(value) > 240:
                    raise ValueError("report case native_recipe {} is invalid".format(key))
            for key in ("release_digest", "executable_sha256"):
                value = native_recipe.get(key)
                if not isinstance(value, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", value):
                    raise ValueError("report case native_recipe {} is invalid".format(key))
            memory_bytes = native_recipe.get("memory_bytes")
            if memory_bytes is not None and (
                isinstance(memory_bytes, bool) or not isinstance(memory_bytes, int)
                or not 0 < memory_bytes <= 8_589_934_592
            ):
                raise ValueError("report case native_recipe memory_bytes is invalid")
        native_proof = case.get("native_proof", {})
        if not isinstance(native_proof, dict) or any(
            not isinstance(value, (str, bool, int, float, type(None))) for value in native_proof.values()
        ):
            raise ValueError("report case native_proof is invalid")
        if set(native_proof) - {"verdict", "evidence_digest", "fragment", "provenance", "reason"}:
            raise ValueError("report case native_proof contains unsupported fields")
        if execution_kind == "native" and case.get("status") == "pass":
            if not isinstance(native_recipe, dict) or native_recipe.get("case_id") != case_id:
                raise ValueError("native execution requires a matching native_recipe case_id")
            if native_proof.get("provenance") is not None and native_proof.get("provenance") not in {
                "native",
                "fixture",
            }:
                raise ValueError("report native_proof provenance is invalid")
            if native_proof.get("verdict") == "pass":
                if native_proof.get("provenance") != "native":
                    raise ValueError("native proof pass requires native provenance")
                if not isinstance(native_proof.get("evidence_digest"), str) or not re.fullmatch(
                    r"sha256:[0-9a-f]{64}", native_proof["evidence_digest"]
                ):
                    raise ValueError("native proof pass requires a valid evidence digest")
        evidence = case.get("evidence", {})
        if not isinstance(evidence, dict):
            raise ValueError("report case evidence must be an object")
        selectors = case.get("selectors", [])
        if not isinstance(selectors, list) or any(not isinstance(item, str) for item in selectors):
            raise ValueError("report case selectors must be a list of strings")
        logs = case.get("logs", {})
        if not isinstance(logs, dict) or any(not isinstance(value, str) for value in logs.values()):
            raise ValueError("report case logs must be a string map")
        pytest_counts = case.get("pytest", {})
        if not isinstance(pytest_counts, dict) or any(
            key not in {"collected", "passed", "failed", "errors", "skipped", "xfailed"}
            or isinstance(value, bool)
            or not isinstance(value, int)
            or value < 0
            for key, value in pytest_counts.items()
        ):
            raise ValueError("report case pytest counts are invalid")
        required = case.get("required_evidence", [])
        if (
            not isinstance(required, list)
            or any(not isinstance(item, str) or not item.strip() or len(item) > 80 for item in required)
            or len(set(required)) != len(required)
        ):
            raise ValueError("report case required_evidence is invalid")
        if case.get("recipe") is not None:
            try:
                _validate_recipe(case["recipe"], case_id=case_id)
            except CatalogError as exc:
                raise ValueError(str(exc)) from exc
    gaps = report.get("coverage_gaps")
    if not isinstance(gaps, list):
        raise ValueError("report coverage_gaps must be a list")
    for gap in gaps:
        if not isinstance(gap, dict) or not isinstance(gap.get("id"), str) or not isinstance(gap.get("reason"), str):
            raise ValueError("report coverage gap must contain string id and reason")
    summary = report.get("summary")
    if not isinstance(summary, dict):
        raise ValueError("report summary must be an object")
    for status, count in summary.items():
        if status not in STATUSES or isinstance(count, bool) or not isinstance(count, int) or count < 0:
            raise ValueError("report summary contains an invalid count")
    expected = {status: sum(case["status"] == status for case in cases) for status in STATUSES}
    if summary != expected:
        raise ValueError("report summary does not match case outcomes")
    expected_verdict, expected_missing = _evidence_verdict(report)
    stored_verdict = report.get("evidence_verdict")
    if stored_verdict is not None and stored_verdict != expected_verdict:
        raise ValueError("report evidence_verdict is stale")
    stored_missing = report.get("missing_requirements")
    if stored_missing is not None and stored_missing != expected_missing:
        raise ValueError("report missing_requirements are stale")
    report["evidence_verdict"] = expected_verdict
    report["missing_requirements"] = expected_missing
    effective_verdict, effective_missing = _effective_evidence(report, expected_verdict, expected_missing)
    report["effective_evidence_verdict"] = effective_verdict
    report["effective_missing_requirements"] = effective_missing
    report["freshness"] = _freshness(report)
    return report


def read_report(path: Path) -> Dict[str, Any]:
    """Read and validate a persisted report without executing any scenario."""
    report_path = Path(path) / "report.json" if Path(path).is_dir() else Path(path)
    try:
        payload = json.loads(report_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError("cannot read report {}: {}".format(report_path, exc)) from exc
    return validate_report(payload)


def format_report(report: Mapping[str, Any]) -> str:
    """Render one validated report using the runner's canonical Markdown."""
    return _markdown(validate_report(dict(report)))


def compare_reports(current: Mapping[str, Any], prior: Mapping[str, Any]) -> Dict[str, Any]:
    """Compare two validated reports without treating gaps as passes."""
    current_report = validate_report(dict(current))
    prior_report = validate_report(dict(prior))
    current_cases = {case["id"]: case for case in current_report["cases"]}
    prior_cases = {case["id"]: case for case in prior_report["cases"]}
    regressions: List[Dict[str, Any]] = []
    repeated_failures: List[Dict[str, Any]] = []
    incomparable: List[Dict[str, Any]] = []
    omitted: List[str] = []
    current_native = current_report.get("profile") == "native" or any(
        case.get("execution_kind") == "native" for case in current_report["cases"]
    )
    if current_native:
        current_revision = current_report["metadata"].get("git_revision")
        prior_revision = prior_report["metadata"].get("git_revision")
        current_source = current_report["metadata"].get("source_digest")
        prior_source = prior_report["metadata"].get("source_digest")
        if current_revision != prior_revision:
            incomparable.append({"id": "<report>", "reason": "host git revision changed"})
        if not current_source or not prior_source or current_source != prior_source:
            incomparable.append({"id": "<report>", "reason": "missing or changed host source digest"})
        for key in ("host_os", "arch", "python", "corpus_sha256"):
            left, right = current_report["metadata"].get(key), prior_report["metadata"].get(key)
            if not left or not right or left != right:
                incomparable.append({"id": "<report>", "reason": "missing or changed {}".format(key)})
        current_prov = current_report["metadata"].get("provenance", {})
        prior_prov = prior_report["metadata"].get("provenance", {})
        for section in ("runtime", "adapter", "catalog"):
            left = current_prov.get(section) if isinstance(current_prov, Mapping) else None
            right = prior_prov.get(section) if isinstance(prior_prov, Mapping) else None
            # Observation time changes between identical runs; identity must not.
            if section == "runtime" and isinstance(left, Mapping) and isinstance(right, Mapping):
                left = {k: v for k, v in left.items() if k != "observed_at"}
                right = {k: v for k, v in right.items() if k != "observed_at"}
            if not left or not right or left != right:
                incomparable.append({"id": "<report>", "reason": "missing or changed provenance {}".format(section)})
    for case_id, old in prior_cases.items():
        new = current_cases.get(case_id)
        if new is None:
            omitted.append(case_id)
            continue
        if current_native and (not old.get("native_recipe") or old.get("native_recipe") != new.get("native_recipe")):
            incomparable.append({"id": case_id, "reason": "missing or changed native recipe identity"})
            continue
        identity_keys = ("revision", "layer", "environment_family")
        if any(not old.get(key) or not new.get(key) for key in identity_keys):
            incomparable.append({"id": case_id, "reason": "missing revision/layer/environment identity"})
            continue
        if any(old.get(key) != new.get(key) for key in identity_keys):
            incomparable.append({"id": case_id, "reason": "revision/layer/environment changed"})
            continue
        if old.get("status") == "pass" and new.get("status") != "pass":
            regressions.append({"id": case_id, "status": new.get("status"), "reason": new.get("reason")})
        elif (
            old.get("status") != "pass"
            and new.get("status") == old.get("status")
            and old.get("failure_fingerprint")
            and old.get("failure_fingerprint") == new.get("failure_fingerprint")
            and old.get("failure_signature_strength") == "strong"
            and new.get("failure_signature_strength") == "strong"
        ):
            repeated_failures.append({"id": case_id, "fingerprint": new["failure_fingerprint"]})
    verdict, missing = _evidence_verdict(current_report)
    verdict, missing = _effective_evidence(current_report, verdict, missing)
    if omitted:
        missing = list(missing) + ["omitted prior cases are never treated as fixed"]
        if verdict == "pass":
            verdict = "blocked"
    if incomparable:
        missing = list(missing) + ["incomparable case identities are never treated as fixed"]
        if verdict == "pass":
            verdict = "blocked"
    if regressions:
        verdict = "fail"
        missing = list(missing) + ["prior passing cases regressed"]
    return {
        "prior_run_id": prior_report["run_id"],
        "current_run_id": current_report["run_id"],
        "regressions": regressions,
        "repeated_failures": repeated_failures,
        "omitted": omitted,
        "incomparable": incomparable,
        "evidence_verdict": verdict,
        "missing_requirements": missing,
    }


def _write_report(run_path: Path, report: Dict[str, Any]) -> None:
    report["summary"] = {status: sum(1 for c in report["cases"] if c["status"] == status) for status in STATUSES}
    verdict, missing = _evidence_verdict(report)
    report["evidence_verdict"] = verdict
    report["missing_requirements"] = missing
    effective_verdict, effective_missing = _effective_evidence(report, verdict, missing)
    report["effective_evidence_verdict"] = effective_verdict
    report["effective_missing_requirements"] = effective_missing
    _atomic_write(run_path / "report.json", json.dumps(report, indent=2, sort_keys=True) + "\n")
    _atomic_write(run_path / "report.md", _markdown(report))


def _run(args: argparse.Namespace, data: Optional[Mapping[str, Any]] = None) -> int:
    root = Path(args.repo_root or REPO_ROOT).resolve()
    catalog_path = (
        Path(args.catalog)
        if args.catalog is not None
        else root / "tests" / "integration_contracts" / "catalog.json"
    )
    current = _platform_id()
    report_dir = Path(args.report_dir).resolve()
    report_dir.mkdir(parents=True, exist_ok=True)
    run_id = _dt.datetime.now(_dt.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ") + "-" + uuid.uuid4().hex[:8]
    run_path = report_dir / run_id
    run_path.mkdir(mode=0o700)
    try:
        corpus_digest: Optional[str] = hashlib.sha256(catalog_path.read_bytes()).hexdigest()
    except (OSError, ValueError):
        corpus_digest = None
    revision, dirty = _git_metadata(root)
    now = _dt.datetime.now(_dt.timezone.utc).isoformat()
    report: Dict[str, Any] = {
        "schema_version": 1,
        "run_id": run_id,
        "status": "running",
        "profile": args.profile,
        "started_at": now,
        "finished_at": None,
        "metadata": {
            "host_os": current,
            "arch": platform.machine(),
            "python": platform.python_version(),
            "environment_family": _environment_family(),
            "git_revision": revision,
            "git_dirty": dirty,
            "corpus_sha256": corpus_digest,
            "provenance": dict(data) if isinstance(data, Mapping) else {"status": "not_collected"},
        },
        "selection": {"harness": args.harness, "feature": args.feature, "case": args.case},
        "cases": [],
        "coverage_gaps": [],
        "summary": {},
    }
    try:
        catalog = load_catalog(catalog_path, root)
        selected = _select_cases(catalog, args.profile, args.harness, args.feature, args.case)
    except (CatalogError, OSError, ValueError) as exc:
        report["selection_error"] = str(exc)
        report["status"] = "complete"
        report["finished_at"] = _dt.datetime.now(_dt.timezone.utc).isoformat()
        _write_report(run_path, report)
        print(str(run_path))
        return 1
    report["cases"] = [
        {
            "id": str(c["id"]),
            "status": "inconclusive",
            "reason": "pending execution",
            "elapsed_seconds": 0.0,
            "selectors": list(c["selectors"]),
            "pytest": {"collected": 0, "passed": 0, "failed": 0, "errors": 0, "skipped": 0, "xfailed": 0},
            "logs": {"stdout": "", "stderr": ""},
            "reproduction_argv": _runner_argv(str(c["id"]), root, catalog_path, report_dir, args.profile),
            "evidence": {},
            "revision": str(c.get("revision", "legacy")),
            "layer": str(c.get("layer", "unknown")),
            "environment_family": _environment_family(),
            "required_evidence": list(c.get("required_evidence", ["legacy_offline"])),
            "recipe": c.get("recipe"),
        }
        for c in selected
    ]
    report["coverage_gaps"] = _coverage_gaps(selected, current)
    _write_report(run_path, report)
    interrupted = False
    try:
        for index, case in enumerate(selected):
            if case.get("gap") or case.get("layer") != "offline":
                outcome = dict(report["cases"][index])
                outcome.update(
                    status="unsupported",
                    reason=str(
                        case.get("gap") or "{} layer is not executable in offline profile".format(case["layer"])
                    ),
                )
            elif current not in case["platforms"]:
                outcome = dict(report["cases"][index])
                outcome.update(
                    status="unsupported",
                    reason="case is not declared for observed {} platform".format(current),
                )
            else:
                outcome = _run_case(case, root, run_path, catalog_path, args.profile)
            outcome = _annotate_case(case, outcome)
            report["cases"][index] = outcome
            _write_report(run_path, report)
    except KeyboardInterrupt:
        interrupted = True
        for pending in report["cases"]:
            if pending["status"] == "inconclusive" and pending["reason"] == "pending execution":
                pending.update(status="inconclusive", reason="run interrupted")
        for index, case in enumerate(selected):
            report["cases"][index] = _annotate_case(case, report["cases"][index])
    report["status"] = "interrupted" if interrupted else "complete"
    report["finished_at"] = _dt.datetime.now(_dt.timezone.utc).isoformat()
    _write_report(run_path, report)
    print(str(run_path))
    executable = [c for c in report["cases"] if c["status"] not in ("unsupported",)]
    return 0 if executable and all(c["status"] == "pass" for c in executable) else 1


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run audited integration contract cases")
    sub = parser.add_subparsers(dest="command", required=True)
    for command in ("list", "run"):
        child = sub.add_parser(command)
        child.add_argument("--catalog", type=Path)
        child.add_argument("--repo-root", type=Path, default=REPO_ROOT)
        child.add_argument("--json", action="store_true", help="emit machine-readable JSON (the default)")
        profile_kwargs: Dict[str, Any] = {"default": "offline"}
        if command == "list":
            profile_kwargs["choices"] = sorted(PROFILES)
        child.add_argument("--profile", **profile_kwargs)
        child.add_argument("--harness", action="append", default=[])
        child.add_argument("--feature", action="append", default=[])
        child.add_argument("--case", action="append", default=[])
    sub.choices["run"].add_argument("--report-dir", type=Path, required=True)
    native = sub.add_parser("native", help="Run one explicitly authorized native recipe")
    native.add_argument("--recipe", required=True)
    native.add_argument("--authorize-native", action="store_true")
    native.add_argument("--catalog", type=Path)
    native.add_argument("--repo-root", type=Path, default=REPO_ROOT)
    native.add_argument("--report-dir", type=Path, required=True)
    native.add_argument("--json", action="store_true", help="emit the completed report as JSON")
    return parser


def main(argv: Optional[Sequence[str]] = None, *, data: Optional[Mapping[str, Any]] = None) -> int:
    try:
        args = _parser().parse_args(argv)
        if args.command == "list":
            if any(x not in HARNESS_IDS for x in args.harness):
                raise CatalogError("unknown harness selector")
            root = Path(args.repo_root or REPO_ROOT).resolve()
            catalog = load_catalog(args.catalog, root)
            selected = _select_cases(catalog, args.profile, args.harness, args.feature, args.case)
            print(json.dumps(selected, indent=2, sort_keys=True))
            return 0
        if args.command == "native":
            return _native_run(args, data=data)
        # Run allocates its report before reading/filtering the catalog so a
        # bad selection remains durable evidence rather than a console error.
        return _run(args, data=data)
    except CatalogError as exc:
        print("integration validation: {}".format(exc), file=sys.stderr)
        return 2
    except OSError as exc:
        print("integration validation: {}".format(exc), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
