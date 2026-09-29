import { describe, expect, it } from "vitest";
import { harnessColorIndex, orderHarnessIds } from "@/screens/usage/harnessIdentity";

describe("canonical harness identity", () => {
  it("shares Claude's colour and order slot across hub and ccusage ids", () => {
    expect(harnessColorIndex("claude-code")).toBe(harnessColorIndex("claude"));
    expect(orderHarnessIds(["pi", "codex", "claude-code"])[0]).toBe("claude-code");
  });

  it("keeps ccusage ids in their established order and colours", () => {
    expect(orderHarnessIds(["pi", "codex", "claude"])).toEqual(["claude", "codex", "pi"]);
    expect(["claude", "codex", "pi", "opencode"].map(harnessColorIndex)).toEqual([0, 1, 2, 3]);
  });
});
