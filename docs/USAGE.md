# Usage History

A durable ledger of daily token and cost totals per agent, stored at
`<data_home>/state/usage/history.jsonl`. It exists so the Usage screen can
show a day even after Claude Code (or another harness) removes the
transcripts that day came from.

## What the ledger is not

The ledger holds only daily totals per agent and model, plus a per-pair
session count. It does not hold session records. A session row carries a
title, a project path, and other private facts, so the ledger never stores
one. "Largest sessions",
"Projects", and tool-call counts always come from the latest usage scan, not
from the ledger.

The ledger is not a durability guarantee. It grows only when you open the
Usage screen or run `hub usage record` by hand. There is no scheduled
capture and no background sync.

## What the Usage screen reads from each source

The Usage screen reads two sources. Each number on the screen comes from
exactly one of them, never both.

From the ledger (`hub usage history`):

- The spend chart
- The KPI cost and token tiles
- Token composition (input, output, cache creation, cache read)
- The top-models list
- The harness breakdown

From the latest scan (the app writes the scan cache after every ccusage
scan; `hub usage record --from-cache` reads that cache):

- Largest sessions
- Session detail
- Projects
- Session and tool-call counts

A backfilled day (see below) has no cost and no token split. The screen
shows its total tokens only, and marks the cost and the split as unknown.

## Codex sessions and agents

Codex sessions use local names or titles when available. The scan reads Codex's
session index and thread database without updating either. A missing or unreadable
metadata source leaves the short session ID as the label. Titles refresh on the
next scan.

The session lists group delegated Codex agents under their parent, including
nested agents. Expand the parent to see each member's own usage and inspect an
agent. The parent row sums each measured member once. Inspection subtree totals
are separate and are never added to that sum.

Filters apply to measured rows. A parent outside the filter can still supply the
task title, with a note that its usage is excluded. An agent whose parent is
missing stays visible with a "Parent unavailable" label. Ordinary forks remain
separate unless Codex records an explicit agent-parent relationship.

Older Codex inspection captures are reparsed once when their source is available.
Retained bodies and pins survive. Legacy token evidence without enough attribution
is kept but excluded from corrected totals; a removed source reports unavailable
tokens. Claude Code accounting is unchanged.

## Row schema

One JSON line per `(date, agent, model)`:

```json
{"date":"2026-08-14","agent":"claude","model":"claude-sonnet-4-5","input":12000,"output":3400,"cache_creation":500,"cache_read":88000,"total":103900,"cost_usd":0.42,"source":"ccusage","scanner":"ccusage","captured_at":"2026-08-14T09:12:03Z","sessions":2}
```

| Field | Meaning |
|---|---|
| `date` | `YYYY-MM-DD`, taken verbatim from the scan. |
| `agent` | The harness id ccusage reports (`claude`, `codex`, and more). |
| `model` | The model name, or `null` for the remainder row (see below). |
| `input`, `output`, `cache_creation`, `cache_read` | Token counts. `null` on a backfilled row — the import has no split. |
| `total` | The token total. Always a number, on every row. |
| `cost_usd` | The cost in US dollars, or `null` on a backfilled row. A `0.0` cost is a real value: ccusage reports `0.0` for a model its offline pricing snapshot does not cover. |
| `source` | `ccusage` or `claude-stats-cache`. |
| `scanner` | A free-text label for the tool that produced the row. |
| `captured_at` | An RFC-3339 UTC timestamp of when the row was recorded. |
| `sessions` | Nullable count for the `(date, agent)` pair, repeated on every model/remainder row. `null` means unknown; history deduplicates repeated values and never stores session records. Counts use the session's `lastActivity`, then `metadata.lastActivity`, then `metadata.updatedAt`, converted to a UTC calendar date. |

A session is counted on its last active day; a session resumed after its day froze is counted again on the new day.

**Remainder row.** A ccusage agent can report a `totalTokens` above the sum
of its model breakdown. When it does — and only then — the ledger adds one
extra row with `model: null` that holds the difference, so the sum of every
row for one `(date, agent)` pair equals what ccusage reported. When
`totalTokens` sits AT or BELOW the breakdown sum, the ledger adds no
remainder row: the day × agent total is then the breakdown sum, not
ccusage's own total. (This is a one-sided reconciliation, not a full
protection against every malformed scan: the token remainder and the cost
remainder are each their own condition, and a row is never allowed to carry
a negative token or cost field — a below-sum split field is clamped to `0`,
and a below-sum cost remainder is `0.0`, never negative.) When ccusage
reports no model breakdown at all, the remainder row is the only row for
that pair, and it carries the agent-level totals verbatim.

## The freeze-horizon rule

`hub usage record` merges a scan into the ledger under one rule: a day is
**mutable** for 14 days from the day it was scanned, then it **freezes**.

- A day inside the 14-day window is mutable. For every agent present
  ANYWHERE in a later scan, every one of that agent's rows on a mutable day
  is deleted — every such day, whether or not the scan itself reports that
  day — and replaced with the scan's own rows for that agent. A day the
  scan no longer covers for a scanned agent therefore disappears rather than
  surviving as stale data. An agent absent from the scan keeps every one of
  its rows, mutable or frozen.
- A day outside the window is write-once. If the ledger already holds a row
  for that `(date, agent)` pair, a later scan cannot change it — this holds
  regardless of whether the scanned agent's other, mutable-day rows are
  being mirrored above.

The horizon comes from the scan's own timestamp, not from the current date.
This rule stops a late re-scan from silently editing history, while still
letting the ledger correct an in-progress day as more usage lands.

One sentence on totals: the ledger's day × agent total equals ccusage's own
`totalTokens` whenever it is at or above the modelBreakdowns sum, and the
breakdown sum otherwise (see Remainder row, above).

## Provenance

Each day, agent, and model in `hub usage history --json` carries one of
three provenance values:

| Provenance | Meaning |
|---|---|
| `scanned` | Inside the mutable window, from a real ccusage scan. |
| `frozen` | Outside the mutable window, from a real ccusage scan recorded while it was still mutable. |
| `backfilled` | From the one-time `stats-cache.json` import. No ccusage scan ever covered this day. |

`costKnown` is `false` when any row that makes up the total has a `null`
cost. In that case, the reported cost is the sum of the known rows only —
never a guess. `splitKnown` works the same way for the token split.

## Usage timeline

`hub usage timeline [--project NAME] --json` reads the sessions ledger once and returns a
privacy-safe aggregate of timestamped events. It returns one daily row for
each UTC date containing at least one recognized skill or tool event, sorted
ascending. Use `--since` and `--until` for
inclusive UTC date bounds, and `--harness claude-code` or `--harness codex` to
filter rows. `--project NAME` limits this scan-derived activity to that
registry project, including sub-agent sessions; it is not cost or model
attribution. The payload contains daily skill/tool counts, a Monday-first UTC
weekday/hour token grid, and matching harness metadata; it never contains
session ids, paths, prompts, or raw event data.

Claude Code contributes only MCP calls, named `<server>/<tool>`. Codex adds a
standalone `skill` event for each registry skill read or mention. These events
are additive, carry zero token and activity deltas, and are ordered after the
primary event at the same timestamp. Server and tool identifiers are bounded
and validated before they are persisted.

Frozen sessions are normally skipped. After an event-format change, a cursor
entry with an absent or older `event_version` is reparsed once from byte zero,
then written with the current version; scan results expose the per-harness
`reparsed` count. Existing session token totals remain unchanged.

## Captured session details

Claude Code and Codex inspection details use the local Inspection SQLite store.
Session identity includes the harness. The same UUID from two harnesses refers to two different sessions.

The index carries separate native facts for the selected run, its children, and the combined subtree.
Claude native line totals and duration come from `cost-state` records. Native duration is not active time.
Tool counts and the per-tool breakdown come from captured calls. These facts do not depend on retained body text.

Each field reports whether evidence is observed, partial, or unavailable.
An unavailable value is not zero. Source disappearance preserves previously captured facts and marks the session unavailable.
A reader revision change reparses unchanged sources before their next successful capture can be skipped.
Pins and prior successful evidence survive this backfill. An unsupported newer store schema fails closed.

Rust still provides titles, project labels and Codex metadata.
Pi retains its Rust tool-count and breakdown producer until canonical Pi capture provides the replacement.
Pi Usage rows remain available. This exception does not provide Pi inspection or native compatibility evidence.

The isolated bundled ccusage 20.0.17 probe includes Claude child tokens in the parent session total.
See [the fixture evidence](changes/DESIGN-usage-wave-2/ccusage-subagent-probe/README.md).
This observation does not justify adding child totals again to a ccusage parent row.

## Claude Code's own stats-cache import

Claude Code keeps its own usage record at `~/.claude/stats-cache.json`. It
holds daily token totals per model, going back further than most ccusage
scans reach, but with three limits: it has no cost, it has no agent field
(every row is Claude Code's own usage), and its token count is not the same
measure as ccusage's. Claude Code's number is much smaller for a comparable
day, by roughly a factor of 100 in practice, because it does not appear to
count cache reads. A backfilled day therefore shows a small bar next to a
scanned day. Read it as "there was activity", not as a comparable total.

`hub usage import-claude-stats` reads this file once and adds tokens-only
rows with `source: "claude-stats-cache"`. The import follows one guard:

- It inserts a row only when the ledger has no row yet for that
  `(date, "claude", model)` combination.
- It skips a whole day when the ledger already holds a `ccusage` row for
  `(date, "claude")`.

The second rule matters: without it, one day could end up part scanned and
part backfilled, and the day's provenance would no longer mean anything.

The import fails closed on a few malformed shapes, each reported as a
warning and never written: a missing schema `version` (older caches never
had the key) or a literal `3` is accepted, any other version stops the
whole import before it writes anything; a `tokensByModel` value that is a
boolean or negative is skipped for that one model; a `date` repeated more
than once in the cache uses only its last occurrence.

## Pricing overrides

ccusage prices each scan from a pricing table built into the binary. That
table has no row for four models: `claude-fable-5-1`, `claude-opus-5`,
`claude-sonnet-5`, and `gpt-6-astra`. ccusage then reports a cost of `0.0`
for every row of those models, with no warning.

`ccusage-pricing.json`, at the code home, corrects this gap. It is a plain
ccusage config file with one `defaults.pricingOverrides` block. The block
lists an input rate, an output rate, a cache-write rate, and a cache-read
rate, in US dollars per token, for each model. Two readers use this file.

The Rust scan passes the file to ccusage with `--config` on every run. A
scan after this change prices the four models correctly.

`usage_history.py` reads the same file a second time, after the scan
writes the ledger. `hub usage record` reprices every merged row that no
scan has ever priced, using this file. A row a past scan left at `0.0`
gets a real cost as soon as an override exists for its model. A stored
cost still reflects the price table in force when the row was priced.
Published prices change over time, and the ledger does not track that.

The reprice pass never touches a row ccusage already priced above `0.0`.
ccusage prices the one-hour cache-write tier from the real transcript.
`ccusage-pricing.json` gives only the five-minute rate for cache writes,
so a cost this pass computes is a floor, not an exact number. ccusage's
own cost, when it has one, is more accurate and stays untouched. A
`model: null` remainder row carries no model name, so it is never
repriced. An agent-day ccusage reports with no per-model breakdown stays
at whatever cost the scan gave it.

The freeze horizon still protects token counts on a frozen day. It does
not protect cost. Cost is derived data, and a missing cost is a gap this
pass can still fill, not a fact the horizon needs to guard.

Run `hub usage reprice` to reprice the whole ledger by hand:

```
hub usage reprice [--dry-run] [--json]
```

Use this after you edit `ccusage-pricing.json`, or whenever you want to
force a recheck. Add `--dry-run` to see the change first, with no write.

## Timezone caveat

A day key is ccusage's own local-timezone day, while the Usage screen
formats dates in UTC. A session near midnight can land in the neighboring
day's column. This is a pre-existing limit, not new to the ledger.

## Day, week and month details

Select a day, week or month in the Usage screen's spend, skill activity, tool
activity or model-mix chart to open its details. Daily and cumulative activity
calendar cells open a day; weekly cells open their Monday-to-Sunday week.
Keyboard users can activate the focused period with Enter or Space. Year buckets
and the weekday/hour peaks grid do not open the modal.

The modal retains the selected harness and currency. It shows the period's tokens,
estimated API-equivalent cost, model and tool-server breakdowns, and sessions last
active in that period. Session rows show whole-session totals, which can include other
days. The existing last-activity, start, then period fallback assigns a dated session
to the list; undated sessions cannot be attributed to a period.

History uses each source's date keys. Sessions and dated tool events use UTC, so the
modal labels this existing boundary difference. Unknown cost and token composition
remain unavailable; mixed known/unknown cost is marked partial. Missing timeline
data has loading, unavailable, and retry states rather than fabricated zero counts.

Opening or navigating periods reads the bounded timeline without scanning and sums
tool counts across its days. Weeks start Monday; months cover the full calendar
month. A selected period includes all its available data even when the dashboard
range shows only part of it. Previous/next moves by the selected period kind.
Search and expanded rows reset when changing period. Inspect session opens the
existing inspection route; Back to Usage restores the selected period. The
calendar's daily/weekly/cumulative view choice survives the return too.

Deep links use one period parameter: `#/usage?day=2026-07-14`,
`#/usage?week=2026-07-13`, or `#/usage?month=2026-07`. Week dates normalize to
Monday; invalid or ambiguous period parameters do not open a modal.

## Backup

The ledger travels in the hub backup as `usage/<hostname>.jsonl`, one file
per machine, so two machines never overwrite each other's history. A
restore writes the file back only when this machine has no ledger yet, or an
empty one. This gives a reinstalled machine its history back. A machine that
already has a ledger keeps it: a ledger is an append-only record of what
happened on one machine, and merging or overwriting it from another machine
would fabricate or erase history. Restore prefers the file for this hostname.
When the snapshot holds exactly one machine, it takes that machine's file.
With several other machines it skips the ledger and names them in the report.
The other machines' files stay readable in the backup repo.

Because the ledger is rewritten on every visit to the Usage screen, it is
excluded from the sync-tail auto-backup's change check. An explicit
`hub sync` or `hub backup now` still backs it up in full.

## Commands

```
hub usage record [--from-cache [PATH]] [--json]
```

Read a ccusage scan cache and merge it into the ledger. `PATH` defaults to
`<data_home>/usage/latest-ccusage.json`, the file the app writes after every
scan. Give `--from-cache PATH` to test against a different file — the bare
flag with no `PATH` is the same as omitting it entirely.

```
hub usage history [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--json]
```

Show the ledger as one entry per day. `--since` and `--until` limit the
range. The JSON payload also carries a `claude_stats` object that reports
how many more days `hub usage import-claude-stats` could add, and a
`warnings` list of any malformed ledger LINE that `read_rows` had to drop
(empty in the normal case). The app shows a banner when this list is
non-empty, and a separate banner when the command fails outright — a broken
`hub`, a corrupted `history.jsonl` — so a reader never mistakes a silently
unavailable ledger for an empty one.

```
hub usage import-claude-stats [--path PATH] [--dry-run] [--json]
```

Import Claude Code's own `stats-cache.json`. Use `--dry-run` to see the
counts without writing anything. `PATH` defaults to
`$HOME/.claude/stats-cache.json`. The JSON payload's `path` field is always
the redacted `~/…` display form, never the expanded real home directory.

### Errors and exit codes

Every command exits `0` on success. On failure, `--json` prints exactly one
`{"ok": false, "error": "..."}` object to stdout (never prose, never a
traceback) and exits non-zero; without `--json` the same message prints as
plain text. `hub usage record` exits `1` for a missing or unreadable scan
cache, and `2` when the cache parses cleanly but its `daily` section
produces zero rows — a signal, not a silent no-op, since that shape is
otherwise indistinguishable from a ccusage output change this ledger can no
longer read. `hub usage import-claude-stats` exits `1` for a missing,
unreadable, or unsupported-`version` stats cache.

## Transcript scan, loadout history, and footprint

This section covers two more ledgers, three new leaf modules
(`usage_classify.py`, `usage_scan.py`, `usage_loadouts.py`,
`usage_footprint.py`), and five new `hub usage …` reads. These are separate
from the day-by-day ledger above. They read Claude Code transcript files, not
a ccusage scan.

### The two ledgers

**`state/usage/sessions.jsonl`** holds one row per Claude Code session. Each
row has token counts, activity counts, skill and sub-agent use, and a short
redacted excerpt of the first human message. `hub usage scan-sessions`
builds this ledger. Nothing else writes to it. `hub sync` never reads or
writes it.

**`state/usage/loadouts.jsonl`** holds one row per change to a project's
equipped skill and MCP server list. `hub sync` appends a row here on every
run whose resolved list changed for a project. The ledger is append only. No
code path in this wave rewrites or deletes a row.

**`state/usage/inspection.sqlite3`** holds captured transcript evidence for
the inspect views. It is local machine state. Scan writes it; inspect reads it
without capturing. Tool and body reads use validated cursors and session
membership, and source generations remain available after replacement or
truncation.

Inspection bodies use two retention tiers. Request inputs stay durable up to
16 KiB; tool results, edit or write content, patches, and attachments are
tier B and can be pruned. The defaults are 90 days and 2 GiB. Configure and
run pruning with `hub usage inspect prune --older-than DAYS
--max-store-bytes BYTES [--vacuum] [--dry-run] --json`. A successful write
persists the selected values in
`state/usage/inspection-retention.json`. Pruning keeps metadata and records a
tombstone so an authorized stale body read returns `reason: "pruned"`.

The two summary ledgers travel in the hub backup, one file per machine, the same way
the day-by-day ledger does (`usage/sessions-<hostname>.jsonl` and
`usage/loadouts-<hostname>.jsonl`). A restore writes them back under the same
rule as the day-by-day ledger: only onto a machine that has none of that kind.
An existing ledger is kept.

### The scan: cursor, accumulator, and freeze rule

`hub usage scan-sessions` reads supported harness transcripts: Claude Code
under `~/.claude/projects/` and Codex rollouts under
`~/.codex/sessions/YYYY/MM/DD/`. The first scan reads every file. Every later scan
reads only the bytes appended since the last scan.

A sidecar file, `state/usage/scan-cursor.json`, tracks this. Keys are
`<harness>:<path relative to that harness root>`; an older Claude cursor with
absolute keys is migrated once when read. For each
transcript file it stores the file size, the file's last-modified time, and
a byte offset. On the next scan, a file with the same size and time is
skipped. A file that grew is read from its stored offset onward. A file that
shrank, or whose last-modified time moved backward, is treated as replaced:
the scan drops the old entry and reads the whole file again.

The cursor also stores an accumulator for each file: running counts, a set
of seen message IDs, and the event list built so far. A session's summary
row is always rebuilt from this accumulator, never patched by hand. This
lets a later scan add new records to counts and events that a plain row
cannot grow on its own.

The scanner reads a full line only. A line with no trailing newline is left
for the next scan, so a half-written line is never parsed.

A session with no new activity for 72 hours is frozen. A frozen session's
row does not change on a later scan, and the scan skips its file. If a
frozen file grows anyway, the scan does not read the new bytes, but it does
count the event in the scan payload's `frozen_appended` field, so the lost
activity is visible instead of silent.

### Inspection chunks and retry

Inspection capture keeps its own cursor and reader state in SQLite. An unchanged
source needs no transcript parsing. Appends consume complete lines after the
committed cursor. A reader change triggers one full backfill and preserves
retained evidence and pins. The summary sidecar above remains in this wave.

Use `hub usage scan-sessions --max-sources 40 --order newest --json` for a
bounded inspection chunk. The source limit spans both harnesses. Unchanged
sources do not consume that limit. `--order path` uses path order instead.
The legacy summary scan still runs on each call.

Keep the returned `inspection.scan_id` and pass it with `--scan-id` on later
chunks. Counts partition the current inventory into done, pending, and incomplete
sources. A failed source stays incomplete until an explicit
`--scan-id ID --retry-incomplete` call. Send the retry flag once; later chunks
keep its pending retry grant. Another failure requires another explicit retry.
A partial final record can resume without Retry when its file changes.
An unchanged partial record stays stopped. Unknown IDs and changed reader
bindings return JSON failures.

`--budget-seconds` defaults to 60. It interrupts a stalled source; it does not
limit the whole pass. Hosts without POSIX alarms parse each source in a
separate process. SQLite commits stay in the scan host. Healthy sources can
continue after a failure. Stopping
between chunks preserves the pass ID. Completion requires no pending sources,
incomplete sources, or unresolved errors. JSON commands keep exit status zero;
check `ok` and the inspection state.

After eligible work drains, the pass runs bounded retention once. Pinned
sessions and run subtrees remain exempt. Expired references are detached even
when another retained reference still needs the same bytes. Physical SQLite
size can stay unchanged after logical reclamation. Use `--vacuum` explicitly
for compaction. A dry run never migrates an older store: it returns
`inspection_migration_required` without changing that store.

### Privacy rules

Both ledgers hold counts, hashes, and short redacted text only.

- No absolute file path appears in any field.
- No shell command text appears in any field.
- The only free text fields are `intent_excerpt` (one per session) and
  `excerpt` (one per event). Each is at most 200 characters after redaction.

Redaction runs in this order: it collapses runs of whitespace to one space,
replaces the home directory with `~`, replaces any other absolute path with
its last path part, scans for secret-shaped tokens and pairs, and truncates
last. A token that looks like a secret (a bearer token, a `KEY=value` pair,
a long hex string) is replaced with `[redacted]`. This can over-redact a
harmless-looking token. That is by design: hiding a real secret matters more
than a clean-looking miss.

Known credential patterns are also masked inside quotes, backticks, parentheses,
and JSON values. This scan runs before truncation. Session and cursor writers
repeat the secret checks, including for frozen records. They record
`excerpt_redaction_version` without changing usage counts or cursor offsets.

To repair stored excerpts without reading transcripts, run:

```bash
hub usage repair-excerpts --json
```

The repair covers session intent, event excerpts, and cached accumulator text
for both harnesses. It parses both files before writing either file. If a file
is malformed, the repair stops without deleting records or printing their text.
Each replacement is atomic. If a write fails, rerun the command.

The result reports `fields_redacted`, `files_rewritten`, and `redaction_version`.
An immediate second repair rewrites no files. Normal scans also apply these
checks when they write the ledger and cursor.

If an excerpt blocked backup, run `hub backup now --json` after the repair.
Verify that the result reports both `committed: true` and `pushed: true`.
Keep the backup secret check enabled. Redaction does not revoke a credential.
The backup command updates its result in the sync report. A successful retry
clears the old refusal there without changing other sync results or timestamps.

### The clock seam

Every scan and every payload in this wave reads the current time through one
function, `usage_scan.now()`. When the environment variable `SKILL_HUB_NOW`
is set, `now()` returns that time instead of the real clock. This is what
makes a scan, and the payloads built from it, reproducible in a test.

### The five payloads

```
hub usage scan-sessions [--json]
```

Run the scan described above. The JSON payload reports files scanned and
skipped, bytes read, rows written, rows frozen, and any per-file error. A
bad transcript file does not stop the scan; every row already built stays
written, and the payload names the file the scan stopped on (a file name
only, never a path).

```
hub usage project <name> [--window 7|30|90] [--json]
```

The window is an inclusive UTC calendar window ending today, so `--window 7`
covers today and the six preceding UTC dates. The full usage picture for one project: its static prompt footprint, per
skill use counts over the chosen window, outcome numbers such as cache hit
ratio and steering count, and any findings (see below). Findings always look
at the last 30 days, even when `--window` asks for a different range; the
payload's `findings_window` field always says so.

Each per skill use row also carries `footprint_bytes` (the skill's own share
of the static prompt footprint, in bytes) and `harnesses` (the list of
harnesses whose prompt includes it). This is what the idle-skill and
large-share findings point to.

The outcome numbers also carry `editing_sessions` (how many sessions in the
window edited a file) and `unverified_editing_sessions` (how many of those
never ran a verification step, such as a test or a lint command). The
verification finding fires when at least one session went unverified and the
project has enough editing sessions to make that a pattern, not noise.
They also carry `tokens_per_session`, the rounded mean of top-level session
token totals in the selected window, or `null` when there are no sessions.

```
hub usage session <id> [--harness <id>] [--json]
```

One session's summary, its intent excerpt, and its event list. If a session
ID matches rows under more than one harness, the command asks for
`--harness` instead of guessing.

```
hub usage inspect-index [--json]
hub usage inspect <session-id> --harness <id> --view overview|tools|changes [--run <run-id>] [--after <call-id>] [--limit <n>] [--json]
hub usage inspect <session-id> --harness <id> --view body --body <body-id> [--after-chunk <n>] [--limit-chunks <n>] [--json]
hub usage pin add|remove <session-id> --harness <id> [--run <run-id>] [--json]
hub usage pin list [--after <cursor>] [--limit <n>] [--json]
```

These commands expose retained evidence only. A missing session returns an
explicit result. The inspection database is never included in backup.

Inspection bodies stay in the private SQLite store and are excluded from
backup snapshots. If a saved attachment is replaced, its earlier body stays
readable and is marked `retained_version`; each body also carries its source
revision. Token fields are `null` when no evidence exists. A partial scope
keeps observed values and reports `partial`. A recorded command location is
shown only when the transcript has a successful absolute `workdir`.
Pull request evidence is grouped by `(repository_id, number)`, so the same
number in two repositories remains two separate links.

Each event in the list is one step of the session: a human turn
(`human_turn`), a slash command (`slash_command`), a model-invoked skill
call (`skill`), a script call a skill's own file made (`script`), or a
sub-agent spawn (`subagent`). `name` carries the skill key or the sub-agent
type for every kind except `human_turn`, where it is always `null`. `model`
is set only on a `subagent` event, to the model that sub-agent actually
ran, and is `null` on every other kind. `invoker` says who or what started
the step: `you` for a human turn or a slash command, `model` for a
model-invoked skill call or a sub-agent spawn, and `script` for a call a
skill's own script made.

Every event carries the token counts of its own segment only, split into
`tokens.input`, `tokens.output`, `tokens.cache_creation`, and
`tokens.cache_read`. A `subagent` event's tokens are the sub-agent's own
total, not the parent segment's. Every event also carries `thinking_len` and
`output_text_len`, the character counts of the thinking text and the output
text written in that segment. These fields let a caller compute a cache-hit
ratio or a thinking share for one step, not only for the whole session.

```
hub usage footprint <name> [--json]
```

The static prompt footprint for one project: what skill text, agent-doc
text, and MCP tool descriptions would enter the prompt for each harness.
This payload is a superset of the footprint block in the `project` payload,
so a lighter caller can ask for the static composition and its text alone.

```
hub usage findings [--project <name>] [--json]
```

Findings across every project, or one project when `--project` is given. A
finding names an idle skill, a skill or file that takes up a large share of
the prompt, or an editing session with no verification step.

```
hub usage loadouts <project> --json
```

This read returns projected loadout history for one project. Each row has
`at`, `harness`, `hash`, `skill_count`, `mcp_count`, and `kind`. The first row
for a harness is `initial`; later hash changes are `changed`. The response
does not return skill names, MCP names, paths, commands, or prompts.

Every one of these five reads always exits `0`. A failed lookup, such as an
unknown project or session ID, comes back as `{"ok": false, "reason": ...}`
in the payload, never as a non-zero exit. The app calls `hub` as a
subprocess and treats a non-zero exit as a blank result, so a `--json` read
must never fail that way.

### Byte-share and text-length approximations

The static footprint counts bytes, not model tokens. Python does not run a
tokenizer. `approx_tokens` is bytes divided by four, rounded up. The footprint
payload also carries `skill_lines` and bounded `discoverable` documents with
`discoverable_bytes` and `discoverable_truncated`; these text fields are
tokenized by the frontend. The project payload's utilization rows carry
`sessions_with_skill` and Python's `idle` verdict. Every
surface that shows it must call it approximate. A finding about a large
share of the prompt is based on this byte share too.

`thinking_text_share` is also an approximation. A thinking block carries no
token count of its own, so this field is the thinking text length divided
by the total output text length. It is never added to a token count, and
every surface that shows it must call it an approximation, too.

Topics routed here: *transcript scan*, *sessions ledger*, *loadout ledger*,
*loadout history*, *scan cursor*, *cursor accumulator*, *freeze rule*,
*usage footprint*, *prompt footprint*, *usage findings*, *idle skill*,
*verification finding*, *SKILL_HUB_NOW*, *approx_tokens*,
*thinking_text_share*.
