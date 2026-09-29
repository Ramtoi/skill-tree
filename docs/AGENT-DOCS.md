# Agent Docs

Agent Docs are project-owned instruction files. The ecosystem standard is
`AGENTS.md` (read by Codex, Copilot, Pi, opencode, …); only Claude Code reads
`CLAUDE.md`. The legacy singular `AGENT.md` is read by **no** configured
harness — it is recognized only to be classified and cleaned up, and never
satisfies a requirement.

## Canonical root policy

The real instruction file is chosen from a project's **effective harnesses**:

- **Claude-only** → `CLAUDE.md` stays the standalone real root (no `AGENTS.md`).
- **Claude + any other harness** → `AGENTS.md` is the single canonical real
  root; `CLAUDE.md` is a *derived* artifact pointing at it.
- **Non-Claude only** → `AGENTS.md` is the real root, no `CLAUDE.md`.

A derived `CLAUDE.md` is self-describing on disk — it is either a symlink to
`AGENTS.md`, or a regular file whose entire body is `@AGENTS.md`. Any other
`CLAUDE.md` (one with real prose) is treated as user-authored and is never
silently overwritten.

The policy applies **per instruction directory**, not only at the root. A
nested directory is canonical when its real file exists; a missing derived
companion in a nested directory is *not* a deviation (nested derivation is an
opt-in step of the fix plan, never demanded).

## Derivation strategy: symlink vs import

A global setting (optionally overridden per project) controls how `CLAUDE.md`
is derived. Both are fully supported:

- **`symlink`** (default) — `CLAUDE.md` is a relative symlink → `AGENTS.md`.
  Minimal git footprint; external appends (e.g. Claude Code `#` memory) land
  in `AGENTS.md` automatically.
- **`import`** — `CLAUDE.md` is a regular file whose body is `@AGENTS.md`
  (a pattern Anthropic officially supports). Commits **two real files**; the
  portable choice for repos that can't carry a symlink (e.g. Windows
  collaborators).

```bash
hub agent-docs strategy --get                      # show global strategy
hub agent-docs strategy --set import               # set global
hub agent-docs strategy --project foo --set symlink # per-project override
hub agent-docs strategy --project foo --clear       # drop override → inherit global
```

Resolution: `project override ?? global ?? symlink`. In the app, the strategy
selector lives in the Agent Docs **Manage** popover.

## The one status model

Every instruction directory gets exactly one verdict, computed from disk on
every scan (no cached link state). The same table is implemented by the app's
Rust scanner and by `agent_docs.py`, pinned against each other by the shared
fixture corpus at `tests/fixtures/agent_docs_corpus.json`.

| Verdict | Meaning | Resolution |
|---|---|---|
| `canonical` | layout matches the policy | none — renders silently |
| `claude_only` | multi-harness but only a real `CLAUDE.md` | fix: promote + derive |
| `agents_only` | root `CLAUDE.md` missing where required | fix: derive |
| `derived_drift` | derived file uses the wrong mechanism for the strategy (incl. a `core.symlinks=false` materialized link) | fix: re-derive |
| `replaced_derived` | both real, byte-identical (external tool overwrote the derived file) | fix: collapse |
| `conflict` | both real, divergent | Compare → `keep_agents` / `keep_claude`; never auto-merged |
| `pointer_plus_content` | `@AGENTS.md` pointer plus appended content (e.g. a memory append under `import`) | `absorb_appendix` — moves the appendix verbatim into `AGENTS.md` |
| `empty` | no real root where one is required | create flow |

Composable flags: `legacy` (an `AGENT.md` is present), `broken_link`,
`external_link`. External symlinks are user-managed: they satisfy the format
and the fix never touches them.

## Fix in one transaction, detect in sync

`hub sync` only **detects** (read-only; root summary + nested deviation
count). Mutation happens through the fix:

```bash
hub agent-docs fix --project foo                   # dry-run: the full plan
hub agent-docs fix --project foo --apply           # apply required steps
hub agent-docs fix --project foo --apply --nested all   # include nested promotions
hub agent-docs fix --project foo --apply --nested cli,webui
hub agent-docs migrate ...                          # alias of fix
hub agent-docs resolve --project foo --op keep_claude    # conflict resolution
hub agent-docs resolve --project foo --op absorb_appendix
```

One plan covers root promotion/derivation/collapse, opt-in nested promotions,
and legacy `AGENT.md` cleanup. Every step records a precondition fingerprint
at plan time; **apply re-verifies all of them against disk first and aborts
whole on any mismatch** ("disk changed — re-preview"), so a stale preview can
never half-apply. Backups for every mutated or removed path land under
`~/.skill-hub/_hub-backups/agent-docs/<project>/`.

Legacy cleanup rules: only `AGENT.md` **symlinks** pointing at a sibling
instruction file (or recorded in the old companion sidecar, or dead) are
removed. A real-content `AGENT.md` is never deleted or rewritten:

- If its directory has **no other instruction file**, the plan offers an
  **opt-in rename** to `AGENTS.md` (`--rename-legacy` on the CLI, a checkbox
  in the app) — backup-first, content preserved verbatim, and the directory
  becomes a canonical nested set that agents actually read.
- Otherwise (any sibling `AGENTS.md`/`CLAUDE.md` exists, even a broken link)
  the rename could clobber or manufacture a conflict, so the file is only
  flagged for manual review.

In the app, the Agent Docs view shows one quiet status line when everything is
canonical, and a single banner with one action (`Fix layout…` / `Compare…`)
when anything deviates. Tree rows carry badges only for deviations
(`LEGACY`/`CONFLICT`/`BROKEN LINK`/`EXTERNAL`). Fix apply and resolutions are
blocked while an editor buffer is dirty.

### Opt-in git commit

`--commit` (CLI, on `fix` and `resolve`) or the checkbox in the app's apply
dialogs commits the result with a prepared message
(`chore(agent-docs): canonicalize instruction layout` + the executed steps).
Strictly scoped: only the files the operation touched are staged and committed
(partial commit — unrelated dirty or staged content is never included), git
ignores are respected, nothing is ever pushed. Outside a git repo the commit
is skipped with a reason; a git failure is a warning and never rolls back the
already-applied filesystem changes. Default is always **no commit**.

### Publish root docs on save

Publish on save is a separate project setting. It is off by default. Turn it
on in the Agent Docs **Manage** popover, or use the CLI:

```bash
hub agent-docs publish-on-save --project foo --enable
hub agent-docs publish-on-save --project foo --disable
hub agent-docs publish-on-save --project foo --json
hub agent-docs publish-now --project foo
```

When it is on, a root `AGENTS.md` or `CLAUDE.md` save can create one commit on
`origin/main`. The local save always finishes first. A publish failure does not
undo it.

The publisher applies these checks:

- It fetches `origin/main` before it makes a commit.
- It checks that the saved file's Git baseline matches `origin/main`.
- It includes only root `AGENTS.md` and `CLAUDE.md`.
- It uses `origin/main` as the new commit's parent.
- It uses a normal push. It never uses a force push.

If the current checkout is exactly `origin/main`, the publisher commits there.
For a feature branch or worktree, it makes the commit in a temporary detached
worktree at `origin/main`. Feature-branch commits cannot enter the published
commit. Other dirty or staged files stay unchanged.

If an Agent Doc changed on `origin/main`, or if the push loses a race, the
publisher stops and reports that the file was saved locally. Review the remote
change, then use **Publish now** to retry.

## Canonical by construction

Creating or saving the **root** document inside the app on a multi-harness
project writes the canonical pair in one command: `AGENTS.md` gets the real
content and `CLAUDE.md` is derived per the strategy. The editor's
content-conflict check (hash fingerprint) always runs first — canonicalization
never overrides a conflict. Nested writes stay literal.

## External edits: the contract

Files created or edited outside Skill Tree can't corrupt anything — there is
no stored link state; every scan reclassifies from disk:

- Appending through a symlink-derived `CLAUDE.md` lands in `AGENTS.md` and
  just works.
- Appending to an import-pointer `CLAUDE.md` → `pointer_plus_content`, fixed
  loss-free by `absorb_appendix`.
- Replacing the derived file with identical content → `replaced_derived`
  (quiet collapse); with divergent content → `conflict` (explicit keeps).
- Deleting `AGENTS.md` → `broken_link`; the fix re-promotes from real content.
- Disk changes between fix preview and apply → the whole apply aborts;
  nothing is half-applied.
- Fixing the layout manually in a terminal → the banner simply disappears on
  the next scan.

## User-global instructions across harnesses

The docs above cover PROJECT root files (`AGENTS.md` / `CLAUDE.md` inside one
repo). Each harness also has a USER-GLOBAL instruction file — the one it
reads for every session, not just one project: `~/.claude/CLAUDE.md`,
`~/.codex/AGENTS.md`, `~/.pi/agent/AGENTS.md`,
`~/.config/opencode/AGENTS.md`.

One harness's global file can **follow** another's. Then both harnesses read
the exact same text. The link is a plain relative symlink on disk. Skill Tree
keeps no extra state for it: `hub harness doc status` always reads the real
files on disk, so the state is never stale.

### States

| state | meaning |
|---|---|
| `missing` | no file yet |
| `standalone` | a real file, and nobody follows it |
| `source` | a real file that at least one other harness follows |
| `follows` | a symlink that resolves to another harness's file |
| `broken` | a symlink whose target no longer exists |
| `external` | a symlink to something else — Skill Tree leaves it alone |

A follower always points straight at a real file, never at another symlink.
If you link a harness to one that already follows a third harness, the link
resolves through to that third harness's own file.

### The CLI

```
hub harness doc status --json                                      # every harness's state
hub harness doc link <harness> --to <source>                       # make <harness> follow <source>
hub harness doc link <harness> --to <source> --on-conflict replace # overwrite <harness>'s own file
hub harness doc link <harness> --to <source> --on-conflict merge   # add <harness>'s text to <source> first
hub harness doc unlink <harness>                                   # detach; <harness> keeps its own real copy
```

Linking a harness that already has its own real file is a CONFLICT, unless
you pass `--on-conflict`. Without it, the command exits with code 2 and
prints the conflict as JSON (`existing_bytes`, a text `preview`) so a caller
can ask the user what to do next. `replace` backs up the file, then links it.
`merge` adds the file's text to the source first (only when the source does
not already hold it), backs up the source too, then links.

A harness that other harnesses already follow (a `source` with followers)
cannot itself become a follower. Detach its followers first.

### In the app

The Harnesses screen shows the state on each card's "Global instructions"
row — `follows <X>`, `shared with N`, or `broken link`. Open the file to see
the full picture:

- A doc that follows another shows a "Follows" plaque, with a link back to
  the source's file and a Detach button.
- A broken link shows a "Broken link" plaque with a "Start a fresh file"
  button (this also detaches it).
- Every other doc shows a SHARED WITH list: one row per other installed
  harness, with a toggle to link or unlink it. Toggling a harness that
  already has its own real file opens a confirm with the same replace/merge
  choice as the CLI.

### Backup note

The backup snapshot only ever copies real files — it skips a follower's
symlink. After a restore, a follower comes back as `missing` (or as a plain
file, if a real backup of its own text exists from before it followed).
Re-link it with `hub harness doc link` once you are ready.
