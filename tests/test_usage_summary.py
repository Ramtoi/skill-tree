"""Pure canonical summary reducer contracts."""

from __future__ import annotations

from datetime import datetime, timezone

from skill_hub.application.usage.usage_summary import project_session

ROOT = "root"


def _facts() -> dict:
    return {
        "coverage": [{"source_id": "root", "status": "complete"}],
        "structural": [
            {
                "record_type": "source_scope",
                "harness": "claude-code",
                "source_session_id": ROOT,
                "root_session_id": ROOT,
                "parent_session_id": None,
                "project_key": "alpha",
                "source_ordinal": 0,
            },
            {
                "run_id": ROOT,
                "kind": "human_turn",
                "message_id": "m1",
                "at": "2026-09-17T08:00:00Z",
                "source_ordinal": 0,
                "block_ordinal": 0,
                "role_ordinal": 0,
                "invoker": "you",
            },
            {
                "run_id": ROOT,
                "kind": "tool",
                "name": "touchpoint/get_goal",
                "at": "2026-09-17T08:00:00Z",
                "source_ordinal": 0,
                "block_ordinal": 2,
                "role_ordinal": 0,
                "invoker": "model",
                "additive": True,
            },
        ],
        "run": [
            {
                "run_id": ROOT,
                "harness": "claude-code",
                "root_session_id": ROOT,
                "source_session_id": ROOT,
                "parent_run_id": None,
                "started_at": "2026-09-17T08:00:00Z",
                "ended_at": "2026-09-17T08:05:00Z",
                "models": ["claude"],
            },
            {
                "run_id": "child",
                "harness": "claude-code",
                "root_session_id": ROOT,
                "source_session_id": "child",
                "parent_run_id": ROOT,
                "started_at": "2026-09-17T08:01:00Z",
                "ended_at": "2026-09-17T08:02:00Z",
                "role": "review",
                "models": ["claude"],
            },
        ],
        "token": [
            {
                "run_id": ROOT,
                "origin": "native",
                "at": "2026-09-17T08:00:00Z",
                "input": 100,
                "output": 10,
                "cache_creation": 0,
                "cache_read": 0,
                "cumulative": False,
                "source_ordinal": 0,
            },
            {
                "run_id": ROOT,
                "origin": "event_mirror",
                "at": "2026-09-17T08:00:00Z",
                "input": 999,
                "output": 0,
                "cache_creation": 0,
                "cache_read": 0,
                "cumulative": True,
                "source_ordinal": 1,
            },
            {
                "run_id": "child",
                "origin": "native",
                "at": "2026-09-17T08:01:00Z",
                "input": 700,
                "output": 10,
                "cache_creation": 0,
                "cache_read": 0,
                "cumulative": False,
                "source_ordinal": 1,
            },
        ],
        "message": [
            {
                "message_id": "m1",
                "run_id": ROOT,
                "kind": "human_turn",
                "at": "2026-09-17T08:00:00Z",
                "excerpt": "Plan the review",
                "text_len": 15,
                "thinking_len": 0,
                "is_steering": False,
                "source_ordinal": 0,
                "block_ordinal": 0,
                "role_ordinal": 0,
            }
        ],
        "call": [
            {
                "run_id": ROOT,
                "activity_class": "verify",
                "read_file_hash": "path:a",
                "at": "2026-09-17T08:00:00Z",
                "source_ordinal": 0,
                "block_ordinal": 1,
                "role_ordinal": 0,
            }
        ],
    }


def test_reduces_root_own_and_child_tokens_without_mirror_double_counting() -> None:
    row = project_session(
        "claude-code",
        ROOT,
        facts=_facts(),
        registry={"skills": {}},
        loadout_rows=[],
        now=datetime(2026, 9, 17, 12, tzinfo=timezone.utc),
        tracked_files=4,
    )

    assert row["tokens"] == {
        "input": 100,
        "output": 10,
        "cache_creation": 0,
        "cache_read": 0,
        "total": 110,
        "subagent_total": 710,
    }
    assert row["activity"]["verify"] == 1
    assert row["files_read"] == 1 and row["tracked_files"] == 4
    assert row["capture_coverage"] == "complete" and row["summary_provenance"] == "canonical"
    assert row["events"][0]["excerpt"] == "Plan the review"
    assert row["events"][0]["token_delta"] == 110
    assert row["events"][0]["tokens"] == {
        "input": 100,
        "output": 10,
        "cache_creation": 0,
        "cache_read": 0,
    }
    assert row["events"][1]["name"] == "touchpoint/get_goal"


def test_token_only_first_turn_and_coverage_are_explicit() -> None:
    facts = _facts()
    facts["message"] = []
    facts["call"] = []
    facts["token"][0]["first_turn_input_total"] = 100
    facts["coverage"] = [{"source_id": "root", "status": "partial"}]

    row = project_session(
        "claude-code",
        ROOT,
        facts=facts,
        registry={},
        loadout_rows=[],
        now=datetime(2026, 9, 17, tzinfo=timezone.utc),
        tracked_files=None,
    )

    assert row["first_turn_input_total"] == 100
    assert row["capture_coverage"] == "partial"


def test_legacy_steering_and_root_boundaries_ignore_child_observations() -> None:
    facts = _facts()
    facts["structural"].append(
        {"run_id": ROOT, "kind": "human_turn", "message_id": "m2", "at": "2026-09-17T08:02:00Z", "source_ordinal": 2}
    )
    facts["message"].extend(
        [
            {
                "message_id": "m2",
                "run_id": ROOT,
                "kind": "human_turn",
                "at": "2026-09-17T08:02:00Z",
                "excerpt": "Second",
                "stacked": False,
                "interrupted": False,
                "source_ordinal": 2,
            },
            {
                "message_id": "child-message",
                "run_id": "child",
                "kind": "human_turn",
                "at": "2026-09-17T08:01:00Z",
                "excerpt": "Child secret",
                "text_len": 99,
                "thinking_len": 88,
                "is_steering": True,
                "source_ordinal": 1,
            },
        ]
    )
    facts["call"].append(
        {
            "run_id": "child",
            "activity_class": "edit",
            "edit_file_hash": "path:child",
            "at": "2026-09-17T08:01:00Z",
            "source_ordinal": 1,
        }
    )

    row = project_session(
        "claude-code",
        ROOT,
        facts=facts,
        registry={},
        loadout_rows=[],
        now=datetime(2026, 9, 17, tzinfo=timezone.utc),
        tracked_files=None,
    )

    assert row["steering_count"] == 1
    assert row["activity"]["edit"] == 0 and row["files_edited"] == 0
    assert all(event["excerpt"] != "Child secret" for event in row["events"])


def test_first_turn_falls_back_to_root_token_buckets_and_token_times_bound_session() -> None:
    facts = _facts()
    facts["run"] = []
    facts["message"] = []
    facts["call"] = []
    facts["structural"] = [facts["structural"][0]]
    facts["token"] = [facts["token"][0]]
    facts["token"][0].update({"input": 7, "cache_creation": 2, "cache_read": 3, "at": "2026-09-17T08:03:00Z"})

    row = project_session(
        "claude-code",
        ROOT,
        facts=facts,
        registry={},
        loadout_rows=[],
        now=datetime(2026, 9, 17, tzinfo=timezone.utc),
        tracked_files=None,
    )

    assert row["first_turn_input_total"] == 12
    assert row["started_at"] == row["last_activity_at"] == "2026-09-17T08:03:00Z"


def test_reduction_does_not_mutate_selected_facts() -> None:
    facts = _facts()
    before = repr(facts)
    project_session(
        "claude-code",
        ROOT,
        facts=facts,
        registry={},
        loadout_rows=[],
        now=datetime(2026, 9, 17, tzinfo=timezone.utc),
        tracked_files=None,
    )
    assert repr(facts) == before


def test_freezing_retains_the_existing_seventy_two_hour_boundary():
    from datetime import timedelta

    facts = _facts()
    observed = project_session(
        "claude-code", ROOT, facts=facts, registry={}, loadout_rows=[],
        now=datetime(2026, 9, 17, 12, tzinfo=timezone.utc), tracked_files=None,
    )
    last = datetime.fromisoformat(observed["last_activity_at"].replace("Z", "+00:00"))
    for hours, expected in ((25, False), (72, False), (73, True)):
        row = project_session(
            "claude-code", ROOT, facts=facts, registry={}, loadout_rows=[],
            now=last + timedelta(hours=hours), tracked_files=None,
        )
        assert row["frozen"] is expected


def test_authoritative_total_survives_missing_buckets_and_cumulative_resets():
    facts = _facts()
    for item in facts["structural"] + facts["run"]:
        if "harness" in item:
            item["harness"] = "codex"
    facts["token"] = [
        {"run_id": ROOT, "origin": "native", "source_ordinal": ordinal,
         "at": "2026-09-17T08:00:00Z", "total": total, "cumulative": cumulative}
        for ordinal, (total, cumulative) in enumerate([(100, False), (50, False), (100, True), (250, True), (60, True)])
    ]
    row = project_session("codex", ROOT, facts=facts, registry={}, loadout_rows=[],
                          now=datetime(2026, 9, 17, 12, tzinfo=timezone.utc), tracked_files=None)
    assert row["tokens"]["total"] == 460
    assert all(row["tokens"][key] == 0 for key in ("input", "output", "cache_creation", "cache_read"))
    assert sum(event["token_delta"] for event in row["events"]) == 460
