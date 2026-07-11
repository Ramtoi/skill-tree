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

const bundle: ReactNode = jsxs(Fragment, {
  children: [
    jsx("polygon", { points: "5,2 8.7,4 8.7,8 5,10 1.3,8 1.3,4" }),
    jsx("polygon", { points: "11,6 14.7,8 14.7,12 11,14 7.3,12 7.3,8" }),
  ],
});

const project: ReactNode = jsxs(Fragment, {
  children: [
    jsx("path", {
      d: "M1.5 5V13a.5.5 0 0 0 .5.5h12a.5.5 0 0 0 .5-.5V6a.5.5 0 0 0-.5-.5H8L6.5 4h-4a1 1 0 0 0-1 1Z",
    }),
    jsx("circle", { cx: 6.5, cy: 10, r: 1.3 }),
    jsx("circle", { cx: 10.5, cy: 10, r: 1.3 }),
  ],
});

const source: ReactNode = jsxs(Fragment, {
  children: [
    jsx("path", { d: "M2.5 3.5h11l-1 4h-9z" }),
    jsx("path", { d: "M2.5 7.5h11l-1 4h-9z" }),
    jsx("circle", { cx: 5, cy: 9.5, r: 0.7, fill: "currentColor", stroke: "none" }),
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

// Off-machine surface: a node at the base with two broadcast arcs rising from it.
const remote: ReactNode = jsxs(Fragment, {
  children: [
    jsx("circle", { cx: 8, cy: 11.5, r: 1.8 }),
    jsx("path", { d: "M5.2 8.7a4 4 0 0 1 5.6 0M3.2 6.7a6.8 6.8 0 0 1 9.6 0" }),
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

const viewDiff: ReactNode = jsxs(Fragment, {
  children: [
    jsx("rect", { x: 2.5, y: 3, width: 11, height: 10, rx: 1 }),
    jsx("path", { d: "M8 3v10" }),
    jsx("path", { d: "M4 6.5h2.5M4 9h2.5M9.5 6.5H12M9.5 9H12" }),
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

const equip: ReactNode = jsx("path", {
  d: "M5 2v3M11 2v3M3.5 5h9v3a4.5 4.5 0 0 1-9 0V5ZM8 12.5V15",
});

const unequip: ReactNode = jsxs(Fragment, {
  children: [
    jsx("path", { d: "M5 2v3M11 2v3M3.5 5h9v3a4.5 4.5 0 0 1-9 0V5Z" }),
    jsx("path", { d: "m2 14 12-12" }),
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

const archive: ReactNode = jsxs(Fragment, {
  children: [
    jsx("path", { d: "M2 3.5h12v2.5H2zM3 6v7.5h10V6" }),
    jsx("path", { d: "M6 9h4" }),
  ],
});

const trash: ReactNode = jsx("path", { d: "M3 4.5h10M6 4.5V3h4v1.5M4.5 4.5l.5 9h6l.5-9" });

const link: ReactNode = jsx("path", {
  d: "M9 4 11 2a2.5 2.5 0 0 1 3.5 3.5L12.5 7.5M7 12 5 14a2.5 2.5 0 0 1-3.5-3.5L3.5 8.5M5.5 10.5l5-5",
});

const bolt: ReactNode = jsx("path", { d: "m9 1.5-6 8h4l-1 5 6-8H8l1-5Z" });

const command: ReactNode = jsx("path", {
  d: "M5 3.5A1.5 1.5 0 1 1 3.5 5H5Zm0 0V11m0 0A1.5 1.5 0 1 1 3.5 12.5H5Zm0-1.5h6m0 0V5m0 6A1.5 1.5 0 1 0 12.5 12.5H11Zm0-6A1.5 1.5 0 1 0 12.5 3.5H11Z",
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

// Snippet — `< >` brackets around an instruction line (reusable block).
const snippet: ReactNode = jsxs(Fragment, {
  children: [
    jsx("path", { d: "m5 4.5-3.5 3.5 3.5 3.5M11 4.5 14.5 8 11 11.5" }),
    jsx("path", { d: "M6.8 8h2.4" }),
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
const chevronDown: ReactNode = jsx("path", { d: "m3 6 5 5 5-5" });
const chevronUp: ReactNode = jsx("path", { d: "m3 10 5-5 5 5" });
const arrowLeft: ReactNode = jsx("path", { d: "M13 8H3m0 0 4-4m-4 4 4 4" });
const arrowRight: ReactNode = jsx("path", { d: "M3 8h10m0 0-4-4m4 4-4 4" });

// ─── Legacy / misc icons (kept for non-breaking resolution) ─────────────────

const cog: ReactNode = jsxs(Fragment, {
  children: [
    jsx("circle", { cx: 8, cy: 8, r: 2 }),
    jsx("path", {
      d: "M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.5 3.5l1.4 1.4M11.1 11.1l1.4 1.4M3.5 12.5l1.4-1.4M11.1 4.9l1.4-1.4",
    }),
  ],
});

const power: ReactNode = jsx("path", { d: "M5 4.5a4.5 4.5 0 1 0 6 0M8 2v6" });

const star: ReactNode = jsx("path", { d: "M8 2 6.2 6 2 6.5l3 3-.8 4.5L8 12l3.8 2L11 9.5l3-3L9.8 6 8 2Z" });

const globe: ReactNode = scopeGlobal; // alias — globe is reserved for scope.global

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
  "view.library": viewLibrary,
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
  chevronDown,
  chevronUp,
  arrowLeft,
  arrowRight,
  "chevron-right": chevronRight,
  "chevron-down": chevronDown,
  "chevron-up": chevronUp,
  "arrow-left": arrowLeft,
  "arrow-right": arrowRight,

  // Legacy / misc (non-breaking)
  cog,
  power,
  star,
  globe,
  doc,
  folder,
  plug,
  agent,
  remote,
  warning,
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
};
