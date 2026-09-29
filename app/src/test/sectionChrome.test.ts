import { describe, it, expect } from "vitest";
import { readAppCss } from "./readAppCss";
import {
  GROUP_IDS,
  GROUP_FOR_SECTION,
  GROUP_META,
  SECTION_IDS,
  SECTION_META,
} from "@/lib/sections";

// Source-scan guard (same shape as the invoke-import guard): the hue is per
// GROUP now, so every group the rail can be in must have a token AND a rule, or
// that group silently wears the default hue — which is the class of bug
// `--sec-backup` closed (N19), one layer up.

const CSS = readAppCss();

describe("group chrome tokens", () => {
  it.each(GROUP_IDS)("defines --sec-%s", (id) => {
    expect(CSS).toContain(`--sec-${id}:`);
  });

  it.each(GROUP_IDS)('routes [data-section="%s"] to its own token', (id) => {
    const rule = new RegExp(
      `\\[data-section="${id}"\\][^}]*--section:\\s*var\\(--sec-${id}\\)`,
    );
    expect(CSS).toMatch(rule);
  });

  it.each(GROUP_IDS)(
    'routes [data-content-section="%s"] to the same token',
    (id) => {
      // The CONTENT group (the section the route's own entity belongs to)
      // reads the same five hues through `--section-2`. Same failure mode one
      // layer over: a group with no rule here wears the chrome hue twice, so a
      // mixed header silently reads as un-mixed. Mechanism: contextMix.test.ts.
      const rule = new RegExp(
        `\\[data-content-section="${id}"\\][^}]*--section-2:\\s*var\\(--sec-${id}\\)`,
      );
      expect(CSS).toMatch(rule);
    },
  );

  it("keeps every group hue at the chrome chroma register (0.06)", () => {
    for (const id of GROUP_IDS) {
      const token = new RegExp(`--sec-${id}:\\s*oklch\\(72% 0\\.06 \\d+\\)`);
      expect(CSS, `--sec-${id}`).toMatch(token);
    }
  });

  it("retires the per-section tokens the group layer replaced", () => {
    // A leftover token is a hue nothing can reach — and an invitation to route
    // a new section straight past the group layer.
    for (const id of SECTION_IDS) {
      if ((GROUP_IDS as readonly string[]).includes(id)) continue;
      expect(CSS, `--sec-${id}`).not.toContain(`--sec-${id}:`);
      expect(CSS, `[data-section="${id}"]`).not.toContain(
        `[data-section="${id}"]`,
      );
    }
  });

  it("gives Backup a hue rather than the default: it rides the elsewhere group", () => {
    expect(GROUP_FOR_SECTION.backup).toBe("elsewhere");
    expect(CSS).toMatch(/--sec-elsewhere:\s*oklch\(/);
  });

  it("paints the panel header in the current section hue", () => {
    expect(CSS).toMatch(/\.side-head-name\s*\{[^}]*color:\s*var\(--section\)/);
  });

  it("lights the navigator's selection in the section hue, not brand violet", () => {
    // The chosen row is a "where am I" mark like the rail pill and the band
    // wash, so its slot tokens re-point at the section's lifted hue INSIDE
    // the panel. Scoped to `.app-side`: at :root `--section` would resolve
    // to the default and every group would light the same colour.
    // Several rules select `.app-side`; the one that owns the slot tokens is
    // the one that declares `--nav-accent`.
    const side =
      [...CSS.matchAll(/\.app-side\s*\{([^}]*)\}/g)]
        .map((m) => m[1])
        .find((body) => body.includes("--nav-accent")) ?? "";
    for (const token of ["--slot-ring", "--slot-fill", "--slot-fill-soft"]) {
      expect(side, token).toMatch(
        new RegExp(
          `${token}:\\s*color-mix\\(in oklab, var\\(--section-lifted, var\\(--section\\)\\) \\d+%, transparent\\)`,
        ),
      );
    }
    expect(side).toMatch(
      /--slot-glow:\s*inset [^;]*var\(--section-lifted, var\(--section\)\)/,
    );
    expect(side).toMatch(/--nav-accent:\s*var\(--section-lifted, var\(--section\)\)/);
    // No active-row rule may reach for the brand accent any more…
    const activeRules = CSS.match(/\.side-item[^{]*\[data-active="true"\][^{]*\{[^}]*\}/g) ?? [];
    expect(activeRules.length).toBeGreaterThan(0);
    for (const r of activeRules) expect(r).not.toMatch(/--violet|--anchor/);
    expect(CSS).toMatch(/\.side-item\[data-active="true"\] \.count \{ color: var\(--nav-accent\)/);
    expect(CSS).toMatch(/\.side-recent-chip\[aria-current="true"\] \{ color: var\(--nav-accent\)/);
    // …while focus keeps the brand ring, so focus and selection stay distinct.
    expect(CSS).toMatch(
      /\.side-item-main:focus-visible[^{]*\{[^}]*outline:\s*2px solid var\(--anchor-2\)/,
    );
  });

  it("names every section and every group", () => {
    for (const id of SECTION_IDS) {
      expect(SECTION_META[id].label.length).toBeGreaterThan(0);
      expect(SECTION_META[id].icon.length).toBeGreaterThan(0);
    }
    for (const id of GROUP_IDS) {
      expect(GROUP_META[id].label.length).toBeGreaterThan(0);
      expect(GROUP_META[id].icon.length).toBeGreaterThan(0);
    }
  });
});
