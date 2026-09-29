// ─── Visual-harness env configuration (pure, unit-tested) ────────────────────
// Every `ST_VISUAL_*` / `ST_DEV_PORT` knob the capture script reads is parsed
// here, from an explicit `env` object, so the parsing can be tested without
// booting Playwright. A junk value never aborts a run: it warns and falls back
// to the default, the same way `ST_DEV_PORT` always has.

import path from "node:path";

export const DEFAULT_PORT = 1420;
export const DEFAULT_WIDTHS = [1440, 1024, 768, 520];

/** `ST_DEV_PORT` — same override as vite.config.ts / playwright.config.ts, so a
 *  parallel worktree can render its gallery without colliding on 1420. */
export function resolveDevPort(env = process.env, warn = console.warn) {
  const raw = env.ST_DEV_PORT;
  if (raw === undefined || raw === "") return DEFAULT_PORT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    warn(`[skill-tree] ST_DEV_PORT=${JSON.stringify(raw)} is not a valid port — falling back to ${DEFAULT_PORT}.`);
    return DEFAULT_PORT;
  }
  return n;
}

/** `ST_VISUAL_WIDTHS=1440,520` — viewport widths to shoot. Order is kept
 *  (the first width is the "primary" frame downstream). Duplicates collapse. */
export function resolveWidths(env = process.env, warn = console.warn) {
  const raw = env.ST_VISUAL_WIDTHS;
  if (raw === undefined || raw.trim() === "") return [...DEFAULT_WIDTHS];
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const widths = [];
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 320 || n > 4096) {
      warn(`[skill-tree] ST_VISUAL_WIDTHS=${JSON.stringify(raw)} has an invalid width ${JSON.stringify(p)} — falling back to ${DEFAULT_WIDTHS.join(",")}.`);
      return [...DEFAULT_WIDTHS];
    }
    if (!widths.includes(n)) widths.push(n);
  }
  if (!widths.length) return [...DEFAULT_WIDTHS];
  return widths;
}

/** `ST_VISUAL_ONLY=a,b` — scene-id allowlist. Empty = every scene. */
export function resolveOnly(env = process.env) {
  return (env.ST_VISUAL_ONLY ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** `ST_VISUAL_CLIP="<selector>[:<height>]"` — screenshot only the bounding box
 *  of the first element matching `selector`, optionally forcing the clip
 *  height (CSS px). `.app-main:160` = the top 160px of the main column, which
 *  is the header band. Absent = full viewport frame. A bare `:160` is invalid. */
export function resolveClip(env = process.env, warn = console.warn) {
  const raw = env.ST_VISUAL_CLIP;
  if (raw === undefined || raw.trim() === "") return null;
  const idx = raw.lastIndexOf(":");
  let selector = raw;
  let height = null;
  // Only treat a trailing `:<digits>` as a height — `a:hover` / `a:nth-child(2)`
  // stay intact as selectors.
  if (idx >= 0 && /^\d+$/.test(raw.slice(idx + 1))) {
    selector = raw.slice(0, idx);
    height = Number(raw.slice(idx + 1));
  }
  selector = selector.trim();
  if (!selector) {
    warn(`[skill-tree] ST_VISUAL_CLIP=${JSON.stringify(raw)} has no selector — shooting full frames.`);
    return null;
  }
  if (height !== null && (height < 1 || height > 8192)) {
    warn(`[skill-tree] ST_VISUAL_CLIP=${JSON.stringify(raw)} height out of range — shooting full frames.`);
    return null;
  }
  return { selector, height };
}

/** `ST_VISUAL_OUT=<dir>` — where frames + gallery go. Relative paths resolve
 *  against `cwd`. Default: `<visualDir>/out`. */
export function resolveOutDir(env = process.env, visualDir, cwd = process.cwd()) {
  const raw = env.ST_VISUAL_OUT;
  if (raw === undefined || raw.trim() === "") return path.join(visualDir, "out");
  return path.resolve(cwd, raw.trim());
}

/** `ST_VISUAL_APP=<dir>` — the app checkout whose Vite (and therefore whose
 *  frontend) gets photographed. Default: the checkout this script lives in.
 *  This is what lets ONE capture script shoot a "before" checkout with the
 *  SAME scene list as the "after" one. */
export function resolveAppDir(env = process.env, defaultAppDir, cwd = process.cwd()) {
  const raw = env.ST_VISUAL_APP;
  if (raw === undefined || raw.trim() === "") return defaultAppDir;
  return path.resolve(cwd, raw.trim());
}

// ─── Shared names + pure geometry ────────────────────────────────────────────

/** Written into every output dir the harness owns. A full run wipes a dir only
 *  when it is missing, empty, or carries this sentinel — so `ST_VISUAL_OUT=.`
 *  (or `--out ..`) can never delete a checkout. */
export const OUT_SENTINEL = ".skill-tree-visual";

/** `canWipe(entries)` — given a directory listing (names), may a full run
 *  `rm -rf` it? Missing dir → caller passes `null` → yes. */
export function canWipe(entries) {
  if (entries === null) return true;
  if (entries.length === 0) return true;
  return entries.includes(OUT_SENTINEL);
}

/** The ONE frame filename template. capture.mjs writes it; pr-proof.mjs reads it. */
export function frameName(sceneId, width) {
  return `${sceneId}__${width}.png`;
}

/** Playwright `clip` rect for an element box inside a `vw`×`vh` viewport, with
 *  an optional forced height. Returns null when nothing visible remains. The
 *  box is intersected with the viewport: a partly-scrolled-out element yields
 *  the visible part, measured from the clamped origin. */
export function clipRect(box, vw, vh, forcedHeight = null) {
  if (!box) return null;
  const x = Math.max(0, box.x);
  const y = Math.max(0, box.y);
  const right = Math.min(vw, box.x + box.width);
  const bottom = Math.min(vh, box.y + (forcedHeight ?? box.height));
  const width = right - x;
  const height = bottom - y;
  if (width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}
