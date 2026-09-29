"""Canonical reducer parity against the frozen wave-3 session rows."""

from __future__ import annotations

import json
from datetime import datetime

from test_usage_wave3_golden_baseline import CLOCK, EXPECTED_ROOT, _capture_outputs, _seed_inputs

from skill_hub import hub_core
from skill_hub.application.usage.usage_summary import project_session
from skill_hub.infrastructure.usage import usage_loadouts
from skill_hub.infrastructure.usage.usage_inspection_store import InspectionStore

CANONICAL = (
    ("claude-code", "aaaaaaaa-1111-4111-8111-111111111111"),
    ("codex", "cccccccc-3333-4333-8333-333333333333"),
    ("codex", "dddddddd-4444-4444-8444-444444444444"),
    ("codex", "eeeeeeee-5555-4555-8555-555555555555"),
)


def _expected() -> dict[tuple[str, str], dict]:
    rows = {}
    for line in (EXPECTED_ROOT / "session_rows.json").read_text().splitlines():
        row = json.loads(line)
        rows[(row["harness"], row["session_id"])] = row
    return rows


def _comparable(row: dict) -> dict:
    return {
        key: value
        for key, value in row.items()
        if key not in {"inspection", "frozen", "summary_provenance", "capture_coverage"}
    }


def test_published_facts_reduce_to_every_canonical_frozen_summary(
    tmp_data_home, monkeypatch, capsys
) -> None:
    monkeypatch.setenv("SKILL_HUB_NOW", CLOCK)
    _seed_inputs(tmp_data_home)
    _capture_outputs(monkeypatch, capsys)
    expected = _expected()
    registry = hub_core.load_registry()
    loadouts, _warnings = usage_loadouts.read_loadout_rows()
    now = datetime.fromisoformat(CLOCK.replace("Z", "+00:00"))

    with InspectionStore.open() as store:
        actual = {
            key: project_session(
                *key,
                facts=store.summary_facts(*key),
                registry=registry,
                loadout_rows=loadouts,
                now=now,
                tracked_files=expected[key]["tracked_files"],
            )
            for key in CANONICAL
        }

    mismatches = {}
    for key in CANONICAL:
        actual_row = _comparable(actual[key])
        expected_row = _comparable(expected[key])
        fields = set(actual_row) | set(expected_row)
        differing = sorted(field for field in fields if actual_row.get(field) != expected_row.get(field))
        if differing:
            mismatches[key] = differing
    assert not mismatches, mismatches
