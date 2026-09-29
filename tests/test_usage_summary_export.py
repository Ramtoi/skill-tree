"""Canonical SQLite summaries feed the same atomic CLI export."""

from __future__ import annotations

import os
from datetime import datetime
from pathlib import Path

from test_usage_wave3_golden_baseline import (
    CLOCK,
    EXPECTED_ROOT,
    _assert_structural,
    _canonical_ledger,
    _capture_outputs,
    _comparable_value,
    _seed_inputs,
)

from skill_hub import hub_core
from skill_hub.application.usage import usage_summary_export
from skill_hub.infrastructure.usage.usage_inspection_store import InspectionStore


def _tracking_decode_worker(
    harness: str, path: str, cursor, deadline: float, result_path: str, reader_ref=None
) -> None:
    from unittest.mock import patch

    from skill_hub.application.usage import usage_inspection_scan
    from skill_hub.infrastructure.usage import usage_inspection_claude, usage_inspection_codex

    tracker = Path(os.environ["USAGE_TEST_DECODE_TRACKER"])
    module = usage_inspection_codex if harness == "codex" else usage_inspection_claude
    name = "capture_codex_source" if harness == "codex" else "capture_claude_source"
    capture = getattr(module, name)

    def tracked(source, *args, **kwargs):
        with tracker.open("a", encoding="utf-8") as stream:
            stream.write(str(source) + "\n")
        return capture(source, *args, **kwargs)

    with patch.object(module, name, tracked):
        usage_inspection_scan._portable_parse_worker(
            harness, path, cursor, deadline, result_path, reader_ref
        )


def test_canonical_export_matches_preserved_wave2_ledger(tmp_data_home, monkeypatch, capsys):
    monkeypatch.setenv("SKILL_HUB_NOW", CLOCK)
    _seed_inputs(tmp_data_home)
    _capture_outputs(monkeypatch, capsys)
    with InspectionStore.open() as store:
        context = usage_summary_export.prepare_context(
            store, "projection-test", hub_core.load_registry(), datetime.fromisoformat(CLOCK.replace("Z", "+00:00"))
        )
        usage_summary_export.refresh_and_export(store, context=context)
        first = (tmp_data_home / "state/usage/sessions.jsonl").read_bytes()
        usage_summary_export.refresh_and_export(store, context=context)
        assert (tmp_data_home / "state/usage/sessions.jsonl").read_bytes() == first
    actual = _canonical_ledger(tmp_data_home / "state/usage/sessions.jsonl")
    expected = (EXPECTED_ROOT / "session_rows.json").read_text()
    _assert_structural(_comparable_value("session_rows", expected), _comparable_value("session_rows", actual))


def test_public_scan_has_only_one_native_decode_path(tmp_data_home, monkeypatch):
    from skill_hub.application.usage import usage_inspection_scan
    from skill_hub.infrastructure.usage import usage_scan, usage_scan_codex

    monkeypatch.setenv("SKILL_HUB_NOW", CLOCK)
    _seed_inputs(tmp_data_home)

    def retired(*args, **kwargs):
        raise AssertionError("duplicate native parser was invoked")

    monkeypatch.setattr(usage_scan_codex, "scan_sessions", retired)
    tracker = tmp_data_home / "decode-paths.txt"
    monkeypatch.setenv("USAGE_TEST_DECODE_TRACKER", str(tracker))
    original_parse = usage_inspection_scan._portable_parse

    def portable_parse(
        harness,
        path,
        cursor,
        seconds,
        *,
        worker_target=usage_inspection_scan._portable_parse_worker,
        reader_ref=None,
    ):
        return original_parse(
            harness,
            path,
            cursor,
            seconds,
            worker_target=_tracking_decode_worker,
            reader_ref=reader_ref,
        )

    monkeypatch.setattr(usage_inspection_scan, "_signal_guard_available", lambda: False)
    monkeypatch.setattr(usage_inspection_scan, "_portable_parse", portable_parse)
    result = usage_scan.scan_sessions(order="path", budget_seconds=60)
    assert result["ok"], result
    calls = tracker.read_text(encoding="utf-8").splitlines()
    assert len(calls) == 5
    assert len(set(calls)) == 5
    with InspectionStore.open() as store:
        assert store.db.execute("SELECT COUNT(*) FROM canonical_session_summaries").fetchone()[0] == 4


def test_export_does_not_attach_capture_to_legacy_and_reads_inspection_in_transaction(tmp_data_home, monkeypatch):
    import json

    path = tmp_data_home / "state/usage/sessions.jsonl"
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps({"schema_version": 1, "harness": "claude-code", "session_id": "legacy"}) + "\n")
    with InspectionStore.open() as store:
        context = usage_summary_export.prepare_context(
            store, "legacy-export", {}, datetime.fromisoformat(CLOCK.replace("Z", "+00:00"))
        )

        def inspection():
            assert store.db.in_transaction, "inspection must share the projection transaction"
            return {"sessions": [{"harness": "claude-code", "session_id": "legacy", "runs": ["partial"]}]}

        monkeypatch.setattr(store, "index_payload", inspection)
        usage_summary_export.refresh_and_export(store, context=context)
    row = json.loads(path.read_text())
    assert row["summary_provenance"] == "legacy_import"
    assert "inspection" not in row
