// ─── pr-proof helpers (pure, unit-tested) ────────────────────────────────────
// Everything in pr-proof.mjs that does not touch a process, a browser, or the
// network lives here: argv parsing, scene selection/grouping, the HTML the
// sheets are rendered from, the PR-body markdown, and the marker splice.

import path from "node:path";
import { frameName } from "./config.mjs";
export { frameName };

export const USAGE = `pr-proof — before/after screenshot proof for a PR

  node visual/pr-proof.mjs --scenes a,b,c [options]
  node visual/pr-proof.mjs --all [options]

Sides
  --after <appDir>      checkout to shoot as AFTER (default: this checkout)
  --before <appDir>     checkout to shoot as BEFORE (omit = after-only proof)
Frames
  --scenes <ids>        comma-separated scene ids from capture.mjs SCENES
  --all                 every scene
  --widths <px,px>      viewport widths, first = primary (default 1440)
  --clip <sel[:h]>      clip frames to an element box, e.g. .app-main:160
  --port-base <n>       Vite ports: before=n, after=n+1 (default 1461)
Output
  --out <dir>           output dir (default visual/proof, wiped each run)
  --title <text>        heading used in the markdown snippet
Publish (both optional, both need gh + push rights)
  --publish <branch>    force-push pairs/ + sheets/ to an orphan branch;
                        must start with pr-assets/
  --pr <number>         splice screenshots.md into that PR's body between
                        <!-- screenshots:start --> … <!-- screenshots:end -->
  --skip-capture        reuse frames already in --out (compose/publish only)
  --allow-missing       publish even when a frame is missing or a clip fell
                        back to a full frame (they are flagged on the sheet)
  -h, --help

Exit codes: 0 ok · 1 frames missing/unclipped (nothing published) · 2 usage,
capture, publish or gh failure.
`;

export const ASSET_BRANCH_PREFIX = "pr-assets/";
export const MARK_START = "<!-- screenshots:start -->";
export const MARK_END = "<!-- screenshots:end -->";

/** Parse argv (after `node script`). Returns `{ ok: true, opts }` or
 *  `{ ok: false, error }`. Never exits. */
export function parseArgs(argv, { cwd = process.cwd(), defaultAppDir, defaultOut } = {}) {
  const opts = {
    after: defaultAppDir,
    before: null,
    scenes: [],
    all: false,
    widths: [1440],
    clip: null,
    portBase: 1461,
    out: defaultOut,
    title: "Screenshots",
    publish: null,
    pr: null,
    skipCapture: false,
    allowMissing: false,
    help: false,
  };
  if (argv.includes("-h") || argv.includes("--help")) return { ok: true, opts: { ...opts, help: true } };
  const seen = new Set();
  const takes = new Set([
    "--after", "--before", "--scenes", "--widths", "--clip", "--port-base",
    "--out", "--title", "--publish", "--pr",
  ]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--all") { opts.all = true; continue; }
    if (a === "--skip-capture") { opts.skipCapture = true; continue; }
    if (a === "--allow-missing") { opts.allowMissing = true; continue; }
    if (!takes.has(a)) return { ok: false, error: `unknown argument ${JSON.stringify(a)}` };
    if (seen.has(a)) return { ok: false, error: `${a} given twice` };
    seen.add(a);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("-") || v.trim() === "") return { ok: false, error: `${a} needs a value` };
    i++;
    switch (a) {
      case "--after": opts.after = path.resolve(cwd, v); break;
      case "--before": opts.before = path.resolve(cwd, v); break;
      case "--scenes": opts.scenes = v.split(",").map((s) => s.trim()).filter(Boolean); break;
      case "--widths": {
        const ws = v.split(",").map((s) => Number(s.trim()));
        if (!ws.length || ws.some((n) => !Number.isInteger(n) || n < 320 || n > 4096)) {
          return { ok: false, error: `--widths ${JSON.stringify(v)}: each width must be an integer 320–4096` };
        }
        opts.widths = [...new Set(ws)];
        break;
      }
      case "--clip": opts.clip = v; break;
      case "--port-base": {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 1024 || n > 65534) return { ok: false, error: `--port-base must be 1024–65534` };
        opts.portBase = n;
        break;
      }
      case "--out": opts.out = path.resolve(cwd, v); break;
      case "--title": opts.title = v; break;
      case "--publish":
        if (!assetBranchAllowed(v)) {
          return { ok: false, error: `--publish ${JSON.stringify(v)}: branch must start with ${ASSET_BRANCH_PREFIX} (it is force-pushed)` };
        }
        opts.publish = v;
        break;
      case "--pr": {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 1) return { ok: false, error: `--pr must be a positive integer` };
        opts.pr = n;
        break;
      }
    }
  }
  if (!opts.all && !opts.scenes.length) return { ok: false, error: "pick frames: --scenes a,b or --all" };
  if (opts.all && opts.scenes.length) return { ok: false, error: "--all and --scenes are exclusive" };
  if (opts.pr && !opts.publish) return { ok: false, error: "--pr needs --publish (the PR body links to the asset branch)" };
  if (!opts.out) return { ok: false, error: "--out is required" };
  return { ok: true, opts };
}

/** Only ever force-push to a dedicated assets namespace. */
export function assetBranchAllowed(name) {
  return (
    typeof name === "string" &&
    name.startsWith(ASSET_BRANCH_PREFIX) &&
    name.length > ASSET_BRANCH_PREFIX.length &&
    /^[A-Za-z0-9._/-]+$/.test(name) &&
    !name.includes("..") &&
    !name.endsWith("/")
  );
}

/** Scene `path` values are hash routes (`/#/project/x`); the app's
 *  `sectionForPath` (lib/sections.ts) takes the router path. Ported verbatim —
 *  a vitest guard checks the two agree. */
export function routeOf(scenePath) {
  const i = scenePath.indexOf("#");
  const r = i >= 0 ? scenePath.slice(i + 1) : scenePath;
  return r.split("?")[0] || "/";
}

export function sectionForPath(p) {
  if (p.startsWith("/project/")) return "projects";
  if (p === "/sources" || p.startsWith("/sources/")) return "sources";
  if (p === "/snippets" || p.startsWith("/snippet/")) return "snippets";
  if (p === "/hooks" || p.startsWith("/hook/")) return "hooks";
  if (p === "/permissions") return "permissions";
  if (p === "/harnesses" || p.startsWith("/harness/")) return "harnesses";
  if (p === "/remotes" || p.startsWith("/remote/")) return "remotes";
  if (p.startsWith("/cloud/")) return "remotes";
  if (p === "/usage" || p.startsWith("/usage/")) return "usage";
  if (p === "/backup") return "backup";
  return "library";
}

/** Resolve `--scenes` / `--all` against the exported SCENES, keeping the
 *  caller's order. Unknown ids are an error (a typo must not silently drop a
 *  frame from the proof). */
export function selectScenes(scenes, { ids, all }) {
  if (all) return { ok: true, scenes: [...scenes] };
  const byId = new Map(scenes.map((s) => [s.id, s]));
  const unknown = ids.filter((id) => !byId.has(id));
  if (unknown.length) {
    return { ok: false, error: `unknown scene id(s): ${unknown.join(", ")}` };
  }
  return { ok: true, scenes: ids.map((id) => byId.get(id)) };
}

/** First scene of each section, in section order of first appearance —
 *  the "one crop per section hue" sheet. */
export function oneScenePerSection(scenes) {
  const seen = new Map();
  for (const s of scenes) {
    const sec = sectionForPath(routeOf(s.path));
    if (!seen.has(sec)) seen.set(sec, s);
  }
  return [...seen.values()];
}

/** `pairs/<scene>.png` for the primary width, `pairs/<scene>__<w>.png` after. */
export function pairName(sceneId, width, primaryWidth) {
  return width === primaryWidth ? `${sceneId}.png` : `${sceneId}__${width}.png`;
}

// ─── Sheet HTML ───────────────────────────────────────────────────────────────

const SHEET_CSS = `
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #111; }
  body { font: 13px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: #ccc; }
  .sheet { display: inline-block; padding: 12px 8px; }
  .pair { padding: 10px 0; width: max-content; }
  .pair + .pair { border-top: 1px solid #333; }
  .label { margin: 0 0 6px 2px; }
  .label .tag { color: #888; }
  .label .warn { color: #f66; }
  .imgs { display: flex; flex-direction: column; gap: 6px; }
  .side { display: flex; flex-direction: column; gap: 2px; }
  .side .cap { color: #777; font-size: 11px; padding-left: 2px; }
  img { display: block; height: auto; background: #000; }
  .missing { color: #f66; font-size: 12px; padding: 6px 2px; }
`;

/** One `.pair` block. `before`/`after` are `{ src, cssWidth }` or null. */
export function pairHtml(id, { before, after, hasBeforeSide, maxWidth }) {
  const w = (s) => Math.min(maxWidth, s.cssWidth);
  const side = (cap, s) =>
    s
      ? `<div class="side"><span class="cap">${cap}${s.unclipped ? " (clip missed — full frame)" : ""}</span><img src="${s.src}" width="${w(s)}" alt="${esc(id)} ${cap}"></div>`
      : `<div class="missing">${cap}: capture failed</div>`;
  let label = esc(id);
  const parts = [];
  if (hasBeforeSide) {
    if (before) parts.push(side("before", before));
    else label += ` <span class="tag">(new scene — no BEFORE)</span>`;
  }
  if (before && after && before.cssWidth !== after.cssWidth) {
    label += ` <span class="warn">(widths differ: ${before.cssWidth} vs ${after.cssWidth}px — not to scale)</span>`;
  }
  parts.push(side(hasBeforeSide ? "after" : "", after));
  return `<section class="pair" id="pair-${esc(id)}"><div class="label">${label}</div><div class="imgs">${parts.join("")}</div></section>`;
}

export function sheetHtml(pairBlocks) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${SHEET_CSS}</style></head><body><div class="sheet">${pairBlocks.join("\n")}</div></body></html>`;
}

// ─── PR markdown ──────────────────────────────────────────────────────────────

/** GitHub renders `blob/<ref>/<file>?raw=true` inline for collaborators of a
 *  private repo; raw.githubusercontent.com does not. `ref` should be the
 *  pushed COMMIT: a branch-name URL is cached, and a force-pushed re-shoot
 *  then shows the previous frames. */
export function assetUrl(repoSlug, ref, relPath) {
  return `https://github.com/${repoSlug}/blob/${ref}/${relPath}?raw=true`;
}

/**
 * Markdown for the PR body. `base` is a function relPath → URL (or a relative
 * path when not published). `entries` = `[{ id, pairs: [{ width, file }] }]`.
 */
export function screenshotsMarkdown({ title, base, entries, showSections, hasBefore, primaryWidth, branch }) {
  const img = (rel, alt, width = 900) => `<img src="${esc(base(rel))}" alt="${esc(alt)}" width="${width}">`;
  const out = [MARK_START, `## ${esc(title)}`, ""];
  if (showSections) {
    out.push("### Every section header after (one crop per section hue)", "");
    out.push(img("sheets/after-sections.png", "after - one scene per section"), "");
  }
  out.push(
    hasBefore
      ? `### Before → after (before on top, after below) @${primaryWidth}px`
      : `### After @${primaryWidth}px`,
    "",
  );
  for (const e of entries) {
    const primary = e.pairs.find((p) => p.width === primaryWidth) ?? e.pairs[0];
    out.push(`<details open><summary><code>${esc(e.id)}</code></summary>`, "", img(`pairs/${primary.file}`, e.id), "", "</details>");
  }
  const extras = entries.flatMap((e) => e.pairs.filter((p) => p.width !== primaryWidth).map((p) => ({ ...p, id: e.id })));
  if (extras.length) {
    out.push("", "### Other widths", "");
    for (const p of extras) {
      out.push(`<details><summary><code>${esc(p.id)}</code> @${p.width}px</summary>`, "", img(`pairs/${p.file}`, `${p.id} ${p.width}px`, Math.min(900, Math.round(p.width * 0.8))), "", "</details>");
    }
  }
  if (branch) out.push("", `_Images live on the orphan branch \`${branch}\` (never merged)._`);
  out.push(MARK_END);
  return out.join("\n") + "\n";
}

/** Replace the marker block in a PR body, or append one. The snippet must
 *  carry both markers itself (screenshotsMarkdown does). Throws when the body
 *  holds more than one block, or markers out of order — appending there would
 *  grow the body on every run. */
export function spliceBody(body, snippet) {
  body = body ?? "";
  const count = (m) => body.split(m).length - 1;
  const nStart = count(MARK_START);
  const nEnd = count(MARK_END);
  if (nStart > 1 || nEnd > 1 || nStart !== nEnd) {
    throw new Error(`PR body has ${nStart} start / ${nEnd} end screenshot markers — expected one pair or none; fix the body by hand`);
  }
  const s = body.indexOf(MARK_START);
  const e = body.indexOf(MARK_END);
  const block = snippet.trimEnd();
  if (nStart === 1) {
    if (e < s) throw new Error("PR body has the screenshot end marker before the start marker — fix the body by hand");
    return body.slice(0, s) + block + body.slice(e + MARK_END.length);
  }
  const trimmed = body.replace(/\s+$/, "");
  return (trimmed ? trimmed + "\n\n" : "") + block + "\n";
}

/** `git@github.com:o/r.git` / `https://github.com/o/r(.git)` → `o/r`. */
export function repoSlugFromRemote(url) {
  const m = String(url).trim().match(/(?:^|@|\/\/)github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

export function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// ─── Vercel deploy gating ─────────────────────────────────────────────────────

/** Files written into the pr-assets/* orphan commit alongside README.md.
 *  Vercel reads vercel.json from the DEPLOYED COMMIT, and each project's Root
 *  Directory is app/ or website/ — an orphan commit that carries only
 *  README.md + pairs/ + sheets/ has neither, so the real app/vercel.json and
 *  website/vercel.json (whose rules key off the branch name) never apply to
 *  it: the push still creates a deployment record on both projects, and
 *  because the Root Directory doesn't exist there the build ERRORs instead
 *  of being ignored. These two files disable the record outright. */
export const VERCEL_GATING_FILES = [
  { path: "app/vercel.json", content: '{"git":{"deploymentEnabled":false}}\n' },
  { path: "website/vercel.json", content: '{"git":{"deploymentEnabled":false}}\n' },
];
