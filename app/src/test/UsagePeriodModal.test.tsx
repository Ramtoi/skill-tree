import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { periodFromKey, type UsagePeriod, type UsagePeriodKind } from "@/screens/usage/usagePeriod";
import { UsagePeriodModal } from "@/screens/usage/UsagePeriodModal";
import type { UsageDailyPoint, UsageSessionRow } from "@/features/usage/usageTypes";
import { makeDeferred, renderWithProviders } from "./helpers";

const tokens = { input: 100, output: 20, cacheRead: 1000, cacheCreation: 0, total: 1120 };
const cost = { usd: 2, label: "Estimated API-equivalent cost" as const };
const point: UsageDailyPoint = { date: "2026-09-09", tokens, estimatedCost: cost,
  harnesses: [{ id: "codex", name: "Codex", tokens, estimatedCost: cost, models: [{ modelName: "gpt-6-astra", tokens, estimatedCost: cost }] }] };
const session: UsageSessionRow = { id: "session-1", period: "2026-09-09", lastActivity: "2026-09-09T12:00:00Z", harnessId: "codex", harnessName: "Codex", title: "Inspect the daily modal", models: ["gpt-6-astra"], tokens, estimatedCost: cost, toolCalls: 999 };
const onInspect = vi.fn();
const timelineReply = (day: string) => ({ success: true, output: JSON.stringify({ schema_version: 1, since: day, until: day,
  days: day === "2026-09-09" ? [{ date: day, tools: { "built-in": 7, touchpoint: 2 }, skills: {} }] : [],
  peaks: { unit: "tokens", grid: [] }, harnesses: [] }) });
let failing = false;
let gate: ReturnType<typeof makeDeferred> | undefined;
function Harness({ backfill = false, available = true, dailyReady = true, kind = "day" }: { backfill?: boolean; available?: boolean; dailyReady?: boolean; kind?: UsagePeriodKind }) {
  const [period, setPeriod] = useState<UsagePeriod | null>(null);
  const daily: UsageDailyPoint[] = backfill ? [{ ...point, provenance: "backfilled", harnesses: point.harnesses.map(h => ({ ...h, costKnown: false, splitKnown: false, models: h.models?.map(m => ({ ...m, costKnown: false })) })) }] : [point];
  return <><button onClick={() => setPeriod(periodFromKey(kind, kind === "month" ? "2026-09" : "2026-09-09"))}>Open day</button><UsagePeriodModal period={period} onPeriodChange={setPeriod} onClose={() => setPeriod(null)} firstDay="2026-09-08" lastDay={kind === "day" ? "2026-09-10" : "2026-09-30"}
    daily={daily} sessions={backfill ? [] : [session]} dailyReady={dailyReady} dailyError={!dailyReady} sessionsAvailable={available} scanned={!backfill}
    harness="codex" harnessName="Codex" currency="EUR" eurRate={0.5} onInspect={onInspect} /></>;
}
beforeEach(() => {
  failing = false; gate = undefined; onInspect.mockClear();
  const previous = vi.mocked(invoke).getMockImplementation();
  vi.mocked(invoke).mockImplementation((async (command: string, params?: { args?: string[] }) => {
    if (command === "hub_cmd" && params?.args?.[1] === "timeline") {
      if (gate) return gate.promise;
      if (failing) throw new Error("Timeline unavailable");
      return timelineReply(params.args[params.args.indexOf("--since") + 1]);
    }
    return previous?.(command, params);
  }) as typeof invoke);
});

describe("day detail modal", () => {
  it.each(["week", "month"] as const)("reads the full %s and sums dated tool servers across its days", async kind => {
    const previous = vi.mocked(invoke).getMockImplementation();
    vi.mocked(invoke).mockImplementation((async (command: string, params?: { args?: string[] }) => {
      if (command === "hub_cmd" && params?.args?.[1] === "timeline") return { success: true, output: JSON.stringify({ schema_version: 1,
        days: [
          { date: "2026-09-08", tools: { "built-in": 7, touchpoint: 2 }, skills: {} },
          { date: "2026-09-09", tools: { "built-in": 3 }, skills: {} },
          { date: "2026-10-01", tools: { "built-in": 999 }, skills: {} },
        ], peaks: { unit: "tokens", grid: [] }, harnesses: [] }) };
      return previous?.(command, params);
    }) as typeof invoke);
    const user = userEvent.setup(); renderWithProviders(<Harness kind={kind} />);
    await user.click(screen.getByRole("button", { name: "Open day" }));
    const dialog = screen.getByRole("dialog");
    await waitFor(() => expect(within(dialog).getByText("12", { selector: ".value" })).toBeVisible());
    expect(within(dialog).getByText("10", { selector: ".usage-day-tools li > span:last-child" })).toBeVisible();
    const bounds = kind === "week" ? ["2026-09-07", "2026-09-13"] : ["2026-09-01", "2026-09-30"];
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("hub_cmd", { args: ["usage", "timeline", "--json", "--since", bounds[0], "--until", bounds[1], "--harness", "codex"] });
    expect(within(dialog).getByRole("button", { name: `Previous ${kind}` })).toHaveAttribute("aria-disabled", "true");
    if (kind === "month") expect(within(dialog).getByRole("button", { name: "Next month" })).toHaveAttribute("aria-disabled", "true");
  });
  it("reads only the selected UTC day, keeps currency/harness and separates daily tool counts", async () => {
    const user = userEvent.setup(); renderWithProviders(<Harness />);
    expect(vi.mocked(invoke).mock.calls.filter(([, args]) => (args as { args?: string[] })?.args?.[1] === "timeline")).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Open day" }));
    const dialog = screen.getByRole("dialog", { name: /September.*9.*2026/ });
    await waitFor(() => expect(within(dialog).getByText("9", { selector: ".value" })).toBeVisible());
    expect(within(dialog).getByText("€1.00", { selector: ".value" })).toBeVisible();
    expect(within(dialog).getByText("Codex · Daily usage")).toBeVisible();
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("hub_cmd", { args: ["usage", "timeline", "--json", "--since", "2026-09-09", "--until", "2026-09-09", "--harness", "codex"] });
    expect(vi.mocked(invoke).mock.calls.some(([cmd, args]) => cmd === "usage_scan_ccusage" || (args as { args?: string[] })?.args?.includes("scan-sessions"))).toBe(false);
    await user.click(within(dialog).getByRole("button", { name: "Next day" }));
    await waitFor(() => expect(within(dialog).getByText("No recorded activity")).toBeVisible());
    expect(within(dialog).getByRole("button", { name: "Next day" })).toHaveAttribute("aria-disabled", "true");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.getByRole("button", { name: "Open day" })).toHaveFocus());
  });
  it("keeps missing history and scan details unknown instead of zero", async () => {
    const user = userEvent.setup(); renderWithProviders(<Harness backfill />);
    await user.click(screen.getByRole("button", { name: "Open day" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getAllByText("Unknown", { selector: ".value" })).toHaveLength(2);
    expect(within(dialog).getByText(/Token composition is unavailable/)).toBeVisible();
    expect(within(dialog).getByText(/Session details are unavailable/)).toBeVisible();
    await waitFor(() => expect(within(dialog).getByText("9", { selector: ".value" })).toBeVisible());
  });
  it("shows pending and failed tools independently and retries only the read", async () => {
    const user = userEvent.setup(); gate = makeDeferred();
    renderWithProviders(<Harness dailyReady={false} available={false} />);
    await user.click(screen.getByRole("button", { name: "Open day" }));
    expect(screen.getByText("Loading…", { selector: ".value" })).toBeVisible();
    expect(screen.getByText(/Daily usage could not be loaded/)).toBeVisible();
    gate.reject(new Error("failed read"));
    await screen.findByRole("button", { name: "Retry tool activity" });
    gate = undefined;
    await user.click(screen.getByRole("button", { name: "Retry tool activity" }));
    await waitFor(() => expect(screen.getByText("9", { selector: ".value" })).toBeVisible());
  });
  it("searches, expands and inspects only matching sessions; resets search when changing days", async () => {
    const user = userEvent.setup(); renderWithProviders(<Harness />);
    await user.click(screen.getByRole("button", { name: "Open day" }));
    const search = screen.getByRole("textbox", { name: "Search this day's sessions" });
    await user.type(search, "no match");
    expect(screen.getByText("No sessions match your search.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Next day" }));
    await user.click(screen.getByRole("button", { name: "Previous day" }));
    expect(screen.getByRole("textbox", { name: "Search this day's sessions" })).toHaveValue("");
    await user.click(screen.getByText(session.title!));
    await user.click(screen.getByRole("button", { name: "Inspect session" }));
    expect(onInspect).toHaveBeenCalledWith(session);
  });
});
