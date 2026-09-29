import { describe, it, expect } from "vitest";
import { readAppCss } from "./readAppCss";

// CSS-contract test for PLAN §A1-b: `.resource-row`'s grid places every cell
// explicitly (never auto-placed), so an absent/empty cell costs zero width —
// no per-caller column override needed (see the `.cloud-skill-row` deletion
// this test also pins).
describe("ResourceRow grid — explicit placement (PLAN §A1-b)", () => {
  const css = readAppCss();

  it("declares column-gap: 0 and a five-column grid-template-columns", () => {
    const rule = css.match(/\.resource-row\s*\{[^}]*\}/)?.[0] ?? "";
    expect(rule).toMatch(/column-gap:\s*0/);
    // Five tracks: glyph · line · actions · badges · disclosure.
    expect(rule).toMatch(
      /grid-template-columns:\s*auto\s+minmax\(0,\s*1fr\)\s+auto\s+auto\s+auto/,
    );
  });

  it("places every cell with an explicit grid-column", () => {
    for (const cell of [
      "resource-glyph",
      "resource-line",
      "resource-actions",
      "resource-badges",
      "resource-disclosure",
    ]) {
      const re = new RegExp(
        `\\.resource-row\\s*>\\s*\\.${cell}\\s*\\{[^}]*grid-column:`,
      );
      expect(css).toMatch(re);
    }
  });

  it("spans .resource-detail across the full row width", () => {
    expect(css).toMatch(
      /\.resource-row\s*>\s*\.resource-detail\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/,
    );
  });

  it("no longer declares a bespoke grid-template-columns for .cloud-skill-row", () => {
    expect(css).not.toMatch(/\.cloud-skill-row\s*\{[^}]*grid-template-columns/);
  });
});
