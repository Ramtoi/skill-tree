"""Exact dispatch for the bundled Usage readers.

The native decoder bodies stay in their existing modules so normalized record
identity and fixture output remain unchanged.  This module is the small
composition root used by both the host and a portable worker.
"""

from __future__ import annotations

import importlib
from dataclasses import dataclass
from typing import Any

from skill_hub.domain.harnesses.harness_usage_api import (
    CaptureBatch,
    CaptureHost,
    ReaderRef,
    ReaderSource,
    SourceCursor,
    SourceProbe,
    SourceRecognition,
    UsageReader,
)

CAPTURE_CONTRACT_VERSION = 1


@dataclass(frozen=True)
class _BundledReader:
    module_name: str
    READER_ID: str
    READER_REVISION: int
    NORMALIZATION_VERSION: int
    CAPTURE_PARSER_VERSION: int
    CAPTURE_CONTRACT_VERSION: int = CAPTURE_CONTRACT_VERSION

    def _module(self) -> Any:
        return importlib.import_module(self.module_name)

    def capture(
        self,
        source: ReaderSource,
        cursor: SourceCursor,
        host: CaptureHost,
        *,
        deadline: float | None = None,
    ) -> CaptureBatch:
        if source.harness not in _MODULES or _MODULES[source.harness] != self.module_name:
            raise ValueError("reader/source harness mismatch")
        module = self._module()
        parser = (
            module.capture_claude_source
            if source.harness == "claude-code"
            else module.capture_codex_source
        )
        return parser(source, cursor, host, deadline=deadline)

    def recognize_source(self, probe: SourceProbe) -> SourceRecognition:
        return self._module().recognize_source(probe)


_MODULES = {
    "claude-code": "skill_hub.infrastructure.usage.usage_inspection_claude",
    "codex": "skill_hub.infrastructure.usage.usage_inspection_codex",
}
_REGISTERED_READERS: dict[tuple[str, int, int], tuple[str, UsageReader]] = {}


def _module_reader(harness: str) -> _BundledReader:
    module_name = _MODULES.get(harness)
    if module_name is None:
        raise ValueError(f"unsupported Usage harness: {harness}")
    module = importlib.import_module(module_name)
    return _BundledReader(
        module_name,
        str(module.READER_ID),
        int(module.READER_REVISION),
        int(module.NORMALIZATION_VERSION),
        int(getattr(module, "CAPTURE_PARSER_VERSION", 1)),
        int(getattr(module, "CAPTURE_CONTRACT_VERSION", CAPTURE_CONTRACT_VERSION)),
    )


def load_usage_reader(ref: ReaderRef) -> UsageReader:
    """Load exactly the bundled reader named by ``ref``.

    A current/default reader is never substituted for a mismatched revision or
    contract.  Later package provenance and historical selection build on this
    fail-closed boundary.
    """
    if not isinstance(ref, ReaderRef):
        raise TypeError("usage reader reference required")
    registered = _REGISTERED_READERS.get((ref.reader_id, ref.revision, ref.contract_version))
    if registered is not None:
        return registered[1]
    for harness in _MODULES:
        reader = _module_reader(harness)
        if reader.READER_ID != ref.reader_id:
            continue
        if reader.READER_REVISION != ref.revision:
            raise ValueError("usage reader revision mismatch")
        if reader.CAPTURE_CONTRACT_VERSION != ref.contract_version:
            raise ValueError("usage reader contract mismatch")
        return reader
    raise ValueError("unknown bundled usage reader")


def register_usage_reader(harness: str, reader: UsageReader) -> ReaderRef:
    """Register a process-local test reader, not an installed package.

    Spawned workers load the bundled registry independently. This test seam
    does not provide installation or cross-process reader availability.
    """
    ref = ReaderRef(
        str(reader.READER_ID),
        int(reader.READER_REVISION),
        int(reader.CAPTURE_CONTRACT_VERSION),
    )
    _REGISTERED_READERS[(ref.reader_id, ref.revision, ref.contract_version)] = (harness, reader)
    return ref


def unregister_usage_reader(ref: ReaderRef) -> None:
    _REGISTERED_READERS.pop((ref.reader_id, ref.revision, ref.contract_version), None)


def usage_reader_inventory() -> tuple[tuple[str, ReaderRef, UsageReader], ...]:
    """Return every locally loadable reader, active or retained."""
    rows: list[tuple[str, ReaderRef, UsageReader]] = []
    for harness in _MODULES:
        reader = _module_reader(harness)
        ref = ReaderRef(reader.READER_ID, reader.READER_REVISION, reader.CAPTURE_CONTRACT_VERSION)
        rows.append((harness, ref, reader))
    rows.extend((harness, ReaderRef(*key), reader) for key, (harness, reader) in _REGISTERED_READERS.items())
    unique: dict[tuple[str, int, int], tuple[str, ReaderRef, UsageReader]] = {
        (ref.reader_id, ref.revision, ref.contract_version): (harness, ref, reader)
        for harness, ref, reader in rows
    }
    return tuple(unique.values())


__all__ = [
    "CAPTURE_CONTRACT_VERSION",
    "load_usage_reader",
    "register_usage_reader",
    "unregister_usage_reader",
    "usage_reader_inventory",
]
