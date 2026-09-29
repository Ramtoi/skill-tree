import { describe, it, expect } from "vitest";
import { readAppCss } from "./readAppCss";
import { GROUP_IDS } from "@/lib/sections";

// ─── Context chrome: the second section hue ────────────────────────────────
//
// Source-scan guards, same posture as sectionChrome.test.ts: jsdom applies no
// real CSS, so the mechanism is pinned by reading the rule text. Three classes
// of regression these catch:
//
//  1. A hue that is declared but never routed (a group with no
//     `data-content-section` rule silently wears the chrome hue twice).
//  2. A derivation that drifts off the primary's ladder — `--chrome-edge-2` at
//     a different mix percentage, or the lift at a different L/C, would put the
//     two tones in different registers and break the contrast floor.
//  3. The mix leaking out of `.main-header` — onto the navigator head, the rail
//     strip, or into the no-mix state, which must stay pixel-identical.

const CSS = readAppCss();

/** Comment-free source: the guards read declarations, and every rule here
 *  carries a paragraph of prose above it that would otherwise land in the
 *  selector capture below. */
const BARE = CSS.replace(/\/\*[\s\S]*?\*\//g, "");

/** The body of the first rule whose selector matches `selectorRe`. */
function ruleBody(selectorRe: RegExp): string {
  const rules = [...BARE.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  const hit = rules.find((m) => selectorRe.test(m[1].trim()));
  return hit ? hit[2] : "";
}

describe("context-mix tokens", () => {
  it.each(GROUP_IDS)(
    'routes [data-content-section="%s"] to its own hue token',
    (id) => {
      expect(CSS).toMatch(
        new RegExp(
          `\\[data-content-section="${id}"\\][^}]*--section-2:\\s*var\\(--sec-${id}\\)`,
        ),
      );
    },
  );

  it("defaults --section-2 onto the chrome hue, so a no-mix route is a no-op", () => {
    expect(CSS).toMatch(/\.app\s*\{\s*--section-2:\s*var\(--section\);\s*\}/);
  });

  it("lifts the content hue with the SAME derivation as --section-lifted", () => {
    // Same @supports guard, same 72% L / 0.14 C. A different lift here would
    // make the two halves of the band read at two chroma registers.
    const primary = /@supports \(color: oklch\(from red l c h\)\) \{\s*\.app \{ --section-lifted: oklch\(from var\(--section\) 72% 0\.14 h\); \}/;
    const secondary = /@supports \(color: oklch\(from red l c h\)\) \{\s*\.app \{ --section-2-lifted: oklch\(from var\(--section-2\) 72% 0\.14 h\); \}/;
    expect(CSS).toMatch(primary);
    expect(CSS).toMatch(secondary);
  });

  it("derives --chrome-edge-2 with the SAME 85% mix as --chrome-edge", () => {
    const edge = (n: "" | "-2") =>
      new RegExp(
        `--chrome-edge${n}:\\s*color-mix\\(in oklab, var\\(--section${n === "-2" ? "-2" : ""}-lifted, var\\(--section${n}\\)\\) 85%, transparent\\)`,
      );
    expect(CSS).toMatch(edge(""));
    expect(CSS).toMatch(edge("-2"));
  });

  it("declares every secondary token on .app, never on :root", () => {
    // A custom property resolves its own var()s on the DECLARING element; at
    // :root `--section-2` is always the default hue, which is the exact bug
    // tokens.css §NOTE records for --chrome-edge.
    // BARE, not CSS: the guard reads DECLARATIONS, and the token block's own
    // prose names these tokens when it explains where they are declared
    // instead.
    const rootBlocks = [...BARE.matchAll(/(^|\})\s*:root\s*\{([^}]*)\}/g)].map(
      (m) => m[2],
    );
    for (const body of rootBlocks) {
      expect(body).not.toContain("--section-2");
      expect(body).not.toContain("--chrome-edge-2");
    }
    for (const token of ["--section-2:", "--chrome-edge-2:"]) {
      expect(CSS).toMatch(
        // A hyphen needs no escape outside a character class; the token is
        // literal text in the pattern.
        new RegExp(`\\.app[^{}]*\\{[^}]*${token}`),
      );
    }
  });
});

describe("context-mix chrome", () => {
  const mixBody = ruleBody(/^\.app\[data-context-mix="true"\] \.main-header$/);

  it("applies only under the attribute, and only to .main-header", () => {
    expect(mixBody).not.toBe("");
    // Nothing outside that rule may reach for the second hue…
    const consumers = [
      ...BARE.matchAll(
        /([^{}]+)\{([^{}]*(?:--section-2-lifted|--chrome-edge-2)[^{}]*)\}/g,
      ),
    ].map((m) => m[1].trim());
    for (const sel of consumers) {
      // `.app-main` joined `.app` as a sanctioned consumer in step 3: the
      // screen's own --ctx* triad and its --slot-* register ARE the content
      // hue now (shell-scaffold.css § The CONTENT accent), which is the whole
      // point of the second hue existing. Everything else must still stay
      // behind the attribute.
      const ok =
        sel === ".app" ||
        sel === ".app-main" ||
        sel.includes('[data-context-mix="true"]');
      expect(ok, `unguarded consumer: ${sel}`).toBe(true);
    }
    // …and the chrome region's other two band cells stay single-hued: they
    // belong to the section the user is IN, which is never mixed.
    for (const [, selector, body] of BARE.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!/\.side-head|\.app-topbar/.test(selector)) continue;
      expect(body, selector.trim()).not.toContain("--section-2");
      expect(body, selector.trim()).not.toContain("--chrome-edge-2");
    }
  });

  it("paints a SECOND lamp of the same family, not a stripe", () => {
    // Same radial family + same colour ladder as the chrome lamp in
    // shell-scaffold.css § The header band, anchored at the band's right end.
    expect(mixBody).toMatch(
      /radial-gradient\(var\(--mix-lamp-reach\) 560px at 100% 0,\s*color-mix\(in oklab, var\(--header-wash-2\) calc\(var\(--mix-lamp-register\) \* var\(--mix-strength\)\), transparent\), transparent 70%\)/,
    );
    // The primary lamp is still painted underneath, over the same ground.
    expect(mixBody).toContain("var(--lamp-x, 0px)");
    expect(mixBody).toContain("var(--bg-0)");
  });

  it("gives the content lamp reach across the header, not a corner tint", () => {
    // The screen header belongs to the CONTENT. Matched to the chrome lamp's
    // 14% / 1000px the second field cancelled across the middle and survived
    // only in the last ~15% of the width. It has to out-reach and out-burn the
    // chrome lamp to be read through it.
    const register = Number(CSS.match(/--mix-lamp-register:\s*(\d+)%/)![1]);
    const reach = Number(CSS.match(/--mix-lamp-reach:\s*(\d+)px/)![1]);
    expect(register).toBeGreaterThan(14);
    expect(reach).toBeGreaterThan(1000);
    // …but still atmosphere, not an accent: the section register tops out well
    // below where a `--sec-*` hue would start reading as status.
    expect(register).toBeLessThanOrEqual(28);
  });

  it("crosses the contour through border-image, keeping the box geometry", () => {
    // A bottom background layer would change where the 1px lands; border-image
    // repaints the border the shared band rule already declares.
    expect(mixBody).toContain("border-image-slice: 1");
    expect(mixBody).toMatch(
      /border-image-source: linear-gradient\(90deg,\s*var\(--chrome-edge\) 0%,\s*var\(--chrome-edge\) var\(--mix-line-start\),\s*var\(--edge-far\) var\(--mix-line-end\),\s*var\(--edge-far\) 100%\)/,
    );
  });

  it("hands the stroke over at the header's LEFT end, keeping both anchors", () => {
    const start = CSS.match(/--mix-line-start:\s*(\d+)%/);
    const end = CSS.match(/--mix-line-end:\s*(\d+)%/);
    expect(start).not.toBeNull();
    expect(end).not.toBeNull();
    const s = Number(start![1]);
    const e = Number(end![1]);
    // A ramp that starts at 0 or settles at 100 leaves no flat run for either
    // hue to be read as itself — the whole line becomes one muddled tone.
    expect(s).toBeGreaterThanOrEqual(5);
    expect(e).toBeLessThan(95);
    expect(e - s).toBeGreaterThanOrEqual(10);
    // The chrome anchor covers the identity column and nothing more: past ~35%
    // the hand-off starts landing under the status chips and the action
    // cluster, which reads as a corner tint on a chrome band rather than as the
    // content owning its own header.
    expect(e).toBeLessThanOrEqual(35);
  });

  it("reveals with a registered-property animation, off under reduced motion", () => {
    // A transition cannot work here: a route change MOUNTS a new .main-header,
    // and a fresh element starts at its final computed value.
    expect(CSS).toMatch(/@property --mix-strength \{[^}]*syntax: "<number>"/);
    expect(CSS).toMatch(
      /@keyframes context-mix-reveal \{\s*from \{ --mix-strength: 0; \}\s*to\s*\{ --mix-strength: 1; \}/,
    );
    expect(mixBody).toMatch(/animation: context-mix-reveal var\(--dur-10\)/);
    // Base value is 1 (not 0), so killing the animation lands on full strength
    // rather than erasing the mix.
    expect(mixBody).toMatch(/--mix-strength:\s*1;/);
    expect(CSS).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{[^@]*\.app\[data-context-mix="true"\] \.main-header \{ animation: none; \}/,
    );
  });
});
