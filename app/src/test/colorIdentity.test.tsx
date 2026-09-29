import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { bundleColor } from "@/components/bundleColors";
import { sourceAccent } from "@/lib/skillSource";
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
      // The exact-match anchor already rules out every semantic accent
      // token (`--green`, `--anchor`, `--ctx`, …) — a string matching
      // `^var\(--id-[0-7]\)$` cannot contain any of them, so a separate
      // `not.toContain` loop over that same set would be entailed, not
      // earned.
      expect(bundleColor(n)).toMatch(/^var\(--id-[0-7]\)$/);
    }
  });
});

describe("sourceAccent — identity ramp", () => {
  const ids = ["local", "starter", "org-skills", "design-system", "acme", "z"];

  it("is deterministic for a given source id", () => {
    for (const id of ids) expect(sourceAccent(id)).toBe(sourceAccent(id));
  });

  it("only ever returns identity-ramp tokens — never a semantic accent", () => {
    // The sources-ux retheme moved status onto badges, so the source color is
    // pure identity. It used to be a raw hsl() hue (and --violet / --amber for
    // the built-ins), which collided with the status vocabulary.
    for (const id of ids) {
      expect(sourceAccent(id)).toMatch(/^var\(--id-[0-7]\)$/);
      for (const tok of [
        "--green",
        "--cyan",
        "--blue",
        "--amber",
        "--violet",
        "--anchor",
        "--ctx",
        "--red",
      ]) {
        expect(sourceAccent(id)).not.toContain(tok);
      }
      expect(sourceAccent(id)).not.toContain("hsl(");
    }
  });

  it("gives the two built-ins distinct, fixed slots", () => {
    expect(sourceAccent("local")).not.toBe(sourceAccent("starter"));
  });

  it("keeps the `unknown` sentinel neutral — it is not an identity", () => {
    expect(sourceAccent("unknown")).toBe("var(--fg-mute)");
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
