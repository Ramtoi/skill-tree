"""Pure, privacy-safe aggregation for the sessions usage timeline.

The ``days`` result has one row per UTC date containing at least one
recognized skill or tool event, sorted in ascending date order.
"""

from __future__ import annotations

import datetime as _dt
from typing import Any

_HARNESS_NAMES = {"claude-code": "Claude Code", "codex": "Codex"}


def _timestamp(value: object) -> _dt.datetime | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = _dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=_dt.timezone.utc)
    return parsed.astimezone(_dt.timezone.utc)


def _bound(value: str | None, name: str) -> _dt.date | None:
    if value is None:
        return None
    try:
        return _dt.date.fromisoformat(value)
    except ValueError as exc:
        raise ValueError(f"{name} must be YYYY-MM-DD") from exc


def validate_bounds(since: str | None, until: str | None) -> None:
    since_date = _bound(since, "since")
    until_date = _bound(until, "until")
    if since_date and until_date and since_date > until_date:
        raise ValueError("since must be on or before until")


def timeline_payload(
    rows: list[dict[str, Any]] | tuple[dict[str, Any], ...],
    *,
    since: str | None = None,
    until: str | None = None,
    harness: str | None = None,
    project: str | None = None,
) -> dict[str, Any]:
    """Aggregate supplied session rows; this function performs no I/O."""
    validate_bounds(since, until)
    since_date = _bound(since, "since")
    until_date = _bound(until, "until")

    days: dict[str, dict[str, dict[str, int]]] = {}
    grid = [[0 for _ in range(24)] for _ in range(7)]
    matching_harnesses: set[str] = set()
    for row in rows:
        if project is not None and row.get("project") != project:
            continue
        if harness and row.get("harness") != harness:
            continue
        row_harness = row.get("harness")
        if isinstance(row_harness, str):
            matching_harnesses.add(row_harness)
        for event in row.get("events") or []:
            if not isinstance(event, dict):
                continue
            at = _timestamp(event.get("at"))
            if at is None:
                continue
            event_date = at.date()
            if since_date and event_date < since_date or until_date and event_date > until_date:
                continue
            token_delta = event.get("token_delta", 0)
            if isinstance(token_delta, (int, float)) and token_delta >= 0:
                grid[at.weekday()][at.hour] += int(token_delta)
            kind = event.get("kind")
            name = event.get("name")
            if kind not in {"skill", "slash_command", "script", "tool"} or not isinstance(name, str) or not name:
                continue
            day = days.setdefault(event_date.isoformat(), {"skills": {}, "tools": {}})
            if kind in {"skill", "slash_command", "script"}:
                day["skills"][name] = day["skills"].get(name, 0) + 1
            else:
                server = name.split("/", 1)[0] if "/" in name else "built-in"
                day["tools"][server] = day["tools"].get(server, 0) + 1

    return {
        "schema_version": 1,
        "since": since,
        "until": until,
        "project": project,
        "days": [
            {"date": date, "skills": value["skills"], "tools": value["tools"]}
            for date, value in sorted(days.items())
        ],
        "peaks": {"unit": "tokens", "grid": grid},
        "harnesses": [
            {"id": key, "name": _HARNESS_NAMES.get(key, key)}
            for key in sorted(matching_harnesses)
        ],
    }
