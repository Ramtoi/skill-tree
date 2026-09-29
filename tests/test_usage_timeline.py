from __future__ import annotations

import json
import time

from skill_hub.domain.usage.usage_timeline import timeline_payload


def _row(harness: str, events: list[dict]) -> dict:
    return {"harness": harness, "events": events}


def test_timeline_groups_events_and_uses_utc_bounds() -> None:
    payload = timeline_payload(
        [_row("claude-code", [
            {"kind": "tool", "name": "github/search", "at": "2026-09-02T23:30:00+02:00", "token_delta": 7},
            {"kind": "skill", "name": "brainstorm", "at": "2026-09-03T00:30:00Z", "token_delta": 2},
            {"kind": "human_turn", "at": "2026-09-03T01:00:00Z", "token_delta": 99},
        ])],
        since="2026-09-02",
        until="2026-09-03",
    )
    assert payload["days"] == [
        {"date": "2026-09-02", "skills": {}, "tools": {"github": 1}},
        {"date": "2026-09-03", "skills": {"brainstorm": 1}, "tools": {}},
    ]
    assert payload["peaks"]["grid"][2][21] == 7
    assert payload["peaks"]["grid"][3][0] == 2


def test_timeline_filters_rows_and_never_returns_private_fields() -> None:
    payload = timeline_payload([_row("codex", [{
        "kind": "tool", "name": "built-in", "at": "2026-09-01T10:00:00Z", "token_delta": -4,
        "session_id": "secret", "prompt": "secret prompt", "path": "/private",
    }]), _row("claude-code", [])], harness="codex")
    assert payload["harnesses"] == [{"id": "codex", "name": "Codex"}]
    assert payload["days"][0]["tools"] == {"built-in": 1}
    assert "secret" not in str(payload)
    assert "/private" not in str(payload)


def test_timeline_includes_midnight_offset_bounds_and_frozen_children() -> None:
    payload = timeline_payload([
        {"harness": "codex", "session_id": "hidden", "frozen": True, "events": [
            {"kind": "skill", "name": "one", "at": "2026-09-01T23:30:00Z", "token_delta": 1},
            {"kind": "tool", "name": "touchpoint/list", "at": "2026-09-02T00:30:00+02:00", "token_delta": 2},
        ]},
        {"harness": "codex", "parent_session_id": "hidden", "events": [
            {"kind": "script", "name": "two", "at": "2026-09-02T01:00:00Z", "token_delta": 3},
        ]},
    ], since="2026-09-01", until="2026-09-02")
    assert [day["date"] for day in payload["days"]] == ["2026-09-01", "2026-09-02"]
    assert payload["days"][0]["skills"] == {"one": 1}
    assert payload["days"][1]["skills"] == {"two": 1}
    assert payload["days"][0]["tools"] == {"touchpoint": 1}
    assert payload["peaks"]["grid"][1][22] == 2
    assert payload["peaks"]["grid"][2][1] == 3


def test_timeline_filters_unknown_harness_and_empty_windows() -> None:
    rows = [_row("claude-code", [{"kind": "skill", "name": "x", "at": "2026-09-01T00:00:00Z", "token_delta": 4}])]
    empty = timeline_payload(rows, harness="unknown")
    assert empty["days"] == []
    assert empty["peaks"]["grid"] == [[0] * 24 for _ in range(7)]
    assert timeline_payload(rows, since="2026-09-02", until="2026-09-03")["days"] == []


def test_timeline_filters_project_before_harness_and_aggregation() -> None:
    rows = [
        {"project": "alpha", "harness": "claude-code", "events": [
            {"kind": "skill", "name": "alpha-skill", "at": "2026-09-01T01:00:00Z", "token_delta": 3},
        ]},
        {"project": "alpha", "harness": "claude-code", "parent_session_id": "a", "events": [
            {"kind": "tool", "name": "alpha-server/run", "at": "2026-09-02T02:00:00Z", "token_delta": 5},
        ]},
        {"project": "beta", "harness": "codex", "events": [
            {"kind": "skill", "name": "beta-skill", "at": "2026-09-03T03:00:00Z", "token_delta": 99},
        ]},
    ]
    alpha = timeline_payload(rows, project="alpha")
    assert alpha["project"] == "alpha"
    assert [day["date"] for day in alpha["days"]] == ["2026-09-01", "2026-09-02"]
    assert alpha["days"][1]["tools"] == {"alpha-server": 1}
    assert sum(map(sum, alpha["peaks"]["grid"])) == 8
    assert alpha["harnesses"] == [{"id": "claude-code", "name": "Claude Code"}]
    assert timeline_payload(rows)["project"] is None
    unknown = timeline_payload(rows, project="unknown")
    assert unknown["days"] == []
    assert unknown["peaks"]["grid"] == [[0] * 24 for _ in range(7)]


def test_timeline_reads_600_rows_quickly_and_payload_is_private() -> None:
    rows = [
        _row("codex", [{"kind": "tool", "name": "built-in", "at": f"2026-09-{i % 28 + 1:02d}T12:00:00Z",
                         "token_delta": 1, "session_id": "secret", "path": "/secret", "prompt": "secret"}])
        for i in range(600)
    ]
    started = time.perf_counter()
    payload = timeline_payload(rows)
    assert time.perf_counter() - started < 1
    encoded = json.dumps(payload)
    assert all(value not in encoded for value in ("secret", "/secret"))
