import { describe, expect, it } from "vitest";
import { estimateTokens } from "@/lib/estimateTokens";
import { footprintTokens, primaryHarness, tokensOf } from "@/lib/footprintTokens";
import type { UsageFootprintPayload } from "@/features/usage/usageAnalyticsTypes";

const payload: UsageFootprintPayload = {
  ok: true,
  project: "alpha",
  window: null,
  last_scan_at: null,
  harnesses: {
    "claude-code": {
      parts: [
        { part: "skills", label: "Skills", text: "skill text", bytes: 10 },
        { part: "agent_docs", label: "Docs", text: "doc text", bytes: 8 },
      ],
      unknown: [],
      bytes_total: 18,
      approx_tokens: 5,
      skill_lines: [{ key: "alpha", text: "alpha: skill", bytes: 12 }],
      discoverable: [{ rel: "nested/AGENTS.md", text: "nested text", bytes: 11 }],
      discoverable_bytes: 11,
      discoverable_truncated: false,
    },
  },
};

describe("footprintTokens", () => {
  it("tokenizes every part and keeps the additive total", () => {
    const result = footprintTokens(payload, "claude-code");
    expect(result?.parts.map((part) => part.tokens)).toEqual([
      estimateTokens("skill text"),
      estimateTokens("doc text"),
    ]);
    expect(result?.total).toBe(result?.parts.reduce((sum, part) => sum + part.tokens, 0));
    expect(result?.upfront).toBe(estimateTokens("doc text"));
    expect(result?.bySkill.get("alpha")).toBe(estimateTokens("alpha: skill"));
    expect(result?.discoverable).toBe(estimateTokens("nested text"));
  });

  it("selects claude-code first and falls back deterministically", () => {
    expect(primaryHarness(payload)).toBe("claude-code");
    expect(primaryHarness({ ...payload, harnesses: { z: payload.harnesses["claude-code"] } })).toBe("z");
    expect(primaryHarness({ ...payload, harnesses: {} })).toBeNull();
    expect(footprintTokens(payload, "missing")).toBeNull();
  });

  it("memoizes identical text", () => {
    expect(tokensOf("memoized text")).toBe(tokensOf("memoized text"));
  });

  it("keeps totals under their own harness", () => {
    const codex = { ...payload.harnesses["claude-code"], parts: [
      { part: "agent_docs", label: "Docs", text: "a much longer codex document", bytes: 28 },
    ] };
    const multi = { ...payload, harnesses: { "claude-code": payload.harnesses["claude-code"], codex } };
    const claude = footprintTokens(multi, "claude-code");
    const codexTokens = footprintTokens(multi, "codex");
    expect(codexTokens?.total).not.toBe(claude?.total);
    expect(codexTokens?.total).toBe(tokensOf("a much longer codex document"));
  });
});
