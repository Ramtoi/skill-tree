import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { LoadoutUsageHeader } from "@/screens/project/LoadoutUsageHeader";

vi.mock("@/screens/usage/UsageScanAction", () => ({
  ScanButton: ({ children, variant }: { children: string; variant: string }) => <button data-variant={variant}>{children}</button>,
}));

describe("LoadoutUsageHeader", () => {
  it("uses the shared age line and Scan before the first scan", () => {
    render(<LoadoutUsageHeader lastScanAt={null} now={new Date("2026-09-07T02:00:00Z")} />);
    expect(screen.getByText("usage never scanned")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Scan" })).toHaveAttribute("data-variant", "ghost");
  });

  it("calls the post-scan action Refresh", () => {
    render(<LoadoutUsageHeader lastScanAt="2026-09-07T00:00:00Z" now={new Date("2026-09-07T02:00:00Z")} />);
    expect(screen.getByText("usage as of 2h ago")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeInTheDocument();
  });
});
