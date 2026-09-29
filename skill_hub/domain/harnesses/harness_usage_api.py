"""Small immutable contract between the Usage host and bundled readers.

The normalized record classes remain owned by ``usage_inspection_capture``.
They are re-exported here deliberately: a reader result must pickle with the
same module-qualified class name as the existing store and fixture corpus.
This module contains no registry, discovery, or filesystem authority.
"""

from __future__ import annotations

import re
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

from skill_hub.domain.usage.usage_inspection_capture import (  # noqa: F401
    OPERATION_SUMMARY_LIMIT,
    RESUME_STATE_VERSION,
    TIER_A_INPUT_BODY_LIMIT,
    TIER_B_INPUT_TOOLS,
    BodyPartInput,
    BodyStatus,
    CaptureBatch,
    CaptureSource,
    ChangeInput,
    EventInput,
    MessageInput,
    NativeRunRef,
    PrInput,
    ReaderBinding,
    ReaderBindingPolicy,
    ReaderBindingSourceEvidence,
    RelationshipInput,
    RetentionTier,
    RootResolution,
    RunInput,
    SourceChangedError,
    SourceCursor,
    SourceFingerprint,
    SourceInput,
    SourceStatus,
    SummaryEventSeedInput,
    TokenSampleInput,
    ToolCallInput,
    body_identity,
    bounded_body,
    dump_resume_state,
    json_body,
    load_resume_state,
    new_resume_state,
    operation_hash,
    retention_tier,
    stable_id,
    text_body,
)


@dataclass(frozen=True, init=False)
class ReaderSource:
    """Immutable lexical context supplied to one reader invocation.

    ``lexical_path`` is an opaque spelling used for source identity and
    filename context.  It is intentionally a string, so a bundled reader
    cannot open arbitrary files through this record.  The host owns all I/O.
    ``path=`` is accepted as a compatibility spelling but is stored as the
    same opaque string.
    """

    source_id: str
    harness: str
    source_session_id: str
    lexical_path: str

    def __init__(
        self,
        source_id: str,
        harness: str,
        source_session_id: str = "",
        lexical_path: str | Path = "",
        *,
        path: str | Path | None = None,
    ) -> None:
        if path is not None:
            if lexical_path not in ("", path):
                raise ValueError("ReaderSource received both lexical_path and path")
            lexical_path = path
        object.__setattr__(self, "source_id", str(source_id))
        object.__setattr__(self, "harness", str(harness))
        object.__setattr__(self, "source_session_id", str(source_session_id))
        object.__setattr__(self, "lexical_path", str(lexical_path))

    @property
    def path(self) -> str:
        """Compatibility spelling that still exposes no filesystem object."""
        return self.lexical_path

    @property
    def source_path(self) -> str:
        return self.lexical_path


@dataclass(frozen=True)
class SourceProbe:
    """Immutable bounded observation used by reader-specific recognition."""

    source_id: str
    snapshot: SourceFingerprint | None
    raw_prefix: bytes
    records: tuple[dict[str, Any], ...]
    complete_end: int
    bytes_read: int
    complete_record_count: int
    stop_reason: str


@dataclass(frozen=True)
class SourceRecognition:
    """Structural evidence returned by one specific bundled reader."""

    producer: str | None = None
    producer_version: str | None = None
    native_format: str | None = None
    format_fingerprint: str | None = None
    completeness: str = "inconclusive"
    reason: str = ""

    def canonical_json(self) -> str:
        import json

        return json.dumps(
            {
                "completeness": self.completeness,
                "format_fingerprint": self.format_fingerprint,
                "native_format": self.native_format,
                "producer": self.producer,
                "producer_version": self.producer_version,
                "reason": self.reason,
            },
            sort_keys=True,
            separators=(",", ":"),
        )


class CaptureHost(Protocol):
    """Source-bound host operations available to a bundled reader."""

    def fingerprint(self) -> SourceFingerprint: ...

    def append_proven(self, cursor: SourceCursor) -> bool: ...

    def read_complete_suffix(
        self, cursor: SourceCursor, deadline: float | None = None
    ) -> tuple[bytes, SourceFingerprint, int, int, bool]: ...

    def snapshot_matches(self, fingerprint: SourceFingerprint) -> bool: ...

    def hashes_for_commit(
        self, offset: int, prefix_sha256: str = ""
    ) -> tuple[str, str]: ...

    # These two operations are also source-bound.  Their arguments are
    # transcript evidence (a locator or repository identity), not arbitrary
    # host paths selected by the caller.
    def capture_attachment(
        self, locator: str, *, max_bytes: int | None = None
    ) -> BodyPartInput: ...

    def capture_revision_patch(
        self,
        repository: str,
        *,
        run_id: str,
        source_epoch: str,
        source_event_id: str,
        repository_id: str,
        revision_id: str,
        base_id: str,
        merge_base_id: str | None = None,
        deadline: float | None = None,
    ) -> ChangeInput: ...


class OperationSummaryHostV1(Protocol):
    """Versioned host capability for redacted operation summaries."""

    def operation_summary_v1(
        self,
        tool_name: str,
        operation_json: str | None,
        *,
        limit: int = OPERATION_SUMMARY_LIMIT,
    ) -> str | None: ...


class ReaderHostCompatibilityError(TypeError):
    """The host is missing a required reader capability."""


def require_operation_summary_host_v1(host: Any) -> OperationSummaryHostV1:
    """Validate the summary capability without touching any other host API."""
    operation_summary_v1 = getattr(host, "operation_summary_v1", None)
    if not callable(operation_summary_v1):
        raise ReaderHostCompatibilityError(
            "Usage reader host must provide callable operation_summary_v1"
        )
    return host


def capture_operation_summary(
    host: Any,
    tool_name: str,
    operation_json: str | None,
    *,
    limit: int = OPERATION_SUMMARY_LIMIT,
) -> str | None:
    """Dispatch one summary request through the versioned host capability."""
    capable = require_operation_summary_host_v1(host)
    return capable.operation_summary_v1(tool_name, operation_json, limit=limit)


def source_generation(
    path: str | Path,
    cursor: SourceCursor,
    fingerprint: SourceFingerprint,
    append_check: Callable[[], bool],
) -> str:
    """Use the established append/replacement epoch formula everywhere."""
    if cursor.generation_id and append_check():
        return cursor.generation_id
    return "epoch:" + stable_id(str(path), fingerprint.prefix_sha256, fingerprint.boundary_sha256)


class DecodedRecordsHost(Protocol):
    """Optional host extension for source-bound JSONL decoding."""

    def decoded_records(
        self,
        raw: bytes,
        fingerprint: SourceFingerprint,
        offset_start: int,
        *,
        deadline: float | None = None,
    ) -> tuple[dict[str, Any], ...]: ...


def capture_records(
    host: CaptureHost,
    raw: bytes,
    fingerprint: SourceFingerprint,
    offset_start: int,
    *,
    deadline: float | None = None,
) -> tuple[dict[str, Any], ...]:
    """Use the optional SDK decoder, or the pure JSONL fallback.

    An installed extension is part of the capture contract. Its exceptions
    intentionally propagate; falling back would hide a broken extension.
    """

    from skill_hub.infrastructure.usage.usage_jsonl import JsonlFramingDeadlineError
    if deadline is not None and time.monotonic() >= deadline:
        raise JsonlFramingDeadlineError("source budget exceeded")
    decoder = getattr(host, "decoded_records", None)
    if callable(decoder):
        records = tuple(decoder(raw, fingerprint, offset_start, deadline=deadline))
        if deadline is not None and time.monotonic() >= deadline:
            raise JsonlFramingDeadlineError("source budget exceeded")
        return records
    from skill_hub.infrastructure.usage.usage_jsonl import decode_jsonl_records

    if deadline is None:
        return decode_jsonl_records(raw)
    return decode_jsonl_records(raw, deadline=deadline)


class UsageReader(Protocol):
    """Reader entry point implemented by the bundled reader adapters."""

    @property
    def READER_ID(self) -> str: ...

    @property
    def READER_REVISION(self) -> int: ...

    @property
    def CAPTURE_CONTRACT_VERSION(self) -> int: ...

    @property
    def NORMALIZATION_VERSION(self) -> int: ...

    def capture(
        self,
        source: ReaderSource,
        cursor: SourceCursor,
        host: CaptureHost,
        *,
        deadline: float | None = None,
    ) -> CaptureBatch: ...

    def recognize_source(self, probe: SourceProbe) -> SourceRecognition: ...


@dataclass(frozen=True, init=False)
class ReaderRef:
    """Exact reader identity requested by a host operation."""

    reader_id: str
    revision: int
    contract_version: int = 1

    def __init__(
        self,
        reader_id: str,
        revision: int | None = None,
        contract_version: int | None = None,
        *,
        reader_revision: int | None = None,
        capture_contract_version: int | None = None,
    ) -> None:
        if revision is None:
            revision = reader_revision
        elif reader_revision is not None and revision != reader_revision:
            raise ValueError("ReaderRef received conflicting revisions")
        if revision is None:
            raise TypeError("ReaderRef requires a revision")
        if contract_version is None:
            contract_version = capture_contract_version if capture_contract_version is not None else 1
        elif capture_contract_version is not None and contract_version != capture_contract_version:
            raise ValueError("ReaderRef received conflicting contract versions")
        object.__setattr__(self, "reader_id", str(reader_id))
        object.__setattr__(self, "revision", int(revision))
        object.__setattr__(self, "contract_version", int(contract_version))

    # The aliases make persisted policy and caller terminology explicit while
    # keeping one immutable record and one pickle identity.
    @property
    def id(self) -> str:
        return self.reader_id

    @property
    def contract(self) -> int:
        return self.contract_version

    @property
    def reader_revision(self) -> int:
        return self.revision

    @property
    def capture_contract_version(self) -> int:
        return self.contract_version

    def canonical_json(self) -> str:
        import json

        return json.dumps(
            {
                "contract_version": self.contract_version,
                "reader_id": self.reader_id,
                "revision": self.revision,
            },
            sort_keys=True,
            separators=(",", ":"),
        )


USAGE_READER_SDK_VERSION = 1

_PACKAGE_ID_RE = re.compile(r"[a-z0-9][a-z0-9._-]{0,127}\Z")
_RELEASE_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._+-]{0,63}\Z")
_SHA256_RE = re.compile(r"[0-9a-f]{64}\Z")
_READER_ID_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,127}\Z")


def _strict_ascii_token(value: object, pattern: re.Pattern[str], name: str) -> str:
    if type(value) is not str:
        raise TypeError(f"{name} must be a string")
    try:
        value.encode("ascii")
    except UnicodeEncodeError as exc:
        raise ValueError(f"{name} must contain ASCII characters") from exc
    if pattern.fullmatch(value) is None:
        raise ValueError(f"invalid {name}")
    return value


@dataclass(frozen=True)
class PackageRef:
    """The immutable identity of one verified reader package."""

    package_id: str
    release: str
    sha256: str

    def __post_init__(self) -> None:
        _strict_ascii_token(self.package_id, _PACKAGE_ID_RE, "package_id")
        if self.package_id in {".", ".."}:
            raise ValueError("invalid package_id")
        _strict_ascii_token(self.release, _RELEASE_RE, "release")
        _strict_ascii_token(self.sha256, _SHA256_RE, "sha256")


@dataclass(frozen=True)
class ReaderArtifactRef:
    """A reader identity pinned to one immutable package release."""

    reader: ReaderRef
    package: PackageRef

    def __post_init__(self) -> None:
        if type(self.reader) is not ReaderRef:
            raise TypeError("reader must be a ReaderRef")
        if type(self.package) is not PackageRef:
            raise TypeError("package must be a PackageRef")
        _strict_ascii_token(self.reader.reader_id, _READER_ID_RE, "reader_id")
        if type(self.reader.revision) is not int or not 1 <= self.reader.revision <= 2_147_483_647:
            raise ValueError("reader revision must be a positive integer")
        if type(self.reader.contract_version) is not int or self.reader.contract_version != 1:
            raise ValueError("reader contract_version must be 1")


__all__ = [
    "OPERATION_SUMMARY_LIMIT",
    "PackageRef",
    "ReaderArtifactRef",
    "BodyPartInput",
    "BodyStatus",
    "CaptureBatch",
    "CaptureHost",
    "CaptureSource",
    "DecodedRecordsHost",
    "OperationSummaryHostV1",
    "ReaderHostCompatibilityError",
    "capture_records",
    "capture_operation_summary",
    "ChangeInput",
    "EventInput",
    "MessageInput",
    "NativeRunRef",
    "PrInput",
    "ReaderBinding",
    "ReaderBindingPolicy",
    "ReaderRef",
    "ReaderSource",
    "ReaderBindingSourceEvidence",
    "RelationshipInput",
    "RootResolution",
    "RunInput",
    "RESUME_STATE_VERSION",
    "RetentionTier",
    "SourceChangedError",
    "SourceCursor",
    "SourceFingerprint",
    "SourceProbe",
    "SourceRecognition",
    "SourceInput",
    "SourceStatus",
    "source_generation",
    "SummaryEventSeedInput",
    "TokenSampleInput",
    "ToolCallInput",
    "UsageReader",
    "USAGE_READER_SDK_VERSION",
    "TIER_A_INPUT_BODY_LIMIT",
    "TIER_B_INPUT_TOOLS",
    "bounded_body",
    "body_identity",
    "dump_resume_state",
    "json_body",
    "load_resume_state",
    "new_resume_state",
    "operation_hash",
    "retention_tier",
    "require_operation_summary_host_v1",
    "stable_id",
    "text_body",
]
