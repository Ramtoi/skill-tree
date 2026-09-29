import { type ReactNode } from "react";
import { jsx, jsxs, Fragment } from "react/jsx-runtime";

// SVG body fragments for each icon. The wrapping <svg> lives in Icon.tsx.
// All paths target a 16×16 viewBox at 1.5px stroke, currentColor.
// Families: entities · scopes · source-types · states · views · actions · markdown · UI affordances.
// Legacy keys are kept resolving via aliases at the bottom of the ICONS map.

// ─── Entities (hex-based) ──────────────────────────────────────────────────

const skill: ReactNode = jsxs(Fragment, {
  children: [
    jsx("polygon", { points: "8,2 13.2,5 13.2,11 8,14 2.8,11 2.8,5" }),
    jsx("circle", { cx: 8, cy: 8, r: 1.6, fill: "currentColor", stroke: "none" }),
  ],
});

const mcp: ReactNode = jsxs(Fragment, {
  children: [
    jsx("polygon", { points: "8,2 13.2,5 13.2,11 8,14 2.8,11 2.8,5" }),
    jsx("path", { d: "M2 8h1.5M12.5 8H14M5.5 13.5l-.7 1.2M10.5 13.5l.7 1.2" }),
  ],
});

// Bundle — a gem cluster: three skill hexes fused into one honeycomb tile.
// The hexagon means "one skill" everywhere else; multiplying it IS the meaning
// here, so this is the only section glyph allowed to spend it.
const bundle: ReactNode = jsxs(Fragment, {
  children: [
    jsx("polygon", {
      points:
        "5.4,2.7 8,4.2 10.6,2.7 13.2,4.2 13.2,7.2 10.6,8.7 10.6,11.7 8,13.2 5.4,11.7 5.4,8.7 2.8,7.2 2.8,4.2",
    }),
    jsx("path", { d: "M8 4.2v3M8 7.2 5.4 8.7M8 7.2l2.6 1.5" }),
  ],
});

// Project — a quest banner: the planted standard flying over each campaign
// you run. The pennant is the live point (it fills in on the active section).
// The folder stays with scope.project.
const project: ReactNode = jsxs(Fragment, {
  children: [
    jsx("path", { d: "M5.4 2.5v10.8", fill: "none" }),
    jsx("path", { d: "M3.7 13.3h3.4", fill: "none" }),
    jsx("polygon", { points: "5.4,3 12.6,3 10.4,5.5 12.6,8 5.4,8", className: "ic-live" }),
  ],
});

// Source — an ore vein: crystal shards breaking through bedrock. Skills are cut
// gems; Sources is the rock they are mined out of. Ground line shared with
// `library` and `remote` (the world-register icons stand on y13.3).
const source: ReactNode = jsxs(Fragment, {
  children: [
    jsx("polygon", { points: "8,2.6 10.7,7 9.7,13.3 6.5,13.3 5.5,7" }),
    jsx("path", { d: "M8 2.6 7.2 7.2 7.5 13.3", fill: "none" }),
    jsx("polygon", { points: "12.2,8.2 13.8,13.3 10.8,13.3", className: "ic-live" }),
    jsx("path", { d: "M1.8 13.3h12.4", fill: "none" }),
  ],
});

const loadout: ReactNode = jsxs(Fragment, {
  children: [
    jsx("rect", { x: 1.5, y: 2.5, width: 13, height: 11, rx: 1.5 }),
    jsx("rect", { x: 4, y: 5.5, width: 2, height: 2 }),
    jsx("rect", { x: 10, y: 5.5, width: 2, height: 2 }),
    jsx("rect", { x: 4, y: 8.5, width: 2, height: 2 }),
    jsx("rect", { x: 10, y: 8.5, width: 2, height: 2 }),
  ],
});

// ─── Scopes (letter badge + sibling glyph) ─────────────────────────────────

const scopeGlobal: ReactNode = jsxs(Fragment, {
  children: [
    jsx("circle", { cx: 8, cy: 8, r: 5.5 }),
    jsx("path", {
      d: "M2.5 8h11M8 2.5c1.6 2 2.4 3.6 2.4 5.5S9.6 11.5 8 13.5C6.4 11.5 5.6 9.9 5.6 8s.8-3.5 2.4-5.5Z",
    }),
  ],
});

const scopePortable: ReactNode = jsxs(Fragment, {
  children: [
    jsx("rect", { x: 2.5, y: 4.5, width: 11, height: 8, rx: 1 }),
    jsx("path", { d: "M6 4.5V3.5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1" }),
    jsx("path", { d: "M8 7.5v2" }),
  ],
});

// Remote — an expedition tent: the far camp you push supplies (skills) to.
// The doorway is the live point — it lights like a campfire glow on the
// active section. Ground line shared with library/source.
const remote: ReactNode = jsxs(Fragment, {
  children: [
    jsx("path", { d: "M2.9 13.3 8 2.9l5.1 10.4", fill: "none" }),
    jsx("path", { d: "M1.6 13.3h12.8", fill: "none" }),
    jsx("path", { d: "M5.9 13.3 8 8.8l2.1 4.5Z", className: "ic-live" }),
  ],
});

const folder: ReactNode = jsx("path", {
  d: "M1.5 4.5V13a.5.5 0 0 0 .5.5h12a.5.5 0 0 0 .5-.5V5.5a.5.5 0 0 0-.5-.5H7L5.5 3.5h-3a1 1 0 0 0-1 1Z",
});
// scope.project reuses folder (alias).

// ─── Source types (unique origin metaphors) ────────────────────────────────

const sourceLocal: ReactNode = jsxs(Fragment, {
  children: [
    jsx("rect", { x: 2, y: 4, width: 12, height: 3, rx: 0.7 }),
    jsx("rect", { x: 2, y: 9, width: 12, height: 3, rx: 0.7 }),
    jsx("circle", { cx: 4.5, cy: 5.5, r: 0.6, fill: "currentColor", stroke: "none" }),
    jsx("circle", { cx: 4.5, cy: 10.5, r: 0.6, fill: "currentColor", stroke: "none" }),
  ],
});

const sourceGit: ReactNode = jsxs(Fragment, {
  children: [
    jsx("circle", { cx: 4, cy: 4, r: 1.6 }),
    jsx("circle", { cx: 4, cy: 12, r: 1.6 }),
    jsx("circle", { cx: 12, cy: 8, r: 1.6 }),
    jsx("path", { d: "M4 5.6v4.8M5.4 4.6a4 4 0 0 1 5 2.2M5.4 11.4a4 4 0 0 0 5-2.2" }),
  ],
});

const sourceStarter: ReactNode = jsxs(Fragment, {
  children: [
    jsx("rect", { x: 2.5, y: 5.5, width: 11, height: 8, rx: 0.8 }),
    jsx("path", { d: "M2.5 8.5h11M8 5.5v8" }),
    jsx("path", { d: "M5 5.5 8 3l3 2.5M6 3.5c0-1 .9-1.5 2-1.5s2 .5 2 1.5" }),
  ],
});

const spark: ReactNode = jsx("path", {
  d: "M8 2.5v3M8 10.5v3M2.5 8h3M10.5 8h3M4.5 4.5l2 2M9.5 9.5l2 2M4.5 11.5l2-2M9.5 6.5l2-2",
});
// source.litellm reuses spark (alias).

// ─── States (filled dot + redundant inner mark) ────────────────────────────

const stateOk: ReactNode = jsxs(Fragment, {
  children: [
    jsx("circle", { cx: 8, cy: 8, r: 5, fill: "currentColor" }),
    jsx("path", { d: "m5.5 8 2 2 3-4", stroke: "var(--bg-0)" }),
  ],
});

const stateSyncing: ReactNode = jsxs(Fragment, {
  children: [
    jsx("circle", { cx: 8, cy: 8, r: 5, fill: "currentColor", stroke: "none" }),
    jsx("path", { d: "M11 6.5A4 4 0 0 0 5 6M5 9.5A4 4 0 0 0 11 10", stroke: "var(--bg-0)" }),
  ],
});

const stateOutOfSync: ReactNode = jsxs(Fragment, {
  children: [
    jsx("circle", { cx: 8, cy: 8, r: 5 }),
    jsx("path", { d: "m10 6-4 4M6 6l4 4" }),
  ],
});

const stateUpdate: ReactNode = jsxs(Fragment, {
  children: [
    jsx("circle", { cx: 8, cy: 8, r: 5, fill: "currentColor", stroke: "none" }),
    jsx("path", { d: "M8 10.5V6M6 8l2-2 2 2", stroke: "var(--bg-0)" }),
  ],
});

const stateError: ReactNode = jsxs(Fragment, {
  children: [
    jsx("path", { d: "m8 1.5 6.5 11.5h-13z" }),
    jsx("path", { d: "M8 6.5v3.5M8 12v.5" }),
  ],
});

const stateIdle: ReactNode = jsx("circle", { cx: 8, cy: 8, r: 5 });

// ─── Views (framed mini-layouts) ───────────────────────────────────────────

const viewLibrary: ReactNode = jsxs(Fragment, {
  children: [
    jsx("rect", { x: 2, y: 2.5, width: 12, height: 11, rx: 1 }),
    jsx("path", { d: "M2 6h12M5 6v7.5" }),
  ],
});

const grid: ReactNode = jsxs(Fragment, {
  children: [
    jsx("rect", { x: 2.5, y: 2.5, width: 4.5, height: 4.5 }),
    jsx("rect", { x: 9, y: 2.5, width: 4.5, height: 4.5 }),
    jsx("rect", { x: 2.5, y: 9, width: 4.5, height: 4.5 }),
    jsx("rect", { x: 9, y: 9, width: 4.5, height: 4.5 }),
  ],
});
// view.grid = grid alias.

const list: ReactNode = jsx("path", { d: "M2.5 4h11M2.5 8h11M2.5 12h11" });
// view.list = list alias.

const viewTree: ReactNode = jsxs(Fragment, {
  children: [
    jsx("circle", { cx: 8, cy: 8, r: 2 }),
    jsx("circle", { cx: 3, cy: 3, r: 1.3 }),
    jsx("circle", { cx: 13, cy: 3, r: 1.3 }),
    jsx("circle", { cx: 3, cy: 13, r: 1.3 }),
    jsx("circle", { cx: 13, cy: 13, r: 1.3 }),
    jsx("path", { d: "m4.1 4.1 2.5 2.5M11.9 4.1 9.4 6.6M4.1 11.9l2.5-2.5M11.9 11.9 9.4 9.4" }),
  ],
});

const viewDocs: ReactNode = jsxs(Fragment, {
  children: [
    jsx("path", { d: "M3.5 1.5h6L12.5 4.5v10h-9V1.5Z" }),
    jsx("path", { d: "M9 1.5V5h3.5M5.5 8.5h5M5.5 11h5M5.5 6h3" }),
  ],
});

const viewPreview: ReactNode = jsxs(Fragment, {
  children: [
    jsx("rect", { x: 2.5, y: 3, width: 11, height: 10, rx: 1 }),
    jsx("path", { d: "M5.5 3v10" }),
    jsx("path", { d: "M8 5.5h3M8 8h3M8 10.5h2" }),
  ],
});

// Diff: two columns, a minus on the left and a plus on the right — it used to
// share the Split glyph exactly, which only worked while both carried labels.
const viewDiff: ReactNode = jsxs(Fragment, {
  children: [
    jsx("rect", { x: 2.5, y: 3, width: 11, height: 10, rx: 1 }),
    jsx("path", { d: "M8 3v10" }),
    jsx("path", { d: "M4 8h2.5M9.5 8H12M10.75 6.75v2.5" }),
  ],
});

const viewEdit: ReactNode = jsxs(Fragment, {
  children: [
    jsx("rect", { x: 2.5, y: 3.5, width: 11, height: 9, rx: 1 }),
    jsx("path", { d: "M5 6.5h2M5 9h4M5 11h3" }),
    jsx("path", { d: "M10.5 6.5h2v2h-2z" }),
  ],
});

// Split — an editor/preview side-by-side (framed two-pane layout).
const viewSplit: ReactNode = jsxs(Fragment, {
  children: [
    jsx("rect", { x: 2.5, y: 3, width: 11, height: 10, rx: 1 }),
    jsx("path", { d: "M8 3v10" }),
    jsx("path", { d: "M4 6.5h2.5M4 9h2.5M9.5 6.5H12M9.5 9H12" }),
  ],
});

// ─── Actions (stroked verbs) ───────────────────────────────────────────────

// Equip = draw a SWORD (the gaming register's verb): blade wedge from the
// top-left tip, crossguard, grip, pommel. Unequip is the same sword struck
// through, so the pair reads as one gesture.
const equip: ReactNode = jsxs(Fragment, {
  children: [
    jsx("path", { d: "M9.5 11.5 2 4V2h2l7.5 7.5" }),
    jsx("path", { d: "m8.5 12.5 4-4" }),
    jsx("path", { d: "m10.5 10.5 2.5 2.5" }),
    jsx("path", { d: "m12.5 14.5 1.5-1.5" }),
  ],
});

const unequip: ReactNode = jsxs(Fragment, {
  children: [
    jsx("path", { d: "M9.5 11.5 2 4V2h2l7.5 7.5" }),
    jsx("path", { d: "m8.5 12.5 4-4" }),
    jsx("path", { d: "m10.5 10.5 2.5 2.5" }),
    jsx("path", { d: "m2 14.5 12.5-12.5" }),
  ],
});

const sync: ReactNode = jsxs(Fragment, {
  children: [
    jsx("path", { d: "M13.5 4.5A5.5 5.5 0 0 0 3.4 4.7M2.5 8.5A5.5 5.5 0 0 0 12.6 11.3" }),
    jsx("path", { d: "M13.5 2v2.5H11M2.5 14v-2.5H5" }),
  ],
});

const fetch: ReactNode = jsxs(Fragment, {
  children: [
    jsx("path", { d: "M8 2v7M5 6l3 3 3-3" }),
    jsx("path", { d: "M2.5 11v2a.5.5 0 0 0 .5.5h10a.5.5 0 0 0 .5-.5v-2" }),
  ],
});

// Skill-pack share pair. Both reuse `fetch`'s tray so the two directions read
// as one gesture: `export` lifts the arrow out, `import` drops it in.
const exportPack: ReactNode = jsxs(Fragment, {
  children: [
    jsx("path", { d: "M8 9.5V2M5 5l3-3 3 3" }),
    jsx("path", { d: "M2.5 11v2a.5.5 0 0 0 .5.5h10a.5.5 0 0 0 .5-.5v-2" }),
  ],
});

const importPack: ReactNode = jsxs(Fragment, {
  children: [
    jsx("path", { d: "M8 2v7.5M5 6.5l3 3 3-3" }),
    jsx("path", { d: "M2.5 11v2a.5.5 0 0 0 .5.5h10a.5.5 0 0 0 .5-.5v-2" }),
  ],
});

const rescan: ReactNode = jsxs(Fragment, {
  children: [
    jsx("path", { d: "M1.5 8s2.5-4 6.5-4 6.5 4 6.5 4-2.5 4-6.5 4-6.5-4-6.5-4Z" }),
    jsx("circle", { cx: 8, cy: 8, r: 2 }),
    jsx("path", { d: "m12 12 2 2", strokeDasharray: "0.1 1.5" }),
  ],
});

const save: ReactNode = jsxs(Fragment, {
  children: [
    jsx("path", {
      d: "M2.5 2.5h8L13.5 5.5v8a.5.5 0 0 1-.5.5h-10a.5.5 0 0 1-.5-.5V3a.5.5 0 0 1 .5-.5Z",
    }),
    jsx("path", { d: "M5 2.5v3.5h5V2.5M5 9.5h6v4.5H5z" }),
  ],
});

const edit: ReactNode = jsx("path", { d: "M2.5 13.5v-2L11 3l2 2-8.5 8.5h-2Z" });

const eye: ReactNode = jsxs(Fragment, {
  children: [
    jsx("path", { d: "M1.5 8s2.5-4 6.5-4 6.5 4 6.5 4-2.5 4-6.5 4-6.5-4-6.5-4Z" }),
    jsx("circle", { cx: 8, cy: 8, r: 2 }),
  ],
});

const duplicate: ReactNode = jsxs(Fragment, {
  children: [
    jsx("rect", { x: 4.5, y: 4.5, width: 9, height: 9, rx: 1 }),
    jsx("path", { d: "M11.5 2.5h-7a1 1 0 0 0-1 1v7" }),
  ],
});

// Backup is a rail destination, so the crate's latch is its live point (see
// COMPONENTS.md §Icons > Live-point accent). Open path ⇒ explicit fill="none".
const archive: ReactNode = jsxs(Fragment, {
  children: [
    jsx("path", { d: "M2 3.5h12v2.5H2zM3 6v7.5h10V6" }),
    jsx("path", { d: "M6 9h4", fill: "none", className: "ic-live" }),
  ],
});

const trash: ReactNode = jsx("path", { d: "M3 4.5h10M6 4.5V3h4v1.5M4.5 4.5l.5 9h6l.5-9" });

const link: ReactNode = jsx("path", {
  d: "M9 4 11 2a2.5 2.5 0 0 1 3.5 3.5L12.5 7.5M7 12 5 14a2.5 2.5 0 0 1-3.5-3.5L3.5 8.5M5.5 10.5l5-5",
});

const bolt: ReactNode = jsx("path", { d: "m9 1.5-6 8h4l-1 5 6-8H8l1-5Z" });

// Command — the drop-down dev console: framed prompt chevron + input line.
// Landscape aspect keeps it distinct from view.library's near-square panel.
const command: ReactNode = jsxs(Fragment, {
  children: [
    jsx("rect", { x: 1.6, y: 3.4, width: 12.8, height: 9.2, rx: 1.8 }),
    jsx("path", { d: "M4.6 6.4 6.9 8.2 4.6 10", fill: "none", className: "ic-live" }),
    jsx("path", { d: "M8.4 10h2.9", fill: "none" }),
  ],
});

const pin: ReactNode = jsx("path", { d: "M8 2v5l-2 2v1h4v-1l-2-2V2M6 2h4M8 10v4" });

const more: ReactNode = jsxs(Fragment, {
  children: [
    jsx("circle", { cx: 3, cy: 8, r: 0.8, fill: "currentColor", stroke: "none" }),
    jsx("circle", { cx: 8, cy: 8, r: 0.8, fill: "currentColor", stroke: "none" }),
    jsx("circle", { cx: 13, cy: 8, r: 0.8, fill: "currentColor", stroke: "none" }),
  ],
});

// ─── Markdown family ───────────────────────────────────────────────────────

const mdBold: ReactNode = jsx("path", {
  d: "M4.5 3.5h4a2.2 2.2 0 0 1 0 4.4H4.5zM4.5 7.9h4.5a2.3 2.3 0 0 1 0 4.6H4.5z",
});

const mdItalic: ReactNode = jsx("path", { d: "M6.5 3.5h6M3.5 12.5h6M9.5 3.5l-3 9" });

const mdH1: ReactNode = jsx("path", { d: "M3 4v8M3 8h4M7 4v8M11 12V5l-1.5 1" });

const mdH2: ReactNode = jsx("path", {
  d: "M3 4v8M3 8h4M7 4v8M9.5 6.5a1.5 1.5 0 0 1 3 0c0 1.5-3 2-3 4h3",
});

const mdList: ReactNode = jsxs(Fragment, {
  children: [
    jsx("path", { d: "M6 4.5h8M6 8h8M6 11.5h8" }),
    jsx("circle", { cx: 3, cy: 4.5, r: 0.8, fill: "currentColor", stroke: "none" }),
    jsx("circle", { cx: 3, cy: 8, r: 0.8, fill: "currentColor", stroke: "none" }),
    jsx("circle", { cx: 3, cy: 11.5, r: 0.8, fill: "currentColor", stroke: "none" }),
  ],
});

const mdQuote: ReactNode = jsx("path", {
  d: "M4 5c0-1 1-1.5 2-1.5v2c-.5 0-1 .3-1 1 0 1 1 .5 1 1.5v2c-1.5 0-2-1-2-2zM10 5c0-1 1-1.5 2-1.5v2c-.5 0-1 .3-1 1 0 1 1 .5 1 1.5v2c-1.5 0-2-1-2-2z",
});

const mdCode: ReactNode = jsx("path", { d: "m6 5-4 3 4 3M10 5l4 3-4 3" });

// Snippet — a scroll of inscription: rolled at BOTH ends (the double overhang
// is the anti-trash-can cue), ragged text lines in the waist. The only
// text-bearing glyph on the rail.
const snippet: ReactNode = jsxs(Fragment, {
  children: [
    jsx("path", { d: "M4.4 2.5h7.2a1.3 1.3 0 0 1 0 2.6H4.4a1.3 1.3 0 0 1 0-2.6Z" }),
    jsx("path", { d: "M4.9 5.1v5.9M11.1 5.1v5.9", fill: "none" }),
    jsx("path", { d: "M4.4 11h7.2a1.3 1.3 0 0 1 0 2.6H4.4a1.3 1.3 0 0 1 0-2.6Z" }),
    jsx("path", { d: "M6.8 7.3h2.8M6.8 9.1h1.8", fill: "none", className: "ic-live" }),
  ],
});

// ─── Sections (the rail's gaming register) ─────────────────────────────────
// One world, three registers: GROWTH AND PLACES planted on a shared ground
// line at y13.3 (skill tree, quest banner, ore vein, expedition tent),
// ARTIFACTS you carry (gem cluster, scroll), GEAR on the path (fishhook,
// warded shield, great helm). Every section glyph tags exactly one detail
// (or one symmetric pair) with className "ic-live" — the charged point: top
// gem, pennant, keyhole, visor slit, tent doorway… Idle it rides the host's
// text color; inside a `.live-glint` host in selected state, CSS brightens
// it to `--live-accent`, fills closed shapes translucently, and pops it with
// a small spring. Contract in COMPONENTS.md §Icons > Live-point accent;
// open-path live details MUST set fill:"none" so the translucent fill-in
// only ever lands on closed shapes.

// Library — the Skill Tree itself: a rooted, branching tree whose tips carry
// skill gems (diamonds). Everything available, growing in one place. The top
// gem is the live point. Distinct from view.tree's radial network.
const library: ReactNode = jsxs(Fragment, {
  children: [
    jsx("path", { d: "M8 13.3V6M8 9.9 5.4 7.7M8 8.7l2.6-2.1", fill: "none" }),
    jsx("path", { d: "M2.9 13.3h10.2", fill: "none" }),
    jsx("polygon", {
      points: "8,2.6 9.6,4.2 8,5.8 6.4,4.2",
      fill: "currentColor",
      stroke: "none",
      className: "ic-live",
    }),
    jsx("polygon", { points: "4.1,5.9 5.5,7.4 4.1,8.9 2.7,7.4" }),
    jsx("polygon", { points: "11.8,4.8 13.2,6.3 11.8,7.8 10.4,6.3" }),
  ],
});

// Hook — a fishhook: eye, shank, bend, barbed point. Says the section's name
// at first sight and reads as a game item (fishing minigame register).
// Deliberately shares zero geometry with `bolt` (the APPLY verb).
const hook: ReactNode = jsxs(Fragment, {
  children: [
    jsx("circle", { cx: 10.6, cy: 3.1, r: 1.0, className: "ic-live" }),
    jsx("path", { d: "M10.6 4.1v5a3.4 3.4 0 1 1-6.8 0V7.6", fill: "none" }),
    jsx("path", { d: "M3.8 7.6l1.7 1.1", fill: "none" }),
  ],
});

// Permissions — the warded shield: same silhouette the section already owned,
// but a keyhole instead of a checkmark. A check is a verdict; a keyhole is an
// access control. NEW key — `shield` stays the TOFU/trust badge and must not
// be restyled (AddRemoteWizard, RemoteDetail, LocalAgentUsage all wear it).
const permissions: ReactNode = jsxs(Fragment, {
  children: [
    jsx("path", { d: "M8 1.8 13 3.3v4.4c0 3.6-2.6 5.6-5 6.5-2.4-.9-5-2.9-5-6.5V3.3L8 1.8Z" }),
    jsx("circle", { cx: 8, cy: 6.8, r: 1.6, className: "ic-live" }),
    jsx("path", { d: "M8 8.6v2.3", fill: "none", className: "ic-live" }),
  ],
});

// Harness — a great helm: in medieval usage a knight's "harness" IS the armor
// you strap on — exactly what a CLI is to an agent. Rounded crown, eye slit
// (the live point — the visor glows on the active section), breath line.
const harness: ReactNode = jsxs(Fragment, {
  children: [
    jsx("path", { d: "M4.3 13.3V7a3.7 3.7 0 0 1 7.4 0v6.3Z" }),
    jsx("path", { d: "M5.5 8.4h5", fill: "none", className: "ic-live" }),
    jsx("path", { d: "M8 5v8.3", fill: "none" }),
  ],
});

// Usage — a combat trace: the DPS parser line — flat idle, one burst, settle —
// with a filled dot marking the current reading. Frees the `agent` bot head
// for actual agents.
const usage: ReactNode = jsxs(Fragment, {
  children: [
    jsx("path", { d: "M2 9.2h2.8l1.7-4.5 2.4 6.6 1.9-3.5h2.3", fill: "none" }),
    jsx("circle", {
      cx: 13.1, cy: 7.8, r: 0.9, fill: "currentColor", stroke: "none",
      className: "ic-live",
    }),
  ],
});

// Tweaks — the options-menu slider rack: two hairline tracks, stroked knobs on
// OPPOSITE sides (the diagonal rhythm is the tell vs source.local's racks).
// NEW key — `cog` stays the generic configure/manage affordance.
const tweaks: ReactNode = jsxs(Fragment, {
  children: [
    jsx("path", { d: "M2.4 5.2h1.7M7.1 5.2h6.5", fill: "none" }),
    jsx("path", { d: "M2.4 10.8h6.7M12.1 10.8h1.5", fill: "none" }),
    jsx("circle", { cx: 5.6, cy: 5.2, r: 1.5, className: "ic-live" }),
    jsx("circle", { cx: 10.6, cy: 10.8, r: 1.5, className: "ic-live" }),
  ],
});

// ─── UI affordances ───────────────────────────────────────────────────────

const search: ReactNode = jsxs(Fragment, {
  children: [
    jsx("circle", { cx: 7, cy: 7, r: 4.5 }),
    jsx("path", { d: "m10.5 10.5 3 3" }),
  ],
});

const plus: ReactNode = jsx("path", { d: "M8 3v10M3 8h10" });
const x: ReactNode = jsx("path", { d: "m4 4 8 8M12 4l-8 8" });
const check: ReactNode = jsx("path", { d: "m3 8 3.5 3.5L13 4" });

const filter: ReactNode = jsx("path", { d: "M2 3h12l-4.5 6V13l-3 1.5V9L2 3Z" });

// Shield — permission/protection surfaces. Outline + interior check.
const shield: ReactNode = jsxs(Fragment, {
  children: [
    jsx("path", { d: "M8 1.8 13 3.3v4.4c0 3.6-2.6 5.6-5 6.5-2.4-.9-5-2.9-5-6.5V3.3L8 1.8Z" }),
    jsx("path", { d: "m5.8 7.8 1.6 1.6 3-3.4" }),
  ],
});

// Panel-left — toggles the off-canvas NavPanel drawer (narrow window).
const panelLeft: ReactNode = jsxs(Fragment, {
  children: [
    jsx("rect", { x: 2, y: 3, width: 12, height: 10, rx: 1 }),
    jsx("path", { d: "M6 3v10" }),
  ],
});

const drag: ReactNode = jsxs(Fragment, {
  children: [
    jsx("circle", { cx: 6, cy: 4, r: 0.8 }),
    jsx("circle", { cx: 10, cy: 4, r: 0.8 }),
    jsx("circle", { cx: 6, cy: 8, r: 0.8 }),
    jsx("circle", { cx: 10, cy: 8, r: 0.8 }),
    jsx("circle", { cx: 6, cy: 12, r: 0.8 }),
    jsx("circle", { cx: 10, cy: 12, r: 0.8 }),
  ],
});

const chevronRight: ReactNode = jsx("path", { d: "m6 3 5 5-5 5" });
const chevronLeft: ReactNode = jsx("path", { d: "m10 3-5 5 5 5" });
const chevronDown: ReactNode = jsx("path", { d: "m3 6 5 5 5-5" });
const chevronUp: ReactNode = jsx("path", { d: "m3 10 5-5 5 5" });
const arrowLeft: ReactNode = jsx("path", { d: "M13 8H3m0 0 4-4m-4 4 4 4" });
const arrowRight: ReactNode = jsx("path", { d: "M3 8h10m0 0-4-4m4 4-4 4" });
// Four corner brackets pulling outward — "open this in a bigger picture"
// (the session drill-down sheet's `Inspect session` trigger).
const expand: ReactNode = jsx("path", {
  d: "M6 2H2v4M10 2h4v4M2 10v4h4M14 10v4h-4",
});

// ─── Legacy / misc icons (kept for non-breaking resolution) ─────────────────

const cog: ReactNode = jsxs(Fragment, {
  children: [
    jsx("circle", { cx: 8, cy: 8, r: 2, className: "ic-live" }),
    jsx("path", {
      d: "M6.4 1.5h3.2l.4 1.7 1.1.6 1.7-.5 1.6 2.8-1.3 1.2v1.4l1.3 1.2-1.6 2.8-1.7-.5-1.1.6-.4 1.7H6.4L6 12.8l-1.1-.6-1.7.5-1.6-2.8 1.3-1.2V7.3L1.6 6.1l1.6-2.8 1.7.5L6 3.2Z",
    }),
  ],
});

const power: ReactNode = jsx("path", { d: "M5 4.5a4.5 4.5 0 1 0 6 0M8 2v6" });

const star: ReactNode = jsx("path", { d: "M8 2 6.2 6 2 6.5l3 3-.8 4.5L8 12l3.8 2L11 9.5l3-3L9.8 6 8 2Z" });

const globe: ReactNode = scopeGlobal; // alias — globe is reserved for scope.global

// Cloud — a hosted upload surface (claude.ai, ChatGPT web). It gets its own
// glyph because `globe` is spoken for by scope.global: two unrelated meanings
// wearing one shape is exactly the collision the identity register must avoid.
// One closed path on the 16-grid, stroked like every other icon here.
const cloud: ReactNode = jsx("path", {
  d: "M4.8 12.5a2.8 2.8 0 0 1 .2-5.6 3.6 3.6 0 0 1 6.8-.9 2.8 2.8 0 0 1 .2 6.5H4.8Z",
});

const doc: ReactNode = jsxs(Fragment, {
  children: [
    jsx("path", { d: "M3.5 1.5h6L12.5 4.5v10h-9V1.5Z" }),
    jsx("path", { d: "M9 1.5V5h3.5" }),
  ],
});

const plug: ReactNode = jsx("path", {
  d: "M5 6V3M11 6V3M3.5 6h9v3a4.5 4.5 0 0 1-9 0V6ZM8 13.5V15",
});

// Agent — a small bot head: rounded body, antenna, two eyes.
const agent: ReactNode = jsxs(Fragment, {
  children: [
    jsx("rect", { x: 3, y: 5.5, width: 10, height: 8, rx: 2 }),
    jsx("path", { d: "M8 5.5V3M8 3a1 1 0 1 0 0-0.01" }),
    jsx("circle", { cx: 6, cy: 9.2, r: 0.9, fill: "currentColor", stroke: "none" }),
    jsx("circle", { cx: 10, cy: 9.2, r: 0.9, fill: "currentColor", stroke: "none" }),
    jsx("path", { d: "M1.5 8.5v2.5M14.5 8.5v2.5" }),
  ],
});

const warning: ReactNode = jsxs(Fragment, {
  children: [
    jsx("path", { d: "m8 2 6.5 11.5h-13L8 2Z" }),
    jsx("path", { d: "M8 6.5v3.5M8 12v.5" }),
  ],
});

/**
 * Circled "i" — the INFORMATION glyph.
 *
 * The blue channel is information; `warning`'s triangle inside a blue banner
 * said "something is wrong" about sentences that were plain statements of fact
 * ("Restoring skips the import step…"), putting two contradictory signals in
 * one component. Blue banners take this; the triangle stays for actual warnings.
 */
const info: ReactNode = jsxs(Fragment, {
  children: [
    jsx("circle", { cx: 8, cy: 8, r: 6.2 }),
    jsx("path", { d: "M8 7.4v4M8 4.7v.8" }),
  ],
});

const refresh: ReactNode = sync; // alias — same circular arrows

const copy: ReactNode = duplicate; // alias

const heading: ReactNode = mdH1; // legacy: replaced by md.h1
const bold: ReactNode = mdBold;
const italic: ReactNode = mdItalic;
const quote: ReactNode = mdQuote;
const code: ReactNode = mdCode;

const gitDiff: ReactNode = viewDiff;

const sun: ReactNode = jsxs(Fragment, {
  children: [
    jsx("circle", { cx: 8, cy: 8, r: 2.5 }),
    jsx("path", {
      d: "M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.2 3.2l1.1 1.1M11.7 11.7l1.1 1.1M3.2 12.8l1.1-1.1M11.7 4.3l1.1-1.1",
    }),
  ],
});

// Classification working modes: the approved C family, a vertical flow with
// one branch for delegation and a returning branch for mixed work.
const workingInline: ReactNode = jsx("path", { d: "M8 2v11m-3-3 3 3 3-3" });
const workingDelegator: ReactNode = jsx("path", { d: "M8 2v4H3v7m-1-2 1 2 2-2M8 6h5v7m-1-2 1 2 2-2" });
const workingMixed: ReactNode = jsx("path", { d: "M4 2v11m-2-2 2 2 2-2M4 4h8v5H8m2-2-2 2 2 2" });
const output: ReactNode = jsx("path", { d: "M8 3H2v10h6M6 8h8m-3-3 3 3-3 3" });

export const ICONS: Record<string, ReactNode> = {
  // Entities
  skill,
  mcp,
  bundle,
  project,
  source,
  loadout,

  // Scopes
  "scope.global": scopeGlobal,
  "scope.portable": scopePortable,
  "scope.project": folder,

  // Source types
  "source.local": sourceLocal,
  "source.git": sourceGit,
  "source.starter": sourceStarter,
  "source.litellm": spark,

  // States
  "state.ok": stateOk,
  "state.syncing": stateSyncing,
  "state.out-of-sync": stateOutOfSync,
  "state.update": stateUpdate,
  "state.error": stateError,
  "state.idle": stateIdle,

  // Views
  "view.library": viewLibrary, // legacy: unreferenced since the Library section got its own `library` glyph; kept resolving
  "view.grid": grid,
  "view.list": list,
  "view.tree": viewTree,
  "view.docs": viewDocs,
  "view.preview": viewPreview,
  "view.diff": viewDiff,
  "view.edit": viewEdit,
  "view.split": viewSplit,

  // Actions
  equip,
  unequip,
  sync,
  fetch,
  export: exportPack,
  import: importPack,
  rescan,
  save,
  edit,
  preview: eye,
  eye,
  duplicate,
  archive,
  delete: trash,
  trash,
  link,
  apply: bolt,
  bolt,
  command,
  pin,
  more,

  // Snippets
  snippet,

  // Sections (rail destinations with their own glyph)
  library,
  hook,
  permissions,
  harness,
  usage,
  tweaks,

  // Markdown
  "md.bold": mdBold,
  "md.italic": mdItalic,
  "md.h1": mdH1,
  "md.h2": mdH2,
  "md.list": mdList,
  "md.quote": mdQuote,
  "md.code": mdCode,
  "md.link": link,

  // UI affordances
  search,
  plus,
  x,
  check,
  filter,
  shield,
  panelLeft,
  "panel-left": panelLeft,
  drag,
  chevronRight,
  chevronLeft,
  chevronDown,
  chevronUp,
  arrowLeft,
  arrowRight,
  expand,
  "chevron-right": chevronRight,
  "chevron-left": chevronLeft,
  "chevron-down": chevronDown,
  "chevron-up": chevronUp,
  "arrow-left": arrowLeft,
  "arrow-right": arrowRight,

  // Legacy / misc (non-breaking)
  cog,
  power,
  star,
  globe,
  cloud,
  doc,
  folder,
  plug,
  agent,
  remote,
  warning,
  info,
  refresh,
  copy,
  spark,
  list,
  "list-ul": list,
  grid,
  tree: viewTree,
  heading,
  bold,
  italic,
  quote,
  code,
  "git-diff": gitDiff,
  gitDiff,
  sun,
  output,
  "working-inline": workingInline,
  "working-delegator": workingDelegator,
  "working-mixed": workingMixed,
};
