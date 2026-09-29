# Permissions

Skill Hub manages agent permissions (tool allow/deny/ask, sandbox/approval
policies, additional directories) as a third sync stream alongside skills and
MCP servers. You maintain **one list per scope** — the hub writes each scope's
rules to that scope's native config file only.

## Save & apply

Every permissions mutation auto-syncs, like every other registry mutation:
`hub permissions set|add|remove` and `hub permissions presets apply` run the
local sync tail (`_auto_sync`, remotes skipped) after the registry write, so
the native harness files hold the new rules when the command returns. For
`permissions set` (the app's save path) stdout stays a pure JSON payload —
sync chatter goes to stderr — and the payload carries the outcome as
`sync_rc`: `null` nothing changed, `0` applied, `1` stream write errors,
`2` doctor danger findings. A non-zero `sync_rc` never fails the command;
the registry write already landed, and the UI reports the outcome inline.
Relatedly, the app's Sync flow distinguishes a doctor-danger exit (writes
succeeded, `hub sync` exits 2) from a real failure and reports "synced, with
danger findings" instead of "couldn't sync".

## Hooks moved to the hook library

Hooks are **no longer a permissions feature**. They used to live under
`permissions.hooks`; they now have their own top-level `hooks:` library, attach
lists (`hooks_global` / `projects.<n>.hooks`), and a dedicated fourth sync stream
(after this permissions stream). Both **claude-code and codex are hook-capable** —
codex is **not** "no hooks" (the old `DROPPED_HOOK` assumption is retired). The
permissions engine writes **no** hooks for any harness.

Full model, capability probing, dispatch, the `lsp-report` built-in, doctor
findings, and the `hub hook …` CLI live in **`docs/HOOKS.md`** — this page only
covers what is still permissions-specific:

- A legacy `hooks:` key under `permissions_global` / `projects.<n>.permissions` is
  **ignored** on write (migrated to the library on first load; see `docs/HOOKS.md`
  §Migration). A stray `hooks` key arriving via `hub permissions set` (e.g. a
  stale UI payload) is **silently dropped with a warning** and never written —
  `NormalizedPermissions` still parses it into the effective/diagnostic view, but
  `resolve_project_own` (the write path) emits no hooks.
- `hub permissions hooks add` / `hub permissions hooks remove` are **deprecated
  aliases** that route into the hook library (`hub hook new` + `hub hook attach` /
  `hub hook detach`) with a loud warning. See the CLI surface below.

## Scope-targeted writes (the mental model)

Permissions are **scope-targeted**, not merged-into-every-file:

- **Global rules** (`permissions_global`) are written **only** to the harness's
  **user-level** file (`~/.claude/settings.json`, `~/.codex/config.toml` +
  `~/.codex/rules/skill-hub.rules`, `~/.pi/agent/settings.json`).
- **Project rules** (`projects.<name>.permissions`) are written **only** to that
  project's native file (`<repo>/.claude/settings.json`, etc.).
- **The harness merges user-level + project-level itself at runtime.** Hub never
  copies a global rule into a project file.

This is the key correctness property: a project's native file contains *exactly*
its own rules — never a duplicated copy of the global list. (Installs that
predate this model are cleaned up by `hub permissions migrate-scope`; see below.)

## How rules apply (the effective view)

There are two permission lists per harness-feature:

- **`permissions_global`** — applies to every project that has the relevant
  harness installed (via the harness's runtime merge of the user-level file).
- **`projects.<name>.permissions`** — applies to that project only.

The **effective** set for a project is the union of the two. It is a
**display/diagnostic view only** (`hub permissions show --effective`, the UI's
inherited section, the doctor) — it is **not** what gets written to the project
file. When the same `(pattern, kind)` rule appears in both *with overlapping
harness affinity*, the **project copy wins** in the effective view: its
`harnesses:` affinity replaces global's, and the global copy is dropped from that
view. An affinity-distinct global rule (e.g. `[codex]`-scoped) is **not** shadowed
by a project rule scoped to other harnesses. The same precedence applies to hooks
keyed on `(event, matcher, command)` and to typed scalar fields (`sandbox_mode`,
`approval_policy`, `project_trust`). `additional_dirs` is set-unioned; `_unmanaged`
is **set-unioned** (a project opt-out never discards a global opt-out). `extras`
is project-shadowed-over-global.

Every resolved rule and hook carries an `origin: "global" | "project"` tag.

For **native writes**, hub uses `resolve_project_own()` (the project's own block,
tagged `origin=project`) — never the effective view.

### Worked example

`registry.yaml`:

```yaml
permissions_global:
  allow:
    - {pattern: "Bash(npm:*)", kind: allow}
    - {pattern: "Bash(git:*)", kind: allow}
projects:
  alpha:
    permissions:
      allow:
        - {pattern: "Bash(git:*)", kind: allow, harnesses: [claude-code]}
        - {pattern: "Read(./src/**)", kind: allow}
```

`hub permissions show --project alpha --effective` prints:

```
origin  kind   pattern                  applies to
global  allow  Bash(npm:*)              all
project allow  Bash(git:*)              claude-code   ← shadows the global Bash(git:*) rule
project allow  Read(./src/**)           all
```

## Registry shape

```yaml
permissions_global:
  allow: [...]
  deny: [...]
  ask: [...]
  # hooks: — LEGACY. A `hooks` key here is migrated to the top-level hook library
  #          on first load and ignored on write. Manage hooks via `hub hook …`
  #          (docs/HOOKS.md), not this block.
  sandbox_mode: workspace-write     # Codex
  approval_policy: on-failure       # Codex
  additional_dirs: []               # Claude
  extras: {}                        # forward-compat for future settings
  _unmanaged: []                    # harness ids opted out of hub management

projects:
  <name>:
    permissions: { ... same shape ... }
```

Rule shape: `{pattern, kind, harnesses?, origin?}`. `origin` is added by the
resolver — you don't write it. (The legacy hook shape
`{event, matcher, command, harnesses?, origin?}` still parses into the effective
view for back-compat but is never written; author hooks via `hub hook …`.)

## First sync: adoption flow

**Per-project (auto-import)**. If the first sync after upgrade finds rules in
`<project>/.claude/settings.json` or `<project>/.codex/config.toml` etc. AND
the registry has no managed permissions for that (project, harness) pair, the
hub:

1. Writes a pre-import backup to
   `~/.skill-hub/_hub-backups/permissions/<harness>/project-<n>/<timestamp>.<ext>`.
2. Parses the discovered rules via the adapter's `discover_existing`.
3. Persists them into `projects.<n>.permissions`.
4. Logs the import and the backup path.
5. Continues syncing.

No blocking prompt. Recovery path is `hub permissions disable --mode restore
--project <n> --apply`.

**Global (blocking)**. If `~/.claude/settings.json` or `~/.codex/config.toml`
contains rules and `permissions_global` is empty, sync emits `AdoptionRequired`
and halts the **global** stream only. Per-project streams continue. Resolve
with the unified reconcile flow (or the legacy adopt shortcuts):

```
hub permissions reconcile --global                          # preview discovered rules (merged/conflict/un-importable)
hub permissions reconcile --global --apply --decisions-stdin # apply chosen decisions (transactional + auto-syncing)
hub permissions adopt --global --action import              # legacy shortcut: take all discovered rules
hub permissions adopt --global --action skip                # mark unmanaged; hub never touches those files
```

`hub bootstrap` includes a global-scope adoption decision step.

## Reconcile: unified ingest of pre-existing native rules

`hub permissions reconcile` is the single flow for pulling pre-existing native
rules (across every installed harness) into the registry. It subsumes the older
separate *adopt* and *import* flows (`adopt`/`import` remain as thin entry points
that route into the same engine).

1. **Discovery** gathers candidates from each harness's native files and
   classifies them:
   - **merged** — the same command + decision in multiple harnesses collapses to
     one affinity-free rule;
   - **conflict** — the same command with divergent decisions; surfaced with
     per-decision options and **never auto-picked**;
   - **un-importable** — shapes the registry can't represent (Codex
     `match`/`not_match`, pattern unions); left untouched and reported.
2. **Apply is one transaction per scope**: snapshot the registry block + every
   native file the scope may touch → write the registry → write native files via
   the adapters (the same path as sync), **MOVE-excising** each imported/dropped
   rule from *every* origin file it came from (Claude/Pi `settings.json`, Codex
   `default.rules` **and** `skill-hub.rules`). On any failure after the registry
   write, the registry block and every native file are restored from the
   pre-apply snapshot — there is no half-applied state.
3. **Auto-syncing**: after a successful apply the registry and native files agree
   without a separate `hub sync`.
4. Returns `{imported, dropped, kept, conflicts_resolved, synced_files}`.

Discovery excludes rules hub already manages (per the sidecar), so an imported /
auto-synced rule never re-surfaces as a fresh candidate and a deliberately-deleted
scope is not re-prompted — reconcile is idempotent.

### Kept decisions (persisted "keep")

A **keep** decision means "this native rule is not hub's business — stop asking".
It persists to a machine-local store at
`~/.skill-hub/state/reconcile/<scope>.kept.json` as `{pattern, kind, source_file}`
fingerprints (deliberately NOT in the registry and NOT backed up: these are
decisions about this machine's native files). Kept candidates:

- are excluded from the app's *unmanaged native rules* count;
- collapse into a "previously kept (N)" group in the reconcile drawer, with an
  **un-keep** affordance (decision action `unkeep`) that lifts the fingerprint so
  the rule re-surfaces;
- re-surface automatically when the rule's **kind changes** in the native file —
  the fingerprint includes the kind, so the situation the user decided about no
  longer exists and hub re-asks.

The store is written after the apply transaction (non-transactional by design:
losing a keep only re-surfaces a candidate; it never touches registry or files).

### settings.local.json as a discovery source (project scope)

Claude Code writes every session-accepted permission ("Yes, and don't ask
again") into the project's `.claude/settings.local.json`. At project scope,
claude-family discovery reads that file **in addition to** `.claude/settings.json`
— each candidate carries its `file` so the origin is visible ("session-accepted"
in the drawer). These rules are **candidates only, never auto-imported**: the
per-project sync auto-import still reads only the shared file. Importing or
dropping such a candidate MOVE-excises it from settings.local.json inside the
same snapshot/rollback transaction as every other origin.

### Divergence summary (`permissions show --json`)

Non-effective, non-personal `show --json` payloads carry a `divergence` block
that feeds the app's Permissions screens without running a full reconcile:

```json
{
  "divergence": {
    "unmanaged_count": 3,
    "stale": true,
    "last_written_at": "2026-08-26T12:06:51Z",
    "harnesses": {"claude-code": {"unmanaged": 3, "stale": true}}
  }
}
```

- `unmanaged_count` — reconcile candidates minus kept rules;
- `stale` — the scope's current registry block, translated per harness, hashes
  differently from what the last native write recorded (`block_sha256` in the v2
  sidecar). `null` = unknown (hub never wrote this scope, or a pre-v2 sidecar);
  distinct from `false` (verified in sync). The app renders both signals as the
  divergence banner (blue, informational) with *Sync now* / *Review* actions.

## De-duplication migration (existing installs)

Installs predating scope-targeted writes may have global rules baked into project
native files. `hub permissions migrate-scope` strips them out:

```
hub permissions migrate-scope          # dry-run: preview what would be removed
hub permissions migrate-scope --apply  # back up each file, then remove the duplicates
```

For each project Claude-family native file hub manages (has a sidecar), it removes
`permissions.{allow,deny,ask}` entries whose `(pattern, kind)` is in the global
block **and** absent from the project's own block. Project-owned rules,
user-authored (non-hub-managed) rules, and entries that don't cleanly resolve are
**kept and reported**. Backups land under `_hub-backups/permissions/`. Codex is
exempt — its rules file and config knobs are scope-targeted by construction.

`hub sync` emits a non-blocking prompt to run the migration when it detects
residual global-sourced duplicates in project files.

## Doctor rollup

At the tail of every `hub sync` (unless `--skip-permissions` is passed), the
hub runs `risks.detect_risks` against every (scope, harness) it touched.
v1 risk codes:

| Code | Severity | Trigger |
|---|---|---|
| `UNBOUNDED_BASH` | danger | Allow rule matching `Bash(*)` |
| `UNBOUNDED_WRITE` | danger | Allow rule matching `Write(*)` / `Edit(*)` |
| `UNBOUNDED_FETCH` | warning | Allow rule matching `WebFetch(*)` |
| `UNSAFE_CODEX_COMBO` | danger | `approval_policy=never` + `sandbox_mode=danger-full-access` |
| `HOOK_RUNS_SUDO` | danger | Hook command invokes `sudo` (scanned over any legacy permission-block hooks here; the hook library's own `HOOK_RUNS_SUDO`/`HOOK_BROKEN_SCRIPT`/`LSP_CHECKER_MISSING` findings come from the hooks stream — see `docs/HOOKS.md`) |
| `CONTRADICTORY_RULE` | warning | The same pattern in both allow and deny (deny wins; the allow is dead) |

**Native-file conflict findings** (permissions-divergence-fixes) additionally
read each harness's ACTUAL settings content via `discover_existing` — so they
see user-authored rules, not just hub's registry view — plus the sidecar's
drift log:

| Code | Severity | Trigger |
|---|---|---|
| `DUPLICATE_NATIVE_RULES` | warning | The same pattern more than once within one kind's list in a native file (append-without-dedupe accumulation) |
| `ASK_SHADOWS_ALLOW` | warning | The same pattern in both `ask` and `allow` — Claude-family harnesses evaluate deny → ask → allow, so sessions **prompt despite the allow**. Suppressed when the registry itself declares the ask (intent matches outcome) |
| `BLANKET_ALLOW_SHADOWS` | info | A blanket allow (e.g. `Bash(*)`) beside narrower same-tool allow rules — the narrow rules are decorative. Never auto-removed: a deliberate blanket is a valid posture |
| `SIDECAR_INDEX_DRIFT` | warning | The last sync's strip found hub-managed rules at different positions than the sidecar recorded (external edit); hub removed only its own values, but the file deserves a look |

Findings are logged unconditionally. Any `severity=danger` finding causes
`hub sync` to exit non-zero even when every write succeeded. The rollup is
**shared** with the hooks stream: it runs after both streams and covers both, so
a single-stream skip still surfaces the other's findings (only
`--skip-permissions --skip-hooks` together suppresses it).

`hub permissions doctor [--json]` runs the same checks ad-hoc.

### Skill-shipped permission rules (`ships_with`)

A skill can declare a `ships_with:` frontmatter block naming companion agents,
hooks, and permission rules it wants provisioned alongside itself — full
schema in `docs/SKILL-SCHEMA.md` §`ships_with:`. Provisioning
(`hub enable <skill> --project <p> --with-companions`) writes each rule into
the project's own permissions block exactly as a hand-added rule would, then
records what it wrote in a per-project ownership ledger
(`projects.<n>.companions.<skill>`). `hub disable` reads that ledger back to
remove **only** what it wrote: a rule edited by hand after provisioning is
left in place (`kept`), never silently reverted.

`risks.detect_companion_risks` — part of the same doctor rollup above, run
once over the whole registry rather than per (scope, harness), since a
ledger entry's standing has nothing to do with which harness it targets —
compares the ledger against each project's active skills and each skill's
CURRENT `ships_with` declaration:

| Code | Severity | Trigger |
|---|---|---|
| `COMPANION_ORPHANED` | warning | A ledger entry's skill is no longer active on the project (a `--keep-companions` disable, or a companion reached only through a bundle — bundles equip skill-only and never provision), or a specific ledger item is no longer named in the skill's current `ships_with` block (an upstream edit or source sync dropped it) |
| `COMPANIONS_PENDING` | info | An active skill declares `ships_with` but has no ledger entry — equipped via a bundle, or alongside a referenced skill through `--with-refs`, so its companions were never offered for consent |

Neither finding mutates the registry or a native file — the doctor only
reports; provisioning and removal stay explicit, one-shot CLI calls.

## Per-harness capability matrix

| Feature                  | claude-code | codex | pi | opencode |
|--------------------------|:---:|:---:|:---:|:---:|
| TOOL_ALLOWLIST           | ✓ | ✓ (Bash-only) | ✓ | ✓ (Bash-only) |
| TOOL_DENYLIST            | ✓ | ✓ (Bash-only) | ✓ | ✓ (Bash-only) |
| TOOL_ASK                 | ✓ | ✓ (Bash-only) | ✓ | ✓ (Bash-only) |
| ADDITIONAL_DIRECTORIES   | ✓ | – | ✓ | – |
| SANDBOX_MODE             | – | ✓ | – | – |
| APPROVAL_POLICY          | – | ✓ | – | – |
| PROJECT_TRUST            | – | ✓ | – | – |

A rule targeting a feature the harness doesn't support is **skipped** for
that harness with a typed `SkipReason` reported in the sync log — never
silently dropped.

There is **no HOOKS row**: hooks are not a permissions feature — they moved to a
separate library + sync stream where **claude-code and codex are both
hook-capable** (see `docs/HOOKS.md` for the per-harness hook capability model).

### Codex command rules (Starlark `prefix_rule`)

Codex's `TOOL_ALLOWLIST`/`DENYLIST`/`ASK` support is **Bash-only**: hub
translates each registry `Bash(<cmd…>:*)` rule into a Codex `prefix_rule()`
entry. The capability set is a coarse yes/no, so the *per-rule* skip decision
keys off translatability (does the rule yield a bounded Bash prefix?), not mere
capability presence — a non-Bash `Read(*)` rule scoped to Codex is still
skipped even though `TOOL_ALLOWLIST` is advertised.

- **Mapping**: `allow → "allow"`, `ask → "prompt"`, `deny → "forbidden"`.
  Multi-word commands whitespace-split into the prefix list:
  `Bash(git push:*)` → `prefix_rule(pattern = ["git", "push"], decision = "allow")`.
- **Skipped**: any non-Bash tool (`Read`, `WebFetch`, `Edit`, …), unbounded
  `Bash(*)` (no derivable prefix), hooks, and `additional_dirs`.
- **File locations** (hub-owned, fully regenerated each sync, deterministic):
  - global: `~/.codex/rules/skill-hub.rules`
  - project: `<repo>/.codex/rules/skill-hub.rules`

  Codex auto-discovers every `*.rules` file in the dir, so hub never touches the
  TUI-owned `default.rules` during sync. A header comment marks the file
  hub-managed.
- **Project trust side effect (loud)**: Codex loads project-local rules only
  from a *trusted* `.codex/` layer, so writing project command rules
  **auto-grants** `[projects."<abs>"].trust_level = "trusted"` in
  `~/.codex/config.toml`. Because trust also activates any committed
  `<repo>/.codex/config.toml` and project-local hooks, hub emits a prominent
  warning in both the sync log and the doctor rollup
  (`CODEX_PROJECT_TRUST_GRANTED`) naming the project.

### opencode bash rules (`permission.bash`, last-match-wins)

opencode's `TOOL_ALLOWLIST`/`DENYLIST`/`ASK` support is **Bash-only**, like
Codex, but the target shape and evaluation order differ. Rules are written into
the single `opencode.json` (global `~/.config/opencode/opencode.json`, project
`<repo>/opencode.json`) — the same file the MCP adapter targets — under
`permission.bash` as an object mapping space-separated glob prefixes to actions.

- **Mapping**: `allow → "allow"`, `ask → "ask"`, `deny → "deny"` (1:1 — opencode's
  `ask` matches the registry `ask`, simpler than Codex's `prompt`). Multi-word
  commands whitespace-join with a trailing `*`: `Bash(git push:*)` →
  `"git push *"`.
- **Ordering matters**: opencode evaluates bash rules **last-match-wins**, so hub
  emits entries **most-specific-last** (more prefix tokens, then longer) — e.g.
  `"git *"` before `"git push *"` — so a specific rule overrides a broader one.
  Insertion order into the JSON object is preserved and is the evaluation order.
- **Skipped**: any non-Bash tool (`Read`, `WebFetch`, …), unbounded `Bash(*)`,
  `additional_dirs`, and **all hooks** (opencode has no permission-hook target) —
  each with a typed `SkipReason`.
- **Merge-preserving**: only `permission.bash.<prefix>` keys are hub-owned;
  user `permission.*` keys and the `mcp` block survive. Managed keys are tracked
  in `~/.skill-hub/state/opencode/<scope>.managed.json`; cleanup removes only
  those keys. Re-sync is byte-identical (deterministic ordering). Field shapes
  verified against `https://opencode.ai/config.json`.

### Reading + importing Codex `default.rules` (MOVE semantics)

Rules a user applies in the Codex TUI ("always allow similar commands") land in
`default.rules`. `hub permissions import` discovers them (parsing multi-line
`prefix_rule()` calls via Python's `ast`, capturing each call's source span) and
offers per-rule **import / keep / drop**:

- **import** adds the rule to the registry (regenerated into `skill-hub.rules`
  on the next sync) AND surgically **excises** the original call from
  `default.rules` — a MOVE, not a copy, so a rule later deleted in Skill Tree
  leaves no ghost still firing from `default.rules`.
- **drop** excises from the native file without adding to the registry.
- **keep** is a no-op (rule stays user-owned).

`default.rules` is backed up before the first edit and is **only** ever touched
by an explicit import/drop — never by ordinary `sync`. Codex shapes the registry
cannot represent (`match`/`not_match`, pattern unions) are flagged
**un-importable** with a reason and left user-owned. A `default.rules` that
fails to parse is skipped with a warning, never partially rewritten.

**Cross-harness merge**: when both Claude-family settings and Codex
`default.rules` carry rules, `import` reconciles them into the single registry —
same-command/same-decision collapses to one affinity-free rule;
same-command/divergent-decision surfaces as a conflict the user resolves (keep
both with `harnesses:` affinity, or pick one). Nothing is auto-picked.

## Sidecar state file

When a permission adapter writes to a user-owned config file, it also writes a
sidecar at:

```
~/.skill-hub/state/<harness>/<scope>.managed.json
```

Sidecar listing example:

```json
{
  "version": 2,
  "harness": "claude-code",
  "scope": "project-alpha",
  "file": "/abs/path/.claude/settings.json",
  "managed_keys": [
    "permissions.allow[0]",
    "permissions.allow[1]"
  ],
  "managed_values": {
    "permissions.allow[0]": "Bash(git:*)",
    "permissions.allow[1]": "Bash(npm:*)"
  },
  "block_sha256": "…",
  "drift_events": [],
  "written_at": "2026-05-22T13:00:00Z"
}
```

**Schema v2 (value-verified strips).** `managed_keys` stay bare positional
strings (every consumer keeps working), and three parallel fields harden them:

- `managed_values` maps each key to the value hub wrote there. A strip removes
  an indexed entry **only when the value at that index still matches**; on
  mismatch (an external edit reordered the list) it removes one occurrence of
  hub's value instead — preferring the last — and records a drift event. If the
  value is gone entirely (the user deleted hub's rule), nothing is removed. This
  is what makes it impossible for a stale index to silently delete a
  user-authored rule.
- `block_sha256` is the canonical hash of the translated payload at write time —
  the staleness signal for the app's divergence banner.
- `drift_events` is the last apply's strip drift log; `fallback` events surface
  as the `SIDECAR_INDEX_DRIFT` doctor finding (warning).

v1 sidecars (bare keys, no values) remain readable and strip with legacy
positional behavior; the first post-upgrade write emits v2. Older hub builds
ignore the extra fields, so a downgrade degrades to v1 semantics without
breaking.

Cleanup reads the sidecar and removes only those keys (value-verified the same
way). User-authored entries are never touched. The user's `~/.claude/settings.json` and `~/.codex/config.toml`
contain **no** hub-internal metadata — no `_hub_managed_keys` arrays, no
sentinel comments.

Codex emits two writes per `(codex, scope)` — `config.toml` and the Starlark
rules file — so it uses **two** sidecars: `<scope>.managed.json` (config.toml
keys) and `<scope>.rules.managed.json` (the `skill-hub.rules` file path). The
distinct paths prevent the second write from clobbering the first; cleanup reads
both, strips the managed config.toml keys, and deletes the hub-owned
`skill-hub.rules`. A missing rules-sidecar simply means "no hub rules file here."

## Safe-write and backup convention

Every adapter write goes through `_atomic_replace` (temp file in same dir + `fsync` + `os.replace`),
preceded by a once-per-session backup to:

```
~/.skill-hub/_hub-backups/permissions/<harness>/<scope>/<timestamp>.<ext>
```

The same backup directory is consulted by `hub permissions disable --mode restore`.

## How to disable / restore / detach

Two modes exit hub-managed permissions cleanly. Both are dry-run by default;
pass `--apply` to commit.

### `--mode restore` — "put my old configs back"

```
hub permissions disable --mode restore --project alpha
# prints the dry-run plan: which file would be replaced from which backup,
# which sidecar would be deleted, which registry block would be dropped.

hub permissions disable --mode restore --project alpha --apply
# 1. Locates the most-recent extension-matched backup under
#    ~/.skill-hub/_hub-backups/permissions/<harness>/project-alpha/.
# 2. Atomically copies it back to the project's native config file. Because the
#    backup predates hub, this also drops any hub-granted Codex trust_level.
# 3. If NO pre-hub backup exists, hub cannot revert to a prior file — instead it
#    surgically strips its managed keys in place (incl. Codex trust_level) and
#    reports `no_backup` rather than leaving registry and native files diverged.
# 4. Drops the hub-managed entries from the registry, marks the (scope,
#    harness) pair as `_unmanaged` so the next sync does not re-discover.
# 5. Deletes the sidecar at ~/.skill-hub/state/<harness>/project-alpha.managed.json.
# 6. For Codex, also deletes the hub-owned skill-hub.rules and its rules-sidecar
#    (the file is fully hub-generated, so restore = remove it).
```

### `--mode detach` — "I want to keep these but hand-edit from now on"

```
hub permissions disable --mode detach --project alpha --apply
# 1. Empties the sidecar's `managed_keys` so the next adapter cleanup will
#    not strip the rules.
# 2. Deletes the sidecar.
# 3. Drops the registry block, marks the (scope, harness) pair as `_unmanaged`.
# Result: the rules live on as ordinary user-authored entries in the native file.
```

A subsequent `hub sync` leaves the disabled (scope, harness) pair alone. Re-
adopt later with `hub permissions adopt --action import`.

Targets accept `--all`, `--global`, or `--project <name>`, narrowable by
`--harness <id>`.

## CLI surface

```
hub permissions list                                       # summary
hub permissions show --global                              # show global rules
hub permissions show --project <n> --effective             # resolved view with origin column
hub permissions add --project <n> --kind allow --pattern "Bash(npm:*)" --harnesses claude-code
hub permissions remove --global --kind deny --pattern "Bash(*)"
hub permissions hooks add ...     # DEPRECATED alias → hub hook new + hub hook attach (see docs/HOOKS.md)
hub permissions hooks remove ...  # DEPRECATED alias → hub hook detach (see docs/HOOKS.md)
hub permissions adopt --global --action import
hub permissions adopt --project <n> --action skip --harness codex
hub permissions reconcile {--global | --project <n>} [--harness <id>] [--json]            # unified discovery (merged/conflict/un-importable)
hub permissions reconcile {--global | --project <n>} --apply --decisions-stdin [--json]   # transactional + auto-syncing apply
hub permissions import {--global | --project <n>} [--harness <id>] [--json]   # legacy alias → routes into reconcile
hub permissions import --global --interactive                                 # per-rule import/keep/drop (MOVE on import/drop)
hub permissions migrate-scope [--apply] [--json]              # strip global-sourced duplicates from project native files
hub permissions doctor [--json]
hub permissions disable --mode restore --project <n> [--harness <id>] [--apply] [--json]
hub permissions disable --mode detach --all [--apply] [--json]
hub permissions adopt --global --action import [--harness <id>] [--json]
hub permissions set {--global | --project <n>} {--stdin-json | --json-file <path>}
hub permissions validate --kind {allow|deny|ask} --pattern <p> [--json]
hub permissions capabilities [--json]
```

### UI-facing JSON verbs

The native Skill Tree app consumes a small JSON-output surface on top of the
verbs above. These exist so the Tauri bridge can marshal one subprocess call
per user action and parse a typed payload — they do not change any existing
text behaviour and add no new registry schema.

- `hub permissions set {--global | --project <n>} {--stdin-json | --json-file <path>}`
  — atomic full-block replace. Reads a `NormalizedPermissions` JSON payload,
  normalises it via `NormalizedPermissions.from_block`, diffs against the
  current registry block, and writes the registry only if the normalised
  forms differ. The write runs under the data-home lock so concurrent
  invocations serialise. Idempotent: an equal payload leaves `registry.yaml`'s
  mtime unchanged. Output: `{"changed": <bool>, "normalized": <to_dict()>}`.

- `hub permissions validate --kind {allow|deny|ask} --pattern <p> --json` —
  wraps `_validate_pattern_across_adapters`. Output: `{"ok": <bool>, "error": <string|null>}`.
  Used by the Permissions editor to validate patterns inline (200 ms idle debounce
  + on blur) without a per-keystroke registry write.

- `hub permissions capabilities --json` — emits `{"<harness_id>": [<PermissionFeature.value>, ...], ...}`
  for every installed harness whose adapter exposes `capabilities()`. The UI
  caches this with a long stale time (capabilities only change with app upgrade)
  and uses it to render the three-state `HarnessAffinityChips` (applied / unsupported / excluded).

- `hub permissions disable ... --json` — emits the same dry-run / apply diff
  the text path renders, structured as
  `{"mode": "restore"|"detach", "apply": <bool>, "entries": [...]}` where each
  entry is `{scope_kind, scope_label, harness_id, target_file, backup_path,
  sidecar_path, action, will_write, applied}`. The DisableDialog in the UI
  renders the `entries` list verbatim for its dry-run preview.

- `hub permissions adopt ... --json` — emits `{"scope_kind", "harness_id" (nullable),
  "action", "imported": N, "backup_path" (nullable), "unmanaged_after": [...]}` per
  action invocation (one invocation = one object).

- `hub permissions show --global --json` is widened with an optional
  `adoption_required` field. When the global `permissions_global` block does
  not currently manage an installed harness (either the block is empty or the
  harness is in `_unmanaged`), the adapter's `discover_existing()` runs and
  any rules it finds are reported as
  `adoption_required: {"<harness_id>": [{"pattern", "kind", "source_file"}, ...]}`.
  Per-project `show --json` SHALL NOT populate this field — per-project
  discovery is auto-imported on sync and surfaced via the inline banner in the
  UI instead.

## UI surfaces (Skill Tree app)

The native app consumes these CLI verbs through a Tauri bridge
(`app/src-tauri/src/commands/permissions.rs`) — every action below maps to
a single `hub permissions <verb>` subprocess call (one exception, noted).

| UI action | Engine verb |
|---|---|
| Open Permissions tab on a project / Global Permissions view | `show --project <n> --json` / `show --global --json` |
| Edit a rule and press Save (or ⌘S) | `set --stdin-json` (payload piped over stdin) |
| Inline pattern validation (blur + 200 ms debounce) | `validate --kind <k> --pattern <p> --json` |
| Render `HarnessAffinityChips` capability states | `capabilities --json` |
| Open Permissions doctor | `doctor --json` |
| AdoptionDialog `Import / Replace / Skip` | `adopt --global --action <x> --json` |
| ImportMergeDialog discover candidates (Tauri `permissions_import_candidates`) | `import {--global\|--project <n>} --json` |
| ImportMergeDialog `Apply` decisions (Tauri `permissions_import_apply`) | `import ... --apply --decisions-stdin --json` (decisions piped over stdin) |
| DisableDialog dry-run preview | `disable ... --json` (no `--apply`) |
| DisableDialog `Confirm and apply` | `disable ... --apply --json` |

`DisableDialog`'s `All projects` target is the only composed action — the
Rust bridge loops one `--project <n>` invocation per registered project and
concatenates the returned `entries` arrays. Every other target shape is a
single engine call.

The frontend reads the build-emitted `risks.generated.json` via the
`permissions_risks_schema` Tauri command (the schema is embedded into the
binary at build time from `risks.emit_schema_json()`) and runs a pure-TS
`detectRisks` over the staged payload — no per-keystroke subprocess. The
pattern table is the single source of truth; the predicate logic is
duplicated in TS and pinned to Python by a golden-output Vitest test
(`app/src/test/permissionsRisks.test.ts`).

## Project worktree access

A project can grant its session agents access to one shared worktree parent:

```yaml
permissions:
  worktree_access:
    enabled: true
    path: /Users/example/Dev/worktrees/project
```

The path must be absolute. Hub saves it in the project's shared permissions block.
The initial suggestion is `~/Dev/worktrees/<project>`. Renaming the project does
not change a saved path. Hub does not create the directory. Create it before
starting a fresh session.

Claude Code receives the grant in `permissions.additionalDirectories` in the
project's `.claude/settings.local.json`. Codex receives project writable roots
when the selected configuration supports them. Unsupported configurations return
an explicit status. Approval, reviewer, trust and sandbox selectors stay intact.

Directory records track ownership separately from ordinary rule records. Each
native target combines its active directory requests. Disabling one request
preserves other requests and pre-existing user entries. Cleanup validates the
record's identity and native target before removing Hub-owned entries.

The grant applies to all session agents. Task briefs assign files but do not
isolate agents. A parent grant can allow writes to nested `.git`, `.codex` and
`.agents` paths that a session rooted inside one worktree can protect.

Configuration status and session verification are separate. Start a fresh session
after syncing. A successful config write does not prove that Codex Desktop loaded
the grant.

## MCP tool permissions

Open a registered MCP server and use its PERMISSIONS block to set a decision
for all tools or for one exact tool. The block reads the stored catalogue. It
does not check the live server. Search the catalogue or enter an exact tool
name when the catalogue is missing or incomplete.

From Usage, choose **Add → MCP permissions** under **Permission presets**.
The sheet saves Global permissions directly. It shows the scope before you save.
Cancel or Escape discards your selections. A failed save keeps them available
for retry. A Sync warning means the rules were saved but need attention.

From Permissions, decisions are added to the existing permissions draft. Global rules apply to
all projects. A project has Shared and Personal tiers; only the active tier is
writable. The other tiers are shown as conflict context. Add MCP permissions
opens a sheet where several decisions can be staged, then added to the parent
draft. Cancel or Escape discards the sheet draft.

Default removes an owned exact rule and does not promise a runtime decision.
Claude precedence is Deny, then Ask, then Allow. A broader inherited rule can
therefore block a narrower rule. The editor keeps such conflicts visible and
does not claim that Allow is effective. Rule affinity stays attached to an
existing decision.

The current adapters support MCP permission rules for Claude Code and Pi.
Codex and OpenCode MCP permission delivery remains unsupported; the UI shows that capability state
and does not silently broaden or remove a rule.

## Direct edits to native files

The registry is the source of truth. If you hand-edit `~/.claude/settings.json`
between syncs, your changes to a hub-managed entry will be overwritten on the
next sync (the sidecar still says the hub owns that index). Two supported
paths back into a clean state:

- `hub permissions adopt --action import` — re-ingest current native state
  into the registry.
- `hub permissions disable --mode detach --apply` — stop hub management for
  that scope; future edits stay put.
