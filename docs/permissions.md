# Permissions

Skill Hub manages agent permissions (tool allow/deny/ask, hooks, sandbox/approval
policies, additional directories) as a third sync stream alongside skills and
MCP servers. You maintain **one list per scope** — the hub writes each scope's
rules to that scope's native config file only.

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
  hooks:
    - {event: PreToolUse, matcher: Bash, command: "/usr/local/bin/audit-hook"}
  sandbox_mode: workspace-write     # Codex
  approval_policy: on-failure       # Codex
  additional_dirs: []               # Claude
  extras: {}                        # forward-compat for future settings
  _unmanaged: []                    # harness ids opted out of hub management

projects:
  <name>:
    permissions: { ... same shape ... }
```

Rule shape: `{pattern, kind, harnesses?, origin?}`. Hook shape:
`{event, matcher, command, harnesses?, origin?}`. `origin` is added by the
resolver — you don't write it.

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
| `HOOK_RUNS_SUDO` | danger | Hook command invokes `sudo` |

Findings are logged unconditionally. Any `severity=danger` finding causes
`hub sync` to exit non-zero even when every write succeeded.

`hub permissions doctor [--json]` runs the same checks ad-hoc.

## Per-harness capability matrix

| Feature                  | claude-code | codex | pi | opencode |
|--------------------------|:---:|:---:|:---:|:---:|
| TOOL_ALLOWLIST           | ✓ | ✓ (Bash-only) | ✓ | ✓ (Bash-only) |
| TOOL_DENYLIST            | ✓ | ✓ (Bash-only) | ✓ | ✓ (Bash-only) |
| TOOL_ASK                 | ✓ | ✓ (Bash-only) | ✓ | ✓ (Bash-only) |
| HOOKS                    | ✓ | – | ✓ | – |
| ADDITIONAL_DIRECTORIES   | ✓ | – | ✓ | – |
| SANDBOX_MODE             | – | ✓ | – | – |
| APPROVAL_POLICY          | – | ✓ | – | – |
| PROJECT_TRUST            | – | ✓ | – | – |

A rule targeting a feature the harness doesn't support is **skipped** for
that harness with a typed `SkipReason` reported in the sync log — never
silently dropped.

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
  "version": 1,
  "harness": "claude-code",
  "scope": "project-alpha",
  "file": "/abs/path/.claude/settings.json",
  "managed_keys": [
    "permissions.allow[0]",
    "permissions.allow[1]",
    "hooks.PreToolUse[0]"
  ],
  "written_at": "2026-05-22T13:00:00Z"
}
```

Cleanup reads the sidecar and removes only those keys. User-authored entries
are never touched. The user's `~/.claude/settings.json` and `~/.codex/config.toml`
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
hub permissions hooks add --global --event PreToolUse --matcher Bash --command "/usr/local/bin/audit"
hub permissions hooks remove --project <n> --event PostToolUse --matcher "" --command "..."
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

## Direct edits to native files

The registry is the source of truth. If you hand-edit `~/.claude/settings.json`
between syncs, your changes to a hub-managed entry will be overwritten on the
next sync (the sidecar still says the hub owns that index). Two supported
paths back into a clean state:

- `hub permissions adopt --action import` — re-ingest current native state
  into the registry.
- `hub permissions disable --mode detach --apply` — stop hub management for
  that scope; future edits stay put.
