# Skill Tree — Design

> A desktop app for managing Claude Code skills, MCP servers, and bundles across local projects. Built around a productivity-first information architecture, dressed in light RPG vocabulary.

---

## 1. Concept

Skill Tree is the management surface for an external skill registry. The user authors and curates **skills** (atomic capabilities, usually a `SKILL.md` + supporting files) and **MCP servers**, organizes them into **bundles** (reusable groups), and **equips** them onto **projects** on disk. A sync step writes the resulting selection into each project's `.claude/skills` and `.agents/skills` folders.

The name leans into gaming slang — *skill tree*, *loadout*, *equipped* — without becoming a costume. The chrome stays in IDE / launcher territory (think Linear × Steam): dense, dark, keyboard-driven, monospaced where it matters. The RPG layer lives in the **vocabulary** and now also in the **material** — see §1a, Guild × Obsidian.

### Guiding principles

1. **Power-user first.** Keyboard before mouse. Every navigation target reachable from the command palette. No modal jumps unless unavoidable.
2. **One screen per concept.** Library, project, skill editor, bundle editor — each has a clear job. The sidebar shows where you are; the main area shows the thing.
3. **Status is always visible.** A persistent bottom status bar shows registry state, sync state, runtime health, and the palette hint. The user never has to ask "is it working?"
4. **Direct manipulation over forms.** Drag a skill onto a project to equip it. Click a bundle chip to apply it. Inline-edit metadata. Save with ⌘S.
5. **The gaming layer earns real material, not costume.** Equipping, loadouts, bundles carry into how surfaces are built — engraved frames, corner ticks, a lit slot on selection. It stops short of a skin: no parchment, no scanlines, no faux-medieval type. See §1a.

---

## 1a. Material — Guild × Obsidian

Two doctrines, one job each, never both on the same surface:

- **Guild owns container surfaces and borders.** A panel, card, or well is
  near-flat — a crisp hairline, an engraved frame (`--engrave`: a dark gap ring
  plus a faint second line, so a surface reads as *set into* the page, the way
  an inventory slot is), a uniform `--radius-frame` (6px). Corner ticks are the
  state channel: hidden at rest, they wake on hover, stand lit on an equipped
  card (amber = direct, neutral = via-bundle) or a charged stat (violet).
  Selection is a **lit slot** — the whole item's frame brightens in brand violet
  with a soft inner glow — never a left edge stripe.
- **Obsidian owns ambience.** Weight and depth live in the shadow stack, not
  the surface skin: a raised card lifts on hover (`--shadow-lift`), a recessed
  well sinks in (`--shadow-well`), a charged panel gets a glow in its shadow,
  never a beveled gradient. The page ground itself carries a faint violet
  atmosphere.

This is why a container never wears a bevel top-edge or a strong gradient
(that would be Obsidian's job leaking onto a Guild surface), and why weight
never comes from a left-edge color bar (that would be a hairline pretending to
be a status channel). Ornament is also the **state** channel where it appears —
a button's corner ticks, a checkbox's stamp-in, a switch's spinning gem, a
loading control's traced rune border — never decoration sitting apart from
what the control is doing.

Full contracts (exact tokens, per-primitive rules) live in `COMPONENTS.md`.
The session that produced this — every accepted/rejected iteration, with the
reasoning — lives in `DESIGN-LEDGER.md`.

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

- **Rail** is icon-only quick-nav; collapsible via Settings. Each icon has the same activation state convention (violet pill).
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
1. Title + count tag (`Library · 39 of 40`; hidden while the floating bar's active kind is BUNDLES or SNIPPETS — that count would measure the wrong thing)
2. Filter popover (source, bundle, triggering mode, grouping)
3. View toggle: list / grid
4. Primary action: `+ New skill`

**Floating search.** A bottom-docked bar (`<FloatingSearch>`) replaces the old inline search input and the `ALL · SKILL · MCP` chips. It ranks skills, MCP servers, bundles, and snippets together against one query. A skill or MCP hit narrows the list in place. A bundle or snippet hit floats above the bar in a cross-entity stack (kind = ALL) or, once its own kind chip is picked, replaces the list with its own rows in the body — a bundle or snippet name never filters the skill list, it navigates. `/` focuses the bar. Search now also reaches the **body** of every skill and snippet, not just their names, descriptions, and tags — a match found only in a body renders no marks on the row itself but explains itself with a one-line excerpt underneath.

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
   - **Edit:** CodeMirror with line numbers and neutral syntax highlighting. Brightness and weight distinguish headings and emphasis. Accent color marks interaction.
   - **Preview:** rendered Markdown
   - **Diff:** line-by-line diff against the last saved version. Added (green) / removed (red) backgrounds.

**Side column** (tiered by frequency; it never restates the header — see `COMPONENTS.md` §Skill editor side panel):
1. **Durable, on top** — source plaque (source-owned skills only: coordinates + Check / Sync update), IDENTITY (description with its meter in a well that grows with the text and scrolls past ~500 characters; scope as a themed Select whose options carry their reach; version · upstream as key/value rows), FILES (current row = lit slot; Add file leads with the kind — Reference / Script / Asset / Other — and prefixes the folder), USED BY open (projects and bundles as sub-groups of one well; one-line rows, the checkbox is the state, `via <bundle>` in the meta of a bundle-provided row).
2. **Behind a head that states its value** — SUB-AGENTS, RUNTIME (harness affinity chips + one trigger chip row with the consequence of the chosen mode).
3. **On scroll only** — the danger zone: archive, framed in red, consequence in plain language.

**Header:** back arrow, scope-badge + name (edits in place like a project's; the rename is staged and the state slot reads RENAMED until ⌘S) + kind tag, mode toggle, duplicate, copy path, Save (primary, disabled when clean).

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

A subtle violet atmosphere tints the main content ground, and the chrome frame carries its own cast shadow at the seams — see §1a for the material system this feeds (Guild containers, Obsidian ambience).

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

**Identity** is its own register: harness marks render as official logos in their brand color (Claude terracotta) or neutral; bundles use their emoji plus a muted identity ramp (`--id-*`, chroma 0.10) that sits visibly below the semantic accents (≥0.12) and above the section-chrome hues (`--sec-*`, 0.06). Three chroma bands, never overlapping, so a color's job is legible at a glance (one sanctioned derivation: the active rail glyph's live-point glint lifts the section hue to ≈ 0.19 on a single detail — still section chrome's "you are here" job).

**Section chrome:** each rail destination has a low-chroma hue applied only to chrome (rail active pill + screen-header underline + the active glyph's live-point glint) — body content never uses it, so it cannot collide with semantic color.

Accents come from `oklch()` to keep perceptual brightness consistent across the whole system.

### 5.3 Type

- **Sans:** Geist — UI, headings, body
- **Mono:** Geist Mono — skill names, paths, breadcrumbs, tags, kbd, code, anything identifier-like

The mono/sans split is the main visual rhythm of the app. Every skill name, project name, bundle name, file path, version string, and tag is mono. This makes "the things you can act on" visually distinct from descriptive copy at a glance.

Sizes: 11–13px is the working range. 18–24px only for screen titles and stat-card values. No display-size headings; this is a workbench, not a marketing page.

### 5.4 Density

Three densities exposed via Settings: `compact` (32px rows), `default` (38px), `cozy` (44px). Padding tokens scale together so the proportions stay right. Default is calibrated for a 14" laptop at native DPI.

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
| Project | project dot | name (edits in place — `InlineName`, undo toast) + skill count; the path crumb opens Edit path | — | Sync | Edit path · Reveal · Remove | 4 view chips |
| Agent Docs | project dot | name | UNSAVED | Create / Save ⌘S | Refresh · Reveal | 4 view chips (same set) |
| Editor | ← back | scope-glyph + name (mono) + KindTag + SourceChip | UNSAVED / READ-ONLY | Save ⌘S **or** Duplicate-as-local | Duplicate · Copy path · Archive (read-only: Copy upstream · Check source) | mode chips (Edit/Preview/Diff) + line·char count + ⌘P |
| Bundle | ← back | bundle glyph + name + count | UNSAVED | Save ⌘S | Duplicate · Delete | *omitted* |
| Sources | — | "External Sources" + count | — | Add source | Check all · Sync all | type filter chips |
| Permissions (global) | `icon="permissions"` header chip | "Permissions" + GLOBAL tag | UNSAVED / ✓ saved | Save ⌘S | Discard · Open doctor · Copy toml · Disable | scope chips (Global + per-project) |
| Permissions (project tab) | project dot | project name | UNSAVED / ✓ saved | Save ⌘S | Discard · Open doctor · Reveal · Copy toml · Disable | 4 view chips (no scope toggle) |

The four **project view chips** (`loadout`, `tree`, `agent-docs`, `permissions`) come from the shared `PROJECT_VIEWS` constant so the Project workspace, Agent Docs, and Project Permissions tab never drift. See COMPONENTS.md § Screen header for the prop signature and the slot order.

### 5.6 Iconography

Inline SVG, 16px viewBox, 1.5px stroke, currentColor. No icon library — every icon lives in `components.jsx`'s `ICONS` map. This keeps the visual language uniform and the bundle small.

Icons are functional, not decorative. A header doesn't get an icon unless that icon means something (e.g. `⚡` for the primary sync action). Every icon has a `title` attribute.

### 5.7 Motion

Two families. **Chrome motion** (unchanged doctrine) is transitional-state-only
and cheap: toasts slide-and-fade in, sheets/drawers slide from the edge,
a syncing dot pulses. No page transitions, no hover-bounce here.

**Primitive motion** (Guild × Obsidian) is new and is a **state channel**, not
decoration — every instance ties directly to something changing:

- A button loading traces a rune of light around its own frame (conic-gradient
  sweep) instead of only showing a spinner.
- A checkbox check **stamps** in with a small overshoot spring. A switch's gem
  knob spins a half-turn as it slides on.
- Corner ticks on cards/buttons fade and slide 1px on hover — the frame wakes up.
- An equipped card arrives with a brief lift-and-settle.
- The Library's floating search: the chip row rises out of the bar it belongs
  to; reduced motion keeps the fade and drops the rise.

All of it is real `@keyframes`/`transition`. `prefers-reduced-motion: reduce`
turns off the geometric part (slides, spins, lifts, traces) and keeps the
fades. Each animation still stands for one state change — motion never plays
for its own sake.

### 5.8 The life of a mutation — intent, in flight, settled, consequence

Every write a control starts passes through four moments. Each moment has one
fixed voice, and the voice lives **on the control that started the write**,
because that is where the eye already is. This is the motion vocabulary the
primitives in §5.7 belong to; nothing else in the app animates.

| Moment | What it says | Voice | Where |
|---|---|---|---|
| **Intent** | "I heard you" | The control flips at once (optimistic): a checkbox **stamps** its check, a switch's gem **spins** on, a Save button takes its label | The control |
| **In flight** | "Working on it" | A **rune of light traces the frame** of the control or row that started the write, and its icon or checkbox yields to the `Spinner`. Same conic-gradient sweep on a button, a picker row, a card | The control's own frame |
| **Settled** | "Done, and it took" | A short **settled mark** replaces the rune where the eye is — a dim mono word (`synced`) beside the control for a few seconds, a card's lift-and-settle — then the control rests in its new state | Beside the control |
| **Consequence** | "Here is what changed elsewhere" | A success toast whose **title is the verb** (`Added X to android`) and whose **body is the consequence** (`Now on example-app, moon-base`). Reversible writes carry Undo in the toast's action slot | Bottom-right, second channel |

Rules that follow:

- **The frame is the busy channel, everywhere.** A button, a picker row, a
  card: whatever shape started the write traces the same rune. Never a
  spinner floating apart from its control, never a page-level overlay for a
  single row's write (an archive/forget that locks its screen is the one
  exception — see `useSkillRemoval`).
- **Optimistic first, honest after.** The intent flip is instant. If the write
  fails, the control snaps back and an error toast names the failure. Because
  the control already looks finished while the rune runs, the settled mark is
  not optional: it is the beat that tells the eye the wait ended.
- **Settled lands where the eye is.** A toast alone is not feedback for a
  write that took seconds: it appears after the wait, away from the control,
  and is gone in 3.2 s. The settled mark is the primary "it worked"; the
  toast is the consequence, not the confirmation.
- **The toast body answers "and then what?"** State the effect on the rest
  of the system in one line — the projects a bundle add reached, the files an
  export wrote, "Reconciled on next sync" for a remote. A toast with no
  consequence to state has no body.
- **Undo, not confirm,** for anything the same control can reverse (§6 and
  `COMPONENTS.md` §`useUndoableAction`). Confirm is for the irreversible.
- **The global chip is not per-control feedback.** The StatusBar's neutral
  "working…" pulse counts every pending command; it tells the user the app is
  alive, never which write is running or whether it landed.
- **Reduced motion keeps the beats, drops the geometry.** No rune trace, no
  stamp spring, no gem spin, no lift: the control still shows the spinner,
  the settled word still appears, the toast still fades in.

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

The per-write beats are §5.8. The standing signals around them:

- **Dirty:** the unsaved dot rides **on the Save button** (`signal="dot"`), never a separate pill.
- **In flight (one write):** the control's rune trace + spinner (§5.8); a long or multi-step process gets a `ProcessCard` via `trackProcess`.
- **In flight (anything at all):** the StatusBar's neutral-pulse "working…" chip — motion + fill, no new hue — with a "still working" hint after 5 s.
- **Settled:** a dim mono word beside the control for a few seconds, then rest.
- **Success:** green toast, verb title + consequence body, auto-dismiss 3.2 s; Undo in the action slot when the verb is reversible.
- **Error:** red toast, 6 s, headline from the CLI's own output; blocking errors get the full-screen error card.

### Empty states

Every list has one. They share the same shape: a single icon, a one-line title, a two-line helper. No illustrations, no CTAs unless the empty state is fixable in one obvious action.

---

## 7. Global Settings

Settings collects supported app-wide preferences in a centered dialog. It opens
from the shell gear icon, palette, or Cmd+, and preserves the current screen and drafts.
Its 800 × 640px frame stays fixed across sections and shrinks to fit smaller
windows. Content scrolls within the selected section; the header and category
navigation stay visible.
Appearance keeps density, rail visibility, rail labels, and navigator visibility.
Agents contains global membership and Agent Docs linking policy. Controls name
what saving changes and whether a separate Sync or Fix layout action is needed.
Worktrees sets directory and access defaults for newly registered projects, with
an optional backup inclusion switch. Existing project settings remain local to
the project. Usage shares currency, conversion rate, and online pricing with
the Usage screen. Backup shows status and its automatic backup preference;
setup and restore remain on the Backup screen.

Worktree defaults and conversion rates use explicit Save actions. Their drafts
survive category changes; leaving Settings asks whether to discard them.
Pending backend writes prevent dismissal.

Production Settings has no demo controls. Error simulation belongs in preview
fixtures. The brand hue stays fixed so color can carry meaning.

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
(green) / unsupported (cyan, read-only) / excluded (mute). A harness-level
setting (`sandbox_mode`, `approval_policy`, `project_trust`,
`additional_directories`) renders in the view of every harness that honors
it — shared settings (≥ 2 installed harnesses) carry a `HarnessIconGroup`
naming who else honors it — and with **no installed harness at all**, every
setting still renders under All, live and editable: there is no harness to
gate on, so nothing is unsupported yet either. Hiding silently is forbidden.

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

### Project loadout overview

The loadout explains the effective setup and provides shortcuts to its editors.
The project navigator spans both columns below the header, matching the other
project screens. Both the overview and available library begin below it.
Context stays visible on initial entry in short windows. Recorded activity uses
30 UTC days and top-level sessions, with explicit refresh and no scan on visit.
Grouped rows show the source bundle playbook without editing it. Cross-bundle
section reordering is a personal local preference. Shared skills and MCPs remain
in each source section and highlight together on hover or focus, while project
totals count each identity once. Instructions, hooks, permissions and sub-agents
remain reachable through the existing destinations and a project hook Sheet.
