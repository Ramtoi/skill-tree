"""Pure canonical Usage session summary reduction from published facts."""

from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any, Mapping

from skill_hub.domain.usage import usage_classify
from skill_hub.infrastructure.usage import usage_loadouts

ACTIVITY_CLASSES = ("read", "edit", "verify", "operate", "delegate", "skill", "external")
_TOKEN_KEYS = ("input", "output", "cache_creation", "cache_read")
_EVENT_KINDS = frozenset({"human_turn", "slash_command", "skill", "script", "subagent", "tool"})


def project_session(
    harness: str,
    session_id: str,
    *,
    facts: Mapping[str, list[dict[str, Any]]],
    registry: dict,
    loadout_rows: list[dict[str, Any]],
    now: datetime,
    tracked_files: int | None,
) -> dict[str, Any]:
    """Reduce host-selected published observations without I/O or mutation."""
    scopes = [
        item
        for item in facts.get("structural", [])
        if item.get("record_type") == "source_scope"
        and item.get("harness") == harness
        and item.get("root_session_id") == session_id
    ]
    scope = next((item for item in scopes if item.get("source_session_id") == session_id), scopes[0] if scopes else {})
    runs = [
        item
        for item in facts.get("run", [])
        if item.get("harness") == harness and item.get("root_session_id") == session_id
    ]
    local_runs = {str(item["run_id"]) for item in runs if item.get("source_session_id") == session_id}
    roots = {str(item["run_id"]) for item in runs
             if item.get("run_id") in local_runs and item.get("parent_run_id") not in local_runs}
    if not roots:
        roots = {session_id}
    children = _descendants(runs, roots)
    member_ids = roots | children
    messages = [item for item in facts.get("message", []) if item.get("run_id") in roots]
    calls = [item for item in facts.get("call", []) if item.get("run_id") in roots]
    seeds = [
        item
        for item in facts.get("structural", [])
        if item.get("record_type") != "source_scope" and item.get("run_id") in roots
    ]
    tokens = _token_totals(facts.get("token", []), member_ids)
    own = _sum_token_rows(tokens, roots)
    child = _sum_token_rows(tokens, children)
    project = scope.get("project_key") if isinstance(scope.get("project_key"), str) else "unregistered"
    root_runs = [item for item in runs if item.get("run_id") in roots]
    root_tokens = [item for item in facts.get("token", []) if item.get("run_id") in roots]
    member_tokens = [item for item in facts.get("token", []) if item.get("run_id") in member_ids]
    started_at = _minimum_time(
        _first_time(root_runs, messages, calls, root_tokens), scope.get("observed_start")
    )
    last_activity_at = _maximum_time(
        _last_time(root_runs, messages, calls, member_tokens), scope.get("observed_end")
    )
    activity = _activity(calls, seeds, harness)
    root_model = next(
        (model for run in root_runs for model in run.get("models", []) if isinstance(model, str)), None
    )
    events, steering, you_skills = _events(
        messages, calls, seeds, facts.get("token", []), roots, registry, harness, root_model, tokens
    )
    skills = _skills(calls, seeds, you_skills)
    loadout_hash, loadout_assumed = _loadout(loadout_rows, project, harness, started_at)
    total = {key: own[key] for key in _TOKEN_KEYS}
    total["total"] = own["total"]
    total["subagent_total"] = child["total"]
    assistant_messages = [item for item in messages if item.get("role") == "assistant"]
    text_len = sum(_int(item.get("text_len")) for item in assistant_messages)
    thinking_len = sum(_int(item.get("thinking_len")) for item in assistant_messages)
    first_turn = _first_turn(messages, facts.get("token", []), roots)
    coverage = _coverage(facts.get("coverage"))
    result = {
        "schema_version": 1,
        "harness": harness,
        "session_id": session_id,
        "project": project,
        "started_at": started_at,
        "last_activity_at": last_activity_at,
        "frozen": _frozen(last_activity_at, now),
        "loadout_hash": loadout_hash,
        "loadout_assumed": loadout_assumed,
        "tokens": total,
        "first_turn_input_total": first_turn,
        "cache_hit_ratio": _cache_hit_ratio(own),
        "steering_count": steering,
        "activity": activity,
        "thinking_text_share": (thinking_len / text_len) if text_len else None,
        "files_read": _file_count(calls, seeds, "read"),
        "files_edited": _file_count(calls, seeds, "edit"),
        "tracked_files": tracked_files,
        "subagents": _subagents(harness, runs, tokens, children, calls, seeds),
        "skills": skills,
        "intent_excerpt": next(
            (
                usage_classify.redact_excerpt(str(item.get("excerpt") or ""))
                for item in sorted(messages, key=_order)
                if item.get("kind") in {"human_turn", "slash_command"}
            ),
            "",
        ),
        "events": events,
        "compactions": sum(_int(item.get("count", 1)) for item in seeds if item.get("kind") == "compaction"),
        "excerpt_redaction_version": 1,
        "summary_provenance": "canonical",
        "capture_coverage": coverage,
    }
    if harness == "codex" and "parent_session_id" in scope:
        result["parent_session_id"] = scope["parent_session_id"]
    return result


def _descendants(runs: list[dict[str, Any]], roots: set[str]) -> set[str]:
    by_parent: dict[str, list[str]] = defaultdict(list)
    for run in runs:
        if isinstance(run.get("parent_run_id"), str) and isinstance(run.get("run_id"), str):
            by_parent[run["parent_run_id"]].append(run["run_id"])
    result: set[str] = set()
    pending = list(roots)
    while pending:
        for child in by_parent.get(pending.pop(), []):
            if child not in result and child not in roots:
                result.add(child)
                pending.append(child)
    return result


def _token_totals(rows: list[dict[str, Any]], selected: set[str]) -> dict[str, dict[str, int]]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        if isinstance(row.get("run_id"), str) and row["run_id"] in selected:
            grouped[row["run_id"]].append(row)
    return {run_id: _run_tokens(samples) for run_id, samples in grouped.items()}


def _run_tokens(rows: list[dict[str, Any]]) -> dict[str, int]:
    """Reduce the same deltas used by events, retaining authoritative totals."""
    keys = (*_TOKEN_KEYS, "total")
    deltas = _token_deltas(rows, {row["run_id"] for row in rows})
    return {key: sum(item["delta"][key] for item in deltas) for key in keys}


def _sum_token_rows(rows: dict[str, dict[str, int]], ids: set[str]) -> dict[str, int]:
    return {key: sum(rows.get(run_id, {}).get(key, 0) for run_id in ids) for key in (*_TOKEN_KEYS, "total")}


def _activity(calls: list[dict[str, Any]], seeds: list[dict[str, Any]], harness: str) -> dict[str, int]:
    result = {key: 0 for key in ACTIVITY_CLASSES}
    call_correlations = {call.get("native_call_id") for call in calls}
    for call in calls:
        kind = call.get("activity_class")
        if kind in result:
            result[kind] += 1
    for seed in seeds:
        if seed.get("kind") == "activity" and seed.get("name") in result:
            result[seed["name"]] += _int(seed.get("count", 1))
        elif seed.get("kind") == "skill" and seed.get("correlation_id") not in call_correlations:
            result["skill"] += _int(seed.get("count", 1))
    return result


def _file_count(calls: list[dict[str, Any]], seeds: list[dict[str, Any]], verb: str) -> int:
    call_key = f"{verb}_file_hash"
    seed_kind = f"{verb}_file"
    return len(
        {item[call_key] for item in calls if item.get(call_key)}
        | {item.get("name") for item in seeds if item.get("kind") == seed_kind and item.get("name")}
    )


def _events(messages, calls, seeds, token_rows, member_ids, registry, harness, root_model, child_tokens):
    by_message = {item.get("message_id"): item for item in messages}
    events = [item for item in seeds if item.get("kind") in _EVENT_KINDS and item.get("at")]
    seeded = {item.get("message_id") for item in events}
    events.extend(
        {
            "kind": item.get("kind"),
            "at": item.get("at"),
            "message_id": item.get("message_id"),
            "run_id": item.get("run_id"),
            **item,
        }
        for item in messages
        if item.get("kind") in {"human_turn", "slash_command"}
        and item.get("message_id") not in seeded
        and item.get("at")
    )
    events.sort(key=lambda item: (item.get("at") or "", *_order(item)))
    activity_log = sorted(
        [
            *[item for item in calls if item.get("activity_class") in ACTIVITY_CLASSES],
            *[
                {"at": item.get("at"), "activity_class": item["name"], **item}
                for item in seeds
                if item.get("kind") == "activity" and item.get("name") in ACTIVITY_CLASSES
            ],
            *[
                {**item, "activity_class": "skill"}
                for item in seeds
                if harness == "codex" and item.get("kind") == "skill"
                and not item.get("message_id")
                and item.get("correlation_id") not in {call.get("native_call_id") for call in calls}
            ],
        ],
        key=lambda item: (item.get("at") or "", *_order(item)),
    )
    token_log = _token_deltas(token_rows, member_ids)
    text_log = sorted(
        [
            item
            for item in messages
            if item.get("at") and (item.get("role") == "assistant" or harness == "codex")
        ],
        key=lambda item: (item.get("at") or "", *_order(item)),
    )
    activity_cursor = token_cursor = text_cursor = 0
    output = []
    you_skills: dict[str, int] = defaultdict(int)
    steering = 0
    human_index = 0
    for seed in events:
        message = by_message.get(seed.get("message_id"), {})
        kind = seed.get("kind") if seed.get("kind") in _EVENT_KINDS else "human_turn"
        event_activity = {key: 0 for key in ACTIVITY_CLASSES}
        event_tokens = {key: 0 for key in _TOKEN_KEYS}
        thinking_len = output_text_len = token_delta = 0
        if not seed.get("additive"):
            at = seed.get("at")
            while activity_cursor < len(activity_log) and (activity_log[activity_cursor].get("at") or "") <= at:
                event_activity[activity_log[activity_cursor]["activity_class"]] += 1
                activity_cursor += 1
            while token_cursor < len(token_log) and (token_log[token_cursor].get("at") or "") <= at:
                item = token_log[token_cursor]
                token_delta += _event_token_delta(item)
                for key in _TOKEN_KEYS:
                    event_tokens[key] += item["delta"][key]
                token_cursor += 1
            while text_cursor < len(text_log) and (text_log[text_cursor].get("at") or "") <= at:
                item = text_log[text_cursor]
                thinking_len += _int(item.get("thinking_len"))
                output_text_len += _int(item.get("text_len"))
                text_cursor += 1
        if kind in {"human_turn", "slash_command"}:
            stacked = bool(seed.get("stacked", message.get("stacked", False)))
            interrupted = bool(seed.get("interrupted", message.get("interrupted", False)))
            if not stacked and (interrupted or human_index > 0):
                steering += 1
            human_index += 1
        if harness == "codex" and kind == "human_turn":
            event_activity["operate"] += 1
            event_activity["skill"] += sum(
                _int(item.get("count", 1))
                for item in seeds
                if item.get("kind") == "skill" and item.get("message_id") == seed.get("message_id")
            )
        name = seed.get("name") if kind != "human_turn" else None
        if kind == "slash_command" and isinstance(name, str) and name in (registry.get("skills") or {}):
            you_skills[name] += 1
        if kind == "subagent":
            child_call = next((call for call in calls
                               if call.get("native_call_id") == seed.get("correlation_id")), {})
            child = child_call.get("child_run_id")
            if child in child_tokens:
                event_tokens = {key: child_tokens[child][key] for key in _TOKEN_KEYS}
        output.append(
            {
                "kind": kind,
                "at": seed.get("at"),
                "token_delta": token_delta,
                "tokens": event_tokens,
                "thinking_len": thinking_len,
                "output_text_len": output_text_len,
                "name": name,
                "model": seed.get("model") or (root_model if harness == "codex" else None),
                "invoker": seed.get("invoker") or ("you" if kind in {"human_turn", "slash_command"} else "model"),
                "excerpt": usage_classify.redact_excerpt(str(message.get("excerpt") or ""))
                if kind in {"human_turn", "slash_command"}
                else "",
                "activity": event_activity,
                "edited_without_verify": False,
                **({"additive": True} if seed.get("additive") else {}),
            }
        )
    final = next((item for item in reversed(output) if not item.get("additive")), output[-1] if output else None)
    if final is not None:
        while token_cursor < len(token_log):
            item = token_log[token_cursor]
            final["token_delta"] += _event_token_delta(item)
            for key in _TOKEN_KEYS:
                final["tokens"][key] += item["delta"][key]
            token_cursor += 1
        while text_cursor < len(text_log):
            item = text_log[text_cursor]
            final["thinking_len"] += _int(item.get("thinking_len"))
            final["output_text_len"] += _int(item.get("text_len"))
            text_cursor += 1
    output.sort(key=lambda item: (item["at"] or "", 1 if item.get("additive") else 0))
    return output, steering, you_skills


def _event_token_delta(item):
    """Preserve Claude output plus cache creation and Codex total deltas."""
    if item.get("origin") == "legacy":
        return item["delta"]["output"] + item["delta"]["cache_creation"]
    return item["delta"]["total"]


def _token_deltas(rows, member_ids):
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        if row.get("run_id") in member_ids:
            grouped[str(row["run_id"])].append(row)
    result = []
    for run_rows in grouped.values():
        if any(row.get("origin") == "native" for row in run_rows):
            run_rows = [row for row in run_rows if row.get("origin") != "event_mirror"]
        # Codex cumulative samples report the whole run/thread, even when the
        # model changes between samples. Keep one baseline per run and retain
        # each sample's model on the emitted increment.
        previous = (0, 0, 0, 0)
        previous_total: int | None = None
        for row in sorted(run_rows, key=_order):
            values = tuple(_int(row.get(key)) for key in _TOKEN_KEYS)
            total = row.get("total")
            if isinstance(total, int):
                values = (*values[:3], min(values[3], max(0, total - sum(values[:3]))))
            total_delta = total if isinstance(total, int) else sum(values)
            if row.get("cumulative"):
                old = previous
                old_total = previous_total
                decreased = any(left < right for left, right in zip(values, old)) or (
                    isinstance(total, int) and isinstance(old_total, int) and total < old_total
                )
                delta = (
                    values
                    if row.get("epoch_marker") or decreased
                    else tuple(max(0, left - right) for left, right in zip(values, old))
                )
                if (
                    not row.get("epoch_marker")
                    and not decreased
                    and isinstance(total, int)
                    and isinstance(old_total, int)
                ):
                    excess = max(0, sum(delta) - max(0, total - old_total))
                    delta = (*delta[:3], max(0, delta[3] - excess))
                if not row.get("epoch_marker") and not decreased:
                    total_delta = max(0, total_delta - (old_total if isinstance(old_total, int) else sum(old)))
                previous = values
                previous_total = total if isinstance(total, int) else None
            else:
                delta = values
            result.append({**row, "delta": {**dict(zip(_TOKEN_KEYS, delta)), "total": total_delta}})
    return sorted(result, key=lambda item: (item.get("at") or "", *_order(item)))


def _skills(calls, seeds, you_skills):
    values: dict[tuple[str, str], int] = defaultdict(int)
    for call in calls:
        if isinstance(call.get("skill_key"), str):
            values[(call["skill_key"], str(call.get("invocation_origin") or "model"))] += 1
    call_correlations = {call.get("native_call_id") for call in calls}
    for seed in seeds:
        if seed.get("kind") == "skill" and isinstance(seed.get("name"), str):
            if seed.get("correlation_id") in call_correlations:
                continue
            values[(seed["name"], str(seed.get("invoker") or "model"))] += _int(seed.get("count", 1))
    for key, count in you_skills.items():
        values[(key, "you")] += count
    return [{"key": key, "invoker": invoker, "count": count} for (key, invoker), count in sorted(values.items())]


def _subagents(harness, runs, tokens, children, calls, seeds):
    labels = {seed.get("correlation_id"): seed.get("name") for seed in seeds
              if seed.get("kind") == "child_invocation" and seed.get("name")}
    child_labels = {call.get("child_run_id"): labels.get(call.get("native_call_id")) for call in calls
                    if call.get("child_run_id")}
    grouped: dict[tuple[str, str], dict[str, Any]] = {}
    for run in runs:
        run_id = run.get("run_id")
        if run_id not in children:
            continue
        role = str(run.get("role") or "unknown")
        model = next(iter(run.get("models") or []), "unknown")
        if harness == "codex":
            item = grouped.setdefault((role, str(model)), {"role": role, "model": str(model), "tokens": 0})
            item["tokens"] += tokens.get(run_id, {}).get("total", 0)
            continue
        if run_id not in tokens:
            continue  # A launch acknowledgement alone has no captured child usage.
        role = child_labels.get(run_id) or "unknown"
        key = (role, str(model))
        item = grouped.setdefault(key, {"subagent_type": role, "model": str(model), "tokens": 0, "count": 0})
        item["tokens"] += tokens.get(run_id, {}).get("total", 0)
        item["count"] += 1
    return sorted(
        grouped.values(),
        key=lambda item: (str(item.get("subagent_type") or item.get("role") or ""), item["model"]),
    )


def _first_turn(messages, token_rows, roots):
    candidates = [
        (item.get("at") or "", item.get("first_turn_input_total"))
        for item in messages
        if item.get("run_id") in roots and isinstance(item.get("first_turn_input_total"), int)
    ]
    candidates.extend(
        (item.get("at") or "", item.get("first_turn_input_total"))
        for item in token_rows
        if item.get("run_id") in roots and isinstance(item.get("first_turn_input_total"), int)
    )
    if candidates:
        return min(candidates, key=lambda item: item[0])[1]
    native = [item for item in token_rows if item.get("run_id") in roots and item.get("origin") == "native"]
    rows = native or [item for item in token_rows if item.get("run_id") in roots]
    if not rows:
        return None
    first = min(rows, key=lambda item: (item.get("at") or "", _order(item)))
    return _int(first.get("input")) + _int(first.get("cache_creation")) + _int(first.get("cache_read"))


def _coverage(value):
    if not isinstance(value, list) or not value:
        return "unavailable"
    states = {item.get("status") for item in value if isinstance(item, dict)}
    return "complete" if states == {"complete"} else ("partial" if states & {"complete", "partial"} else "unavailable")


def _loadout(rows, project, harness, started_at):
    if harness == "codex":
        return None, True
    row = usage_loadouts.loadout_at(rows, project, harness, started_at) if started_at else None
    if row is not None:
        return row.get("hash"), False
    first = usage_loadouts.first_loadout_for_pair(rows, project, harness)
    return (first.get("hash") if first else None), True


def _cache_hit_ratio(tokens):
    denominator = tokens["input"] + tokens["cache_creation"] + tokens["cache_read"]
    return tokens["cache_read"] / denominator if denominator else None


def _first_time(runs, messages, calls, tokens):
    values = [
        item.get("started_at") or item.get("at")
        for item in [*runs, *messages, *calls, *tokens]
        if item.get("started_at") or item.get("at")
    ]
    return min(values) if values else None


def _last_time(runs, messages, calls, tokens):
    values = [
        item.get("ended_at") or item.get("at")
        for item in [*runs, *messages, *calls, *tokens]
        if item.get("ended_at") or item.get("at")
    ]
    return max(values) if values else None


def _minimum_time(*values):
    valid = [value for value in values if isinstance(value, str)]
    return min(valid) if valid else None


def _maximum_time(*values):
    valid = [value for value in values if isinstance(value, str)]
    return max(valid) if valid else None


def _frozen(last_activity_at, now):
    if not isinstance(last_activity_at, str):
        return False
    try:
        then = datetime.fromisoformat(last_activity_at.replace("Z", "+00:00"))
        return now.astimezone(timezone.utc) - then.astimezone(timezone.utc) > timedelta(hours=72)
    except ValueError:
        return False


def _order(item):
    return (
        item.get("source_ordinal", 0),
        item.get("block_ordinal", 0),
        item.get("role_ordinal", 0),
        str(item.get("_physical_id", "")),
    )


def _int(value):
    return value if isinstance(value, int) and not isinstance(value, bool) else 0
