from __future__ import annotations

import json
from pathlib import Path

import pytest

from skill_hub.domain.harnesses.harness_usage_api import SourceProbe, capture_records
from skill_hub.infrastructure.usage.usage_inspection_claude import recognize_source as recognize_claude
from skill_hub.infrastructure.usage.usage_inspection_codex import recognize_source as recognize_codex
from skill_hub.infrastructure.usage.usage_jsonl import (
    JsonlFramingDeadlineError,
    complete_jsonl_prefix,
    decode_jsonl_records,
)
from skill_hub.infrastructure.usage.usage_reader_context import SourceBoundCaptureHost, probe_source


def _line(value: object) -> bytes:
    return json.dumps(value, separators=(",", ":")).encode() + b"\n"


def test_probe_counts_invalid_and_nonobject_frames_within_record_limit(tmp_path: Path):
    path = tmp_path / "session.jsonl"
    path.write_bytes(b"not-json\n" + _line([1, 2]) + _line({"sessionId": "s"}) + _line({"message": {}}))

    probe = probe_source(SourceBoundCaptureHost(path))

    assert probe.complete_record_count == 4
    assert len(probe.records) == 2
    assert probe.stop_reason == "eof"
    assert probe.complete_end == path.stat().st_size


def test_probe_uses_legacy_splitlines_for_cr_and_unicode_boundaries(tmp_path: Path):
    path = tmp_path / "mixed-lines.jsonl"
    raw = b"{}\r" * 40 + "{\"sessionId\":\"s\"}\u2028".encode("utf-8")
    path.write_bytes(raw)

    probe = probe_source(SourceBoundCaptureHost(path))

    assert probe.complete_record_count == 32
    assert probe.stop_reason == "record_limit"
    safe, reason, count = complete_jsonl_prefix(raw, max_records=32)
    assert (safe, reason, count) == (raw[: 32 * 3], "record_limit", 32)


def test_full_decoder_matches_replacement_and_splitlines():
    raw = b'{"ok":1}\r\nnot-json\x80\n[1,2]' + '{"ok":2}\u2028'.encode("utf-8")
    expected = []
    for line in raw.decode("utf-8", errors="replace").splitlines():
        try:
            value = json.loads(line)
        except ValueError:
            continue
        if isinstance(value, dict):
            expected.append(value)

    assert decode_jsonl_records(raw) == tuple(expected)


def test_probe_read_accounting_includes_tail_sentinel(tmp_path: Path):
    path = tmp_path / "accounted.jsonl"
    path.write_bytes(b"{}\n" * 30000)

    probe = probe_source(SourceBoundCaptureHost(path))

    assert probe.bytes_read == 64 * 1024


def test_probe_is_bounded_and_leaves_partial_tail_unread(tmp_path: Path):
    path = tmp_path / "large.jsonl"
    path.write_bytes(b"".join(_line({"sessionId": str(i)}) for i in range(20000)) + b"partial")

    probe = probe_source(SourceBoundCaptureHost(path))

    assert probe.bytes_read <= 64 * 1024
    assert probe.complete_record_count <= 32
    assert probe.complete_end <= len(probe.raw_prefix)
    assert probe.stop_reason in {"record_limit", "byte_limit"}


def test_probe_deadline_is_reported_before_source_io(tmp_path: Path):
    path = tmp_path / "session.jsonl"
    path.write_bytes(_line({"sessionId": "s"}))

    probe = probe_source(SourceBoundCaptureHost(path), deadline=0.0)

    assert probe.stop_reason == "deadline"
    assert probe.bytes_read == 0


def test_optional_decoder_errors_are_not_hidden(tmp_path: Path):
    path = tmp_path / "session.jsonl"
    path.write_bytes(_line({"sessionId": "s"}))

    class FailingHost(SourceBoundCaptureHost):
        def decoded_records(self, raw, fingerprint, offset_start, *, deadline=None):
            raise RuntimeError("decoder extension failed")

    with pytest.raises(RuntimeError, match="decoder extension failed"):
        probe_source(FailingHost(path))


def test_decoded_prefix_cache_reuses_only_an_exact_snapshot(tmp_path: Path, monkeypatch):
    path = tmp_path / "session.jsonl"
    path.write_bytes(_line({"sessionId": "s", "nested": {"value": 1}}))
    calls = 0
    from skill_hub.infrastructure.usage import usage_reader_context

    original = usage_reader_context.decode_jsonl_records

    def counting(raw, **kwargs):
        nonlocal calls
        calls += 1
        return original(raw, **kwargs)

    monkeypatch.setattr(usage_reader_context, "decode_jsonl_records", counting)
    host = SourceBoundCaptureHost(path)
    first = probe_source(host)
    second = probe_source(host)
    assert first.records == second.records
    assert calls == 1

    path.write_bytes(_line({"sessionId": "s", "nested": {"value": 2}}))
    replaced = probe_source(host)
    assert replaced.stop_reason == "eof"
    assert replaced.records[0]["nested"]["value"] == 2
    path.write_bytes(_line({"sessionId": "s", "nested": {"value": 1}}))
    restored = probe_source(host)
    assert restored.records[0]["nested"]["value"] == 1
    assert calls == 3


def test_old_host_uses_pure_fallback_decoder():
    class LegacyHost:
        pass

    raw = _line({"sessionId": "s"})
    assert capture_records(LegacyHost(), raw, None, 0) == ({"sessionId": "s"},)


def test_fallback_decoder_honors_deadline_during_framing(monkeypatch):
    class LegacyHost:
        pass

    raw = b"{}\n" * 100
    calls = 0
    from skill_hub.infrastructure.usage import usage_jsonl

    def clock():
        nonlocal calls
        calls += 1
        return 0.0 if calls < 3 else 2.0

    monkeypatch.setattr(usage_jsonl.time, "monotonic", clock)
    with pytest.raises(JsonlFramingDeadlineError):
        capture_records(LegacyHost(), raw, None, 0, deadline=1.0)


def test_reader_recognition_is_structural_and_has_no_version_claim(tmp_path: Path):
    claude_path = tmp_path / "claude.jsonl"
    claude_path.write_bytes(_line({"sessionId": "s", "message": {}}))
    codex_path = tmp_path / "codex.jsonl"
    codex_path.write_bytes(_line({"type": "session_meta"}))

    claude = probe_source(SourceBoundCaptureHost(claude_path))
    codex = probe_source(SourceBoundCaptureHost(codex_path))

    assert recognize_claude(claude).producer == "claude-code"
    assert recognize_claude(claude).producer_version is None
    assert recognize_codex(codex).producer == "codex"
    assert recognize_codex(codex).producer_version is None


def test_codex_recognition_ignores_malformed_type_values():
    probe = SourceProbe("source", None, b"", ({"type": []}, {"type": {}}), 0, 0, 2, "eof")

    assert recognize_codex(probe).reason == "inconclusive"


@pytest.mark.parametrize(
    'separator', ['\n', '\r', '\r\n', '\v', '\f', '\x1c', '\x1d', '\x1e', '\x85', '\u2028', '\u2029']
)
def test_framing_preserves_raw_offsets_with_invalid_utf8(separator):
    from skill_hub.infrastructure.usage.usage_jsonl import iter_jsonl_frames

    first = b'{"text":"\xf0\x9f\x80\xff"}' + separator.encode()
    raw = first + b'{"next":1}\nunfinished\xe2'
    frames = list(iter_jsonl_frames(raw))
    assert [frame.text for frame in frames] == raw.decode('utf-8', errors='replace').splitlines()
    assert frames[0].end == len(first)
    assert complete_jsonl_prefix(raw, max_records=1)[0] == first


def test_probe_deadline_expires_during_actual_decoding(tmp_path, monkeypatch):
    from skill_hub.infrastructure.usage import usage_jsonl

    path = tmp_path / 'deadline.jsonl'
    path.write_bytes(_line({'sessionId': 's'}) * 20)
    clock = [0.0]
    decoded = []
    original = usage_jsonl.json.loads

    def decode_then_expire(line):
        decoded.append(line)
        value = original(line)
        clock[0] = 2.0
        return value

    monkeypatch.setattr(usage_jsonl.time, 'monotonic', lambda: clock[0])
    monkeypatch.setattr(usage_jsonl.json, 'loads', decode_then_expire)
    probe = probe_source(SourceBoundCaptureHost(path, deadline=1.0))
    assert probe.stop_reason == 'deadline'
    assert len(decoded) == 1
    assert probe.records == ()


def test_deadline_between_wrapper_and_host_does_no_io(tmp_path, monkeypatch):
    from skill_hub.infrastructure.usage import usage_reader_context

    clock = iter([0.0, 2.0])
    monkeypatch.setattr(usage_reader_context.time, 'monotonic', lambda: next(clock))
    probe = probe_source(SourceBoundCaptureHost(tmp_path / 'does-not-exist', deadline=1.0))
    assert probe.stop_reason == 'deadline'
    assert probe.bytes_read == 0


def test_capture_does_not_frame_or_decode_cached_prefix_again(tmp_path, monkeypatch):
    from skill_hub.infrastructure.usage import usage_jsonl

    path = tmp_path / 'cached.jsonl'
    raw = b''.join(_line({'value': i}) for i in range(40))
    path.write_bytes(raw)
    host = SourceBoundCaptureHost(path)
    probe = probe_source(host)
    framed = []
    original = usage_jsonl.iter_jsonl_frames

    def track_frames(data, **kwargs):
        framed.append(data)
        yield from original(data, **kwargs)

    monkeypatch.setattr(usage_jsonl, 'iter_jsonl_frames', track_frames)
    probe.records[0]['value'] = 'mutated probe'
    result = capture_records(host, raw, probe.snapshot, 0)
    assert tuple(row['value'] for row in result) == tuple(range(40))
    assert framed == [raw[probe.complete_end:]]
    framed.clear()
    assert capture_records(host, raw, probe.snapshot, 0) == result
    assert framed == [raw[probe.complete_end:]]
    assert host._decoded_prefix.raw == probe.raw_prefix
    framed.clear()
    suffix = raw[probe.complete_end:]
    assert capture_records(host, suffix, probe.snapshot, probe.complete_end) == result[32:]
    assert framed == [suffix]


def test_rewrite_during_probe_invalidates_cached_records(tmp_path, monkeypatch):
    import os

    path = tmp_path / 'replaced.jsonl'
    path.write_bytes(_line({'value': 1}))
    host = SourceBoundCaptureHost(path)
    probe_source(host)
    original = host.decoded_records

    def replace_after_decode(raw, fingerprint, offset_start, *, deadline=None):
        records = original(raw, fingerprint, offset_start, deadline=deadline)
        path.write_bytes(_line({'value': 2}))
        os.utime(path, ns=(fingerprint.mtime_ns + 1000000, fingerprint.mtime_ns + 1000000))
        return records

    monkeypatch.setattr(host, 'decoded_records', replace_after_decode)
    changed = probe_source(host)
    assert changed.stop_reason == 'source_changed'
    assert changed.records == ()
    assert host._decoded_prefix is None
    monkeypatch.setattr(host, 'decoded_records', original)
    assert probe_source(host).records == ({'value': 2},)


def test_probe_budget_counts_actual_reads(tmp_path, monkeypatch):
    path = tmp_path / 'reads.jsonl'
    path.write_bytes(b'{}\n' * 30000)
    original = Path.open
    reads = []

    class TrackedFile:
        def __init__(self, handle):
            self.handle = handle

        def __enter__(self):
            return self

        def __exit__(self, *args):
            self.handle.close()

        def read(self, size=-1):
            assert size >= 0
            data = self.handle.read(size)
            reads.append(len(data))
            return data

        def seek(self, offset):
            return self.handle.seek(offset)

    def tracked_open(source, *args, **kwargs):
        handle = original(source, *args, **kwargs)
        return TrackedFile(handle) if source == path else handle

    monkeypatch.setattr(Path, 'open', tracked_open)
    probe = probe_source(SourceBoundCaptureHost(path))
    assert sum(reads) == probe.bytes_read == 64 * 1024
    assert probe.raw_prefix == b'{}\n' * 32


def test_failed_capture_snapshot_discards_decoded_prefix(tmp_path, monkeypatch):
    from skill_hub.infrastructure.usage import usage_reader_context

    path = tmp_path / "cas.jsonl"
    raw = _line({"value": 1})
    path.write_bytes(raw)
    host = SourceBoundCaptureHost(path, snapshot_matches_fn=lambda _path, _fp: False)
    decoded = []
    original = usage_reader_context.decode_jsonl_records

    def count_decodes(data, **kwargs):
        decoded.append(data)
        return original(data, **kwargs)

    monkeypatch.setattr(usage_reader_context, "decode_jsonl_records", count_decodes)
    probe = probe_source(host)
    assert capture_records(host, raw, probe.snapshot, 0) == probe.records
    assert decoded == [raw]
    assert host.snapshot_matches(probe.snapshot) is False
    assert capture_records(host, raw, probe.snapshot, 0) == probe.records
    assert decoded == [raw, raw]
