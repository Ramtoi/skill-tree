# Runners

Two ways to spawn a chunk's sub-orchestrator. Both nest: the spawned sub-orchestrator is
still depth 2, and it spawns depth-3 units the same way regardless of which runner started
it.

| Runner | Spawn | Pick it when |
|---|---|---|
| claude-nested | the Agent tool with `subagent_type: orch-sub-orchestrator`, never `fork` | default; the chunk is UI, needs `proof-it`/`deliver-it`, or must be covered by the three hooks (Claude is the only harness where they attach at project scope) |
| codex-exec | `scripts/run-codex-chunk.sh --worktree <worktree> --report <report> --model <model> -- <prompt>` | the chunk is backend-only (Python, Rust, config), long-running, or should stay entirely out of this session's context; Claude capacity is the constraint |

## The exact `codex exec` invocation

`run-codex-chunk.sh` always execs, with stdin redirected from `/dev/null`:

```
codex exec -s <sandbox, default workspace-write> -m <model> -o <report> --json -C <worktree> -- <prompt>
```

Stdin must be `/dev/null`: `codex exec` reads stdin even when the prompt is also given as an
argument, so a live terminal or an inherited pipe left open stalls the run waiting for input
that never comes. The script checks its own stdin first — `-t 0` — and exits 2, naming the
redirect, before it would ever get to that exec.

## Session id capture and storage

The script streams the process's JSONL output to `<report>.jsonl` and extracts the first
`session_id` or `thread_id` it sees into `--session-file` (default `<report>.session`), one
line, no other content. The super reads that file to resume later; nothing else parses the
JSONL.

## Resuming

- claude-nested: `SendMessage` to the agent's id — the same channel any nested spawn uses.
- codex-exec: `codex exec resume <session-id> '<message>'`, the session id read back from
  `--session-file`.

## What each runner cannot do

- **claude-nested** dies with the session: if the parent process exits mid-chunk, the
  in-flight work is gone, though the chunk's branch and PLAN.md survive on disk and the super
  can re-spawn against the same chunk workspace.
- **codex-exec** runs a chunk **unguarded by the three hooks** (R4 — codex receives only
  globally-attached hooks in v1, gated behind a trust hash hub never writes for a codex
  chunk). Compensate with `-s workspace-write`, `-C <worktree>`, and `confine.sh` before
  integrating; never trust that `orch-scope-guard` caught a stray write in a codex chunk.
