# Skill Tree — Design

> A desktop app for managing Claude Code skills, MCP servers, and bundles across local projects. Built around a productivity-first information architecture, dressed in light RPG vocabulary.

---

## 1. Concept

Skill Tree is the management surface for an external skill registry. The user authors and curates **skills** (atomic capabilities, usually a `SKILL.md` + supporting files) and **MCP servers**, organizes them into **bundles** (reusable groups), and **equips** them onto **projects** on disk. A sync step writes the resulting selection into each project's `.claude/skills` and `.agents/skills` folders.

The name leans into gaming slang — *skill tree*, *loadout*, *equipped* — without becoming a costume. The chrome stays in IDE / launcher territory (think Linear × Steam): dense, dark, keyboard-driven, monospaced where it matters. The RPG layer lives in the **vocabulary** and a few targeted visual moves (the optional node-graph view, the loadout-style project workspace) — not in textures, gradients, or ornament.

### Guiding principles

1. **Power-user first.** Keyboard before mouse. Every navigation target reachable from the command palette. No modal jumps unless unavoidable.
2. **One screen per concept.** Library, project, skill editor, bundle editor — each has a clear job. The sidebar shows where you are; the main area shows the thing.
3. **Status is always visible.** A persistent bottom status bar shows registry state, sync state, runtime health, and the palette hint. The user never has to ask "is it working?"
4. **Direct manipulation over forms.** Drag a skill onto a project to equip it. Click a bundle chip to apply it. Inline-edit metadata. Save with ⌘S.
5. **The gaming layer is metaphor, not theme.** Equipping, loadouts, bundles — yes. Glowing magic borders, parchment, scanlines — no.

---

## 2. Vocabulary

| Term | Means |
|---|---|
| **Skill** | A single capability — usually a `SKILL.md` + assets. Has a kind (`SKILL` or `MCP`) and a scope (`global`, `portable`, `project`). |
| **MCP** | A Model Context Protocol server. Treated as a kind of skill — same lifecycle, same equipping model. |
| **Bundle** | A named group of skills the user can apply as a unit. Reusable across projects. |
| **Project** | A folder on disk that the user wants skills equipped on. |
| **Equip / Unequip** | Apply or remove a skill from a project's loadout. Two paths: directly, or by applying a bundle that contains it. |
| **Loadout** | The full set of skills currently equipped on one project (direct ∪ from-bundles). The cards view of the project workspace shows this. |
| **Library** | The full catalog of all skills in the registry. |
| **Sync** | Walk every project and write its current loadout into `.claude/skills` and `.agents/skills`. |

Naming is consistent across UI surfaces, breadcrumbs, command palette items, and toast copy. We deliberately do **not** call the library "Codex" — that collides with the coding-agent product.

---

## 3. Information architecture

```
┌─ Rail ──┬─ Sidebar ──────────┬─ Main ────────────────────────────┐
│ Logo    │ LIBRARY            │  Header (title, crumbs, actions)  │
│ ───     │   ▸ All skills     │  ───────────────────────────────  │
│ List    │ RECENT             │                                   │
│ Folder  │   …                │  Screen body (one of:             │
│ Bundle  │ PROJECTS           │    – Library list                 │
│ Refresh │   ● example-app    │    – Project workspace            │
│ ───     │   ● demo-service       │    – Skill editor                 │
│ ⌘K      │   …                │    – Bundle editor                │
│ Cog     │ BUNDLES            │    – Python-missing error)        │
│         │   ◈ android        │                                   │
│         │   ◇ openspec       │                                   │
│         │   ◉ web            │                                   │
│         │   ⚡ workflow       │                                   │
│         ├────────────────────│                                   │
│         │ Quick jump  ⌘K     │                                   │
└─────────┴────────────────────┴───────────────────────────────────┘
└───────────────── Status bar (runtime · sync · counts · ⌘K) ──────┘
```

- **Rail** is icon-only quick-nav; collapsible via Tweaks. Each icon has the same activation state convention (violet pill).
- **Sidebar** is the primary nav. Groups: Library entry, Recent (auto-populated), Projects, Bundles. Each item carries small metadata: skill count, sync-health dot.
- **Main** owns the screen. Its chrome is the shared `<ScreenHeader>` (see §5.5): row 1 (`.main-header`, 56px) carries identity — title, breadcrumbs, state pill, and the single primary action with all other actions in an overflow kebab; row 2 (`.main-subheader`, 40px) carries view-mode/scope chips, filters, and counts. Both heights are fixed (never min-height) so the header never grows or wraps when content overflows — tails collapse into the overflow menu and chips scroll horizontally instead. Row 2 is **conditional** — a screen with no view modes or filters (e.g. the Bundle editor) renders no second row and jumps straight from the 56px identity bar into content. Below the header, exactly one scroll container owns each visible pane; screen gutters use the `--pad-screen-x` / `--pad-screen-y` tokens (see COMPONENTS.md § Screen layout contract).
- **Status bar** is global, always visible. Single source of truth for runtime/registry health.

### Navigation contract

| From | To |
|---|---|
| Sidebar click | navigate({ screen, id }) |
| Skill row click | open editor |
| Project row click | open project workspace |
| Bundle chip click in workspace | open bundle editor |
| `⌘K` anywhere | command palette → any of the above |
| `/` from any screen | focus the page-local search input |
| Editor back arrow | return to library |

There is no browser-style history stack — we treat this as a Tauri desktop app where each click is a deterministic navigation. "Recent" in the sidebar serves the same purpose as Back in practice.

---

## 4. Screens

### 4.1 Library

The catalog. Everything the user has ever authored or imported, scoped by `global / portable / project`.

**Header controls (left → right):**
1. Title + count tag (`Library · 39 of 40`)
2. Search input (focus with `/`)
3. Kind filter chips: `ALL · SKILL · MCP` (with counts)
4. Bundle filter chips: one chip per bundle, multi-pressable, colored dot per bundle
5. View toggle: list / grid
6. Primary action: `+ New skill`

**Body — list mode:**
- Grouped by scope (`GLOBAL`, `PORTABLE`, `PROJECT`) with sticky section headers
- Each row: scope badge · name (mono) · kind tag · bundle tags · description · row-hover quick actions (preview / edit / equip-on) · equipped-count pip (e.g. "🔌 3") · version
- Click row = open editor; hover reveals the inline actions

**Body — grid mode:**
- Tighter card per skill — same data, fewer columns, scannable at 280px columns

**Empty state:** when filters clear the list, show a centered icon + helper copy.

### 4.2 Project workspace (the hero)

The screen the user spends most time on. Shows one project's full loadout and lets them rearrange it.

**Layout:** `main (1fr) | side panel (320px)`

**Hero strip:** four stat cards across the top.
1. **Equipped** (accent card, violet) — total skill count + breakdown ("8 direct · 2 via bundles")
2. **Skills** — count of `SKILL`-kind, with MCP count as sub
3. **Bundles** — applied count
4. **Sync** — current state ("● up to date", ".claude · .agents aligned")

**Active bundles section:** chips for each applied bundle (icon, name, skill count, ✕-on-hover to remove) followed by a dashed `+ Apply bundle` chip with a popover for the available ones.

**Equipped skills section:** card grid (260px min). Each card:
- Scope badge · name · kind tag (row 1)
- Two-line description (row 2)
- Source indicator: `◆ DIRECT` (amber) or `◆ via android, workflow` (violet) (row 3)
- Drag handle (whole card is draggable)
- Hover-reveal ✕ to unequip (only for direct skills; bundle-provided skills are unequipped by removing the bundle)

**Available side panel:** filterable list of unequipped skills, grouped by scope. Drag to the loadout grid or click to add directly. The loadout grid and the panel are mirror dropzones — drag from one to the other.

**View toggle** in the header: **Loadout** (cards) or **Tree** (node graph).

### 4.3 Tree view

An alternative visualization of the same project, more in the RPG spirit.

- Center: the project as a hub node.
- Inner ring (radius ≈ 22): one node per available bundle. Active bundles are bright, inactive bundles are dimmed-and-dashed-line.
- Outer ring (radius ≈ 40): each active bundle's skills arrayed in an arc around it. Equipped via bundle = violet. Equipped directly = amber. Not equipped = dim outline.
- Lines: solid violet between an active bundle and its skills; dashed grey between inactive bundles and the hub.
- Click a bundle to toggle it on/off; click a skill to toggle direct equip.
- Legend pinned top-left; interaction hint pinned bottom-right.

The tree view is for **scanning** structure, not for fine editing — when the user wants to edit, they're expected to switch to Loadout view.

### 4.4 Skill editor

Two-column: `main (1fr) | side (360px)`

**Main column, top → bottom:**
1. **Metadata grid** — name, scope (select), version, description (full-width textarea), upstream URL
2. **Markdown toolbar** — B / I / H1 / H2 / list / quote / code / link plus right-side line/char count and `⌘P` palette hint
3. **Editor body** — three sub-modes via segmented control in the header:
   - **Edit:** code-area with line numbers and light syntax highlighting for headings / bold / inline code / lists. Transparent textarea over a rendered `<pre>` so caret behavior stays native.
   - **Preview:** rendered Markdown
   - **Diff:** line-by-line diff against the last saved version. Added (green) / removed (red) backgrounds.

**Side column:**
1. **Status** — scope, version, upstream, touched-at, created-at
2. **In bundles** — bundle chips with `+ Add to bundle` action
3. **Equipped on** — every project listed with one of three states: `EQUIPPED` (amber), `VIA BUNDLE` (violet), `OFF` (dim). Lets the user see at a glance who's using this skill.
4. **Danger zone** — archive action, framed in red. Explains the consequence in plain language.

**Header:** back arrow, scope-badge + name + kind tag + UNSAVED indicator if dirty, mode toggle, duplicate, copy path, Save (primary, disabled when clean).

**Save model:** dirty state is explicit (`UNSAVED` pill in title); ⌘S saves; toast confirms.

### 4.5 Bundle editor

Same layout idiom as the skill editor.

**Hero:** colored bundle glyph + name/description inputs + "Applied to" project chips on the right.

**Body:** ordered card grid of skills in the bundle. Each card is numbered (`01`, `02`...) to make the *ordering* visible — bundles apply in declaration order at sync time, so position is semantic. Cards are drag-reorderable; hover ✕ removes a skill.

**Side panel:** filterable skill picker, grouped by scope, with a checkbox per item.

**Danger zone:** delete bundle, with a clear consequence statement ("Skills equipped only through this bundle will no longer be active until re-equipped.")

### 4.6 Command palette

`⌘K` from anywhere.

- Backdrop blur + centered card, 640px wide, ~70vh max
- Single text input, autofocused
- Results grouped by kind: **Actions**, **Projects**, **Bundles**, **Skills** — section headers with counts
- Arrow keys navigate, `↵` activates, `Esc` dismisses
- Each item: icon · name (mono) · hint (right-aligned mute — scope for skills, equipped-count for projects, skill-count for bundles, keybind for actions)
- Footer: kbd legend (↑↓ ↵ Esc) and a `⌘K from anywhere` reminder

### 4.7 Sync states

- **In sync** (green dot): default. Shown in status bar and on the project workspace's Sync stat card.
- **Syncing** (amber pulsing dot): triggered by the Sync button or auto-sync. Toast: "hub sync · writing .claude/skills, .agents/skills…"
- **Out of sync** (amber dot, no pulse): not shown in this prototype but reserved — meant for "project on disk has diverged from registry".
- **Failed** (red dot): rare; surfaced via toast and the status bar segment.

### 4.8 Python-missing error state

The app delegates to a `hub.py` script. When Python 3 isn't on `$PATH`, the main area is taken over by a focused error card:

- Red-bordered card with subtle radial red glow at the top
- Heading with warning icon
- Plain-language explanation of what's broken and why
- The raw shell error in a mono code block: `$ command not found: python3`
- A numbered Fix section
- Two actions: secondary `Continue in degraded mode` and primary `Recheck runtime`

The status bar's runtime segment also flips to red `python 3: not found`, so the bad state is visible even if the user dismisses the error card.

---

## 5. Visual system

> Detailed token-level rules live in `components.md`. This section is the philosophy.

### 5.1 Surfaces

A warm-tinted black ramp: `bg-0` (app shell) → `bg-1` (main) → `bg-2` (panel) → `bg-3` (elevated) → `bg-4` (hover). The warmth (very slight blue→violet tint) sits the dark UI next to the accent color comfortably. No pure black anywhere — pure black on screen reads as a hole.

Subtle violet and amber radial washes in the app background break up the flatness without becoming decorative gradients.

### 5.2 Accent

Every color channel answers exactly one question. Identity (*what* a thing is) is carried by shape — logo, emoji, icon — never by a hue, so the palette stays free to mean state.

The primary accent is **violet** (`oklch(72% 0.18 290)`) and is **fixed** — it is no longer user-swappable. (The accent Tweak was removed: a swappable brand hue silently collided with the status palette, e.g. a green accent made "active" and "synced" the same color.) Violet marks:
- Active nav state · the primary button · the hub in the tree view · focus rings

Secondary accents have semantic roles, not decorative ones:
- **Amber** = directly equipped (the user explicitly chose this) — and nothing else
- **Green** = synced / OK · **Red** = error / danger · **Blue** = informational
- **Cyan** = global-scope skills

**Transitional states use motion + fill, not hue:** syncing pulses a neutral dot, stale/out-of-sync shows a hollow neutral ring, only the settled endpoints (green ok, red error) carry color.

This is **enforced in fact** (as of `ux-narrow-color-polish`): the amber overload was swept out of every status/transitional consumer — remote drift/health, source update-available, harness not-installed/file-missing, snippet outdated/modified/orphaned, and equip/subagent disabled-reasons all render in their correct channel (neutral+motion, blue, or red), never amber. The only non-provenance amber that remains is the two documented legacy registers — `scope.project` and the `RiskBadge` warning tier (a real severity below danger) — plus the equipped "won't sync here" affinity badge, which is a genuine actionable warning, not a transitional state.

**Identity** is its own register: harness marks render as official logos in their brand color (Claude terracotta) or neutral; bundles use their emoji plus a muted identity ramp (`--id-*`, chroma 0.10) that sits visibly below the semantic accents (≥0.12) and above the section-chrome hues (`--sec-*`, 0.06). Three chroma bands, never overlapping, so a color's job is legible at a glance.

**Section chrome:** each rail destination has a low-chroma hue applied only to chrome (rail active pill + screen-header underline) — body content never uses it, so it cannot collide with semantic color.

Accents come from `oklch()` to keep perceptual brightness consistent across the whole system.

### 5.3 Type

- **Sans:** Geist — UI, headings, body
- **Mono:** Geist Mono — skill names, paths, breadcrumbs, tags, kbd, code, anything identifier-like

The mono/sans split is the main visual rhythm of the app. Every skill name, project name, bundle name, file path, version string, and tag is mono. This makes "the things you can act on" visually distinct from descriptive copy at a glance.

Sizes: 11–13px is the working range. 18–24px only for screen titles and stat-card values. No display-size headings; this is a workbench, not a marketing page.

### 5.4 Density

Three densities exposed via Tweaks: `compact` (32px rows), `default` (38px), `cozy` (44px). Padding tokens scale together so the proportions stay right. Default is calibrated for a 14" laptop at native DPI.

### 5.5 Screen header

Every non-takeover screen renders the same chrome above its body: a two-row, slotted header (`<ScreenHeader>`) that's adaptive at the *container* level (not viewport) so it reflows immediately when the rail or sidebar toggles. There is one source of truth — no screen hand-rolls a `.main-header` JSX block.

```
┌─ row 1 — identity (56px, never wraps) ──────────────────────────────────┐
│ [back|leading]  [title block · flex:1 · ellipses]   [state] [primary] [⋯] │
└─────────────────────────────────────────────────────────────────────────┘
┌─ row 2 — workspace bar (40px, optional) ────────────────────────────────┐
│ [view chips → filters → search · overflow-x:auto] [counts / kbd hints]  │
└─────────────────────────────────────────────────────────────────────────┘
```

**Row-1 slots** in source order, with strict rules:

| Slot | Use |
|---|---|
| `back` | Back-arrow only on detail screens (Editor, Bundle). Mutually exclusive with `leading`; `back` wins. |
| `leading` | Identity glyph: project dot, scope badge, bundle glyph, or section icon. 24–28px square. Tells you what kind of thing this screen is about at a glance. |
| `title` | `<h2>`, sans, ellipses on overflow. Mono `nameMono` for proper-noun identifiers (per §5.3). |
| `meta` | Inline secondary identifiers right of the title: `KindTag`, `SourceChip`, count tags. Don't put state here. |
| `crumbs` | One mono dim line under the title (`library / portable / leggo`). **First thing to drop** at narrow container widths. |
| `state` | One `<StatePill>`: `UNSAVED` (amber), `READ-ONLY` (mute), `✓ saved` (green), or `info` (mute). Pinned to the right of the title block. |
| `primary` | Exactly **one** primary button. The screen's main verb (Save / Sync / New skill / Add source). |
| `overflow` | Kebab `⋯` opening a dropdown. **All** other screen-level actions live here — never as siblings of the primary. |

**Row-2 slots** (`subheader`):

| Slot | Use |
|---|---|
| `left` | View-mode chips first, then filter chips, then in-header search. Horizontally scrollable when narrow — never wraps. |
| `right` | Always-pinned ancillary: counts, group-by, density, kbd hints. Never primary or destructive actions. |

Row 2 renders only when the screen has something for it. The Bundle editor has no view modes or filters → no row 2; the page jumps straight from the 56px identity bar into content. An empty row-2 is worse than no row-2.

**Adaptive rules** (CSS container queries on `.app-main`, which is `container-type: inline-size`):

- `<680px` container — page-local search collapses to an icon, expands on focus
- `<560px` — back-arrow loses its label, becomes icon-only
- `<480px` — primary + overflow + remaining ghost buttons lose their labels (icon-only with tooltip), kbd hints hide
- `<420px` — gutters and gaps tighten, title clamps
- `<360px` — crumbs hide entirely (last resort)

These trigger off the actual main-column width, so toggling the rail/sidebar reflows the headers in the same frame — no viewport resize required.

**Per-screen mapping** (the contract for consistency):

| Screen | Leading / back | Title | State | Primary | Overflow | Row 2 |
|---|---|---|---|---|---|---|
| Library | — | "Library" + count | — | New skill | Add project · Manage sources · Sync | search · kind/source/bundle · group-by · view |
| Project | project dot | name + skill count | — | Sync | Edit path · Reveal · Remove | 4 view chips |
| Agent Docs | project dot | name | UNSAVED | Create / Save ⌘S | Refresh · Reveal | 4 view chips (same set) |
| Editor | ← back | scope-glyph + name (mono) + KindTag + SourceChip | UNSAVED / READ-ONLY | Save ⌘S **or** Duplicate-as-local | Duplicate · Copy path · Archive (read-only: Copy upstream · Check source) | mode chips (Edit/Preview/Diff) + line·char count + ⌘P |
| Bundle | ← back | bundle glyph + name + count | UNSAVED | Save ⌘S | Duplicate · Delete | *omitted* |
| Sources | — | "External Sources" + count | — | Add source | Check all · Sync all | type filter chips |
| Permissions (global) | cog scope-glyph | "Permissions" + GLOBAL tag | UNSAVED / ✓ saved | Save ⌘S | Discard · Open doctor · Copy toml · Disable | scope chips (Global + per-project) |
| Permissions (project tab) | project dot | project name | UNSAVED / ✓ saved | Save ⌘S | Discard · Open doctor · Reveal · Copy toml · Disable | 4 view chips (no scope toggle) |

The four **project view chips** (`loadout`, `tree`, `agent-docs`, `permissions`) come from the shared `PROJECT_VIEWS` constant so the Project workspace, Agent Docs, and Project Permissions tab never drift. See COMPONENTS.md § Screen header for the prop signature and the slot order.

### 5.6 Iconography

Inline SVG, 16px viewBox, 1.5px stroke, currentColor. No icon library — every icon lives in `components.jsx`'s `ICONS` map. This keeps the visual language uniform and the bundle small.

Icons are functional, not decorative. A header doesn't get an icon unless that icon means something (e.g. `⚡` for the primary sync action). Every icon has a `title` attribute.

### 5.7 Motion

Mostly absent. Three places we use it:
1. Toasts slide-and-fade in (~250ms cubic-bezier)
2. Detail drawer slides in from the right (~250ms)
3. Syncing dot pulses (1.4s loop)

No hover-bounce, no page transitions, no decorative animation. Productivity apps that feel snappy don't animate things.

---

## 6. Interaction patterns

### Keyboard

- `⌘K` — command palette (toggle)
- `/` — focus current screen's search input
- `⌘S` — save (in editors)
- `Esc` — dismiss palette / drawer
- `↑ ↓ ↵` — palette navigation
- Tab order follows visual order; all interactive elements are real `<button>` / `<input>`.

### Drag & drop

- Skill card → equipped grid = equip (direct)
- Skill card → available panel = unequip
- Skill card in bundle editor = reorder
- Bundle chips are clickable, not draggable — bundles aren't ordered relative to each other (their *contents* are).

### State surfacing

- **Dirty:** UNSAVED pill in the title bar
- **Loading:** amber pulsing dot in status bar; matching toast
- **Success:** green toast, auto-dismiss 3.2s
- **Error:** red toast, longer dismiss; for blocking errors, full-screen error card

### Empty states

Every list has one. They share the same shape: a single icon, a one-line title, a two-line helper. No illustrations, no CTAs unless the empty state is fixable in one obvious action.

---

## 7. Tweaks (in-app variants)

The Tweaks panel (toggleable from the toolbar) exposes:

- **Density** — compact / default / cozy radio
  <br>_(The accent-color swatches were removed — the brand hue is fixed so color can carry meaning; see §5.2.)_
- **Show icon rail** — toggle the left-most rail
- **Try a screen** — quick-jump buttons to each screen (for review)
- **Trigger sync** — fires the sync animation + toast
- **Python missing** — flips the app into the error state

These are not features the end user needs; they're affordances for design review.

---

## 7.5 Permissions UI

The Permissions surface lives next to the existing project tabs and as its
own top-level screen — `Loadout · Tree · Agent Docs · Permissions` per
project, and a `/permissions` route reachable from the IconRail + NavPanel
for the global scope.

**Provenance accents** mirror the same violet/amber pairing that distinguishes
bundle-equipped vs direct-equipped skills, applied to a new domain:

- **Violet** = `via global` — the rule lives in `permissions_global` and is
  shadowing into this project via the resolver. Inherited rows are read-only;
  the `Promote to project` affordance duplicates the rule into the project
  scope (shadow semantics, not untether) so the project copy wins via the
  resolver's `(pattern, kind)` dedup.
- **Amber** = `project` — the rule is defined directly on this project.

The tab uses one unified rule list per scope. Per-harness affinity is
expressed through chips on each row (`HarnessAffinityChips`) — applied
(green) / unsupported (cyan, read-only) / excluded (mute). When an entire
feature category is unsupported by every installed harness, the subsection
shows a `CapabilityPlaceholder` rather than being hidden. Hiding silently
is forbidden.

Risk visualisation reuses the warning/danger accents from the existing
status palette: amber warning / red danger inline `RiskBadge` pills on rule
rows, with a worst-severity badge surfacing in the section header. Risk
detection runs frontend-side from the build-emitted pattern table — no
subprocess per keystroke. The full report is one click away in the
`Permissions doctor` panel.

Explicit-save UX matches `SkillEditor` exactly: `UNSAVED` pill the moment
local state diverges, `⌘S` scoped to focus inside `.permissions-section`,
`Save` button disabled while validation errors are pending, `Discard or
Cancel` modal on navigation away while dirty. There is no autosave anywhere
in the Permissions UI — including for hooks. Hooks are a high-blast-radius
surface and benefit from the same friction as rules.

The off-ramp (`DisableDialog`) is launched from the section overflow menu.
It always shows a dry-run preview rendered from the structured `entries`
list before any filesystem write, and tier-appropriately requires an
`I understand…` checkbox for the `All projects` and `Everything (incl.
global)` targets (no checkbox for `Just this scope`).

## 8. Out of scope / next iterations

- **Multi-select & bulk actions** in the library (e.g. "equip these 5 on this project"). The UI has visual room for it.
- **Diff against upstream** — when a skill has an `upstream` URL, the editor's Diff mode could pull from there. Today it diffs against the last save.
- **Tree view force-directed layout** — the current radial layout collapses when one bundle has many skills. A small force-directed pass would help.
- **Sync conflict resolution** — when a project's `.claude/skills` has been hand-edited, we need a 3-way merge UI. Not yet designed.
- **Light mode** — color tokens are oklch-based and ready; we just haven't authored the surface ramp.
