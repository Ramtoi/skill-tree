#!/usr/bin/env python3
"""usage_history — the durable per-day usage ledger.

Owns `<data_home>/state/usage/history.jsonl`: one flat JSON line per
`(date, agent, model)`, folded in from a ccusage scan under a freeze-horizon
merge rule, plus a one-time tokens-only import of Claude Code's own
`stats-cache.json`. No row EVER carries a path, a session id, or a title —
this module reads `parsed["daily"]` for rows and structured `session[]` for
counts, never raw text, and reads `dailyModelTokens[]` from the stats cache.

Three provenance classes, computed here (not by any caller) because only this
module owns the freeze horizon:

  * **scanned**  — the day is inside the mutable window (< 14 days old at the
    scan that touched it) and holds at least one `ccusage` row.
  * **frozen**   — the day is outside the mutable window and holds a
    `ccusage` row recorded while it was still mutable. Write-once from then
    on: a later re-scan cannot change it.
  * **backfilled** — the day holds no `ccusage` row at all, only rows from
    the one-time `stats-cache.json` import (tokens only, no cost, no split).

See `docs/USAGE.md` for the full picture (why the horizon is 14 days, the
import guard, and which parts of the Usage screen read this ledger vs. the
latest scan).
"""

from __future__ import annotations

import datetime as _dt
import json
import math
import os
import re
import sys
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Optional

from skill_hub import hub_core

#: Data-home-relative path of the ledger — a `backup.py:ManifestRow.entry`.
HISTORY_REL = "state/usage/history.jsonl"

#: `code_home()`-relative name of the checked-in ccusage price-override
#: config. The Rust scan passes the same file to ccusage via `--config`;
#: this module reads it a second time to reprice ledger rows a scan already
#: wrote with no (or a stale) override in effect. See `pricing_overrides_path`
#: and docs/USAGE.md "Pricing overrides".
PRICING_OVERRIDES_FILE = "ccusage-pricing.json"

#: Days back from a scan's own `scanned_at` (or, for `history_view`, the
#: caller's own `today`) before a day stops being mutable. See the module
#: docstring's provenance classes.
FREEZE_HORIZON_DAYS = 14

_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class EmptyScanError(ValueError):
    """The scan cache parsed cleanly but its `daily` section produced zero
    ledger rows. Indistinguishable, from here, between a genuinely quiet
    account and a ccusage output-shape change this module can no longer
    read — so `record_from_cache` fails closed (writes nothing) instead of
    silently reporting success with no signal. A `ValueError` subclass so an
    existing `except ValueError` still catches it; callers that want the
    distinct exit code (`hub usage record` uses 2, not 1) must catch this
    FIRST."""

#: Display names for ccusage agent ids. Mirrors
#: `app/src/features/usage/normalizeUsage.ts`'s `KNOWN_HARNESSES` — kept as a
#: small, independent copy rather than a shared source of truth, since one is
#: Python and the other TypeScript and neither is generated from the other.
_AGENT_DISPLAY_NAMES = {
    "claude": "Claude Code",
    "codex": "Codex",
    "opencode": "OpenCode",
    "amp": "Amp",
    "droid": "Droid",
    "codebuff": "Codebuff",
    "hermes": "Hermes Agent",
    "pi": "pi-agent",
    "goose": "Goose",
    "openclaw": "OpenClaw",
    "kilo": "Kilo",
    "kimi": "Kimi",
    "qwen": "Qwen",
    "copilot": "GitHub Copilot CLI",
    "gemini": "Gemini CLI",
}


def history_path() -> Path:
    import hub

    return hub.data_home() / HISTORY_REL


def default_cache_path() -> Path:
    """`<data_home>/usage/latest-ccusage.json` — the `hub usage record
    --from-cache` default. Matches Rust's `CACHE_REL_PATH`."""
    import hub

    return hub.data_home() / "usage" / "latest-ccusage.json"


def default_stats_cache_path() -> Path:
    """`$HOME/.claude/stats-cache.json`, resolved fresh on every call — never
    cached at import time — so a test's faked `$HOME` is always honoured."""
    return Path.home() / ".claude" / "stats-cache.json"


def pricing_overrides_path() -> Path:
    """`<code_home>/ccusage-pricing.json` — the same checked-in config the
    Rust scan passes to ccusage via `--config` (see `usage.rs::scan_args`).
    `hub_core.code_home()`, not `hub.data_home()`: this file ships with the
    app/repo, it is never user-registry data."""
    return hub_core.code_home() / PRICING_OVERRIDES_FILE


def display_path(path: Path) -> str:
    """`~/…` when `path` sits under the real `$HOME`, the path verbatim
    otherwise. The one redaction the `claude_stats` probe and
    `hub usage import-claude-stats --json` both use, so neither surface ever
    hands the caller an expanded real home directory. `Path.home()` is read
    fresh (never cached), so a test's faked `$HOME` is honoured."""
    path = Path(path)
    home = Path.home()
    try:
        rel = path.relative_to(home)
    except ValueError:
        return str(path)
    return "~" if str(rel) == "." else f"~/{rel}"


# ─────────────────────────────────────────────────────────────────────────────
# Row model
# ─────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class UsageRow:
    """One `(date, agent, model)` line of the durable usage ledger.

    `model=None` is the remainder row for a `(date, agent)` pair whose
    ccusage agent-level total sits above the sum of its per-model breakdown,
    or the whole row for a pair ccusage reports with no breakdown at all.
    `cost_usd=None` marks a backfilled (stats-cache import) row — never a
    real `0.0`, which ccusage itself reports for models its offline pricing
    snapshot lacks. `input`/`output`/`cache_creation`/`cache_read` are `None`
    on a backfilled row (tokens-only import); `total` is always an int.
    """

    date: str
    agent: str
    model: Optional[str]
    input: Optional[int]
    output: Optional[int]
    cache_creation: Optional[int]
    cache_read: Optional[int]
    total: int
    cost_usd: Optional[float]
    source: str
    scanner: str
    captured_at: str
    sessions: Optional[int] = None

    def sort_key(self) -> tuple:
        return (self.date, self.agent, self.model or "")

    def to_dict(self) -> dict:
        return {
            "date": self.date,
            "agent": self.agent,
            "model": self.model,
            "input": self.input,
            "output": self.output,
            "cache_creation": self.cache_creation,
            "cache_read": self.cache_read,
            "total": self.total,
            "cost_usd": self.cost_usd,
            "source": self.source,
            "scanner": self.scanner,
            "captured_at": self.captured_at,
            "sessions": self.sessions,
        }

    @staticmethod
    def from_dict(data: dict) -> "UsageRow":
        """Build one row from a decoded JSON line, or raise `ValueError` —
        `read_rows` drops and warns on any of these, so `history_view` can
        never raise on ledger content (W2): `date` must be a real calendar
        `YYYY-MM-DD` (matching the regex is not enough — `2026-13-45` does),
        `agent` a non-empty string, and every int field (`input`/`output`/
        `cache_creation`/`cache_read`/`total`/`sessions`) non-negative when
        present."""
        if not isinstance(data, dict):
            raise ValueError("row is not a JSON object")
        date = str(data["date"])
        if not _DATE_RE.match(date):
            raise ValueError(f"bad date {date!r}")
        try:
            _dt.date.fromisoformat(date)
        except ValueError as exc:
            raise ValueError(f"bad date {date!r}: {exc}") from exc

        agent = str(data["agent"])
        if not agent:
            raise ValueError("agent must be a non-empty string")

        model_raw = data.get("model")
        input_ = _opt_int(data.get("input"))
        output = _opt_int(data.get("output"))
        cache_creation = _opt_int(data.get("cache_creation"))
        cache_read = _opt_int(data.get("cache_read"))
        total = int(data["total"])
        sessions = _opt_int(data.get("sessions"))
        for name, value in (
            ("input", input_),
            ("output", output),
            ("cache_creation", cache_creation),
            ("cache_read", cache_read),
            ("total", total),
            ("sessions", sessions),
        ):
            if value is not None and value < 0:
                raise ValueError(f"negative {name} {value!r}")

        return UsageRow(
            date=date,
            agent=agent,
            model=str(model_raw) if model_raw is not None else None,
            input=input_,
            output=output,
            cache_creation=cache_creation,
            cache_read=cache_read,
            total=total,
            cost_usd=_opt_float(data.get("cost_usd")),
            source=str(data["source"]),
            scanner=str(data.get("scanner", "")),
            captured_at=str(data["captured_at"]),
            sessions=sessions,
        )


def _opt_int(value: object) -> Optional[int]:
    return int(value) if value is not None else None  # type: ignore[call-overload]


def _opt_float(value: object) -> Optional[float]:
    return float(value) if value is not None else None  # type: ignore[arg-type]


def _num(value: object, default: float = 0) -> float:
    """A ccusage numeric field, or `default` for anything that is not a
    genuine, finite number — including a `bool` (a `bool` is a Python `int`
    subclass, so `isinstance(True, int)` is true; without this guard a
    literal `true`/`false` in a scan silently becomes `1`/`0`) and a
    non-finite float (`Infinity`/`NaN`, which `json.loads` accepts and which
    would otherwise raise `OverflowError` at the `int(...)` call site)."""
    if isinstance(value, bool):
        return default
    if isinstance(value, (int, float)):
        if isinstance(value, float) and not math.isfinite(value):
            return default
        return value
    return default


# ─────────────────────────────────────────────────────────────────────────────
# Read / write — the only I/O path is a whole-file sorted rewrite
# ─────────────────────────────────────────────────────────────────────────────


def read_rows(path: Path) -> tuple[list[UsageRow], list[str]]:
    """Read the ledger. A malformed line is dropped — never raises — and
    named in the returned warnings list; well-formed lines around it survive.
    A missing file reads as empty."""
    path = Path(path)
    if not path.exists():
        return [], []
    rows: list[UsageRow] = []
    warnings: list[str] = []
    for lineno, raw_line in enumerate(path.read_text().splitlines(), start=1):
        line = raw_line.strip()
        if not line:
            continue
        try:
            data = json.loads(line)
            rows.append(UsageRow.from_dict(data))
        except (json.JSONDecodeError, ValueError, TypeError, KeyError) as exc:
            warnings.append(f"{path}:{lineno}: dropped malformed usage row ({exc})")
    return rows, warnings


def _row_has_negative_field(row: UsageRow) -> bool:
    for value in (row.input, row.output, row.cache_creation, row.cache_read, row.total, row.sessions):
        if value is not None and value < 0:
            return True
    return row.cost_usd is not None and row.cost_usd < 0


def write_rows(path: Path, rows: list[UsageRow]) -> None:
    """Sort + atomically rewrite the whole ledger: sibling temp + `os.replace`,
    permissions locked to 0o600 (it holds usage data no other local account or
    backup sweep should read), parent directory created as needed. Rewriting
    unchanged rows is byte-identical (sorted, `sort_keys=True` JSON).

    Last line of defence (C1): a row with a negative token or cost field is
    dropped and a warning printed to stderr rather than written — every
    caller that builds rows is expected to have already prevented this, but
    a durable ledger must never persist a negative count regardless."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    safe_rows = []
    for row in rows:
        if _row_has_negative_field(row):
            print(
                f"usage_history: dropped a row with a negative field before writing "
                f"(never persisted): {row.to_dict()}",
                file=sys.stderr,
            )
            continue
        safe_rows.append(row)
    ordered = sorted(safe_rows, key=lambda r: r.sort_key())
    text = "".join(json.dumps(row.to_dict(), sort_keys=True) + "\n" for row in ordered)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text)
    try:
        os.chmod(tmp, 0o600)
    except OSError:
        pass
    os.replace(tmp, path)


# ─────────────────────────────────────────────────────────────────────────────
# ccusage scan -> rows
# ─────────────────────────────────────────────────────────────────────────────


def extract_session_counts(parsed: dict) -> dict:
    """Extract privacy-safe `(UTC date, agent)` session counts from a scan."""
    session_raw = parsed.get("session") if isinstance(parsed, dict) else None
    available = isinstance(session_raw, list)
    by_pair: dict[tuple[str, str], int] = {}
    undated = unmatched = 0
    daily_pairs: set[tuple[str, str]] = set()
    daily = parsed.get("daily") if isinstance(parsed, dict) else None
    if isinstance(daily, list):
        for day in daily:
            if not isinstance(day, dict) or not isinstance(day.get("period"), str):
                continue
            period = day["period"]
            if not _DATE_RE.match(period):
                continue
            agents = day.get("agents")
            if isinstance(agents, list):
                daily_pairs.update(
                    (period, agent["agent"])
                    for agent in agents
                    if isinstance(agent, dict)
                    and isinstance(agent.get("agent"), str)
                    and bool(agent["agent"])
                )
    if available and isinstance(session_raw, list):
        for session in session_raw:
            if not isinstance(session, dict):
                continue
            agent = session.get("agent")
            if not isinstance(agent, str) or not agent:
                continue
            metadata = session.get("metadata")
            timestamp_candidates = [session.get("lastActivity")]
            if isinstance(metadata, dict):
                timestamp_candidates.extend((metadata.get("lastActivity"), metadata.get("updatedAt")))
            date = next(
                (candidate_date for candidate in timestamp_candidates
                 if (candidate_date := _session_utc_date(candidate)) is not None),
                None,
            )
            if date is None:
                undated += 1
                continue
            pair = (date, agent)
            if pair not in daily_pairs:
                unmatched += 1
                continue
            by_pair[pair] = by_pair.get(pair, 0) + 1
    return {"available": available, "by_pair": by_pair, "undated": undated, "unmatched": unmatched}


def _session_utc_date(value: object) -> Optional[str]:
    if not isinstance(value, str) or not value:
        return None
    try:
        normalized = value[:-1] + "+00:00" if value.endswith("Z") else value
        timestamp = _dt.datetime.fromisoformat(normalized)
    except ValueError:
        return None
    if timestamp.tzinfo is None:
        return None
    return timestamp.astimezone(_dt.timezone.utc).date().isoformat()


def rows_from_scan(
    parsed: dict,
    scanned_at: str,
    scanner: str,
    sessions_by_pair: Optional[dict[tuple[str, str], int]] = None,
) -> list[UsageRow]:
    """Walk `parsed['daily'][].agents[].modelBreakdowns[]` into ledger rows,
    plus one `model: None` remainder row per `(date, agent)` when ccusage's
    own `totalTokens` sits ABOVE the sum of its breakdown (never below or
    equal — see `_rows_for_agent_day` and docs/USAGE.md). A `period` that is
    not a plain `YYYY-MM-DD` string is dropped, not stored. Never reads
    `session`/`raw` — those can carry a session id, a title, or a real
    project path. When `sessions_by_pair` is supplied, its known count is
    repeated on every row for the `(date, agent)` pair; otherwise sessions
    remain unknown (`None`)."""
    daily = parsed.get("daily") if isinstance(parsed, dict) else None
    if not isinstance(daily, list):
        return []
    rows: list[UsageRow] = []
    for day in daily:
        if not isinstance(day, dict):
            continue
        period = day.get("period")
        if not isinstance(period, str) or not _DATE_RE.match(period):
            continue
        agents = day.get("agents")
        if not isinstance(agents, list):
            continue
        for agent_row in agents:
            if not isinstance(agent_row, dict):
                continue
            agent_id = agent_row.get("agent")
            if not isinstance(agent_id, str) or not agent_id:
                continue
            pair_sessions = (
                sessions_by_pair.get((period, agent_id), 0)
                if sessions_by_pair is not None
                else None
            )
            rows.extend(
                _rows_for_agent_day(period, agent_id, agent_row, scanned_at, scanner, pair_sessions)
            )
    return rows


def _rows_for_agent_day(
    date: str,
    agent: str,
    agent_row: dict,
    captured_at: str,
    scanner: str,
    sessions: Optional[int] = None,
) -> list[UsageRow]:
    breakdowns_raw = agent_row.get("modelBreakdowns")
    breakdowns = breakdowns_raw if isinstance(breakdowns_raw, list) else []

    sum_input = sum_output = sum_cache_creation = sum_cache_read = 0
    sum_cost = 0.0
    rows: list[UsageRow] = []
    for mb in breakdowns:
        if not isinstance(mb, dict):
            continue
        model_name = mb.get("modelName")
        if not isinstance(model_name, str) or not model_name:
            continue
        m_input = int(_num(mb.get("inputTokens")))
        m_output = int(_num(mb.get("outputTokens")))
        m_cache_creation = int(_num(mb.get("cacheCreationTokens")))
        m_cache_read = int(_num(mb.get("cacheReadTokens")))
        m_cost = float(_num(mb.get("cost"), 0.0))
        m_total = m_input + m_output + m_cache_creation + m_cache_read
        sum_input += m_input
        sum_output += m_output
        sum_cache_creation += m_cache_creation
        sum_cache_read += m_cache_read
        sum_cost += m_cost
        rows.append(
            UsageRow(
                date=date,
                agent=agent,
                model=model_name,
                input=m_input,
                output=m_output,
                cache_creation=m_cache_creation,
                cache_read=m_cache_read,
                total=m_total,
                cost_usd=round(m_cost, 6),
                source="ccusage",
                scanner=scanner,
                captured_at=captured_at,
                sessions=sessions,
            )
        )

    agent_input = int(_num(agent_row.get("inputTokens")))
    agent_output = int(_num(agent_row.get("outputTokens")))
    agent_cache_creation = int(_num(agent_row.get("cacheCreationTokens")))
    agent_cache_read = int(_num(agent_row.get("cacheReadTokens")))
    agent_cost = float(_num(agent_row.get("totalCost"), 0.0))

    # ccusage's own `totalTokens` when present — never the sum of the four
    # per-field counts, which a future agent-row shape could omit while
    # still reporting a total (W3: this is also what the app's scan-path
    # fallback reads, so the two sources cannot disagree). Falls back to the
    # per-field sum only when `totalTokens` itself is absent/non-numeric.
    agent_total_raw = agent_row.get("totalTokens")
    if isinstance(agent_total_raw, (int, float)) and not isinstance(agent_total_raw, bool):
        agent_total = int(_num(agent_total_raw))
    else:
        agent_total = agent_input + agent_output + agent_cache_creation + agent_cache_read

    if not breakdowns:
        # The ONLY row for the pair — ccusage reported no breakdown to
        # reconcile against, so the agent-level splits/total/cost carry over
        # verbatim (never collapsed to zero).
        rows.append(
            UsageRow(
                date=date,
                agent=agent,
                model=None,
                input=agent_input,
                output=agent_output,
                cache_creation=agent_cache_creation,
                cache_read=agent_cache_read,
                total=agent_total,
                cost_usd=round(agent_cost, 6),
                source="ccusage",
                scanner=scanner,
                captured_at=captured_at,
                sessions=sessions,
            )
        )
        return rows

    # A breakdown exists (C1). Emit a `model: null` remainder row ONLY when
    # ccusage's own total sits ABOVE the breakdown sum — never when it is
    # equal (no row needed) or below (the breakdown sum IS the day × agent
    # total; see docs/USAGE.md). Each split field is independently clamped
    # at 0 (a per-field ccusage figure can sit below its own breakdown sum
    # even while the grand total sits above it); the cost remainder is its
    # own, separate condition — 0.0, never negative, when it does not.
    breakdown_sum = sum_input + sum_output + sum_cache_creation + sum_cache_read
    remainder_total = agent_total - breakdown_sum
    if remainder_total > 0:
        remainder_cost = (agent_cost - sum_cost) if agent_cost > sum_cost else 0.0
        rows.append(
            UsageRow(
                date=date,
                agent=agent,
                model=None,
                input=max(agent_input - sum_input, 0),
                output=max(agent_output - sum_output, 0),
                cache_creation=max(agent_cache_creation - sum_cache_creation, 0),
                cache_read=max(agent_cache_read - sum_cache_read, 0),
                total=remainder_total,
                cost_usd=round(remainder_cost, 6),
                source="ccusage",
                scanner=scanner,
                captured_at=captured_at,
                sessions=sessions,
            )
        )
    return rows


# ─────────────────────────────────────────────────────────────────────────────
# Merge — pure, no I/O
# ─────────────────────────────────────────────────────────────────────────────


def merge_rows(
    existing: list[UsageRow], incoming: list[UsageRow], horizon_date: _dt.date
) -> tuple[list[UsageRow], dict]:
    """Freeze-horizon merge, mirrored at agent grain (W5).

    For every agent PRESENT ANYWHERE in `incoming`: every existing row for
    that agent on a MUTABLE day (`date >= horizon_date`) is deleted — every
    such date, whether or not `incoming` itself covers that date — then
    `incoming`'s rows for that agent are inserted. An agent absent from
    `incoming` keeps every one of its rows untouched. A day the ledger no
    longer hears about for a scanned agent therefore disappears rather than
    surviving forever as stale data (the bug this replaced).

    `date < horizon_date` is unaffected by the above and stays write-once at
    `(date, agent)` grain: if the ledger already holds any row for the pair,
    the incoming rows for it are skipped whole (never interleaved at the
    model grain) — a pair the ledger does not yet hold is inserted, and
    freezes from then on. Frozen days never move, regardless of whether
    their agent appears in `incoming`.

    Pure: no I/O, no clock reads. Returns `(merged_rows, stats)` where
    `stats` is `{inserted, replaced, skipped, days}`, counted at
    `(date, agent)` pair grain over `incoming` — `days` is the count of
    distinct dates present in `incoming`.
    """
    incoming_agents = {row.agent for row in incoming}
    existing_pairs = {(row.date, row.agent) for row in existing}

    # Every existing row survives EXCEPT a mutable-day row for an agent the
    # scan touched anywhere — that set is mirrored away wholesale and
    # rebuilt below from `incoming` alone.
    kept: list[UsageRow] = []
    for row in existing:
        row_date = _dt.date.fromisoformat(row.date)
        if row.agent in incoming_agents and row_date >= horizon_date:
            continue
        kept.append(row)

    incoming_by_pair: dict[tuple[str, str], list[UsageRow]] = {}
    for row in incoming:
        incoming_by_pair.setdefault((row.date, row.agent), []).append(row)

    result_rows = list(kept)
    inserted = replaced = skipped = 0

    for pair, inc_rows in incoming_by_pair.items():
        date_str, _agent = pair
        pair_date = _dt.date.fromisoformat(date_str)
        had_existing = pair in existing_pairs
        if pair_date >= horizon_date:
            # The pair's own existing rows (if any) were already dropped
            # above as part of the agent-wide mirror.
            result_rows.extend(inc_rows)
            if had_existing:
                replaced += 1
            else:
                inserted += 1
        else:
            if had_existing:
                skipped += 1
            else:
                result_rows.extend(inc_rows)
                inserted += 1

    stats = {
        "inserted": inserted,
        "replaced": replaced,
        "skipped": skipped,
        "days": len({date for date, _agent in incoming_by_pair}),
    }
    return result_rows, stats


# ─────────────────────────────────────────────────────────────────────────────
# Pricing overrides — repair ccusage's $0 rows for a model its offline
# pricing snapshot does not cover (see docs/USAGE.md "Pricing overrides").
# ─────────────────────────────────────────────────────────────────────────────


def load_pricing_overrides(path: Optional[Path] = None) -> dict[str, dict[str, float]]:
    """Read `defaults.pricingOverrides` from the checked-in
    `ccusage-pricing.json` (or `path`, for testing). Fails open: a missing
    file returns `{}` with no warning (this is the normal state before the
    file is installed); a file that exists but cannot be read or does not
    hold the expected shape returns `{}` and prints ONE warning line to
    stderr. Never raises — a broken pricing file must not break a scan or a
    reprice pass, only leave prices unrepaired."""
    p = Path(path) if path is not None else pricing_overrides_path()
    if not p.exists():
        return {}
    try:
        raw = json.loads(p.read_text())
    except (OSError, ValueError) as exc:
        print(f"usage_history: could not read pricing overrides at {p}: {exc}", file=sys.stderr)
        return {}
    defaults = raw.get("defaults") if isinstance(raw, dict) else None
    overrides = defaults.get("pricingOverrides") if isinstance(defaults, dict) else None
    if not isinstance(overrides, dict):
        print(
            f"usage_history: pricing overrides at {p} has no defaults.pricingOverrides object",
            file=sys.stderr,
        )
        return {}
    return {
        model: spec
        for model, spec in overrides.items()
        if isinstance(model, str) and isinstance(spec, dict)
    }


def price_row(row: UsageRow, prices: dict) -> Optional[float]:
    """Compute a REPAIR cost for one row, or `None` when the row is not
    eligible for repair at all — never a revision of a cost ccusage itself
    already computed. `prices` is the `load_pricing_overrides()` shape:
    `{model: {inputCostPerToken, outputCostPerToken,
    cacheCreationInputTokenCost, cacheReadInputTokenCost}}`.

    `None` in every one of these cases:

    * the row did not come from a ccusage scan (a backfilled row has no
      cost to compute — it never even reports the token split by field);
    * the row's `cost_usd` is already above `0.0` — ccusage prices the
      one-hour cache-write tier and this override table only ever knows
      the five-minute rate, so ccusage's own figure is always at least as
      accurate and MUST NEVER be overwritten;
    * the row has no tokens (`total <= 0`) — nothing to price;
    * the row's four token-split fields are all `None` (a hand-edited or
      restored ledger line can carry this shape even with a real `total`)
      — there is nothing to multiply a rate against;
    * the row's model has no entry in `prices` — including a `model: null`
      remainder row, which by definition carries no model name to look up
      and so can never be repaired, no matter its cost.

    An absent rate field in `prices` is `0`. Pure."""
    if row.source != "ccusage":
        return None
    if row.model is None:
        return None
    current_cost = row.cost_usd if row.cost_usd is not None else 0.0
    if current_cost > 0.0:
        return None
    if row.total <= 0:
        return None
    if row.input is None and row.output is None and row.cache_creation is None and row.cache_read is None:
        return None
    spec = prices.get(row.model)
    if not isinstance(spec, dict):
        return None
    input_rate = _num(spec.get("inputCostPerToken"))
    output_rate = _num(spec.get("outputCostPerToken"))
    cache_write_rate = _num(spec.get("cacheCreationInputTokenCost"))
    cache_read_rate = _num(spec.get("cacheReadInputTokenCost"))
    cost = (
        (row.input or 0) * input_rate
        + (row.output or 0) * output_rate
        + (row.cache_creation or 0) * cache_write_rate
        + (row.cache_read or 0) * cache_read_rate
    )
    return round(cost, 6)


def reprice_rows(rows: list[UsageRow], prices: dict) -> tuple[list[UsageRow], dict]:
    """Return `(new_rows, stats)`: `new_rows` mirrors `rows` one-to-one.
    `price_row` gates ELIGIBILITY (see its docstring) — a row it returns
    `None` for is never touched, in particular a row ccusage already priced
    above `0.0`, which keeps ccusage's own number always. For an eligible
    row, `cost_usd` is replaced only when the computed repair differs from
    the row's current cost by 1e-9 or more — a row already at the right
    price is left as the identical object and not counted, which is what
    makes a second pass over this function's own output change nothing
    (idempotent). `stats` is `{"rows_changed": n, "models": {model:
    n_changed}, "delta_usd": round(sum(new - old), 6)}`. Pure — no I/O, no
    clock reads."""
    new_rows: list[UsageRow] = []
    rows_changed = 0
    models: dict[str, int] = {}
    delta = 0.0
    for row in rows:
        new_cost = price_row(row, prices)
        if new_cost is None:
            new_rows.append(row)
            continue
        old_cost = row.cost_usd if row.cost_usd is not None else 0.0
        if abs(new_cost - old_cost) < 1e-9:
            new_rows.append(row)
            continue
        rows_changed += 1
        model_key = row.model or ""
        models[model_key] = models.get(model_key, 0) + 1
        delta += new_cost - old_cost
        new_rows.append(replace(row, cost_usd=new_cost))
    stats = {
        "rows_changed": rows_changed,
        "models": models,
        "delta_usd": round(delta, 6),
    }
    return new_rows, stats


# ─────────────────────────────────────────────────────────────────────────────
# Orchestration — `hub usage record`
# ─────────────────────────────────────────────────────────────────────────────


def record_from_cache(cache_path: Path) -> dict:
    """Read a ccusage scan cache, merge it into the ledger under the
    freeze-horizon rule, and rewrite the ledger.

    Raises `FileNotFoundError` / `ValueError` on a missing or malformed
    cache — the CLI turns those into a plain failed exit (non-zero, no
    traceback), which is the shape Wave 2's Rust hook already treats as
    "the ledger was not updated for this scan", never a crash. Raises the
    narrower `EmptyScanError` (W6) — and writes nothing at all, not even an
    unchanged rewrite — when the scan's `daily` section produces zero rows:
    that is indistinguishable, from here, from a ccusage output-shape
    change, so it must not look like a quiet success.
    """
    cache_path = Path(cache_path)
    if not cache_path.exists():
        raise FileNotFoundError(f"no usage scan cache at {cache_path}")
    try:
        raw = json.loads(cache_path.read_text())
    except (OSError, ValueError) as exc:
        raise ValueError(f"usage scan cache unreadable: {exc}") from exc
    if not isinstance(raw, dict):
        raise ValueError("usage scan cache is not a JSON object")

    scanned_at_epoch = raw.get("scanned_at")
    if not isinstance(scanned_at_epoch, (int, float)):
        raise ValueError("usage scan cache is missing 'scanned_at'")
    parsed = raw.get("parsed")
    if not isinstance(parsed, dict):
        raise ValueError("usage scan cache is missing 'parsed'")

    scanned_dt = _dt.datetime.fromtimestamp(float(scanned_at_epoch), tz=_dt.timezone.utc)
    captured_at = scanned_dt.strftime("%Y-%m-%dT%H:%M:%SZ")
    scanner = "ccusage"

    session_counts = extract_session_counts(parsed)
    sessions_by_pair = session_counts["by_pair"] if session_counts["available"] else None
    incoming = rows_from_scan(parsed, captured_at, scanner, sessions_by_pair)
    if not incoming:
        raise EmptyScanError("scan contained no daily rows")
    horizon_date = scanned_dt.date() - _dt.timedelta(days=FREEZE_HORIZON_DAYS)

    path = history_path()
    existing, _warnings = read_rows(path)
    merged, stats = merge_rows(existing, incoming, horizon_date)
    # Cost is derived data, not a fact the freeze horizon needs to protect —
    # unlike a token count, a cost can be legitimately WRONG on a frozen day
    # (ccusage priced it $0 before an override existed) and repairing it here
    # does not rewrite history the way changing a token count would.
    merged, reprice_stats = reprice_rows(merged, load_pricing_overrides())
    write_rows(path, merged)
    stats["repriced"] = reprice_stats["rows_changed"]
    stats["sessions_undated"] = session_counts["undated"]
    stats["sessions_unmatched"] = session_counts["unmatched"]
    return stats


# ─────────────────────────────────────────────────────────────────────────────
# Claude stats-cache import — one shared guard, two callers
# ─────────────────────────────────────────────────────────────────────────────


def _stats_cache_version_ok(raw: dict) -> bool:
    """The one guard both `import_claude_stats` and `claude_stats_probe` run
    (W4) before touching `dailyModelTokens[]`: a missing `version` (older
    caches never had the key) or a literal `3` are the only shapes this
    module knows how to read. Anything else fails closed — `import_claude_stats`
    raises, `claude_stats_probe` reports unavailable — rather than blindly
    importing a schema this code was never written against."""
    version = raw.get("version")
    return version is None or version == 3


def _claude_import_plan(daily: list, existing: list[UsageRow]) -> dict:
    """Shared classification behind BOTH `import_claude_stats` and
    `claude_stats_probe` — one guard, so the two can never disagree about
    which `dailyModelTokens[]` days/rows would actually land.

    A day already covered by a `ccusage` claude row is skipped whole (never
    mixed provenance). Within a surviving day, a `(date, "claude", model)`
    triple the ledger already holds (from a prior import) is skipped too, so
    a re-run is idempotent. `importable_dates` counts a date only when it
    would gain at least one NEW row — the number a probe reports and a
    subsequent import actually inserts must always agree.

    Two more guards (W4), both reported via `warnings` rather than silently:
    a `date` repeated across `daily` uses only its LAST occurrence (earlier
    ones are discarded before any row is built, so nothing double-counts a
    day); a `tokensByModel` value that is a `bool` or negative is skipped
    for that one model rather than accepted as a token count (`bool` is a
    Python `int` subclass, so `true`/`false` would otherwise become `1`/`0`;
    a non-numeric, non-bool value is skipped silently, unchanged from
    before — it was never a plausible token count either way).
    """
    covered_dates = {row.date for row in existing if row.agent == "claude" and row.source == "ccusage"}
    existing_keys = {(row.date, row.agent, row.model) for row in existing}

    entries_by_date: dict[str, dict] = {}
    duplicate_dates: set[str] = set()
    for entry in daily:
        if not isinstance(entry, dict):
            continue
        date_str = entry.get("date")
        if not isinstance(date_str, str) or not _DATE_RE.match(date_str):
            continue
        if date_str in entries_by_date:
            duplicate_dates.add(date_str)
        entries_by_date[date_str] = entry  # last occurrence wins

    insertable: list[tuple[str, str, float]] = []
    skipped_existing = 0
    skipped_ccusage_dates: set[str] = set()
    importable_dates: set[str] = set()
    warnings: list[str] = [
        f"stats-cache: duplicate date {date_str!r} — using the last occurrence"
        for date_str in sorted(duplicate_dates)
    ]

    for date_str, entry in entries_by_date.items():
        tokens_by_model = entry.get("tokensByModel")
        if not isinstance(tokens_by_model, dict):
            continue
        if date_str in covered_dates:
            skipped_ccusage_dates.add(date_str)
            continue
        day_has_insertable = False
        for model_name, total in tokens_by_model.items():
            if not isinstance(model_name, str) or not model_name:
                continue
            if not isinstance(total, (int, float)) or isinstance(total, bool):
                if isinstance(total, bool):
                    warnings.append(
                        f"stats-cache {date_str}: skipped model {model_name!r} — "
                        f"tokensByModel value must be a number, got a bool"
                    )
                continue
            if total < 0:
                warnings.append(
                    f"stats-cache {date_str}: skipped model {model_name!r} with a "
                    f"negative tokensByModel value ({total!r})"
                )
                continue
            key = (date_str, "claude", model_name)
            if key in existing_keys:
                skipped_existing += 1
                continue
            insertable.append((date_str, model_name, total))
            day_has_insertable = True
        if day_has_insertable:
            importable_dates.add(date_str)

    return {
        "importable_dates": importable_dates,
        "insertable_rows": insertable,
        "skipped_existing": skipped_existing,
        "skipped_ccusage_days": len(skipped_ccusage_dates),
        "warnings": warnings,
    }


def import_claude_stats(stats_path: Path, dry_run: bool = False) -> dict:
    """One-time, tokens-only import of Claude Code's own `stats-cache.json`.

    Inserts only absent `(date, "claude", model)` rows and skips any
    `(date, "claude")` day the ledger already covers with a `ccusage` row —
    see `_claude_import_plan`. `dry_run=True` reports what would happen and
    writes nothing (the ledger file is untouched, byte-for-byte).

    Raises `FileNotFoundError` / `ValueError` on a missing or malformed
    stats cache — fails closed, same convention as `record_from_cache`. An
    unsupported schema `version` (W4) is one such `ValueError`: missing or
    `3` is accepted, anything else raises and writes nothing.
    """
    stats_path = Path(stats_path)
    if not stats_path.exists():
        raise FileNotFoundError(f"no Claude stats cache at {stats_path}")
    try:
        raw = json.loads(stats_path.read_text())
    except (OSError, ValueError) as exc:
        raise ValueError(f"Claude stats cache unreadable: {exc}") from exc
    if not isinstance(raw, dict):
        raise ValueError("Claude stats cache is not a JSON object")
    if not _stats_cache_version_ok(raw):
        raise ValueError(f"unsupported stats-cache version {raw.get('version')!r}")
    daily = raw.get("dailyModelTokens")
    if not isinstance(daily, list):
        raise ValueError("Claude stats cache is missing 'dailyModelTokens'")

    path = history_path()
    existing, _warnings = read_rows(path)
    plan = _claude_import_plan(daily, existing)

    now_iso = _utc_now_iso()
    new_rows = [
        UsageRow(
            date=date_str,
            agent="claude",
            model=model_name,
            input=None,
            output=None,
            cache_creation=None,
            cache_read=None,
            total=int(total),
            cost_usd=None,
            source="claude-stats-cache",
            scanner="claude-stats-cache",
            captured_at=now_iso,
        )
        for date_str, model_name, total in plan["insertable_rows"]
    ]

    if not dry_run and new_rows:
        write_rows(path, existing + new_rows)

    result: dict = {
        "skipped_existing": plan["skipped_existing"],
        "skipped_ccusage_days": plan["skipped_ccusage_days"],
        "dry_run": dry_run,
        "warnings": plan["warnings"],
    }
    result["would_insert" if dry_run else "inserted"] = len(new_rows)
    return result


def claude_stats_probe(stats_path: Optional[Path] = None, existing_rows: list[UsageRow] = ()) -> dict:  # type: ignore[assignment]
    """Read-only probe of the stats-cache import surface — never writes,
    never raises. Runs the SAME guards `import_claude_stats` applies
    (`_stats_cache_version_ok`, `_claude_import_plan`), so a reported count
    can never drift from what an actual import would do, and an unsupported
    schema `version` (W4) reports unavailable rather than a stale count.

    `path` in the result is `display_path(resolved)` (W8) — `~/…` under the
    real `$HOME`, the caller-supplied path verbatim otherwise — never the
    expanded real `$HOME` itself.
    """
    resolved = Path(stats_path) if stats_path is not None else default_stats_cache_path()
    disp = display_path(resolved)

    empty = {"available": False, "path": disp, "importable_days": 0, "last_computed": None}
    if not resolved.exists():
        return empty
    try:
        raw = json.loads(resolved.read_text())
    except (OSError, ValueError):
        return empty
    if not isinstance(raw, dict):
        return empty
    if not _stats_cache_version_ok(raw):
        return empty
    daily = raw.get("dailyModelTokens")
    if not isinstance(daily, list):
        return empty

    plan = _claude_import_plan(daily, list(existing_rows))
    last_computed = raw.get("lastComputedDate")
    if not isinstance(last_computed, str):
        last_computed = None
    return {
        "available": True,
        "path": disp,
        "importable_days": len(plan["importable_dates"]),
        "last_computed": last_computed,
    }


# ─────────────────────────────────────────────────────────────────────────────
# `hub usage history --json` payload
# ─────────────────────────────────────────────────────────────────────────────


def _zero_tokens() -> dict:
    return {"input": 0, "output": 0, "cacheCreation": 0, "cacheRead": 0, "total": 0}


def _add_tokens(target: dict, addend: dict) -> None:
    for key in ("input", "output", "cacheCreation", "cacheRead", "total"):
        target[key] += addend[key]


def _agent_display_name(agent_id: str) -> str:
    if agent_id in _AGENT_DISPLAY_NAMES:
        return _AGENT_DISPLAY_NAMES[agent_id]
    return agent_id.replace("-", " ").replace("_", " ").title()


def _utc_now_iso() -> str:
    return _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def history_view(
    rows: list[UsageRow],
    since: Optional[str],
    until: Optional[str],
    today: _dt.date,
    claude_stats_path: Optional[Path] = None,
    warnings: Optional[list[str]] = None,
) -> dict:
    """The `hub usage history --json` payload: one entry per recorded day,
    each carrying day-, agent- and model-grain `provenance`/`costKnown`/
    `splitKnown`, plus the read-only `claude_stats` import probe.

    `costKnown` is false when any contributing row has `cost_usd: null`, and
    `costUsd` then sums only the known rows (never fabricates the rest).
    `splitKnown` is false when any contributing row has a null
    input/output/cache_* split (a backfilled row carries only `total`); the
    split fields then sum only the split-known rows while `total` stays
    exact. The horizon is computed from `today`, not from any row's own
    `captured_at` — this is a read-side view, not the write-side merge.

    `warnings` (review W6) carries the caller's own `read_rows` drop
    warnings — a malformed ledger LINE, not a malformed DAY, so this
    function cannot discover them itself; the caller (`cmd_usage_history`)
    already has them from its own `read_rows` call. Defaults to `[]` so a
    caller building a view straight from an in-memory row list (most tests)
    need not pass one — a corrupted ledger line was previously visible only
    in `hub usage history`'s TEXT output, never in `--json`.
    """
    horizon_date = today - _dt.timedelta(days=FREEZE_HORIZON_DAYS)
    horizon_str = horizon_date.isoformat()
    view_warnings = list(warnings) if warnings else []

    filtered = rows
    if since:
        filtered = [r for r in filtered if r.date >= since]
    if until:
        filtered = [r for r in filtered if r.date <= until]

    by_day: dict[str, list[UsageRow]] = {}
    for row in filtered:
        by_day.setdefault(row.date, []).append(row)

    days_out = []
    backfilled_days = frozen_days = scanned_days = 0

    for date_str in sorted(by_day):
        day_rows = by_day[date_str]
        day_date = _dt.date.fromisoformat(date_str)
        day_has_ccusage = any(r.source == "ccusage" for r in day_rows)
        if not day_has_ccusage:
            day_prov = "backfilled"
            backfilled_days += 1
        elif day_date >= horizon_date:
            day_prov = "scanned"
            scanned_days += 1
        else:
            day_prov = "frozen"
            frozen_days += 1

        by_agent: dict[str, list[UsageRow]] = {}
        for row in day_rows:
            by_agent.setdefault(row.agent, []).append(row)

        agents_out = []
        day_tokens = _zero_tokens()
        day_cost = 0.0
        day_cost_known = True
        day_split_known = True
        day_sessions = 0
        day_sessions_known = True

        for agent_id in sorted(by_agent):
            agent_rows = sorted(by_agent[agent_id], key=lambda r: r.model or "")
            agent_has_ccusage = any(r.source == "ccusage" for r in agent_rows)
            if not agent_has_ccusage:
                agent_prov = "backfilled"
            elif day_date >= horizon_date:
                agent_prov = "scanned"
            else:
                agent_prov = "frozen"

            agent_tokens = _zero_tokens()
            agent_cost = 0.0
            agent_cost_known = True
            agent_split_known = True
            agent_session_values = [row.sessions for row in agent_rows]
            agent_sessions = (
                agent_session_values[0]
                if agent_session_values
                and agent_session_values[0] is not None
                and all(value == agent_session_values[0] for value in agent_session_values)
                else None
            )
            agent_sessions_known = agent_sessions is not None
            if not agent_sessions_known and any(value is not None for value in agent_session_values):
                view_warnings.append(
                    f"usage history: sessions unknown for {date_str} / {agent_id} "
                    "because rows do not carry one identical non-null count"
                )
            models_out = []

            for row in agent_rows:
                row_tokens = {
                    "input": row.input or 0,
                    "output": row.output or 0,
                    "cacheCreation": row.cache_creation or 0,
                    "cacheRead": row.cache_read or 0,
                    "total": row.total,
                }
                _add_tokens(agent_tokens, row_tokens)
                row_cost_known = row.cost_usd is not None
                if row_cost_known:
                    agent_cost += row.cost_usd  # type: ignore[operator]
                else:
                    agent_cost_known = False
                row_split_known = (
                    row.input is not None
                    and row.output is not None
                    and row.cache_creation is not None
                    and row.cache_read is not None
                )
                if not row_split_known:
                    agent_split_known = False
                models_out.append(
                    {
                        "model": row.model,
                        "costUsd": round(row.cost_usd or 0.0, 6) if row_cost_known else 0.0,
                        "costKnown": row_cost_known,
                        "splitKnown": row_split_known,
                        "tokens": row_tokens,
                    }
                )

            _add_tokens(day_tokens, agent_tokens)
            day_cost += agent_cost
            if not agent_cost_known:
                day_cost_known = False
            if not agent_split_known:
                day_split_known = False
            if agent_sessions_known:
                day_sessions += agent_sessions  # type: ignore[operator]
            else:
                day_sessions_known = False

            agents_out.append(
                {
                    "agent": agent_id,
                    "name": _agent_display_name(agent_id),
                    "provenance": agent_prov,
                    "source": agent_rows[0].source,
                    "tokens": agent_tokens,
                    "costUsd": round(agent_cost, 6),
                    "costKnown": agent_cost_known,
                    "splitKnown": agent_split_known,
                    "sessions": agent_sessions,
                    "sessionsKnown": agent_sessions_known,
                    "models": models_out,
                }
            )

        days_out.append(
            {
                "date": date_str,
                "provenance": day_prov,
                "tokens": day_tokens,
                "costUsd": round(day_cost, 6),
                "costKnown": day_cost_known,
                "splitKnown": day_split_known,
                "sessions": day_sessions if day_sessions_known else None,
                "sessionsKnown": day_sessions_known,
                "agents": agents_out,
            }
        )

    return {
        "schema_version": 1,
        "generated_at": _utc_now_iso(),
        "horizon": horizon_str,
        "since": since,
        "until": until,
        "days": days_out,
        "counts": {
            "days": len(days_out),
            "rows": len(filtered),
            "backfilled_days": backfilled_days,
            "frozen_days": frozen_days,
            "scanned_days": scanned_days,
        },
        "claude_stats": claude_stats_probe(claude_stats_path, rows),
        "warnings": view_warnings,
    }
