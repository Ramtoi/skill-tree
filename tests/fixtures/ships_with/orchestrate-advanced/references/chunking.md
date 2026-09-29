# The chunking rule

A chunk qualifies only when all three hold.

**Disjoint files.** No file shared with another chunk. One owner per lockfile, migration, or
generated file. An overlap between two candidate chunks is not a chunk boundary — it is a
wave inside one chunk.

**Own gate.** One command that runs alone and goes green without any other chunk being
merged. If a chunk's gate needs another chunk's code on disk first, it is not independent;
fold it into that chunk or make it a dependent chunk (see Dependencies below).

**Own lane.** On its own, the chunk clears at least `orchestrate`'s light lane: 4 or more
named files, or one design choice with two real options. A chunk with 3 or fewer trivial
files is not worth a branch, a worktree, and a sub-orchestrator spawn.

You need **three or more** qualifying chunks. Two, or any chunk below the light lane, means
plain `orchestrate` with waves — the coordination overhead of a chunk (branch, worktree,
marker, spawn, resume protocol) only pays for itself past that count.

## A worked good cut — by layer

A feature touching a Python leaf module, a Rust command, and a React screen cuts cleanly by
layer: `py-leaf` (the leaf module + its tests), `rust-cmd` (the Tauri command + its Rust
tests), `react-screen` (the screen + its component tests). Each has its own gate
(`pytest`, `cargo test`, `npm run test`), no file in common, and each alone clears the light
lane. Three chunks, all independent — no dependency edges needed.

## A worked bad cut — by file type across one feature

Cutting the same feature into "all the `.py` files," "all the `.rs` files," "all the `.tsx`
files" looks similar but fails the own-gate test: the Rust command calls into the Python CLI
contract, so `cargo test` cannot go green until the Python chunk lands. That is one chunk
with three waves, not three chunks.

## Recording a dependency between chunks

When a chunk's own gate genuinely needs another chunk's code already on disk (not merely
"designed" but "buildable"), record it as a dependency in PLAN.md's Chunks table (`base`
column names the parent chunk's branch instead of the run's base branch). The dependent
chunk's worktree branches off the parent chunk's branch, and merge order follows that chain
(`deliver-it`: stacked PRs, retarget each base to main after the one below merges). A chunk
with a dependency still needs its own gate — the dependency changes what it builds on, not
whether it has an independent gate.

## What to say when the rule fails

"The chunking rule does not hold: `<reason — an overlap on <path>, a chunk below the light
lane, or only two qualifying chunks>`. Falling back to plain `orchestrate` with waves."
