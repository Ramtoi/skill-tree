"""Tests for `usage_history.py` — the durable per-day usage ledger.

Covers plan `plans/1.md` Wave 1 tasks 14-21 (round trip, freeze-horizon merge,
horizon edges, the remainder row, the stats-cache import + guard, the
`history_view` payload, and the no-path/no-session-id guarantee), plus the
coordinator-requested `claude_stats` probe and `import-claude-stats --dry-run`
coverage.

Every test uses `tmp_data_home` (isolates `SKILL_HUB_HOME`) plus the autouse
`_fake_home` fixture in `conftest.py` (fakes `$HOME`) — no test may read or
write the real `~/.claude` or `~/.skill-hub`.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
from pathlib import Path

import pytest

import skill_hub.entrypoints.cli.usage as hcu
from skill_hub.application.usage import usage_history as uh

# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────


def _row(
    date,
    agent="claude",
    model="claude-sonnet-4-5",
    total=100,
    source="ccusage",
    cost_usd=1.0,
    input=10,  # noqa: A002
    output=20,
    cache_creation=30,
    cache_read=40,
    scanner="ccusage",
    captured_at="2026-08-14T09:12:03Z",
    sessions=None,
):
    return uh.UsageRow(
        date=date,
        agent=agent,
        model=model,
        input=input,
        output=output,
        cache_creation=cache_creation,
        cache_read=cache_read,
        total=total,
        cost_usd=cost_usd,
        source=source,
        scanner=scanner,
        captured_at=captured_at,
        sessions=sessions,
    )


def _model_breakdown(model_name, input_t, output_t, cache_creation_t, cache_read_t, cost):
    return {
        "modelName": model_name,
        "inputTokens": input_t,
        "outputTokens": output_t,
        "cacheCreationTokens": cache_creation_t,
        "cacheReadTokens": cache_read_t,
        "cost": cost,
    }


def _agent_row(
    agent,
    breakdowns,
    extra_input=0,
    extra_output=0,
    extra_cache_creation=0,
    extra_cache_read=0,
    extra_cost=0.0,
):
    """Build a ccusage `daily[].agents[]` entry whose own totals are the exact
    sum of `breakdowns` PLUS the given `extra_*` remainder amounts."""
    total_input = sum(b["inputTokens"] for b in breakdowns) + extra_input
    total_output = sum(b["outputTokens"] for b in breakdowns) + extra_output
    total_cache_creation = sum(b["cacheCreationTokens"] for b in breakdowns) + extra_cache_creation
    total_cache_read = sum(b["cacheReadTokens"] for b in breakdowns) + extra_cache_read
    total_cost = sum(b["cost"] for b in breakdowns) + extra_cost
    return {
        "agent": agent,
        "inputTokens": total_input,
        "outputTokens": total_output,
        "cacheCreationTokens": total_cache_creation,
        "cacheReadTokens": total_cache_read,
        "totalTokens": total_input + total_output + total_cache_creation + total_cache_read,
        "totalCost": total_cost,
        "modelBreakdowns": breakdowns,
    }


def _scan(daily_rows, extra_top_level=None):
    parsed = {"daily": daily_rows, "weekly": [], "monthly": [], "session": []}
    if extra_top_level:
        parsed.update(extra_top_level)
    return parsed


def test_session_extraction_is_unavailable_without_session_section():
    result = uh.extract_session_counts({"daily": []})
    assert result == {"available": False, "by_pair": {}, "undated": 0, "unmatched": 0}


def test_session_extraction_uses_timestamp_ladder_and_utc_date():
    daily = [
        {"period": "2026-08-14", "agents": [{"agent": "claude"}]},
        {"period": "2026-08-15", "agents": [{"agent": "claude"}]},
    ]
    result = uh.extract_session_counts(
        {
            "daily": daily,
            "session": [
                {"agent": "claude", "lastActivity": "2026-08-14T23:30:00-02:00"},
                {"agent": "claude", "metadata": {"lastActivity": "2026-08-14T12:00:00Z"}},
                {"agent": "claude", "metadata": {"updatedAt": "2026-08-14T13:00:00Z"}},
            ],
        }
    )
    assert result["by_pair"] == {("2026-08-15", "claude"): 1, ("2026-08-14", "claude"): 2}


def test_session_extraction_counts_undated_and_unmatched():
    result = uh.extract_session_counts(
        {
            "daily": [{"period": "2026-08-14", "agents": [{"agent": "claude"}]}],
            "session": [
                {"agent": "claude", "lastActivity": "not-a-date"},
                {"agent": "codex", "lastActivity": "2026-08-14T00:00:00Z"},
            ],
        }
    )
    assert result["undated"] == 1
    assert result["unmatched"] == 1


def test_session_extraction_groups_multiple_sessions_by_pair():
    result = uh.extract_session_counts(
        {
            "daily": [{"period": "2026-08-14", "agents": [{"agent": "claude"}, {"agent": "codex"}]}],
            "session": [
                {"agent": "claude", "lastActivity": "2026-08-14T00:00:00Z"},
                {"agent": "claude", "lastActivity": "2026-08-14T01:00:00Z"},
                {"agent": "codex", "lastActivity": "2026-08-14T02:00:00Z"},
            ],
        }
    )
    assert result["by_pair"] == {("2026-08-14", "claude"): 2, ("2026-08-14", "codex"): 1}


def test_sessions_row_compatibility_and_negative_guard(tmp_path):
    row = _row("2026-08-14", sessions=0)
    assert row.to_dict()["sessions"] == 0
    assert uh.UsageRow.from_dict({k: v for k, v in row.to_dict().items() if k != "sessions"}).sessions is None
    with pytest.raises(ValueError, match="negative sessions"):
        uh.UsageRow.from_dict({**row.to_dict(), "sessions": -1})


# ─────────────────────────────────────────────────────────────────────────────
# Task 14 — round trip, malformed lines, sort, byte-identical rewrite
# ─────────────────────────────────────────────────────────────────────────────


def test_round_trip_write_read_is_identical(tmp_path):
    path = tmp_path / "history.jsonl"
    rows = [
        _row("2026-08-14", model="claude-sonnet-4-5"),
        _row(
            "2026-08-13",
            agent="codex",
            model="gpt-5.6-sol",
            cost_usd=None,
            input=None,
            output=None,
            cache_creation=None,
            cache_read=None,
        ),
        _row("2026-08-14", model=None, cost_usd=0.0),
    ]
    uh.write_rows(path, rows)
    read_back, warnings = uh.read_rows(path)
    assert warnings == []

    def _sorted_dicts(items):
        return sorted((r.to_dict() for r in items), key=lambda d: (d["date"], d["agent"], d["model"] or ""))

    assert _sorted_dicts(read_back) == _sorted_dicts(rows)


def test_malformed_line_is_dropped_with_a_warning_good_lines_survive(tmp_path):
    path = tmp_path / "history.jsonl"
    good = _row("2026-08-14")
    path.write_text(
        json.dumps(good.to_dict()) + "\n"
        + "not json at all\n"
        + json.dumps({"date": "2026-08-15"}) + "\n"  # missing required keys
        + "\n"  # blank line, must be skipped silently
    )
    rows, warnings = uh.read_rows(path)
    assert [r.to_dict() for r in rows] == [good.to_dict()]
    assert len(warnings) == 2
    assert all(str(path) in w for w in warnings)


def test_write_sorts_by_date_agent_model_and_is_byte_identical_on_rewrite(tmp_path):
    path = tmp_path / "history.jsonl"
    rows = [
        _row("2026-08-14", agent="codex", model="gpt-5.6-sol"),
        _row("2026-08-14", agent="claude", model=None),
        _row("2026-08-13", agent="claude", model="claude-sonnet-4-5"),
        _row("2026-08-14", agent="claude", model="claude-sonnet-4-5"),
    ]
    uh.write_rows(path, rows)
    text1 = path.read_text()
    read_back, _ = uh.read_rows(path)
    assert [(r.date, r.agent, r.model) for r in read_back] == [
        ("2026-08-13", "claude", "claude-sonnet-4-5"),
        ("2026-08-14", "claude", None),
        ("2026-08-14", "claude", "claude-sonnet-4-5"),
        ("2026-08-14", "codex", "gpt-5.6-sol"),
    ]
    uh.write_rows(path, read_back)
    assert path.read_text() == text1


def test_write_creates_parent_dir_and_locks_permissions(tmp_path):
    path = tmp_path / "nested" / "history.jsonl"
    uh.write_rows(path, [_row("2026-08-14")])
    assert path.exists()
    import stat

    mode = stat.S_IMODE(path.stat().st_mode)
    assert mode == 0o600


# ─────────────────────────────────────────────────────────────────────────────
# W2 — read_rows validates date/agent/non-negative ints; history_view never
# raises on ledger content.
# ─────────────────────────────────────────────────────────────────────────────


def test_read_rows_drops_a_row_with_an_invalid_calendar_date(tmp_path):
    path = tmp_path / "history.jsonl"
    good = _row("2026-08-14")
    bad = good.to_dict()
    bad["date"] = "2026-13-45"  # matches the YYYY-MM-DD shape, not a real date
    path.write_text(json.dumps(good.to_dict()) + "\n" + json.dumps(bad) + "\n")
    rows, warnings = uh.read_rows(path)
    assert [r.to_dict() for r in rows] == [good.to_dict()]
    assert len(warnings) == 1


def test_read_rows_drops_a_row_with_an_empty_agent(tmp_path):
    path = tmp_path / "history.jsonl"
    good = _row("2026-08-14")
    bad = good.to_dict()
    bad["agent"] = ""
    path.write_text(json.dumps(good.to_dict()) + "\n" + json.dumps(bad) + "\n")
    rows, warnings = uh.read_rows(path)
    assert [r.to_dict() for r in rows] == [good.to_dict()]
    assert len(warnings) == 1


@pytest.mark.parametrize("field", ["input", "output", "cache_creation", "cache_read", "total", "sessions"])
def test_read_rows_drops_a_row_with_a_negative_int_field(tmp_path, field):
    path = tmp_path / "history.jsonl"
    good = _row("2026-08-14")
    bad = good.to_dict()
    bad[field] = -5
    path.write_text(json.dumps(good.to_dict()) + "\n" + json.dumps(bad) + "\n")
    rows, warnings = uh.read_rows(path)
    assert [r.to_dict() for r in rows] == [good.to_dict()]
    assert len(warnings) == 1


def test_history_view_never_raises_when_the_ledger_holds_an_invalid_date(tmp_data_home):
    path = uh.history_path()
    good = _row("2026-08-14")
    bad = good.to_dict()
    bad["date"] = "2026-13-45"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(good.to_dict()) + "\n" + json.dumps(bad) + "\n")
    rows, warnings = uh.read_rows(path)
    assert len(warnings) == 1
    payload = uh.history_view(rows, None, None, dt.date(2026, 9, 4))  # must not raise
    assert payload["counts"]["days"] == 1


# ─────────────────────────────────────────────────────────────────────────────
# Task 15 — mutable window
# ─────────────────────────────────────────────────────────────────────────────


def test_mutable_window_replaces_agent_rows_leaves_absent_agent_untouched():
    horizon = dt.date(2026, 8, 21)
    existing = [
        _row("2026-08-25", agent="claude", model="claude-sonnet-4-5", total=999),
        _row("2026-08-25", agent="codex", model="gpt-5.6-sol", total=500),
    ]
    incoming = [
        _row("2026-08-25", agent="claude", model="claude-sonnet-4-5", total=10, sessions=4),
    ]
    merged, stats = uh.merge_rows(existing, incoming, horizon)
    by_agent = {(r.agent, r.model): r.total for r in merged}
    assert by_agent[("claude", "claude-sonnet-4-5")] == 10
    assert next(r for r in merged if r.agent == "claude").sessions == 4
    assert by_agent[("codex", "gpt-5.6-sol")] == 500, "an agent absent from the scan keeps its rows"
    assert stats["replaced"] == 1
    assert stats["inserted"] == 0
    assert stats["skipped"] == 0


def test_mutable_window_inserts_a_new_pair_when_none_existed():
    horizon = dt.date(2026, 8, 21)
    merged, stats = uh.merge_rows([], [_row("2026-08-25")], horizon)
    assert len(merged) == 1
    assert stats["inserted"] == 1
    assert stats["replaced"] == 0


def test_w5_mirror_rule_deletes_every_mutable_day_for_a_scanned_agent_not_just_scanned_dates():
    """`plans/1.md`: for each agent PRESENT anywhere in the scan, every
    mutable-day row of that agent is deleted — every mutable date, whether
    or not the scan itself covers that date — then the scan's rows for that
    agent are inserted. A prior version keyed the deletion on the
    (date, agent) PAIR instead, so a stale mutable day the scan no longer
    reports for an agent survived forever."""
    horizon = dt.date(2026, 8, 20)
    existing = [
        _row("2026-09-01", agent="claude", total=4),  # mutable, stale: scan doesn't cover this date
        _row("2026-08-10", agent="claude", total=999),  # frozen: must survive untouched
        _row("2026-09-01", agent="codex", total=50),  # different agent, absent from scan
    ]
    incoming = [_row("2026-09-02", agent="claude", total=8)]
    merged, stats = uh.merge_rows(existing, incoming, horizon)
    by_pair = {(r.date, r.agent): r.total for r in merged}

    assert ("2026-09-01", "claude") not in by_pair, "a stale mutable day for a scanned agent must be mirrored away"
    assert by_pair[("2026-09-02", "claude")] == 8
    assert by_pair[("2026-08-10", "claude")] == 999, "frozen days never move, even for a scanned agent"
    assert by_pair[("2026-09-01", "codex")] == 50, "an agent absent from the scan keeps every row"
    assert stats["inserted"] == 1


# ─────────────────────────────────────────────────────────────────────────────
# Task 16 — frozen window
# ─────────────────────────────────────────────────────────────────────────────


def test_frozen_window_never_changes_an_existing_pair():
    horizon = dt.date(2026, 8, 21)
    existing = [_row("2026-08-10", agent="claude", model="claude-sonnet-4-5", total=999)]
    incoming = [_row("2026-08-10", agent="claude", model="claude-sonnet-4-5", total=1)]
    merged, stats = uh.merge_rows(existing, incoming, horizon)
    assert [r.total for r in merged] == [999]
    assert stats["skipped"] == 1
    assert stats["inserted"] == 0
    assert stats["replaced"] == 0


def test_frozen_window_inserts_a_pair_the_ledger_has_never_seen():
    horizon = dt.date(2026, 8, 21)
    merged, stats = uh.merge_rows([], [_row("2026-08-10")], horizon)
    assert len(merged) == 1
    assert stats["inserted"] == 1
    assert stats["skipped"] == 0


# ─────────────────────────────────────────────────────────────────────────────
# Task 17 — horizon edges (parameterized)
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "days_old,expect_mutated",
    [
        (14, True),  # exactly 14 days old: still mutable
        (15, False),  # 15 days old: frozen
        (0, True),  # same day: mutable
    ],
)
def test_horizon_edges(days_old, expect_mutated):
    scanned_at = dt.date(2026, 8, 25)
    horizon = scanned_at - dt.timedelta(days=uh.FREEZE_HORIZON_DAYS)
    row_date = (scanned_at - dt.timedelta(days=days_old)).isoformat()

    existing = [_row(row_date, total=999)]
    incoming = [_row(row_date, total=1)]
    merged, stats = uh.merge_rows(existing, incoming, horizon)
    result_total = merged[0].total
    if expect_mutated:
        assert result_total == 1
        assert stats["replaced"] == 1
    else:
        assert result_total == 999
        assert stats["skipped"] == 1


# ─────────────────────────────────────────────────────────────────────────────
# Task 18 — remainder row
# ─────────────────────────────────────────────────────────────────────────────


def test_remainder_row_reconciles_agent_total_above_breakdown_sum():
    breakdowns = [
        _model_breakdown("claude-fable-5", 4353, 523460, 5686662, 187007925, 326.9576949999998),
        _model_breakdown("claude-opus-5", 58776, 1873746, 10866935, 500998392, 0.0),
    ]
    agent_row = _agent_row(
        "claude",
        breakdowns,
        extra_input=1000,
        extra_output=2000,
        extra_cache_creation=3000,
        extra_cache_read=4000,
        extra_cost=5.5,
    )
    scan = _scan([{"period": "2026-08-14", "agent": "all", "agents": [agent_row]}])
    rows = uh.rows_from_scan(scan, "2026-08-14T09:00:00Z", "ccusage")

    assert len(rows) == 3  # 2 model rows + 1 remainder
    remainder = [r for r in rows if r.model is None]
    assert len(remainder) == 1
    remainder = remainder[0]
    assert remainder.input == 1000
    assert remainder.output == 2000
    assert remainder.cache_creation == 3000
    assert remainder.cache_read == 4000
    assert remainder.total == 10000
    assert remainder.cost_usd == pytest.approx(5.5)

    # Day x agent sum over the ledger equals what ccusage reported.
    assert sum(r.total for r in rows) == agent_row["totalTokens"]
    assert sum(r.cost_usd for r in rows) == pytest.approx(agent_row["totalCost"])


def test_no_breakdowns_produces_a_single_remainder_row_only():
    agent_row = {
        "agent": "claude",
        "inputTokens": 10,
        "outputTokens": 20,
        "cacheCreationTokens": 30,
        "cacheReadTokens": 40,
        "totalTokens": 100,
        "totalCost": 1.5,
        "modelBreakdowns": [],
    }
    scan = _scan([{"period": "2026-08-14", "agent": "all", "agents": [agent_row]}])
    rows = uh.rows_from_scan(scan, "2026-08-14T09:00:00Z", "ccusage")
    assert len(rows) == 1
    assert rows[0].model is None
    assert rows[0].total == 100
    assert rows[0].cost_usd == pytest.approx(1.5)


def test_no_remainder_row_when_breakdown_sum_matches_agent_total():
    breakdowns = [_model_breakdown("claude-fable-5", 10, 20, 30, 40, 1.0)]
    agent_row = _agent_row("claude", breakdowns)
    scan = _scan([{"period": "2026-08-14", "agent": "all", "agents": [agent_row]}])
    rows = uh.rows_from_scan(scan, "2026-08-14T09:00:00Z", "ccusage")
    assert len(rows) == 1
    assert rows[0].model == "claude-fable-5"


def test_rows_from_scan_repeats_known_zero_on_model_and_remainder_rows():
    breakdowns = [_model_breakdown("m", 1, 1, 1, 1, 0.1)]
    agent_row = _agent_row("claude", breakdowns, extra_input=2)
    rows = uh.rows_from_scan(
        _scan([{"period": "2026-08-14", "agents": [agent_row]}]),
        "2026-08-14T09:00:00Z",
        "ccusage",
        {("2026-08-14", "claude"): 0},
    )
    assert len(rows) == 2
    assert {row.sessions for row in rows} == {0}


def test_non_date_period_is_dropped_not_stored():
    scan = _scan([{"period": "2026-W33", "agent": "all", "agents": [_agent_row("claude", [])]}])
    assert uh.rows_from_scan(scan, "2026-08-14T09:00:00Z", "ccusage") == []


def test_claude_and_codex_survive_scan_merge_history_view():
    date = "2026-03-10"
    today = dt.date(2026, 3, 12)
    horizon_date = today - dt.timedelta(days=14)
    scan = _scan(
        [
            {
                "period": date,
                "agent": "all",
                "agents": [
                    _agent_row("claude", [_model_breakdown("claude-sonnet-5", 10, 20, 30, 40, 1.0)]),
                    _agent_row("codex", [_model_breakdown("gpt-6-astra", 50, 60, 70, 80, 2.0)]),
                ],
            }
        ]
    )

    incoming = uh.rows_from_scan(scan, "2026-03-10T00:00:00Z", "ccusage")
    assert {(row.date, row.agent) for row in incoming} == {(date, "claude"), (date, "codex")}

    merged, stats = uh.merge_rows([], incoming, horizon_date)
    assert stats == {"inserted": 2, "replaced": 0, "skipped": 0, "days": 1}

    payload = uh.history_view(merged, None, None, today)
    day = payload["days"][0]
    assert day["date"] == date
    assert day["provenance"] == "scanned"
    assert {agent["agent"] for agent in day["agents"]} == {"claude", "codex"}
    assert all(agent["provenance"] == "scanned" for agent in day["agents"])


# ─────────────────────────────────────────────────────────────────────────────
# C1 / W3 — remainder math never goes negative; ccusage's own totalTokens
# decides the day × agent total.
# ─────────────────────────────────────────────────────────────────────────────


def test_c1_no_remainder_row_when_agent_total_is_below_breakdown_sum():
    breakdowns = [_model_breakdown("claude-fable-5", 100, 200, 300, 400, 5.0)]
    breakdown_sum = 100 + 200 + 300 + 400
    agent_row = _agent_row(
        "claude",
        breakdowns,
        extra_input=-40,
        extra_output=-40,
        extra_cache_creation=-10,
        extra_cache_read=-10,
        extra_cost=-2.0,
    )
    assert agent_row["totalTokens"] < breakdown_sum  # the below-sum case under test
    scan = _scan([{"period": "2026-08-14", "agent": "all", "agents": [agent_row]}])
    rows = uh.rows_from_scan(scan, "2026-08-14T09:00:00Z", "ccusage")

    assert len(rows) == 1  # the model row only — no remainder row, above OR equal
    assert rows[0].model == "claude-fable-5"
    assert all(r.total >= 0 for r in rows)
    assert all((r.cost_usd or 0.0) >= 0.0 for r in rows)
    # W3: below the breakdown sum, the ledger's day × agent total IS the
    # breakdown sum — ccusage's own (lower) total is not used.
    assert sum(r.total for r in rows) == breakdown_sum


def test_c1_remainder_uses_agent_total_tokens_when_per_field_counts_are_absent():
    breakdowns = [_model_breakdown("claude-fable-5", 100, 50, 10, 40, 1.0)]
    breakdown_sum = 100 + 50 + 10 + 40
    agent_row = {
        "agent": "claude",
        # No inputTokens/outputTokens/cacheCreationTokens/cacheReadTokens at
        # all — only the two ccusage-reported totals, as a future agent-row
        # shape (or a version bump) could plausibly send.
        "totalTokens": breakdown_sum + 50,
        "totalCost": 1.0,  # equals the breakdown's cost sum -> no cost remainder
        "modelBreakdowns": breakdowns,
    }
    scan = _scan([{"period": "2026-08-14", "agent": "all", "agents": [agent_row]}])
    rows = uh.rows_from_scan(scan, "2026-08-14T09:00:00Z", "ccusage")

    remainder = [r for r in rows if r.model is None]
    assert len(remainder) == 1
    remainder = remainder[0]
    assert remainder.total == 50
    assert remainder.cost_usd == 0.0  # totalCost does not EXCEED the breakdown sum
    # Split fields fall back to 0 (missing agent-level counts default to 0,
    # then clamp at 0 rather than go negative).
    assert remainder.input == 0
    assert remainder.output == 0
    assert remainder.cache_creation == 0
    assert remainder.cache_read == 0
    assert sum(r.total for r in rows) == agent_row["totalTokens"]  # W3: above -> ccusage's total


def test_c1_write_rows_never_persists_a_negative_field_last_line_of_defence(tmp_path, capsys):
    path = tmp_path / "history.jsonl"
    good = _row("2026-08-14", total=10)
    bad = _row("2026-08-15", agent="codex", total=-5)
    uh.write_rows(path, [good, bad])
    rows, _ = uh.read_rows(path)
    assert [(r.date, r.agent) for r in rows] == [("2026-08-14", "claude")]
    assert "negative" in capsys.readouterr().err.lower()


def test_w3_day_agent_total_rule_stated_as_one_sentence():
    """The ledger's day × agent total equals ccusage's own totalTokens
    whenever it is >= the modelBreakdowns sum, and the breakdown sum
    otherwise — exactly the sentence docs/USAGE.md states."""
    breakdowns = [_model_breakdown("m", 10, 20, 30, 40, 1.0)]
    breakdown_sum = 10 + 20 + 30 + 40

    above = _agent_row("claude", breakdowns, extra_input=5)
    above_scan = _scan([{"period": "2026-08-14", "agent": "all", "agents": [above]}])
    above_rows = uh.rows_from_scan(above_scan, "2026-08-14T09:00:00Z", "ccusage")
    assert sum(r.total for r in above_rows) == above["totalTokens"]
    assert above["totalTokens"] >= breakdown_sum

    below = _agent_row("claude", breakdowns, extra_input=-5)
    below_scan = _scan([{"period": "2026-08-14", "agent": "all", "agents": [below]}])
    below_rows = uh.rows_from_scan(below_scan, "2026-08-14T09:00:00Z", "ccusage")
    assert below["totalTokens"] < breakdown_sum
    assert sum(r.total for r in below_rows) == breakdown_sum


# ─────────────────────────────────────────────────────────────────────────────
# Task 19 — stats-cache import + guard
# ─────────────────────────────────────────────────────────────────────────────


def _write_stats_cache(path, daily, last_computed="2026-05-31"):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"dailyModelTokens": daily, "lastComputedDate": last_computed}))


def test_import_inserts_only_absent_date_claude_model_rows(tmp_data_home, tmp_path):
    stats_path = tmp_path / "stats-cache.json"
    _write_stats_cache(
        stats_path,
        [
            {"date": "2025-12-23", "tokensByModel": {"claude-3-opus": 100, "claude-3-sonnet": 50}},
            {"date": "2025-12-24", "tokensByModel": {"claude-3-opus": 10}},
        ],
    )
    result = uh.import_claude_stats(stats_path)
    assert result["inserted"] == 3
    assert result["dry_run"] is False

    rows, _ = uh.read_rows(uh.history_path())
    assert len(rows) == 3
    assert all(r.source == "claude-stats-cache" for r in rows)
    assert all(r.cost_usd is None for r in rows)
    assert all(r.input is None and r.output is None and r.cache_creation is None and r.cache_read is None for r in rows)


def test_import_is_idempotent_a_second_run_is_byte_identical(tmp_data_home, tmp_path):
    stats_path = tmp_path / "stats-cache.json"
    _write_stats_cache(stats_path, [{"date": "2025-12-23", "tokensByModel": {"claude-3-opus": 100}}])
    uh.import_claude_stats(stats_path)
    text1 = uh.history_path().read_text()

    result2 = uh.import_claude_stats(stats_path)
    assert result2["inserted"] == 0
    assert result2["skipped_existing"] == 1
    assert uh.history_path().read_text() == text1


def test_import_skips_a_whole_day_already_covered_by_a_ccusage_row(tmp_data_home, tmp_path):
    path = uh.history_path()
    uh.write_rows(path, [_row("2025-12-23", agent="claude", model="claude-3-opus", source="ccusage")])

    stats_path = tmp_path / "stats-cache.json"
    _write_stats_cache(
        stats_path,
        [{"date": "2025-12-23", "tokensByModel": {"claude-3-opus": 5, "claude-3-sonnet": 5}}],
    )
    result = uh.import_claude_stats(stats_path)
    assert result["inserted"] == 0
    assert result["skipped_ccusage_days"] == 1

    rows, _ = uh.read_rows(path)
    assert len(rows) == 1  # untouched
    assert rows[0].source == "ccusage"


def test_import_reads_only_the_given_tmp_fixture_path(tmp_data_home, tmp_path, monkeypatch):
    """The default stats-cache path must never be consulted when an explicit
    `stats_path` is given (no test may read `~/.claude`)."""

    def _boom():
        raise AssertionError("default_stats_cache_path must not be called")

    monkeypatch.setattr(uh, "default_stats_cache_path", _boom)
    stats_path = tmp_path / "stats-cache.json"
    _write_stats_cache(stats_path, [{"date": "2025-12-23", "tokensByModel": {"m": 1}}])
    uh.import_claude_stats(stats_path)  # must not raise


def test_import_missing_file_raises_file_not_found(tmp_path):
    with pytest.raises(FileNotFoundError):
        uh.import_claude_stats(tmp_path / "does-not-exist.json")


# ─────────────────────────────────────────────────────────────────────────────
# W4 — stats-cache import: version guard, bool/negative token rejection,
# duplicate-date last-occurrence-wins.
# ─────────────────────────────────────────────────────────────────────────────


def test_import_rejects_an_unsupported_stats_cache_version_and_writes_nothing(tmp_data_home, tmp_path):
    stats_path = tmp_path / "stats-cache.json"
    stats_path.write_text(
        json.dumps({"version": 99, "dailyModelTokens": [{"date": "2025-12-23", "tokensByModel": {"m": 1}}]})
    )
    with pytest.raises(ValueError, match="version"):
        uh.import_claude_stats(stats_path)
    assert not uh.history_path().exists()


@pytest.mark.parametrize("version", [None, 3])
def test_import_accepts_a_missing_or_v3_version(tmp_data_home, tmp_path, version):
    stats_path = tmp_path / "stats-cache.json"
    payload = {"dailyModelTokens": [{"date": "2025-12-23", "tokensByModel": {"m": 1}}]}
    if version is not None:
        payload["version"] = version
    stats_path.write_text(json.dumps(payload))
    result = uh.import_claude_stats(stats_path)
    assert result["inserted"] == 1


def test_claude_stats_probe_reports_unavailable_for_an_unsupported_version(tmp_path):
    stats_path = tmp_path / "stats-cache.json"
    stats_path.write_text(
        json.dumps({"version": 99, "dailyModelTokens": [{"date": "2025-12-23", "tokensByModel": {"m": 1}}]})
    )
    probe = uh.claude_stats_probe(stats_path, existing_rows=[])
    assert probe["available"] is False


def test_import_rejects_bool_and_negative_token_values_and_warns(tmp_data_home, tmp_path):
    stats_path = tmp_path / "stats-cache.json"
    _write_stats_cache(
        stats_path,
        [{"date": "2025-12-23", "tokensByModel": {"a": "12", "b": True, "c": 3.9, "d": -5}}],
    )
    result = uh.import_claude_stats(stats_path)
    # "a" (non-numeric string) was already correctly rejected before this fix
    # and stays silent; "b" (bool) and "d" (negative) are new rejections,
    # each warned about; "c" (a plain positive float) is the only insert.
    assert result["inserted"] == 1
    rows, _ = uh.read_rows(uh.history_path())
    assert [(r.model, r.total) for r in rows] == [("c", 3)]
    assert any("bool" in w for w in result["warnings"])
    assert any("negative" in w for w in result["warnings"])


def test_import_duplicate_date_uses_the_last_occurrence_and_warns(tmp_data_home, tmp_path):
    stats_path = tmp_path / "stats-cache.json"
    _write_stats_cache(
        stats_path,
        [
            {"date": "2025-12-23", "tokensByModel": {"m": 1}},
            {"date": "2025-12-23", "tokensByModel": {"m": 2}},
        ],
    )
    result = uh.import_claude_stats(stats_path)
    assert result["inserted"] == 1  # not 2 — the flat-triple grain is never double-written
    rows, _ = uh.read_rows(uh.history_path())
    assert [r.total for r in rows] == [2], "the LAST occurrence of a duplicated date wins"
    assert any("duplicate date" in w for w in result["warnings"])


# ─────────────────────────────────────────────────────────────────────────────
# W6 — record_from_cache raises on a scan with zero daily rows and writes
# nothing (never a quiet, signal-free success).
# ─────────────────────────────────────────────────────────────────────────────


def _write_scan_cache(path, scanned_at_epoch: float, parsed: dict) -> None:
    path.write_text(json.dumps({"scanned_at": scanned_at_epoch, "parsed": parsed}))


def test_record_from_cache_raises_empty_scan_error_and_writes_nothing(tmp_data_home, tmp_path):
    cache_path = tmp_path / "cache.json"
    scanned_at = dt.datetime(2026, 8, 25, 9, 0, tzinfo=dt.timezone.utc).timestamp()
    _write_scan_cache(cache_path, scanned_at, _scan([]))
    with pytest.raises(uh.EmptyScanError):
        uh.record_from_cache(cache_path)
    assert not uh.history_path().exists()


def test_record_from_cache_merges_a_real_scan(tmp_data_home, tmp_path):
    cache_path = tmp_path / "cache.json"
    scanned_at = dt.datetime(2026, 8, 25, 9, 0, tzinfo=dt.timezone.utc).timestamp()
    agent_row = _agent_row("claude", [_model_breakdown("m", 10, 20, 30, 40, 1.0)])
    parsed = _scan([{"period": "2026-08-25", "agent": "all", "agents": [agent_row]}])
    _write_scan_cache(cache_path, scanned_at, parsed)
    stats = uh.record_from_cache(cache_path)
    assert stats["inserted"] == 1
    rows, _ = uh.read_rows(uh.history_path())
    assert len(rows) == 1


def test_record_from_cache_threads_known_session_count_and_diagnostics(tmp_data_home, tmp_path):
    cache_path = tmp_path / "cache.json"
    scanned_at = dt.datetime(2026, 8, 25, 9, 0, tzinfo=dt.timezone.utc).timestamp()
    agent_row = _agent_row("claude", [_model_breakdown("m", 10, 20, 30, 40, 1.0)], extra_input=5)
    parsed = {
        "daily": [{"period": "2026-08-25", "agents": [agent_row]}],
        "session": [
            {"agent": "claude", "lastActivity": "2026-08-25T01:00:00Z"},
            {"agent": "claude", "metadata": {}},
            {"agent": "codex", "lastActivity": "2026-08-25T01:00:00Z"},
        ],
    }
    _write_scan_cache(cache_path, scanned_at, parsed)
    stats = uh.record_from_cache(cache_path)
    assert stats["sessions_undated"] == 1
    assert stats["sessions_unmatched"] == 1
    rows, _ = uh.read_rows(uh.history_path())
    assert rows and all(row.sessions == 1 for row in rows)


def test_cmd_usage_record_text_discloses_positive_session_diagnostics(tmp_data_home, tmp_path, capsys):
    cache_path = tmp_path / "cache.json"
    scanned_at = dt.datetime(2026, 8, 25, 9, 0, tzinfo=dt.timezone.utc).timestamp()
    parsed = {
        "daily": [{"period": "2026-08-25", "agents": [_agent_row("claude", [])]}],
        "session": [
            {"agent": "claude", "lastActivity": "invalid"},
            {"agent": "codex", "lastActivity": "2026-08-25T00:00:00Z"},
        ],
    }
    _write_scan_cache(cache_path, scanned_at, parsed)
    hcu.cmd_usage_record(argparse.Namespace(from_cache=str(cache_path), json=False))
    output = capsys.readouterr().out
    assert "sessions undated: 1" in output
    assert "sessions unmatched: 1" in output


def test_history_view_deduplicates_pair_sessions_and_marks_unknown_agents():
    rows = [_row("2026-09-01", model="a", sessions=3), _row("2026-09-01", model="b", sessions=3)]
    rows.append(_row("2026-09-01", agent="codex", sessions=None))
    day = uh.history_view(rows, None, None, dt.date(2026, 9, 2))["days"][0]
    agents = {agent["agent"]: agent for agent in day["agents"]}
    assert agents["claude"]["sessions"] == 3
    assert agents["claude"]["sessionsKnown"] is True
    assert agents["codex"]["sessions"] is None
    assert agents["codex"]["sessionsKnown"] is False
    assert day["sessions"] is None
    assert day["sessionsKnown"] is False


@pytest.mark.parametrize(
    ("values", "expected", "known"),
    [([3, 4], None, False), ([None, 3], None, False), ([3, 3], 3, True)],
)
def test_history_view_pair_sessions_fail_closed_and_warn(values, expected, known):
    rows = [_row("2026-09-01", model=f"m-{index}", sessions=value) for index, value in enumerate(values)]
    payload = uh.history_view(rows, None, None, dt.date(2026, 9, 2))
    agent = payload["days"][0]["agents"][0]
    assert agent["sessions"] == expected
    assert agent["sessionsKnown"] is known
    if not known:
        assert any("2026-09-01" in warning and "claude" in warning for warning in payload["warnings"])


# ─────────────────────────────────────────────────────────────────────────────
# Coordinator addition — import-claude-stats --dry-run
# ─────────────────────────────────────────────────────────────────────────────


def test_dry_run_writes_nothing_and_would_insert_matches_the_real_run(tmp_data_home, tmp_path):
    stats_path = tmp_path / "stats-cache.json"
    _write_stats_cache(
        stats_path,
        [
            {"date": "2025-12-23", "tokensByModel": {"claude-3-opus": 100}},
            {"date": "2025-12-24", "tokensByModel": {"claude-3-opus": 10, "claude-3-sonnet": 5}},
        ],
    )
    path = uh.history_path()
    assert not path.exists()

    dry = uh.import_claude_stats(stats_path, dry_run=True)
    assert dry["dry_run"] is True
    assert "would_insert" in dry
    assert "inserted" not in dry
    assert not path.exists(), "dry-run must write nothing"

    real = uh.import_claude_stats(stats_path, dry_run=False)
    assert real["inserted"] == dry["would_insert"]
    assert real["skipped_existing"] == dry["skipped_existing"]
    assert real["skipped_ccusage_days"] == dry["skipped_ccusage_days"]


# ─────────────────────────────────────────────────────────────────────────────
# Coordinator addition — claude_stats probe
# ─────────────────────────────────────────────────────────────────────────────


def test_claude_stats_probe_missing_file_is_unavailable(tmp_path):
    probe = uh.claude_stats_probe(tmp_path / "nope.json", existing_rows=[])
    assert probe == {
        "available": False,
        "path": str(tmp_path / "nope.json"),
        "importable_days": 0,
        "last_computed": None,
    }


def test_claude_stats_probe_default_path_is_the_literal_tilde_string(tmp_data_home, monkeypatch):
    # No override -> the display path must be the literal, never the
    # expanded fake $HOME.
    probe = uh.claude_stats_probe(None, existing_rows=[])
    assert probe["path"] == "~/.claude/stats-cache.json"
    assert probe["available"] is False  # nothing written under the fake $HOME


def test_claude_stats_probe_counts_match_a_subsequent_import(tmp_data_home, tmp_path):
    stats_path = tmp_path / "stats-cache.json"
    _write_stats_cache(
        stats_path,
        [
            {"date": "2025-12-23", "tokensByModel": {"claude-3-opus": 100, "claude-3-sonnet": 50}},
            {"date": "2025-12-24", "tokensByModel": {"claude-3-opus": 10}},
        ],
        last_computed="2026-05-31",
    )
    existing, _ = uh.read_rows(uh.history_path())
    probe = uh.claude_stats_probe(stats_path, existing_rows=existing)
    assert probe["available"] is True
    assert probe["importable_days"] == 2
    assert probe["last_computed"] == "2026-05-31"

    result = uh.import_claude_stats(stats_path)
    inserted_rows, _ = uh.read_rows(uh.history_path())
    distinct_dates = {r.date for r in inserted_rows}
    assert len(distinct_dates) == probe["importable_days"]
    assert result["inserted"] == 3


def test_claude_stats_probe_excludes_days_already_ccusage_covered(tmp_data_home, tmp_path):
    uh.write_rows(uh.history_path(), [_row("2025-12-23", agent="claude", source="ccusage")])
    stats_path = tmp_path / "stats-cache.json"
    _write_stats_cache(
        stats_path,
        [
            {"date": "2025-12-23", "tokensByModel": {"claude-3-opus": 100}},
            {"date": "2025-12-24", "tokensByModel": {"claude-3-opus": 10}},
        ],
    )
    existing, _ = uh.read_rows(uh.history_path())
    probe = uh.claude_stats_probe(stats_path, existing_rows=existing)
    assert probe["importable_days"] == 1


# ─────────────────────────────────────────────────────────────────────────────
# Task 20 — history_view
# ─────────────────────────────────────────────────────────────────────────────


def test_history_view_classifies_provenance():
    today = dt.date(2026, 9, 4)
    horizon = today - dt.timedelta(days=uh.FREEZE_HORIZON_DAYS)  # 2026-08-21
    rows = [
        _row(today.isoformat(), source="ccusage"),  # scanned
        _row("2026-08-01", source="ccusage"),  # frozen (< horizon)
        _row(  # backfilled
            "2025-12-23",
            source="claude-stats-cache",
            cost_usd=None,
            input=None,
            output=None,
            cache_creation=None,
            cache_read=None,
        ),
    ]
    payload = uh.history_view(rows, None, None, today)
    by_date = {d["date"]: d for d in payload["days"]}
    assert by_date[today.isoformat()]["provenance"] == "scanned"
    assert by_date["2026-08-01"]["provenance"] == "frozen"
    assert by_date["2025-12-23"]["provenance"] == "backfilled"
    assert payload["horizon"] == horizon.isoformat()
    assert payload["counts"] == {"days": 3, "rows": 3, "backfilled_days": 1, "frozen_days": 1, "scanned_days": 1}


def test_history_view_cost_known_false_when_a_null_cost_contributes():
    today = dt.date(2026, 9, 4)
    rows = [
        _row("2026-09-01", model="claude-fable-5", cost_usd=1.0, source="ccusage"),
        _row("2026-09-01", model=None, cost_usd=None, source="ccusage"),
    ]
    payload = uh.history_view(rows, None, None, today)
    day = payload["days"][0]
    assert day["costKnown"] is False
    assert day["costUsd"] == pytest.approx(1.0)  # sums only the known rows, never fabricates the rest


def test_history_view_split_known_false_when_a_row_has_no_split():
    today = dt.date(2026, 9, 4)
    rows = [
        _row("2026-09-01", model="claude-fable-5"),
        _row(
            "2026-09-01",
            model="claude-opus-5",
            input=None,
            output=None,
            cache_creation=None,
            cache_read=None,
            total=5,
        ),
    ]
    payload = uh.history_view(rows, None, None, today)
    day = payload["days"][0]
    assert day["splitKnown"] is False
    assert day["tokens"]["total"] == 105  # total always exact


def test_history_view_since_until_clip():
    today = dt.date(2026, 9, 4)
    rows = [_row("2026-08-01"), _row("2026-08-10"), _row("2026-08-20")]
    payload = uh.history_view(rows, "2026-08-05", "2026-08-15", today)
    assert [d["date"] for d in payload["days"]] == ["2026-08-10"]
    assert payload["since"] == "2026-08-05"
    assert payload["until"] == "2026-08-15"


def test_history_view_includes_claude_stats_probe(tmp_data_home, tmp_path):
    stats_path = tmp_path / "stats-cache.json"
    _write_stats_cache(stats_path, [{"date": "2025-12-23", "tokensByModel": {"claude-3-opus": 1}}])
    today = dt.date(2026, 9, 4)
    payload = uh.history_view([], None, None, today, claude_stats_path=stats_path)
    assert payload["claude_stats"]["available"] is True
    assert payload["claude_stats"]["importable_days"] == 1
    assert payload["claude_stats"]["path"] == str(stats_path)


def test_history_view_warnings_default_empty_and_pass_through_when_given():
    # W6: `history_view` cannot discover a malformed LINE itself (that's
    # `read_rows`'s job) — it carries whatever its caller hands it, and
    # defaults to an empty list so every other caller building a view
    # straight from an in-memory row list need not fabricate one.
    today = dt.date(2026, 9, 4)
    assert uh.history_view([], None, None, today)["warnings"] == []
    payload = uh.history_view([], None, None, today, warnings=["some.jsonl:3: dropped malformed usage row"])
    assert payload["warnings"] == ["some.jsonl:3: dropped malformed usage row"]


def test_cmd_usage_history_json_carries_read_rows_warnings(tmp_data_home, capsys):
    # A corrupted ledger line was previously visible only in the TEXT branch
    # of `hub usage history` — invisible to the app, which only ever reads
    # `--json` (review W6).
    path = uh.history_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(_row("2026-08-14").to_dict()) + "\n" + "not json at all\n")
    args = argparse.Namespace(since=None, until=None, path_claude_stats=None, json=True)
    hcu.cmd_usage_history(args)
    payload = json.loads(capsys.readouterr().out)
    assert len(payload["warnings"]) == 1
    assert str(path) in payload["warnings"][0]
    # The good line still survives despite the malformed one alongside it.
    assert len(payload["days"]) == 1


def test_cmd_usage_history_json_warnings_empty_for_a_clean_ledger(tmp_data_home, capsys):
    path = uh.history_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(_row("2026-08-14").to_dict()) + "\n")
    args = argparse.Namespace(since=None, until=None, path_claude_stats=None, json=True)
    hcu.cmd_usage_history(args)
    payload = json.loads(capsys.readouterr().out)
    assert payload["warnings"] == []


# ─────────────────────────────────────────────────────────────────────────────
# Task 21 — no row field ever carries a path or a session id
# ─────────────────────────────────────────────────────────────────────────────


def test_rows_from_scan_never_leaks_session_ids_or_paths():
    scan = {
        "daily": [
            {
                "period": "2026-08-14",
                "agent": "all",
                "agents": [_agent_row("claude", [_model_breakdown("claude-fable-5", 10, 20, 30, 40, 1.0)])],
            }
        ],
        "weekly": [],
        "monthly": [],
        # Session rows carry a session id (period) and, once enriched, a
        # projectPath — rows_from_scan must never touch this section.
        "session": [
            {
                "agent": "claude",
                "period": "abc-123-session-uuid",
                "metadata": {"projectPath": "--Users-alice-secret-client--"},
            }
        ],
        "raw": "/Users/alice/secret-client-project full stdout dump",
    }
    rows = uh.rows_from_scan(scan, "2026-08-14T09:00:00Z", "ccusage")
    assert rows
    for row in rows:
        for value in row.to_dict().values():
            if isinstance(value, str):
                assert "/" not in value, f"path-shaped value leaked: {value!r}"
                assert "session" not in value
                assert "secret" not in value
                assert "abc-123" not in value


# ─────────────────────────────────────────────────────────────────────────────
# W1 — every `hub usage … --json` error path prints ONE JSON object to
# stdout and exits non-zero (1 = bad input/missing cache, 2 = empty scan).
# ─────────────────────────────────────────────────────────────────────────────


def test_cmd_usage_record_json_error_on_missing_cache_is_one_json_object(tmp_data_home, tmp_path, capsys):
    args = argparse.Namespace(from_cache=str(tmp_path / "nope.json"), json=True)
    with pytest.raises(SystemExit) as exc_info:
        hcu.cmd_usage_record(args)
    assert exc_info.value.code == 1
    payload = json.loads(capsys.readouterr().out.strip())  # must parse as exactly one object
    assert payload["ok"] is False
    assert isinstance(payload["error"], str) and payload["error"]


def test_cmd_usage_record_json_error_on_empty_scan_exits_2(tmp_data_home, tmp_path, capsys):
    cache_path = tmp_path / "cache.json"
    scanned_at = dt.datetime(2026, 8, 25, 9, 0, tzinfo=dt.timezone.utc).timestamp()
    cache_path.write_text(json.dumps({"scanned_at": scanned_at, "parsed": {"daily": []}}))
    args = argparse.Namespace(from_cache=str(cache_path), json=True)
    with pytest.raises(SystemExit) as exc_info:
        hcu.cmd_usage_record(args)
    assert exc_info.value.code == 2
    payload = json.loads(capsys.readouterr().out.strip())
    assert payload == {"ok": False, "error": "scan contained no daily rows"}
    assert not uh.history_path().exists()


def test_cmd_usage_record_text_mode_error_is_not_json(tmp_data_home, tmp_path, capsys):
    args = argparse.Namespace(from_cache=str(tmp_path / "nope.json"), json=False)
    with pytest.raises(SystemExit) as exc_info:
        hcu.cmd_usage_record(args)
    assert exc_info.value.code == 1
    out = capsys.readouterr().out.strip()
    with pytest.raises(json.JSONDecodeError):
        json.loads(out)


def test_cmd_usage_import_claude_stats_json_error_is_one_json_object(tmp_data_home, tmp_path, capsys):
    args = argparse.Namespace(path=str(tmp_path / "nope.json"), dry_run=False, json=True)
    with pytest.raises(SystemExit) as exc_info:
        hcu.cmd_usage_import_claude_stats(args)
    assert exc_info.value.code == 1
    payload = json.loads(capsys.readouterr().out.strip())
    assert payload["ok"] is False


# ─────────────────────────────────────────────────────────────────────────────
# W8 — `import-claude-stats --json`'s `path` uses the same `~/…` redaction
# the `claude_stats` probe uses, never the expanded real home.
# ─────────────────────────────────────────────────────────────────────────────


def test_cmd_usage_import_claude_stats_default_path_error_is_redacted(tmp_data_home, capsys):
    # No --path -> the default path under the faked $HOME, which does not exist.
    args = argparse.Namespace(path=None, dry_run=False, json=True)
    with pytest.raises(SystemExit):
        hcu.cmd_usage_import_claude_stats(args)
    payload = json.loads(capsys.readouterr().out.strip())
    assert "~/.claude/stats-cache.json" in payload["error"]
    assert str(Path.home()) not in payload["error"]


def test_cmd_usage_import_claude_stats_json_path_field_matches_display_path(tmp_data_home, tmp_path, capsys):
    stats_path = tmp_path / "stats-cache.json"
    _write_stats_cache(stats_path, [{"date": "2025-12-23", "tokensByModel": {"m": 1}}])
    args = argparse.Namespace(path=str(stats_path), dry_run=False, json=True)
    hcu.cmd_usage_import_claude_stats(args)
    payload = json.loads(capsys.readouterr().out.strip())
    assert payload["path"] == uh.display_path(stats_path)
    assert payload["inserted"] == 1


# ─────────────────────────────────────────────────────────────────────────────
# Pricing overrides — load_pricing_overrides / price_row / reprice_rows /
# record_from_cache's reprice pass / hub usage reprice.
# ─────────────────────────────────────────────────────────────────────────────

_SONNET_SPEC = {
    "inputCostPerToken": 0.000002,
    "outputCostPerToken": 0.00001,
    "cacheCreationInputTokenCost": 0.0000025,
    "cacheReadInputTokenCost": 0.0000002,
}


def test_load_pricing_overrides_missing_path_is_empty(tmp_path):
    assert uh.load_pricing_overrides(tmp_path / "nope.json") == {}


def test_load_pricing_overrides_malformed_json_is_empty_and_warns(tmp_path, capsys):
    path = tmp_path / "ccusage-pricing.json"
    path.write_text("not json")
    assert uh.load_pricing_overrides(path) == {}
    assert "could not read pricing overrides" in capsys.readouterr().err


def test_load_pricing_overrides_wrong_shape_is_empty_and_warns(tmp_path, capsys):
    path = tmp_path / "ccusage-pricing.json"
    path.write_text(json.dumps({"defaults": {}}))
    assert uh.load_pricing_overrides(path) == {}
    assert "pricingOverrides" in capsys.readouterr().err


def test_load_pricing_overrides_reads_the_checked_in_file():
    # No path override: exercises the real pricing_overrides_path() ->
    # hub_core.code_home() resolution against the repo's own checked-in file
    # — a guard against a typo breaking the file the app actually ships.
    path = uh.pricing_overrides_path()
    assert path.exists(), f"ccusage-pricing.json must exist at {path}"
    overrides = uh.load_pricing_overrides()
    assert set(overrides) == {
        "claude-fable-5-1",
        "claude-opus-5",
        "claude-sonnet-5",
        "gpt-6-astra",
    }
    assert overrides["gpt-6-astra"] == {
        "inputCostPerToken": 0.00001,
        "outputCostPerToken": 0.00005,
        "cacheCreationInputTokenCost": 0.0000125,
        "cacheReadInputTokenCost": 0.000001,
    }
    for model, spec in overrides.items():
        for field in (
            "inputCostPerToken",
            "outputCostPerToken",
            "cacheCreationInputTokenCost",
            "cacheReadInputTokenCost",
        ):
            assert isinstance(spec[field], (int, float)), f"{model}.{field}"
            assert spec[field] > 0


def test_price_row_computes_from_all_four_token_counts():
    row = _row(
        "2026-08-25",
        model="claude-sonnet-5",
        input=1000,
        output=2000,
        cache_creation=3000,
        cache_read=4000,
        cost_usd=0.0,
    )
    prices = {"claude-sonnet-5": _SONNET_SPEC}
    expected = round(
        1000 * _SONNET_SPEC["inputCostPerToken"]
        + 2000 * _SONNET_SPEC["outputCostPerToken"]
        + 3000 * _SONNET_SPEC["cacheCreationInputTokenCost"]
        + 4000 * _SONNET_SPEC["cacheReadInputTokenCost"],
        6,
    )
    assert uh.price_row(row, prices) == expected


def test_price_row_none_for_unknown_model():
    row = _row("2026-08-25", model="claude-sonnet-5", cost_usd=0.0)
    assert uh.price_row(row, {}) is None


def test_price_row_none_for_non_ccusage_source():
    row = _row("2026-08-25", model="claude-sonnet-5", source="claude-stats-cache", cost_usd=None)
    prices = {"claude-sonnet-5": _SONNET_SPEC}
    assert uh.price_row(row, prices) is None


def test_reprice_rows_idempotent_and_leaves_other_models_untouched():
    zero_cost = _row(
        "2026-08-25",
        model="claude-sonnet-5",
        input=1000,
        output=0,
        cache_creation=0,
        cache_read=0,
        cost_usd=0.0,
        sessions=2,
    )
    other = _row(
        "2026-08-24",
        model="claude-opus-4-5",
        input=100,
        output=0,
        cache_creation=0,
        cache_read=0,
        cost_usd=1.23,
    )
    prices = {"claude-sonnet-5": _SONNET_SPEC}

    once, stats = uh.reprice_rows([zero_cost, other], prices)
    assert stats["rows_changed"] == 1
    assert stats["models"] == {"claude-sonnet-5": 1}
    assert stats["delta_usd"] > 0
    repriced = next(r for r in once if r.model == "claude-sonnet-5")
    assert repriced.cost_usd == round(1000 * _SONNET_SPEC["inputCostPerToken"], 6)
    assert repriced.sessions == 2
    untouched = next(r for r in once if r.model == "claude-opus-4-5")
    assert untouched.cost_usd == 1.23
    assert untouched is other  # never rebuilt when nothing changed

    twice, stats2 = uh.reprice_rows(once, prices)
    assert stats2 == {"rows_changed": 0, "models": {}, "delta_usd": 0.0}
    assert [r.cost_usd for r in twice] == [r.cost_usd for r in once]


def test_reprice_rows_stats_shape_with_no_changes():
    row = _row("2026-08-25", model="unknown-model", cost_usd=5.0)
    rows, stats = uh.reprice_rows([row], {})
    assert rows == [row]
    assert stats == {"rows_changed": 0, "models": {}, "delta_usd": 0.0}


# REVIEW-A #1 (blocker) / #2 — ccusage prices the one-hour cache-write tier
# and this override table only ever knows the five-minute rate, so a row
# ccusage already priced above $0 must never be revised, even when its
# model has an override on file and the override would compute a DIFFERENT
# number. Only a genuine $0-or-never-priced row is eligible for repair.


def test_reprice_rows_never_lowers_an_already_priced_row():
    # Same model, same token counts as `test_price_row_computes_from_all_four_
    # token_counts` — the override formula would compute a DIFFERENT (lower)
    # number here. That must never reach this row: ccusage already priced it.
    already_priced = _row(
        "2026-09-06",
        model="claude-sonnet-5",
        input=1000,
        output=2000,
        cache_creation=3000,
        cache_read=4000,
        cost_usd=999.0,  # ccusage's own number — must survive untouched
    )
    prices = {"claude-sonnet-5": _SONNET_SPEC}

    rows, stats = uh.reprice_rows([already_priced], prices)
    assert stats == {"rows_changed": 0, "models": {}, "delta_usd": 0.0}
    assert rows == [already_priced]
    assert rows[0].cost_usd == 999.0
    assert rows[0] is already_priced  # never rebuilt
    assert uh.price_row(already_priced, prices) is None


def test_reprice_rows_still_repairs_a_frozen_zero_cost_row():
    # "Frozen" here only means: an old row, already sitting in the ledger
    # with no cost — reprice_rows itself has no notion of the freeze
    # horizon (that lives in merge_rows/record_from_cache), so this proves
    # the eligibility guard above did not also close off the repair path
    # the whole feature exists for.
    frozen_zero_cost = _row(
        "2026-08-01",
        model="claude-sonnet-5",
        input=1000,
        output=2000,
        cache_creation=3000,
        cache_read=4000,
        cost_usd=0.0,
        captured_at="2026-08-01T00:00:00Z",
    )
    prices = {"claude-sonnet-5": _SONNET_SPEC}

    rows, stats = uh.reprice_rows([frozen_zero_cost], prices)
    assert stats["rows_changed"] == 1
    assert rows[0].cost_usd > 0.0
    assert rows[0].cost_usd == round(
        1000 * _SONNET_SPEC["inputCostPerToken"]
        + 2000 * _SONNET_SPEC["outputCostPerToken"]
        + 3000 * _SONNET_SPEC["cacheCreationInputTokenCost"]
        + 4000 * _SONNET_SPEC["cacheReadInputTokenCost"],
        6,
    )


def test_record_from_cache_repairs_a_frozen_zero_cost_row(tmp_data_home, tmp_path, monkeypatch):
    # Seed a FROZEN (>14 days old relative to the scan) zero-cost row for an
    # overrides model, directly into the ledger — the shape a pre-override
    # scan would have written.
    frozen_row = _row(
        "2026-08-01",
        agent="claude",
        model="claude-sonnet-5",
        input=1000,
        output=0,
        cache_creation=0,
        cache_read=0,
        total=1000,
        cost_usd=0.0,
        captured_at="2026-08-01T00:00:00Z",
    )
    uh.write_rows(uh.history_path(), [frozen_row])

    overrides_path = tmp_path / "ccusage-pricing.json"
    overrides_path.write_text(
        json.dumps({"defaults": {"pricingOverrides": {"claude-sonnet-5": _SONNET_SPEC}}})
    )
    monkeypatch.setattr(uh, "pricing_overrides_path", lambda: overrides_path)

    # A later scan for a DIFFERENT day/agent pair — frozen_row's own
    # (date, agent) is untouched by merge_rows, only by the reprice pass.
    cache_path = tmp_path / "cache.json"
    scanned_at = dt.datetime(2026, 8, 25, 9, 0, tzinfo=dt.timezone.utc).timestamp()
    agent_row = _agent_row("codex", [_model_breakdown("m", 1, 1, 1, 1, 0.01)])
    parsed = _scan([{"period": "2026-08-25", "agent": "all", "agents": [agent_row]}])
    _write_scan_cache(cache_path, scanned_at, parsed)

    stats = uh.record_from_cache(cache_path)
    assert stats["repriced"] == 1

    rows, _ = uh.read_rows(uh.history_path())
    repaired = next(r for r in rows if r.model == "claude-sonnet-5")
    assert repaired.cost_usd == round(1000 * _SONNET_SPEC["inputCostPerToken"], 6)
    assert repaired.date == "2026-08-01"  # frozen day itself never moved


# ─────────────────────────────────────────────────────────────────────────────
# hub usage reprice
# ─────────────────────────────────────────────────────────────────────────────


def test_cmd_usage_reprice_dry_run_writes_nothing(tmp_data_home, tmp_path, monkeypatch, capsys):
    row = _row(
        "2026-08-25",
        model="claude-sonnet-5",
        input=1000,
        output=0,
        cache_creation=0,
        cache_read=0,
        cost_usd=0.0,
    )
    uh.write_rows(uh.history_path(), [row])
    overrides_path = tmp_path / "ccusage-pricing.json"
    overrides_path.write_text(
        json.dumps({"defaults": {"pricingOverrides": {"claude-sonnet-5": _SONNET_SPEC}}})
    )
    monkeypatch.setattr(uh, "pricing_overrides_path", lambda: overrides_path)

    args = argparse.Namespace(dry_run=True, json=True)
    hcu.cmd_usage_reprice(args)
    payload = json.loads(capsys.readouterr().out.strip())
    assert payload["ok"] is True
    assert payload["dry_run"] is True
    assert payload["rows_changed"] == 1
    assert payload["overrides"] == ["claude-sonnet-5"]

    rows, _ = uh.read_rows(uh.history_path())
    assert rows[0].cost_usd == 0.0, "dry-run must write nothing"


def test_cmd_usage_reprice_real_run_writes_and_reports_zero_next_time(tmp_data_home, tmp_path, monkeypatch, capsys):
    row = _row(
        "2026-08-25",
        model="claude-sonnet-5",
        input=1000,
        output=0,
        cache_creation=0,
        cache_read=0,
        cost_usd=0.0,
    )
    uh.write_rows(uh.history_path(), [row])
    overrides_path = tmp_path / "ccusage-pricing.json"
    overrides_path.write_text(
        json.dumps({"defaults": {"pricingOverrides": {"claude-sonnet-5": _SONNET_SPEC}}})
    )
    monkeypatch.setattr(uh, "pricing_overrides_path", lambda: overrides_path)

    hcu.cmd_usage_reprice(argparse.Namespace(dry_run=False, json=True))
    payload = json.loads(capsys.readouterr().out.strip())
    assert payload["rows_changed"] == 1

    rows, _ = uh.read_rows(uh.history_path())
    assert rows[0].cost_usd == round(1000 * _SONNET_SPEC["inputCostPerToken"], 6)

    # A second run over the now-correct ledger changes nothing.
    hcu.cmd_usage_reprice(argparse.Namespace(dry_run=False, json=True))
    payload2 = json.loads(capsys.readouterr().out.strip())
    assert payload2["rows_changed"] == 0


def test_cmd_usage_reprice_text_mode_no_changes(tmp_data_home, tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(uh, "pricing_overrides_path", lambda: tmp_path / "nope.json")
    hcu.cmd_usage_reprice(argparse.Namespace(dry_run=False, json=False))
    out = capsys.readouterr().out
    assert "no rows changed" in out
