# Hooks

Skill Hub manages agent **hooks** — commands the harness runs on lifecycle events
(a file edit, a prompt submit, a session start) — as a dedicated fourth sync
stream alongside skills, MCP servers, and permissions. Hooks live in their own
top-level library and are *attached* at a scope; sync writes them into each
harness's native hook config.

Hooks are **separate from permissions**. They used to live under
`permissions.hooks`; that path is gone (see `docs/permissions.md` §Hooks moved to
the hook library and the Migration section below).

## The model

There are three moving parts, mirroring `harnesses_global` / skills:

- **The library** (`hooks:`) — named hook *definitions*, keyed by name.
- **Attach lists** — `hooks_global` (machine-wide) and `projects.<n>.hooks`
  (per-project, additive). A definition does nothing until it is attached.
- **`hook_settings`** — optional per-project settings overrides, deep-merged over
  a definition's base `settings`.

```yaml
hooks:                             # top-level: the hook library (user definitions)
  my-hook:
    description: "..."
    event: PostToolUse             # canonical Claude event vocabulary
    tools: [Edit, Write]           # canonical tool names; [] = all tools (matcher "")
    matcher: ""                    # optional raw regex escape hatch; WINS over tools
    command: "..."                 # a hook is EITHER a command…
    script:                        # …OR a script (never both — see Hook scripts)
      source: managed              # managed | repo
      path: scripts/lint.sh        # repo only: relative to the project root
      interpreter: bash            # bash | python3
      args: "--fix"                # optional, appended verbatim
    timeout: 60                    # optional seconds
    harnesses: [claude-code]       # optional affinity narrowing (same semantics as skills)
    settings: {}                   # free-form, consumed by the hook's own script

hooks_global: [lsp-report]         # attached everywhere (like harnesses_global)

projects:
  <n>:
    hooks: [my-hook]               # additive per-project attach
    hook_settings:                 # optional per-project settings override (deep-merged)
      lsp-report: {languages: {typescript: {enabled: true}}}
```

The attached set for a project is `hooks_global ∪ project.hooks` (order preserved,
deduped) — `hooks_model.resolve_project_hooks`. `resolve_global_hooks` resolves
just `hooks_global`. Each attached name is resolved to a definition, its settings
merged for that scope, and yielded as a `ResolvedHook`. Harness-affinity and
capability filtering happen later at adapter time — a `ResolvedHook` carries its
`harnesses` through unfiltered.

`hooks_model.py` owns two shapes:

- **`HookDefinition`** — one definition (`name`, `event`, `command`,
  `description`, `tools`, `matcher`, `timeout`, `harnesses`, `settings`,
  `provenance`, `script`). `to_block()`/`from_block()` round-trip through the
  registry; `from_block` is tolerant (coerces scalars, falls back to safe empties
  for malformed collection fields). `script:` is emitted **only when present**, so
  a registry written before hook scripts existed re-saves byte-identically.
- **`HookScript`** — where a script lives (`source`, `interpreter`, `path`,
  `args`) — see [Hook scripts](#hook-scripts-managed-vs-repo).
- **`ResolvedHook`** — a definition attached at a scope with its `settings`
  already merged.

An orphaned `hook_settings` key (settings for a name not attached to that
project) is warned and pruned from the resolved view — the registry is **not**
rewritten.

### Built-ins vs user hooks (provenance)

Every definition has a `provenance` of `user` or `builtin`:

- **`user`** — stored in the registry's `hooks:` map. Fully editable.
- **`builtin`** — shipped on disk at `code_home()/hooks/<name>/hook.yaml` (+ its
  script), resolved by name at runtime. Built-ins are **never** written into
  `registry.yaml` (mirrors starter-skills / code-home philosophy — upgrades apply
  automatically). The directory name is authoritative; a `name:` key inside
  `hook.yaml` is ignored.

A built-in's **command, event, and script body are read-only** — `hub hook edit`
and `hub hook script show`/`save` refuse it (both by `provenance`, not by name)
and point you at `hub hook set-settings`. A built-in's body lives in the code
home, which hub treats as read-only; it is not a hub-managed script. Its
**settings remain editable**, but only per-project (its global/base settings are
read-only on-disk defaults; there is no global override tier in v1).

**Shadow-by-registry-name:** if a registry `hooks:` entry has the *same name* as
a built-in, the registry definition **shadows** the built-in (used in full —
including its `command`, which sync-time materialization such as the `lsp-report`
bake leaves untouched because that keys off `provenance == "builtin"`, not the
name) and a warning is emitted
(`hooks_model.resolve_definition` / `all_definitions`). A
dangling attached name (neither a registry definition nor a built-in) is warned
and omitted — it never reaches an adapter.

## Hook scripts (managed vs repo)

A hook is **either** a shell `command` **or** a `script` — never both. A script
has a *location*, and the location is the whole decision:

| | **managed** | **repo** |
|---|---|---|
| Body lives at | `<data_home>/hooks/<name>/script.<sh\|py>` (hub-owned) | `<project>/<path>` (yours, committed with the repo) |
| Edited in | Skill Tree (`hub hook script save`, the app editor) | your editor, per project |
| Baked as | an ABSOLUTE, shell-quoted path | the relative path, verbatim |
| Good for | a project-agnostic hook that must behave the same everywhere | a hook that IS part of one codebase |

`interpreter` is `bash` or `python3`. `python3` resolves through the same
precedence as the built-in `lsp-report` bake (`SKILL_TREE_PYTHON` → the packaged
app's bundled runtime → PATH), so a hook still runs on a machine with no system
python; `bash` is taken from PATH at run time. `args` is appended to the baked
command line **verbatim** — it is not quoted, so it reads exactly as typed
(`--fix --paths "a b"`).

Validation (`hooks_model`): `source ∈ {managed, repo}`, `interpreter ∈
{bash, python3}`, a repo script REQUIRES a `path` that is relative, POSIX, and
free of `..` segments (an absolute, `~`-anchored, backslash-separated or
traversing path is refused), and a managed script FORBIDS `path`. A registry that
somehow carries an invalid `script:` is warned + the script is ignored (the hook
falls back to its `command`); one carrying **both** `command` and `script` is
warned + the `command` wins. `hub hook new`/`edit` refuse to CREATE either state.

**Sync-time baking** (`hook_scripts.bake_script_hooks`) runs once per scope in the
hooks stream, right after the `lsp-report` bake and before any adapter sees the
resolved hooks. It rewrites `command` in place:

- managed → `<interpreter> '<abs body path>'[ <args>]`
- repo → `<interpreter> '<relative path>'[ <args>]` (harnesses run hook commands
  from the project root — the same assumption `lsp-report` relies on)

Both the interpreter and the path are shell-quoted, because a packaged
`code_home()` and a user's project path can contain spaces. Baking is
deterministic, so an unchanged hook re-syncs byte-identically. It **never**
touches a built-in (a built-in materializes itself) nor a command hook — and it
keys off `provenance`, so a *user* definition that shadows `lsp-report` by name
is baked as the script it is.

A managed body that is **missing at sync time** is dropped from that scope with a
warning rather than written as a command that cannot run; the doctor explains it
(`HOOK_SCRIPT_MISSING`). A repo script is baked unconditionally — its per-project
presence is a doctor concern, not a write gate.

**Lifecycle.** The managed dir is created on `hook new`/`edit` into managed mode
(seeded with a 2-line stub unless `--script-body-file` is passed), carried across
an interpreter change (`script.sh` → `script.py` keeps the body), and **deleted**
on `hook delete` or on an `edit` that switches away from managed — always AFTER
the registry write succeeds, so a rejected edit never eats a body.

**Confinement.** `hook_scripts.managed_script_dir` is the single place a hook NAME
becomes a path, and it re-validates the slug (`[a-z0-9-]+`) there — the registry is
a plain YAML file, so a hand edit or a restored backup can carry a name like
`../victim` that would otherwise escape `<data_home>/hooks/` (including into the
`shutil.rmtree` behind `hook delete`). Write paths (ensure/write/rename,
`hook script save`, an `edit` touching a managed body) **fail closed** with a clean
CLI error; the delete path and the sync-time bake **warn and stand down** — the
registry entry is still removable, the hook is just dropped from the scope.

A plain `command` hook can also name a script the user cannot see from Skill
Tree — `hub hook show --json` detects it (`command_script`) so the editor can
show it read-only, and when the command is really `<interpreter> <relative
path> [args]` offers to convert it into a modelled repo script
(`repo_script_conversion`) so it gets the per-project existence check, the
`HOOK_SCRIPT_MISSING` doctor finding, and a shell-quoted bake.

## Capability probing

Hook mechanisms differ wildly per harness, so before writing anything sync runs a
cheap per-harness probe (`harness_probe.py`). Each **installed** harness gets one
timeout-bounded probe (5 s) and a verdict:

| Verdict | Meaning |
|---|---|
| `supported` | Hook writes take effect on this harness. |
| `feature_off` | Installed & capable, but the hook feature is explicitly disabled (e.g. codex `[features] hooks = false`). **Not** an uninstall — written entries are kept in place (D4: "feature-off ≠ uninstall"). |
| `unsupported` | The harness fundamentally does not accept hub-managed hook writes in v1 (opencode plugins, pi shim). |
| `not_installed` | The harness is not installed (no subprocess spawned). |

Per-harness rules:

- **claude-code** — installed ⇒ `supported`.
- **codex** — hooks is a **stable, default-on** feature. The probe prefers
  `codex features list` over version heuristics: an absent `[features].hooks` key
  means enabled; `feature_off` only on an explicit `false` (either
  `~/.codex/config.toml` `[features] hooks = false` or the CLI reporting false).
  A flaky probe (timeout / nonzero exit) fails **safe** to `supported` (never
  bricks writes), recording `extra.probe_failed`.
- **opencode** — hook writes are always `unsupported`; the probe additionally
  reports opencode's `lsp` runtime state (`extra.lsp_state`, off by default) for
  the UI badge.
- **pi** — `unsupported` in v1; the probe checks for a community-shim marker
  (`extra.shim`) for the badge only.

Results are cached at `<data_home>/state/harness-capabilities.json`
(`schema_version`, `probed_at`, per-harness verdict + reason), refreshed once at
the start of every hooks sync. The UI/Tauri render path reads the cache only
(`harness_probe.load_cached`) — it **never** probes on render.

### Per-event gating

A hook's `event` is written only to harnesses that understand it (an adapter
never writes dead config). `tool_catalog.py` pins the canonical event vocabulary
against the installed binaries (not docs):

- `tool_catalog.CANONICAL_EVENTS` pins **14** binary-verified canonical events
  (Claude Code 2.1.210): `PreToolUse`, `PostToolUse`, `PostToolUseFailure`,
  `PermissionRequest`, `UserPromptSubmit`, `SessionStart`, `SessionEnd`, `Stop`,
  `SubagentStart`, `SubagentStop`, `Notification`, `PreCompact`, `PostCompact`,
  `FileChanged`. claude-code supports all 14. (The wider "~31 events" figure is
  doc-sourced and not enumerable from the binary, so the catalog pins exactly the
  verified anchor set.)
- **codex supports exactly 10** of them (pinned from the binary's snake_case
  hook-event enum): `PreToolUse`, `PermissionRequest`, `PostToolUse`,
  `PreCompact`, `PostCompact`, `SessionStart`, `UserPromptSubmit`,
  `SubagentStart`, `SubagentStop`, `Stop`. Codex has **no** `SessionEnd`,
  `Notification`, `PostToolUseFailure`, or `FileChanged`.
- opencode / pi / any unknown id support no hook events in v1 (no adapter), so
  per-event gating skips them wholesale.

`event_supported(event, harness_id)` / `harness_events(harness_id)` drive the
gating and the UI's reach display.

### Per-harness tool/matcher translation

A definition stores **canonical** tool names (Claude's vocabulary is canonical);
each adapter translates them to its harness's native matcher at write time
(`tool_catalog.translate_tools`):

- `[]` (empty tools) → `""`, the empty matcher meaning **all tools**.
- A raw `matcher:` on the definition **bypasses** translation and is used verbatim
  on every harness (power-user escape hatch).
- Codex's single edit tool is `apply_patch`, so the whole Claude edit family
  collapses onto it: `Edit | Write | MultiEdit` → `apply_patch`. Codex's
  hook-matchable tools are the edit family plus `Bash`; a canonical tool that
  does not exist on codex (e.g. a Claude-only `Read`) is **dropped**.
- `mcp__<server>` tokens (derived from registry mcp-servers) pass through on
  every hook-capable harness.
- If **every** tool drops for a harness, `translate_tools` returns `None` and the
  write is **skipped** (translating an all-unsupported list to `""` would wrongly
  match every tool).

## Dispatch (the hooks sync stream)

`_run_hooks_stream` (`hooks_stream.py`) runs **after** the permissions stream (so the two
writers never interleave on a shared settings file) and **before** the shared
doctor rollup. Bypass it with `hub sync --skip-hooks`.

The stream: refreshes the capability cache once (`probe_and_cache`) → runs a
one-time legacy permissions→hooks sidecar handover
(`migrate_permissions_hook_sidecars`, robust under `--skip-permissions`) →
resolves + writes global hooks, then per-project hooks → runs a cleanup pass over
**every** known hook-capable harness (so a harness that *was* attached but is now
uninstalled has its native entries stripped). It returns non-zero only when an
adapter errored.

Writes go through `hook_adapters.py`, which mirrors the permissions-adapter house
style (atomic `_atomic_replace`, backup-first, merge-preserving) but targets a
**disjoint namespace** tracked by a **`kind="hooks"` sidecar** — so a hook write
never clobbers a `permissions.*` managed key in a shared `settings.json`. Backups
land at `~/.skill-hub/_hub-backups/hooks/<harness>/<scope>/<timestamp>.<ext>`,
once per (harness, scope, file) per process, **only when the write changes the
file**.

### Scope → file mapping

| Harness | Global attach | Project attach |
|---|---|---|
| claude-code | `~/.claude/settings.json` | `<repo>/.claude/settings.local.json` |
| codex | `~/.codex/config.toml` | **skipped in v1** (reason surfaced) |
| pi, opencode | — (no adapter; `unsupported`) | — |

- Claude-family project hooks land in the **personal, uncommitted**
  `settings.local.json`, **never** the committed `settings.json` — hook commands
  are code execution with machine-absolute paths that must not be pushed to
  teammates. (Global hooks are inherently machine-local already.)
- The Claude adapter writes the real nested schema:
  `{"<Event>": [{"matcher": …, "hooks": [{"type": "command", "command": …,
  "timeout"?: n}]}]}`. Managed keys are `hooks.<Event>[<i>]#<fingerprint>`, where
  the fingerprint is a short sha256 of `event + matcher + command`. **Ownership
  is identity-based, not positional:** the user edits the same list, so a
  prepend/deletion shifts hub's entry off its recorded index. Before removing a
  prior entry hub verifies the fingerprint, searches the list when it moved, and
  removes **nothing** when its entry is gone — a user hook that slid into hub's
  old slot is never deleted, and a hub hook is never duplicated. Bare
  `hooks.<Event>[<i>]` keys from an older install still reconcile by index
  (bounds-checked) and are rewritten with a fingerprint on the next sync.
  An unparseable settings file **aborts** the write (file untouched, reported).
- Codex in v1 receives **only globally-attached** hooks, into
  `~/.codex/config.toml` `[[hooks.<Event>]]` array-of-tables (each with a nested
  `[[hooks.<Event>.hooks]]` carrying `type = "command"`, `command` (always a
  string, never an array), optional `timeout`). Project-attached codex hooks are
  skipped with a surfaced reason. An unparseable `config.toml` **aborts** codex's
  write (file untouched, logged).

**Byte-stable re-sync:** the adapter's `apply` is a reconciler — it strips every
prior sidecar-owned entry, then re-emits the currently-resolved hooks in one
atomic write. A sync with no registry change is a byte-identical no-op (nothing is
written, no backup taken). `apply` only writes when the bytes actually change and
never creates an empty file.

### Claude Code trust — one-time, not per-hook

Claude Code does **not** re-prompt on every hook change: a file watcher picks up
`settings.json` hook edits, and a byte-identical rewrite is inert. The only
trust prompt is Claude's own **one-time project trust prompt** shown when you
enter a repo that carries `.claude` settings for the first time. Hub writing or
updating hooks does not trigger a fresh prompt.

### Codex trust posture (hub never grants trust)

Codex gates hook execution behind a per-hook trust hash. **Hub never writes**
`[hooks.state]` — not `trusted_hash`, not `enabled`. Trust is granted through
Codex's own flow. Hub writes only the hook tables and reads `[hooks.state]`
**read-only** (`hook_adapters.read_hook_trust_state`) so the doctor/UI can surface
an "awaiting trust in Codex" state for a hub-written hook Codex has not yet
trusted. (The `CodexHookAdapter` merge-preserves `[hooks.state]` and every other
unrelated table.)

## The built-in `lsp-report` hook

`lsp-report` ships at `code_home()/hooks/lsp-report/` (`hook.yaml` +
`lsp_report.py`, stdlib-only so it runs under any interpreter). It runs **one-shot
per-language diagnostics after a file edit** — a `PostToolUse` hook matching
`Edit`, `Write`, `MultiEdit` (→ `apply_patch` on codex). The same stdin/stdout
contract works on both claude-code and codex.

### Per-language settings

`settings.languages.<lang>` carries `{enabled, mode, timeout}`. Shipped defaults:

| Language | Enabled | Mode | Timeout | Checker(s) |
|---|:---:|---|---|---|
| python | ✓ | advisory | 30s | `ruff check` (+ `pyright` if present) |
| go | ✓ | advisory | 30s | `gopls check` (experimental) |
| typescript | – | advisory | 30s | `tsc --noEmit` (project-scoped) |
| rust | – | advisory | 30s | `cargo check --message-format=json` (project-scoped) |

typescript and rust default **off** because their checkers are project-wide and
latency-prone. Flip a language per project via `hook_settings`. On/off for the
whole hook is attach/detach (`hooks_global` / `project.hooks` membership).

### Advisory vs blocking delivery

The mode keys are `advisory` / `blocking`. UI copy labels them **report**
(advisory) and **interrupt — agent must address** (blocking). Blocking **never**
claims to prevent the edit: this is a `PostToolUse` hook, so the edit already
happened.

- **advisory** (default everywhere) → exit 0 + a JSON
  `hookSpecificOutput.additionalContext` report.
- **blocking** (any blocking-mode language with findings) → exit 2 + the report
  on stderr, phrased as an interrupt the agent must address — explicitly stating
  the edit was already applied and is not undone.
- **clean** → exit 0, no output.

The aggregated report is capped at ~4KB (truncation is stated in the text);
timeouts are reported honestly (never claimed as a clean result).

### Runtime behavior

- **Command baking (sync time):** `lsp_report_sync.py` rewrites the resolved
  hook's `command` per scope, baking the resolved absolute Python interpreter
  (`SKILL_TREE_PYTHON` → bundled `.app` runtime → system `python3`, mirroring the
  Rust `detect_python()`) plus `--config <data_home>/state/hooks/lsp-report.<scope>.json`.
  The per-scope config is serialized from the hook's merged settings. Because the
  rewrite runs fresh every sync it is naturally idempotent (unchanged interpreter
  ⇒ identical command string ⇒ byte-stable re-sync).
- **Edited-file resolution:** per-harness — claude Edit/Write/MultiEdit
  `tool_input.file_path`; codex parses the `apply_patch` envelope from
  `tool_input.command` (`*** Begin Patch` / `*** Update|Add|Delete File:` lines),
  with `git status --porcelain` as the fallback. Files are filtered to those under
  `cwd`; vendored/generated dirs (`node_modules`, `target`, `dist`, `.git`) are
  dropped.
- **`gopls check` is officially experimental/unsupported:** go checker failures
  (timeout, missing binary, nonzero exit) are **silent no-ops** — go never blocks
  or errors. Only a clean run with output is surfaced as advisory diagnostics.
- **Single-flight locking:** the script holds a single-flight lock keyed by
  `(project, language)` — a concurrent invocation for the same key **skips** and
  notes the skip in the report (never double-runs a checker).
- **Missing checker:** a checker binary absent from PATH is a **silent runtime
  no-op**; sync surfaces it as an `LSP_CHECKER_MISSING` doctor finding (info).

## Doctor findings

The shared doctor rollup (`_run_doctor_rollup`) runs after **both** the
permissions and hooks streams and covers **both** — a single-stream skip still
surfaces the other stream's findings; only `--skip-permissions --skip-hooks`
together suppresses the rollup. Hook-library findings come from
`risks.detect_hook_risks`, evaluated per (scope, harness) for hooks that actually
reach that harness (verdict `supported` / `feature_off`; a `not_installed` /
`unsupported` harness gets no write, so no findings):

| Code | Severity | Trigger |
|---|---|---|
| `HOOK_RUNS_SUDO` | danger | Hook command invokes `sudo` — hub-managed hooks must not require elevation. |
| `HOOK_BROKEN_SCRIPT` | warning | The command references a script path that does not exist on disk — the hook will fail to run. (Script-backed hooks are exempt: `HOOK_SCRIPT_MISSING` owns them.) |
| `LSP_CHECKER_MISSING` | info | An `lsp-report` language is enabled but its checker binary is not on PATH — that language is a silent runtime no-op. |

One more finding comes from `risks.detect_hook_script_risks`, which runs **once
over the registry** rather than per (scope, harness) — a script's existence has
nothing to do with which harness runs it:

| Code | Severity | Trigger |
|---|---|---|
| `HOOK_SCRIPT_MISSING` | warning | A managed body is gone from the data home, or a repo script is absent in ≥1 attached project (global attach ⇒ every registered project). One finding per hook, listing the projects. |

Any `severity=danger` finding causes `hub sync` to exit non-zero even when every
write succeeded. (The retired `DROPPED_HOOK` "Codex has no hooks" finding is
**gone** — codex is hook-capable and hooks are no longer authored from the
permissions block.)

`hub hook doctor [--json]` runs the same two legs on demand, READ-ONLY, without
a full sync: it mirrors `_run_hooks_stream`'s targets (global → every installed
harness, per project → its effective harnesses, skipping any project
`project_sync_skip_reason` quarantines the same way the real sync stream
does), bakes each hook's `command` for attribution purposes only (never
`materialize_lsp_report` / `bake_script_hooks` — nothing under `state/hooks/`
is ever written by a read), and calls `detect_hook_risks`/
`detect_hook_script_risks` **once per hook** so every finding carries a `hook`
field by construction rather than by parsing `detail`. The script leg only
scans hooks that are actually attached somewhere (`hooks_global` or a
project's `hooks`) — an unattached definition never runs, so a missing or
broken body raises no finding. A hook attached at the global scope resolves
into every installed harness *and* every project, so the raw scan would
otherwise repeat the same risk several times over; findings are **deduped
across scopes** on `(hook, code, detail)`, keeping the first occurrence's
`scope`/`harness`, and `danger_count` is the count AFTER dedupe. `--json`
output is `{findings: [{hook, scope, harness, code, severity, explanation,
detail}], danger_count}`, sorted danger→warning→info then by hook name.
**`--json` mode always exits 0** (the Rust bridge treats any non-zero exit as a
failed read before it parses stdout); text mode mirrors `hub permissions doctor`
and exits 2 when `danger_count > 0`.

### Skill-shipped hooks (`ships_with`)

A skill's `ships_with:` frontmatter block (`docs/SKILL-SCHEMA.md` §`ships_with:`)
can declare hooks it wants attached wherever the skill is equipped, alongside
companion agents and permission rules (full provisioning model:
`docs/permissions.md` §Skill-shipped permission rules). Once provisioned, a
shipped hook is an ordinary hook — it lives in the hook library, attaches at
the project scope, and is subject to every finding above
(`HOOK_RUNS_SUDO`, `HOOK_BROKEN_SCRIPT`, `HOOK_SCRIPT_MISSING`, …) exactly
like a hand-authored one. What is new is the **ownership record** —
`projects.<n>.companions.<skill>.hooks` — a per-project ledger `hub disable`
reads to remove only what it provisioned. Every `hub skill companions <skill>`
read — project-less or with `--project` alike — checks EVERY companions
ledger (every project's plus `companions_global`) and reports the scopes it
finds under a top-level `provisioned_on` list; the list is never narrowed to
the one project named on the command line, so "provisioned on `notes-vault`"
reads true even when you ask about the skill from a different project, or
from outside any project at all.

A hook entry in the block is either inline (the shape above) or a **reference**
— `{ref: <name>}` — naming a definition that already lives in the hooks
library (built-in or user). A referenced hook attaches as-is and is never
copied; the library owns its definition, so a later edit to that library
entry needs no re-provisioning. `hub sync` reconciles the declaration against
the ledger on every run, per (project, skill) and for `scope: global` skills:
an item the skill still declares but the ledger has not recorded yet is
**pending** (never written by sync — provisioning stays an explicit,
consented act); an item the ledger has but the declaration dropped is
**stale** and is de-provisioned, but only when hub's own ledger flags say hub
attached it in the first place, so a rule or hook a person added by hand next
to a shipped one is left alone; a changed inline hook definition is
re-attached in place; a companion agent whose source changed is re-rendered
when every written copy still matches what was recorded, and reported —
never overwritten — when one does not.

A shipped hook whose `command` names a script inside the skill directory
needs the execute bit, or the harness cannot run it. The confinement is on
the FILE, not the command string: a file under `scripts/` carries the bit,
regardless of what any hook's `command` happens to name. Three paths carry
it today: a `.skillpack` export and import (`hub skill export` / `hub skill
import`), a push or pull through a remote connector, and project adoption
(`hub project import-skill`, a plain `shutil.copytree` — the filesystem
itself preserves the mode, pinned by
`tests/test_ships_with_import_export.py:216-227`). All three are additive
only: they may add the execute bit, never remove one, and never touch the
mode of any other file. See `docs/remote-connectors.md` §SkillTree for the
remote-connector side of this rule — including its one caveat: a push or
pull skips a remote file whose bytes already match
(`hermes._write_skill`'s byte-identical skip), so a script already on a box
from before this rule existed is not repaired in place — only touching the
file's bytes, or removing and re-pushing the skill, fixes it.

**Authoring a brand-new inline hook.** `hub skill companions new-hook <skill>
--item <name> --event <EVENT> [--tools a,b] [--activation
while-running|always] [--command scripts/<slug>.sh] [--no-scaffold] [--json]`
declares a new inline hook for a skill. Unless `--no-scaffold` is given, it
also creates the hook's script. The script lands at
`<skill>/scripts/<slug>.sh`, or at the path named by `--command`. Hub seeds
the script with a fail-open template and marks it executable. The write is
strictly additive: hub never overwrites a script that already exists. A
failure at any point rolls back both the frontmatter change and the new
script.

A new inline hook's name must not collide with anything hub can already
resolve. This includes a name the skill already declares, inline or by
reference. It also includes a name already in the hooks library, as a
registry hook or a built-in. Hub refuses the collision before it writes any
file. The error names the collision and points at `hub skill companions add
--kind hook --item <name>` — the reference splice — as the likely intent.

`hub skill companions set` applies almost the same rule to an inline
`hooks[]` entry. It skips only a name the skill already declares as its OWN
inline hook. This carve-out lets an already-provisioned skill re-save
without error — its inline hook is by then also a library definition.

`set`'s JSON result gains two reporting-only fields. `scaffolded` lists the
absolute paths of scripts this call created. `missing_commands` lists the
`command` value of each declared inline hook that has no file on disk and
asked for no scaffold. The `HOOK_BROKEN_SCRIPT` doctor code is still what
enforces this, not the new field.

`risks.detect_companion_risks` (part of the shared doctor rollup above, **not**
one of the two `hub hook doctor` legs — it runs once over the whole registry,
not per hook) checks that ledger against each project's active skills and
each skill's current declaration, and folds in the two reconcile-only
findings below (fed from `ships_with_reconcile.classify`, the read-only
reshape of the same per-sync reconcile walk):

| Code | Severity | Trigger |
|---|---|---|
| `COMPANION_ORPHANED` | warning | A ledger entry's skill is no longer active on the project (`--keep-companions`, or a bundle-only equip), or a ledger item — a hook or agent name — is no longer named in the skill's current `ships_with` block |
| `COMPANIONS_PENDING` | info | An active `ships_with` skill has no ledger entry at all — a bundle or `--with-refs` equip skipped the consent flow |
| `COMPANION_REF_MISSING` | warning | A `{ref: <name>}` hook names a hooks-library definition that no longer exists |
| `COMPANION_AGENT_DRIFT` | warning | A companion agent's rendered file no longer matches the hash the ledger recorded — hand-edited outside the skill; reconcile never clobbers it, so this finding is the only trace |

Both new codes are warnings, like every other companion finding — they never
fail `hub sync` on their own (only a `danger`-severity finding does, per the
Sync Behavior doctor rollup).

`activation: while-running` (`docs/SKILL-SCHEMA.md` §`ships_with:`) stays
display metadata only: a shipped hook attaches for as long as the companion
relationship exists, and its own script is responsible for exiting fast when
there is no matching active-workflow marker — hub cannot scope a hook
*attachment* to "while a particular skill runs".

## CLI reference

```
hub hook list [--json]                                  # every definition + attach scopes + capability reach
hub hook show <name> [--json]                           # one definition + resolved per-project settings + reach
hub hook doctor [--json]                                # read-only risk scan over every attached hook (--json always exits 0)
hub hook new <name> --event <E> --command <cmd> \       # create a COMMAND definition
    [--description <s>] [--tools a,b] [--matcher <regex>] [--timeout <s>] [--harnesses claude-code,codex]
hub hook new <name> --event <E> \                       # create a SCRIPT definition
    --script-source managed|repo --script-interpreter bash|python3 \
    [--script-path <rel>] [--script-args=<s>] [--script-body-file <f>] [--description <s>] [--tools a,b] …
hub hook edit <name> \                                  # edit a user definition (built-ins: command/event read-only)
    [--event <E>] [--command <cmd>] [--description <s>] [--tools a,b] [--matcher <regex>] [--timeout <s>] [--harnesses ...] \
    [--script-source managed|repo|""] [--script-interpreter …] [--script-path …] [--script-args=…] [--script-body-file …]
hub hook script show <name> [--json]                    # print a MANAGED script body
hub hook script save <name> {--body-file <f> | --stdin} # overwrite a MANAGED script body
hub hook delete <name> --yes                            # delete a user hook + detach it from every scope
hub hook attach <name> {--global | --project <p>}       # attach at a scope
hub hook detach <name> {--global | --project <p>}       # detach from a scope
hub hook set-settings <name> {--global | --project <p>} --json '<obj>'   # deep-merge settings
```

Notes (verified against `hub.py` argparse):

- `--tools` / `--harnesses` are comma-separated. `--matcher` wins over `--tools`.
  `--event` is **required** on `hook new`, and so is exactly one action —
  `--command` OR the `--script-*` flags (passing both is refused). `hook edit`
  requires at least one field flag.
- `--description` is the one-line summary the app's editor and `hook list`/`show`
  render. On `hook edit` it follows the same clear-sentinel convention as
  `--tools`/`--matcher`/`--harnesses`: an empty string drops the field, and a
  description-only edit counts as a real edit.
- Script flags on `hook edit` merge over the existing script, so `--script-args`
  alone does not have to restate the source/interpreter. `--command` on a script
  hook switches it back to a command; `--script-source ""` clears the script and
  must come with `--command` (a hook with no action is refused). Either switch
  DELETES the managed body — the app warns first.
- Write `--script-args=--fix` (with `=`): a bare `--script-args --fix` makes
  argparse read `--fix` as a flag.
- `--script-body-file` is managed-only and seeds the body at create time;
  `hub hook script save` is the ongoing edit path (it re-syncs). Both refuse a
  command hook, a repo script, and a built-in.
- `hub hook show --json` carries `script` (managed also gets `body` + `body_path`,
  `body` is `null` when the file is gone) and `script_projects`
  (`[{project, path_exists}]`, repo scripts only). `hub hook list --json` rows
  carry an `action` discriminator: `command` | `script:managed` | `script:repo`.
- `hub hook show --json` also always carries `baked_command` (the command line
  the harness actually receives after sync, at the GLOBAL scope — computed
  read-only, never written; `null` on error) and `builtin` (for a provenance
  `builtin` hook only: `{dir, files: [{name, path, body}]}` for every regular
  file directly in its `code_home()/hooks/<name>/` dir, `hook.yaml` sorted
  last; `null` for a user hook). `hub hook list --json` rows carry
  `baked_command` too, so a built-in's row can show the real command instead
  of its template.
- `hub hook show --json` also always carries `command_script` (the script file
  a plain command hook's command line references — first token detected via
  `risks.candidate_script_paths`, `null` for a built-in, a script-backed hook,
  or a command with no script-path token). A relative token resolves to one
  location per project the hook actually reaches — every registered project
  for a global attach, only the attached ones otherwise; a project with no
  `path` is skipped, not surfaced as a location. Each location's `reason` is
  one of `outside_project` (the token traverses out of the project root),
  `unreadable`, `too_large` (over 512 KiB), `unresolvable` (the path could not
  be expanded, e.g. a `~nosuchuser/...` token), or `null` (readable, or simply
  missing). `repo_script_conversion` is `{interpreter, path, args}` when the
  command is a hand-written `<interpreter> <relative path> [args]` whose path
  token is itself a real script token (per `candidate_script_paths` — so
  `bash -c "..."` and `python3 -m mod` are never mistaken for one), `null`
  when it is not convertible — an absolute or `~` path is never convertible, a
  repo script is per-project by definition. Both keys are read-only: neither
  ever writes under `state/`.
- `hook new`/`edit`/`attach`/`detach`/`delete`/`set-settings` are registry
  mutations — each triggers a follow-up `_auto_sync()` (which skips the remote
  dispatch pass). `list`/`show` are read-only.
- `attach`/`detach` require **exactly one** of `--global` / `--project`.
  `set-settings` defaults to **global** when neither is passed; a built-in's
  global settings are read-only, so `set-settings` on a built-in requires
  `--project <p>`.
- `hook delete` refuses a built-in (detach it instead) and prints a dry-run plan
  unless `--yes` is passed.
- `hook list`/`show` print each harness's cached capability **reach** (run
  `hub sync` once to populate the probe cache).

### Deprecated permissions aliases

`hub permissions hooks add` / `hub permissions hooks remove` still work (with a
loud deprecation warning) as thin aliases: `add` creates an `imported-hook-<n>`
definition and attaches it; `remove` finds the matching library hook by
`(event, matcher, command)` and detaches it. Use `hub hook new` / `hub hook attach`
/ `hub hook detach` directly.

## Migration (automatic, one-time)

On the first registry load after upgrade, each legacy `permissions*.hooks` entry
becomes a library definition (name auto-derived `imported-hook-<n>`, provenance
`user`) attached at its original scope, honoring its harness affinity; the hook
entries are removed from the permissions blocks; `registry.yaml` is backed up
first. Personal-tier (`permissions_local`) hooks migrate to a **project attach**
(which now writes to `settings.local.json`, preserving their personal, uncommitted
file target). The hooks stream's one-time sidecar handover clears any legacy
`hooks.*` keys still recorded in a permissions sidecar and re-writes them under the
`kind="hooks"` sidecar in the nested schema. `permissions.hooks` no longer exists
post-migration. See `docs/permissions.md`.

Topics routed here: *hook*, *hooks*, *hook library*, *hook script*, *managed
script*, *repo script*, *lsp-report*, *PostToolUse*, *hook trust*, *hook
capability*, *hook probe*, *feature-off*, *attach hook*, *disable hook*.
