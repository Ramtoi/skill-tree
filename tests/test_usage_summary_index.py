"""The app can distinguish complete canonical token scope from provider totals."""

import json

from test_usage_wave3_golden_baseline import CLOCK, _seed_inputs

from skill_hub.infrastructure.usage import usage_scan
from skill_hub.infrastructure.usage.usage_inspection_store import InspectionStore


def test_index_exposes_committed_summary_coverage_for_root_and_children(tmp_data_home, monkeypatch):
    monkeypatch.setenv("SKILL_HUB_NOW", CLOCK)
    _seed_inputs(tmp_data_home)
    assert usage_scan.scan_sessions(order="path", budget_seconds=60)["ok"]
    with InspectionStore.open() as store:
        rows = store.index_payload()["sessions"]
        assert rows
        for row in rows:
            assert row["summary_provenance"] == "canonical"
            assert row["capture_coverage"] == "complete"
            for child in row["agents"]:
                assert child["summary_provenance"] == "canonical"
                assert child["capture_coverage"] == "complete"


def test_index_never_infers_complete_coverage_from_retained_tokens(tmp_data_home, monkeypatch):
    monkeypatch.setenv("SKILL_HUB_NOW", CLOCK)
    _seed_inputs(tmp_data_home)
    assert usage_scan.scan_sessions(order="path", budget_seconds=60)["ok"]
    with InspectionStore.open() as store:
        initial = store.index_payload()["sessions"][0]
        key = (initial["harness"], initial["session_id"])
        stored = store.db.execute(
            "SELECT payload_json FROM canonical_session_summaries WHERE harness=? AND session_id=?", key
        ).fetchone()
        payload = json.loads(stored[0])
        payload["capture_coverage"] = "partial"
        store.db.execute(
            "UPDATE canonical_session_summaries SET payload_json=? WHERE harness=? AND session_id=?",
            (json.dumps(payload), *key),
        )
        partial = next(row for row in store.index_payload()["sessions"]
                       if (row["harness"], row["session_id"]) == key)
        assert partial["capture_coverage"] == "partial"
        assert partial["scopes"] == initial["scopes"]
        assert all(child["capture_coverage"] == "partial" for child in partial["agents"])
        store.db.execute("DELETE FROM canonical_session_summaries WHERE harness=? AND session_id=?", key)
        missing = next(row for row in store.index_payload()["sessions"]
                       if (row["harness"], row["session_id"]) == key)
        assert missing["capture_coverage"] == "unavailable"
        assert missing["summary_provenance"] is None
        assert missing["scopes"] == initial["scopes"]
