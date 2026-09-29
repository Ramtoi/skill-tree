# Chunk brief

The brief the super writes for each chunk's sub-orchestrator, verbatim, before spawning it:

```
Purpose: sub-orchestrate
Chunk: <chunk-id>
Objective: <one sentence, observable outcome for this chunk alone>
Run: the `orchestrate` skill, full loop, Mode: auto, Profile: <feature|bugfix|refactor|ui>
Repo: <chunk worktree abs path>   Branch: <branch>   Base: <base branch or parent chunk branch>
Workspace: <chunk workspace abs path>  (your own; run setup.sh with slug <slug>-<chunk-id>)
Allowed files: <exact paths, dir/ prefixes, or globs; nothing else, nothing outside the repo>
Gate before reporting, exactly this command:
  gate.sh --workspace <chunk workspace> [--cwd <dir>] <label> -- <command>
Depth: you are at depth 2 of 3. Your units are depth 3 and spawn nothing.
Git: commit your waves on <branch>. Never push. Never merge. Never touch another branch.
Blocked: never ask a human. Write a blocked chunk report with numbered options and stop.
Report to: <super workspace>/reports/chunks/<chunk-id>.md
Return: your final message is the chunk report below, verbatim, at most 12 lines, nothing else.
```

## One line per field

- **Chunk**: the id used everywhere — the branch suffix, the PLAN.md Chunks row, the report
  filename, and the marker's `chunk` field.
- **Objective**: an outcome you (the super) can verify without reading the diff — a gate
  passing, a file existing, a behavior described in the report.
- **Run**: always `orchestrate`, full loop. A chunk that would only need the light lane is
  below the chunking rule's own-lane bar and should not have been cut out as a chunk.
- **Repo / Branch / Base**: the sub-orchestrator's whole world. It never touches another
  branch or worktree.
- **Workspace**: its own `orchestrate` workspace — PLAN.md, `plans/`, `reports/`, `evidence/`
  all live here, separate from the super's.
- **Allowed files**: copied into the marker's `allowed` array **unchanged** — the brief and
  the hook read the same list, so they can never disagree about what this chunk may touch.
- **Gate**: the chunk's own gate from the chunking rule's own-gate test, run through the
  same `gate.sh` `orchestrate` already uses.
- **Depth**: stated so the sub-orchestrator knows it may spawn units but not another
  sub-orchestrator; the cap is structural (see SKILL.md), this line is just visibility.
- **Git**: no push, no merge — the super integrates after the chunk's own gate is green.
- **Blocked**: the resume protocol lives in `references/chunk-report.md`.
- **Report to / Return**: the 12-line contract; see `references/chunk-report.md` for the
  exact template and what each field means.
