# Components

> Reusable UI primitives across Skill Tree. Single source of truth for visual + behavioral rules. New screens should compose these, not reinvent them.

All components live in `src/components.jsx` unless noted otherwise. Tokens live in `src/styles.css` under `:root`.

---

## Tokens

### Surfaces

| Token | Hex | Used for |
|---|---|---|
| `--bg-0` | `#0b0b10` | App shell, code area, status bar |
| `--bg-1` | `#101017` | Main content surface |
| `--bg-2` | `#15151e` | Panels, inputs, skill cards |
| `--bg-3` | `#1c1c27` | Elevated surfaces, hovered selects, popovers |
| `--bg-4` | `#232331` | Hover state on dark elements |
| `--bg-glass` | `rgba(20,20,28,0.78)` | Backdrop-blurred overlays (palette, toasts, legend) |

### Text

| Token | Used for |
|---|---|
| `--fg-strong` | Titles, primary identifiers |
| `--fg` | Body copy, default text |
| `--fg-mid` | Secondary text, button labels |
| `--fg-mute` | Descriptions, meta, placeholders |
| `--fg-dim` | Labels, counts, section headers |

### Lines

| Token | Used for |
|---|---|
| `--border` | Default 1px hairlines, between rows, panel edges |
| `--border-strong` | Hover state borders, popover borders, kbd |
| `--border-active` | Focused input borders |

### Accents (oklch)

Color answers **one question per channel** — that is the whole system. Identity (what a thing *is*) is carried by shape/logo/emoji, never by a palette hue.

| Channel | Question it answers | Vocabulary |
|---|---|---|
| **Brand** | "Is this interactive / active / focused?" | `--violet` only. **Fixed** — not user-swappable (the accent Tweak was removed). |
| **Status** | "What state is this in?" | `--green` = ok/synced · `--red` = danger/error · `--blue` = informational/update. Transitional states (syncing/stale) carry **no hue** — see below. |
| **Provenance** | "Did I choose this explicitly?" | `--amber` = directly equipped, and nothing else. Via-bundle is neutral text. |
| **Scope** | (legacy, unchanged) | `scope.global` = `--cyan` · `scope.portable` = violet · `scope.project` = amber. |
| **Identity** | "What *is* this thing?" | Shape/logo/emoji + the muted identity ramp. **Never** a semantic accent. |
| **Section chrome** | "Where am I?" | `--sec-*` → `--section`, applied to chrome only (rail pill + header underline). |

| Token | Color | Meaning |
|---|---|---|
| `--violet` / `-2` / `-glow` | `oklch(72–78% 0.18–0.20 290)` | Brand — active, primary button, focus ring. Fixed. |
| `--amber` | `oklch(78% 0.16 75)` | Direct equip ("chosen explicitly"). Not used for status. |
| `--green` | `oklch(76% 0.16 155)` | Synced / OK endpoint |
| `--red` | `oklch(70% 0.20 25)` | Danger / error endpoint |
| `--blue` | `oklch(73% 0.14 245)` | Informational / update available |
| `--cyan` | `oklch(78% 0.12 200)` | Global scope, inline code |
| `--id-0..7` | `oklch(72% 0.10 h)` | **Identity ramp** — per-bundle decoration. `bundleColor(name)` hashes to one. |
| `--sec-*` | `oklch(72% 0.06 h)` | **Section chrome** — one per rail destination, chrome-only via `--section`. |

**Three chroma registers, never overlapping** — this is what keeps a hue's *job* legible at a glance:

- **Semantic** accents: chroma ≥ 0.12 (loud — they mean something).
- **Identity ramp** (`--id-*`): chroma ≈ 0.10 (a quieter, distinct register — decoration).
- **Section chrome** (`--sec-*`): chroma ≈ 0.06 (atmosphere — barely there).

**Transitional states = motion + fill, not hue.** ok = filled green dot · error = filled red dot · syncing = *pulsing* neutral dot · stale/out-of-sync = *hollow* neutral ring · never/idle = hollow dim ring. Amber is never a status color.

**`--section` is consumed by exactly two rules** (the rail active pill and the screen-header underline). Body content must never reference `--section` or any `--sec-*` token — that is what makes section hues structurally unable to collide with the semantic palette. The route→section mapping lives on `.app[data-section]` (set in `App.tsx`).

Color is **always** scoped to meaning, never decorative. If a new use case needs a color, check the channel table first; reach for the identity ramp (not a semantic accent) for anything that is mere identity.

### Geometry

| Token | Value | Used for |
|---|---|---|
| `--radius-sm` | 4px | Inner controls, list-item hover bg |
| `--radius` | 6px | Default — buttons, cards, inputs, chips |
| `--radius-lg` | 10px | Modals, large cards, palette |
| `--radius-xl` | 14px | Reserved for future hero elements |
| `--pad-screen-x` | 24px | Screen-level horizontal gutter (header rows, workspace columns, section headers, code area, side panels) |
| `--pad-screen-y` | 16px | Screen-level vertical spacing; band separation uses `calc(var(--pad-screen-y) * 2)` |

`--pad-x` / `--pad-y` are for *component* internals (chips, buttons, inputs). `--pad-screen-x` / `--pad-screen-y` are for *screen-level* containers — see the Screen layout contract below. Inline `style={{ padding }}` is banned on screen-level wrappers.

### Density (data attribute on `<html>`)

| Attr | `--row-h` | `--pad-x` | `--pad-y` | `--pad-screen-x` | `--pad-screen-y` | `--header-row-1` | `--header-row-2` |
|---|---|---|---|---|---|---|---|
| `data-density="compact"` | 32px | 12px | 8px | 20px | 12px | 52px | 36px |
| (default) | 38px | 16px | 12px | 24px | 16px | 56px | 40px |
| `data-density="cozy"` | 44px | 20px | 16px | 28px | 20px | 60px | 44px |

`--header-row-1` / `--header-row-2` are the two fixed `<ScreenHeader>` rows (see Screen header below). Density flips scale them so the header proportions track the row height.

### Type

| Token | Stack |
|---|---|
| `--font-sans` | `Geist, ui-sans-serif, system-ui, …` |
| `--font-mono` | `Geist Mono, ui-monospace, JetBrains Mono, …` |
| `--font-display` | `Geist` (currently aliased to sans) |

Rule: any string that's a **proper-noun identifier** (skill name, project name, version, path, tag, kbd, code) renders in mono. Everything else is sans.

---

## Icons — `<Icon name="…" tone="…">`

All icons live in `app/src/components/icons.ts`; the `<Icon>` primitive (`app/src/components/Icon.tsx`) wraps them in a 16×16 / 1.5px-stroke / `currentColor` SVG. New screens **never** invent inline SVGs — they reference a key from the inventory.

### 8 families

| Family | Shape DNA | Example keys |
|---|---|---|
| **Entities** | hex-based | `skill`, `mcp`, `bundle`, `project`, `source`, `loadout` |
| **Scopes** | letter badge + sibling glyph | `scope.global` (globe), `scope.portable` (briefcase), `scope.project` (folder) |
| **Source types** | unique origin metaphors | `source.local`, `source.git`, `source.starter`, `source.litellm` |
| **States** | filled dot + redundant inner mark | `state.ok`, `state.syncing`, `state.out-of-sync`, `state.update`, `state.error`, `state.idle` |
| **Views** | framed mini-layouts | `view.library`, `view.grid`, `view.list`, `view.tree`, `view.docs`, `view.preview`, `view.diff`, `view.edit` |
| **Actions** | stroked verbs | `equip`, `unequip`, `sync`, `fetch`, `rescan`, `save`, `edit`, `preview`, `duplicate`, `archive`, `delete`, `link`, `apply`, `command`, `pin`, `more` |
| **Markdown** | editor toolbar | `md.bold`, `md.italic`, `md.h1`, `md.h2`, `md.list`, `md.quote`, `md.code`, `md.link` |
| **UI affordances** | global primitives | `search`, `plus`, `x`, `check`, `filter`, `drag`, `chevron-*`, `arrow-*` |

### `tone` prop

`<Icon tone="…">` maps to the existing accent CSS vars so call sites never set inline `style={{color}}`:

| `tone` | CSS var |
|---|---|
| `violet` | `--violet-2` |
| `amber` | `--amber` |
| `green` | `--green` |
| `red` | `--red` |
| `blue` | `--blue` |
| `cyan` | `--cyan` |
| `mute` | `--fg-mute` |
| `dim` | `--fg-dim` |
| `strong` | `--fg-strong` |

If `tone` is omitted, the icon inherits `currentColor` (the parent's text color). An explicit `style.color` from the caller always wins over `tone` — call sites can override per-instance.

### Semantic color per surface

These pairings are the contract — keep them consistent across screens:

- **Rail/sidebar entity icons are neutral** (inherit `currentColor`); the rail's active item is colored by `--section`, not by an icon tone.
- **Equipped via bundle = neutral**; **equipped directly = amber** (the `◆ DIRECT` provenance chip). Equipped cards share the neutral surface — no provenance-tinted backgrounds.
- **`scope.global` = cyan**; **`scope.portable` = violet**; **`scope.project` = amber**.
- **States**: ok = green, error = red, update = blue, idle = `mute`; **syncing/out-of-sync render neutral** (state shown by pulse + hollow-ring, never amber).
- **`delete` / `unequip` action surfaces = red**.
- **`sync` (write to disk) primary button = violet**; the StatusBar registry chip is the global sync affordance.
- **Permissions surfaces use `shield`**; the `cog` is exclusive to Tweaks.

### Reserved meanings

- `globe` = **global scope only** (`scope.global`). Sources rail, sources screen, and git source type use their own icons — never globe.
- `sync` (circular arrows) = **write a project's resolved loadout to disk**. Other refresh-like ops use `fetch` (pull from upstream) or `rescan` (re-read filesystem).

### Animated state

`state.syncing` is a static SVG; pass `className="icon-state-syncing"` to spin it (1.4s linear infinite, respects `prefers-reduced-motion`).

```tsx
<Icon name="state.syncing" tone="amber" className="icon-state-syncing" />
```

---

## Layout

### `<App>` grid

```
grid-template-columns: 56px (rail) | 240px (sidebar) | 1fr (main)
grid-template-rows:    1fr | 28px (status bar)
```

The rail can be hidden via Tweaks (`showRail: false`), in which case the sidebar takes column 1.

### Two-column main layouts

Used by project workspace, skill editor, bundle editor.

```css
.workspace-grid { display: grid; grid-template-columns: 1fr 320px; height: 100%; }
.editor-grid    { display: grid; grid-template-columns: 1fr 360px; flex: 1; min-height: 0; }
```

Right side is always the contextual / secondary panel. Don't put primary actions in it.

### Screen header — `<ScreenHeader>` (the single source of truth)

Every non-takeover screen mounts **one `<ScreenHeader>`** at the top of its render — no screen hand-rolls a `.main-header` JSX block. It owns the two fixed-height header rows (default 56px + 40px, density-aware via `--header-row-1`/`--header-row-2`).

```tsx
interface ScreenHeaderProps {
  back?: { label: string; onClick: () => void };   // ← arrow. XOR `leading`.
  leading?: React.ReactNode;                        // identity glyph (project-dot, scope-glyph, section icon)
  title?: React.ReactNode;                          // sans
  nameMono?: string;                                // monospace proper-noun identifier
  meta?: React.ReactNode;                           // KindTag, SourceChip, count tags after the title
  crumbs?: React.ReactNode[];                        // mono dim line; use .crumb-path + .path for file paths
  subline?: React.ReactNode;                         // composes after crumbs with a `·`, or renders alone
  state?: React.ReactNode;                           // one <StatePill>, pinned right of the title
  primary?: React.ReactNode;                         // exactly ONE <Button variant="primary">
  overflow?: OverflowMenuItem[];                     // every other screen-level action → kebab
  subheader?: { left?: ReactNode; right?: ReactNode } | ReactNode;  // row 2; omit → no row 2
  className?: string;
}
```

**Slot order (row 1):** `back` / `leading` → `.main-title` (title/nameMono → meta → state) → `.main-header-right` (`primary` then the overflow `⋯`). `back` and `leading` are mutually exclusive; `back` wins.

- **One primary, everything else in overflow.** Each screen shows exactly one `variant="primary"` button; secondary actions are `overflow` items (`{ icon?, label, onClick, kbd?, danger?, disabled?, divider? }`). Omit/empty `overflow` ⇒ no kebab.
- **Bundle glyph:** since `back` and `leading` can't coexist, the bundle editor renders its colored glyph as a node prefixing the title — `title={<span className="bundle-glyph header-bundle-glyph" …>}` + `nameMono={name}` — so it sits after the back arrow, left of the mono name.
- **crumbs + subline compose** on one `.crumbs` line separated by `·`; `subline` alone renders without crumbs.
- **Row 2** renders only when `subheader` is truthy; the `{ left, right }` form fills `.main-subheader-left` / `-right` (right omitted when falsy). A raw node fills the row directly.
- Both rows `padding: 0 var(--pad-screen-x)`, nowrap.

**Container-query adaptivity.** `.app-main` is a `container-type: inline-size` named `appmain`; `@container appmain` rules reflow on the *content-column* width (so toggling the rail/sidebar collapses chrome in-frame, no viewport resize): `680px` collapses the in-header search to an icon, `560px` drops the back-arrow label, `480px` drops right-cluster button labels + kbd hints, `420px` tightens gutters/gaps and clamps the title, `360px` is the last resort that hides crumbs entirely. Button labels are hidable because `<Button>` wraps children in `<span class="btn-label">`.

**Per-screen slot mapping:**

| Screen | back/leading | title / nameMono | meta | state | primary | overflow | subheader |
|---|---|---|---|---|---|---|---|
| Library | — | "Library" | "{filtered} of {total}" | — | New skill | Add project · Manage sources · — · Sync registry | search + kind/SOURCE/BUNDLE groups · GROUP + list/grid |
| Project | project-dot | name | "{n} skills" | — | Sync | Edit path · Reveal · — · Remove | 4 view chips |
| Agent Docs | project-dot | name | — | UNSAVED | Create/Save | Refresh from disk · Reveal | 4 view chips |
| Skill editor | back "Library" | nameMono=name | scope-glyph + KindTag + SourceChip | UNSAVED / READ-ONLY | Save / Duplicate-as-local | Duplicate · Copy path · — · Archive (read-only: Copy upstream · Check source) | Edit/Preview/Diff · lines·chars + ⌘P |
| Bundle editor | back "Library" | bundle-glyph + nameMono=name | "{n} skills" | UNSAVED | Save | Duplicate · — · Delete | — |
| Sources | — | "External Sources" | "{ext} external · {managed} managed skills" | — | Add source | Check all · Sync all | type filter chips |
| Permissions (global) | cog scope-glyph | "Permissions" | GLOBAL tag | UNSAVED / saved | Save | Discard · Open doctor · — · Copy toml · — · Disable | SCOPE group (Global + per-project) |
| Permissions (project tab) | project-dot | project name | — | UNSAVED / saved | Save | Discard · Open doctor · Reveal · — · Copy toml · — · Disable | 4 view chips (no scope toggle) |

The four **project view chips** (`loadout`, `tree`, `agent-docs`, `permissions`) come from the shared `PROJECT_VIEWS` constant (`@/lib/projectViews`), so the Project workspace, Agent Docs, and Project Permissions tab never drift. `ProjectWorkspace` short-circuits `view === "agent-docs"` / `"permissions"` to `AgentDocsView` / `ProjectPermissionsTab`, each of which renders its own `ScreenHeader` carrying those same chips.

**Permissions split.** `PermissionsEditor` is the shared **body** (rules grid + side panel + doctor) — it renders no header. It exposes a `renderChrome?: (chrome: PermissionsChrome) => ReactNode` render-prop projecting its draft state (`dirty`, `saving`, `savedJustNow`, `saveDisabled`, counts, `save`/`discard`/`openDoctor`/`copyToml`/`openDisable`, `scopeOptions`/`onSelectScope`). `GlobalPermissions` renders the cog/"Permissions" header **with** a SCOPE toggle; `ProjectPermissionsTab` renders the project-identity header (project-dot + 4 view chips) **without** one.

#### Header support primitives

- **`<StatePill state icon? children>`** — `state` ∈ `unsaved | readonly | saved | info`. Renders `<span class="state-pill" data-state>` with an optional leading `<Icon>`. `unsaved` = amber border + "UNSAVED"; `readonly` = mute border (usually `icon="link"`) + "READ-ONLY"; `saved` = green, borderless, `icon="check"` + lowercase "saved"; `info` = mute. Passed via the header `state` slot.
- **`<SubheaderViewChips views value onChange>`** — generic over the view id; the canonical view-mode tab row (`.chips` / `.chip[aria-pressed]`, `role="tab"`, optional `<Icon size={12}>` + `.chip-label`). Every multi-view switcher routes through this rather than a bespoke chip row.
- **`<SubheaderGroup label? children>`** — a labelled control cluster in row 2. Optional `label` renders as `.subheader-group-label`; consecutive groups auto-separate via the `+ .subheader-group { border-left }` rule (never add manual separators).

### Screen layout contract

One scroll model app-wide. `.app-main` is `overflow: hidden`, so **exactly one descendant per visible pane scrolls**:

- **Single-column screens** (Library, Sources, GlobalPermissions) wrap body in `.main-body` — the sole scroller. Inner content that needs the gutter uses `.screen-pad` (`padding: var(--pad-screen-y) var(--pad-screen-x)`); never inline `style={{ padding }}`.
- **Two-column screens** use a height-filling grid; each pane (`.workspace-main`/`.workspace-side`, `.code-area`/`.editor-side`, `.perm-main`/`.perm-side`) owns exactly one `overflow: auto`. No grid-level scroll, no `position: sticky` side, no `calc(100vh − X)` magic heights.
- Scrollbars use the single global `::-webkit-scrollbar` rule (grey `--bg-3` thumb). No per-component scrollbar color overrides.
- Screen-level wrappers MUST use `var(--pad-screen-x)` / `var(--pad-screen-y)`. Inline `style={{ padding }}` on `.main-body`, `.main-header`, `.main-subheader`, `.workspace-main`/`-side`, `.editor-main`/`-side`, or `.perm-main`/`-side` is banned (enforced in review + the `layoutContract` test).
- Project workspace groups its main column into `.ws-band` sections (`ws-band-overview`, `ws-band-loadout`, optional `ws-band-agent-docs`) separated by `calc(var(--pad-screen-y) * 2)`.

### Editor side panels — `ResizableSplit`

`BundleManager` wraps `editor-main | editor-side` in `<ResizableSplit fixedPane="right" className="editor-grid" defaultRightPx={360} minRightPx={280} maxRightPx={560}>`, persisting to `localStorage["st:layout:bundle-editor"]`. `AgentDocsView` uses the default `fixedPane="left"` (`st:layout:agent-docs-map`, 220–600). `fixedPane` selects which pane keeps a px width; the other takes `1fr`. Dragging the splitter toward a pane shrinks it; arrows/Home/End adjust the fixed pane. The three document editors (`SkillEditor`, Snippets detail, `SubagentEditor`) do **not** hand-roll this split — they compose `DocumentEditorShell` (below), which owns it.

---

## Document editor platform — `renderMarkdown` · `lineDiff` · `DocumentEditorShell`

The skill / snippet / sub-agent editors share one document-authoring triad (Edit / Preview / Diff / Split). The three pieces below are the frozen contracts (ux-editor-platform D1/D2/D5); consumers customize through **slots**, never call-site overrides.

### `renderMarkdown(md, opts?) → ReactNode` — Preview (`CodeAreaPreview`)

Pure, in-house, two-pass (block then inline) markdown renderer. Returns React nodes only — **never** `dangerouslySetInnerHTML` (no sanitizer surface). Zero inline styles: every construct is a token-driven class under a single `.md-prose` root that owns padding from `--pad-screen-*`.

Supported constructs (the golden fixture list — `lib/renderMarkdown.fixtures.ts`):

| Construct | Output | Notes |
|---|---|---|
| `#`…`######` | `<h1>`…`<h6>` | **no case transform** (text verbatim) |
| `1. 2. 3.` | real `<ol>` (`start=` preserved) | markers restored via `.md-prose ol { list-style: decimal }` (Tailwind Preflight strips them) |
| `-` / `*` / `+`, one nest level | `<ul>` / nested `<ul>` | one indent level only |
| `**b**` `__b__` / `*i*` `_i_` / `` `c` `` | `<strong>` / `<em>` / `<code class=md-code-inline>` | earliest-match, first-rule-wins tie-break (`**` beats `*`) |
| `[t](href)` | `<a class=md-link onClick>` | opens via `opts.onOpenLink ?? openUrl`, `preventDefault`; non-`http(s)`/`mailto` → `.md-link-plain` text, no anchor |
| `> q` | `<blockquote>` | spans consecutive `>` lines |
| ```` ``` ```` fence | `<pre><code>` | no inline markdown inside |
| `---` / `***` / `___` | `<hr>` | block-boundary only |
| text lines | `<p>` | consecutive lines joined |

**Tipping point → adopt `marked`/`react-markdown`** when any of these become requirements: markdown tables, task-list checkboxes, nested lists deeper than one level, reference-style links, raw-HTML passthrough. Until then in-house wins on dep-weight + safety.

### `lineDiff(original, current) → DiffHunk[]` + `isUnchanged(hunks)` — Diff (`CodeAreaDiff`)

Real aligned line diff: common prefix/suffix trim → Myers O(ND) shortest-edit-script on the changed middle → ops with line numbers → hunks with `@@ -a,c +b,c @@` headers. A single inserted/removed line marks **exactly** that line (no index-aligned cascade). `isUnchanged` (no hunks) drives a centered "No changes since last save" empty state. Content-agnostic — **frontmatter-awareness is at the call site**: `SkillEditor` feeds `composeSkillDocument(savedMeta, savedBody)` vs `composeSkillDocument(currentMeta, body)` (`lib/composeSkillDocument.ts`, mirrors `build_skill_document`) so metadata edits (name/description) appear in the diff. Rendering is token-styled (`.diff-hunk-header`, `.diff-line[data-kind]` → `--green`/`--red`/`--fg-mid`), monospace, `overflow-x:auto`.

### `<DocumentEditorShell>` — the shared editor chrome

Owns the mode chips (`SubheaderViewChips`), the `UNSAVED` pill (`StatePill`), the `⌘S`/Save affordance (the shell owns the keydown listener — consumers stop hand-rolling it), the editor|side-panel `ResizableSplit`, the soft-wrap footer `Toggle`, and the split-mode width gate. Invents no new primitive. Key props (full contract in `DocumentEditorShell.tsx`):

- `content` / `onContentChange` / `readOnly` / `editorRef` — the editable text (CodeMirror handle for the toolbar).
- `mode` / `onModeChange` / `modes?` — `DocMode = "edit" | "preview" | "diff" | "split"`.
- `previewSource?` (default `content`) / `diffOriginal` / `diffCurrent?` (default `content`) — Preview + Diff sources.
- `dirty` / `onSave` / `saveDisabled?` — the Save affordance.
- Slots: `toolbar` (markdown toolbar; hidden when `readOnly` or non-edit mode), `sidePanel` (right pane), `dangerZone` (under the side panel), `headerExtras` (beside the chips), `footerExtras` (beside the wrap toggle).
- `splitStorageKey` — the editor|side-panel `ResizableSplit` key; `softWrapDefault?` (default true).

**Split-view breakpoint rule:** the `split` mode (side-by-side Edit | Preview) is offered **only** when the editor pane measures ≥ `--bp-nav` (680px), via a `ResizeObserver`. Below that the Split chip is hidden and an active split falls back to `edit` — no layout thrash.

**Stays screen-owned (D-NONUNIFY):** the shell wraps **only** the document-editing pane. `MasterDetail` is not extracted — Snippets keeps its own master list + selection; the shell wraps only its detail pane. The sub-agent guided form + raw-YAML escape hatch are the sub-agent's `sidePanel` — the guided↔raw toggle, YAML/TOML validation, and format switching stay in `SubagentEditor`, never in the shell.

---

## Buttons — `<Button variant size icon kbd onClick>`

| Variant | Background | Border | Text | Use |
|---|---|---|---|---|
| `ghost` *(default)* | transparent | hairline | mid | Default action |
| `soft` | `--bg-2` | none | mid | Slightly elevated |
| `primary` | violet gradient | violet 60% | white | One per screen — the screen's primary action |
| `danger` | transparent | red 35% | red | Destructive |

Sizes: `sm` (4×8, 11.5px), `md` (6×10, 12.5px, default), `lg` (9×14, 13px).

Props:
- `icon` — name from the `ICONS` map; rendered 13–14px to the left of children
- `kbd` — small inline kbd hint after the label (`<Button kbd="⌘S">Save</Button>`)
- `busy` — **the one per-control pending affordance.** While true the button
  swaps its icon for a leading `<Spinner>`, hard-disables itself, adds
  `.is-loading`, and exposes `aria-busy`. Use it on the control that triggered
  an in-flight mutation (`<Button busy={saving}>`); leave sibling controls
  interactive. `LoadingButton` and `ConfirmDialog busy` route through this same
  visual, and `DocumentEditorShell` exposes a `saving` prop that drives the Save
  button's `busy`. This is the single busy pattern — do not hand-roll spinners on
  buttons. (The *global* in-flight signal is separate: every `invoke` goes
  through `@/lib/ipc`, which counts pending commands into the store so the
  StatusBar shows a debounced neutral-pulse "working…" chip — motion+fill, no new
  hue — with a calm "still working" hint after 5s.)

**Rules:**
- Exactly **one** primary button per screen. Multiple primaries fight for attention and turn the screen into noise.
- Don't use color (e.g. red text) to communicate state on a ghost button; that's the danger variant's job.
- Buttons always have a visible label *or* a `title` attribute. Icon-only buttons require `title`.

### One-primary-per-screen (system rule)

The primary channel is **brand violet = one action per screen**. A `ScreenHeader`
carries at most one `primary` Button; everything else is `ghost`/`soft`, or lives
in the overflow menu. Dialogs are their own "screen": a `ConfirmDialog`/`Sheet`
footer has exactly one primary/danger confirm plus a ghost cancel. This is why
status badges, toggles, and chips **never** use violet — violet is spoken for.

---

## Toggle — `<Toggle checked onChange variant size disabled label indeterminate>`

The **one** brand-violet control (D2). Four hand-rolled accent colors (green
sub-agent enable, terracotta harness enable, violet tool checks, browser-blue
skill checks) collapse into this. A real `<input type="checkbox">` carries a11y /
focus / keyboard (`Space` toggles); the skin is painted with tokenized
pseudo-elements over the hidden input via `accent-color: var(--violet)`.

- `variant="checkbox"` (box + check, default) or `"switch"` (pill track + knob) —
  same semantics + keyboard.
- `size="sm" | "md"`.
- `label` — optional inline label; wraps the control in a `<label>` so clicking
  the label toggles. Omit `label` to render the bare control (e.g. inside an
  existing `<label>` row) and pass `ariaLabel`.
- `indeterminate` — tri-state for "some selected" pickers (checkbox only; applied
  via a ref effect, DOM-only).

**Rule:** every checkbox / switch in the app is a `Toggle`. No ad-hoc
`accent-color`, no bespoke check squares. On = violet (the active channel).

---

## Overlays — `<Modal>` + `<ConfirmDialog>` / `<Sheet>` presets

One overlay implementation (D3): portal, backdrop scrim, focus-trap, `Esc` /
backdrop dismiss, restore-focus-on-close, `role="dialog"` + `aria-modal`, and a
width rendered as **`min(width, 92vw)`** so no dialog overflows a narrow window.

- **`<Modal open onClose title width footer initialFocus dismissable side>`** —
  the base. `side="center"` (default) or `"right"` (sheet). Title renders in the
  head with a close-x; pass `aria-label` when the title is a non-string node.
- **`<ConfirmDialog … onConfirm title body blastRadius confirmLabel tone busy
  confirmDisabled>`** — consequence prompt. `tone="danger"` → red confirm; `busy`
  → spinner + disabled + non-dismissable; `confirmDisabled` gates the confirm on
  a precondition (e.g. a dry-run resolved + a "yes I understand" toggle). Put the
  blast-radius / consequence content in `blastRadius`.
- **`<Sheet side width …>`** — form / wizard container (Modal preset). `side="right"`
  for step wizards (AddRemoteWizard), `"center"` for New-X forms.

Consumers: ConfirmDialog ← BundleManager delete, DisableDialog, snippet
remove/delete, remote remove/clear; Sheet ← NewSubagentSheet, AddRemoteWizard;
Modal base ← PermissionsDoctorPanel, the project add/edit-path/remove dialogs.
No dialog owns its own inline-styled backdrop any more.

**Stays distinct (D-NONUNIFY):** `CommandPalette` (single-instance glass command
surface) is **not** a Modal preset. Its only overlap with Modal is Esc-close.
(`DetailDrawer` was removed in `ux-narrow-color-polish` — it had zero consumers.)
`TipsTour` (first-run coach-marks) is **not** a Modal either: it is a non-modal
overlay — the page stays fully interactive, there is no scrim and no focus trap,
so it falls outside Modal's contract. It shares only Esc-close.

---

## StatusBadge — `<StatusBadge channel shape motion icon>` + presets

Every status badge is the same shape (D4): a small pill / dot / ring carrying a
semantic state through **hue register + shape + motion, never brand violet**.

- `channel`: `ok`→green · `info`→blue · `warn`→amber · `error`→red · `neutral`→fg-mid.
- `shape`: `pill` (filled, default) · `dot` (color dot + label) · `ring` (outline).
- `motion`: `none` (default) · `pulse` (transitional states; dropped under
  `prefers-reduced-motion`).

Presets map a domain enum → these props and own their labels / icons / tooltips:
`StatePill` (core), `DriftBadge`, `RiskBadge`, `SnippetStatusBadge`. They keep
their exported names/APIs so call sites don't change.

### Badge vocabulary (the map every preset obeys)

| Family | channel(s) | shape | motion | context / notes |
|---|---|---|---|---|
| `StatePill` | warn / neutral / ok | pill | none | editor title state (UNSAVED / READ-ONLY / ✓ saved) |
| `DriftBadge` | ok · info · error · neutral | pill / (pulse) | pulse (drift) | remote 3-way drift; transitional drift is neutral+pulse, conflict is error |
| `RiskBadge` | error (danger) / warn (warning) | pill | none | permission risk; `warn` = a real severity tier (below danger) |
| `SnippetStatusBadge` | ok / neutral | pill / ring | pulse (outdated·modified) | applied=ok; outdated/modified=neutral ring+pulse (stale); orphaned=neutral |
| `FreshnessBadge` | ok / error / neutral | dot | pulse (stale) | sync freshness (`ux-truth-sync-signal`) |
| affinity "won't sync here" | warn | pill | none | equipped skill whose harness affinity excludes the project (a real, actionable mismatch) |

**Amber is provenance-only, enforced in fact (`ux-narrow-color-polish`).** `--amber`
means "directly equipped" and nothing else, except the two documented legacy
registers `scope.project` and `RiskBadge` warning-tier. The former amber-overload
(snippet outdated/modified, remote drift/health, source update-available, harness
not-installed, disabled-reasons) was swept to its correct channel — transitional →
neutral+motion (`FreshnessBadge` grammar), update → blue, unreachable/absent →
neutral, auth-fail/invalid → red. The `warn` channel keeps `--amber` for the two
genuine severity/actionable uses only (`RiskBadge` warning, affinity mismatch).

---

## Responsive — named breakpoints + collapse ladder (D7/D8)

`@container`/`@media` conditions can't interpolate `var()`, so the scale is a
**named convention** (a legend comment in `App.css`), not literal custom props:

| Name | px | Meaning |
|---|---|---|
| `--bp-micro`   | 360 | single-column, icon-only chrome |
| `--bp-tight`   | 420 | drop secondary meta; mono titles cap width |
| `--bp-stack`   | 480 | two-column → stacked; grids → 1 col |
| `--bp-compact` | 560 | meta-grid → 1 col; counts collapse |
| `--bp-nav`     | 680 | rail / search collapse to icons |

**Collapse ladder (identity drops last):** every responsive surface sheds
elements in this order as width shrinks — `actions → counts/timestamps → meta
chips → description → identity (name/title) never, until the surface itself
stacks`. `ScreenHeader` is the canonical example: the `48 lines · 1796 chars`
count hides first, then meta chips, and the mono title's flex priority is raised
so identity truncates last.

---

## Chips — `.chips` + `.chip[aria-pressed]`

A row of mutually-exclusive or multi-select toggles, rendered in a single padded shell with 1px border. Used for:
- Library kind/bundle filters
- Loadout / Tree view switch
- Edit / Preview / Diff mode switch

A chip has:
- Optional leading `Icon` (13px) or colored `.dot`
- Mono label (11.5px, uppercase letter-spacing 0.02em)
- Optional trailing `.count` (10.5px, dim)

`aria-pressed="true"` raises the bg one step and adds an inset hairline. The active state is **never** the primary color — only positional weight.

---

## Tags — `<Tag color kind size>`

A pill-shaped meta label. Three kinds:

| Kind | Behavior |
|---|---|
| `soft` *(default)* | Tinted bg (color-mix 14%), color-colored text |
| `solid` | Full color bg, dark text |
| `outline` | Transparent bg, color-mix border |

Sizes: `sm` (9.5px, 2×5 padding), `md` (11px, 3×7).

Specializations:
- `<KindTag kind="SKILL|MCP">` — semantic kind labels for skills
- `<ScopeBadge scope="global|portable|project">` — single-letter square badge (18×18), G/P/·

Always mono, always uppercase, always 0.04–0.05em letter-spacing.

---

## Search input — `.search-input`

A composed input with leading icon, text field, and trailing `/` kbd hint.

```jsx
<div className="search-input">
  <Icon name="search" />
  <input placeholder="Search…" />
  <span className="slash">/</span>
</div>
```

Hairline border, `--bg-2` background. Focus state moves border to `--border-active` and bg to `--bg-3`. Min-width 280px; collapses under that only in panels.

Always pair with the `/` global hotkey. The kbd hint isn't decorative — it has to work.

---

## Resource row / card — `<ResourceRow>` / `<ResourceCard>` (the shared list anatomy)

The one generic for "a list of configured things with a status". Every list
row and grid tile composes it via slots — **never a fork** (D5). SkillRow /
SkillCard are the reference presets; new surfaces pass slots, they don't
re-implement the anatomy.

```tsx
<ResourceRow
  glyph={…}      // identity: ScopeBadge / section icon / bundle glyph / emoji
  name="…"        // mono proper-noun identifier (always --font-mono)
  meta={…}        // inline identifiers after the name (KindTag, source chip, count tags)
  desc={…}        // one-line description; truncates BEFORE the name does
  badges={…}      // right-aligned status badges (StatusBadge presets)
  actions={…}     // hover/focus-revealed action buttons
  onClick selected layout="row"|"card"
/>
<ResourceCard … />   // = ResourceRow layout="card"
```

Anatomy (identity **truncates last**): `glyph · mono name · inline meta · one-line
desc · right-aligned badges · hover-revealed actions`. Rules:

- Root is a `div role="button"` (not a native `<button>`) when `onClick` is set,
  so nested action buttons stay valid DOM; Enter/Space activate.
- `row` = full-width list line (name/meta/desc on one line); `card` = grid tile
  (head row + clamped desc + footer + corner actions).
- Surface-specific state rides the `dataset` prop (`data-*`), not bespoke markup
  (e.g. SkillCard's `equipped`/`via`/`dim`).
- **Presets, not absorption** (D5): SkillRow keeps its resolved-count / bundle-tag
  logic and maps it onto the slots, so skill-domain code never leaks into the
  generic. Model any new surface the same way.

The `.resource-row` / `.resource-card` base owns padding, hover, selected stripe,
identity-last truncation, and the hover-reveal of `.resource-actions`. Presets
layer only their extras (e.g. `.skill-card[data-equipped]` borders).

---

## Skill row — `.skill-row` (ResourceRow preset)

The standard row in the library — a thin preset of `<ResourceRow>`. Grid layout: `18 (badge) | 1fr (name + tags + desc) | row-actions | equipped-pip | version`.

- 38px default row height (scales with density)
- Bottom hairline; hovered = `--bg-1` + violet 4% mix
- Selected row gets a left violet stripe and `--bg-1` + violet 10% mix
- Row-action buttons (preview, edit, equip) only appear on hover — preserves scan-ability of the row at rest

Equipped-pip shows count of projects using this skill: green styling when >0, neutral when 0.

---

## Skill card — `.skill-card` (ResourceCard preset)

A thin preset of `<ResourceCard>`. Used wherever a skill is rendered as a tile (project workspace, bundle editor, library grid view).

```
[scope-badge] [name (mono, ellipsed)]    [kind tag]
[two-line description (ellipsed)]
[source indicator] · · · · · · [version]
```

State data-attrs:
- `data-equipped="true"` — amber border, amber-tinted bg
- `data-via="bundle"` — violet border, violet-tinted bg
- `data-dim="true"` — 55% opacity (not equipped, in tree view)

Hover-reveal `.equip-toggle` in the top-right corner (22×22 square). The equipped state controls its icon and color.

Cards are draggable; the whole card is the drag target. `draggable` HTML attr; payload is `text/skill` = skill id.

---

## Stat card — `.stat-card`

Used in the project workspace hero strip.

```
LABEL (mono, 10.5px, dim)
24px display value
sub-text (mono, 11px, mute)
```

Variant: `.stat-card.accent` — violet diagonal gradient bg + violet border. Use sparingly — only the *primary* stat per screen.

Min-width 180px in a `repeat(auto-fit, minmax(180px, 1fr))` grid.

---

## Bundle chip — `.bundle-chip`

Tile representation of a bundle. Used in the project workspace, the editor side panels, and bundle hero "Applied to" lists.

```
[colored icon square] [bundle name (mono)] [· skill count] [✕ on hover]
```

Sister component: `.bundle-chip-add` — a dashed-border equivalent that opens a popover with selectable bundles. Click reveals a floating menu, not a full modal.

---

## Sidebar item — `.side-item`

The base nav row in the left sidebar.

```
[glyph (16px slot, icon OR health dot OR bundle icon)] [name (1fr, ellipsed)] [row-hint] [pin*] [count (mono, dim)]
```

States:
- Hover: `--bg-2` bg, fg promoted to `--fg`
- `aria-current="true"`: violet horizontal gradient bg, fg promoted to `--fg-strong`, small violet dot stamped at far right

Project items use the `.health` dot in the glyph slot — green/amber/grey based on `lastSync` (red when source-status=error). Bundle items use the bundle's icon character in that slot, colored.

Modifiers (combinable): `.is-compact` (smaller font + tighter padding, used for source rows), `.is-muted` (color shifts to `--fg-mute`, used for `All sources`), `.is-pinned` (used inside `.side-group.is-featured`).

The `.pin` button hover-reveals on the row; once pinned it stays visible amber. `.health[data-state]` accepts `"ok" | "stale" | "never" | "error"` (mapping to green / amber / dim grey / red).

---

## Nav primitives (internal) — `SideRow`, `SideSection`

> Colocated in `app/src/components/NavPanel.tsx`. Not promoted to `components/` yet — they have a single consumer and a richer-than-typical prop surface. Promote on the second consumer.

### `<SideRow>` — one navigator row

| Prop | Type | Notes |
|---|---|---|
| `leading` | `ReactNode` | the 16px slot (health dot, glyph, icon) |
| `name` | `string` | row label |
| `count` | `number?` | mono count badge on the right |
| `active` | `boolean?` | sets `aria-current="true"` for the violet gradient state |
| `onClick` | `() => void` | row activation |
| `onPin` | `() => void?` | toggles pin; hover-reveal star |
| `pinned` | `boolean?` | pinned state for the star icon |
| `showPin` | `boolean?` | default `true`; pass `false` for non-pinnable rows like `All sources` |
| `compact` | `boolean?` | adds `.is-compact` |
| `muted` | `boolean?` | adds `.is-muted` |
| `hint` | `ReactNode?` | small `.row-hint` text between name and pin (used for pin-kind label) |
| `title` | `string?` | tooltip (used for project path / bundle description) |

Renders as a `<button>`. The pin click `stopPropagation`s so it does not also fire the row activation.

### `<SideSection>` — one collapsible group

| Prop | Type | Notes |
|---|---|---|
| `title` | `string` | group label (mono, uppercase via CSS) |
| `count` | `number` | count badge right of title |
| `collapsed` | `boolean` | controlled by parent (persisted in `localStorage["st:sb:collapsed"]`) |
| `onToggle` | `() => void` | both clicking the header *and* the chevron call this |
| `onAdd` | `() => void?` | renders `+` icon in header (right side) when not collapsed |
| `addTitle` | `string?` | tooltip for the `+` button |
| `variant` | `"featured"?` | amber-tinted card treatment for the `Pinned` group |
| `quiet` | `boolean?` | dims the title color — used for `Sources` |
| `summary` | `string?` | summary chip text shown next to title **only when collapsed** |
| `summaryTone` | `"ok" \| "warn" \| "error"?` | drives the chip color via `.tone-*` class |
| `showFilter` | `boolean?` | renders the search icon in the header |
| `filterOpen` | `boolean?` | controls whether the filter input row is visible |
| `onToggleFilter` | `() => void?` | toggles `filterOpen` |
| `filter` | `string?` | filter input value |
| `onChangeFilter` | `(v: string) => void?` | filter value updater |
| `children` | `ReactNode` | the rows; wrap in `.side-group-items` automatically |

When `collapsed`, the body, filter input, `+` button and search icon are all unmounted (not just hidden) so `aria-expanded` stays accurate and we don't pay the render cost.

---

## Section header — `<SectionHeader label count right level>`

Sticky header for grouped lists (library scope groups, palette result groups, editor side-panel sections).

```
LABEL · count                                    right slot
```

11px mono, 0.14em letter-spacing, uppercase. Color `--fg-mid` (label) and `--fg-dim` (count). Sticky to the top of its scroll container; gradient fade-out on the bg so content scrolling under it doesn't look harsh.

---

## PowerPips — `<PowerPips on total color>`

A row of small dots representing a level / fill state. Used for indicating something like "3 of 7 projects have this equipped". Off-pips are dim grey; on-pips use the passed `color` (default violet).

Not the same thing as a skill row's equipped pill — that's a textual count. Pips are for at-a-glance density.

---

## Kbd — `<Kbd>⌘K</Kbd>`

Small monospace key cap. 11px, 1×5 padding, double-thick bottom border for the slight 3D look. Used in:
- Palette footer ("↑↓ ↵ Esc")
- Button labels via the `kbd` prop
- The status bar palette hint
- The sidebar Quick Jump card

Never use a Kbd for purely decorative purposes — if there's a keybind shown, it must work.

---

## Field — `.field` (label + input/textarea/select)

The basic form unit in editors.

```
LABEL (mono, 10px, 0.12em letter-spacing, uppercase, --fg-dim)
[input / textarea / select]
```

Inputs share styling: `--bg-2` bg, hairline border, 7×10 padding, 6px radius. Focus brings border to `--border-active` and bg to `--bg-3`. Textareas use mono font (these are mostly markdown / paths).

`.field-full` spans full grid width in a `.meta-grid` layout.

---

## Code area — `.code-area`

The shared monospace canvas used by:
- Skill editor (Edit mode)
- Markdown preview (Preview mode)
- Diff view (Diff mode)
- Python error screen's command sample

12.5px mono, 1.55 line-height, `--bg-0` background. In Edit mode, a transparent textarea is layered over a rendered `<pre>` so we get caret + selection from the textarea and syntax highlighting from the `<pre>`. Highlight colors come from the same accent palette:
- `--red` for `#` heading
- `--green` for `##` heading
- `--amber` for `**bold**`
- `--cyan` for `` `code` ``
- `--violet-2` for list markers

Diff lines use `color-mix` tints of green / red on top of the bg.

---

## Toast — `<ToastHost toasts>` + `useToasts()`

Floating notifications, bottom-right.

```jsx
const { toasts, push } = useToasts();
push({ kind: 'success', title: 'Saved', body: 'brainstorm v1.0.0', duration: 3200 });
```

Kinds: `info` (default), `success` (green border), `error` (red border). Each toast has an icon, a title (12.5px, strong), and an optional mono body (11.5px, mute). Slide-up-and-fade entry; auto-dismiss after `duration` (default 3.2s).

The host renders a stacked column; multiple toasts stack from the bottom.

---

## Command palette — `<CommandPalette open onClose onNavigate ...>`

Source: `src/palette.jsx`.

- Backdrop: blurred `rgba(5,5,10,0.55)`
- Card: 640px max-w, 70vh max-h, glass bg, large radius
- Head: command icon + input + Esc kbd
- List: result groups (Actions / Projects / Bundles / Skills), section headers, items with icon + name + hint
- Foot: keybind legend

Behavior contract:
- `⌘K` toggles
- Arrow keys navigate; `↵` activates; `Esc` dismisses
- Hover sets the active row (mouse and keyboard stay in sync)
- Input auto-focuses on open, cleared on each open
- Items always render a `hint` — for skills it's the scope; for projects it's the equipped count; for actions it's the keybind

When adding new commands, register them once in the items builder. Don't create alternate ways to reach the same destination — the palette should be the canonical universal accessor.

---

## Detail drawer — `.detail-drawer`

A right-sliding drawer over the main area. Reserved for inspect-without-leaving-the-list patterns (e.g. preview a skill from the library without losing scroll position).

Width 420px, slides in from the right with a 250ms cubic-bezier transition. Has `.detail-head`, `.detail-body`, `.detail-foot` slots. Currently used in mockups; if we ship it, treat it as a peek view — anything substantive happens on the full editor screen.

---

## Tree view — `.tree-canvas` + `.tree-node` + `.tree-bundle`

The radial graph in the project workspace.

- Canvas: subtle dot grid bg (radial-gradient), full container
- SVG layer absolutely positioned, `viewBox="0 0 100 100"` so positions are percentages
- Nodes positioned via `left/top` percent, translated by `(-50%, -50%)`
- `.tree-bundle` — round hub (86×86), shows glyph + name + skill count
- `.tree-node` — pill (110px wide), shows ellipsed skill name + optional `MCP` flag
- State via `data-equipped="true|bundle|false"` — amber / violet / dim

Lines render in SVG with `vectorEffect="non-scaling-stroke"` so they stay 1.4–1.6px regardless of viewBox scaling.

---

## Empty state — `.empty-state`

Common shape across every list that can be empty.

```
[icon, 28px]
[H3 title]
[short helper paragraph]
```

Centered, ~60px top/bottom padding. No buttons unless there is a single obvious next action (e.g. "+ New skill" on an empty library).

---

## Error card — `.error-card`

Full-screen blocking error pattern (Python missing). Centered card with red border + subtle radial red glow at top.

```
[Heading: ⚠ Title]
[Plain explanation (mute)]
[Mono command/output sample]
[FIX section heading]
[Numbered list of steps]
[Action row: secondary + primary]
```

Used only when the user **cannot proceed** with normal app use. Recoverable errors get toasts, not cards.

---

## Status bar — `.app-status`

Persistent bottom bar (28px tall). Segments separated by gap, mono 11px, mute color. Each segment is a `.status-segment` with an optional `.dot` (state via `data-state`).

Segments (left → right):
1. **Runtime state** — green/amber/red dot + label
2. **Registry path** — folder icon + path
3. **Runtime** — device icon + version
4. (filler)
5. **Counts** — skills / bundles / projects
6. **App version**
7. **⌘K palette** — clickable, opens palette

This bar is the canonical state surface. Anywhere else (toasts, badges, etc.) only mirrors what's here.

---

## Permissions primitives

Live in `app/src/components/`, one file per primitive. All use tokens from
`App.css`; no inline color literals. Identifiers (patterns, harness ids,
file paths) render in `var(--font-mono)`; prose in `var(--font-sans)`.

| Primitive | Contract |
|---|---|
| `PermissionRow` | One row per rule. Props: `rule`, `installedHarnesses`, `harnessLabels`, `capabilities`, `validation`, `risks`, `onChange`, `onDelete`, `onPromote`, `readOnly`. Renders kind badge (`allow` green / `deny` red / `ask` amber), mono pattern input, `HarnessAffinityChips`, provenance pill (violet=`via global`, amber=`project`), inline `RiskBadge`s, delete affordance. Inherited rows render read-only with `Promote to project` affordance (tooltip: *Copy this global rule into the project. The global rule stays in effect for other projects; here, your copy wins.*) |
| `HarnessAffinityChips` | Compact chips per installed harness. Three states: `applied` (green) / `unsupported` (cyan, read-only) / `excluded` (mute). Collapses to a single `all` pill when affinity is null and every chip would be applied. Click toggles applied ↔ excluded. |
| `RiskBadge` | Inline pill: amber (warning) or red (danger). `code` rendered in mono; tooltip carries the explanation + optional detail. |
| `CapabilityPlaceholder` | Dimmed `Not supported by <labels>` block with `--cyan` accent, used when an entire feature subsection is unsupported by every installed harness. Never hide a feature silently. |
| `AdoptionDialog` | Modal listing discovered rules grouped by harness. Three actions: `Import` (primary) / `Replace` / `Skip (mark unmanaged)` — each fires `permissions_adopt --global`. Only blocks the global editor; per-project auto-imports surface via `ImportedBanner`. |
| `DisableDialog` | Modal wrapping `permissions_disable`. Target selector (`Just this scope` / `All projects` / `Everything (incl. global)`), mode selector (`Restore from backup` / `Detach`), per-harness checkboxes, dry-run preview rendered from the structured `entries` list, tier-appropriate `I understand` checkbox (none on Just this scope; softer copy on All projects; strict copy on Everything). |
| `PermissionsDoctorPanel` | Modal listing `RiskBadge` rows for every finding from `permissions_doctor`. Click-through scrolls + focuses the offending `PermissionRow`. |
| `ImportedBanner` | Inline banner shown on the project Permissions tab when a recent auto-import has populated the project's permissions block. Dismissal is keyed on `(project, harness, last_import_timestamp)` in `localStorage` — a new import always re-shows the banner. |

The `PermissionsEditor` composite (`app/src/components/PermissionsEditor.tsx`)
hosts these primitives, owns the staged-edits `useState`, the `UNSAVED` pill,
the ⌘S handler scoped to `.permissions-section`, and the explicit-save flow
(`permissions_set` over stdin). It is reused verbatim by `GlobalPermissions`
and `ProjectPermissionsTab`.

## Hooks

| Hook | Purpose |
|---|---|
| `useToasts()` | Returns `{ toasts, push }`. Use everywhere notifications fire. |
| `useTweaks(defaults)` | From the Tweaks starter. Returns `[t, setTweak]`. The `EDITMODE-BEGIN/END` block in `app.jsx` is the source of defaults. |
| `usePermissions(scope, mounted)` | React-Query lazy fetch (`enabled: mounted`, `staleTime: 30s`). Bind `mounted` to a `useState(false)` flipped true once the Permissions section actually renders — no upfront fetch. |
| `usePermissionCapabilities()` | Long-lived query (`staleTime: Infinity`-ish). Returns `Record<HarnessId, PermissionFeature[]>`. |
| `usePermissionsDoctor(mounted)` | Doctor panel data. Gated by the panel's own open state. |
| `usePermissionRisksSchema()` | Static schema from the build-emitted `risks.generated.json`. Drives `detectRisks` in `app/src/lib/permissionsRisks.ts`. |

---

## File map

| File | What's in it |
|---|---|
| `src/data.jsx` | Mock skill / bundle / project arrays + helpers (`effectiveSkills`, `projectsForSkill`, etc.) |
| `src/components.jsx` | `Icon`, `Tag`, `KindTag`, `ScopeBadge`, `Button`, `Kbd`, `PowerPips`, `SectionHeader`, `ToastHost`, `useToasts`, the `ICONS` map, `KIND_META`, `SCOPE_META`, `BUNDLE_COLOR` |
| `src/library.jsx` | `LibraryScreen`, `SkillRow` |
| `src/project.jsx` | `ProjectScreen`, `TreeView` |
| `src/editor.jsx` | `EditorScreen`, `CodeArea`, `MarkdownPreview`, `DiffView` |
| `src/bundle.jsx` | `BundleScreen` |
| `src/palette.jsx` | `CommandPalette`, `PythonErrorScreen` |
| `src/app.jsx` | App shell, routing, tweak wiring, keyboard handlers, side panel, status bar |
| `src/styles.css` | All tokens + component CSS |
| `tweaks-panel.jsx` | Starter — host protocol + tweak controls (panel, sections, sliders, toggles, radios, color, button) |

When adding a new screen, the rule of thumb: drop a `src/<screen>.jsx` exporting one component to `window`, add a script tag to `Skill Tree.html`, and wire it through `src/app.jsx`'s view-switch and the command palette.

## Voice & copy

The house voice for every user-facing string (labels, buttons, toasts, empty states, tooltips, aria-labels). One rule per line; when in doubt, match an existing peer surface.

- **Harness, never "agent," for a sync target.** Skills sync into *harnesses* (claude-code / codex / pi / opencode); "agent" is reserved for the AI and sub-agents. E.g. `won't reach any harness` — not `won't reach any agent`.
- **Equip / apply / sync are the locked verbs.** Equip a skill, apply a bundle, sync the registry. Never "install" for those (install is only harnesses-on-machine + app updates), never "activate" or "manage" for equip. E.g. `Register a project to equip skills and apply bundles to it`.
- **Sentence case for every button, label, and title.** Only the first word (and proper nouns) capitalize. E.g. `Remove project`, `Add project`, `Update path` — not `Remove Project`.
- **No terminal period in EmptyState / StatCard titles.** The title is a fragment; the sentence-with-period lives in the description. E.g. title `No matching skills`, description `Try clearing the search…`.
- **Error toasts: `Couldn't <verb> <object>` in the title, detail in the body.** Never a subject-less `Failed:`; never `Could not` (use the contraction). E.g. `toast.error("Couldn't equip skill", String(err))`. For `addToast(kind, msg)` use the `title — body` split: `Couldn't sync — ${err}`.
- **Don't wrap identifiers in ASCII quotes in toast text.** Toasts can't render mono, so `'…'` is just noise — state the bare name. E.g. `Registered project ${name}` — not `Registered project '${name}'`.
- **Identifiers render in `var(--font-mono)` wherever the surface can style them** (skill/project/bundle/version/path/kbd). In plain-text toasts that can't, drop styling and quotes both.
- **Show-don't-tell guardrail.** If a badge, color, count, or an adjacent banner already conveys a state, don't also spell it in per-item text. E.g. the affinity banner already says "won't reach any harness," so the per-card badge is an icon-only ⚠ (meaning carried by `ariaLabel`/`title`), not the words `WON'T SYNC HERE`; a direct-provenance card shows the amber `◆` marker, not `◆ DIRECT`.

# COMPONENTS.md addendum — ux-command-layer

> Merge target: `COMPONENTS.md`. Documents the command layer (chords, cheatsheet,
> palette verbs, undo, list-nav). All CSS lives in `app/src/styles/command-layer.css`
> (imported from `main.tsx`), not `App.css`.

## Keymap registry (single source of truth)

`app/src/lib/keymap.ts` exports one static `KEYMAP: KeyBinding[]`. It is the ONE
place a chord binding, its label, its display `hint`, and its `run` handler live
together. Three consumers derive from it and nothing else defines a chord or
renders a chord hint:

- `useChords(KEYMAP, ctx)` (`hooks/useChords.ts`) — the window keydown handler.
- `ShortcutCheatsheet` — the `?` overlay, generated from `KEYMAP`.
- Palette `Kbd` hints — via `hintForBindingId(id)`.

**Invariant (tested, bidirectional):** every `KEYMAP` entry exposes a callable
`run` AND every rendered chord hint maps back to a registry entry. A missing
handler or an orphan hint fails `keymap.test.tsx`. This is the structural
guarantee that a shown keybind actually fires (it kills the class of bug that
forced change 1 to delete fake hints).

`KeyBinding`: `{ id, keys[], label, group, hint, when?, run(ctx) }`. `keys` are
discrete tokens (`["g","l"]`, `["g","P"]` for shift, `["c","s"]`); `hint` is
display-only and never re-parsed. `when` defaults to `"not-typing"` (inert while
an input/textarea/contenteditable/`[role=textbox]` is focused); `"always"` is
reserved for globally-owned keys. `KeymapCtx = { navigate, openPalette(verbId?),
lastProjectRoute(), firstBundleRoute() }`.

Default set: `g l/p/b/h/s/n/r` navigation, `g ⇧p` Permissions (case-sensitive
second key), `c s`/`c b` create, `?` cheatsheet. `⌘K`/`/`/`⌘S`/`Esc` stay owned
by App.tsx/screens and render as a **static** "Global" block in the cheatsheet —
NOT registry entries — so the entry↔handler test stays exact for the chords the
registry governs.

**Chord machine** (`useChords`): idle → pending(prefix) → dispatch/cancel, ~1.2s
timeout. A lone modifier keydown (`Shift`/`Control`/`Alt`/`Meta`) never cancels a
pending prefix (so `g ⇧p` works). The captured prefix surfaces on the shared
store (`chordPending`) → a subtle StatusBar chip + an `aria-live="polite"`
region; the chip's pulse is dropped under `prefers-reduced-motion`.

## Palette stage machine (verbs with arguments)

The command palette is a tiny stack machine over its existing grouped list.
`app/src/lib/paletteVerbs.ts` exports `PALETTE_VERBS` + types. A **verb** entry
(label ends `…`) pushes an argument stage instead of navigating; `run` fires once
every argument is picked, then the palette closes.

- `PaletteArgSpec.kind`: `"list"` reuses the palette option-list (arrow/enter +
  filter); `"text"` swaps in a validated slug input (`SLUG_RE`, Enter-to-continue).
- Header renders a `verb › picked… › stage-title` **breadcrumb**.
- **Esc pops exactly one stage**, clearing a non-empty search first (mirrors
  `EquipPicker`'s Esc grammar), never straight to root and never closing mid-flow.
- Verbs: `equip-skill` (skill→project, undoable), `apply-bundle` (bundle→project,
  undoable), `new-snippet` (validated name → snippet create route),
  `open-project-tab` (project→tab → `/project/<p>?tab=…`). Equip/apply route
  their terminal action through `useUndoableAction`; option lists derive equip
  state (`equipped`/`via bundle`) so rows read honestly.
- The palette **Sync** action routes through the shared `useRunSync` (one sync
  code path — no divergent local invalidations).

## `useUndoableAction` + the reversible-vs-destructive rule

`hooks/useUndoableAction.ts` expresses the reversible half of a mutation as a
forward/inverse verb pair: `{ do, undo, label, undoLabel?, invalidate[] }`. On
`do()` success it invalidates keys and pushes a success Toast whose **action slot**
runs `undo()` (then re-invalidates); an undo failure surfaces an error toast. The
undo window is exactly the toast duration — no undo store, no multi-level stack.
It wraps the *committed* verb pair, so it composes with change 3's optimistic
hooks (which own cache state).

**Rule:** reversible edits get **undo-instead-of-confirm**; destructive edits
keep **ConfirmDialog + blast radius**.

| Reversible → undo | Destructive → keep ConfirmDialog |
|---|---|
| equip / unequip skill↔project | delete bundle |
| bundle apply / remove ↔project | archive skill |
| snippet remove↔apply (plain block) | remove project |
|  | snippet remove of a *modified* block (discards in-file edits) |

Undo is a convenience over an already-reversible verb, not a safety net — that is
what confirm is for on destructive paths (guarded by a delete-bundle regression
test).

## `useListNav` (roving focus)

`hooks/useListNav.ts` — a reusable hook (not a component) so each list keeps its
own row markup. `{ count, onOpen, onSecondary?, orientation? }` →
`{ activeIndex, setActiveIndex, itemProps(i), containerProps }`. `j`/ArrowDown +
`k`/ArrowUp move the active row (roving tabindex), `Enter`=`onOpen`, `e`=
`onSecondary`, Home/End jump. The keydown binds on the **list container**
(focus-scoped) and ignores text-field targets, so it never competes with the
window chord handler or a focused filter input. Library is the proof consumer:
`onOpen` opens the skill, `onSecondary` opens the skill→projects `EquipPicker` on
the focused row (the same picker the row's equip button opens).
