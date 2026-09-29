from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from skill_hub.application.usage import usage_inspection, usage_inspection_scan
from skill_hub.application.usage.usage_inspection import index_payload, mutate_pin
from skill_hub.infrastructure.usage.usage_inspection_claude import capture_claude_source
from skill_hub.infrastructure.usage.usage_inspection_store import db_path

SESSION = "aaaaaaaa-1111-4111-8111-111111111111"


def _write_source(root: Path, *, added: int = 7) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    path = root / f"{SESSION}.jsonl"
    path.write_text(json.dumps({
        "type": "cost-state", "totalLinesAdded": added,
        "totalLinesRemoved": 2, "totalDuration": 31,
    }) + "\n")
    return path


def test_scan_backfill_failure_retry_preserves_facts_pin_and_scan_id(tmp_data_home, tmp_path, monkeypatch):
    root = tmp_path / "claude"
    path = _write_source(root)
    initial = capture_claude_source(path)
    assert usage_inspection.merge_capture(initial).outcome == "captured"
    assert mutate_pin("claude-code", SESSION, initial.runs[0].run_id, "add")["ok"] is True

    with sqlite3.connect(db_path()) as db:
        db.execute("UPDATE metadata SET value='2' WHERE key='schema_version'")
        db.execute("UPDATE sources SET reader_revision=3 WHERE source_id=?", (initial.source.source_id,))
        db.commit()

    original_parse = usage_inspection_scan._portable_parse
    calls = 0

    def fail_once(*args, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise RuntimeError("injected backfill failure")
        return original_parse(*args, **kwargs)

    monkeypatch.setattr(usage_inspection_scan, "_signal_guard_available", lambda: False)
    monkeypatch.setattr(usage_inspection_scan, "_portable_parse", fail_once)
    failed = usage_inspection_scan.capture_pass({"claude-code": root}, now=None)
    assert failed["state"] == "stopped"
    assert failed["sources_incomplete"] == 1
    scan_id = failed["scan_id"]
    assert index_payload()["sessions"][0]["native"]["own"]["lines_added"] == 7
    assert mutate_pin("claude-code", SESSION, initial.runs[0].run_id, "add")["ok"] is True

    retried = usage_inspection_scan.capture_pass(
        {"claude-code": root}, scan_id=scan_id, retry_incomplete=True,
    )
    assert retried["scan_id"] == scan_id
    assert retried["state"] == "complete"
    assert retried["sources_incomplete"] == 0
    assert index_payload()["sessions"][0]["native"]["own"]["lines_added"] == 7

    next_pass = usage_inspection_scan.capture_pass({"claude-code": root})
    assert next_pass["scan_id"] != scan_id
    assert next_pass["sources_skipped_unchanged"] == 1
    assert next_pass["sources_processed"] == 0
    assert index_payload()["sessions"][0]["native"]["own"]["lines_added"] == 7
