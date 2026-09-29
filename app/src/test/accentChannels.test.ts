import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { readAppCss } from "./readAppCss";

// ─── ANCHOR / CONTEXT split guard (context-accent) ─────────────────────────
//
// The brand accent is two channels: --anchor* (constant brand violet, every
// screen) and --ctx* (the CONTENT section's hue). Body content — every
// stylesheet and component outside styles/tokens.css — must reach for one of
// those, never the raw --violet* triad tokens.css defines them from. Same walk
// shape as ipcImportGuard.test.ts / cssScales.test.ts.
//
// Step 3 lifted --ctx* off the anchor: `.app-main` re-declares the triad from
// --section-2 (the content hue), and :root keeps the anchor as the fallback
// the overlay layer inherits. The two guards below pin BOTH halves — and the
// third one pins the trap that makes the split necessary at all (a custom
// property substitutes its var()s on the element that DECLARES it, so a
// --section-derived --ctx at :root would freeze on the default hue).

const SRC = join(process.cwd(), "src");
const TOKENS_FILE = join("styles", "tokens.css");

function walk(dir: string, exts: RegExp): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p, exts));
    else if (exts.test(entry)) out.push(p);
  }
  return out;
}

const STYLE_FILES = walk(join(SRC, "styles"), /\.css$/);
const TSX_FILES = walk(SRC, /\.tsx$/).filter(
  (f) => !relative(SRC, f).startsWith("test" + sep),
);

const VIOLET_TOKEN = /--violet(-2|-glow)?\b/;

describe("accent channel split — no raw --violet outside tokens.css", () => {
  const offenders: string[] = [];
  for (const file of [...STYLE_FILES, ...TSX_FILES]) {
    const rel = relative(SRC, file);
    if (rel === TOKENS_FILE) continue;
    const text = readFileSync(file, "utf-8");
    for (const [i, line] of text.split("\n").entries()) {
      if (VIOLET_TOKEN.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
    }
  }

  it("every src/styles/**/*.css and non-test src/**/*.tsx file is clean", () => {
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});

const TOKENS_CSS = readFileSync(join(SRC, TOKENS_FILE), "utf-8");

describe("tokens.css — the two channels", () => {
  it.each(["--anchor", "--anchor-2", "--anchor-glow", "--ctx", "--ctx-2", "--ctx-glow"])(
    "defines %s",
    (token) => {
      expect(TOKENS_CSS).toMatch(new RegExp(`${token}:\\s*[^;]+;`));
    },
  );

  it(":root's --ctx* stay the ANCHOR fallback (what the overlay layer gets)", () => {
    expect(TOKENS_CSS).toMatch(/--ctx:\s*var\(--anchor\);/);
    expect(TOKENS_CSS).toMatch(/--ctx-2:\s*var\(--anchor-2\);/);
    expect(TOKENS_CSS).toMatch(/--ctx-glow:\s*var\(--anchor-glow\);/);
  });

  it("never derives a :root --ctx* from --section (the tokens.css §NOTE trap)", () => {
    // A --section/--section-2 reference inside a :root --ctx* declaration
    // resolves against the DEFAULT section for every route — the same bug that
    // painted --chrome-edge violet on all five groups. The lift belongs on
    // `.app-main`, where --section-2 is the route's own.
    const rootBlock = TOKENS_CSS.slice(
      TOKENS_CSS.indexOf(":root {"),
      TOKENS_CSS.indexOf("\n}", TOKENS_CSS.indexOf(":root {")),
    );
    for (const line of rootBlock.split("\n")) {
      const decl = line.split("/*")[0];
      if (!/^\s*--ctx(-2|-glow)?\s*:/.test(decl)) continue;
      expect(decl, decl.trim()).not.toMatch(/var\(--(section|sec-)/);
    }
  });

  it("--anchor* still resolves to the base --violet* triad", () => {
    expect(TOKENS_CSS).toMatch(/--anchor:\s*var\(--violet\);/);
    expect(TOKENS_CSS).toMatch(/--anchor-2:\s*var\(--violet-2\);/);
    expect(TOKENS_CSS).toMatch(/--anchor-glow:\s*var\(--violet-glow\);/);
  });

  it("the :root selection slots (--slot-ring/-fill/-fill-soft/-glow) derive from --ctx", () => {
    for (const token of ["--slot-ring", "--slot-fill", "--slot-fill-soft", "--slot-glow"]) {
      expect(TOKENS_CSS, token).toMatch(
        new RegExp(`${token}:\\s*[^;]*var\\(--ctx\\)[^;]*;`),
      );
    }
  });
});

// ─── Step 3: --ctx* IS the content section's hue, on `.app-main` ───────────
//
// Source-scan guards (jsdom applies no real CSS), same posture as
// contextMix.test.ts / sectionChrome.test.ts.

const APP_CSS = readAppCss();

describe("the CONTENT accent — --ctx* on .app-main", () => {
  it("re-declares the whole triad on .app-main, off --section-2", () => {
    expect(APP_CSS).toMatch(
      /\.app-main \{[^}]*--ctx:\s*var\(--section-2-lifted,\s*var\(--section-2\)\);/,
    );
    expect(APP_CSS).toMatch(
      /\.app-main \{[^}]*--ctx-2:\s*var\(--ctx-2-lifted,\s*var\(--section-2\)\);/,
    );
    expect(APP_CSS).toMatch(
      /\.app-main \{[^}]*--ctx-glow:\s*var\(--ctx-glow-lifted,\s*var\(--section-2\)\);/,
    );
  });

  it("--ctx REUSES --section-2-lifted rather than restating the 72%/0.14 lift", () => {
    // One lift, one register: the ring on a card and the contour under the
    // band must be derivable from the same variable.
    expect(APP_CSS).not.toMatch(/--ctx:\s*oklch\(from/);
  });

  it("lifts --ctx-2 / --ctx-glow under the relative-colour @supports guard", () => {
    expect(APP_CSS).toMatch(
      /@supports \(color: oklch\(from red l c h\)\) \{\s*\.app-main \{\s*--ctx-2-lifted: oklch\(from var\(--section-2\) 78% 0\.16 h\);\s*--ctx-glow-lifted: oklch\(from var\(--section-2\) 70% 0\.16 h \/ 0\.35\);/,
    );
  });

  it("holds the context lift at or under the 0.16 status-chroma ceiling", () => {
    // Separation from status is by HUE (≥30°, sectionHueSpacing.test.ts); the
    // chroma cap only stops context being LOUDER than the quietest status
    // colour — amber and green sit at 0.16, violet 0.18, red 0.20.
    for (const [, c] of APP_CSS.matchAll(
      /--ctx(?:-2|-glow)-lifted: oklch\(from var\(--section-2\) \d+% (0\.\d+) h/g,
    )) {
      expect(Number(c)).toBeLessThanOrEqual(0.16);
    }
  });

  it("restates the lit-slot quartet on .app-main (the :root copy is the overlays')", () => {
    const body = APP_CSS.slice(APP_CSS.indexOf(".app-main {"));
    for (const token of ["--slot-ring", "--slot-fill", "--slot-fill-soft", "--slot-glow"]) {
      expect(body, token).toMatch(
        new RegExp(`${token}:[^;]*var\\(--ctx\\)[^;]*;`),
      );
    }
  });

  it("re-derives the screen ground (--atmo-tint) on .app off the content hue", () => {
    // Its only consumer is the rail's fused active tab, which lives OUTSIDE
    // `.app-main` and has to end in the colour the screen actually paints.
    expect(APP_CSS).toMatch(
      /\.app \{\s*--atmo-tint: color-mix\(in oklab, var\(--section-2-lifted, var\(--section-2\)\) 8%, var\(--bg-1\)\);/,
    );
  });
});
