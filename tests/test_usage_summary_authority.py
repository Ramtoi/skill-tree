"""Committed summary rows remain readable while an export is retried."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from skill_hub.application.usage import usage_inspection, usage_summary_export, usage_summary_projection
from skill_hub.infrastructure.usage import usage_scan
from skill_hub.infrastructure.usage.usage_inspection_store import InspectionStore


def _canonical_row() -> dict[str, object]:
    return {
        "schema_version": 1,
        "harness": "claude-code",
        "session_id": "authority-session",
        "project": "alpha",
        "frozen": False,
        "summary_provenance": "canonical",
        "capture_coverage": "complete",
    }


def _insert_canonical(store: InspectionStore, row: dict[str, object], revision: int = 1) -> None:
    payload = json.dumps(row, sort_keys=True, separators=(",", ":"))
    digest = hashlib.sha256(payload.encode()).hexdigest()
    store.db.execute(
        "INSERT INTO canonical_session_summaries "
        "(harness,session_id,payload_json,payload_digest,context_digest,revision) "
        "VALUES (?,?,?,?,?,?)",
        (row["harness"], row["session_id"], payload, digest, "0" * 64, revision),
    )


def _summary_context() -> dict[str, object]:
    return {
        "registry": {"skills": {}},
        "loadout_rows": [],
        "tracked_files": {},
        "now": "2026-09-17T12:00:00Z",
    }


def test_failed_export_keeps_committed_summary_and_retry_advances_revision(
    tmp_data_home, monkeypatch
):
    old_bytes = b'{"stale":true}\n'
    path = tmp_data_home / "state/usage/sessions.jsonl"
    path.parent.mkdir(parents=True)
    path.write_bytes(old_bytes)

    with InspectionStore.open() as store:
        row = _canonical_row()
        _insert_canonical(store, row, revision=7)
        store.db.execute("UPDATE metadata SET value='7' WHERE key='canonical_revision'")
        store.db.execute("UPDATE metadata SET value='6' WHERE key='projection_revision'")
        store.db.execute(
            "INSERT INTO usage_summary_metadata(key,value) VALUES ('legacy_import_complete','1')"
        )
        assert usage_summary_projection.effective_summaries(store.db) == [row]

        original_replace = usage_summary_export.os.replace
        calls = 0

        def fail_once(source, destination):
            nonlocal calls
            calls += 1
            if calls == 1:
                raise OSError("simulated export interruption")
            return original_replace(source, destination)

        monkeypatch.setattr(usage_summary_export.os, "replace", fail_once)
        with pytest.raises(OSError, match="simulated export interruption"):
            usage_inspection.rebuild_summary_projection(store)

        assert path.read_bytes() == old_bytes
        assert usage_scan.read_session_rows()[0] == [row]
        assert store.db.execute(
            "SELECT value FROM metadata WHERE key='projection_revision'"
        ).fetchone()[0] == "6"

        monkeypatch.setattr(usage_summary_export.os, "replace", original_replace)
        assert usage_inspection.rebuild_summary_projection(store) == 7
        first = path.read_bytes()
        assert store.db.execute(
            "SELECT value FROM metadata WHERE key='projection_revision'"
        ).fetchone()[0] == "7"

        assert usage_inspection.rebuild_summary_projection(store) == 7
        assert path.read_bytes() == first
        exported = json.loads(first)
        assert exported["session_id"] == "authority-session"
        assert exported["summary_provenance"] == "canonical"

        path.unlink()
        assert usage_inspection.rebuild_summary_projection(store) == 7
        assert path.read_bytes() == first


def test_completed_import_marker_ignores_new_file_rows_on_refresh(tmp_data_home):
    path = tmp_data_home / "state/usage/sessions.jsonl"
    path.parent.mkdir(parents=True)
    old = {"harness": "claude-code", "session_id": "old-file", "project": "alpha"}
    new = {"harness": "claude-code", "session_id": "new-file", "project": "alpha"}
    path.write_text(json.dumps(old) + "\n")

    with InspectionStore.open() as store:
        usage_summary_export.refresh_and_export(store, context=_summary_context())
        path.write_text(json.dumps(new) + "\n")

        usage_summary_export.refresh_and_export(store, context=_summary_context())
        usage_summary_export.refresh_and_export(store, context=_summary_context())

        rows = usage_summary_projection.effective_summaries(store.db)
        assert [(row["harness"], row["session_id"]) for row in rows] == [("claude-code", "old-file")]
        assert [json.loads(line)["session_id"] for line in path.read_text().splitlines()] == ["old-file"]


def test_refresh_recovers_from_invalid_utf8_export_after_import(tmp_data_home):
    path = tmp_data_home / "state/usage/sessions.jsonl"
    path.parent.mkdir(parents=True)
    path.write_bytes(b"\xff")

    with InspectionStore.open() as store:
        row = _canonical_row()
        _insert_canonical(store, row)
        store.db.execute(
            "INSERT INTO usage_summary_metadata(key,value) VALUES ('legacy_import_complete','1')"
        )

        usage_summary_export.refresh_and_export(store, context=_summary_context())

        assert json.loads(path.read_bytes())["session_id"] == row["session_id"]


def test_rebuild_recovers_from_invalid_utf8_export_after_import(tmp_data_home):
    path = tmp_data_home / "state/usage/sessions.jsonl"
    path.parent.mkdir(parents=True)
    path.write_bytes(b"\xff")

    with InspectionStore.open() as store:
        row = _canonical_row()
        _insert_canonical(store, row)
        store.db.execute("UPDATE metadata SET value='1' WHERE key='canonical_revision'")
        store.db.execute(
            "INSERT INTO usage_summary_metadata(key,value) VALUES ('legacy_import_complete','1')"
        )

        assert usage_inspection.rebuild_summary_projection(store) == 1
        assert json.loads(path.read_bytes())["session_id"] == row["session_id"]


def test_default_reads_use_sqlite_and_report_import_rejections(tmp_data_home):
    path = tmp_data_home / "state/usage/sessions.jsonl"
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps({**_canonical_row(), "session_id": "stale-file"}) + "\n")

    with InspectionStore.open() as store:
        row = _canonical_row()
        _insert_canonical(store, row)
        store.db.execute(
            "INSERT INTO usage_summary_metadata(key,value) VALUES "
            "('last_import_rejected','2'),('legacy_import_complete','1')"
        )

    rows, warnings = usage_scan.read_session_rows()
    assert rows == [row]
    assert warnings == ["SQLite summary import rejected 2 row(s)"]


def test_existing_db_without_import_marker_still_reads_legacy_file(tmp_data_home):
    row = {
        "harness": "claude-code",
        "session_id": "legacy-session",
        "project": "alpha",
        "started_at": "2026-09-17T12:00:00Z",
        "last_activity_at": "2026-09-17T12:01:00Z",
        "frozen": False,
    }
    path = tmp_data_home / "state/usage/sessions.jsonl"
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps(row) + "\n")

    original_bytes = path.read_bytes()
    with InspectionStore.open() as store:
        store.db.execute("UPDATE metadata SET value='7' WHERE key='canonical_revision'")
        usage_inspection.rebuild_summary_projection(store)
        assert path.read_bytes() == original_bytes
        assert store.db.execute(
            "SELECT 1 FROM usage_summary_metadata "
            "WHERE key='legacy_import_complete'"
        ).fetchone() is None

    assert usage_scan.read_session_rows() == ([row], [])

    with InspectionStore.open() as store:
        store.db.execute(
            "INSERT INTO usage_summary_metadata(key,value) "
            "VALUES ('legacy_import_complete','1')"
        )

    assert usage_scan.read_session_rows() == ([], [])


def test_explicit_path_keeps_legacy_validation_and_warnings(tmp_path: Path):
    row = {
        "harness": "claude-code",
        "session_id": "file-session",
        "project": "alpha",
        "started_at": "2026-09-17T12:00:00Z",
        "last_activity_at": "2026-09-17T12:01:00Z",
        "frozen": False,
    }
    path = tmp_path / "sessions.jsonl"
    path.write_text(json.dumps(row) + "\nnot-json\n")

    rows, warnings = usage_scan.read_session_rows(path)
    assert rows == [row]
    assert len(warnings) == 1
    assert "dropped malformed session row" in warnings[0]


def test_last_scan_at_uses_committed_metadata(tmp_data_home):
    cursor = usage_scan.cursor_path()
    cursor.parent.mkdir(parents=True)
    cursor.write_text(json.dumps({"last_scan_at": "sidecar-value", "files": {}}))
    assert usage_scan.last_scan_at() == "sidecar-value"

    with InspectionStore.open() as store:
        assert usage_scan.last_scan_at() == "sidecar-value"
        store.db.execute(
            "INSERT INTO metadata(key,value) VALUES ('summary_last_scan_at','2026-09-17T12:00:00+00:00')"
        )

    assert usage_scan.last_scan_at() == "2026-09-17T12:00:00.000Z"


def test_summary_read_uses_one_transaction_snapshot(tmp_data_home, monkeypatch):
    with InspectionStore.open() as store:
        _insert_canonical(store, _canonical_row())
        store.db.execute(
            "INSERT INTO usage_summary_metadata(key,value) VALUES ('legacy_import_complete','1')"
        )
    original = usage_summary_projection.effective_summaries
    snapshots = []

    def observed(db):
        # The two-table canonical/legacy selection must share a snapshot.
        snapshots.append(db.in_transaction)
        return original(db)

    monkeypatch.setattr(usage_summary_projection, "effective_summaries", observed)
    assert usage_scan.read_session_rows()[0] == [_canonical_row()]
    assert snapshots == [True]


def test_retry_repairs_changed_summary_at_equal_capture_revision(tmp_data_home, monkeypatch):
    with InspectionStore.open() as store:
        row = _canonical_row()
        _insert_canonical(store, row, revision=0)
        store.db.execute(
            "INSERT INTO usage_summary_metadata(key,value) VALUES ('legacy_import_complete','1')"
        )
        usage_inspection.rebuild_summary_projection(store)
        path = usage_scan.sessions_path()
        old = path.read_bytes()
        changed = {**row, "capture_coverage": "partial"}
        store.db.execute("UPDATE canonical_session_summaries SET payload_json=?", (json.dumps(changed),))
        replace = usage_summary_export.os.replace

        def failed(*args):
            raise OSError("rename failed")

        monkeypatch.setattr(usage_summary_export.os, "replace", failed)
        with pytest.raises(OSError, match="rename failed"):
            usage_inspection.rebuild_summary_projection(store)
        assert usage_scan.read_session_rows()[0] == [changed]
        assert path.read_bytes() == old
        monkeypatch.setattr(usage_summary_export.os, "replace", replace)
        usage_inspection.rebuild_summary_projection(store)
        assert json.loads(path.read_bytes())["capture_coverage"] == "partial"


def test_retry_exports_current_populated_inspection_and_pin(tmp_data_home, monkeypatch):
    from test_usage_wave3_golden_baseline import CLOCK, _seed_inputs

    monkeypatch.setenv("SKILL_HUB_NOW", CLOCK)
    _seed_inputs(tmp_data_home)
    assert usage_scan.scan_sessions(order="path", budget_seconds=60)["ok"]
    path = usage_scan.sessions_path()
    old = path.read_bytes()
    with InspectionStore.open() as store:
        initial = store.index_payload()["sessions"][0]
        key = (initial["harness"], initial["session_id"])
        assert store.mutate_pin(*key, None, "add")["ok"]
        expected = next(row for row in store.index_payload()["sessions"]
                        if (row["harness"], row["session_id"]) == key)
        assert expected["pinned"] is True
        assert expected["scopes"]["own"]["tokens"]["total"] > 0
        replace = usage_summary_export.os.replace

        def failed(*args):
            raise OSError("pin export interrupted")

        monkeypatch.setattr(usage_summary_export.os, "replace", failed)
        with pytest.raises(OSError, match="pin export interrupted"):
            usage_inspection.rebuild_summary_projection(store)
        assert path.read_bytes() == old
        monkeypatch.setattr(usage_summary_export.os, "replace", replace)
        usage_inspection.rebuild_summary_projection(store)
        exported = next(row for row in map(json.loads, path.read_text().splitlines())
                        if (row["harness"], row["session_id"]) == key)
        assert exported["inspection"] == expected
        assert store.list_pins()["items"]


def test_initial_import_rejections_remain_durable_after_refresh(tmp_data_home):
    path = tmp_data_home / "state/usage/sessions.jsonl"
    path.parent.mkdir(parents=True)
    valid = {"harness": "claude-code", "session_id": "retained", "project": "alpha"}
    path.write_text("not-json\n[]\n{}\n" + json.dumps(valid) + "\n")

    with InspectionStore.open() as store:
        result = usage_summary_export.refresh_and_export(store, context=_summary_context())
        assert result["malformed_rows_dropped"] == 3

    for _ in range(2):
        with InspectionStore.open() as store:
            result = usage_summary_export.refresh_and_export(store, context=_summary_context())
            assert result["malformed_rows_dropped"] == 3
            assert store.db.execute(
                "SELECT value FROM usage_summary_metadata WHERE key='last_import_rejected'"
            ).fetchone()[0] == "3"
        rows, warnings = usage_scan.read_session_rows()
        assert [row["session_id"] for row in rows] == ["retained"]
        assert warnings == ["SQLite summary import rejected 3 row(s)"]
