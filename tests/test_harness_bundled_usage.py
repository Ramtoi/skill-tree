"""Exact bundled Usage reader dispatch tests."""

from __future__ import annotations

import pickle
from pathlib import Path

import pytest

from skill_hub.domain.harnesses.harness_usage_api import ReaderRef, ReaderSource, SourceCursor
from skill_hub.domain.usage.usage_inspection_capture import CaptureBatch
from skill_hub.domain.usage.usage_inspection_capture import SourceCursor as CaptureSourceCursor
from skill_hub.infrastructure.harnesses.harness_bundled_usage import load_usage_reader
from skill_hub.infrastructure.usage.usage_inspection_claude import NORMALIZATION_VERSION, READER_ID, READER_REVISION
from skill_hub.infrastructure.usage.usage_inspection_codex import capture_codex_source
from skill_hub.infrastructure.usage.usage_reader_context import SourceBoundCaptureHost, source_context


def test_sdk_aliases_retain_existing_pickle_identity():
    assert SourceCursor is CaptureSourceCursor
    encoded = pickle.dumps(SourceCursor)
    assert pickle.loads(encoded) is CaptureSourceCursor


def test_loader_requires_exact_bundled_reader_identity():
    reader = load_usage_reader(ReaderRef(READER_ID, READER_REVISION, 1))
    assert reader.READER_ID == READER_ID
    assert reader.READER_REVISION == READER_REVISION
    assert reader.NORMALIZATION_VERSION == NORMALIZATION_VERSION
    with pytest.raises(ValueError, match="revision mismatch"):
        load_usage_reader(ReaderRef(READER_ID, READER_REVISION + 1, 1))
    with pytest.raises(ValueError, match="contract mismatch"):
        load_usage_reader(ReaderRef(READER_ID, READER_REVISION, 2))
    with pytest.raises(ValueError, match="unknown bundled"):
        load_usage_reader(ReaderRef("missing-reader", 1, 1))


def test_bundled_readers_do_not_own_filesystem_inventory():
    claude = load_usage_reader(ReaderRef(READER_ID, READER_REVISION, 1))
    codex = load_usage_reader(ReaderRef("usage_inspection_codex", 6, 1))

    assert not hasattr(claude, "recognizes_source_path")
    assert not hasattr(claude, "discover_sources")
    assert not hasattr(codex, "recognizes_source_path")
    assert not hasattr(codex, "discover_sources")


def test_loaded_reader_captures_through_the_source_bound_host(tmp_path: Path):
    path = tmp_path / "aaaaaaaa-1111-4111-8111-111111111111.jsonl"
    path.write_text('{"type":"assistant","sessionId":"session","message":{}}\n')
    reader = load_usage_reader(ReaderRef(READER_ID, READER_REVISION, 1))
    source = ReaderSource("claude:test", "claude-code", path.stem, str(path))
    cursor = SourceCursor("claude:test", "", 0, 0, SourceBoundCaptureHost(path).fingerprint())
    batch = reader.capture(source, cursor, SourceBoundCaptureHost(path))
    assert isinstance(batch, CaptureBatch)
    assert batch.source.source_id == "claude:test"


def test_codex_factory_preserves_headerless_filename_identity(tmp_path: Path):
    session_id = "bbbbbbbb-2222-4222-8222-222222222222"
    path = tmp_path / f"rollout-2026-09-16T12-00-00-{session_id}.jsonl"
    path.write_text("{}\n")
    source, host = source_context(path, harness="codex")
    reader = load_usage_reader(ReaderRef("usage_inspection_codex", 6, 1))
    cursor = SourceCursor(source.source_id, "", 0, 0, host.fingerprint())

    factory_batch = reader.capture(source, cursor, host)
    wrapper_batch = capture_codex_source(path)

    assert factory_batch.source.source_session_id == session_id
    assert factory_batch.source.source_session_id == wrapper_batch.source.source_session_id
