"""Contracts for the source-bound Usage host context."""

from __future__ import annotations

import os
import time
from dataclasses import FrozenInstanceError
from pathlib import Path

import pytest

from skill_hub.domain.harnesses.harness_usage_api import ReaderSource, SourceCursor
from skill_hub.infrastructure.usage.usage_capture_io import source_fingerprint
from skill_hub.infrastructure.usage.usage_reader_context import SourceBoundCaptureHost, probe_source, source_context


def test_source_context_keeps_lexical_source_immutable_without_path_authority(tmp_path: Path):
    source_path = tmp_path / "session.jsonl"
    source_path.write_bytes(b"{}\n")
    source, host = source_context(
        source_path, harness="claude-code", source_id="claude:test"
    )

    assert source == ReaderSource("claude:test", "claude-code", "session", str(source_path))
    assert isinstance(source.lexical_path, str)
    assert source.path == str(source_path)
    with pytest.raises(FrozenInstanceError):
        source.source_id = "changed"  # type: ignore[misc]
    assert host.source_path == source_path


def test_host_operations_are_bound_to_one_source_and_clamp_deadline(tmp_path: Path):
    source_path = tmp_path / "session.jsonl"
    source_path.write_bytes(b"{}\n")
    host = SourceBoundCaptureHost(source_path, deadline=time.monotonic() - 1)

    with pytest.raises(TimeoutError, match="source budget exceeded"):
        host.fingerprint()

    fingerprint = source_fingerprint(source_path)
    cursor = SourceCursor("claude:test", "", 0, 0, fingerprint)
    later = SourceBoundCaptureHost(source_path, deadline=time.monotonic() + 10)
    raw, _, start, end, partial = later.read_complete_suffix(
        cursor, deadline=time.monotonic() + 100
    )
    assert (raw, start, end, partial) == (b"{}\n", 0, 3, False)


def test_host_passes_a_clamped_deadline_to_reader_services(tmp_path: Path):
    source_path = tmp_path / "session.jsonl"
    source_path.write_bytes(b"{}\n")
    observed: list[float | None] = []
    host_deadline = time.monotonic() + 10

    def read_suffix(path, cursor, *, deadline):
        observed.append(deadline)
        return b"", source_fingerprint(path), cursor.offset, cursor.offset, False

    host = SourceBoundCaptureHost(
        source_path,
        deadline=host_deadline,
        read_complete_suffix_fn=read_suffix,
    )
    cursor = SourceCursor("claude:test", "", 0, 0, host.fingerprint())
    host.read_complete_suffix(cursor, deadline=host_deadline + 10)
    assert observed == [host_deadline]


def test_portable_probe_seed_is_source_bound_and_reused(tmp_path: Path):
    source_path = tmp_path / "session.jsonl"
    source_path.write_text('{"type":"assistant","sessionId":"seed"}\n')
    source_id = "claude:seed"
    probe_host = SourceBoundCaptureHost(source_path, source_id=source_id)
    probe = probe_source(probe_host)
    worker_host = SourceBoundCaptureHost(source_path, source_id=source_id)

    assert probe.raw_prefix
    assert worker_host.install_probe_seed(probe) is True
    assert worker_host.decoded_records(probe.raw_prefix, probe.snapshot, 0) == probe.records

    changed = tmp_path / "changed.jsonl"
    changed.write_text(source_path.read_text())
    assert SourceBoundCaptureHost(changed, source_id=source_id).install_probe_seed(probe) is False


def test_nested_child_attachments_use_the_legacy_session_tool_results_root(tmp_path: Path, monkeypatch):
    transcript = tmp_path / "session" / "subagents" / "workflow" / "agent-child.jsonl"
    transcript.parent.mkdir(parents=True)
    transcript.write_text("{}\n")
    tool_results = transcript.parent.parent / "tool-results"
    tool_results.mkdir()
    attachment = tool_results / "result.txt"
    attachment.write_bytes(b"child output")
    outside = tmp_path / "outside.txt"
    outside.write_bytes(b"outside output")
    import skill_hub.infrastructure.usage.usage_reader_context as usage_reader_context

    legacy_capture = usage_reader_context.capture_attachment
    calls = []

    def capture_with_recorded_root(path, root, *, locator, max_bytes):
        calls.append((path, root, locator, max_bytes))
        return legacy_capture(path, root, locator=locator, max_bytes=max_bytes)

    monkeypatch.setattr(usage_reader_context, "capture_attachment", capture_with_recorded_root)
    host = SourceBoundCaptureHost(transcript)
    captured = host.capture_attachment(str(attachment), max_bytes=100)
    assert calls == [(attachment, tool_results, str(attachment), 100)]
    assert captured == legacy_capture(attachment, tool_results, locator=str(attachment), max_bytes=100)
    if os.open in os.supports_dir_fd:
        assert captured.bytes_value == b"child output"
    else:
        # The existing confined reader requires descriptor-relative opens.
        # Unsupported hosts retain its explicit unavailable result.
        assert captured.status == "unavailable"
        assert captured.bytes_value is None
    rejected = host.capture_attachment(str(outside), max_bytes=100)
    assert rejected.status == "unavailable"
    assert rejected.bytes_value is None
