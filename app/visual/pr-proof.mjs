// ─── pr-proof: before/after screenshot proof for a PR, in one command ────────
//
//   cd app && node visual/pr-proof.mjs --before ../../.skill-hub/app \
//     --scenes skill-library,project-loadout --clip .app-main:160 \
//     --publish pr-assets/my-feature --pr 52
//
// 1. capture  — runs capture.mjs (this checkout's SCENES) against the BEFORE
//               checkout and the AFTER checkout, each on its own Vite port,
//               only the requested scenes × widths, optionally clipped.
// 2. compose  — pairs/<scene>.png (before over after), sheets/compare-<n>.png
//               (12 pairs per sheet, local only) and sheets/after-sections.png
//               (one scene per section hue), rendered from HTML by Chromium.
// 3. gate     — a missing frame (either side) or a clip that fell back to a
//               full frame stops here with exit 1, BEFORE anything is
//               published. --allow-missing overrides (flagged on the sheet).
// 4. publish  — (--publish) force-push pairs/ + sheets/after-sections.png to
//               an orphan pr-assets/* branch and read one file back via gh.
// 5. pr       — (--pr) splice screenshots.md into the PR body between
//               <!-- screenshots:start --> … <!-- screenshots:end -->.
//
// Exit codes: 0 ok · 1 gate failed · 2 usage / capture / publish / gh error.
// Every step's inputs/outputs are plain files under --out, so publish + pr can
// be re-run alone (--skip-capture) after a transient failure.

import { spawn, execFileSync } from "node:child_process";
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { chromium } from "playwright";
import { SCENES } from "./capture.mjs";
import { OUT_SENTINEL, canWipe, frameName } from "./config.mjs";
import {
  USAGE,
  VERCEL_GATING_FILES,
  assetUrl,
  oneScenePerSection,
  pairHtml,
  pairName,
  parseArgs,
  repoSlugFromRemote,
  screenshotsMarkdown,
  selectScenes,
  sheetHtml,
  spliceBody,
} from "./proof-lib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, "..");
const CAPTURE = path.join(__dirname, "capture.mjs");
const SCALE = 2; // capture.mjs shoots @2x
const MAX_IMG_CSS_WIDTH = 1200;
const PAIRS_PER_SHEET = 12;

function fail(msg) {
  console.error(`\npr-proof: ${msg}`);
  process.exit(2);
}

const parsed = parseArgs(process.argv.slice(2), {
  defaultAppDir: APP_DIR,
  defaultOut: path.join(__dirname, "proof"),
});
if (!parsed.ok) {
  console.error(`pr-proof: ${parsed.error}\n`);
  console.error(USAGE);
  process.exit(2);
}
const opts = parsed.opts;
if (opts.help) {
  console.log(USAGE);
  process.exit(0);
}

const picked = selectScenes(SCENES, { ids: opts.scenes, all: opts.all });
if (!picked.ok) fail(picked.error);
const scenes = picked.scenes;
const primaryWidth = opts.widths[0];
const hasBefore = Boolean(opts.before);
const sides = [
  ...(hasBefore ? [{ name: "before", dir: opts.before, port: opts.portBase }] : []),
  { name: "after", dir: opts.after, port: opts.portBase + 1 },
];

// ─── 1. capture ───────────────────────────────────────────────────────────────

function runCapture(side) {
  const env = {
    ...process.env,
    ST_VISUAL_APP: side.dir,
    ST_VISUAL_OUT: path.join(opts.out, side.name),
    ST_VISUAL_ONLY: scenes.map((s) => s.id).join(","),
    ST_VISUAL_WIDTHS: opts.widths.join(","),
    ST_DEV_PORT: String(side.port),
  };
  delete env.ST_VISUAL_LIST;
  if (opts.clip) env.ST_VISUAL_CLIP = opts.clip;
  else delete env.ST_VISUAL_CLIP;
  console.log(`\n━━ capture ${side.name.toUpperCase()}  ${side.dir}  (port ${side.port})`);
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [CAPTURE], { cwd: APP_DIR, env, stdio: "inherit" });
    proc.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`capture ${side.name} exited ${code}`))));
    proc.on("error", reject);
  });
}

if (!opts.skipCapture) {
  for (const s of sides) {
    const ok = await stat(path.join(s.dir, "node_modules", "vite", "bin", "vite.js")).then(() => true, () => false);
    if (!ok) fail(`${s.name} checkout ${s.dir} has no node_modules/vite — run npm install there`);
  }
  const entries = await readdir(opts.out).catch(() => null);
  if (!canWipe(entries)) {
    fail(`refusing to wipe ${opts.out}: it is not empty and has no ${OUT_SENTINEL} sentinel — pick an empty or pr-proof-owned --out`);
  }
  await rm(opts.out, { recursive: true, force: true });
  await mkdir(opts.out, { recursive: true });
  await writeFile(path.join(opts.out, OUT_SENTINEL), "written by app/visual/pr-proof.mjs — marks a dir it may wipe\n");
  for (const side of sides) {
    try {
      await runCapture(side);
    } catch (err) {
      fail(`${err.message}`);
    }
  }
} else {
  console.log(`\n━━ capture skipped — reusing ${opts.out}`);
}

// ─── 2. compose ───────────────────────────────────────────────────────────────

function pngWidth(buf) {
  // IHDR width lives at byte 16 of every PNG.
  return buf.length > 24 && buf.toString("ascii", 1, 4) === "PNG" ? buf.readUInt32BE(16) : null;
}

async function loadReport(sideName) {
  const p = path.join(opts.out, sideName, "capture-report.json");
  const raw = await readFile(p, "utf8").catch(() => null);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
const reports = Object.fromEntries(await Promise.all(sides.map(async (s) => [s.name, await loadReport(s.name)])));

/** A frame is "unclipped" when a clip was requested but capture fell back to
 *  the full frame (element missing on that branch). Without a report we
 *  cannot tell, so assume fine. */
function unclipped(sideName, sceneId, width) {
  if (!opts.clip) return false;
  const r = reports[sideName];
  if (!r) return false;
  const f = r.frames?.find((x) => x.scene === sceneId && x.width === width);
  return Boolean(f && f.ok && !f.clipped);
}

async function frame(sideName, sceneId, width) {
  const p = path.join(opts.out, sideName, frameName(sceneId, width));
  const buf = await readFile(p).catch(() => null);
  if (!buf) return null;
  const w = pngWidth(buf);
  if (!w) return null;
  return {
    src: `data:image/png;base64,${buf.toString("base64")}`,
    cssWidth: Math.round(w / SCALE),
    unclipped: unclipped(sideName, sceneId, width),
  };
}

const pairsDir = path.join(opts.out, "pairs");
const sheetsDir = path.join(opts.out, "sheets");
await rm(pairsDir, { recursive: true, force: true });
await rm(sheetsDir, { recursive: true, force: true });
await mkdir(pairsDir, { recursive: true });
await mkdir(sheetsDir, { recursive: true });

console.log(`\n━━ compose  (${scenes.length} scenes × ${opts.widths.join("/")}px${hasBefore ? ", before+after" : ", after only"})`);
const browser = await chromium.launch();
const entries = scenes.map((s) => ({ id: s.id, pairs: [] })); // scene order, then width order
const entryById = new Map(entries.map((e) => [e.id, e]));
if (entryById.size !== entries.length) {
  const seen = new Set();
  const dupes = new Set();
  for (const e of entries) {
    if (seen.has(e.id)) dupes.add(e.id);
    seen.add(e.id);
  }
  throw new Error(`pr-proof: duplicate scene id(s), each scene id must be unique: ${[...dupes].join(", ")}`);
}
const problems = []; // gate failures
const sheets = [];
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: SCALE });

  for (const width of opts.widths) {
    // `scene.minWidth` opts a scene out of a narrower width the same way
    // capture.mjs's own width loop does (around line 3858) — capture.mjs
    // never wrote an AFTER (or BEFORE) frame for that pair at this width, so
    // pairing it here would always report a false "no AFTER frame" gate
    // failure instead of skipping cleanly.
    const scenesAtWidth = scenes.filter((scene) => !(scene.minWidth && width < scene.minWidth));
    const blocks = [];
    for (const scene of scenesAtWidth) {
      const before = hasBefore ? await frame("before", scene.id, width) : null;
      const after = await frame("after", scene.id, width);
      if (!after) problems.push(`${scene.id}@${width}: no AFTER frame`);
      if (hasBefore && !before) problems.push(`${scene.id}@${width}: no BEFORE frame (new scene?)`);
      if (before?.unclipped) problems.push(`${scene.id}@${width}: BEFORE clip "${opts.clip}" missed — full frame`);
      if (after?.unclipped) problems.push(`${scene.id}@${width}: AFTER clip "${opts.clip}" missed — full frame`);
      blocks.push(pairHtml(scene.id, { before, after, hasBeforeSide: hasBefore, maxWidth: MAX_IMG_CSS_WIDTH }));
    }
    // One document per chunk: bounded sheet height, one element screenshot per pair.
    for (let i = 0; i < blocks.length; i += PAIRS_PER_SHEET) {
      const chunk = blocks.slice(i, i + PAIRS_PER_SHEET);
      await page.setContent(sheetHtml(chunk), { waitUntil: "load" });
      for (let j = 0; j < chunk.length; j++) {
        const scene = scenesAtWidth[i + j];
        const file = pairName(scene.id, width, primaryWidth);
        await page.locator(`#pair-${cssEscape(scene.id)}`).screenshot({ path: path.join(pairsDir, file) });
        entryById.get(scene.id).pairs.push({ width, file });
      }
      if (width === primaryWidth) {
        const name = `compare-${sheets.length + 1}.png`;
        await page.locator(".sheet").screenshot({ path: path.join(sheetsDir, name) });
        sheets.push(name);
      }
    }
  }

  // After-only, one scene per section, primary width (bounded by section count).
  // Same `minWidth` skip as the compose loop above: a section's representative
  // scene that opts out of a width narrower than its `minWidth` never got an
  // AFTER frame captured at `primaryWidth` either, so drop it here too instead
  // of shipping a blank pair.
  const perSection = oneScenePerSection(scenes).filter((scene) => !(scene.minWidth && primaryWidth < scene.minWidth));
  const secBlocks = [];
  for (const scene of perSection) {
    const after = await frame("after", scene.id, primaryWidth);
    secBlocks.push(pairHtml(scene.id, { before: null, after, hasBeforeSide: false, maxWidth: MAX_IMG_CSS_WIDTH }));
  }
  await page.setContent(sheetHtml(secBlocks), { waitUntil: "load" });
  await page.locator(".sheet").screenshot({ path: path.join(sheetsDir, "after-sections.png") });

  await writeFile(
    path.join(opts.out, "manifest.json"),
    JSON.stringify(
      { hasBefore, widths: opts.widths, clip: opts.clip, scenes: entries, sheets, sections: perSection.map((s) => s.id), problems },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
console.log(`  pairs/  ${entries.length} scenes → ${pairsDir}`);
console.log(`  sheets/ ${sheets.join(", ")}, after-sections.png → ${sheetsDir}`);

// A scene whose `minWidth` is above every requested width never got a pair
// at any width (the `scenesAtWidth` filter in the compose loop skips it every
// iteration) — screenshotsMarkdown assumes every entry has at least one pair
// and throws (via `e.pairs[0]`) otherwise, so drop those entries here and say
// which scene was skipped and why.
const publishableEntries = [];
for (const e of entries) {
  if (e.pairs.length === 0) {
    const scene = scenes.find((s) => s.id === e.id);
    console.warn(`  ${e.id}: skipped at every requested width (minWidth=${scene?.minWidth ?? "?"})`);
    continue;
  }
  publishableEntries.push(e);
}

// ─── 3. gate ──────────────────────────────────────────────────────────────────

for (const p of problems) console.warn(`  [problem] ${p}`);
if (problems.length && !opts.allowMissing) {
  console.error(`\npr-proof: ${problems.length} problem(s) — nothing published. Fix them, or pass --allow-missing to publish with flags on the sheet.`);
  process.exit(1);
}

// ─── 4. publish ───────────────────────────────────────────────────────────────

let repoSlug = null;
// The commit the images were pushed as. Image URLs pin to it, never to the
// branch name: GitHub caches `blob/<branch>/…?raw=true`, so a re-run that
// force-pushes the same paths kept serving the PREVIOUS round's frames for
// every scene that already existed — a correct build looked unchanged.
let publishedSha = null;
if (opts.publish) {
  try {
    const remote = git(opts.after, ["remote", "get-url", "origin"]);
    repoSlug = repoSlugFromRemote(remote);
    if (!repoSlug) throw new Error(`cannot derive owner/repo from origin ${JSON.stringify(remote)} (github.com remotes only)`);
    const pub = path.join(opts.out, "publish");
    await rm(pub, { recursive: true, force: true });
    await mkdir(path.join(pub, "sheets"), { recursive: true });
    await cp(pairsDir, path.join(pub, "pairs"), { recursive: true });
    // compare-*.png are local review sheets (unbounded size, never linked).
    await cp(path.join(sheetsDir, "after-sections.png"), path.join(pub, "sheets", "after-sections.png"));
    await writeFile(
      path.join(pub, "README.md"),
      `# PR assets — ${opts.publish}\n\nScreenshots referenced from a PR description. Orphan branch, never merged.\nGenerated by \`app/visual/pr-proof.mjs\`.\n`,
    );
    // Vercel reads vercel.json from the deployed commit, and each project's
    // Root Directory is app/ or website/ — this orphan commit otherwise has
    // neither, so a screenshot-only push would still create a deployment
    // record on both projects (and ERROR, since the Root Directory is
    // missing) instead of being skipped. Ship both files disabled here.
    for (const f of VERCEL_GATING_FILES) {
      const dest = path.join(pub, f.path);
      await mkdir(path.dirname(dest), { recursive: true });
      await writeFile(dest, f.content);
    }
    const name = gitOpt(opts.after, ["config", "user.name"]) || "pr-proof";
    const email = gitOpt(opts.after, ["config", "user.email"]) || "pr-proof@localhost";
    console.log(`\n━━ publish  ${repoSlug} ← ${opts.publish}`);
    git(pub, ["init", "-q"]);
    git(pub, ["symbolic-ref", "HEAD", `refs/heads/${opts.publish}`]);
    git(pub, ["add", "-A"]);
    git(pub, ["-c", `user.name=${name}`, "-c", `user.email=${email}`, "commit", "-q", "-m", `📸 assets: screenshots for ${opts.publish}`]);
    // Dedicated namespace (parseArgs enforces the pr-assets/ prefix), so a
    // re-run after a fix commit simply replaces the previous set.
    git(pub, ["push", "-q", "--force", remote, `HEAD:refs/heads/${opts.publish}`]);
    publishedSha = git(pub, ["rev-parse", "HEAD"]).trim();
    const probe = publishableEntries[0]?.pairs[0]?.file;
    if (probe) {
      const size = sh("gh", ["api", `repos/${repoSlug}/contents/pairs/${probe}?ref=${opts.publish}`, "-q", ".size"]);
      if (!/^\d+$/.test(size) || Number(size) === 0) throw new Error(`pushed, but gh cannot see pairs/${probe} on ${opts.publish}`);
      console.log(`  verified pairs/${probe} (${size} bytes) on ${opts.publish} @ ${publishedSha.slice(0, 7)}`);
    }
  } catch (err) {
    fail(`publish failed: ${err.message}\n  (frames are kept — retry with --skip-capture; needs git ≥ 2.22, gh authenticated for ${repoSlug ?? "the origin repo"})`);
  }
}

// ─── 5. markdown (+ PR body) ──────────────────────────────────────────────────

const base = opts.publish ? (rel) => assetUrl(repoSlug, publishedSha ?? opts.publish, rel) : (rel) => rel;
const md = screenshotsMarkdown({
  title: opts.title,
  base,
  entries: publishableEntries,
  showSections: oneScenePerSection(scenes).length > 1,
  hasBefore,
  primaryWidth,
  branch: opts.publish,
});
const mdPath = path.join(opts.out, "screenshots.md");
await writeFile(mdPath, md);
console.log(`\n━━ markdown → ${mdPath}${opts.publish ? "" : "  (relative paths — add --publish for PR-ready URLs)"}`);

if (opts.pr) {
  try {
    console.log(`━━ PR #${opts.pr}: splice body`);
    // REST, not `gh pr view/edit`: those go through GraphQL and gh ≤ 2.58
    // trips over GitHub's deprecated `projectCards` field on every edit.
    const body = sh("gh", ["api", `repos/${repoSlug}/pulls/${opts.pr}`, "-q", ".body"]);
    const next = spliceBody(body, md);
    const bodyFile = path.join(opts.out, `pr-${opts.pr}-body.md`);
    await writeFile(bodyFile, next);
    sh("gh", ["api", "-X", "PATCH", `repos/${repoSlug}/pulls/${opts.pr}`, "-F", `body=@${bodyFile}`, "-q", ".number"]);
    console.log(`  updated PR #${opts.pr} body (${next.length} chars)`);
  } catch (err) {
    fail(`PR body update failed: ${err.message}\n  (assets are on ${opts.publish}; ${mdPath} holds the section — retry with --skip-capture or paste it by hand)`);
  }
}

console.log("\npr-proof: done");

// ─── helpers ──────────────────────────────────────────────────────────────────

function sh(cmd, args, cwd = opts.after) {
  return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
}
function git(cwd, args) {
  return sh("git", args, cwd);
}
/** `git config <key>` exits 1 when unset — that is "no value", not an error. */
function gitOpt(cwd, args) {
  try {
    return git(cwd, args);
  } catch {
    return "";
  }
}
function cssEscape(id) {
  return id.replace(/[^A-Za-z0-9_-]/g, (c) => `\\${c}`);
}
