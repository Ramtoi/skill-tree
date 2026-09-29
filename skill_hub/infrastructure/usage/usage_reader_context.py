"""Host-owned context for one source-bound Usage reader invocation."""

from __future__ import annotations

import hashlib
import time
from collections.abc import Callable
from copy import deepcopy
from dataclasses import dataclass
from pathlib import Path

from skill_hub.domain.harnesses.harness_usage_api import (
    OPERATION_SUMMARY_LIMIT,
    ReaderSource,
    SourceCursor,
    SourceFingerprint,
    SourceProbe,
    SourceRecognition,
    capture_records,
)
from skill_hub.domain.usage.usage_inspection_capture import BodyPartInput, ChangeInput
from skill_hub.infrastructure.usage.usage_capture_io import (
    append_proven,
    capture_attachment,
    capture_revision_patch,
    hashes_for_commit,
    read_complete_suffix,
    snapshot_fingerprint_matches,
    source_fingerprint,
)
from skill_hub.infrastructure.usage.usage_capture_summary import operation_summary
from skill_hub.infrastructure.usage.usage_jsonl import JsonlDeadlineError, complete_jsonl_prefix, decode_jsonl_records

PROBE_BYTE_LIMIT = 64 * 1024
PROBE_RECORD_LIMIT = 32
_SENTINEL_BYTES = 4096


@dataclass(frozen=True)
class _DecodedPrefix:
    raw: bytes
    records: tuple[dict, ...]
    snapshot: SourceFingerprint


def _source_id(path: Path) -> str:
    return "source:" + hashlib.sha256(str(path).encode("utf-8")).hexdigest()


class SourceBoundCaptureHost:
    """Bind every filesystem operation to one transcript source.

    A reader receives this object only for the source selected by the host.
    It cannot substitute another source path for the core read/fingerprint
    operations.  A deadline supplied by a reader is always clamped to the
    host's budget.
    """

    def __init__(
        self,
        path: str | Path,
        *,
        source_id: str | None = None,
        source_session_id: str | None = None,
        deadline: float | None = None,
        fingerprint_fn: Callable[[Path], SourceFingerprint] = source_fingerprint,
        append_proven_fn: Callable[[Path, SourceCursor], bool] = append_proven,
        read_complete_suffix_fn: Callable[..., tuple[bytes, SourceFingerprint, int, int, bool]] = read_complete_suffix,
        snapshot_matches_fn: Callable[[Path, SourceFingerprint], bool] = snapshot_fingerprint_matches,
        hashes_for_commit_fn: Callable[..., tuple[str, str]] = hashes_for_commit,
    ) -> None:
        self._path = Path(path)
        self._source_id = source_id or _source_id(self._path)
        self._source_session_id = source_session_id or self._path.stem
        self._deadline = deadline
        self._fingerprint_fn = fingerprint_fn
        self._append_proven_fn = append_proven_fn
        self._read_complete_suffix_fn = read_complete_suffix_fn
        self._snapshot_matches_fn = snapshot_matches_fn
        self._hashes_for_commit_fn = hashes_for_commit_fn
        self._decoded_prefix: _DecodedPrefix | None = None

    @property
    def source_path(self) -> Path:
        """Expose the bound path to the host composition root only."""
        return self._path

    @property
    def source_session_id(self) -> str:
        return self._source_session_id

    @property
    def source_id(self) -> str:
        return self._source_id

    def operation_summary_v1(
        self,
        tool_name: str,
        operation_json: str | None,
        *,
        limit: int = OPERATION_SUMMARY_LIMIT,
    ) -> str | None:
        return operation_summary(tool_name, operation_json, limit=limit)

    def decoded_records(
        self,
        raw: bytes,
        fingerprint: SourceFingerprint,
        offset_start: int,
        *,
        deadline: float | None = None,
    ) -> tuple[dict, ...]:
        """Decode records with a private prefix cache detached from probes."""

        bounded = self._bounded_deadline(deadline)
        if bounded is not None and time.monotonic() >= bounded:
            raise JsonlDeadlineError("source budget exceeded")
        cached = self._decoded_prefix
        if offset_start == 0 and cached is not None:
            exact_prefix = raw.startswith(cached.raw)
            same_snapshot = cached.snapshot == fingerprint
            if same_snapshot and exact_prefix:
                suffix = raw[len(cached.raw) :]
                if not suffix:
                    return tuple(deepcopy(record) for record in cached.records)
                remainder = decode_jsonl_records(suffix, deadline=bounded)
                return tuple(deepcopy(record) for record in cached.records) + remainder
        return decode_jsonl_records(raw, deadline=bounded)

    def install_probe_seed(self, probe: SourceProbe) -> bool:
        """Install a bounded host-owned probe prefix after source validation.

        Portable workers receive only this detached seed.  A changed source
        invalidates it before any reader can reuse the decoded prefix.
        """
        if probe.source_id != self._source_id or probe.snapshot is None or not probe.raw_prefix:
            return False
        try:
            current = self._fingerprint_fn(self._path)
            if current != probe.snapshot or not self._snapshot_matches_fn(self._path, probe.snapshot):
                self._decoded_prefix = None
                return False
        except (OSError, ValueError):
            self._decoded_prefix = None
            return False
        self._decoded_prefix = _DecodedPrefix(bytes(probe.raw_prefix), tuple(deepcopy(probe.records)), probe.snapshot)
        return True

    def read_probe(self, *, deadline: float | None = None) -> SourceProbe:
        """Read a bounded source prefix and its two fingerprint sentinels."""

        bounded = self._bounded_deadline(deadline)
        source_id = self._source_id
        if bounded is not None and time.monotonic() >= bounded:
            return SourceProbe(source_id, None, b"", (), 0, 0, 0, "deadline")
        snapshot = self._path.stat()
        total = 0
        data = b""
        deadline_hit = False

        def expired() -> bool:
            return bounded is not None and time.monotonic() >= bounded

        if expired():
            return SourceProbe(source_id, None, b"", (), 0, 0, 0, "deadline")
        # Reserve one 4 KiB read for the boundary sentinel.  The prefix read
        # therefore cannot make the total attributable probe reads exceed 64K.
        prefix_budget = max(0, PROBE_BYTE_LIMIT - _SENTINEL_BYTES)
        with self._path.open("rb") as handle:
            data = handle.read(min(snapshot.st_size, prefix_budget))
            total += len(data)
            if expired():
                deadline_hit = True
            prefix = data[: min(_SENTINEL_BYTES, snapshot.st_size)]
            boundary_start = max(0, snapshot.st_size - _SENTINEL_BYTES)
            if not deadline_hit and expired():
                deadline_hit = True
            if not deadline_hit:
                if snapshot.st_size <= len(data):
                    boundary = data[boundary_start : snapshot.st_size]
                else:
                    handle.seek(boundary_start)
                    boundary = handle.read(min(_SENTINEL_BYTES, snapshot.st_size - boundary_start))
                    total += len(boundary)
        final = self._path.stat()
        if (final.st_dev, final.st_ino) != (snapshot.st_dev, snapshot.st_ino) or final.st_size < snapshot.st_size:
            self._decoded_prefix = None
            return SourceProbe(source_id, None, b"", (), 0, total, 0, "source_changed")
        if final.st_size == snapshot.st_size and final.st_mtime_ns != snapshot.st_mtime_ns:
            self._decoded_prefix = None
            return SourceProbe(source_id, None, b"", (), 0, total, 0, "source_changed")
        if deadline_hit:
            return SourceProbe(source_id, None, b"", (), 0, total, 0, "deadline")
        fp = SourceFingerprint(
            snapshot.st_dev,
            snapshot.st_ino,
            snapshot.st_size,
            snapshot.st_mtime_ns,
            hashlib.sha256(prefix).hexdigest(),
            hashlib.sha256(boundary).hexdigest(),
        )
        try:
            safe_raw, framing_reason, frame_count = complete_jsonl_prefix(
                data, max_records=PROBE_RECORD_LIMIT, deadline=bounded
            )
        except JsonlDeadlineError:
            return SourceProbe(source_id, fp, b"", (), 0, total, 0, "deadline")
        if snapshot.st_size > len(data) and framing_reason in {"eof", "partial_tail"}:
            framing_reason = "byte_limit"
        complete_end = len(safe_raw)
        if expired():
            return SourceProbe(source_id, fp, safe_raw, (), complete_end, total, frame_count, "deadline")
        try:
            records = capture_records(self, safe_raw, fp, 0, deadline=bounded)
        except JsonlDeadlineError:
            return SourceProbe(source_id, fp, safe_raw, (), complete_end, total, frame_count, "deadline")
        final_after_decode = self._path.stat()
        if (
            (final_after_decode.st_dev, final_after_decode.st_ino)
            != (snapshot.st_dev, snapshot.st_ino)
            or final_after_decode.st_size < snapshot.st_size
        ):
            self._decoded_prefix = None
            return SourceProbe(source_id, None, b"", (), 0, total, 0, "source_changed")
        if final_after_decode.st_size == snapshot.st_size and final_after_decode.st_mtime_ns != snapshot.st_mtime_ns:
            self._decoded_prefix = None
            return SourceProbe(source_id, None, b"", (), 0, total, 0, "source_changed")
        if expired():
            return SourceProbe(source_id, fp, safe_raw, records, complete_end, total, frame_count, "deadline")
        # Retain only the bounded recognition prefix. Full capture may be much
        # larger and must not grow this per-source cache during a scan pass.
        self._decoded_prefix = _DecodedPrefix(
            safe_raw, tuple(deepcopy(record) for record in records), fp
        )
        return SourceProbe(source_id, fp, safe_raw, records, complete_end, total, frame_count, framing_reason)

    def _bounded_deadline(self, requested: float | None) -> float | None:
        if requested is None:
            return self._deadline
        if self._deadline is None:
            return requested
        return min(requested, self._deadline)

    def _check_deadline(self, requested: float | None = None) -> float | None:
        deadline = self._bounded_deadline(requested)
        if deadline is not None and time.monotonic() >= deadline:
            raise TimeoutError("source budget exceeded")
        return deadline

    def fingerprint(self) -> SourceFingerprint:
        self._check_deadline()
        return self._fingerprint_fn(self._path)

    def append_proven(self, cursor: SourceCursor) -> bool:
        self._check_deadline()
        return self._append_proven_fn(self._path, cursor)

    def read_complete_suffix(
        self, cursor: SourceCursor, deadline: float | None = None
    ) -> tuple[bytes, SourceFingerprint, int, int, bool]:
        bounded = self._check_deadline(deadline)
        return self._read_complete_suffix_fn(self._path, cursor, deadline=bounded)

    def snapshot_matches(self, fingerprint: SourceFingerprint) -> bool:
        self._check_deadline()
        matches = self._snapshot_matches_fn(self._path, fingerprint)
        if not matches:
            self._decoded_prefix = None
        return matches

    def hashes_for_commit(
        self, offset: int, prefix_sha256: str = ""
    ) -> tuple[str, str]:
        self._check_deadline()
        return self._hashes_for_commit_fn(self._path, offset, prefix_sha256)

    def _tool_results_root(self) -> Path:
        # Root transcripts have a sibling session directory. Child transcripts
        # live under ``<session>/subagents`` and share the root tool-results
        # directory. This mirrors the legacy reader's confinement relation.
        if any(parent.name == "subagents" for parent in self._path.parents):
            return self._path.parent.parent / "tool-results"
        return self._path.parent / self._source_session_id / "tool-results"

    def capture_attachment(
        self, locator: str, *, max_bytes: int | None = None
    ) -> BodyPartInput:
        self._check_deadline()
        return capture_attachment(
            Path(locator), self._tool_results_root(), locator=locator, max_bytes=max_bytes
        )

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
    ) -> ChangeInput:
        bounded = self._check_deadline(deadline)
        return capture_revision_patch(
            Path(repository),
            run_id=run_id,
            source_epoch=source_epoch,
            source_event_id=source_event_id,
            repository_id=repository_id,
            revision_id=revision_id,
            base_id=base_id,
            merge_base_id=merge_base_id,
            deadline=bounded,
        )


CaptureHostContext = SourceBoundCaptureHost
BoundCaptureHost = SourceBoundCaptureHost


def source_context(
    path: str | Path,
    *,
    harness: str,
    source_id: str | None = None,
    source_session_id: str | None = None,
) -> tuple[ReaderSource, SourceBoundCaptureHost]:
    """Create the immutable source record and its host-owned service pair."""
    lexical = str(path)
    sid = source_id or f"{harness}:{hashlib.sha256(lexical.encode()).hexdigest()}"
    session = source_session_id or (Path(path).stem if harness == "claude-code" else "")
    return (
        ReaderSource(sid, harness, session, lexical),
        SourceBoundCaptureHost(path, source_id=sid, source_session_id=session),
    )


def make_reader_source(
    path: str | Path,
    harness: str,
    *,
    source_id: str | None = None,
    source_session_id: str | None = None,
) -> ReaderSource:
    return source_context(
        path,
        harness=harness,
        source_id=source_id,
        source_session_id=source_session_id,
    )[0]


def probe_source(host: SourceBoundCaptureHost, deadline: float | None = None) -> SourceProbe:
    """Run the host-owned bounded source probe."""
    bounded = host._bounded_deadline(deadline)
    if bounded is not None and time.monotonic() >= bounded:
        return SourceProbe(host.source_id, None, b"", (), 0, 0, 0, "deadline")
    return host.read_probe(deadline=deadline)


__all__ = [
    "BoundCaptureHost",
    "CaptureHostContext",
    "SourceBoundCaptureHost",
    "SourceProbe",
    "SourceRecognition",
    "make_reader_source",
    "probe_source",
    "source_context",
]
