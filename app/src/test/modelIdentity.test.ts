import { describe, expect, it } from "vitest";
import { parseModelId } from "@/screens/usage/modelIdentity";

describe("parseModelId", () => {
  it("maps every model id seen in the local ledger to a display name and provider", () => {
    const table: Array<[string, string]> = [
      ["claude-fable-5-1", "Fable 5.1"],
      ["claude-fable-5", "Fable 5"],
      ["claude-sonnet-5", "Sonnet 5"],
      ["claude-opus-5", "Opus 5"],
      ["claude-haiku-4-5-20251001", "Haiku 4.5"],
      ["claude-opus-4-8", "Opus 4.8"],
      ["claude-sonnet-4-6", "Sonnet 4.6"],
      ["gpt-5.3-codex", "GPT-5.3 Codex"],
      ["gpt-5.4", "GPT-5.4"],
      ["gpt-5.4-mini", "GPT-5.4 mini"],
      ["gpt-5.4-nano", "GPT-5.4 nano"],
      ["gpt-5.6-sol", "GPT-5.6 Sol"],
      ["gpt-5.6-terra", "GPT-5.6 Terra"],
      ["gpt-5.6-luna", "GPT-5.6 Luna"],
      ["pi-default", "pi-default"],
      ["<synthetic>", "<synthetic>"],
      ["", ""],
    ];
    for (const [raw, display] of table) {
      expect(parseModelId(raw).display).toBe(display);
    }
    expect(parseModelId("claude-fable-5-1").provider).toBe("claude-code");
    expect(parseModelId("gpt-5.4").provider).toBe("codex");
    expect(parseModelId("pi-default").provider).toBeUndefined();
    expect(parseModelId("<synthetic>").provider).toBeUndefined();
    expect(parseModelId("").provider).toBeUndefined();
  });

  it("maps the legacy claude-<version>-<family>[-<date>] order to the same output", () => {
    expect(parseModelId("claude-3-5-sonnet-20241022").display).toBe("Sonnet 3.5");
  });

  it("splits a [pi] store prefix into a store tag and keeps the provider glyph", () => {
    const opus = parseModelId("[pi] claude-opus-4-6-thinking");
    expect(opus.display).toBe("Opus 4.6 · thinking");
    expect(opus.store).toBe("pi");
    expect(opus.provider).toBe("claude-code");

    const gpt = parseModelId("[pi] gpt-5.5");
    expect(gpt.display).toBe("GPT-5.5");
    expect(gpt.store).toBe("pi");
    expect(gpt.provider).toBe("codex");
  });

  it("renders a [1m] context suffix as a qualifier", () => {
    const identity = parseModelId("claude-opus-5[1m]");
    expect(identity.display).toBe("Opus 5 · 1M");
    expect(identity.provider).toBe("claude-code");
  });

  it("drops an 8-digit build date", () => {
    expect(parseModelId("claude-haiku-4-5-20251001").display).toBe("Haiku 4.5");
    expect(parseModelId("claude-haiku-4-5-20251001").display).not.toContain("20251001");
  });

  it("keeps an unknown shape verbatim with no provider", () => {
    const identity = parseModelId("pi-default");
    expect(identity.display).toBe(identity.raw);
    expect(identity.provider).toBeUndefined();
    expect(identity.store).toBeUndefined();
  });

  // REVIEW-W1 #4: a dotted version group ("4.5") used to fall through to
  // the qualifier branch — `claude-haiku-4.5` read "Haiku · 4.5" instead of
  // "Haiku 4.5", disagreeing with the dash-separated spelling of the same
  // version AND with the gpt family, which already accepted dots.
  it("treats a dotted version group as a version, not a qualifier", () => {
    expect(parseModelId("claude-haiku-4.5").display).toBe("Haiku 4.5");
    expect(parseModelId("claude-haiku-4-5").display).toBe("Haiku 4.5");
  });
});
