from __future__ import annotations

import hashlib
import json
import os
import stat
from pathlib import Path
from types import SimpleNamespace

import pytest

from skill_hub.domain.harnesses.harness_usage_api import PackageRef, ReaderArtifactRef, ReaderRef
from skill_hub.infrastructure.harnesses.harness_usage_package_manifest import (
    UsagePackageVerificationError,
    verify_usage_package,
)

_DIGEST_DOMAIN = b"skill-hub.usage-reader-package.v1\0"
_MANIFEST_BYTES_LIMIT = 262_144
_MAX_MEMBER_COUNT = 1_024
_MAX_MEMBER_BYTES = 4 * 1024 * 1024
_MAX_TOTAL_MEMBER_BYTES = 16 * 1024 * 1024
_MAX_DIRECTORY_DEPTH = 32
_VISITED_ENTRY_LIMIT = 8192


def _reader(reader_id: str = "fixture_reader", revision: int = 1) -> dict[str, object]:
    return {
        "reader_id": reader_id,
        "revision": revision,
        "capture_contract": 1,
        "normalization_version": 1,
        "parser_version": 1,
        "host_contract_version": 1,
        "resume_version": 1,
        "capture_schema_version": 1,
        "adapter_digest": None,
        "harness": "codex",
        "entrypoint": "reader:READER",
        "supported_formats": ["fixture-jsonl"],
        "supported_producer_versions": [],
        "recognition_contract": "source_probe_v1_allow_unversioned",
        "allows_unknown_legacy": True,
        "metadata_contract": None,
        "metadata_entrypoint": None,
    }


def _write_package(
    root: Path,
    *,
    readers: list[dict[str, object]] | None = None,
    files: dict[str, bytes] | None = None,
    package_id: str = "fixture-readers",
    release: str = "1",
) -> PackageRef:
    members = files or {"reader.py": b"READER = object()\n"}
    for relative, content in members.items():
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
    file_entries = [
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
        "files": file_entries,
    }
    canonical_input = dict(
        without_digest,
        readers=sorted(
            without_digest["readers"],
            key=lambda reader: (reader["reader_id"], reader["revision"], reader["capture_contract"]),
        ),
    )
    canonical = json.dumps(canonical_input, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()
    digest = hashlib.sha256(_DIGEST_DOMAIN + canonical).hexdigest()
    manifest = dict(without_digest, sha256=digest)
    (root / "reader-package.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return PackageRef(package_id, release, digest)


def _assert_reason(exc: pytest.ExceptionInfo[UsagePackageVerificationError], reason: str) -> None:
    assert exc.value.reason == reason


def test_verifies_independent_digest_oracle_and_immutable_result(tmp_path: Path) -> None:
    expected = _write_package(tmp_path)

    verified = verify_usage_package(expected, tmp_path)

    assert verified.ref == expected
    assert verified.manifest_bytes == (tmp_path / "reader-package.json").read_bytes()
    assert verified.canonical_manifest_bytes == json.dumps(
        {
            "files": [
                {
                    "length": 18,
                    "path": "reader.py",
                    "sha256": hashlib.sha256(b"READER = object()\n").hexdigest(),
                }
            ],
            "manifest_schema": 1,
            "package_id": "fixture-readers",
            "readers": [_reader()],
            "release": "1",
            "requirements": ["operation_summary_v1"],
            "sdk": {"api": "usage-reader", "max_version": 1, "min_version": 1},
        },
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
    ).encode()
    assert expected.sha256 == hashlib.sha256(_DIGEST_DOMAIN + verified.canonical_manifest_bytes).hexdigest()
    assert verified.sdk_min_version == 1
    assert verified.sdk_max_version == 1
    assert verified.requirements == ("operation_summary_v1",)
    assert isinstance(verified.readers, tuple)
    assert verified.readers == (
        type(verified.readers[0])(
            reader_id="fixture_reader",
            revision=1,
            capture_contract=1,
            normalization_version=1,
            parser_version=1,
            host_contract_version=1,
            resume_version=1,
            capture_schema_version=1,
            adapter_digest=None,
            harness="codex",
            entrypoint="reader:READER",
            supported_formats=("fixture-jsonl",),
            supported_producer_versions=(),
            recognition_contract="source_probe_v1_allow_unversioned",
            allows_unknown_legacy=True,
            metadata_contract=None,
            metadata_entrypoint=None,
        ),
    )
    reader = verified.readers[0]
    assert reader.reader_id == "fixture_reader"
    assert reader.revision == 1
    assert reader.capture_contract == 1
    assert reader.normalization_version == 1
    assert reader.parser_version == 1
    assert reader.host_contract_version == 1
    assert reader.resume_version == 1
    assert reader.capture_schema_version == 1
    assert reader.adapter_digest is None
    assert reader.harness == "codex"
    assert reader.entrypoint == "reader:READER"
    assert isinstance(reader.supported_formats, tuple)
    assert reader.supported_formats == ("fixture-jsonl",)
    assert isinstance(reader.supported_producer_versions, tuple)
    assert reader.supported_producer_versions == ()
    assert reader.recognition_contract == "source_probe_v1_allow_unversioned"
    assert reader.allows_unknown_legacy is True
    assert reader.metadata_contract is None
    assert reader.metadata_entrypoint is None
    assert isinstance(verified.members, tuple)
    member = verified.members[0]
    assert member.path == "reader.py"
    assert member.length == 18
    assert member.sha256 == hashlib.sha256(b"READER = object()\n").hexdigest()
    assert member.content == b"READER = object()\n"
    with pytest.raises((AttributeError, TypeError)):
        verified.members = ()  # type: ignore[misc]
    with pytest.raises((AttributeError, TypeError)):
        verified.members[0].content = b"changed"  # type: ignore[misc]


def test_reader_order_and_manifest_key_order_do_not_change_digest(tmp_path: Path) -> None:
    readers = [_reader("z_reader"), _reader("a_reader")]
    expected = _write_package(tmp_path, readers=readers)
    first = verify_usage_package(expected, tmp_path)

    def reverse_object_keys(value):
        if isinstance(value, dict):
            return {key: reverse_object_keys(value[key]) for key in reversed(list(value))}
        if isinstance(value, list):
            return [reverse_object_keys(item) for item in value]
        return value

    manifest = reverse_object_keys(json.loads((tmp_path / "reader-package.json").read_text()))
    manifest["readers"] = list(reversed(manifest["readers"]))
    (tmp_path / "reader-package.json").write_text(json.dumps(manifest, separators=(",", ":")))

    second = verify_usage_package(expected, tmp_path)
    assert first.canonical_manifest_bytes == second.canonical_manifest_bytes
    assert tuple(reader.reader_id for reader in second.readers) == ("a_reader", "z_reader")


def test_expected_digest_blocks_self_consistent_replacement_before_import(tmp_path: Path) -> None:
    expected = _write_package(tmp_path)
    replacement = b"raise RuntimeError('sentinel must not execute')\n"
    replacement_path = tmp_path / "reader.py"
    replacement_path.write_bytes(replacement)
    _write_package(tmp_path, files={"reader.py": replacement})

    with pytest.raises(UsagePackageVerificationError) as exc:
        verify_usage_package(expected, tmp_path)
    _assert_reason(exc, "package_digest_mismatch")


@pytest.mark.parametrize(
    ("mutate", "reason"),
    [
        (lambda manifest: manifest.update(unknown=True), "manifest_invalid_schema"),
        (lambda manifest: manifest["requirements"].clear(), "requirements_incompatible"),
        (lambda manifest: manifest["sdk"].update(min_version=True), "manifest_invalid_schema"),
        (lambda manifest: manifest["readers"][0].update(metadata_contract="future"), "reader_contract_incompatible"),
    ],
)
def test_rejects_strict_schema_and_capability_changes(tmp_path: Path, mutate, reason: str) -> None:
    expected = _write_package(tmp_path)
    manifest_path = tmp_path / "reader-package.json"
    manifest = json.loads(manifest_path.read_text())
    mutate(manifest)
    manifest_path.write_text(json.dumps(manifest))

    with pytest.raises(UsagePackageVerificationError) as exc:
        verify_usage_package(expected, tmp_path)
    _assert_reason(exc, reason)


@pytest.mark.parametrize(
    ("mutate", "reason"),
    [
        (lambda manifest: manifest.update(package_id="café"), "manifest_invalid_schema"),
        (lambda manifest: manifest.update(release="café"), "manifest_invalid_schema"),
        (lambda manifest: manifest["readers"][0].update(reader_id="réader"), "manifest_invalid_schema"),
        (lambda manifest: manifest["files"][0].update(path="réader.py"), "member_path_invalid"),
    ],
)
def test_rejects_non_ascii_identity_and_member_tokens(tmp_path: Path, mutate, reason: str) -> None:
    expected = _write_package(tmp_path)
    manifest_path = tmp_path / "reader-package.json"
    manifest = json.loads(manifest_path.read_text())
    mutate(manifest)
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")

    with pytest.raises(UsagePackageVerificationError) as exc:
        verify_usage_package(expected, tmp_path)
    _assert_reason(exc, reason)


@pytest.mark.parametrize(
    ("mutate", "reason"),
    [
        (
            lambda manifest: manifest["readers"][0].update(
                supported_formats=["z-format", "a-format"]
            ),
            "manifest_invalid_schema",
        ),
        (
            lambda manifest: manifest["readers"][0].update(
                supported_formats=["fixture-jsonl", "fixture-jsonl"]
            ),
            "manifest_invalid_schema",
        ),
        (lambda manifest: manifest["files"].reverse(), "manifest_invalid_schema"),
        (lambda manifest: manifest["files"].__setitem__(1, dict(manifest["files"][0])), "member_path_invalid"),
    ],
)
def test_rejects_unsorted_and_duplicate_token_or_file_arrays(tmp_path: Path, mutate, reason: str) -> None:
    expected = _write_package(
        tmp_path,
        files={
            "reader.py": b"READER = object()\n",
            "second.py": b"VALUE = 1\n",
        },
    )
    manifest_path = tmp_path / "reader-package.json"
    manifest = json.loads(manifest_path.read_text())
    mutate(manifest)
    manifest_path.write_text(json.dumps(manifest))

    with pytest.raises(UsagePackageVerificationError) as exc:
        verify_usage_package(expected, tmp_path)
    _assert_reason(exc, reason)


@pytest.mark.parametrize(
    "mutate",
    [
        lambda manifest: manifest["sdk"].update(future=1),
        lambda manifest: manifest["readers"][0].update(future=1),
        lambda manifest: manifest["files"][0].update(future=1),
    ],
)
def test_rejects_unknown_nested_manifest_keys(tmp_path: Path, mutate) -> None:
    expected = _write_package(tmp_path)
    manifest_path = tmp_path / "reader-package.json"
    manifest = json.loads(manifest_path.read_text())
    mutate(manifest)
    manifest_path.write_text(json.dumps(manifest))

    with pytest.raises(UsagePackageVerificationError) as exc:
        verify_usage_package(expected, tmp_path)
    _assert_reason(exc, "manifest_invalid_schema")


@pytest.mark.parametrize(
    ("mutate", "reason"),
    [
        (lambda manifest: manifest["sdk"].update(api="usage-reader-future"), "sdk_incompatible"),
        (lambda manifest: manifest["sdk"].update(min_version=2, max_version=2), "sdk_incompatible"),
        (lambda manifest: manifest["readers"][0].update(host_contract_version=2), "reader_contract_incompatible"),
        (lambda manifest: manifest["readers"][0].update(recognition_contract="future"), "reader_contract_incompatible"),
    ],
)
def test_rejects_unsupported_sdk_and_reader_policy_versions(tmp_path: Path, mutate, reason: str) -> None:
    expected = _write_package(tmp_path)
    manifest_path = tmp_path / "reader-package.json"
    manifest = json.loads(manifest_path.read_text())
    mutate(manifest)
    manifest_path.write_text(json.dumps(manifest))

    with pytest.raises(UsagePackageVerificationError) as exc:
        verify_usage_package(expected, tmp_path)
    _assert_reason(exc, reason)


@pytest.mark.parametrize(
    "raw",
    [
        b'{"manifest_schema":1,"manifest_schema":1}',
        b'{"manifest_schema":1.0}',
        b'{"manifest_schema":NaN}',
    ],
)
def test_rejects_duplicate_float_and_nonfinite_json(tmp_path: Path, raw: bytes) -> None:
    expected = _write_package(tmp_path)
    (tmp_path / "reader-package.json").write_bytes(raw)

    with pytest.raises(UsagePackageVerificationError) as exc:
        verify_usage_package(expected, tmp_path)
    _assert_reason(exc, "manifest_invalid_json")


def test_rejects_utf8_bom_before_json_parsing(tmp_path: Path) -> None:
    expected = _write_package(tmp_path)
    manifest_path = tmp_path / "reader-package.json"
    manifest_path.write_bytes(b"\xef\xbb\xbf" + manifest_path.read_bytes())

    with pytest.raises(UsagePackageVerificationError) as exc:
        verify_usage_package(expected, tmp_path)
    _assert_reason(exc, "manifest_invalid_json")


def test_rejects_manifest_byte_cap(tmp_path: Path) -> None:
    expected = _write_package(tmp_path)
    (tmp_path / "reader-package.json").write_bytes(b"{" + b" " * _MANIFEST_BYTES_LIMIT)

    with pytest.raises(UsagePackageVerificationError) as exc:
        verify_usage_package(expected, tmp_path)
    _assert_reason(exc, "manifest_too_large")


def test_accepts_manifest_at_the_byte_cap(tmp_path: Path) -> None:
    expected = _write_package(tmp_path)
    manifest_path = tmp_path / "reader-package.json"
    manifest = manifest_path.read_bytes()
    manifest += b" " * (_MANIFEST_BYTES_LIMIT - len(manifest))
    assert len(manifest) == _MANIFEST_BYTES_LIMIT
    manifest_path.write_bytes(manifest)

    assert verify_usage_package(expected, tmp_path).ref == expected


def test_manifest_read_is_bounded_before_oversized_content_is_allocated(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    expected = _write_package(tmp_path)
    manifest_path = tmp_path / "reader-package.json"
    original_open = Path.open
    requested_sizes: list[int] = []

    class BoundedStream:
        def __enter__(self) -> "BoundedStream":
            return self

        def __exit__(self, *args: object) -> None:
            del args

        def read(self, size: int = -1) -> bytes:
            if size < 0:
                raise AssertionError("manifest reads must be bounded")
            requested_sizes.append(size)
            return b"x" * size

    def bounded_open(path: Path, *args: object, **kwargs: object) -> object:
        if path == manifest_path:
            return BoundedStream()
        return original_open(path, *args, **kwargs)

    monkeypatch.setattr(Path, "open", bounded_open)
    with pytest.raises(UsagePackageVerificationError) as exc:
        verify_usage_package(expected, tmp_path)
    _assert_reason(exc, "manifest_too_large")
    assert max(requested_sizes) <= 65_536
    assert sum(requested_sizes) == _MANIFEST_BYTES_LIMIT + 1


def test_rejects_declared_member_byte_cap(tmp_path: Path) -> None:
    expected = _write_package(tmp_path)
    manifest_path = tmp_path / "reader-package.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["files"][0]["length"] = _MAX_MEMBER_BYTES + 1
    manifest_path.write_text(json.dumps(manifest))

    with pytest.raises(UsagePackageVerificationError) as exc:
        verify_usage_package(expected, tmp_path)
    _assert_reason(exc, "member_limit_exceeded")


def test_rejects_declared_total_member_byte_cap(tmp_path: Path) -> None:
    expected = _write_package(
        tmp_path,
        files={
            "reader.py": b"READER = object()\n",
            "one.py": b"1",
            "two.py": b"2",
            "three.py": b"3",
            "four.py": b"4",
        },
    )
    manifest_path = tmp_path / "reader-package.json"
    manifest = json.loads(manifest_path.read_text())
    for item in manifest["files"]:
        item["length"] = _MAX_MEMBER_BYTES
    manifest_path.write_text(json.dumps(manifest))

    with pytest.raises(UsagePackageVerificationError) as exc:
        verify_usage_package(expected, tmp_path)
    _assert_reason(exc, "member_limit_exceeded")


def test_rejects_declared_member_count_cap(tmp_path: Path) -> None:
    members = {"reader.py": b"READER = object()\n"}
    members.update({f"module_{index:04d}.py": b"VALUE = 1\n" for index in range(_MAX_MEMBER_COUNT)})
    expected = _write_package(tmp_path, files=members)

    with pytest.raises(UsagePackageVerificationError) as exc:
        verify_usage_package(expected, tmp_path)
    _assert_reason(exc, "member_limit_exceeded")


def test_accepts_actual_member_count_at_the_cap(tmp_path: Path) -> None:
    members = {"reader.py": b"READER = object()\n"}
    members.update({f"module_{index:04d}.py": b"VALUE = 1\n" for index in range(_MAX_MEMBER_COUNT - 1)})
    expected = _write_package(tmp_path, files=members)

    assert len(members) == _MAX_MEMBER_COUNT
    assert verify_usage_package(expected, tmp_path).ref == expected


def test_rejects_actual_member_count_cap(tmp_path: Path) -> None:
    members = {"reader.py": b"READER = object()\n"}
    members.update({f"module_{index:04d}.py": b"VALUE = 1\n" for index in range(_MAX_MEMBER_COUNT - 1)})
    expected = _write_package(tmp_path, files=members)
    (tmp_path / "extra.py").write_bytes(b"VALUE = 2\n")

    with pytest.raises(UsagePackageVerificationError) as exc:
        verify_usage_package(expected, tmp_path)
    _assert_reason(exc, "member_limit_exceeded")


def test_rejects_member_digest_mismatch(tmp_path: Path) -> None:
    expected = _write_package(tmp_path)
    (tmp_path / "reader.py").write_bytes(b"SEADER = object()\n")

    with pytest.raises(UsagePackageVerificationError) as exc:
        verify_usage_package(expected, tmp_path)
    _assert_reason(exc, "member_digest_mismatch")


def test_rejects_member_length_mismatch_before_hashing(tmp_path: Path) -> None:
    expected = _write_package(tmp_path)
    (tmp_path / "reader.py").write_bytes(b"READER = object()")

    with pytest.raises(UsagePackageVerificationError) as exc:
        verify_usage_package(expected, tmp_path)
    _assert_reason(exc, "member_length_mismatch")


def test_member_read_is_bounded_before_oversized_content_is_allocated(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    expected = _write_package(tmp_path)
    member_path = tmp_path / "reader.py"
    original_open = Path.open
    requested_sizes: list[int] = []

    class BoundedStream:
        def __enter__(self) -> "BoundedStream":
            return self

        def __exit__(self, *args: object) -> None:
            del args

        def read(self, size: int = -1) -> bytes:
            if size < 0:
                raise AssertionError("member reads must be bounded")
            requested_sizes.append(size)
            return b"x" * size

    def bounded_open(path: Path, *args: object, **kwargs: object) -> object:
        if path == member_path:
            return BoundedStream()
        return original_open(path, *args, **kwargs)

    monkeypatch.setattr(Path, "open", bounded_open)
    with pytest.raises(UsagePackageVerificationError) as exc:
        verify_usage_package(expected, tmp_path)
    _assert_reason(exc, "member_length_mismatch")
    assert requested_sizes == [len(b"READER = object()\n") + 2]


def test_rejects_symlink_and_extra_cache_content(tmp_path: Path) -> None:
    expected = _write_package(tmp_path)
    cache = tmp_path / "__pycache__"
    cache.mkdir()
    (cache / "reader.cpython-313.pyc").write_bytes(b"ignored")
    (cache / "extra.txt").write_bytes(b"must be declared")
    with pytest.raises(UsagePackageVerificationError) as exc:
        verify_usage_package(expected, tmp_path)
    _assert_reason(exc, "member_set_mismatch")

    (cache / "extra.txt").unlink()
    assert verify_usage_package(expected, tmp_path).ref == expected

    extra = tmp_path / "nested"
    extra.mkdir()
    os.symlink(tmp_path / "reader.py", extra / "link.py")
    with pytest.raises(UsagePackageVerificationError) as exc:
        verify_usage_package(expected, tmp_path)
    _assert_reason(exc, "member_path_invalid")


def test_rejects_manifest_symlink(tmp_path: Path) -> None:
    expected = _write_package(tmp_path)
    manifest_path = tmp_path / "reader-package.json"
    target = tmp_path / "manifest-copy"
    target.write_bytes(manifest_path.read_bytes())
    manifest_path.unlink()
    os.symlink(target, manifest_path)

    with pytest.raises(UsagePackageVerificationError) as exc:
        verify_usage_package(expected, tmp_path)
    _assert_reason(exc, "member_path_invalid")


def test_rejects_special_files_when_supported(tmp_path: Path) -> None:
    if not hasattr(os, "mkfifo"):
        pytest.skip("platform does not support special files")
    expected = _write_package(tmp_path)
    try:
        os.mkfifo(tmp_path / "special")
    except (NotImplementedError, OSError):
        pytest.skip("platform does not support FIFO fixtures")

    with pytest.raises(UsagePackageVerificationError) as exc:
        verify_usage_package(expected, tmp_path)
    _assert_reason(exc, "member_path_invalid")


def test_rejects_pyc_outside_cache(tmp_path: Path) -> None:
    expected = _write_package(tmp_path)
    (tmp_path / "reader.pyc").write_bytes(b"not ignored")

    with pytest.raises(UsagePackageVerificationError) as exc:
        verify_usage_package(expected, tmp_path)
    _assert_reason(exc, "member_set_mismatch")


def test_rejects_listed_cache_bytecode(tmp_path: Path) -> None:
    expected = _write_package(
        tmp_path,
        files={
            "reader.py": b"READER = object()\n",
            "__pycache__/reader.cpython-313.pyc": b"listed cache bytecode",
        },
    )

    with pytest.raises(UsagePackageVerificationError) as exc:
        verify_usage_package(expected, tmp_path)
    _assert_reason(exc, "member_set_mismatch")


def test_rejects_unsafe_and_ambiguous_members(tmp_path: Path) -> None:
    expected = _write_package(tmp_path)
    (tmp_path / "CON.txt").write_bytes(b"reserved")
    with pytest.raises(UsagePackageVerificationError) as exc:
        verify_usage_package(expected, tmp_path)
    _assert_reason(exc, "member_path_invalid")

    (tmp_path / "CON.txt").unlink()
    expected = _write_package(
        tmp_path,
        files={
            "reader.py": b"READER = object()\n",
            "helper.py": b"VALUE = 1\n",
            "helper/__init__.py": b"VALUE = 2\n",
        },
    )
    with pytest.raises(UsagePackageVerificationError) as exc:
        verify_usage_package(expected, tmp_path)
    _assert_reason(exc, "member_path_invalid")


def test_rejects_fully_declared_intermediate_module_ambiguity(tmp_path: Path) -> None:
    reader = dict(_reader(), entrypoint="a.b:READER")
    expected = _write_package(
        tmp_path,
        readers=[reader],
        files={
            "a.py": b"VALUE = 1\n",
            "a/__init__.py": b"VALUE = 2\n",
            "a/b.py": b"READER = object()\n",
        },
    )

    with pytest.raises(UsagePackageVerificationError) as exc:
        verify_usage_package(expected, tmp_path)
    _assert_reason(exc, "member_path_invalid")


def test_rejects_declared_module_and_package_ambiguity_for_init_modules(tmp_path: Path) -> None:
    reader = _reader()
    expected = _write_package(
        tmp_path,
        readers=[reader],
        files={
            "reader.py": b"READER = object()\n",
            "x/__init__.py": b"VALUE = 1\n",
            "x/__init__/__init__.py": b"VALUE = 2\n",
        },
    )

    with pytest.raises(UsagePackageVerificationError) as exc:
        verify_usage_package(expected, tmp_path)
    _assert_reason(exc, "member_path_invalid")


def test_accepts_nested_module_with_declared_parent_initializer(tmp_path: Path) -> None:
    reader = dict(_reader(), entrypoint="pkg.reader:READER")
    expected = _write_package(
        tmp_path,
        readers=[reader],
        files={
            "pkg/__init__.py": b"VALUE = 1\n",
            "pkg/reader.py": b"READER = object()\n",
        },
    )

    assert verify_usage_package(expected, tmp_path).readers[0].entrypoint == "pkg.reader:READER"


def test_rejects_missing_entrypoint_module(tmp_path: Path) -> None:
    reader = dict(_reader(), entrypoint="missing:READER")
    expected = _write_package(tmp_path, readers=[reader])

    with pytest.raises(UsagePackageVerificationError) as exc:
        verify_usage_package(expected, tmp_path)
    _assert_reason(exc, "member_set_mismatch")


def test_rejects_missing_entrypoint_parent_initializer(tmp_path: Path) -> None:
    reader = dict(_reader(), entrypoint="pkg.reader:READER")
    expected = _write_package(
        tmp_path,
        readers=[reader],
        files={"pkg/reader.py": b"READER = object()\n"},
    )

    with pytest.raises(UsagePackageVerificationError) as exc:
        verify_usage_package(expected, tmp_path)
    _assert_reason(exc, "member_set_mismatch")


def test_rejects_declared_non_pyc_cache_member(tmp_path: Path) -> None:
    expected = _write_package(
        tmp_path,
        files={
            "reader.py": b"READER = object()\n",
            "__pycache__/helper.txt": b"must not be a package member\n",
        },
    )

    with pytest.raises(UsagePackageVerificationError) as exc:
        verify_usage_package(expected, tmp_path)
    _assert_reason(exc, "member_set_mismatch")


def test_traversal_budget_stops_consuming_an_oversized_ignored_cache(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    expected = _write_package(tmp_path)
    consumed = 0

    class FakeEntry:
        def __init__(self, name: str, path: Path, is_directory: bool) -> None:
            self.name = name
            self.path = str(path)
            self._is_directory = is_directory

        def is_symlink(self) -> bool:
            return False

        def stat(self, *, follow_symlinks: bool) -> SimpleNamespace:
            del follow_symlinks
            mode = stat.S_IFDIR if self._is_directory else stat.S_IFREG
            return SimpleNamespace(st_mode=mode)

    class CountingScan:
        def __init__(self, entries: int, directory: Path) -> None:
            self._entries = entries
            self._directory = directory
            self._index = 0

        def __iter__(self) -> "CountingScan":
            return self

        def __enter__(self) -> "CountingScan":
            return self

        def __exit__(self, *args: object) -> None:
            del args

        def close(self) -> None:
            return None

        def __next__(self) -> FakeEntry:
            nonlocal consumed
            if self._index >= self._entries:
                raise StopIteration
            self._index += 1
            consumed += 1
            name = f"module_{self._index}.py"
            return FakeEntry(name, self._directory / name, False)

    def bounded_scandir(path: str | os.PathLike[str]) -> CountingScan:
        return CountingScan(_VISITED_ENTRY_LIMIT + 100, Path(path))

    monkeypatch.setattr(
        "skill_hub.infrastructure.harnesses.harness_usage_package_manifest.os.scandir",
        bounded_scandir,
    )
    with pytest.raises(UsagePackageVerificationError) as exc:
        verify_usage_package(expected, tmp_path)
    _assert_reason(exc, "member_limit_exceeded")
    assert consumed <= _VISITED_ENTRY_LIMIT + 1


def test_accepts_and_rejects_the_visited_entry_boundary(tmp_path: Path) -> None:
    expected = _write_package(tmp_path)
    cache = tmp_path / "__pycache__"
    cache.mkdir()
    for index in range(_VISITED_ENTRY_LIMIT - 3):
        (cache / f"reader_{index:04d}.pyc").write_bytes(b"ignored")

    assert verify_usage_package(expected, tmp_path).ref == expected

    (tmp_path / "extra.py").write_bytes(b"VALUE = 1\n")
    with pytest.raises(UsagePackageVerificationError) as exc:
        verify_usage_package(expected, tmp_path)
    _assert_reason(exc, "member_limit_exceeded")


def test_accepts_directory_depth_at_the_limit(tmp_path: Path) -> None:
    expected = _write_package(tmp_path)
    current = tmp_path
    for index in range(_MAX_DIRECTORY_DEPTH):
        current /= f"level_{index}"
        current.mkdir()

    assert verify_usage_package(expected, tmp_path).ref == expected


def test_rejects_directory_depth_above_the_limit(tmp_path: Path) -> None:
    expected = _write_package(tmp_path)
    current = tmp_path
    for index in range(_MAX_DIRECTORY_DEPTH + 1):
        current /= f"level_{index}"
        current.mkdir()

    with pytest.raises(UsagePackageVerificationError) as exc:
        verify_usage_package(expected, tmp_path)
    _assert_reason(exc, "member_limit_exceeded")


def test_rejects_casefold_colliding_members_when_filesystem_supports_them(tmp_path: Path) -> None:
    probe = tmp_path / "case_probe"
    probe.mkdir()
    (probe / "lower").write_bytes(b"lower")
    if (probe / "LOWER").exists():
        pytest.skip("filesystem does not preserve case-distinct names")
    (probe / "lower").unlink()
    probe.rmdir()

    expected = _write_package(tmp_path)
    (tmp_path / "READER.py").write_bytes(b"OTHER = object()\n")
    with pytest.raises(UsagePackageVerificationError) as exc:
        verify_usage_package(expected, tmp_path)
    _assert_reason(exc, "member_path_invalid")


def test_rejects_symlinked_package_root(tmp_path: Path) -> None:
    package = tmp_path / "package"
    package.mkdir()
    expected = _write_package(package)
    linked = tmp_path / "linked-package"
    os.symlink(package, linked, target_is_directory=True)

    with pytest.raises(UsagePackageVerificationError) as exc:
        verify_usage_package(expected, linked)
    _assert_reason(exc, "member_path_invalid")


def test_rejects_symlink_inside_ignored_cache(tmp_path: Path) -> None:
    expected = _write_package(tmp_path)
    cache = tmp_path / "__pycache__"
    cache.mkdir()
    os.symlink(tmp_path / "reader.py", cache / "reader.cpython-313.pyc")

    with pytest.raises(UsagePackageVerificationError) as exc:
        verify_usage_package(expected, tmp_path)
    _assert_reason(exc, "member_path_invalid")


def test_verification_errors_do_not_expose_paths_or_os_messages(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    expected = _write_package(tmp_path)
    private_message = f"secret path {tmp_path / 'private'}"

    def failing_scandir(path: str | os.PathLike[str]) -> object:
        del path
        raise OSError(private_message)

    monkeypatch.setattr(
        "skill_hub.infrastructure.harnesses.harness_usage_package_manifest.os.scandir",
        failing_scandir,
    )
    with pytest.raises(UsagePackageVerificationError) as exc:
        verify_usage_package(expected, tmp_path)
    _assert_reason(exc, "package_io_error")
    assert private_message not in str(exc.value)
    assert str(tmp_path) not in str(exc.value)


def test_missing_declared_member_is_unavailable(tmp_path: Path) -> None:
    expected = _write_package(tmp_path)
    (tmp_path / "reader.py").unlink()

    with pytest.raises(UsagePackageVerificationError) as exc:
        verify_usage_package(expected, tmp_path)
    _assert_reason(exc, "package_unavailable")
    assert str(tmp_path) not in str(exc.value)
    assert "reader.py" in str(exc.value)


def test_identity_records_are_strict_but_reader_ref_compatibility_is_unchanged() -> None:
    package = PackageRef("pkg", "release+1", "a" * 64)
    reader = ReaderRef("reader", "2", "1")
    assert reader.revision == 2
    assert ReaderArtifactRef(reader, package).package == package
    with pytest.raises((TypeError, ValueError)):
        PackageRef("Pkg", "1", "a" * 64)
    with pytest.raises((TypeError, ValueError)):
        ReaderArtifactRef(ReaderRef("bad/id", 1, 1), package)
