import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { bundleColor } from "@/components/bundleColors";
import { HarnessGlyph } from "@/components/harness/HarnessGlyph";

describe("bundleColor — identity ramp", () => {
  it("is deterministic for a given name", () => {
    expect(bundleColor("android")).toBe(bundleColor("android"));
    expect(bundleColor("openspec")).toBe(bundleColor("openspec"));
  });

  it("only ever returns identity-ramp tokens, never semantic accents", () => {
    const names = [
      "android",
      "openspec",
      "web",
      "workflow",
      "global-workflow",
      "workflow-test",
      "anything-else",
    ];
    for (const n of names) {
      expect(bundleColor(n)).toMatch(/^var\(--id-[0-7]\)$/);
    }
    // Explicitly never a semantic accent.
    const semantic = ["--green", "--cyan", "--blue", "--amber", "--violet"];
    for (const n of names) {
      for (const tok of semantic) {
        expect(bundleColor(n)).not.toContain(tok);
      }
    }
  });
});

describe("HarnessGlyph — brand-or-neutral identity", () => {
  it("renders Claude in its terracotta brand color", () => {
    const { container } = render(<HarnessGlyph id="claude-code" />);
    const glyph = container.querySelector(".harness-glyph") as HTMLElement;
    expect(glyph).not.toBeNull();
    expect(glyph.style.getPropertyValue("--harness-accent")).toBe("#D97757");
  });

  it("renders a brandless harness in neutral (no semantic accent token)", () => {
    const { container } = render(<HarnessGlyph id="codex" />);
    const glyph = container.querySelector(".harness-glyph") as HTMLElement;
    const accent = glyph.style.getPropertyValue("--harness-accent");
    expect(accent).toBe("var(--fg-strong)");
    expect(accent).not.toContain("--cyan");
  });

  it("falls back to a neutral monogram for unknown harness ids", () => {
    const { container } = render(
      <HarnessGlyph id="mystery-agent" label="Mystery Agent" />,
    );
    const glyph = container.querySelector(".harness-glyph") as HTMLElement;
    expect(glyph.classList.contains("has-monogram")).toBe(true);
    expect(glyph.textContent).toBe("MA");
    expect(glyph.style.getPropertyValue("--harness-accent")).toBe(
      "var(--fg-strong)",
    );
  });
});
