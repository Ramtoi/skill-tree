"""Strict, byte-oriented verification for Usage reader packages.

This module deliberately stops at verified bytes.  It does not import, load,
or discover a reader implementation.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import stat
from dataclasses import dataclass
from pathlib import Path
from typing import Any, NoReturn

from skill_hub.domain.harnesses.harness_usage_api import (
    USAGE_READER_SDK_VERSION,
    PackageRef,
)

MANIFEST_NAME = "reader-package.json"
MANIFEST_SCHEMA = 1
MANIFEST_BYTES_LIMIT = 262_144
MAX_MEMBER_COUNT = 1_024
MAX_MEMBER_BYTES = 4 * 1024 * 1024
MAX_TOTAL_MEMBER_BYTES = 16 * 1024 * 1024
MAX_VISITED_ENTRIES = 8_192
MAX_DIRECTORY_DEPTH = 32
DIGEST_PREFIX = b"skill-hub.usage-reader-package.v1\0"
REQUIRED_REQUIREMENTS = ("operation_summary_v1",)

_PACKAGE_ID_RE = re.compile(r"[a-z0-9][a-z0-9._-]{0,127}\Z")
_RELEASE_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._+-]{0,63}\Z")
_READER_ID_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,127}\Z")
_SHA256_RE = re.compile(r"[0-9a-f]{64}\Z")
_FORMAT_RE = re.compile(r"[a-z0-9][a-z0-9._-]{0,127}\Z")
_PRODUCER_VERSION_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._+-]{0,127}\Z")
_ENTRY_COMPONENT_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*\Z")
_PATH_COMPONENT_RE = re.compile(r"[A-Za-z0-9_][A-Za-z0-9._-]*\Z")
_DEVICE_NAMES = {"con", "prn", "aux", "nul", *(f"com{i}" for i in range(1, 10)), *(f"lpt{i}" for i in range(1, 10))}


class UsagePackageVerificationError(ValueError):
    """A safe, stable failure from package verification."""

    kind = "usage_package_invalid"

    def __init__(self, reason: str, member: str | None = None) -> None:
        self.reason = reason
        self.member = member
        detail = reason if member is None else f"{reason}: {member}"
        super().__init__(detail)


def _reject(reason: str, member: str | None = None) -> NoReturn:
    raise UsagePackageVerificationError(reason, member)


def _is_int(value: object) -> bool:
    return type(value) is int


def _positive_int(value: object) -> bool:
    return type(value) is int and 1 <= value <= 2_147_483_647


def _ascii_token(value: object, pattern: re.Pattern[str], reason: str = "manifest_invalid_schema") -> str:
    if type(value) is not str:
        _reject(reason)
    try:
        value.encode("ascii")
    except UnicodeEncodeError:
        _reject(reason)
    if pattern.fullmatch(value) is None:
        _reject(reason)
    return value


def _exact_keys(value: object, expected: set[str]) -> dict[str, Any]:
    if type(value) is not dict or set(value) != expected:
        _reject("manifest_invalid_schema")
    return value


def _sorted_tokens(value: object, pattern: re.Pattern[str], *, nonempty: bool) -> tuple[str, ...]:
    if type(value) is not list or (nonempty and not value):
        _reject("manifest_invalid_schema")
    result = tuple(_ascii_token(item, pattern) for item in value)
    if len(set(result)) != len(result) or result != tuple(sorted(result)):
        _reject("manifest_invalid_schema")
    return result


def _entrypoint(value: object) -> tuple[str, str]:
    token = _ascii_token(value, re.compile(r".{1,256}\Z"))
    if len(token.encode("ascii")) > 256 or token.startswith(".") or ":" not in token:
        _reject("manifest_invalid_schema")
    module, attribute = token.split(":", 1)
    modules = module.split(".")
    if not modules or any(_ENTRY_COMPONENT_RE.fullmatch(part) is None for part in modules):
        _reject("manifest_invalid_schema")
    if _ENTRY_COMPONENT_RE.fullmatch(attribute) is None:
        _reject("manifest_invalid_schema")
    return module, attribute


def _member_path(value: object, *, reason: str = "manifest_invalid_schema") -> str:
    if type(value) is not str:
        _reject(reason)
    try:
        encoded = value.encode("ascii")
    except UnicodeEncodeError:
        _reject("member_path_invalid")
    if not 1 <= len(encoded) <= 1024 or "\\" in value or value.startswith("/") or value.endswith("/"):
        _reject("member_path_invalid")
    parts = value.split("/")
    if any(not part or part in {".", ".."} for part in parts):
        _reject("member_path_invalid")
    for part in parts:
        if len(part.encode("ascii")) > 255 or part.endswith(".") or _PATH_COMPONENT_RE.fullmatch(part) is None:
            _reject("member_path_invalid")
        if part.split(".", 1)[0].lower() in _DEVICE_NAMES:
            _reject("member_path_invalid")
    return value


def _parse_json(raw: bytes) -> dict[str, Any]:
    if raw.startswith(b"\xef\xbb\xbf"):
        _reject("manifest_invalid_json")

    def duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                _reject("manifest_invalid_json")
            result[key] = value
        return result

    try:
        text = raw.decode("utf-8")
        value = json.loads(
            text,
            object_pairs_hook=duplicate_keys,
            parse_float=lambda _: (_ for _ in ()).throw(ValueError("float")),
            parse_constant=lambda _: (_ for _ in ()).throw(ValueError("constant")),
        )
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError, ValueError, TypeError):
        _reject("manifest_invalid_json")
    if type(value) is not dict:
        _reject("manifest_invalid_schema")
    return value


def _read_member(path: Path, declared_length: int, member: str) -> bytes:
    try:
        st = path.lstat()
    except FileNotFoundError as exc:
        raise UsagePackageVerificationError("package_unavailable", member) from exc
    except OSError as exc:
        raise UsagePackageVerificationError("package_unavailable", member) from exc
    if not stat.S_ISREG(st.st_mode):
        _reject("member_path_invalid", member)
    if st.st_size > MAX_MEMBER_BYTES:
        _reject("member_limit_exceeded", member)
    try:
        with path.open("rb") as stream:
            content = _read_limited(stream, declared_length + 1, member=member)
    except UsagePackageVerificationError:
        raise
    except OSError as exc:
        raise UsagePackageVerificationError("package_unavailable", member) from exc
    if len(content) != declared_length:
        _reject("member_length_mismatch", member)
    return content


def _read_limited(stream: Any, limit: int, *, member: str | None = None) -> bytes:
    chunks: list[bytes] = []
    size = 0
    while True:
        chunk = stream.read(min(65_536, limit + 1 - size))
        if not chunk:
            return b"".join(chunks)
        chunks.append(chunk)
        size += len(chunk)
        if size > limit:
            _reject("manifest_too_large" if member is None else "member_length_mismatch", member)


@dataclass(frozen=True)
class VerifiedPackageMember:
    path: str
    length: int
    sha256: str
    content: bytes


@dataclass(frozen=True)
class VerifiedReaderExport:
    reader_id: str
    revision: int
    capture_contract: int
    normalization_version: int
    parser_version: int
    host_contract_version: int
    resume_version: int
    capture_schema_version: int
    adapter_digest: None
    harness: str
    entrypoint: str
    supported_formats: tuple[str, ...]
    supported_producer_versions: tuple[str, ...]
    recognition_contract: str
    allows_unknown_legacy: bool
    metadata_contract: None
    metadata_entrypoint: None


@dataclass(frozen=True)
class VerifiedUsagePackage:
    ref: PackageRef
    manifest_bytes: bytes
    canonical_manifest_bytes: bytes
    sdk_min_version: int
    sdk_max_version: int
    requirements: tuple[str, ...]
    readers: tuple[VerifiedReaderExport, ...]
    members: tuple[VerifiedPackageMember, ...]


_READER_KEYS = {
    "reader_id", "revision", "capture_contract", "normalization_version", "parser_version",
    "host_contract_version", "resume_version", "capture_schema_version", "adapter_digest",
    "harness", "entrypoint", "supported_formats", "supported_producer_versions",
    "recognition_contract", "allows_unknown_legacy", "metadata_contract", "metadata_entrypoint",
}


def _parse_reader(value: object) -> tuple[VerifiedReaderExport, tuple[str, int, int], str]:
    item = _exact_keys(value, _READER_KEYS)
    reader_id = _ascii_token(item["reader_id"], _READER_ID_RE)
    if not _positive_int(item["revision"]):
        _reject("manifest_invalid_schema")
    versions = (
        ("capture_contract", item["capture_contract"]),
        ("normalization_version", item["normalization_version"]),
        ("host_contract_version", item["host_contract_version"]),
        ("resume_version", item["resume_version"]),
        ("capture_schema_version", item["capture_schema_version"]),
    )
    if any(not _is_int(value) for _, value in versions) or not _positive_int(item["parser_version"]):
        _reject("manifest_invalid_schema")
    if any(value != 1 for _, value in versions):
        _reject("reader_contract_incompatible")
    if (
        item["adapter_digest"] is not None
        or item["metadata_contract"] is not None
        or item["metadata_entrypoint"] is not None
    ):
        _reject("reader_contract_incompatible")
    harness = item["harness"]
    recognition = item["recognition_contract"]
    if type(harness) is not str or type(recognition) is not str:
        _reject("manifest_invalid_schema")
    if harness not in {"claude-code", "codex"} or recognition not in {
        "source_probe_v1",
        "source_probe_v1_allow_unversioned",
    }:
        _reject("reader_contract_incompatible")
    module, _ = _entrypoint(item["entrypoint"])
    formats = _sorted_tokens(item["supported_formats"], _FORMAT_RE, nonempty=True)
    producers = _sorted_tokens(item["supported_producer_versions"], _PRODUCER_VERSION_RE, nonempty=False)
    if type(item["allows_unknown_legacy"]) is not bool:
        _reject("manifest_invalid_schema")
    export = VerifiedReaderExport(
        reader_id=reader_id,
        revision=item["revision"],
        capture_contract=item["capture_contract"],
        normalization_version=item["normalization_version"],
        parser_version=item["parser_version"],
        host_contract_version=item["host_contract_version"],
        resume_version=item["resume_version"],
        capture_schema_version=item["capture_schema_version"],
        adapter_digest=None,
        harness=harness,
        entrypoint=item["entrypoint"],
        supported_formats=formats,
        supported_producer_versions=producers,
        recognition_contract=recognition,
        allows_unknown_legacy=item["allows_unknown_legacy"],
        metadata_contract=None,
        metadata_entrypoint=None,
    )
    return export, (reader_id, item["revision"], item["capture_contract"]), module


def _parse_manifest(
    manifest: dict[str, Any],
) -> tuple[
    dict[str, Any],
    tuple[VerifiedReaderExport, ...],
    tuple[tuple[str, int, str], ...],
    int,
    int,
    tuple[str, ...],
]:
    top = _exact_keys(
        manifest,
        {"manifest_schema", "package_id", "release", "sdk", "requirements", "readers", "files", "sha256"},
    )
    if not _is_int(top["manifest_schema"]):
        _reject("manifest_invalid_schema")
    if top["manifest_schema"] != MANIFEST_SCHEMA:
        _reject("manifest_unsupported_schema")
    package_id = _ascii_token(top["package_id"], _PACKAGE_ID_RE)
    release = _ascii_token(top["release"], _RELEASE_RE)
    sdk = _exact_keys(top["sdk"], {"api", "min_version", "max_version"})
    if type(sdk["api"]) is not str or not _positive_int(sdk["min_version"]) or not _positive_int(sdk["max_version"]):
        _reject("manifest_invalid_schema")
    if sdk["min_version"] > sdk["max_version"]:
        _reject("manifest_invalid_schema")
    if sdk["api"] != "usage-reader" or not (sdk["min_version"] <= USAGE_READER_SDK_VERSION <= sdk["max_version"]):
        _reject("sdk_incompatible")
    requirements = top["requirements"]
    if type(requirements) is not list or any(type(item) is not str for item in requirements):
        _reject("manifest_invalid_schema")
    if tuple(requirements) != REQUIRED_REQUIREMENTS:
        _reject("requirements_incompatible")
    raw_readers = top["readers"]
    if type(raw_readers) is not list or not raw_readers:
        _reject("manifest_invalid_schema")
    parsed_readers = tuple(_parse_reader(item) for item in raw_readers)
    identities = [identity for _, identity, _ in parsed_readers]
    if len(set(identities)) != len(identities):
        _reject("manifest_invalid_schema")
    readers = tuple(
        sorted(
            (reader for reader, _, _ in parsed_readers),
            key=lambda item: (item.reader_id, item.revision, item.capture_contract),
        )
    )
    files = top["files"]
    if type(files) is not list:
        _reject("manifest_invalid_schema")
    if len(files) > MAX_MEMBER_COUNT:
        _reject("member_limit_exceeded")
    declarations: list[tuple[str, int, str]] = []
    for item in files:
        file_item = _exact_keys(item, {"path", "length", "sha256"})
        path = _member_path(file_item["path"])
        if path == MANIFEST_NAME:
            _reject("member_set_mismatch")
        if not _is_int(file_item["length"]) or file_item["length"] < 0:
            _reject("manifest_invalid_schema")
        if file_item["length"] > MAX_MEMBER_BYTES:
            _reject("member_limit_exceeded", path)
        digest = _ascii_token(file_item["sha256"], _SHA256_RE)
        declarations.append((path, file_item["length"], digest))
    paths = [path for path, _, _ in declarations]
    if paths != sorted(paths):
        _reject("manifest_invalid_schema")
    if len({path.casefold() for path in paths}) != len(paths):
        _reject("member_path_invalid")
    if sum(length for _, length, _ in declarations) > MAX_TOTAL_MEMBER_BYTES:
        _reject("member_limit_exceeded")
    _ascii_token(top["sha256"], _SHA256_RE)
    return top, readers, tuple(declarations), sdk["min_version"], sdk["max_version"], tuple(requirements)


@dataclass(frozen=True)
class _DiskEntry:
    path: str
    absolute: Path
    is_dir: bool
    ignored: bool


def _walk_package(root: Path) -> tuple[tuple[_DiskEntry, ...], set[str]]:
    entries: list[_DiskEntry] = []
    ignored_files: set[str] = set()
    seen_casefold: dict[tuple[str, ...], tuple[str, bool]] = {}
    visited = 0

    def visit(directory: Path, prefix: tuple[str, ...], in_cache: bool) -> None:
        nonlocal visited
        try:
            with os.scandir(directory) as scan:
                children = []
                for child in scan:
                    visited += 1
                    if visited > MAX_VISITED_ENTRIES:
                        _reject("member_limit_exceeded")
                    children.append(child)
            children.sort(key=lambda item: item.name)
        except OSError as exc:
            raise UsagePackageVerificationError("package_io_error") from exc
        for child in children:
            rel_parts = prefix + (child.name,)
            rel = "/".join(rel_parts)
            _member_path(rel)
            try:
                if child.is_symlink():
                    _reject("member_path_invalid")
                mode = child.stat(follow_symlinks=False).st_mode
            except UsagePackageVerificationError:
                raise
            except OSError as exc:
                raise UsagePackageVerificationError("package_io_error") from exc
            is_dir = stat.S_ISDIR(mode)
            is_file = stat.S_ISREG(mode)
            if not is_dir and not is_file:
                _reject("member_path_invalid")
            directory_depth = len(rel_parts) if is_dir else len(prefix)
            if directory_depth > MAX_DIRECTORY_DEPTH:
                _reject("member_limit_exceeded")
            folded = tuple(part.casefold() for part in rel_parts)
            if folded in seen_casefold:
                _reject("member_path_invalid")
            if any(seen_casefold.get(folded[:index], ("", False))[1] for index in range(1, len(folded))):
                _reject("member_path_invalid")
            if is_file and any(key[: len(folded)] == folded for key in seen_casefold):
                _reject("member_path_invalid")
            seen_casefold[folded] = (rel, is_file)
            cache = in_cache or child.name == "__pycache__"
            if is_dir:
                visit(Path(child.path), rel_parts, cache)
                continue
            if cache and not child.name.endswith(".pyc"):
                _reject("member_set_mismatch", rel)
            ignored = cache
            if ignored:
                ignored_files.add(rel)
            entries.append(_DiskEntry(rel, Path(child.path), False, ignored))

    visit(root, (), False)
    return tuple(entries), ignored_files


def _canonical_bytes(manifest: dict[str, Any], readers: tuple[VerifiedReaderExport, ...]) -> bytes:
    without_digest = dict(manifest)
    without_digest.pop("sha256")
    without_digest["readers"] = [
        {key: getattr(reader, key) for key in _READER_KEYS}
        for reader in readers
    ]
    return json.dumps(
        without_digest,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
        allow_nan=False,
    ).encode("utf-8")


def _check_entrypoints(readers: tuple[VerifiedReaderExport, ...], declared: set[str]) -> None:
    for path in declared:
        if path.endswith(".py"):
            package_file = f"{path[:-3]}/__init__.py"
            if package_file in declared:
                _reject("member_path_invalid")
    for reader in readers:
        module, _ = _entrypoint(reader.entrypoint)
        parts = module.split(".")
        module_file = "/".join(parts) + ".py"
        package_file = "/".join(parts) + "/__init__.py"
        candidates = [path for path in (module_file, package_file) if path in declared]
        if len(candidates) != 1:
            _reject("member_path_invalid" if len(candidates) == 2 else "member_set_mismatch")
        for index in range(1, len(parts)):
            initializer = "/".join(parts[:index]) + "/__init__.py"
            if initializer not in declared:
                _reject("member_set_mismatch")


def verify_usage_package(expected: PackageRef, root: Path) -> VerifiedUsagePackage:
    """Verify a package against a trusted identity and return immutable bytes."""
    if type(expected) is not PackageRef:
        raise TypeError("expected must be a PackageRef")
    try:
        root_path = Path(root)
        root_stat = root_path.lstat()
    except (OSError, TypeError, ValueError) as exc:
        raise UsagePackageVerificationError("package_unavailable") from exc
    if stat.S_ISLNK(root_stat.st_mode):
        _reject("member_path_invalid")
    if not stat.S_ISDIR(root_stat.st_mode):
        _reject("package_unavailable")
    manifest_path = root_path / MANIFEST_NAME
    try:
        manifest_stat = manifest_path.lstat()
    except OSError as exc:
        raise UsagePackageVerificationError("package_unavailable") from exc
    if stat.S_ISLNK(manifest_stat.st_mode):
        _reject("member_path_invalid", MANIFEST_NAME)
    if not stat.S_ISREG(manifest_stat.st_mode):
        _reject("member_path_invalid", MANIFEST_NAME)
    if manifest_stat.st_size > MANIFEST_BYTES_LIMIT:
        _reject("manifest_too_large")
    try:
        with manifest_path.open("rb") as stream:
            manifest_bytes = _read_limited(stream, MANIFEST_BYTES_LIMIT)
    except OSError as exc:
        raise UsagePackageVerificationError("package_unavailable") from exc
    manifest = _parse_json(manifest_bytes)
    top, readers, declarations, sdk_min, sdk_max, requirements = _parse_manifest(manifest)
    if top["package_id"] != expected.package_id or top["release"] != expected.release:
        _reject("package_identity_mismatch")
    canonical = _canonical_bytes(manifest, readers)
    digest = hashlib.sha256(DIGEST_PREFIX + canonical).hexdigest()
    if top["sha256"] != digest or expected.sha256 != digest:
        _reject("package_digest_mismatch")
    disk_entries, ignored_files = _walk_package(root_path)
    actual = {entry.path: entry for entry in disk_entries if not entry.ignored and entry.path != MANIFEST_NAME}
    if len(actual) > MAX_MEMBER_COUNT:
        _reject("member_limit_exceeded")
    declared_paths = {path for path, _, _ in declarations}
    if ignored_files & declared_paths or MANIFEST_NAME in declared_paths:
        _reject("member_set_mismatch")
    missing = declared_paths - set(actual)
    extra = set(actual) - declared_paths
    if missing and not extra:
        _reject("package_unavailable", sorted(missing)[0])
    if missing or extra:
        _reject("member_set_mismatch")
    _check_entrypoints(readers, declared_paths)
    members: list[VerifiedPackageMember] = []
    for path, length, declared_digest in declarations:
        content = _read_member(actual[path].absolute, length, path)
        actual_digest = hashlib.sha256(content).hexdigest()
        if actual_digest != declared_digest:
            _reject("member_digest_mismatch", path)
        members.append(VerifiedPackageMember(path, length, declared_digest, content))
    return VerifiedUsagePackage(
        ref=expected,
        manifest_bytes=manifest_bytes,
        canonical_manifest_bytes=canonical,
        sdk_min_version=sdk_min,
        sdk_max_version=sdk_max,
        requirements=requirements,
        readers=readers,
        members=tuple(members),
    )


__all__ = [
    "MANIFEST_BYTES_LIMIT",
    "MAX_DIRECTORY_DEPTH",
    "MAX_MEMBER_BYTES",
    "MAX_MEMBER_COUNT",
    "MAX_TOTAL_MEMBER_BYTES",
    "MAX_VISITED_ENTRIES",
    "UsagePackageVerificationError",
    "VerifiedPackageMember",
    "VerifiedReaderExport",
    "VerifiedUsagePackage",
    "verify_usage_package",
]
