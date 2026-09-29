# The super's PLAN.md additions

`orchestrate-advanced` writes the same PLAN.md `orchestrate` does, plus one table under
Gates:

## Chunks table

| id | objective | branch | base | runner | merge order | status |
|---|---|---|---|---|---|---|
| py-leaf | ... | feat/\<slug\>-py-leaf | main | claude-nested | 1 | green |
| rust-cmd | ... | feat/\<slug\>-rust-cmd | main | codex-exec | 2 | in_progress |

- **id** matches the chunk brief's `Chunk:` field, the marker's `chunk`, and the report
  filename.
- **base** names the run's base branch, or a parent chunk's branch when this chunk depends
  on it (`references/chunking.md`, Recording a dependency).
- **merge order** is the sequence the super integrates in; a dependent chunk's number is
  always higher than its parent's.
- **status** uses the same vocabulary as `orchestrate`'s Gates table: pending, in_progress,
  green, red(n), blocked, deferred.

## A chunk's own PLAN.md is its state

The Chunks table holds only the 12-line summary of each chunk's latest report — never its
full state. Each chunk's own `orchestrate` run keeps its own PLAN.md, `plans/`, `reports/`,
and `evidence/` inside its own workspace; that file is the one place a resumed
sub-orchestrator or a fresh spawn against the same workspace goes to reconcile. The super
never edits a chunk's PLAN.md.

## The per-chunk resume counter

Track resumes per chunk next to its Chunks-table row (a `resumes: <n>` note, or a Decisions
log line each time). Two resumes are allowed before a third `blocked` ends the chunk and
escalates to the user (`references/chunk-report.md`, The resume protocol). Reset the counter
only if the chunk is abandoned and re-spawned as a fresh chunk with a new id — resuming the
same sub-orchestrator keeps counting against the same chunk.
