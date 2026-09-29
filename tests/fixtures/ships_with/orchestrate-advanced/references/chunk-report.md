# Chunk report

The report a chunk's sub-orchestrator returns, verbatim, at most 12 lines:

```
chunk: <chunk-id>
status: green | red | blocked
gate: <label> exit=<n> log=<abs path>
commits: <sha> <sha> ...   (or "none")
branch: <branch> @ <head sha>
files: <n> changed, <n> added, <n> deleted
scope: ok | stray: <path>
deviations: <one line, or "none">
blocked: <one line, or "nothing">
options: 1) <one line>  2) <one line>  3) <one line>   (blocked only, else "n/a")
recommend: <option number and one line, or "n/a">
next: <what the super must know before merging this chunk>
```

A 13th line, or a missing `gate:` line, is a broken brief; `orch-report-guard` refuses the
stop for a `sub-orchestrator`-role marker (it never touches a `unit`-role one — see the hook
script contracts).

## What each status means

- **green**: the chunk's own gate passed and there is nothing left for this chunk to do.
  Integrate it (confine, merge in order).
- **red**: the chunk's own loop budget is spent, or a gate stayed red past its retry. Treat
  it as steering input exactly as `orchestrate/references/steering.md` describes for a unit
  report — do not re-run the chunk yourself; decide whether to extend budget, narrow scope,
  or escalate.
- **blocked**: the resume protocol below.

## How the super reacts

Read only the 12 lines and the trailer of the log `gate:` names. Never open the chunk's
`reports/<chunk-id>.md` (the sub-orchestrator's own PLAN.md-adjacent file) or its diff — that
would defeat the point of the 12-line contract. When `scope` names a stray file, run
`confine.sh` yourself before integrating; a stray on a lockfile, migration, or generated file
is the auto-mode pause point from `orchestrate`'s Mode table.

## The resume protocol

A sub-orchestrator runs **auto** mode. Every auto-mode pause point in `orchestrate` (a
CRITICAL grill finding it would dismiss, a spent loop budget, an irreversible step, a confine
violation on a risky file) becomes a `blocked` report with 2 or 3 numbered options and a
recommendation. It never asks a human and never guesses past the blocker.

The super decides, **except**: an irreversible step, or a CRITICAL grill finding it would
dismiss — those escalate to the user with the same options, per `orchestrate`'s Mode table.
For anything else, the super picks an option and resumes the **same** sub-orchestrator, which
still holds its context:

- claude-nested: `SendMessage` to the agent id with
  `Decision: option <n>. <one line>. Re-report.`
- codex-exec: `codex exec resume <session-id> 'Decision: option <n>. <one line>. Re-report.'`

The reply must be a fresh 12-line report. **Two resumes per chunk**; a third `blocked` ends
the chunk and the super escalates to the user.
