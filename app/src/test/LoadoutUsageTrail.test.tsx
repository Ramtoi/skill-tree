import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { LoadoutUsageTrail } from "@/screens/project/LoadoutUsageTrail";
import type { UsageUtilizationRow } from "@/features/usage/usageAnalyticsTypes";

const row = (overrides: Partial<UsageUtilizationRow> = {}): UsageUtilizationRow => ({
  key: "demo",
  count: 12,
  you: 2,
  model: 9,
  script: 1,
  last_used_at: "2026-09-06T12:00:00Z",
  trail: [0, 1, 2],
  footprint_bytes: 999999,
  harnesses: ["claude-code"],
  sessions_with_skill: 6,
  idle: false,
  ...overrides,
});

describe("LoadoutUsageTrail", () => {
  it("renders the split, chart, and token estimate", () => {
    render(<LoadoutUsageTrail row={row()} tokens={{ harness: "claude-code", parts: [], upfront: 0, total: 0, discoverable: 0, discoverableTruncated: false, bySkill: new Map([["demo", 148]]) }} skillKey="demo" lastScanAt="2026-09-01T00:00:00Z" />);
    expect(screen.getByText("12")).toBeInTheDocument();
    expect(screen.getByText("you")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("~148 tokens upfront")).toBeInTheDocument();
    expect(screen.getByTestId("loadout-usage-trail")).toHaveAttribute("title", "2026-09-06T12:00:00Z");
  });

  it("omits zero invokers and states idle or insufficient history", () => {
    const { rerender } = render(<LoadoutUsageTrail row={row({ you: 0, model: 12, script: 0, count: 0, idle: true })} tokens={null} skillKey="demo" lastScanAt={null} />);
    expect(screen.getByText("no invocations in 30 days")).toBeInTheDocument();
    expect(screen.queryByText(/you/)).toBeNull();
    rerender(<LoadoutUsageTrail row={row({ count: 0, idle: false, sessions_with_skill: 2 })} tokens={null} skillKey="demo" lastScanAt={null} />);
    expect(screen.getByText("not enough history yet (2 sessions counted)")).toBeInTheDocument();
  });

  it("renders no trail when there is no utilization row", () => {
    const { container } = render(<LoadoutUsageTrail row={undefined} tokens={null} skillKey="demo" lastScanAt={null} />);
    expect(container.firstChild).toBeNull();
  });
});
