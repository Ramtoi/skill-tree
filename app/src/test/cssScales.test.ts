import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { readAppCss } from "./readAppCss";

// ─── CSS scale guards (S7) ─────────────────────────────────────────────────
//
// The app has no stylelint (and the plan forbids new dependencies — see
// src/test/ipcImportGuard.test.ts for the same posture on JS imports), so the
// design-scale rules S7 introduces are enforced here instead: every literal
// font-size and every raw `rgba(` shadow/scrim must route through a token,
// and the two sanctioned `@supports` relative-colour derivations are pinned
// at exactly 4 so a third one can't sneak in unnoticed.
//
// The walk below is the same shape as ipcImportGuard.test.ts's `walk()`.

const SRC = join(process.cwd(), "src");

/** The one CSS file allowed to hold the `:root` token block (and therefore
 *  the only file allowed to contain raw `rgba(` literals — everywhere else
 *  must reference a `--shadow-*`/`--scrim*` token instead). Slice A keeps the
 *  tokens in App.css; Slice B moves them into styles/tokens.css and flips
 *  this one constant. */
const TOKENS_FILE = "tokens.css";

function walkCss(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walkCss(p));
    else if (extname(entry) === ".css") out.push(p);
  }
  return out;
}

const cssFiles = walkCss(SRC);
const contents = new Map<string, string>();
for (const f of cssFiles) contents.set(f, readFileSync(f, "utf-8"));

/** Strips the FIRST top-level `:root { ... }` block (the design-token block)
 *  out of a stylesheet's text, by brace-depth matching from the first `{`
 *  after the `:root` selector to its balanced close. A later, unrelated
 *  `:root { ... }` block (e.g. the ligature override) is left untouched —
 *  only the primary token block is exempt from the raw-rgba( ban. */
function withoutFirstRootBlock(css: string): string {
  const selIdx = css.indexOf(":root");
  if (selIdx === -1) return css;
  const braceStart = css.indexOf("{", selIdx);
  if (braceStart === -1) return css;
  let depth = 0;
  let i = braceStart;
  for (; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) { i++; break; }
    }
  }
  return css.slice(0, selIdx) + css.slice(i);
}

describe("CSS scale guards", () => {
  it("no literal px font-size remains outside the --fs scale", () => {
    const offenders: { file: string; count: number }[] = [];
    for (const [file, css] of contents) {
      const matches = css.match(/font-size:\s*[0-9.]+px/g);
      if (matches && matches.length) offenders.push({ file, count: matches.length });
    }
    expect(offenders).toEqual([]);
  });

  it("raw rgba( literals only exist inside the tokens file's :root block", () => {
    const offenders: string[] = [];
    for (const [file, css] of contents) {
      const scoped = file.endsWith(TOKENS_FILE) ? withoutFirstRootBlock(css) : css;
      if (scoped.includes("rgba(")) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it("relative-colour derivations stay pinned at the two sanctioned @supports blocks", () => {
    // Sanctioned lifts: the rail glint (--live-accent), the ONE chrome accent
    // lift (--section-lifted on .app) which the contour line, the band wash
    // and the rail wash all derive from, and that SAME lift applied a second
    // time to the content hue (--section-2-lifted, context-mix.css) so the two
    // halves of a mixed header band cannot land in different registers. Each
    // block = guard + one declaration, two `oklch(from` occurrences apiece.
    //
    // +3 (6 → 9): the CONTENT accent block on `.app-main` (shell-scaffold.css
    // § The CONTENT accent) — one guard plus the TWO brighter steps --ctx* has
    // no --section sibling to reuse (--ctx-2-lifted at 78%/0.16, --ctx-glow-
    // lifted at 70%/0.16/.35). --ctx itself adds none: it reads
    // --section-2-lifted straight, which is the point.
    //
    // +4 (9 → 13): the Usage session sheet (shell-scaffold.css § The Usage
    // session sheet), the ONE overlay that is a place. It portals to
    // document.body, outside `.app`, so it can inherit no --section-2* and
    // must restate the ladder from --sec-agents: one guard plus all THREE
    // steps. Every percentage is copied from the `.app-main` block above, so
    // the two cannot drift; the sheet still reads its --ctx through a
    // var(--…-lifted, <fallback>) so no --ctx restates a lift inline.
    let total = 0;
    for (const css of contents.values()) {
      const matches = css.match(/oklch\(from|rgb\(from|hsl\(from/g);
      if (matches) total += matches.length;
    }
    expect(total).toBe(13);
  });

  it("App.css is gone and no split CSS file exceeds 650 lines", () => {
    const appCssExists = cssFiles.some((f) => f.endsWith("/App.css"));
    expect(appCssExists).toBe(false);

    const oversized: { file: string; lines: number }[] = [];
    for (const [file, css] of contents) {
      const lineCount = css.split("\n").length;
      if (lineCount > 650) oversized.push({ file, lines: lineCount });
    }
    expect(oversized).toEqual([]);
  });

  // E3 rev 2 §2.6/§5 case 23 — a toast must layer ABOVE a modal (red on
  // main: --z-toast 80 < --z-modal 90). Read through readAppCss() (the
  // App.css-reassembly helper other token-order tests already use), not the
  // raw tokens.css text, so this pins the value the app actually renders
  // with, not just what the token block happens to say.
  it("--z-toast renders above --z-modal", () => {
    const css = readAppCss();
    function zValue(token: string): number {
      const m = css.match(new RegExp(`--${token}:\\s*(-?[0-9]+)`));
      if (!m) throw new Error(`token --${token} not found`);
      return Number(m[1]);
    }
    expect(zValue("z-toast")).toBeGreaterThan(zValue("z-modal"));
    // --z-max is the one sanctioned outlier still above both (COMPONENTS.md
    // § Z ladder) — pinned here so this test documents the exception
    // instead of silently tolerating a second one.
    expect(zValue("z-max")).toBeGreaterThan(zValue("z-toast"));
  });
});
