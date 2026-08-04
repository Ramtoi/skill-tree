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
    command: "..."                 # command hook only (v1)
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
  `provenance`). `to_block()`/`from_block()` round-trip through the registry;
  `from_block` is tolerant (coerces scalars, falls back to safe empties for
  malformed collection fields).
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

A built-in's **command and event are read-only** — `hub hook edit` refuses them
and points you at `hub hook set-settings`. Its **settings remain editable**, but
only per-project (its global/base settings are read-only on-disk defaults; there
is no global override tier in v1).

**Shadow-by-registry-name:** if a registry `hooks:` entry has the *same name* as
a built-in, the registry definition **shadows** the built-in (used in full —
including its `command`, which sync-time materialization such as the `lsp-report`
bake leaves untouched because that keys off `provenance == "builtin"`, not the
name) and a warning is emitted
(`hooks_model.resolve_definition` / `all_definitions`). A
dangling attached name (neither a registry definition nor a built-in) is warned
and omitted — it never reaches an adapter.

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

`_run_hooks_stream` (`hub.py`) runs **after** the permissions stream (so the two
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
| `HOOK_BROKEN_SCRIPT` | warning | The command references a script path that does not exist on disk — the hook will fail to run. |
| `LSP_CHECKER_MISSING` | info | An `lsp-report` language is enabled but its checker binary is not on PATH — that language is a silent runtime no-op. |

Any `severity=danger` finding causes `hub sync` to exit non-zero even when every
write succeeded. (The retired `DROPPED_HOOK` "Codex has no hooks" finding is
**gone** — codex is hook-capable and hooks are no longer authored from the
permissions block.)

## CLI reference

```
hub hook list [--json]                                  # every definition + attach scopes + capability reach
hub hook show <name> [--json]                           # one definition + resolved per-project settings + reach
hub hook new <name> --event <E> --command <cmd> \       # create a user definition
    [--tools a,b] [--matcher <regex>] [--timeout <s>] [--harnesses claude-code,codex]
hub hook edit <name> \                                  # edit a user definition (built-ins: command/event read-only)
    [--event <E>] [--command <cmd>] [--tools a,b] [--matcher <regex>] [--timeout <s>] [--harnesses ...]
hub hook delete <name> --yes                            # delete a user hook + detach it from every scope
hub hook attach <name> {--global | --project <p>}       # attach at a scope
hub hook detach <name> {--global | --project <p>}       # detach from a scope
hub hook set-settings <name> {--global | --project <p>} --json '<obj>'   # deep-merge settings
```

Notes (verified against `hub.py` argparse):

- `--tools` / `--harnesses` are comma-separated. `--matcher` wins over `--tools`.
  `--event` and `--command` are **required** on `hook new`. `hook edit` requires
  at least one field flag.
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

Topics routed here: *hook*, *hooks*, *hook library*, *lsp-report*, *PostToolUse*,
*hook trust*, *hook capability*, *hook probe*, *feature-off*, *attach hook*,
*disable hook*.
