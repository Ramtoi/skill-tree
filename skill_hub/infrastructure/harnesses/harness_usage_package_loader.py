"""Load verified Usage reader packages from retained bytes.

The manifest verifier owns filesystem access.  This module turns its immutable
result into a normal importlib package under a digest-qualified namespace.
"""

from __future__ import annotations

import ast
import importlib
import importlib.abc
import importlib.machinery
import sys
import threading
from dataclasses import dataclass, field
from importlib import _bootstrap
from pathlib import Path
from types import ModuleType
from typing import Any

from skill_hub.domain.harnesses.harness_usage_api import (
    PackageRef,
    ReaderBindingPolicy,
    ReaderRef,
    UsageReader,
)
from skill_hub.infrastructure.harnesses.harness_usage_package_manifest import (
    VerifiedReaderExport,
    VerifiedUsagePackage,
    verify_usage_package,
)

_PARENT_NAME = "_skill_hub_usage_packages"
_NAMESPACE_PREFIX = _PARENT_NAME + ".p_"
_ALLOWED_STDLIB_ROOTS = {
    "__future__",
    "collections",
    "dataclasses",
    "datetime",
    "hashlib",
    "json",
    "pathlib",
    "re",
    "shlex",
    "time",
    "typing",
}
_ALLOWED_SDK = "skill_hub.domain.harnesses.harness_usage_api"


class UsagePackageLoadError(ImportError):
    """A safe, typed failure while loading retained package bytes."""

    kind = "usage_package_load_failed"

    def __init__(self, reason: str, member: str | None = None) -> None:
        self.reason = reason
        self.member = member
        detail = reason if member is None else f"{reason}: {member}"
        super().__init__(detail)


@dataclass(frozen=True)
class LoadedUsagePackage:
    """Immutable handle for one ready, digest-qualified reader package."""

    ref: PackageRef
    namespace: str

    def reader(self, ref: ReaderRef) -> UsageReader:
        if type(ref) is not ReaderRef:
            raise TypeError("ref must be a ReaderRef")
        state = _state_for_handle(self)
        reader = state.readers.get(ref)
        if reader is None:
            raise UsagePackageLoadError("reader_not_exported")
        return reader


@dataclass
class _PackageState:
    package: VerifiedUsagePackage
    namespace: str
    codes: dict[str, Any]
    modules: dict[str, ModuleType]
    readers: dict[ReaderRef, Any]
    status: str = "registered"
    owner_thread: int | None = None
    failure_reason: str | None = None
    initializing_modules: set[str] = field(default_factory=set)
    pending_publication: set[str] = field(default_factory=set)
    specs: dict[str, importlib.machinery.ModuleSpec] = field(default_factory=dict)
    module_locks: dict[str, Any] = field(default_factory=dict)
    publication_threads: dict[str, int] = field(default_factory=dict)


class _UsagePackageLoader(importlib.abc.Loader):
    def __init__(self, state: _PackageState, name: str, code: Any, is_package: bool) -> None:
        self._state = state
        self._name = name
        self._code = code
        self._is_package = is_package

    def create_module(self, spec: importlib.machinery.ModuleSpec) -> ModuleType:
        module = ModuleType(spec.name)
        module_lock = getattr(_bootstrap, "_get_module_lock")(spec.name)
        with _STATE_LOCK:
            existing = self._state.modules.get(spec.name)
            if existing is not None and sys.modules.get(spec.name) is not existing:
                _fail_state_locked(self._state, "namespace_conflict")
                _cleanup_state(self._state)
                raise UsagePackageLoadError("namespace_conflict")
            self._state.modules[spec.name] = module
            self._state.specs[spec.name] = spec
            self._state.module_locks[spec.name] = module_lock
            self._state.publication_threads[spec.name] = threading.get_ident()
            self._state.initializing_modules.add(spec.name)
        return module

    def exec_module(self, module: ModuleType) -> None:
        _assert_state_running(self._state)
        filename = _synthetic_filename(self._state.package.ref.sha256, self._member_for_name(self._name))
        if self._is_package:
            module.__path__ = []  # type: ignore[attr-defined]
        module.__file__ = filename
        if self._name == self._state.namespace:
            with _STATE_LOCK:
                if self._state.owner_thread is None:
                    self._state.owner_thread = threading.get_ident()
                elif self._state.owner_thread != threading.get_ident():
                    raise UsagePackageLoadError("package_initializing")
        try:
            if self._name == self._state.namespace:
                _execute_root(self._state, module)
            else:
                exec(self._code, module.__dict__)
        except BaseException as exc:
            _fail_state(self._state)
            _cleanup_state(self._state)
            if isinstance(exc, UsagePackageLoadError):
                raise
            if isinstance(exc, Exception):
                raise UsagePackageLoadError(
                    "module_execution_failed", self._member_for_name(self._name)
                ) from exc
            raise
        with _STATE_LOCK:
            _assert_owned_state_locked(self._state)
            self._state.initializing_modules.discard(self._name)
            self._state.pending_publication.add(self._name)
        _assert_state_running(self._state)

    def _member_for_name(self, name: str) -> str:
        if name == self._state.namespace:
            return "__init__.py"
        relative = name.removeprefix(self._state.namespace + ".")
        if _is_package_name(self._state, name):
            return relative.replace(".", "/") + "/__init__.py"
        return relative.replace(".", "/") + ".py"


class _UsagePackageFinder(importlib.abc.MetaPathFinder):
    def find_spec(
        self, fullname: str, path: object | None = None, target: ModuleType | None = None
    ) -> importlib.machinery.ModuleSpec | None:
        del path, target
        if not fullname.startswith(_NAMESPACE_PREFIX):
            return None
        digest_and_descendants = fullname.removeprefix(_NAMESPACE_PREFIX)
        digest = digest_and_descendants.split(".", 1)[0]
        namespace = _NAMESPACE_PREFIX + digest
        with _STATE_LOCK:
            state = _STATES_BY_NAMESPACE.get(namespace)
            if state is None:
                raise UsagePackageLoadError("module_not_verified")
            if state.status == "failed":
                raise UsagePackageLoadError("package_failed")
            if fullname != state.namespace and not fullname.startswith(state.namespace + "."):
                raise UsagePackageLoadError("module_not_verified")
            if fullname not in state.codes and fullname != state.namespace:
                raise UsagePackageLoadError("module_not_verified")
            is_package = _is_package_name(state, fullname) or fullname == state.namespace
            code = state.codes.get(fullname)
            loader = _UsagePackageLoader(state, fullname, code, is_package)
            spec = importlib.machinery.ModuleSpec(fullname, loader, is_package=is_package)
            spec.origin = _synthetic_filename(state.package.ref.sha256, loader._member_for_name(fullname))
            if is_package:
                spec.submodule_search_locations = []
            return spec


_STATE_LOCK = threading.RLock()
_STATES_BY_REF: dict[PackageRef, _PackageState] = {}
_STATES_BY_NAMESPACE: dict[str, _PackageState] = {}
_RELEASE_DIGESTS: dict[tuple[str, str], str] = {}
_FINDER = _UsagePackageFinder()
_PARENT_MODULE: ModuleType | None = None
_MISSING = object()


def load_usage_package(expected: PackageRef, root: Path) -> LoadedUsagePackage:
    """Verify the installed package and load all declared reader entrypoints."""
    verified = verify_usage_package(expected, root)
    return _load_verified_package(verified)


def _load_verified_package(package: VerifiedUsagePackage) -> LoadedUsagePackage:
    namespace = _NAMESPACE_PREFIX + package.ref.sha256
    codes, package_names = _compile_members(package, namespace)
    with _STATE_LOCK:
        _ensure_finder_locked()
        previous = _RELEASE_DIGESTS.get((package.ref.package_id, package.ref.release))
        if previous is not None and previous != package.ref.sha256:
            raise UsagePackageLoadError("release_identity_conflict")
        existing = _STATES_BY_REF.get(package.ref)
        if existing is not None:
            _assert_owned_state_locked(existing)
            if existing.status == "failed":
                raise UsagePackageLoadError("package_failed")
            if existing.status == "initializing" and existing.owner_thread == threading.get_ident():
                raise UsagePackageLoadError("package_initializing")
            state = existing
        else:
            _ensure_parent_locked()
            state = _PackageState(
                package,
                namespace,
                codes,
                {},
                {},
                status="initializing",
            )
            _preflight_namespace_locked(state, package_names)
            _STATES_BY_REF[package.ref] = state
            _STATES_BY_NAMESPACE[namespace] = state
            _RELEASE_DIGESTS[(package.ref.package_id, package.ref.release)] = package.ref.sha256
    try:
        importlib.import_module(namespace)
    except BaseException as exc:
        if not isinstance(exc, Exception):
            _fail_state(state)
            _cleanup_state(state)
            raise
        _fail_state(state)
        _cleanup_state(state)
        if isinstance(exc, UsagePackageLoadError):
            raise
        raise UsagePackageLoadError("module_execution_failed") from exc
    with _STATE_LOCK:
        _assert_owned_state_locked(state)
        if state.status == "failed":
            raise UsagePackageLoadError("package_failed")
        if state.status != "ready":
            raise UsagePackageLoadError("module_execution_failed")
        state.owner_thread = None
        return LoadedUsagePackage(package.ref, namespace)


def _compile_members(package: VerifiedUsagePackage, namespace: str) -> tuple[dict[str, Any], set[str]]:
    member_paths = {member.path for member in package.members}
    codes: dict[str, Any] = {}
    package_names: set[str] = set()
    for export in package.readers:
        module_name, _ = export.entrypoint.split(":", 1)
        if module_name == "__init__" or module_name.endswith(".__init__"):
            raise UsagePackageLoadError("module_layout_invalid")
    for member in package.members:
        if not member.path.endswith(".py"):
            continue
        relative = member.path[:-3]
        parts = relative.split("/")
        if any(not part.isidentifier() for part in parts if part != "__init__"):
            raise UsagePackageLoadError("module_layout_invalid", member.path)
        if parts[-1] == "__init__":
            if len(parts) == 1:
                fullname = namespace
            else:
                fullname = namespace + "." + ".".join(parts[:-1])
            package_names.add(fullname)
        else:
            fullname = namespace + "." + ".".join(parts)
        if fullname in codes:
            raise UsagePackageLoadError("module_layout_invalid", member.path)
        for index in range(1, len(parts) if parts[-1] == "__init__" else len(parts)):
            parent = "/".join(parts[:index]) + "/__init__.py"
            if parent not in member_paths:
                raise UsagePackageLoadError("module_layout_invalid", member.path)
        try:
            tree = ast.parse(member.content, filename=_synthetic_filename(package.ref.sha256, member.path))
            _validate_imports(tree, fullname, namespace, member_paths)
            codes[fullname] = compile(
                member.content,
                _synthetic_filename(package.ref.sha256, member.path),
                "exec",
                dont_inherit=True,
            )
        except UsagePackageLoadError:
            raise
        except (SyntaxError, UnicodeDecodeError, ValueError, TypeError) as exc:
            raise UsagePackageLoadError("module_syntax_invalid", member.path) from exc
    return codes, package_names


def _validate_imports(tree: ast.AST, fullname: str, namespace: str, members: set[str]) -> None:
    package_module = _is_package_fullname(fullname, namespace, members)
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                _validate_absolute_import(alias.name)
        elif isinstance(node, ast.ImportFrom):
            if node.level:
                base = _resolve_relative(fullname, node.level, package_module)
                if not base.startswith(namespace):
                    raise UsagePackageLoadError("import_not_allowed")
                if base != namespace and not _mapped_name(base, namespace, members):
                    raise UsagePackageLoadError("import_not_allowed")
                if node.module:
                    target = base + "." + node.module
                    if not _mapped_name(target, namespace, members):
                        raise UsagePackageLoadError("import_not_allowed")
            elif node.module:
                _validate_absolute_import(node.module)


def _validate_absolute_import(name: str) -> None:
    root = name.split(".", 1)[0]
    if root in _ALLOWED_STDLIB_ROOTS or name == _ALLOWED_SDK:
        return
    raise UsagePackageLoadError("import_not_allowed")


def _resolve_relative(fullname: str, level: int, package_module: bool) -> str:
    package = fullname if package_module else fullname.rsplit(".", 1)[0]
    parts = package.split(".")
    if level > len(parts):
        return ""
    return ".".join(parts[: len(parts) - level + 1])


def _mapped_name(name: str, namespace: str, members: set[str]) -> bool:
    if name == namespace:
        return True
    rel = name.removeprefix(namespace + ".")
    rel_path = rel.replace(".", "/")
    module_member = rel_path + ".py"
    return (
        module_member in members and module_member.rsplit("/", 1)[-1] != "__init__.py"
    ) or rel_path + "/__init__.py" in members


def _is_package_fullname(name: str, namespace: str, members: set[str]) -> bool:
    if name == namespace:
        return True
    relative = name.removeprefix(namespace + ".")
    return relative.replace(".", "/") + "/__init__.py" in members


def _execute_root(state: _PackageState, module: ModuleType) -> None:
    root_code = state.codes.get(state.namespace)
    if root_code is not None:
        exec(root_code, module.__dict__)
    for export in state.package.readers:
        module_name, attribute = export.entrypoint.split(":", 1)
        if module_name == "__init__" or module_name.endswith(".__init__"):
            raise UsagePackageLoadError("module_layout_invalid")
        entry_name = state.namespace + "." + module_name
        entry = importlib.import_module(entry_name)
        with _STATE_LOCK:
            if state.modules.get(entry_name) is not entry:
                raise UsagePackageLoadError("namespace_conflict")
        reader = getattr(entry, attribute, None)
        _validate_reader_export(reader, export)
        state.readers[ReaderRef(export.reader_id, export.revision, export.capture_contract)] = reader
    with _STATE_LOCK:
        if state.status == "failed":
            raise UsagePackageLoadError("package_failed")
        _assert_owned_state_locked(state)
        state.status = "ready"


def _validate_reader_export(reader: Any, export: VerifiedReaderExport) -> None:
    if (
        reader is None
        or not callable(getattr(reader, "capture", None))
        or not callable(getattr(reader, "recognize_source", None))
    ):
        raise UsagePackageLoadError("reader_export_mismatch")
    expected_constants = {
        "READER_ID": (str, export.reader_id),
        "READER_REVISION": (int, export.revision),
        "CAPTURE_CONTRACT_VERSION": (int, export.capture_contract),
        "NORMALIZATION_VERSION": (int, export.normalization_version),
        "CAPTURE_PARSER_VERSION": (int, export.parser_version),
    }
    for name, (expected_type, expected_value) in expected_constants.items():
        value = getattr(reader, name, None)
        if type(value) is not expected_type or value != expected_value:
            raise UsagePackageLoadError("reader_export_mismatch")
    policy = getattr(reader, "READER_POLICY", None)
    if type(policy) is not ReaderBindingPolicy:
        raise UsagePackageLoadError("reader_export_mismatch")
    expected_policy_fields = (
        ("capture_contract_version", int, export.capture_contract),
        ("host_contract_version", int, export.host_contract_version),
        ("reader_id", str, export.reader_id),
        ("reader_revision", int, export.revision),
        ("normalization_version", int, export.normalization_version),
        ("resume_version", int, export.resume_version),
        ("capture_schema_version", int, export.capture_schema_version),
        ("adapter_digest", type(None), export.adapter_digest),
        ("parser_version", int, export.parser_version),
    )
    if any(
        type(getattr(policy, name, _MISSING)) is not expected_type
        or getattr(policy, name, _MISSING) != expected_value
        for name, expected_type, expected_value in expected_policy_fields
    ):
        raise UsagePackageLoadError("reader_export_mismatch")
    expected = {
        "HARNESS": export.harness,
        "SUPPORTED_FORMATS": export.supported_formats,
        "SUPPORTED_PRODUCER_VERSIONS": export.supported_producer_versions,
        "RECOGNITION_CONTRACT": export.recognition_contract,
        "ALLOWS_UNKNOWN_LEGACY": export.allows_unknown_legacy,
    }
    if type(getattr(reader, "HARNESS", None)) is not str or getattr(reader, "HARNESS") != expected["HARNESS"]:
        raise UsagePackageLoadError("reader_export_mismatch")
    for name in ("SUPPORTED_FORMATS", "SUPPORTED_PRODUCER_VERSIONS"):
        value = getattr(reader, name, None)
        if type(value) is not tuple or any(type(item) is not str for item in value) or value != expected[name]:
            raise UsagePackageLoadError("reader_export_mismatch")
    for name in ("RECOGNITION_CONTRACT", "ALLOWS_UNKNOWN_LEGACY"):
        value = getattr(reader, name, None)
        if type(value) is not type(expected[name]) or value != expected[name]:
            raise UsagePackageLoadError("reader_export_mismatch")


def _ensure_finder_locked() -> None:
    if _FINDER not in sys.meta_path:
        sys.meta_path.insert(0, _FINDER)


def _ensure_parent_locked() -> None:
    global _PARENT_MODULE
    existing = sys.modules.get(_PARENT_NAME)
    if existing is not None:
        if _PARENT_MODULE is None or existing is not _PARENT_MODULE:
            raise UsagePackageLoadError("namespace_conflict")
        return
    parent = ModuleType(_PARENT_NAME)
    parent.__path__ = []  # type: ignore[attr-defined]
    parent.__package__ = _PARENT_NAME
    parent.__spec__ = importlib.machinery.ModuleSpec(_PARENT_NAME, None, is_package=True)
    _PARENT_MODULE = parent
    sys.modules[_PARENT_NAME] = parent


def _preflight_namespace_locked(state: _PackageState, package_names: set[str]) -> None:
    names = set(package_names) | set(state.codes) | {state.namespace}
    names.update(
        existing_name
        for existing_name, existing_module in tuple(sys.modules.items())
        if existing_module is not None
        and (
            existing_name == state.namespace
            or existing_name.startswith(state.namespace + ".")
        )
    )
    for name in names:
        foreign = sys.modules.get(name)
        if foreign is not None:
            raise UsagePackageLoadError("namespace_conflict")
        parent_name, _, child = name.rpartition(".")
        parent = sys.modules.get(parent_name)
        if parent is not None and child in vars(parent):
            raise UsagePackageLoadError("namespace_conflict")


def _assert_synthetic_parent_locked(state: _PackageState) -> None:
    if _PARENT_MODULE is None or sys.modules.get(_PARENT_NAME) is not _PARENT_MODULE:
        _namespace_conflict_locked(state)


def _audit_namespace_locked(state: _PackageState) -> None:
    for name, module in tuple(sys.modules.items()):
        if module is None or (
            name != state.namespace and not name.startswith(state.namespace + ".")
        ):
            continue
        if state.modules.get(name) is not module:
            _namespace_conflict_locked(state)


def _namespace_conflict_locked(state: _PackageState) -> None:
    _fail_state_locked(state, "namespace_conflict")
    _cleanup_state(state)
    raise UsagePackageLoadError("namespace_conflict")


def _assert_state_running(state: _PackageState) -> None:
    with _STATE_LOCK:
        _assert_owned_state_locked(state)
        if state.status == "failed":
            raise UsagePackageLoadError("package_failed")


def _assert_owned_state_locked(state: _PackageState) -> None:
    if state.status == "failed":
        return
    _assert_synthetic_parent_locked(state)
    _audit_namespace_locked(state)
    for name, module in tuple(state.modules.items()):
        publication_in_progress = _publication_in_progress_locked(state, name)
        current = sys.modules.get(name)
        if current is not module:
            if current is None and publication_in_progress:
                continue
            _namespace_conflict_locked(state)
        spec = state.specs.get(name)
        if spec is None or module.__spec__ is not spec or module.__loader__ is not spec.loader:
            _namespace_conflict_locked(state)
        parent_name, _, child = name.rpartition(".")
        parent = sys.modules.get(parent_name)
        if parent is None:
            if publication_in_progress:
                continue
            _namespace_conflict_locked(state)
        child_value = vars(parent).get(child, _MISSING)
        if child_value is not _MISSING and child_value is not module:
            _namespace_conflict_locked(state)
        if child_value is _MISSING:
            if not publication_in_progress:
                _namespace_conflict_locked(state)
        else:
            state.initializing_modules.discard(name)
            state.pending_publication.discard(name)


def _publication_in_progress_locked(state: _PackageState, name: str) -> bool:
    if name not in state.initializing_modules and name not in state.pending_publication:
        return False
    module_lock = state.module_locks.get(name)
    return module_lock is not None and getattr(module_lock, "owner", None) == state.publication_threads.get(name)


def _state_for_handle(handle: LoadedUsagePackage) -> _PackageState:
    with _STATE_LOCK:
        _ensure_finder_locked()
        state = _STATES_BY_NAMESPACE.get(handle.namespace)
        if state is None or state.package.ref != handle.ref:
            raise UsagePackageLoadError("namespace_conflict")
        _assert_owned_state_locked(state)
        if state.status == "failed":
            raise UsagePackageLoadError("package_failed")
        if state.status != "ready":
            raise UsagePackageLoadError("package_initializing")
        return state


def _fail_state(state: _PackageState) -> None:
    with _STATE_LOCK:
        _fail_state_locked(state, "package_failed")


def _fail_state_locked(state: _PackageState, reason: str) -> None:
    if state.status != "failed":
        state.status = "failed"
        state.failure_reason = reason
        state.owner_thread = None


def _cleanup_state(state: _PackageState) -> None:
    with _STATE_LOCK:
        for name, module in tuple(state.modules.items()):
            if sys.modules.get(name) is module:
                del sys.modules[name]
            parent_name, _, child = name.rpartition(".")
            parent = sys.modules.get(parent_name)
            parent_owned = parent is not None and (
                parent is _PARENT_MODULE or state.modules.get(parent_name) is parent
            )
            if parent_owned and vars(parent).get(child, _MISSING) is module:
                del vars(parent)[child]
        state.initializing_modules.clear()
        state.pending_publication.clear()


def _is_package_name(state: _PackageState, name: str) -> bool:
    return name in {state.namespace} or name in {
        state.namespace + "." + path[:-12].replace("/", ".")
        for path in (member.path for member in state.package.members)
        if path.endswith("/__init__.py")
    }


def _synthetic_filename(digest: str, member: str) -> str:
    return f"<usage-package:{digest}/{member}>"


__all__ = [
    "LoadedUsagePackage",
    "UsagePackageLoadError",
    "load_usage_package",
]
