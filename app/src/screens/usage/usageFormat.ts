import { plural } from "@/lib/plural";

/** Currency the screen renders costs in. EUR is a local, offline conversion —
 *  never a network rate lookup — regardless of the separate online-pricing
 *  opt-in (Plan A Addendum A3), which is the ONE network call this screen
 *  ever makes, and only while a viewer has explicitly turned it on. */
export type UsageCurrency = "USD" | "EUR";

/** `Intl.NumberFormat` grouped integer — "1,200". A non-finite value reads
 *  "0" rather than the literal "NaN"/"∞" `Intl` prints: these numbers come
 *  from a normalizer over a user-editable cache, and a KPI tile is the wrong
 *  place to surface a parse failure. */
export function formatCount(value: number): string {
  if (!Number.isFinite(value)) return "0";
  // `Math.round(-0)` is `-0`, which `Intl` prints as "-0"; `+ 0` normalizes
  // it back to a plain zero.
  return new Intl.NumberFormat().format(Math.round(value) + 0);
}

/** Descending, so the first unit a value clears is the largest one. */
const COMPACT_UNITS: ReadonlyArray<readonly [number, string]> = [
  [1_000_000_000_000, "T"],
  [1_000_000_000, "B"],
  [1_000_000, "M"],
  [1_000, "k"],
];

/** Compact magnitude for chart ticks/bars/KPIs — "1.2T", "29.5B", "845k".
 *  Below 1,000 falls back to {@link formatCount} (no decimal noise on small
 *  counts). A 29.5-billion-token corpus must read "29.5B", never a 5-digit
 *  "M" figure — always the largest unit the value clears. */
export function formatCompact(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  for (let i = 0; i < COMPACT_UNITS.length; i++) {
    const [unit, suffix] = COMPACT_UNITS[i];
    if (abs < unit) continue;
    // 999,950 rounds to 1000.0 inside its own unit — a four-digit mantissa
    // ("1000k") for what a reader would call 1M. Roll up one unit instead;
    // above T there is nothing to roll into, so 1e15 stays "1000T".
    if (Math.round((abs / unit) * 10) / 10 >= 1_000 && i > 0) {
      const [bigger, biggerSuffix] = COMPACT_UNITS[i - 1];
      return `${sign}${trimDecimal(abs / bigger)}${biggerSuffix}`;
    }
    return `${sign}${trimDecimal(abs / unit)}${suffix}`;
  }
  return formatCount(value);
}

function trimDecimal(n: number): string {
  const rounded = Math.round(n * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/** A [0, 1] fraction as a percentage — "42%" for a whole share, "0.3%" for a
 *  small but real one, "<0.1%" for a share too thin to round to a tenth, and
 *  "0%" only for exactly zero. A share below 1% otherwise reads as the same
 *  misleading "0%" a real 0.29% share once did. */
export function formatPercent(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0%";
  const pct = value * 100;
  if (pct < 0.05) return "<0.1%";
  if (pct < 1) return `${pct.toFixed(1)}%`;
  return `${Math.round(pct)}%`;
}

/** An estimated-API-equivalent USD amount, converted to `currency` with
 *  `eurRate` (EUR per USD) and formatted via `Intl.NumberFormat`'s currency
 *  style. Every cost on the Usage screen goes through this — never a bespoke
 *  `$`-prefixed template string. `currencyDisplay: "narrowSymbol"` always
 *  prints the bare `$`/`€` — the default `"symbol"` display disambiguates
 *  USD from other dollar currencies as `"US$"` under some locales, which
 *  runs a hero cost like $6,921.07 past the stat card's padding. */
export function formatMoney(usd: number, currency: UsageCurrency, eurRate: number): string {
  const amount = currency === "EUR" ? usd * eurRate : usd;
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    currencyDisplay: "narrowSymbol",
    maximumFractionDigits: 2,
  }).format(amount);
}

/** "3 days ago" / "just now", and **empty** for a missing or unparseable
 *  timestamp — a row then simply shows no time rather than the word
 *  "Unknown". */
export function formatRelativeTime(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const diffMs = Date.now() - date.getTime();
  if (diffMs < 0) return "just now";
  const diffSec = Math.round(diffMs / 1000);
  if (diffSec < 60) return "just now";
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin} ${plural(diffMin, "minute")} ago`;
  const diffHour = Math.round(diffMin / 60);
  if (diffHour < 24) return `${diffHour} ${plural(diffHour, "hour")} ago`;
  const diffDay = Math.round(diffHour / 24);
  if (diffDay < 30) return `${diffDay} ${plural(diffDay, "day")} ago`;
  const diffMonth = Math.round(diffDay / 30);
  if (diffMonth < 12) return `${diffMonth} ${plural(diffMonth, "month")} ago`;
  const diffYear = Math.round(diffMonth / 12);
  return `${diffYear} ${plural(diffYear, "year")} ago`;
}

/** "1h 27m" / "48m" / "< 1m" — never a fractional minute below an hour and
 *  never a bare minute count above one. Shared by the session detail's
 *  Activity block and the session drill-down sheet's header strip Duration
 *  row (both session-grain durations, routinely minutes to hours long). A
 *  sub-agent's own, much shorter run uses {@link formatSubAgentDuration}
 *  instead — this floor would read "< 1m" for nearly every one of them
 *  (REVIEW-W2 F10). */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 60_000) return "< 1m";
  const totalMinutes = Math.floor(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

/** Seconds-aware duration for a sub-agent row (REVIEW-W2 F10): "45s" below a
 *  minute, else the same "1h 27m"/"48m" shape {@link formatDuration} already
 *  gives. Sub-agent runs are routinely seconds long — `formatDuration`'s
 *  one-minute floor would read "< 1m" for nearly every one of them, losing
 *  the duration entirely for the most common row. */
export function formatSubAgentDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return formatDuration(ms);
}

/**
 * The first 8 characters of a plain session id, or the last 8 hex characters
 * of a rollout UUID — enough to disambiguate a
 * fallback session label without printing a whole UUID or path-derived key. A
 * Codex period is a path (`2026/02/19/rollout-<ts>-<uuid>`), so the id is the
 * UUID at its tail; any other value is taken as the id itself.
 *
 * The 8-char cut can land mid-separator (a date period "2026-07-14" cut to
 * "2026-07-"), which reads as a truncation bug rather than an id, so trailing
 * separators are trimmed. A value with nothing left to show returns "" and
 * the caller drops the id clause entirely.
 */
export function shortId(value: string): string {
  const tail = value.split("/").pop() ?? value;
  const uuid = tail.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  // A rollout is recognised from its own TAIL segment only — `rollout-…-<uuid>`
  // or a timestamp glued to the uuid — never from a date-shaped directory
  // elsewhere in the path: a Claude transcript archived under
  // `…/2026-02-19/<uuid>` keeps its leading eight.
  const rollout =
    uuid !== null &&
    (/^rollout[-_]/i.test(tail) || /^\d{4}-\d{2}-\d{2}T[\d-]+[-_]?$/i.test(tail.slice(0, uuid.index ?? 0)));
  const id = uuid ? uuid[0] : tail;
  return (rollout ? id.slice(-8) : id.slice(0, 8)).replace(/[-_.\s]+$/, "");
}

/** "Sept 3, 2026, 2:41 PM" style — the header subline's last-scan clause. */
export function formatScannedAt(value: string | undefined): string {
  if (!value) return "no cached scan yet";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

/** The header pill's privacy claim. Accurate only while every scan stays
 *  offline (the default): once the online-pricing opt-in (Plan A Addendum
 *  A3) is on, a scan fetches LiteLLM's public price list over the network,
 *  so the pill must say so rather than repeating a claim the opt-in just
 *  made partly untrue — `ccusage` itself still runs locally either way,
 *  only the price-list fetch leaves the machine. */
export function usageRunsLocallyLabel(onlinePricing: boolean): string {
  return onlinePricing ? "Runs locally · fetches public prices" : "Runs locally · No raw prompts uploaded";
}

/** Folds a leading `/Users/<name>` or `/home/<name>` prefix to `~` — the
 *  Prices popover's `overrides_path` (REVIEW-A #11) is a full disk path,
 *  never redacted by the Rust side (it's a config path, not a project one),
 *  so this is the frontend's own display-only shortening. A path outside
 *  either shape (an app-bundle install, a Windows path) is returned
 *  unchanged — never a lossy guess. */
export function foldHomeDir(path: string): string {
  const match = /^\/(?:Users|home)\/[^/]+(\/.*)?$/.exec(path);
  return match ? `~${match[1] ?? ""}` : path;
}

/** Preserve a captured lower bound when some evidence is unavailable. */
export function formatCapturedCount(value: number, complete: boolean, compact = false): string {
  const formatted = compact ? formatCompact(value) : formatCount(value);
  return complete ? formatted : value > 0 ? `At least ${formatted}` : "Unavailable";
}
