from __future__ import annotations

import hashlib
import importlib.abc
import importlib.machinery
import json
import multiprocessing
import pickle
import sys
import threading
from pathlib import Path
from types import ModuleType

import pytest

from skill_hub.domain.harnesses.harness_usage_api import PackageRef, ReaderRef, SourceRecognition
from skill_hub.infrastructure.harnesses import harness_usage_package_loader as loader
from skill_hub.infrastructure.harnesses.harness_usage_package_manifest import (
    UsagePackageVerificationError,
    verify_usage_package,
)

_DIGEST_DOMAIN = b"skill-hub.usage-reader-package.v1\0"


def _send_unpickled_type(connection, payload: bytes) -> None:
    value = pickle.loads(payload)
    connection.send((type(value).__module__, type(value).__name__))
    connection.close()


def _reader(*, entrypoint: str = "pkg.reader:READER") -> dict[str, object]:
    return {
        "reader_id": "fixture_reader",
        "revision": 1,
        "capture_contract": 1,
        "normalization_version": 1,
        "parser_version": 1,
        "host_contract_version": 1,
        "resume_version": 1,
        "capture_schema_version": 1,
        "adapter_digest": None,
        "harness": "codex",
        "entrypoint": entrypoint,
        "supported_formats": ["fixture-jsonl"],
        "supported_producer_versions": [],
        "recognition_contract": "source_probe_v1_allow_unversioned",
        "allows_unknown_legacy": True,
        "metadata_contract": None,
        "metadata_entrypoint": None,
    }


def _reader_source(*, helper: str = "", post: str = "", dynamic_helper: bool = False) -> bytes:
    helper_import = "" if dynamic_helper else "from .helper import VALUE\n"
    capture = (
        "    def capture(self, *args, **kwargs):\n"
        "        from .helper import VALUE\n"
        "        return VALUE\n"
        if dynamic_helper
        else "    capture = lambda self, *args, **kwargs: VALUE\n"
    )
    return "".join(
        [
            "from skill_hub.domain.harnesses.harness_usage_api import ReaderBindingPolicy\n",
            "from skill_hub.domain.harnesses.harness_usage_api import SourceRecognition\n",
            helper_import,
            "READER_ID = 'fixture_reader'\n",
            "READER_REVISION = 1\n",
            "CAPTURE_CONTRACT_VERSION = 1\n",
            "NORMALIZATION_VERSION = 1\n",
            "CAPTURE_PARSER_VERSION = 1\n",
            "READER_POLICY = ReaderBindingPolicy(1, 1, READER_ID, READER_REVISION, 1, 1, 1, None, 1)\n",
            helper,
            "HARNESS = 'codex'\n",
            "SUPPORTED_FORMATS = ('fixture-jsonl',)\n",
            "SUPPORTED_PRODUCER_VERSIONS = ()\n",
            "RECOGNITION_CONTRACT = 'source_probe_v1_allow_unversioned'\n",
            "ALLOWS_UNKNOWN_LEGACY = True\n",
            "class _Reader:\n",
            "    READER_ID = READER_ID\n",
            "    READER_REVISION = READER_REVISION\n",
            "    CAPTURE_CONTRACT_VERSION = CAPTURE_CONTRACT_VERSION\n",
            "    NORMALIZATION_VERSION = NORMALIZATION_VERSION\n",
            "    CAPTURE_PARSER_VERSION = CAPTURE_PARSER_VERSION\n",
            "    READER_POLICY = READER_POLICY\n",
            "    HARNESS = HARNESS\n",
            "    SUPPORTED_FORMATS = SUPPORTED_FORMATS\n",
            "    SUPPORTED_PRODUCER_VERSIONS = SUPPORTED_PRODUCER_VERSIONS\n",
            "    RECOGNITION_CONTRACT = RECOGNITION_CONTRACT\n",
            "    ALLOWS_UNKNOWN_LEGACY = ALLOWS_UNKNOWN_LEGACY\n",
            capture,
            "    recognize_source = lambda self, probe: SourceRecognition(reason='fixture')\n",
            "READER = _Reader()\n",
            post,
        ]
    ).encode()


def _write_package(
    root: Path,
    *,
    package_id: str,
    release: str = "1",
    files: dict[str, bytes] | None = None,
    readers: list[dict[str, object]] | None = None,
) -> PackageRef:
    members = files or {
        "__init__.py": b"ROOT_VALUE = 'retained-root'\n",
        "pkg/__init__.py": b"PACKAGE_VALUE = 1\n",
        "pkg/helper.py": b"VALUE = 41\n",
        "pkg/reader.py": _reader_source(),
    }
    for relative, content in members.items():
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
    entries = [
        {"path": path, "length": len(content), "sha256": hashlib.sha256(content).hexdigest()}
        for path, content in sorted(members.items())
    ]
    without_digest = {
        "manifest_schema": 1,
        "package_id": package_id,
        "release": release,
        "sdk": {"api": "usage-reader", "min_version": 1, "max_version": 1},
        "requirements": ["operation_summary_v1"],
        "readers": readers or [_reader()],
        "files": entries,
    }
    canonical = json.dumps(
        without_digest,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
    ).encode()
    digest = hashlib.sha256(_DIGEST_DOMAIN + canonical).hexdigest()
    manifest = dict(without_digest, sha256=digest)
    (root / "reader-package.json").write_text(json.dumps(manifest), encoding="utf-8")
    return PackageRef(package_id, release, digest)


def test_loads_verified_bytes_and_returns_exact_export(tmp_path: Path) -> None:
    expected = _write_package(tmp_path, package_id="loader-basic")

    package = loader.load_usage_package(expected, tmp_path)
    reader = package.reader(ReaderRef("fixture_reader", 1, 1))

    assert package.ref == expected
    assert package.namespace.endswith(expected.sha256)
    assert reader.READER_ID == "fixture_reader"
    assert reader.capture(None, None, None) == 41
    assert "usage-package:" in reader.__class__.__module__ or reader.__class__.__module__.startswith(
        "_skill_hub_usage_packages."
    )


def test_root_initializer_and_nested_packages_execute_from_synthetic_namespace(tmp_path: Path) -> None:
    expected = _write_package(tmp_path, package_id="loader-root")

    package = loader.load_usage_package(expected, tmp_path)
    root = __import__(package.namespace, fromlist=["*"])
    reader_module = __import__(package.namespace + ".pkg.reader", fromlist=["*"])

    assert root.ROOT_VALUE == "retained-root"
    assert reader_module.__file__.startswith("<usage-package:")
    assert reader_module.__spec__.origin.startswith("<usage-package:")
    assert reader_module.__path__ if hasattr(reader_module, "__path__") else True


def test_late_import_uses_retained_bytes_after_verified_files_are_removed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    files = {
        "__init__.py": b"ROOT_VALUE = 'retained-root'\n",
        "pkg/__init__.py": b"PACKAGE_VALUE = 1\n",
        "pkg/helper.py": b"VALUE = 41\n",
        "pkg/reader.py": _reader_source(dynamic_helper=True),
    }
    expected = _write_package(tmp_path, package_id="loader-retained", files=files)
    verified = verify_usage_package(expected, tmp_path)
    monkeypatch.setattr(loader, "verify_usage_package", lambda ref, root: verified)
    for path in tmp_path.iterdir():
        if path.name != "reader-package.json":
            if path.is_dir():
                for child in path.rglob("*"):
                    if child.is_file():
                        child.unlink()
                path.rmdir()
            else:
                path.unlink()

    package = loader.load_usage_package(expected, tmp_path)
    assert package.reader(ReaderRef("fixture_reader", 1, 1)).capture(None, None, None) == 41


def test_public_entry_reverification_does_not_trust_ready_cache(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    expected = _write_package(tmp_path, package_id="loader-reverify")
    loader.load_usage_package(expected, tmp_path)

    def unavailable(ref: PackageRef, root: Path):
        raise UsagePackageVerificationError("package_unavailable")

    monkeypatch.setattr(loader, "verify_usage_package", unavailable)
    with pytest.raises(UsagePackageVerificationError, match="package_unavailable"):
        loader.load_usage_package(expected, tmp_path)


def test_disallowed_absolute_import_rejects_before_any_package_code_executes(tmp_path: Path) -> None:
    files = {
        "pkg/__init__.py": b"SENTINEL = True\n",
        "pkg/helper.py": b"VALUE = 41\n",
        "pkg/reader.py": _reader_source(
            helper="import skill_hub.domain.usage.usage_inspection_capture\n"
        ),
    }
    expected = _write_package(tmp_path, package_id="loader-import", files=files)

    with pytest.raises(loader.UsagePackageLoadError) as exc:
        loader.load_usage_package(expected, tmp_path)
    assert exc.value.reason == "import_not_allowed"
    assert not any(name.endswith(expected.sha256) for name in __import__("sys").modules)


def test_reader_export_mismatch_poison_rejects_retry(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    files = {
        "pkg/__init__.py": b"VALUE = 1\n",
        "pkg/helper.py": b"VALUE = 41\n",
        "pkg/reader.py": _reader_source(helper="READER_POLICY = None\n"),
    }
    expected = _write_package(tmp_path, package_id="loader-poison", files=files)

    with pytest.raises(loader.UsagePackageLoadError, match="reader_export_mismatch"):
        loader.load_usage_package(expected, tmp_path)
    with pytest.raises(loader.UsagePackageLoadError) as retry:
        loader.load_usage_package(expected, tmp_path)
    assert retry.value.reason == "package_failed"


def test_unknown_reader_ref_is_closed_set_error(tmp_path: Path) -> None:
    expected = _write_package(tmp_path, package_id="loader-reader-ref")
    package = loader.load_usage_package(expected, tmp_path)

    with pytest.raises(loader.UsagePackageLoadError, match="reader_not_exported"):
        package.reader(ReaderRef("other_reader", 1, 1))


def test_two_releases_keep_distinct_digest_namespaces(tmp_path: Path) -> None:
    first_root = tmp_path / "first"
    second_root = tmp_path / "second"
    first_root.mkdir()
    second_root.mkdir()
    first = _write_package(first_root, package_id="loader-releases", release="1")
    second = _write_package(second_root, package_id="loader-releases", release="2")

    loaded_first = loader.load_usage_package(first, first_root)
    loaded_second = loader.load_usage_package(second, second_root)

    assert loaded_first.namespace != loaded_second.namespace
    assert loaded_first.reader(ReaderRef("fixture_reader", 1, 1)) is not loaded_second.reader(
        ReaderRef("fixture_reader", 1, 1)
    )


def test_sdk_record_pickle_round_trip_in_spawn_preserves_canonical_identity(tmp_path: Path) -> None:
    expected = _write_package(tmp_path, package_id="loader-spawn")
    reader = loader.load_usage_package(expected, tmp_path).reader(ReaderRef("fixture_reader", 1, 1))
    record = reader.recognize_source(None)
    assert type(record) is SourceRecognition
    payload = pickle.dumps(record)

    context = multiprocessing.get_context("spawn")
    receive, send = context.Pipe(duplex=False)
    process = context.Process(target=_send_unpickled_type, args=(send, payload))
    process.start()
    send.close()
    process.join(timeout=10)
    assert process.exitcode == 0
    assert receive.recv() == (SourceRecognition.__module__, "SourceRecognition")


def test_concurrent_loaders_share_one_ready_handle_and_reader(tmp_path: Path) -> None:
    expected = _write_package(tmp_path, package_id="loader-concurrent")
    barrier = threading.Barrier(2)
    outcomes: list[object] = [None, None]

    def load(index: int) -> None:
        barrier.wait()
        outcomes[index] = loader.load_usage_package(expected, tmp_path)

    threads = [threading.Thread(target=load, args=(index,)) for index in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=10)

    assert all(not thread.is_alive() for thread in threads)
    first, second = outcomes
    assert isinstance(first, loader.LoadedUsagePackage)
    assert isinstance(second, loader.LoadedUsagePackage)
    assert first.namespace == second.namespace
    ref = ReaderRef("fixture_reader", 1, 1)
    assert first.reader(ref) is second.reader(ref)


def test_same_thread_reentrant_load_cannot_observe_partial_package(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    expected = _write_package(tmp_path, package_id="loader-reentrant")
    original_execute_root = loader._execute_root
    observed: list[str] = []

    def reentrant(state, module) -> None:
        with pytest.raises(loader.UsagePackageLoadError) as exc:
            loader.load_usage_package(expected, tmp_path)
        observed.append(exc.value.reason)
        original_execute_root(state, module)

    monkeypatch.setattr(loader, "_execute_root", reentrant)
    loader.load_usage_package(expected, tmp_path)

    assert observed == ["package_initializing"]


def test_foreign_parent_module_is_never_replaced(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    expected = _write_package(tmp_path, package_id="loader-foreign-parent")
    foreign = ModuleType(loader._PARENT_NAME)
    monkeypatch.setitem(sys.modules, loader._PARENT_NAME, foreign)

    with pytest.raises(loader.UsagePackageLoadError, match="namespace_conflict"):
        loader.load_usage_package(expected, tmp_path)
    assert sys.modules[loader._PARENT_NAME] is foreign


def test_foreign_digest_and_descendant_entries_are_preserved(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    expected = _write_package(tmp_path, package_id="loader-foreign-descendant")
    namespace = loader._NAMESPACE_PREFIX + expected.sha256
    foreign_root = ModuleType(namespace)
    monkeypatch.setitem(sys.modules, namespace, foreign_root)
    with pytest.raises(loader.UsagePackageLoadError, match="namespace_conflict"):
        loader.load_usage_package(expected, tmp_path)
    assert sys.modules[namespace] is foreign_root

    monkeypatch.delitem(sys.modules, namespace)
    foreign_descendant = ModuleType(namespace + ".pkg.reader")
    monkeypatch.setitem(sys.modules, namespace + ".pkg.reader", foreign_descendant)
    with pytest.raises(loader.UsagePackageLoadError, match="namespace_conflict"):
        loader.load_usage_package(expected, tmp_path)
    assert sys.modules[namespace + ".pkg.reader"] is foreign_descendant

    monkeypatch.delitem(sys.modules, namespace + ".pkg.reader")
    foreign_unlisted = ModuleType(namespace + ".pkg.unlisted")
    monkeypatch.setitem(sys.modules, namespace + ".pkg.unlisted", foreign_unlisted)
    with pytest.raises(loader.UsagePackageLoadError, match="namespace_conflict"):
        loader.load_usage_package(expected, tmp_path)
    assert sys.modules[namespace + ".pkg.unlisted"] is foreign_unlisted


def test_earlier_foreign_finder_entrypoint_is_rejected_and_preserved(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    expected = _write_package(tmp_path, package_id="loader-earlier-finder")
    namespace = loader._NAMESPACE_PREFIX + expected.sha256
    foreign_name = namespace + ".pkg.reader"
    foreign = ModuleType(foreign_name)
    source = _reader_source(dynamic_helper=True).decode()
    exec(compile(source, "<foreign-reader>", "exec"), foreign.__dict__)

    class ForeignLoader(importlib.abc.Loader):
        def create_module(self, spec: importlib.machinery.ModuleSpec) -> ModuleType:
            del spec
            return foreign

        def exec_module(self, module: ModuleType) -> None:
            del module

    class ForeignFinder(importlib.abc.MetaPathFinder):
        def find_spec(self, fullname: str, path=None, target=None):
            del path, target
            if fullname == foreign_name:
                return importlib.machinery.ModuleSpec(fullname, ForeignLoader())
            return None

    finder = ForeignFinder()
    monkeypatch.setattr(sys, "meta_path", [finder, *sys.meta_path])
    with pytest.raises(loader.UsagePackageLoadError, match="namespace_conflict"):
        loader.load_usage_package(expected, tmp_path)
    assert sys.modules.get(foreign_name) is foreign


def test_nested_late_imports_use_retained_bytes(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    reader_source = _reader_source(dynamic_helper=True)
    reader_source = reader_source.replace(b"from .helper import VALUE", b"from .helper_a import VALUE_A")
    reader_source = reader_source.replace(b"return VALUE", b"return VALUE_A")
    files = {
        "__init__.py": b"ROOT_VALUE = 'retained-root'\n",
        "pkg/__init__.py": b"PACKAGE_VALUE = 1\n",
        "pkg/helper_a.py": b"from .helper_b import VALUE_B\nVALUE_A = VALUE_B\n",
        "pkg/helper_b.py": b"VALUE_B = 41\n",
        "pkg/reader.py": reader_source,
    }
    expected = _write_package(tmp_path, package_id="loader-nested-late", files=files)
    verified = verify_usage_package(expected, tmp_path)
    monkeypatch.setattr(loader, "verify_usage_package", lambda ref, root: verified)
    for path in tuple(tmp_path.iterdir()):
        if path.name == "reader-package.json":
            continue
        if path.is_dir():
            for child in path.rglob("*"):
                if child.is_file():
                    child.unlink()
            path.rmdir()
        else:
            path.unlink()

    package = loader.load_usage_package(expected, tmp_path)
    assert package.reader(ReaderRef("fixture_reader", 1, 1)).capture(None, None, None) == 41


def test_handle_rejects_removed_late_helper_registrations(tmp_path: Path) -> None:
    files = {
        "pkg/__init__.py": b"PACKAGE_VALUE = 1\n",
        "pkg/helper.py": b"VALUE = 41\n",
        "pkg/reader.py": _reader_source(dynamic_helper=True),
    }
    expected = _write_package(tmp_path, package_id="loader-removed-helper-handle", files=files)
    package = loader.load_usage_package(expected, tmp_path)
    ref = ReaderRef("fixture_reader", 1, 1)
    reader = package.reader(ref)
    assert reader.capture(None, None, None) == 41

    helper_name = package.namespace + ".pkg.helper"
    helper_parent = sys.modules[package.namespace + ".pkg"]
    helper = sys.modules.pop(helper_name)
    assert vars(helper_parent).pop("helper") is helper

    with pytest.raises(loader.UsagePackageLoadError, match="namespace_conflict"):
        package.reader(ref)
    assert not any(name.startswith(package.namespace) for name in sys.modules)


def test_cached_load_rejects_removed_late_helper_registrations(tmp_path: Path) -> None:
    files = {
        "pkg/__init__.py": b"PACKAGE_VALUE = 1\n",
        "pkg/helper.py": b"VALUE = 41\n",
        "pkg/reader.py": _reader_source(dynamic_helper=True),
    }
    expected = _write_package(tmp_path, package_id="loader-removed-helper-cache", files=files)
    package = loader.load_usage_package(expected, tmp_path)
    reader = package.reader(ReaderRef("fixture_reader", 1, 1))
    assert reader.capture(None, None, None) == 41

    helper_name = package.namespace + ".pkg.helper"
    helper_parent = sys.modules[package.namespace + ".pkg"]
    helper = sys.modules.pop(helper_name)
    assert vars(helper_parent).pop("helper") is helper

    with pytest.raises(loader.UsagePackageLoadError, match="namespace_conflict"):
        loader.load_usage_package(expected, tmp_path)
    assert not any(name.startswith(package.namespace) for name in sys.modules)


def test_handle_and_cached_load_survive_concurrent_late_module_initialization(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    reader_source = _reader_source(dynamic_helper=True)
    reader_source = reader_source.replace(b"from .helper import VALUE", b"from .helper_a import VALUE_A")
    reader_source = reader_source.replace(b"return VALUE", b"return VALUE_A")
    files = {
        "__init__.py": b"ROOT_VALUE = 'retained-root'\n",
        "pkg/__init__.py": b"PACKAGE_VALUE = 1\n",
        "pkg/helper_a.py": b"from .helper_b import VALUE_B\nVALUE_A = VALUE_B\n",
        "pkg/helper_b.py": b"VALUE_B = 41\n",
        "pkg/reader.py": reader_source,
    }
    expected = _write_package(tmp_path, package_id="loader-concurrent-late", files=files)
    package = loader.load_usage_package(expected, tmp_path)
    ref = ReaderRef("fixture_reader", 1, 1)
    reader = package.reader(ref)
    helper_name = package.namespace + ".pkg.helper_a"
    entered = threading.Event()
    release = threading.Event()
    original_exec_module = loader._UsagePackageLoader.exec_module
    outcomes: list[int] = []
    errors: list[BaseException] = []
    handle_error: BaseException | None = None
    cached_error: BaseException | None = None
    cached_package: loader.LoadedUsagePackage | None = None

    def paused_exec_module(loader_instance, module) -> None:
        if loader_instance._name == helper_name:
            entered.set()
            release.wait(5)
        original_exec_module(loader_instance, module)

    def capture() -> None:
        try:
            outcomes.append(reader.capture(None, None, None))
        except BaseException as exc:
            errors.append(exc)

    monkeypatch.setattr(loader._UsagePackageLoader, "exec_module", paused_exec_module)
    thread = threading.Thread(target=capture)
    thread.start()
    try:
        if not entered.wait(5):
            pytest.fail("late helper did not begin initialization")
        try:
            assert package.reader(ref) is reader
        except BaseException as exc:
            handle_error = exc
        try:
            cached_package = loader.load_usage_package(expected, tmp_path)
        except BaseException as exc:
            cached_error = exc
    finally:
        release.set()
        thread.join(timeout=5)
    assert not thread.is_alive()
    assert handle_error is None
    assert cached_error is None
    assert cached_package is not None
    assert outcomes == [41]
    assert errors == []


def test_earlier_foreign_finder_helper_is_rejected_and_cleaned(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    warmup_root = tmp_path / "warmup"
    warmup_root.mkdir()
    warmup = _write_package(warmup_root, package_id="loader-earlier-helper-warmup")
    loader.load_usage_package(warmup, warmup_root)

    target_root = tmp_path / "target"
    target_root.mkdir()
    files = {
        "__init__.py": b"ROOT_VALUE = 'retained-root'\n",
        "pkg/__init__.py": b"PACKAGE_VALUE = 1\n",
        "pkg/helper.py": b"VALUE = 41\n",
        "pkg/reader.py": _reader_source(),
    }
    expected = _write_package(target_root, package_id="loader-earlier-helper", files=files)
    helper_name = loader._NAMESPACE_PREFIX + expected.sha256 + ".pkg.helper"
    foreign = ModuleType(helper_name)
    foreign.VALUE = 99

    class ForeignLoader(importlib.abc.Loader):
        def create_module(self, spec: importlib.machinery.ModuleSpec) -> ModuleType:
            del spec
            return foreign

        def exec_module(self, module: ModuleType) -> None:
            del module

    class ForeignFinder(importlib.abc.MetaPathFinder):
        def find_spec(self, fullname: str, path=None, target=None):
            del path, target
            if fullname == helper_name:
                return importlib.machinery.ModuleSpec(fullname, ForeignLoader())
            return None

    monkeypatch.setattr(sys, "meta_path", [ForeignFinder(), *sys.meta_path])
    with pytest.raises(loader.UsagePackageLoadError, match="namespace_conflict"):
        loader.load_usage_package(expected, target_root)
    assert sys.modules.get(helper_name) is foreign
    assert not any(
        name.startswith(loader._NAMESPACE_PREFIX + expected.sha256) and name != helper_name
        for name in sys.modules
    )


@pytest.mark.parametrize("replacement", [False, True], ids=["missing", "replaced"])
@pytest.mark.parametrize("access_mode", ["handle", "cached_load"], ids=["handle", "cached-load"])
def test_synthetic_parent_is_required_for_handle_and_cached_load(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    replacement: bool,
    access_mode: str,
) -> None:
    expected = _write_package(
        tmp_path,
        package_id=(
            "loader-synthetic-parent-"
            + ("replacement" if replacement else "missing")
            + "-"
            + access_mode
        ),
    )
    package = loader.load_usage_package(expected, tmp_path)
    parent_name = loader._PARENT_NAME
    owned_root = sys.modules[package.namespace]
    foreign = ModuleType(parent_name)
    if replacement:
        setattr(foreign, "p_" + expected.sha256, owned_root)
        monkeypatch.setitem(sys.modules, parent_name, foreign)
    else:
        monkeypatch.delitem(sys.modules, parent_name)
    assert sys.modules.get(package.namespace) is not None
    if access_mode == "handle":
        with pytest.raises(loader.UsagePackageLoadError, match="namespace_conflict"):
            package.reader(ReaderRef("fixture_reader", 1, 1))
    else:
        with pytest.raises(loader.UsagePackageLoadError, match="namespace_conflict"):
            loader.load_usage_package(expected, tmp_path)
    if replacement:
        assert sys.modules[parent_name] is foreign
        assert getattr(foreign, "p_" + expected.sha256) is owned_root
    else:
        assert not any(name.startswith(package.namespace) for name in sys.modules)


def test_executor_thread_owns_registered_root_for_reentrant_load(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    expected = _write_package(tmp_path, package_id="loader-executor-thread")
    namespace = loader._NAMESPACE_PREFIX + expected.sha256
    registered = threading.Event()
    executing = threading.Event()
    release_registering = threading.Event()
    import_lock = threading.Lock()
    first_root_import = True
    original_import = loader.importlib.import_module
    original_execute_root = loader._execute_root
    observed: list[str] = []
    outcomes: list[object] = [None, None]
    errors: list[BaseException] = []

    def import_proxy(name: str):
        nonlocal first_root_import
        if name == namespace:
            with import_lock:
                is_first = first_root_import
                first_root_import = False
            if is_first:
                registered.set()
                assert release_registering.wait(10)
        return original_import(name)

    def execute_root(state, module) -> None:
        executing.set()
        with pytest.raises(loader.UsagePackageLoadError) as exc:
            loader.load_usage_package(expected, tmp_path)
        observed.append(exc.value.reason)
        original_execute_root(state, module)

    monkeypatch.setattr(loader.importlib, "import_module", import_proxy)
    monkeypatch.setattr(loader, "_execute_root", execute_root)

    def load(index: int) -> None:
        try:
            outcomes[index] = loader.load_usage_package(expected, tmp_path)
        except BaseException as exc:
            errors.append(exc)

    registering_thread = threading.Thread(target=load, args=(0,))
    registering_thread.start()
    assert registered.wait(10)
    executing_thread = threading.Thread(target=load, args=(1,))
    executing_thread.start()
    assert executing.wait(10)
    release_registering.set()
    registering_thread.join(timeout=10)
    executing_thread.join(timeout=10)

    assert errors == []
    assert observed == ["package_initializing"]
    assert all(isinstance(outcome, loader.LoadedUsagePackage) for outcome in outcomes)


def test_foreign_parent_attribute_is_preserved_and_owned_modules_are_cleaned(tmp_path: Path) -> None:
    expected = _write_package(tmp_path, package_id="loader-foreign-attribute")
    namespace = loader._NAMESPACE_PREFIX + expected.sha256
    parent = sys.modules.get(loader._PARENT_NAME)
    if parent is None:
        bootstrap_root = tmp_path / "bootstrap"
        bootstrap_root.mkdir()
        bootstrap = _write_package(bootstrap_root, package_id="loader-foreign-attribute-bootstrap")
        loader.load_usage_package(bootstrap, bootstrap_root)
        parent = sys.modules[loader._PARENT_NAME]
    assert parent is not None
    foreign = ModuleType(namespace)
    setattr(parent, "p_" + expected.sha256, foreign)
    try:
        with pytest.raises(loader.UsagePackageLoadError, match="namespace_conflict"):
            loader.load_usage_package(expected, tmp_path)
        assert getattr(parent, "p_" + expected.sha256) is foreign
    finally:
        delattr(parent, "p_" + expected.sha256)


def test_replaced_owned_module_cleans_only_owned_objects(tmp_path: Path) -> None:
    expected = _write_package(tmp_path, package_id="loader-replaced-module")
    package = loader.load_usage_package(expected, tmp_path)
    module_name = package.namespace + ".pkg.reader"
    parent = sys.modules[package.namespace + ".pkg"]
    foreign = ModuleType(module_name)
    sys.modules[module_name] = foreign
    parent.reader = foreign
    try:
        with pytest.raises(loader.UsagePackageLoadError, match="namespace_conflict"):
            package.reader(ReaderRef("fixture_reader", 1, 1))
        assert sys.modules[module_name] is foreign
        assert parent.reader is foreign
        assert package.namespace not in sys.modules
    finally:
        sys.modules.pop(module_name, None)


def test_initialization_base_exception_is_rethrown_and_poisoned(tmp_path: Path) -> None:
    files = {
        "pkg/__init__.py": b"raise KeyboardInterrupt('fixture stop')\n",
        "pkg/helper.py": b"VALUE = 41\n",
        "pkg/reader.py": _reader_source(),
    }
    expected = _write_package(tmp_path, package_id="loader-base-exception", files=files)
    namespace = loader._NAMESPACE_PREFIX + expected.sha256

    with pytest.raises(KeyboardInterrupt, match="fixture stop"):
        loader.load_usage_package(expected, tmp_path)
    assert namespace not in sys.modules
    with pytest.raises(loader.UsagePackageLoadError, match="package_failed"):
        loader.load_usage_package(expected, tmp_path)


def test_late_helper_failure_poisoning_cleans_owned_namespace(tmp_path: Path) -> None:
    files = {
        "pkg/__init__.py": b"VALUE = 1\n",
        "pkg/helper.py": b"raise RuntimeError('late helper failure')\n",
        "pkg/reader.py": _reader_source(dynamic_helper=True),
    }
    expected = _write_package(tmp_path, package_id="loader-late-failure", files=files)
    package = loader.load_usage_package(expected, tmp_path)

    with pytest.raises(loader.UsagePackageLoadError) as failure:
        package.reader(ReaderRef("fixture_reader", 1, 1)).capture(None, None, None)
    assert failure.value.reason == "module_execution_failed"
    assert "late helper failure" not in str(failure.value)
    with pytest.raises(loader.UsagePackageLoadError, match="package_failed"):
        package.reader(ReaderRef("fixture_reader", 1, 1))
    assert not any(name.startswith(package.namespace) for name in sys.modules)


def test_unused_helper_is_statically_validated_before_execution(tmp_path: Path) -> None:
    files = {
        "pkg/__init__.py": b"SENTINEL = True\n",
        "pkg/helper.py": b"VALUE = 41\n",
        "pkg/unused.py": b"import skill_hub.domain.usage.usage_inspection_capture\n",
        "pkg/reader.py": _reader_source(),
    }
    expected = _write_package(tmp_path, package_id="loader-unused-helper", files=files)

    with pytest.raises(loader.UsagePackageLoadError, match="import_not_allowed"):
        loader.load_usage_package(expected, tmp_path)
    namespace = loader._NAMESPACE_PREFIX + expected.sha256
    assert not any(name.startswith(namespace) for name in sys.modules)


def test_unused_helper_cannot_import_root_initializer_alias(tmp_path: Path) -> None:
    files = {
        "__init__.py": b"raise RuntimeError('root initializer executed')\n",
        "pkg/__init__.py": b"PACKAGE_VALUE = 1\n",
        "pkg/helper.py": b"VALUE = 41\n",
        "pkg/unused.py": b"from ..__init__ import ROOT_VALUE\n",
        "pkg/reader.py": _reader_source(),
    }
    expected = _write_package(tmp_path, package_id="loader-root-alias-import", files=files)

    with pytest.raises(loader.UsagePackageLoadError) as failure:
        loader.load_usage_package(expected, tmp_path)
    assert failure.value.reason == "import_not_allowed"
    namespace = loader._NAMESPACE_PREFIX + expected.sha256
    assert not any(name.startswith(namespace) for name in sys.modules)


def test_unused_helper_cannot_import_nested_initializer_alias(tmp_path: Path) -> None:
    files = {
        "__init__.py": b"ROOT_VALUE = 1\n",
        "pkg/__init__.py": b"raise RuntimeError('nested initializer alias executed')\n",
        "pkg/helper.py": b"VALUE = 41\n",
        "pkg/sub/__init__.py": b"SUBPACKAGE_VALUE = 1\n",
        "pkg/sub/unused.py": b"from ..__init__ import PACKAGE_VALUE\n",
        "pkg/reader.py": _reader_source(),
    }
    expected = _write_package(tmp_path, package_id="loader-nested-alias-import", files=files)

    with pytest.raises(loader.UsagePackageLoadError) as failure:
        loader.load_usage_package(expected, tmp_path)
    assert failure.value.reason == "import_not_allowed"
    namespace = loader._NAMESPACE_PREFIX + expected.sha256
    assert not any(name.startswith(namespace) for name in sys.modules)


def test_relative_imports_use_package_context_and_escape_is_rejected(tmp_path: Path) -> None:
    files = {
        "__init__.py": b"ROOT_VALUE = 1\n",
        "pkg/__init__.py": b"from .helper import VALUE\nPACKAGE_VALUE = VALUE\n",
        "pkg/helper.py": b"VALUE = 41\n",
        "pkg/reader.py": _reader_source(),
    }
    expected = _write_package(tmp_path, package_id="loader-relative-package", files=files)
    package = loader.load_usage_package(expected, tmp_path)
    assert package.reader(ReaderRef("fixture_reader", 1, 1)).capture(None, None, None) == 41

    escape_root = tmp_path / "escape"
    escape_root.mkdir()
    escape_files = dict(files)
    escape_files["pkg/reader.py"] = _reader_source(helper="from ...outside import VALUE\n")
    escape = _write_package(escape_root, package_id="loader-relative-escape", files=escape_files)
    with pytest.raises(loader.UsagePackageLoadError, match="import_not_allowed"):
        loader.load_usage_package(escape, escape_root)


def test_root_initializer_alias_and_syntax_errors_are_rejected_before_execution(tmp_path: Path) -> None:
    alias_files = {
        "__init__.py": b"SENTINEL = True\n",
    }
    alias = _write_package(
        tmp_path / "alias",
        package_id="loader-root-alias",
        files=alias_files,
        readers=[_reader(entrypoint="__init__:READER")],
    )
    alias_namespace = loader._NAMESPACE_PREFIX + alias.sha256
    with pytest.raises(loader.UsagePackageLoadError, match="module_layout_invalid"):
        loader.load_usage_package(alias, tmp_path / "alias")
    assert alias_namespace not in sys.modules

    syntax_root = tmp_path / "syntax"
    syntax_root.mkdir()
    syntax_files = {
        "pkg/__init__.py": b"VALUE = 1\n",
        "pkg/helper.py": b"VALUE = 41\n",
        "pkg/reader.py": b"def broken(:\n    pass\n",
    }
    syntax = _write_package(syntax_root, package_id="loader-syntax", files=syntax_files)
    with pytest.raises(loader.UsagePackageLoadError, match="module_syntax_invalid"):
        loader.load_usage_package(syntax, syntax_root)


@pytest.mark.parametrize(
    "post",
    [
        "READER.READER_ID = 'wrong'\n",
        "READER.READER_REVISION = True\n",
        "READER.CAPTURE_CONTRACT_VERSION = 2\n",
        "READER.NORMALIZATION_VERSION = 2\n",
        "READER.CAPTURE_PARSER_VERSION = 2\n",
        "READER.READER_POLICY = None\n",
        "READER.READER_POLICY = ReaderBindingPolicy(True, 1, READER_ID, READER_REVISION, 1, 1, 1, None, 1)\n",
        "READER.READER_POLICY = ReaderBindingPolicy(1, 1.0, READER_ID, READER_REVISION, 1, 1, 1, None, 1)\n",
        "READER.HARNESS = 'claude-code'\n",
        "READER.SUPPORTED_FORMATS = ['fixture-jsonl']\n",
        "READER.SUPPORTED_PRODUCER_VERSIONS = ('v1',)\n",
        "READER.RECOGNITION_CONTRACT = 'source_probe_v1'\n",
        "READER.ALLOWS_UNKNOWN_LEGACY = 1\n",
        "READER.capture = None\n",
        "READER.recognize_source = None\n",
    ],
)
def test_strict_reader_export_validation_rejects_each_mismatch(tmp_path: Path, post: str) -> None:
    files = {
        "pkg/__init__.py": b"VALUE = 1\n",
        "pkg/helper.py": b"VALUE = 41\n",
        "pkg/reader.py": _reader_source(post=post),
    }
    expected = _write_package(tmp_path, package_id="loader-export-" + str(abs(hash(post))), files=files)

    with pytest.raises(loader.UsagePackageLoadError, match="reader_export_mismatch"):
        loader.load_usage_package(expected, tmp_path)
