# Skill Hub

Central skill registry and project linker for Claude Code, Codex, Pi, and opencode.

## Repo

- Public mirror: https://github.com/Ramtoi/skill-tree
- Development happens in a private upstream repo and is published to the mirror
  as a sanitized snapshot on each release. The publish runbook lives in the
  upstream repo's `RELEASING.md`.

## Docs

- `DESIGN.md` — Skill Tree app design vision (1.1 power-user first, IA, motion, accent semantics)
- `COMPONENTS.md` — primitive contracts: tokens, props, class names, behavioral rules
- `docs/ADDING-SKILLS.md` — creating skills + MCP servers, registering, enabling
- `docs/SKILL-SCHEMA.md` — SKILL.md frontmatter reference (incl. `bootstrap:` block)
- `docs/distribution.md` — code home vs data home, bundle layout, install flow, env vars
- `docs/permissions.md` — permissions model, adoption flow, doctor risks, sidecar state, `hub permissions disable {restore|detach}` off-ramps. Topics routed here: *permissions*, *allowlist*, *deny rule*, *approval policy*, *sandbox mode*, *disable permissions*, *restore permissions backup*.
- `docs/AGENT-DOCS.md` — canonical root policy (`AGENTS.md` real, `CLAUDE.md` derived), `symlink` vs `import` strategy, the one per-directory status model (verdicts + `legacy`/`broken_link`/`external_link` flags, shared Rust/Python fixture corpus), transactional `hub agent-docs fix` (legacy `AGENT.md` cleanup, opt-in nested promotion, apply-time disk re-validation), `resolve` ops, external-edit contract. Topics routed here: *agent docs*, *AGENTS.md*, *CLAUDE.md*, *AGENT.md legacy*, *root strategy*, *canonical root*, *fix layout*, *migrate agent docs*, *divergent root conflict*.
- `docs/SNIPPETS.md` — reusable agent-doc instruction blocks: marker format, scan-derived statuses (`applied|modified|outdated|orphaned` + damaged warnings), drift/fallback semantics, CLI. Topics routed here: *snippet*, *snippets*, *instruction snippet*, *marker block*, *orphaned block*, *update everywhere*.
- `docs/remote-connectors.md` — pushing hub-managed artifacts to remotes via pluggable connectors: the `remotes:` block (references-only/no-secrets), the `RemoteConnector` plan-then-apply ABC + `REMOTE_CONNECTORS` registry (lazy fail-safe discovery: builtin → `connectors_private` → `skill_hub.connectors` entry points → drop-in `data_home()/connectors/`; `hub remote connectors --json` catalog; connector metadata `label`/`description`/`transport_kind` drives registry-derived wizard cards + transport-aware onboarding, `setup_key_transport` hook for custom key flows), the publishable Hermes connector (`~/.hermes/skill-hub/` push, merge-preserving config, SOUL/MEMORY/USER round-trip, write-confinement), the `_run_remote_dispatch` sync pass + 3-way drift/conflict model, import (`origin: remote:<id>`), TOFU host-key pinning + keychain secrets, `hub remote …` CLI, doctor, authoring a connector. Topics routed here: *remote*, *connector*, *hermes remote*, *remote sync*, *remote drift*, *equip remote*, *push skill to box*.
- `docs/subagents.md` — sub-agents managed **in place** (no content mirror) across **Claude Code** (`~/.claude/agents/*.md`) and **Codex** (`$CODEX_HOME/agents/*.toml`, user scope; project scope trust-gated/deferred): harness-parameterized `subagents.py` + `subagent_codex.py` (tomlkit round-trip) + `subagent_links.py` + `hub subagent` CLI (`--harness`, list/show/save/delete/set-disabled/skill-usage/attachable-skills/link/unlink/link-status/resolve-drift/provision-skill, all `--json`), capability-gated `/harness/:id` surface (`Harness.agents_dir`), **linked twins** (shared core co-write via a membership-only sidecar `state/subagents/links.json`, per-field drift resolution, never auto-clobbered), **two-phase attach-skill provisioning** (`needs_provisioning` → consequence prompt → `provision-skill`; remote-quarantine hard refuse, affinity widen), Claude disable = `Agent(<name>)` deny (NOT hub-managed), Codex disable = `.toml`⇄`.toml.disabled` rename, live gate `RUN_LIVE_CODEX=1 pytest tests/test_subagents_live_codex.py`. Topics routed here: *sub-agent*, *subagent*, *agent definition*, *codex agent*, *linked twin*, *agent drift*, *attach skill to agent*, *provision skill*, *disable agent*, *harness config*.

## Key Files

- `hub.py` — CLI entry point (`hub` command). Resolves `code_home()` (read-only assets — itself, starter skills) and `data_home()` (user registry, owned skills).
- `data_home()` resolution: `$SKILL_HUB_HOME` → `$SKILL_HUB_DIR` (legacy, deprecated, one-shot warning) → `~/.skill-hub/`. With no env and no `~/.skill-hub/registry.yaml`, a legacy `~/Dev/.skill-hub/` is used transparently with a migration prompt.
- `code_home()` resolution: `$SKILL_HUB_CODE` → walk-up from `Path(__file__).parent` for a dir with `hub.py + app/`. In packaged builds the Tauri side reads `<App>.app/Contents/Resources/hub/`.
- `~/.skill-hub/` — runtime data home. Contains `registry.yaml` (with top-level `bootstrap:` block recording first-run state), `skills/`, `snippets/` (reusable agent-doc instruction blocks), `mcp-servers/`, `_hub-backups/`, `.lock`.
- `app/` — Skill Tree native desktop app (Tauri 2 + React 19 + TypeScript + Vite)
  - `app/src/` — React frontend
  - `app/src-tauri/src/commands/` — Rust commands: `registry`, `hub`, `fs`, `bootstrap`, `projects`; shared `mod.rs` exposes `code_home()` / `data_home()` / `hub_py()`
  - `app/src-tauri/tauri.conf.json` — app config + `bundle.resources` that ships `hub.py` + its sibling `.py` modules + `requirements.txt` into `Contents/Resources/hub/` (no starter `skills/`/`mcp-servers/` are bundled; the Starter Pack source ships empty and is populated later as an external source)
- `openspec/changes/` — spec-driven change tracker

## Native App: Skill Tree

`/Applications/Skill Tree.app` (replaces the old FastAPI dashboard).

```bash
hub app dev              # run Tauri + Vite in dev mode (hot reload)
hub app build            # build production app
hub app build --install  # macOS: build and copy app to /Applications
hub dashboard            # launch the installed app
hub dashboard --dev      # legacy alias for dev mode
```

Build from source:

```bash
cd app && npm install && npm run tauri build
```

### Architecture

- **HashRouter** routes: `/` (Library), `/skill/:name`, `/project/:name`, `/bundle/:name`. Python-missing gate is **above** the router in `AppShell` (`useQuery(["python"], invoke<boolean>("check_python"))`).
- **Data layer**: `@tanstack/react-query`. `useRegistry` is the canonical hook (`@/hooks/useRegistry`). Mutations call `invoke("hub_cmd", { args: [...] })` and invalidate `["registry"]`. No new state libs.
- **UI store**: Zustand at `app/src/store/index.ts` — palette open state, sync status, toasts, recently visited, degraded-mode flag.
- **Routing helpers**: `useTrackRecent` (`app/src/hooks/useRecent.ts`) auto-populates the sidebar Recent group from the URL.
- **Tweaks**: state lives in the Zustand store (`store/index.ts`, backed by `lib/tweaks.ts` localStorage read/write) — not a standalone hook — so a rail/density toggle live-updates every subscriber. `App.tsx` applies `[data-density]` to `<html>` and `[data-rail]` to `.app`. The brand accent (`--violet`) is **fixed** in the stylesheet and intentionally not swappable (the accent picker was removed so color can carry meaning); legacy stored `accent` keys are ignored.
- **Sync**: `useRunSync` (`app/src/hooks/useRunSync.ts`) is the one registry-sync flow (`hub sync` → invalidate `["registry"]` → status + toasts). The StatusBar registry chip is its primary trigger; there is no rail Sync button.
- **Tauri bridge**: every UI action maps to one of `enable`, `disable`, `bundle apply/remove/new/update/delete`, `new`, `set-meta`, `update`, `archive`, `sync`. The Rust layer at `app/src-tauri/src/commands/` only marshals subprocess calls — no business logic.

### Shell layout

3-row × 3-column CSS grid (`app/src/App.css` — search `.app`):

```
.app-topbar (rail+side cols)        | (main spans rows 1–2)
56px IconRail | 240px NavPanel      | 1fr main
                28px StatusBar (spans all columns)
```

Row 1 is `--topbar-h` (= `--header-row-1`, the screen-header title-row height) — a `.app-topbar` strip rendered in `App.tsx` that reserves room for the macOS traffic lights across the rail+sidebar columns (single `--bg-0` background, one bottom border, no vertical seam under the lights). It holds the right-aligned **SKILL TREE** label + skill count and is a `-webkit-app-region: drag` zone (`data-tauri-drag-region`). `--titlebar-inset` (84px) left-pads it clear of the traffic lights. The main column spans rows 1–2 (`grid-row: 1 / 3`) so its header stays flush to the top, aligned with the lights. In fullscreen (`data-fullscreen="true"`) the topbar collapses to 0 and hides, since macOS auto-hides the lights. The topbar spans cols 1–2 with the rail, col 1 without it.

`<IconRail />` can be hidden via Tweaks (`data-rail="false"` on `.app`). Seven destinations — Library, Projects, Sources, Snippets ┊ Permissions (`shield` icon), Harnesses, Remotes (`remote` icon) — then bottom utilities Palette + Tweaks (`cog`). No Bundles button (reachable via NavPanel + palette) and no Sync button (moved to the StatusBar chip). Projects navigates to the most-recent/first project, falling back to the palette. The active item is tinted by `--section` (per-route chrome hue set on `.app[data-section]` in `App.tsx`), not by violet. Library and Permissions live solely in the rail — **not** duplicated in the NavPanel.

**NavPanel IA** (`app/src/components/NavPanel.tsx`):
`Pinned (when ≥1) → Projects → Bundles → Sources → sticky Recent strip → Quick-jump footer`.
Groups >6 items truncate to 6 visible rows + `Show N more`, expose an inline filter (search icon in header), and the currently-active row is force-included in the truncated slice. Pin / collapsed state persists in `localStorage` under `st:sb:pinned` / `st:sb:collapsed` (defaults: nothing pinned, `Sources` collapsed). `SideRow` and `SideSection` primitives are colocated inside `NavPanel.tsx` and are not yet promoted to `components/`.

### Visual system

All design tokens live in `app/src/App.css` under `:root` (surfaces `--bg-0..4`, text `--fg/-strong/-mid/-mute/-dim`, semantic accents `--violet/-2/-glow/--amber/--green/--red/--blue/--cyan`, identity ramp `--id-0..7`, section-chrome `--sec-*`+`--section`, geometry `--radius-sm/-/-lg/-xl`, density `--row-h/--pad-x/--pad-y`, type `--font-sans/-mono/-display`).

- **Identifier vs prose typography**: any proper-noun identifier (skill, project, bundle, version, path, kbd, code) renders in `var(--font-mono)`. Everything else is `var(--font-sans)`. See `COMPONENTS.md` §Tokens > Type.
- **Color = one job per channel** (three chroma registers, never overlapping): **brand** violet (≥0.12, fixed) = active/primary/focus (and the single `Toggle`/checkbox accent); **status** green=ok / red=error / blue=info, with sync freshness carried by dedicated freshness tones + **motion+fill**, never amber; **provenance/severity** amber = direct-equip provenance + risk severity ONLY (via-bundle is neutral); **identity** = shape/logo/emoji + the muted `--id-*` ramp (0.10), never a semantic accent; **section chrome** `--sec-*` (0.06) on the rail pill + header underline only. Harness glyphs = official logos in brand color (Claude terracotta) or neutral. See `COMPONENTS.md` §Accents.
- **Fonts**: Geist Variable + Geist Mono Variable via `@fontsource-variable/geist[-mono]` (imported in `app/src/main.tsx`).

### Primitive library

`app/src/components/` — every primitive lives in its own file. New screens compose these; do **not** reinvent. Read `COMPONENTS.md` for contracts.

Reference (just the names — read each file for current props):

- Atoms: `Icon` + `icons.ts`, `Button`, `Toggle` (the one checkbox/switch), `Tag`/`KindTag`/`ScopeBadge`, `Kbd`, `Chips`/`Chip`, `SectionHeader`, `SearchInput`, `Field`/`MetaGrid`, `PowerPips`, `StatusBadge` (base; `DriftBadge`/`RiskBadge`/`StatePill`/`SnippetStatusBadge` are presets), `FreshnessBadge`/`FreshnessDot`
- Composite: `StatCard`, `ResourceRow`/`ResourceCard` (`SkillRow`/`SkillCard` are presets), `BundleChip`/`BundleChipAdd`, `EmptyState`, `ErrorCard`, `CodeArea` (`Edit`/`Preview`/`Diff`), `EquipPicker`, `ConnectionsPanel`, `SyncReportDrawer`, `Toast`
- Overlays (**the one overlay system** — `Modal.tsx`): `Modal` / `ConfirmDialog` / `Sheet`. `DetailDrawer` and `ConfirmModal` are **removed** (deleted; use `Sheet` / `ConfirmDialog`).
- Editor: `DocumentEditorShell` (shared two-column shell for `SkillEditor` / Snippets / SubagentEditor) + `CodeArea`, `ShortcutCheatsheet`
- Shell: `IconRail`, `NavPanel`, `StatusBar`, `TweaksPanel`/`TweaksToggle`
- Helpers: `bundleColors.ts` (`bundleColor(name)` hashes deterministically to an identity-ramp token `--id-0..7`)

`CodeArea` behavior: `Preview` renders via `lib/renderMarkdown.tsx` (faithful, golden-fixture pinned); `Diff` via `lib/lineDiff.ts` (Myers, aligned lines); `⌘F` in-editor search, soft-wrap, split mode. `Toast` honors `duration` / `info=blue` / a close button / an action slot.

### Screens

`app/src/screens/`:

- `SkillLibrary.tsx` — scope-grouped rows, kind+bundle chip filters + a Filter popover, list/grid toggle, keyboard list nav (`useListNav`) with row equip (`e`), a detected-project-local-skills banner, `/?new=1` opens `NewSkillSheet`.
- `ProjectWorkspace.tsx` — 4-card hero strip, active-bundle chips, source-coded equipped grid (amber=direct, violet=via bundle), drag-and-drop equip, Loadout/Tree toggle. Global bundles render as a read-only **auto-applied** cluster; skills whose `harnesses:` affinity won't reach any effective harness get a "won't sync here" badge + banner.
- `TreeView` (in `components/TreeView.tsx`) — radial SVG node graph; click bundle to (un)apply, click skill to toggle direct equip; nodes **navigate** (no dead-end toasts), labels capped at 12 nodes.
- `SkillEditor.tsx` — composes `DocumentEditorShell`; segmented Edit/Preview/Diff, markdown toolbar with selection mutators, `UNSAVED` pill, `⌘S` save, side-panel sections (incl. a `set-meta --harnesses` affinity picker) + Danger zone.
- `BundleManager.tsx` — ordered numbered card grid with drag-reorder (order = `skills:` array order in `registry.yaml`), side-panel picker, Applied-to chips, Danger zone.
- `RemotesScreen.tsx` — remote connector targets (`/remotes`, `/remote/:id`); `components/remotes/` holds `AddRemoteWizard` (TOFU host-key onboarding), `RemoteDetail` (diff plan + drift badges), `DriftBadge`, `RemoteDocEditor` (SOUL/MEMORY/USER round-trip). In-app equip via `EquipPicker` (→ `hub remote equip`); cards lazily probe health. Marshals the `hub remote …` subcommands. See `docs/remote-connectors.md`.
- Sources (`/sources`) — git/external source registration; the add-git flow has a per-conflict resolver (skip/replace/suffix → `--decisions-stdin`).
- Permissions (project tab, `PermissionsEditor`) — saving project permissions that emit translatable Codex Bash rules intercepts with a `ConfirmDialog` for the `trust_level = "trusted"` auto-grant.
- `PythonError.tsx` — full-screen `ErrorCard`; `Continue in degraded mode` flips `useAppStore.degradedMode` so routes render despite `pythonOk === false`.

`app/src/components/CommandPalette.tsx` — custom 640px glass card, groups results into `Actions | Projects | Bundles | Skills`, arrow/enter/esc keyboard nav, hover-keyboard sync.

### Keyboard contract

Global single-keys (wired in `app/src/App.tsx`):

| Key | Action |
|---|---|
| `⌘K` / `Ctrl+K` | Toggle command palette |
| `/` | Focus the active screen's search (`lib/focusScreenSearch` picks the slot; no-op while a text field is focused) |
| `⌘⌃F` | Toggle fullscreen |
| `Esc` | Dismiss palette / pop the current palette stage |

**Chord system** — one registry at `lib/keymap.ts` (`KEYMAP`), dispatched by `useChords` with a 1.2s timeout; the StatusBar shows a pending-chord chip. The `?` overlay (`ShortcutCheatsheet`) and every palette `Kbd` hint derive from `KEYMAP`, so a shown binding always fires. Navigation chords: `g l` Library, `g p` last project, `g b` Bundles, `g h` Harnesses, `g s` Sources, `g n` Snippets, `g r` Remotes, `g ⇧p` Permissions. Create: `c s` new skill, `c b` new bundle. `?` opens the cheatsheet.

**Palette verbs with arguments** (`lib/paletteVerbs.ts`): verbs like `Equip skill…` / `Apply bundle…` push argument stages (two-stage pick) instead of navigating, firing `run` once all args are picked.

**List navigation** (SkillLibrary, `useListNav`): `j`/`k`/arrows move, `Enter` opens, `e` equips the focused row.

Reversible actions surface an **undo toast** (`useUndoableAction`).

Per-screen: `⌘S` in the editors (SkillEditor / Snippets / SubagentEditor) saves if dirty.

### Derived selectors

`app/src/lib/resolveActiveSkills.ts` exports:

- `resolveActiveSkills(project, registry)` — names of all skills active on a project (global bundles ∪ applied bundles ∪ `enabled`)
- `bundleProvidedSkills(project, registry)` — set of names provided by any applied (or global) bundle
- `directOnly(project, registry)` — names equipped via `enabled` but not via any bundle
- `viaBundles(skillName, project, registry)` — bundle names providing this skill to this project
- `equippedCount(skillName, registry)` — how many projects have this skill active

`app/src/lib/` also exports two small helpers used by the navigator:

- `projectHealth(lastSync?)` → `"ok" | "stale" | "never"` — health-dot state from the human sync string. Returns `"never"` when `lastSync` is undefined.
- `syncMinutes(lastSync?)` → minutes-since-sync as a number for sorting (`Number.MAX_SAFE_INTEGER` for unknown/never).

### Tests

**Vitest (frontend + CLI contract)** — `app/src/test/`:

- `helpers.tsx` — `renderWithProviders`, `sampleRegistry` (includes `bootstrap:` block), `primeRegistry`, `makeQueryClient`. Use these for any new component test that needs router + react-query.
- `setup.ts` — mocks `@tauri-apps/api/core` `invoke` globally; installs sensible defaults per `beforeEach` for `bootstrap_check`, `project_*`, `pick_directory`, `check_python`, `hub_cmd` so tests that don't care about specific commands don't have to mock them. Override with `vi.mocked(invoke).mockImplementation(...)` when needed.
- Logic tests (no UI): `resolveActiveSkills.test.ts`, `cliContract.test.ts` (spawns `python3 hub.py` against a tmp data home via `SKILL_HUB_HOME`), `hubCmdIntegration.test.ts`.
- Component tests: `primitives.test.tsx`, `SkillRow.test.tsx`, `StatusBar.test.tsx`, `IconRail.test.tsx`, `CommandPalette.test.tsx`, `BootstrapWizard.test.tsx`, `ProjectDialogs.test.tsx`. Notable newer suites: `primitiveSystem`, `adoptionPrimitives`, `EquipPicker`, `ConnectionsPanel`, `renderMarkdown` (golden fixtures), `lineDiff`, keymap↔cheatsheet bidirectional, `TrustConfirm`, `AffinitySurfacing` (~676 tests across ~70 files).

Run: `cd app && npm run test -- --run` (or `npm run test` for watch).

**E2E (Playwright)** — `app/e2e/`: journey specs run against the `VISUAL_MOCK` app (`npm run test:e2e`), ~31 journeys covering equip/connections, undo, chord + command layer, the editor platform, adoption overlays, trust-confirm, and sub-agents (incl. Codex + linked twins).

**Visual / responsive screenshots** — `app/visual/` + `app/src/mocks/`:

- `cd app && npm run visual` renders the **real** frontend in headless Chromium with mocked Tauri
  data (guarded `VISUAL_MOCK=1` Vite alias → `src/mocks/tauriCore|tauriWindow|tauriOpener.ts`; the
  normal Tauri build path is untouched when the env var is absent), captures every screen × multiple
  widths (default `1440/1024/768/520`, height 900; now ~40 scenes × 4 widths = ~160 frames), and
  writes a side-by-side gallery to
  `app/visual/out/index.html` (PNGs alongside, gitignored). `app/visual/capture.mjs` holds the
  `SCENES` + `WIDTHS`; add a screen by appending a scene (route + wait selector) and, if it calls a
  new Tauri command, a return shape in `src/mocks/tauriCore.ts`.
- Use it after any layout/CSS/screen change and before a release to catch overflow/clipping, panel
  overlap, broken two-column stacking, or editor cursor drift. The reusable workflow is also
  registered as the project-local skill **`skill-tree-visual-tests`** (triggers: "responsive
  review", "screenshot the app", "regenerate the visual gallery").

**Pytest (Python — `hub.py` internals)** — `tests/`:

- `conftest.py` — `tmp_data_home` fixture: isolates `SKILL_HUB_HOME` to a tmp path, unsets `SKILL_HUB_DIR`/`SKILL_HUB_CODE`, resets `hub._DATA_HOME_CACHE` and warning state. `clean_env` for tests that need no env at all.
- `test_path_resolvers.py` — `data_home()` / `code_home()` precedence + collision rejection.
- `test_bootstrap.py` — `cmd_bootstrap` idempotency, `--force`, dry-run JSON shape, Python-version precondition.
- `test_migrate_home.py` — legacy-move logic, EXDEV fallback, source-path rewrite, collision-skip semantics (the migrator correctly removes empty placeholder dirs that `data_home()` auto-creates at the target).
- `test_import_scanner.py` — classification (NEW/CONFLICT/SILENT_SKIP/ALREADY_MANAGED/INVALID_NAME/BROKEN) + `apply_import` conflict actions + adoption flow.
- `test_lock.py` — two-process `subprocess.Popen` race + `os._exit` crash-release.
- `test_project_lifecycle.py` — `clean_project_artifacts` symlink ownership via `os.readlink`, MCP entry pruning, empty-dir cleanup, missing-old-path tolerance, edit-path collision rejection.
- `test_sync_report.py` — sync-report schema + atomic write on every exit path; `test_remote_equip.py` — `hub remote equip` registry toggle; `test_source_conflict_decisions.py` — `source add git` per-conflict decision vocabulary (fail-closed). ~972 tests total.

Run: `python3 -m pytest tests/ -v` (pytest installed via `python3 -m pip install pytest --user`).

## Data Model

```yaml
harnesses_global: [claude-code]    # top-level: harnesses always on for every project

agent_docs:                        # top-level: canonical-root derivation strategy
  root_strategy: symlink           # symlink | import (default symlink when absent)

permissions_global:                # top-level: canonical permission list applied to every project
  allow: [{pattern: "Bash(npm:*)", kind: allow}]
  deny: []
  ask: []
  hooks: []
  sandbox_mode: workspace-write    # Codex-only typed setting
  approval_policy: on-failure      # Codex-only typed setting
  additional_dirs: []
  extras: {}                       # forward-compat escape hatch
  _unmanaged: []                   # harness ids opted out of hub management

projects:
  <name>:
    path: /absolute/path
    bundles: [android, openspec]   # assigned bundles
    enabled: [extra-skill]         # individual skills outside any bundle
    harnesses: [pi]                # additive to harnesses_global
    agent_docs: {root_strategy: import}  # optional per-project override of the global strategy
    permissions: {}                # per-project permissions block — same hybrid shape as permissions_global
    invocation_overrides:          # per-skill invocation override for THIS project
      extra-skill: user-only       # auto|user-only|model-only; portable/project-specific skills only

bundles:
  <name>:
    description: "..."
    icon: "📦"
    scope: global | project-specific  # global bundles auto-apply to all projects
    skills: [skill1, skill2]          # order is preserved (drives Bundle editor card order)

remotes:                             # top-level: pluggable remote connector targets (references only)
  <id>:
    connector: hermes                # REMOTE_CONNECTORS key
    transport: {ssh_host: hermes@moon-base}  # connector transport coords
    host_key_sha256: SHA256:...      # pinned TOFU host-key fingerprint (also accepted under transport:)
    secret_ref: skill-hub:hermes-main  # OS-keychain handle — NEVER secret bytes
    home: ~/.hermes                  # remote home dir (connector default if omitted)
    sync_enabled: true               # include in the auto-sync dispatch pass
    bundles: [android]               # equipped (project equip model)
    enabled: [extra-skill]           # individually equipped skills
```

Resolved active skills = union(global-bundle skills) ∪ union(applied-bundle skills) ∪ `enabled`.

Effective harnesses for a project = `(harnesses_global ∪ project.harnesses) ∩ installed`.
Sync resolves both sets: skills land in each effective harness's `project_skills_dir`,
optionally narrowed by a skill's own `harnesses:` frontmatter. Codex, Pi, and
opencode share `.agents/skills/`, so enabling any of them produces writes to the
same dir (opencode also reads `.opencode/skills/` and `.claude/skills/` natively).

**Writes are scope-targeted (D1).** Global rules (`permissions_global`) are written **only** to
each harness's user-level file; a project's native file receives **only** that project's own block
(`resolve_project_own`). Hub never copies a global rule into a project file — the harness merges
user-level + project-level itself at runtime. Installs predating this are cleaned up by
`hub permissions migrate-scope`.

**Effective permissions for a project** = `merge(permissions_global, project.permissions)` — a
**display/diagnostic view only** (`resolve_effective`, used by `show --effective`, the UI inherited
section, and the doctor), **never** what gets written. Project copy wins on `(pattern, kind)` rule
dedupe **only when harness affinities overlap** (an affinity-distinct global rule survives) and on
`(event, matcher, command)` hook dedupe; typed scalar fields (`sandbox_mode`, `approval_policy`,
`project_trust`) take the project value when present and fall back to global; `additional_dirs` and
`_unmanaged` are **set-unioned** (a project opt-out never discards a global opt-out). Every resolved
rule and hook carries an `origin: "global" | "project"` provenance tag.

### Remote Connectors

A **remote** (top-level `remotes:` block, above) is a pluggable connector pointed at one
destination (a box over SSH). It equips skills with the **same model as a project**
(`resolve_remote_skills` → `resolve_project_skills`) and holds **references only** — `secret_ref` is
an OS-keychain handle, never secret bytes (SSH auth is ssh-agent; host key TOFU-pinned). Connectors
implement the plan-then-apply `RemoteConnector` ABC and register into `REMOTE_CONNECTORS`
(`connectors/`). The framework + the publishable **Hermes** connector ship in the public mirror;
the **custom private connectors are a separate sibling change** living in an excluded
`connectors_private/` tree (`publishable = False`). `hub sync` runs `_run_remote_dispatch` as a
**non-blocking** pass after the global-MCP pass (skipped by `--skip-remotes`): per `sync_enabled`
remote it resolves desired state → `health_check` (unreachable → log + skip) → `plan` → `apply` with
the default allow set `{CREATE, FAST_FORWARD, REMOVE}`. 3-way drift (base = sidecar
`last_pushed_sha256` vs remote vs local): only `local-ahead` auto fast-forwards; `remote-drifted` /
`conflict` are surfaced and **never clobbered** — resolved explicitly via `hub remote resolve`.
Cleanup/drift only consider the ownership sidecar (`<data_home>/state/remote_<id>/`); the box's
pre-existing library is invisible. See `docs/remote-connectors.md`.

## Common Commands

```
hub bootstrap                             # first-run wizard: optional migrate-home, import wizard, sync, writes bootstrap.completed_at
hub bootstrap --dry-run --json            # preview legacy detection, importable candidates, conflicts
hub migrate-home                          # move ~/Dev/.skill-hub/ contents → ~/.skill-hub/
hub harness list                          # show installed × on-globally × used-by-projects
hub harness enable <id>                   # add to harnesses_global (claude-code | codex | pi | opencode)
hub harness disable <id>                  # remove from harnesses_global
hub project harnesses <name>              # show effective + per-source breakdown
hub project harnesses <name> --add <ids>  # mutate project.harnesses (comma-separated)
hub agent-docs strategy --get             # show global root-derivation strategy (symlink|import)
hub agent-docs strategy --set import      # set global; add --project <n> for per-project override; --clear to drop it
hub agent-docs fix                        # dry-run transactional canonical-layout plan (all projects); `migrate` = alias
hub agent-docs fix --project <n> --apply  # promote/derive root + clean legacy AGENT.md links (backup-first, abort-on-disk-change)
hub agent-docs fix --project <n> --apply --nested all  # also promote nested CLAUDE.md dirs (opt-in)
hub agent-docs fix --project <n> --apply --rename-legacy  # also rename lone user-authored AGENT.md → AGENTS.md (opt-in)
hub agent-docs fix --project <n> --apply --commit  # opt-in: git-commit ONLY the touched files, prepared message, never pushes
hub agent-docs resolve --project <n> --op keep_agents|keep_claude|absorb_appendix  # explicit conflict/appendix resolution
hub set-meta <skill> --harnesses claude-code,codex   # narrow a skill's harness targeting
hub list                                  # all skills with bundle membership
hub bundle list                           # bundles + assigned projects
hub bundle apply <bundle> --project <p>   # assign bundle (creates symlinks)
hub bundle remove <bundle> --project <p>  # unassign bundle (removes symlinks)
hub bundle new <name> --skills s1,s2      # create bundle
hub bundle update <name> --skills s1,s2   # update bundle metadata or membership
hub bundle delete <name>                  # delete + unassign from all projects
hub project add <name> <path>             # register a project
hub project edit-path <name> <new-path>   # move a project's filesystem location (cleans old artifacts)
hub project remove <name>                 # unregister a project (cleans hub-owned artifacts)
hub project remove <name> --dry-run --json # preview removal plan
hub project import-skill <name> --project <p>  # adopt a hand-authored project-local skill (.claude/skills/<n>) into the hub
hub set-meta <skill> --scope portable     # update skill registry metadata
hub set-meta <skill> --harnesses claude-code,codex  # narrow harness affinity (now also editable in the skill editor UI)
hub set-meta <skill> --invocation user-only  # who may invoke: auto|user-only|model-only (rewrites SKILL.md frontmatter)
hub project invocation <name>             # table: library mode / override / effective per active skill
hub project invocation <name> --skill <skill> --mode user-only|inherit  # set/clear a per-project invocation override
hub source add git <url> --decisions-stdin  # clone+register; per-conflict skip|replace|suffix on stdin (fail-closed)
hub sync                                  # rebuild symlinks from registry (also runs the permissions stream + doctor)
hub sync --skip-permissions               # bypass the permissions stream and doctor rollup
hub permissions list                      # summary of permission counts per scope
hub permissions show --global             # show global rules
hub permissions show --project <n> --effective  # show resolved (global+project) rules with origin
hub permissions add --global --kind allow --pattern "Bash(npm:*)"
hub permissions remove --global --kind allow --pattern "Bash(npm:*)"
hub permissions hooks add --global --event PreToolUse --matcher Bash --command "..."
hub permissions reconcile --global --json         # unified discovery: merged/conflict/un-importable (machine output)
hub permissions reconcile --global --apply --decisions-stdin  # transactional + auto-syncing apply of chosen decisions
hub permissions adopt --global --action import    # legacy shortcut: ingest all pre-existing native rules
hub permissions adopt --project <n> --action skip --harness claude-code
hub permissions import --global --interactive     # legacy alias → reconcile; per-rule import/keep/drop (MOVE)
hub permissions migrate-scope                     # dry-run: strip global-sourced duplicates from project files
hub permissions migrate-scope --apply             # back up + remove the duplicates
hub permissions doctor                    # detect risks; non-zero exit on danger findings
hub permissions disable --mode restore --project <n>           # dry-run preview
hub permissions disable --mode restore --project <n> --apply   # revert to backup, drop registry block
hub permissions disable --mode detach --global --apply         # leave rules in native files as user-authored
hub snippet list                          # snippets + scan-derived usage (applied/modified/outdated/orphaned)
hub snippet new <name> --tags a,b --body-file f   # create a reusable agent-doc instruction block
hub snippet apply <name> --project <p>    # append marker-wrapped block to the canonical root (--file <rel> for others)
hub snippet update <name> --all           # propagate a library edit to every outdated block (skips modified)
hub snippet remove <name> --project <p>   # excise the block (--force when edited in-file)
hub snippet status --json                 # marker scan across registered projects (no tracking store)
hub remote list                           # configured remotes (table or --json)
hub remote keyscan <ssh-host>             # fetch live SHA256 host-key fingerprint (TOFU; pre-registration)
hub remote setup-key [<id>] [--ssh-host H] # one-time ssh-copy-id of our pubkey (id OR raw host)
hub remote add <id> --connector hermes --ssh-host H --host-key SHA256:… [--secret-ref REF] [--bundles a,b]
hub remote show <id>                      # config + resolved skills
hub remote diff <id>                      # dry-run plan: per-artifact drift (no writes)
hub remote sync <id> [--force]            # sync one remote now (--force ignores sync_enabled)
hub remote resolve <id> --artifact NAME --op push|pull|keep-local|keep-remote [--kind skill|mcp|agent_doc]
hub remote equip <id> --kind bundle|skill --name <n> --state on|off  # registry-only equip toggle for a remote
hub remote import-skill [NAME] --remote <id> [--scan]  # adopt a box-native skill (origin: remote:<id>)
hub remote fetch-doc <id> --doc SOUL.md|MEMORY.md|USER.md   # fetch agent-doc (read-only)
hub remote push-doc <id> --doc … [--force] # push edited agent-doc (content on stdin; drift-checked)
hub remote enable|disable <id>            # toggle sync_enabled
hub remote remove <id>                    # unregister (drops registry entry + sidecars; box untouched)
hub remote clear <id>                     # forget ownership (clear sidecars only; box untouched)
hub remote health <id>                    # reachable / authenticated / host-key-match
hub remote doctor                         # risk scan (host-key mismatch=danger, unreachable, stale sidecars, unresolved drift)
hub dashboard                             # launch Skill Tree native app
```

## Environment Variables

| Var | Purpose |
|---|---|
| `SKILL_HUB_HOME` | Override data home (where `registry.yaml` + user-owned skills live) |
| `SKILL_HUB_CODE` | Override code home (dev only; for packaged apps Tauri resolves to `Contents/Resources/hub/`) |
| `SKILL_HUB_DIR` | **Deprecated** legacy alias for `SKILL_HUB_HOME`; emits one-shot warning per process; will be removed in a follow-up change |

## Sync Behavior

`hub sync` resolves per project:
1. **Effective harnesses** = `(harnesses_global ∪ project.harnesses) ∩ installed`. Unknown harness ids in the registry log a warning and are inert.
2. **Active skills** = union(global-bundle skills) ∪ union(applied-bundle skills) ∪ `enabled` (same as before).
3. For each skill, **target dirs** = `effective ∩ (skill.harnesses or effective)` — narrowed by the optional `harnesses:` SKILL.md frontmatter. Affinity-filtered skips are logged.
4. **Writes symlinks** to each unique `harness.project_skills_dir` in the intersection. Codex, Pi, and opencode share `.agents/skills/` → one write, not three.
4b. **Invocation overrides** (`projects.<n>.invocation_overrides`): an overridden (project, skill) pair's symlink points at a generated variant dir (`<data_home>/state/skill_variants/<skill>@<mode>/` — real SKILL.md with `disable-model-invocation`/`user-invocable` patched + per-file symlinks to the library), keyed by (skill, mode) and shared across projects. Elided when the override equals the library mode; inert (warn + direct link) for `scope: global` skills or unequipped skills; orphaned variants are cleaned at the end of the project pass. Readlink ownership is unchanged (targets stay under data_home). Library invocation flags are mirrored to `skills.<n>.invocation` by `sync_skill_frontmatter_metadata` (absent = auto; both flags = `conflicted` + warning).
5. **MCP dispatch** uses per-harness adapters. `claude-code` and `pi` share `ClaudeMcpAdapter` (`.mcp.json`) — one write. `codex` uses `CodexMcpAdapter` (`.codex/config.toml` via `tomlkit`, preserving unrelated content). `opencode` uses `OpenCodeMcpAdapter` (`<repo>/opencode.json` `mcp` object — `{type:"local", command:[cmd,*args], environment, enabled}`, merge-preserving JSON; distinct shape from `.mcp.json` so it cannot share the Claude adapter). Skill `harnesses:` affinity also filters MCP writes. **`scope: global` mcp-servers are EXCLUDED from this per-project pass** (`_sync_project_skills` filters them out of `resolved_mcps`) — they are owned solely by the global-MCP pass (5b) to avoid a double-write + Claude's project>user precedence silently shadowing the global entry.
5b. **Global MCP dispatch** (`_run_global_mcp_dispatch`, a dedicated pass parallel to the global-skills pass, part of the MCP stream — NOT gated by `--skip-permissions`): every registry skill with `type=="mcp-server"` and `scope=="global"` is written to each installed harness's **user-global** MCP config via the adapter's `write_global(global_path, specs, prior_managed, harness_id)`. Targets come from a new `Harness.global_mcp_config` field — `claude-code`→`~/.claude.json` (`mcpServers` object, stdio `{command,args,env}` entries), `codex`→`~/.codex/config.toml` (`[mcp_servers.<name>]` tables). **pi and opencode are skipped** (`global_mcp_config is None`, logged with a reason): pi reads project-local `.mcp.json` only, opencode's adapter is project-only — so a global MCP server reaches them only via per-project enable. Each server's `harnesses:` affinity still filters targets. Writes are merge-preserving (every other key/table preserved byte-for-byte), backup-first (`~/.skill-hub/_hub-backups/mcp/<harness>/global/<ts>.<ext>`, **only when the write changes the file**), and atomic (sibling temp + `os.replace`). The Claude writer serializes with `json.dumps(indent=2, ensure_ascii=False)` and preserves the file's existing trailing-newline state (the live `~/.claude.json` has none + non-ASCII bytes) — it does NOT reuse `write()` (which would reformat the whole 88KB file); a re-write of an already-present spec is byte-identical. The Codex writer round-trips via tomlkit on the passed ABSOLUTE path (bypassing `_config_path`). An existing-but-unparseable target ABORTS that harness's write (file untouched, logged). Cleanup is **sidecar-scoped**: hub records its owned names at `~/.skill-hub/state/<harness>/global-mcp.managed.json` and removes only names present in that sidecar that are no longer `scope:global` mcp-servers; if the sidecar is missing/corrupt, cleanup is a NO-OP (warns; never deletes a user-authored server). Idempotent: a second sync with no registry change is a byte-stable no-op.
5c. **Remote dispatch** (`_run_remote_dispatch`, after the global-MCP pass, before per-project skills; **non-blocking**, opt-out `--skip-remotes`): for each `sync_enabled` remote it resolves desired state (`build_remote_desired_state`) → `get_connector` → `health_check` (unreachable/not-ready → log + skip) → `plan` → `apply` with the default allow set `{CREATE, FAST_FORWARD, REMOVE}`. 3-way drift classification (base = ownership sidecar `last_pushed_sha256`); only `local-ahead` auto fast-forwards; `remote-drifted`/`conflict` are reported but **never clobbered** (a TOCTOU re-check before each write aborts if the box drifted between plan and apply). Cleanup/drift only consider sidecar-listed names. **Only an EXPLICIT `hub sync` (or `hub remote sync <id>`) runs this pass — post-mutation auto-syncs skip it.** Every registry mutation (`enable`/`disable`, bundle apply/remove/new/update/delete, project ops, `set-meta`, rename, …) reconciles via `_auto_sync()`, a helper that calls `cmd_sync` with `skip_remotes=True` (permissions + doctor stay ON) so an equip click never blocks on the ~30s live-remote plan; remote push is eventual ("Reconciled on next sync"). The two first-run/full flows (`cmd_bootstrap`, `cmd_migrate_home`) deliberately keep the full `cmd_sync` incl. remote dispatch. The custom private connectors are a separate sibling change living in an excluded `connectors_private/` tree. See `docs/remote-connectors.md`.
6. **Cleanup** walks **every** known harness's `project_skills_dir` (not just the active ones) so disabling a harness removes its orphans.
7. **Permissions dispatch** (third stream, after skills and MCP, opt-out via `--skip-permissions`) runs `permission_adapters.get_adapter(harness.permission_adapter_key)` for the global scope then per project. **Writes are scope-targeted (D1):** the global pass writes `permissions_global` only to user-level files; each per-project pass writes only that project's own block (`resolve_project_own`) — never the merged effective view — so a project native file holds exactly its own rules. `claude-code` and `pi` share `ClaudePermissionAdapter` (different target file per harness id — `.claude/settings.json` vs `.pi/agent/settings.json`); `codex` uses `CodexPermissionAdapter`, which now emits **two** writes per `(codex, scope)`: (a) `~/.codex/config.toml` typed knobs (`approval_policy`, `sandbox_mode`, `[projects."<abs>"].trust_level`), and (b) a hub-owned Starlark **command-rules file** — `~/.codex/rules/skill-hub.rules` (global) or `<repo>/.codex/rules/skill-hub.rules` (project). Each translatable registry `Bash(<cmd…>:*)` rule becomes one `prefix_rule(pattern = [...], decision = "…")` line (`allow→allow`, `ask→prompt`, `deny→forbidden`; multi-word prefixes whitespace-split). Non-Bash tools and unbounded `Bash(*)` stay `SkipReason`. The file is fully regenerated each sync (deterministic → byte-identical re-sync) and Codex auto-discovers it alongside its TUI-owned `default.rules`, which hub never reads or writes during sync. **Writing project command rules auto-grants `trust_level = "trusted"`** and emits a loud warning (sync log + doctor) because trust also activates any committed `.codex/config.toml` + project-local hooks. Hub-managed keys are tracked in per-file sidecars at `~/.skill-hub/state/<harness>/<scope>.managed.json` (config.toml) and `<scope>.rules.managed.json` (the rules file) — the two never clobber. User config files never contain hub metadata. Pre-write backups land at `~/.skill-hub/_hub-backups/permissions/<harness>/<scope>/<timestamp>.<ext>`. `opencode` uses `OpenCodePermissionAdapter`, which writes per-command bash rules into the **same** `opencode.json` the MCP adapter targets (global `~/.config/opencode/opencode.json`, project `<repo>/opencode.json`) under `permission.bash` as an object of space-separated glob prefixes → action (`Bash(git push:*)` → `"git push *"`, kinds map 1:1 `allow`/`ask`/`deny`). Rules are emitted **most-specific-last** to honor opencode's last-match-wins evaluation. Non-Bash tools, unbounded `Bash(*)`, and **all hooks** (opencode has no permission-hook target) stay `SkipReason`. Writes are merge-preserving (only `permission.bash.*` keys are hub-owned); managed keys tracked in the `~/.skill-hub/state/opencode/<scope>.managed.json` sidecar.
8. **Unified reconcile (D3) + cross-harness import**: per-project discovery auto-imports pre-existing native rules into the registry (backup-first, no blocking prompt). Global discovery emits `AdoptionRequired` and halts the **global** stream only; per-project streams continue. The single resolution flow is `hub permissions reconcile` (CLI; Tauri `permissions_reconcile_candidates` + `permissions_reconcile_apply`), which subsumes the older `adopt`/`import` (kept as thin aliases routing into it). Discovery reconciles pre-existing rules across Claude-family settings **and** Codex `default.rules`: same-command/same-decision collapses to one affinity-free rule, divergent decisions surface as conflicts (never auto-picked), un-representable Codex shapes (`match`/`not_match`, pattern unions) are flagged un-importable, and rules hub already manages (per sidecar) are excluded so reconcile is idempotent. **Apply is one transaction per scope**: snapshot registry block + every touched native file → write registry → auto-sync native files via the adapters (same path as sync), **MOVE-excising** each imported/dropped rule from EVERY origin (Claude/Pi `settings.json`, Codex `default.rules` AND `skill-hub.rules`). On any post-registry failure it rolls back the registry block + restores native files from the snapshot — no half-applied state, and no separate `hub sync` needed. Returns `{imported, dropped, kept, conflicts_resolved, synced_files}`. Hub edits `default.rules` ONLY on explicit reconcile import/drop, never during ordinary sync. **De-dup migration:** `hub permissions migrate-scope` (dry-run default, `--apply`) strips global-sourced duplicates left in project native files by pre-D1 installs; `hub sync` emits a non-blocking prompt when it detects residual duplicates.
9. **Doctor rollup** at the tail of the permissions stream runs `risks.detect_risks` against every touched (scope, harness) pair. Findings of `severity = "danger"` cause `hub sync` to exit non-zero even when all writes succeeded.
10. **Agent-docs detection** (read-only pass via `agent_docs.detect_status`, between skills and permissions) flags each project as `ok` / `needs_canonicalization` / `conflict` (divergent `CLAUDE.md` vs `AGENTS.md`), plus a nested-deviation count. It **never** renames, links, or rewrites a root doc — mutation is explicit via `hub agent-docs fix --apply` (one transactional plan per project: root promote/derive/collapse, opt-in nested promotions, legacy `AGENT.md` link cleanup; precondition fingerprints re-verified at apply time, whole-apply abort on mismatch) and `hub agent-docs resolve` for conflict/appendix resolution. Statuses come from the single per-directory verdict model shared by `agent_docs.py` (`classify_directory`) and the Rust scanner (`classify_dir`), pinned by `tests/fixtures/agent_docs_corpus.json`; legacy `AGENT.md` never satisfies the AGENT format. Canonical root = `claude-code → CLAUDE.md`, all other harnesses → `AGENTS.md`; multi-harness ⇒ real `AGENTS.md` + derived `CLAUDE.md` (`symlink` or `import` per `agent_docs.root_strategy`, project override wins); in-app root writes are canonical-by-construction (`write_agent_doc` writes `AGENTS.md` + derives `CLAUDE.md` in one command). Divergent conflicts are **non-blocking** (do not fail sync). See `docs/AGENT-DOCS.md`.
11. **Project-local skill detection** (read-only pass via `scan_project_skill_candidates`, after agent-docs detection) closes the hub's push-only blind spot: a skill hand-authored directly in a project's `.claude/skills/<n>/` (e.g. by Claude Code) is otherwise invisible — not in the registry, never seen by the user-global `scan_import_candidates`, and left untouched by sync cleanup (it's a real dir, not a hub-owned symlink). For each project it walks every known harness's `project_skills_dir` (deduped), flagging real dirs (symlinks skipped) with a parseable `SKILL.md` whose name is **not** already a registry skill or active for the project: `NEW` (importable) vs `INVALID_NAME` (bad slug). It **never** mutates — adoption is explicit via `hub project import-skill <name> --project <p>`, which copies the dir into `data_home/skills/`, registers it (`scope: project-specific`), enables it on the project, and removes the original (only after a verified copy + registry write; the next sync re-creates it as a managed symlink). Non-blocking. (App surfacing of these detections is a deferred follow-up — detection is CLI-only today.)
12. **Sync report** — every `hub sync` writes `<data_home>/state/sync-report.json` (`schema_version: 1`: per-project `ts`/`ok`/`errors`/`writes`/`affinity_skips` + a global summary) atomically on **every** exit path (success or failure). Tauri `sync_report()` returns it alongside a live registry fingerprint; the frontend derives a fresh/stale/unknown/error freshness grammar (`lib/syncFreshness.ts`, `FreshnessBadge`) that drives NavPanel dots, the project sync card, and a StatusBar `SyncReportDrawer`.

## OpenSpec Notes

- This repo may contain valid local changes under `openspec/changes/` that `openspec list` or `openspec status --change <name>` fail to surface.
- If a user names a specific change and the CLI says it is missing, verify the filesystem first: check `openspec/changes/<name>/` before concluding it does not exist.
- If the folder exists, treat it as the source of truth, read its artifacts directly, and use `openspec validate <name> --type change --json` as a secondary confirmation step.
- Do **not** tell the user a change is missing based only on `openspec list`/`openspec status` when the change directory exists locally.

<!-- skill-tree:snippet id=verify-with-tywin v=7 sha=890ecf754b9e -->
Review your code with tywin in agent mode and read the JSON before treating a change as done.

```
tywin check --working --mode agent     # review uncommitted changes (before you commit) — most common
tywin check --mode agent               # review your last commit (HEAD~1..HEAD)
tywin check --base origin/main --mode agent   # review everything since main
```

- **`--working`** reviews your uncommitted work (working tree vs HEAD) — this is the
  "review before I commit" check. `--staged` reviews only staged changes.
- Without `--working`/`--staged`, tywin reviews a **committed** range (default = your last commit).
- `"status":"PASS"` is a real green light — tywin reports `"status":"BLOCKED"` (with the reason in
  `warnings`) if the range was empty, so a no-op review can't masquerade as a clean one. Don't pass
  `--base HEAD` (empty range; use `--working` for uncommitted work).

Needs tywin ≥ 1.3.0 (`tywin update`), `OPENAI_API_KEY` (from `.env`), and for Android `ANDROID_HOME`.
<!-- skill-tree:snippet:end id=verify-with-tywin -->
