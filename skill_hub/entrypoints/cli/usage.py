"""`hub usage` — the durable per-day usage-history ledger.

Four verbs, all marshalling + output only: the row model, the freeze-horizon
merge, the stats-cache import, the pricing-overrides reprice pass, and the
`history --json` payload all live in `usage_history.py`. This module's job
is argparse wiring and printing.

Carved out alongside `hub_cli/cloud.py` — see `hub_cli/__init__.py` for the
module contract this file implements (`NAME`, `register`, `dispatch`).
"""
# ruff: noqa: E501

from __future__ import annotations

import datetime as _dt
import json
import sys
from pathlib import Path

from skill_hub import hub_core
from skill_hub.hub_core import (
    BOLD,
    CYAN,
    DIM,
    GREEN,
    YELLOW,
    c,
    data_home_lock,
)

NAME = "usage"

p_usage = None


def register(sub) -> None:
    global p_usage

    # usage — the durable ledger a `hub sync`-independent Usage screen reads
    # daily token/cost totals from, folded in from a ccusage scan (`record`)
    # or backfilled from Claude Code's own stats-cache.json (one-time,
    # tokens-only). See docs/USAGE.md.
    p_usage = sub.add_parser(
        "usage", help="Durable usage-history ledger (daily token/cost totals)"
    )
    usage_sub = p_usage.add_subparsers(dest="usage_cmd")

    p_record = usage_sub.add_parser(
        "record", help="Fold a ccusage scan cache into the durable usage ledger"
    )
    p_record.add_argument(
        "--from-cache",
        nargs="?",
        default=None,
        metavar="PATH",
        help="Read the scan from PATH (default: <data_home>/usage/latest-ccusage.json)",
    )
    p_record.add_argument("--json", action="store_true", help="Emit JSON")

    p_history = usage_sub.add_parser(
        "history", help="Show the durable usage ledger as a day-by-day payload"
    )
    p_history.add_argument("--since", help="Only days on/after this date (YYYY-MM-DD)")
    p_history.add_argument("--until", help="Only days on/before this date (YYYY-MM-DD)")
    p_history.add_argument(
        "--path-claude-stats",
        dest="path_claude_stats",
        help="Override the stats-cache.json path used for the claude_stats probe (testing)",
    )
    p_history.add_argument("--json", action="store_true", help="Emit JSON")

    p_import = usage_sub.add_parser(
        "import-claude-stats",
        help="One-time import of Claude Code's own stats-cache.json (tokens only)",
    )
    p_import.add_argument(
        "--path", help="Path to stats-cache.json (default: $HOME/.claude/stats-cache.json)"
    )
    p_import.add_argument(
        "--dry-run", action="store_true", help="Report what would be imported, write nothing"
    )
    p_import.add_argument("--json", action="store_true", help="Emit JSON")

    p_reprice = usage_sub.add_parser(
        "reprice",
        help="Re-price ledger rows against ccusage-pricing.json (token counts never change)",
    )
    p_reprice.add_argument(
        "--dry-run", action="store_true", help="Report what would change, write nothing"
    )
    p_reprice.add_argument("--json", action="store_true", help="Emit JSON")

    # usage-loadout-analytics (wave 1, design D7): five reads over the
    # transcript-scan sessions ledger, the loadout ledger and the static
    # footprint composition. Every `--json` read below exits 0 with its
    # verdict in the payload — never `_usage_fail` — because the Rust
    # bridge that calls `hub` from the app treats any non-zero exit as a
    # blank query (G29).
    from skill_hub.infrastructure.harnesses import harnesses as _harnesses_for_choices

    p_scan_sessions = usage_sub.add_parser(
        "scan-sessions",
        help="Scan supported harness transcripts into the sessions ledger",
    )
    p_scan_sessions.add_argument("--json", action="store_true", help="Emit JSON")
    p_scan_sessions.add_argument("--max-sources", dest="scan_max_sources", type=int)
    p_scan_sessions.add_argument("--order", dest="scan_order", choices=("newest", "path"), default="newest")
    p_scan_sessions.add_argument("--budget-seconds", dest="scan_budget_seconds", type=float, default=60.0)
    p_scan_sessions.add_argument("--scan-id", dest="scan_id")
    p_scan_sessions.add_argument("--retry-incomplete", dest="scan_retry_incomplete", action="store_true")

    p_repair_excerpts = usage_sub.add_parser(
        "repair-excerpts", help="Redact stored session and cursor excerpts without rescanning transcripts"
    )
    p_repair_excerpts.add_argument("--json", dest="json", action="store_true", help="Emit JSON")

    p_inspect_index = usage_sub.add_parser("inspect-index", help="List captured Usage inspections")
    p_inspect_index.add_argument("--json", action="store_true", help="Emit JSON")

    p_inspect = usage_sub.add_parser("inspect", help="Read captured Usage inspection evidence")
    p_inspect.add_argument("session_id", help="Captured session id")
    p_inspect.add_argument("--harness", dest="inspect_harness", required=False)
    p_inspect.add_argument("--view", dest="inspect_view", choices=("overview", "tools", "changes", "body"), required=False)
    p_inspect.add_argument("--run", dest="inspect_run", default=None)
    p_inspect.add_argument("--after", dest="inspect_after", default=None)
    p_inspect.add_argument("--limit", dest="inspect_limit", type=int, default=100)
    p_inspect.add_argument("--body", dest="inspect_body", default=None)
    p_inspect.add_argument("--after-chunk", dest="inspect_after_chunk", type=int, default=None)
    p_inspect.add_argument("--limit-chunks", dest="inspect_limit_chunks", type=int, default=32)
    p_inspect.add_argument("--json", action="store_true", help="Emit JSON")
    p_inspect.add_argument("--older-than", dest="prune_older_than", type=int, default=None)
    p_inspect.add_argument("--max-store-bytes", dest="prune_max_store_bytes", type=int, default=None)
    p_inspect.add_argument("--vacuum", dest="prune_vacuum", action="store_true")
    p_inspect.add_argument("--dry-run", dest="prune_dry_run", action="store_true")

    p_pin = usage_sub.add_parser("pin", help="Manage durable Usage inspection pins")
    pin_sub = p_pin.add_subparsers(dest="pin_action")
    for action in ("add", "remove"):
        p_action = pin_sub.add_parser(action)
        p_action.add_argument("session_id")
        p_action.add_argument("--harness", dest="pin_harness", required=True)
        p_action.add_argument("--run", dest="pin_run", default=None)
        p_action.add_argument("--json", action="store_true", help="Emit JSON")
    p_pin_list = pin_sub.add_parser("list")
    p_pin_list.add_argument("--after", dest="pin_after", default=None)
    p_pin_list.add_argument("--limit", dest="pin_limit", type=int, default=50)
    p_pin_list.add_argument("--json", action="store_true", help="Emit JSON")

    p_usage_project = usage_sub.add_parser(
        "project",
        help="Per-project usage payload: footprint, utilization, outcomes, findings",
    )
    p_usage_project.add_argument("name", help="Project name")
    p_usage_project.add_argument(
        "--window",
        dest="window",
        type=int,
        choices=(7, 30, 90),
        default=30,
        help="Rolling window in days (default: 30)",
    )
    p_usage_project.add_argument("--json", action="store_true", help="Emit JSON")

    p_usage_session = usage_sub.add_parser(
        "session", help="One session's timeline payload"
    )
    p_usage_session.add_argument("session_id", help="Session id (UUID)")
    p_usage_session.add_argument(
        "--harness",
        dest="harness",
        choices=sorted(_harnesses_for_choices.HARNESSES),
        help="Disambiguate a session id that matches rows for more than one harness",
    )
    p_usage_session.add_argument("--json", action="store_true", help="Emit JSON")

    p_usage_timeline = usage_sub.add_parser(
        "timeline", help="Aggregate timestamped session events over time"
    )
    p_usage_timeline.add_argument("--since", help="Only events on/after this UTC date (YYYY-MM-DD)")
    p_usage_timeline.add_argument("--until", help="Only events on/before this UTC date (YYYY-MM-DD)")
    p_usage_timeline.add_argument(
        "--harness", choices=("claude-code", "codex"), help="Limit events to one harness"
    )
    p_usage_timeline.add_argument(
        "--project", help="Limit events to one registry project"
    )
    p_usage_timeline.add_argument("--json", action="store_true", help="Emit JSON")

    p_usage_footprint = usage_sub.add_parser(
        "footprint", help="Static prompt-footprint composition for a project"
    )
    p_usage_footprint.add_argument("name", help="Project name")
    p_usage_footprint.add_argument("--json", action="store_true", help="Emit JSON")

    p_usage_findings = usage_sub.add_parser(
        "findings", help="Idle, footprint, and verification findings"
    )
    p_usage_findings.add_argument(
        "--project", dest="project", help="Limit to one project (default: every project)"
    )
    p_usage_findings.add_argument("--json", action="store_true", help="Emit JSON")

    p_usage_loadouts = usage_sub.add_parser(
        "loadouts", help="Read projected loadout history for one project"
    )
    p_usage_loadouts.add_argument("project", help="Project name")
    p_usage_loadouts.add_argument("--json", action="store_true", help="Emit JSON")


def _usage_fail(json_mode: bool, message: str, code: int = 1) -> None:
    """Every `hub usage …` error path routes through here instead of
    `hub_core.fail()` (W1): `fail()` prints prose to stdout unconditionally,
    which is not parseable JSON and leaves the Rust post-scan hook's
    `ledger_note` reasonless on a `--json` failure. `--json` mode prints
    ONE `{"ok": false, "error": ...}` object to stdout; text mode prints the
    plain message — both exit with `code` (1 = bad input/missing cache,
    2 = an empty scan, see W6)."""
    if json_mode:
        print(json.dumps({"ok": False, "error": message}))
    else:
        print(message)
    sys.exit(code)


def dispatch(args) -> None:
    uc = getattr(args, "usage_cmd", None)
    if uc == "record":
        cmd_usage_record(args)
    elif uc == "history":
        cmd_usage_history(args)
    elif uc == "import-claude-stats":
        cmd_usage_import_claude_stats(args)
    elif uc == "reprice":
        cmd_usage_reprice(args)
    elif uc == "scan-sessions":
        cmd_usage_scan_sessions(args)
    elif uc == "repair-excerpts":
        cmd_usage_repair_excerpts(args)
    elif uc == "inspect-index":
        cmd_usage_inspect_index(args)
    elif uc == "inspect":
        cmd_usage_inspect(args)
    elif uc == "pin":
        cmd_usage_pin(args)
    elif uc == "project":
        cmd_usage_project(args)
    elif uc == "session":
        cmd_usage_session(args)
    elif uc == "timeline":
        cmd_usage_timeline(args)
    elif uc == "footprint":
        cmd_usage_footprint(args)
    elif uc == "findings":
        cmd_usage_findings(args)
    elif uc == "loadouts":
        cmd_usage_loadouts(args)
    else:
        if p_usage is not None:
            p_usage.print_help()


# ─────────────────────────────────────────────────────────────────────────────
# hub usage record
# ─────────────────────────────────────────────────────────────────────────────


def cmd_usage_record(args) -> None:
    """`hub usage record [--from-cache [PATH]] [--json]`.

    Reads a ccusage scan cache (default: `<data_home>/usage/latest-ccusage.json`
    — never stdin, never the live in-memory scan, which still carries real
    project paths; see `docs/USAGE.md`), merges it into the ledger under the
    freeze-horizon rule, and rewrites the ledger. A missing/unreadable cache
    (exit 1) or a scan whose `daily` section produced zero rows (exit 2, W6)
    is a plain failed exit, no traceback — the Rust post-scan hook (wave 2)
    treats any non-zero exit as "the ledger was not updated for this scan",
    never a crash. See `_usage_fail` (W1) for the `--json` error shape.
    """
    from skill_hub.application.usage import usage_history

    path_arg = getattr(args, "from_cache", None)
    cache_path = Path(path_arg).expanduser() if path_arg else usage_history.default_cache_path()
    json_mode = bool(getattr(args, "json", False))

    try:
        with data_home_lock():
            result = usage_history.record_from_cache(cache_path)
    except FileNotFoundError as exc:
        _usage_fail(json_mode, str(exc), code=1)
        return
    except usage_history.EmptyScanError as exc:
        _usage_fail(json_mode, str(exc), code=2)
        return
    except ValueError as exc:
        _usage_fail(json_mode, f"could not read the scan cache: {exc}", code=1)
        return

    payload = {"ok": True, "cache_path": str(cache_path), **result}
    if json_mode:
        print(json.dumps(payload, indent=2))
        return
    print(
        f"  {c('✓', GREEN)} usage history: {result['inserted']} inserted, "
        f"{result['replaced']} replaced, {result['skipped']} skipped, "
        f"{result['repriced']} repriced "
        f"({result['days']} day(s) in this scan)"
    )
    for key, label in (("sessions_undated", "undated"), ("sessions_unmatched", "unmatched")):
        if result[key] > 0:
            print(f"  {c('i', CYAN)} sessions {label}: {result[key]}")


# ─────────────────────────────────────────────────────────────────────────────
# hub usage history
# ─────────────────────────────────────────────────────────────────────────────


def cmd_usage_history(args) -> None:
    """`hub usage history [--since D] [--until D] [--path-claude-stats P] [--json]`.

    Read-only: no lock, no write. Emits the payload `usage_history.history_view`
    builds — see Interfaces §2 in the design plan and `docs/USAGE.md`.
    """
    from skill_hub.application.usage import usage_history

    since = getattr(args, "since", None)
    until = getattr(args, "until", None)
    json_mode = bool(getattr(args, "json", False))
    stats_override = getattr(args, "path_claude_stats", None)
    claude_stats_path = Path(stats_override).expanduser() if stats_override else None

    rows, warnings = usage_history.read_rows(usage_history.history_path())
    today = _dt.datetime.now(_dt.timezone.utc).date()
    payload = usage_history.history_view(
        rows, since, until, today, claude_stats_path=claude_stats_path, warnings=warnings
    )

    if json_mode:
        print(json.dumps(payload, indent=2))
        return

    print(f"\n{c('Usage history', BOLD, CYAN)}  {c(payload['horizon'] + ' horizon', DIM)}\n")
    for warning in warnings:
        print(f"  {c('!', YELLOW)} {warning}")
    if not payload["days"]:
        print(c("  no recorded days yet — run a usage scan, or `hub usage import-claude-stats`", DIM))
        print()
        return

    print(c(f"  {'DATE':<12}{'PROV':<12}{'TOKENS':<14}COST", BOLD))
    for day in payload["days"]:
        cost = f"${day['costUsd']:.2f}" if day["costKnown"] else f"~${day['costUsd']:.2f}"
        print(f"  {day['date']:<12}{day['provenance']:<12}{day['tokens']['total']:<14}{cost}")

    counts = payload["counts"]
    print(
        f"\n  {counts['days']} day(s) · {counts['scanned_days']} scanned · "
        f"{counts['frozen_days']} frozen · {counts['backfilled_days']} backfilled"
    )
    stats = payload["claude_stats"]
    if stats["available"] and stats["importable_days"]:
        print(
            f"  {c('i', CYAN)} {stats['importable_days']} more day(s) available from "
            f"{stats['path']} — try: hub usage import-claude-stats"
        )
    print()


# ─────────────────────────────────────────────────────────────────────────────
# hub usage import-claude-stats
# ─────────────────────────────────────────────────────────────────────────────


def cmd_usage_import_claude_stats(args) -> None:
    """`hub usage import-claude-stats [--path P] [--dry-run] [--json]`.

    One-time, tokens-only import of Claude Code's own `stats-cache.json`.
    `--dry-run` reports what would happen and writes nothing.
    """
    from skill_hub.application.usage import usage_history

    path_arg = getattr(args, "path", None)
    stats_path = Path(path_arg).expanduser() if path_arg else usage_history.default_stats_cache_path()
    dry_run = bool(getattr(args, "dry_run", False))
    json_mode = bool(getattr(args, "json", False))
    # W8: the display form — `~/…` under the real home — never the expanded
    # path, in the payload's `path` field AND in every error message below
    # (a `FileNotFoundError`/`ValueError` raised by usage_history embeds the
    # real expanded path in its own message, so this CLI layer builds its
    # own text rather than relaying `str(exc)` verbatim).
    display = usage_history.display_path(stats_path)

    try:
        with data_home_lock():
            result = usage_history.import_claude_stats(stats_path, dry_run=dry_run)
    except FileNotFoundError:
        _usage_fail(json_mode, f"no Claude stats cache at {display}", code=1)
        return
    except ValueError as exc:
        _usage_fail(json_mode, f"could not read {display}: {exc}", code=1)
        return

    payload = {"path": display, **result}
    if json_mode:
        print(json.dumps(payload, indent=2))
        return

    count = result.get("would_insert", result.get("inserted", 0))
    verb = "would insert" if dry_run else "inserted"
    for warning in result.get("warnings", []):
        print(f"  {c('!', YELLOW)} {warning}")
    print(
        f"  {c('✓', GREEN)} claude-stats-cache import: {verb} {count} row(s) · "
        f"skipped {result['skipped_existing']} already-present · "
        f"{result['skipped_ccusage_days']} day(s) already covered by a scan"
    )


# ─────────────────────────────────────────────────────────────────────────────
# hub usage reprice
# ─────────────────────────────────────────────────────────────────────────────


def cmd_usage_reprice(args) -> None:
    """`hub usage reprice [--dry-run] [--json]`.

    Repairs every ccusage-sourced ledger row still at `$0` (or never
    priced) against the checked-in `ccusage-pricing.json` overrides. Never
    touches a token count, never moves a row across the freeze horizon, and
    never revises a row ccusage itself already priced above `$0` (see
    `price_row`'s docstring for why) — only `cost_usd` can change, and only
    for a row that starts at `$0`/`null`. Useful after editing
    `ccusage-pricing.json` by hand, or to repair rows that froze at `$0`
    before an override existed. Exits 0 whether or not any row changed — 0
    changes is a normal, successful run.
    """
    from skill_hub.application.usage import usage_history

    dry_run = bool(getattr(args, "dry_run", False))
    json_mode = bool(getattr(args, "json", False))

    try:
        with data_home_lock():
            path = usage_history.history_path()
            rows, _warnings = usage_history.read_rows(path)
            prices = usage_history.load_pricing_overrides()
            new_rows, stats = usage_history.reprice_rows(rows, prices)
            if not dry_run and stats["rows_changed"]:
                usage_history.write_rows(path, new_rows)
    except OSError as exc:
        # W1 (same convention as `_usage_fail`'s own docstring): every
        # `hub usage …` error path routes through here, never a bare
        # traceback — a full disk or a read-only data home must still
        # produce a parseable `{"ok": false, "error": ...}` under --json.
        _usage_fail(json_mode, f"could not rewrite the ledger: {exc}", code=1)
        return

    payload = {
        "ok": True,
        "dry_run": dry_run,
        "rows_changed": stats["rows_changed"],
        "models": stats["models"],
        "delta_usd": stats["delta_usd"],
        "overrides": sorted(prices.keys()),
    }
    if json_mode:
        print(json.dumps(payload, indent=2))
        return

    if not stats["rows_changed"]:
        print(f"  {c('✓', GREEN)} usage reprice: no rows changed")
        return
    verb = "would change" if dry_run else "changed"
    delta = stats["delta_usd"]
    sign = "-" if delta < 0 else ""
    print(
        f"  {c('✓', GREEN)} usage reprice: {verb} {stats['rows_changed']} row(s), "
        f"Δ {sign}${abs(delta):.2f}"
    )
    for model, count in sorted(stats["models"].items()):
        print(f"    {model}: {count} row(s)")


# ─────────────────────────────────────────────────────────────────────────────
# usage-loadout-analytics (wave 1, design D7): scan-sessions / project /
# session / footprint / findings. Marshalling + output only, over
# `usage_scan.py`, `usage_loadouts.py` and `usage_footprint.py` (the three
# leaves units A/B/D own). None of the five reads below calls `_usage_fail`:
# every one exits 0 and carries its verdict in the payload.
# ─────────────────────────────────────────────────────────────────────────────


def cmd_usage_repair_excerpts(args) -> None:
    """Repair stored excerpts; output contains counts only, never credential text."""
    from skill_hub.infrastructure.usage import usage_scan

    json_mode = bool(getattr(args, "json", False))
    try:
        result = usage_scan.repair_excerpts()
    except (OSError, ValueError, TypeError) as exc:
        # JSONDecodeError can contain source text. Do not print its details.
        _usage_fail(json_mode, f"excerpt repair failed ({type(exc).__name__})")
        return
    if json_mode:
        print(json.dumps(result, indent=2))
    else:
        print(f"Usage excerpts: {result['fields_redacted']} field(s) redacted, "
              f"{result['files_rewritten']} file(s) rewritten")


def cmd_usage_scan_sessions(args) -> None:
    """`hub usage scan-sessions [--json]`.

    Runs the incremental supported-harness transcript scan
    (`usage_scan.scan_sessions`) and rewrites `state/usage/sessions.jsonl`
    plus the cursor sidecar. Always exits 0: a per-file failure is reported
    in the payload's `errors[]`/`stopped_on`, and every row already written
    stays written — a bad transcript never blanks the screen (design D7).
    """
    from skill_hub.infrastructure.usage import usage_scan

    json_mode = bool(getattr(args, "json", False))
    retry_incomplete = bool(getattr(args, "scan_retry_incomplete", False))
    scan_id = getattr(args, "scan_id", None)
    if retry_incomplete and not scan_id:
        if json_mode:
            print(json.dumps({"ok": False, "error": "--retry-incomplete requires --scan-id"}))
        else:
            print("--retry-incomplete requires --scan-id")
        return
    result = usage_scan.scan_sessions(
        max_sources=getattr(args, "scan_max_sources", None),
        order=getattr(args, "scan_order", "newest"),
        budget_seconds=getattr(args, "scan_budget_seconds", 60.0),
        scan_id=scan_id,
        retry_incomplete=retry_incomplete,
    )

    if json_mode:
        print(json.dumps(result, indent=2))
        return

    mark, tone = ("✓", GREEN) if result["ok"] else ("!", YELLOW)
    print(
        f"  {c(mark, tone)} usage scan: {result['rows_written']} row(s) written, "
        f"{result['rows_frozen']} frozen ({result['files_scanned']} file(s) scanned, "
        f"{result['files_skipped']} skipped)"
    )
    for err in result["errors"]:
        file_name = err.get("file")
        if file_name:
            suffix = f" ({err.get('reason')})" if err.get("reason") else ""
            print(f"  {c('!', YELLOW)} {file_name}: {err.get('kind', 'scan_error')}{suffix}")
        else:
            print(f"  {c('!', YELLOW)} usage scan pass: {err.get('kind', 'scan_error')}"
                  f" ({err.get('reason', '')})")
        if err.get("kind") == "replan_required":
            print("  Start a new pass without --scan-id.")


def _usage_inspection_print(payload: dict, json_mode: bool) -> None:
    if json_mode:
        print(json.dumps(payload, indent=2))
    else:
        print(json.dumps(payload, indent=2))


def cmd_usage_inspect_index(args) -> None:
    from skill_hub.application.usage import usage_inspection
    _usage_inspection_print(usage_inspection.index_payload(), bool(getattr(args, "json", False)))


def cmd_usage_inspect(args) -> None:
    from skill_hub.application.usage import usage_inspection
    if args.session_id == "prune":
        _usage_inspection_print(usage_inspection.prune_bodies(getattr(args, "prune_older_than", None), getattr(args, "prune_max_store_bytes", None), bool(getattr(args, "prune_vacuum", False)), bool(getattr(args, "prune_dry_run", False))), bool(getattr(args, "json", False)))
        return
    if not args.inspect_harness or not args.inspect_view:
        _usage_inspection_print({"ok": False, "reason": "invalid_arguments"}, bool(getattr(args, "json", False)))
        return
    if args.inspect_view == "body":
        payload = usage_inspection.read_body_for_session(args.inspect_harness, args.session_id, args.inspect_body or "", args.inspect_after_chunk, args.inspect_limit_chunks)
    else:
        payload = usage_inspection.inspection_payload(args.inspect_harness, args.session_id, args.inspect_view, args.inspect_run, args.inspect_after, args.inspect_limit)
    _usage_inspection_print(payload, bool(getattr(args, "json", False)))


def cmd_usage_pin(args) -> None:
    from skill_hub.application.usage import usage_inspection
    action = getattr(args, "pin_action", None)
    if action == "list":
        payload = usage_inspection.list_pins(args.pin_after, args.pin_limit)
    elif action in ("add", "remove"):
        payload = usage_inspection.mutate_pin(args.pin_harness, args.session_id, args.pin_run, action)
    else:
        payload = {"ok": False, "reason": "unavailable"}
    _usage_inspection_print(payload, bool(getattr(args, "json", False)))


def cmd_usage_project(args) -> None:
    """`hub usage project <name> [--window 7|30|90] [--json]` (design D7)."""
    import hub
    from skill_hub.application.usage import usage_footprint

    registry = hub_core.load_registry()
    name = args.name
    window = args.window

    if name not in (registry.get("projects") or {}):
        payload = {"ok": False, "reason": "not_found", "project": name}
    else:
        payload = usage_footprint.project_payload(
            name, registry, resolve_skills=hub.resolve_project_skills, window_days=window
        )

    if bool(getattr(args, "json", False)):
        print(json.dumps(payload, indent=2))
        return

    if not payload["ok"]:
        print(f"  {c('!', YELLOW)} unknown project '{name}'")
        return
    outcomes = payload["outcomes"]
    print(f"\n{c(f'Usage: {name}', BOLD, CYAN)}  {c(f'{window}-day window', DIM)}\n")
    print(f"  sessions        : {outcomes.get('sessions', 0)}")
    print(f"  cache hit ratio : {outcomes.get('cache_hit_ratio')}")
    print(f"  findings        : {len(payload['findings'])}")
    for h_id in payload["harnesses"]:
        block = payload["footprint"].get(h_id, {})
        print(
            f"  {h_id:<14}~{block.get('approx_tokens')} approx tokens "
            f"({block.get('bytes_total')} bytes)"
        )
    print()


def cmd_usage_session(args) -> None:
    """`hub usage session <id> [--harness <id>] [--json]` (design D7)."""
    from skill_hub.infrastructure.usage import usage_scan

    registry = hub_core.load_registry()
    session_id = args.session_id
    harness = getattr(args, "harness", None)
    payload = usage_scan.session_payload(session_id, registry, harness=harness)

    if bool(getattr(args, "json", False)):
        print(json.dumps(payload, indent=2))
        return

    if not payload["ok"]:
        print(f"  {c('!', YELLOW)} {payload['reason']}")
        return
    summary = payload["summary"]
    print(f"\n{c(f'Session: {session_id}', BOLD, CYAN)}  {c(payload['harness'], DIM)}\n")
    print(f"  project   : {payload['project']}")
    print(f"  tokens    : {summary['tokens_total']}")
    print(f"  steering  : {summary['steering_count']}")
    print(f"  events    : {len(payload['events'] or [])}")
    print()


def cmd_usage_timeline(args) -> None:
    """`hub usage timeline --json` — aggregate the sessions ledger once."""
    from skill_hub.domain.usage import usage_timeline
    from skill_hub.infrastructure.usage import usage_scan

    try:
        usage_timeline.validate_bounds(
            getattr(args, "since", None), getattr(args, "until", None)
        )
        payload = usage_timeline.timeline_payload(
            usage_scan.read_session_rows()[0],
            since=getattr(args, "since", None),
            until=getattr(args, "until", None),
            harness=getattr(args, "harness", None),
            project=getattr(args, "project", None),
        )
    except ValueError as exc:
        _usage_fail(bool(getattr(args, "json", False)), str(exc))
        return
    if bool(getattr(args, "json", False)):
        print(json.dumps(payload, indent=2))
        return
    print(f"  timeline: {len(payload['days'])} day(s), {len(payload['harnesses'])} harness(es)")


def cmd_usage_footprint(args) -> None:
    """`hub usage footprint <name> [--json]` — `compose`'s payload plus `ok`,
    `window: null`, and `last_scan_at` (design D7)."""
    import hub
    from skill_hub.application.usage import usage_footprint
    from skill_hub.infrastructure.usage import usage_scan

    registry = hub_core.load_registry()
    name = args.name

    if name not in (registry.get("projects") or {}):
        payload = {"ok": False, "reason": "not_found", "project": name}
    else:
        composed = usage_footprint.compose(
            name, registry, resolve_skills=hub.resolve_project_skills
        )
        payload = {
            "ok": True,
            **composed,
            "window": None,
            "last_scan_at": usage_scan.last_scan_at(),
        }

    if bool(getattr(args, "json", False)):
        print(json.dumps(payload, indent=2))
        return

    if not payload["ok"]:
        print(f"  {c('!', YELLOW)} unknown project '{name}'")
        return
    print(f"\n{c(f'Footprint: {name}', BOLD, CYAN)}\n")
    for h_id, block in payload["harnesses"].items():
        print(f"  {h_id:<14}~{block['approx_tokens']} approx tokens ({block['bytes_total']} bytes)")
    print()


def cmd_usage_findings(args) -> None:
    """`hub usage findings [--project <name>] [--json]` (design D7)."""
    import hub
    from skill_hub.application.usage import usage_footprint

    registry = hub_core.load_registry()
    project = getattr(args, "project", None)
    payload = usage_footprint.findings_payload(
        registry, resolve_skills=hub.resolve_project_skills, project=project
    )

    if bool(getattr(args, "json", False)):
        print(json.dumps(payload, indent=2))
        return

    findings = payload["findings"]
    if not findings:
        print(c("  no findings", DIM))
        return
    print(f"\n{c('Findings', BOLD, CYAN)}  {c(str(payload['findings_window']) + '-day window', DIM)}\n")
    for f in findings:
        print(f"  [{f['kind']}] {f['project']}: {f['observation']}")
    print()


def cmd_usage_loadouts(args) -> None:
    """`hub usage loadouts <project> --json` (design D16.2)."""
    from skill_hub.infrastructure.usage import usage_loadouts

    project = args.project
    rows, _warnings = usage_loadouts.read_loadout_rows()
    projected = []
    seen: dict[str, str] = {}
    for row in sorted(rows, key=lambda item: item.get("at", "")):
        if row.get("project") != project:
            continue
        harness = str(row.get("harness", ""))
        row_hash = str(row.get("hash", ""))
        kind = "initial" if harness not in seen else "changed"
        if harness in seen and seen[harness] == row_hash:
            continue
        seen[harness] = row_hash
        projected.append(
            {
                "at": row.get("at"),
                "harness": harness,
                "hash": row_hash,
                "skill_count": len(row.get("skills") or []),
                "mcp_count": len(row.get("mcp") or []),
                "kind": kind,
            }
        )
    payload = {"ok": True, "project": project, "rows": projected}
    if bool(getattr(args, "json", False)):
        print(json.dumps(payload, indent=2))
        return
    print(f"{project}: {len(projected)} loadout change(s)")
