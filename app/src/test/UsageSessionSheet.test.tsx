import { describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { useAppStore } from "@/store";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { focusManager } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import inspectionFixture from "../../../tests/fixtures/usage/inspection-session.json";
import { UsageSessionsCard } from "@/screens/usage/UsageSessionsCard";
import { UsageSessionSheet } from "@/screens/usage/UsageSessionSheet";
import { UsageInspectionTimeline } from "@/screens/usage/UsageInspectionTimeline";
import { UsageInspectionPanel } from "@/screens/usage/UsageInspectionPanel";
import { renderWithProviders, makeDeferred } from "./helpers";
import type { InspectionIndexSession } from "@/features/usage/usageInspectionTypes";
import type { InspectionPayload } from "@/features/usage/usageInspectionTypes";
import type { UsageSessionRow, UsageTokenCounts } from "@/features/usage/usageTypes";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(async () => undefined),
}));

function tok(total: number): UsageTokenCounts {
  return { input: total, output: 0, cacheCreation: 0, cacheRead: 0, total };
}

function sampleSession(overrides: Partial<UsageSessionRow> = {}): UsageSessionRow {
  const inspection = inspectionFixture.index.sessions[0] as InspectionIndexSession;
  return {
    id: inspection.session_id,
    // The inspector transport is keyed by the durable session key.  The
    // timeline's run id is a child selector and must stay inside inspection.
    period: inspection.session_id,
    harnessId: "claude",
    harnessName: "Claude Code",
    models: ["claude-sonnet-5"],
    tokens: tok(inspection.scopes.own.tokens.total ?? 0),
    estimatedCost: { usd: inspection.scopes.own.cost.value ?? 0, label: "Estimated API-equivalent cost" },
    toolCalls: 1,
    inspection,
    ...overrides,
  };
}

function cardBaseProps() {
  return {
    effectiveShowFullPaths: false,
    onShowFullPathsChange: vi.fn(),
    hasFullFidelityData: true,
    busy: false,
    onRunFreshScan: vi.fn(),
    currency: "USD" as const,
    eurRate: 0.86,
  };
}

describe("UsageSessionSheet", () => {
  it("opens from Inspect session and closes on Escape", async () => {
    renderWithProviders(<UsageSessionsCard sessions={[sampleSession()]} {...cardBaseProps()} />);

    fireEvent.click(screen.getByTestId("usage-session-row"));
    fireEvent.click(await screen.findByRole("button", { name: "Inspect session" }));

    const dialog = await screen.findByRole("dialog");
    expect(await screen.findByTestId("usage-inspection-panel")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Timeline" })).toBeChecked();

    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("renders all observed lanes, relationship evidence, and selected-agent stats", async () => {
    renderWithProviders(<UsageSessionSheet session={sampleSession()} onClose={vi.fn()} />);

    expect((await screen.findAllByText("Main session")).length).toBeGreaterThan(1);
    expect(screen.getByText("Worker")).toBeInTheDocument();
    expect(screen.getByText("Targeted Wait")).toBeInTheDocument();

    const lanes = await screen.findAllByTestId("usage-inspection-lane");
    // Every lane names the model that answered, as the shared ModelName label.
    for (const lane of lanes) expect(lane).toHaveTextContent(/Sonnet 5/);
    fireEvent.click(lanes.find((lane) => lane.textContent?.includes("Worker"))!);
    expect(await screen.findByRole("region", { name: "Worker statistics" })).toHaveTextContent("Own");
    expect(screen.getByText("5 tok · 0 tools")).toBeInTheDocument();
  });

  it("switches to captured Tool calls and opens retained body evidence", async () => {
    renderWithProviders(<UsageSessionSheet session={sampleSession()} onClose={vi.fn()} />);

    fireEvent.click(await screen.findByRole("radio", { name: "Tool calls" }));
    expect(await screen.findByText(/captured calls/)).toBeInTheDocument();
    const group = screen.getByRole("button", { name: /Bash.*git status/ });
    fireEvent.click(group);
    fireEvent.click(await screen.findByRole("button", { name: /Input: available/ }));

    await waitFor(() => expect(screen.getByRole("region", { name: "Captured body" })).toHaveTextContent("git status"));
  });

  it("copies exactly the displayed formatted request by keyboard without retrieving more data", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    renderWithProviders(<UsageSessionSheet session={sampleSession()} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("radio", { name: "Tool calls" }));
    fireEvent.click(await screen.findByRole("button", { name: /Bash.*git status/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Input: available/ }));
    const region = await screen.findByRole("region", { name: "Captured body" });
    const expected = '{\n  "command": "git status"\n}';
    await waitFor(() => expect(region.querySelector("pre")?.textContent).toBe(expected));
    const reads = vi.mocked(invoke).mock.calls.length;
    const copy = within(region).getByRole("button", { name: "Copy displayed text" });
    copy.focus();
    await user.tab();
    await user.tab({ shift: true });
    expect(copy).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(writeText).toHaveBeenCalledExactlyOnceWith(expected);
    expect(useAppStore.getState().toasts).toEqual(expect.arrayContaining([expect.objectContaining({ title: "Displayed text copied" })]));
    expect(vi.mocked(invoke).mock.calls).toHaveLength(reads);
  });

  it.each([
    ["result", "text/plain", "  café\tresult\r\n\n", "  café\tresult\r\n\n"],
    ["patch", "text/plain", "diff --git a/a b/a\n-old\n+new  \n", "diff --git a/a b/a\n-old\n+new  \n"],
    ["invalid JSON", "application/json", '{"partial":  \n', '{"partial":  \n'],
    ["empty result", "text/plain", "", ""],
  ])("copies the displayed %s without changing whitespace", async (kind, contentType, raw, expected) => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const previous = vi.mocked(invoke).getMockImplementation()!;
    vi.mocked(invoke).mockImplementation(async (cmd, args) => {
      const values = (args as { args?: string[] })?.args ?? [];
      if (cmd === "hub_cmd" && values.includes("--body")) return { success: true, output: JSON.stringify({
        ok: true, status: "available", content_type: contentType,
        chunks: [{ seq: 0, base64: btoa(String.fromCharCode(...new TextEncoder().encode(raw))) }], next_after_chunk: null,
      }) };
      return previous(cmd, args);
    });
    renderWithProviders(<UsageSessionSheet session={sampleSession()} onClose={vi.fn()} />);
    if (kind === "patch") {
      fireEvent.click(await screen.findByRole("radio", { name: "Changes" }));
      fireEvent.click(await screen.findByRole("button", { name: "Open retained patch body" }));
    } else {
      fireEvent.click(await screen.findByRole("radio", { name: "Tool calls" }));
      fireEvent.click(await screen.findByRole("button", { name: /Bash.*git status/ }));
      fireEvent.click(await screen.findByRole("button", { name: /Recorded result: available/ }));
    }
    const region = await screen.findByRole("region", { name: "Captured body" });
    await waitFor(() => expect(region.querySelector("pre")?.textContent).toBe(expected));
    const reads = vi.mocked(invoke).mock.calls.length;
    await user.click(within(region).getByRole("button", { name: "Copy displayed text" }));
    expect(writeText).toHaveBeenCalledExactlyOnceWith(expected);
    expect(vi.mocked(invoke).mock.calls).toHaveLength(reads);
  });

  it("copies only a partial prefix and keeps both retrieval and truncation notices", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const previous = vi.mocked(invoke).getMockImplementation()!;
    vi.mocked(invoke).mockImplementation(async (cmd, args) => {
      const values = (args as { args?: string[] })?.args ?? [];
      if (cmd === "hub_cmd" && values.includes("--body")) return { success: true, output: JSON.stringify(
        values.includes("--after-chunk") ? { ok: false, status: "unavailable" } : {
          ok: true, status: "truncated", content_type: "text/plain",
          chunks: [{ seq: 0, base64: btoa("  retained prefix\n") }], next_after_chunk: 1,
        },
      ) };
      return previous(cmd, args);
    });
    renderWithProviders(<UsageSessionSheet session={sampleSession()} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("radio", { name: "Tool calls" }));
    fireEvent.click(await screen.findByRole("button", { name: /Bash.*git status/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Input: available/ }));
    const region = await screen.findByRole("region", { name: "Captured body" });
    await within(region).findByText(/More body pages could not be retrieved/);
    expect(region.querySelector("pre")?.textContent).toBe("  retained prefix\n");
    const reads = vi.mocked(invoke).mock.calls.length;
    await user.click(within(region).getByRole("button", { name: "Copy displayed text" }));
    expect(writeText).toHaveBeenCalledExactlyOnceWith("  retained prefix\n");
    expect(region).toHaveTextContent("The retained source body is truncated");
    expect(region).toHaveTextContent("More body pages could not be retrieved");
    expect(vi.mocked(invoke).mock.calls).toHaveLength(reads);
  });

  it.each(["available", "unavailable", "pruned", "rejected"])("cannot copy the previous input while switching to a %s result", async (status) => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const pending = makeDeferred();
    const previous = vi.mocked(invoke).getMockImplementation()!;
    let bodyReads = 0;
    vi.mocked(invoke).mockImplementation(async (cmd, args) => {
      const values = (args as { args?: string[] })?.args ?? [];
      if (cmd === "hub_cmd" && values.includes("--body") && ++bodyReads === 2) return pending.promise;
      return previous(cmd, args);
    });
    renderWithProviders(<UsageSessionSheet session={sampleSession()} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("radio", { name: "Tool calls" }));
    fireEvent.click(await screen.findByRole("button", { name: /Bash.*git status/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Input: available/ }));
    const region = await screen.findByRole("region", { name: "Captured body" });
    const copy = within(region).getByRole("button", { name: "Copy displayed text" });
    await waitFor(() => expect(copy).toBeEnabled());
    await user.click(copy);
    writeText.mockClear();
    fireEvent.click(await screen.findByRole("button", { name: /Recorded result: available/ }));
    await within(region).findByText("Loading retained body…");
    expect(copy).toBeDisabled();
    expect(region.querySelector("pre")).toBeNull();
    await user.click(copy);
    expect(writeText).not.toHaveBeenCalled();
    if (status === "rejected") pending.reject(new Error("read failed"));
    else pending.resolve({ success: true, output: JSON.stringify({
      ok: status === "available", status, reason: status,
      content_type: "text/plain", chunks: [{ seq: 0, base64: btoa("new result\n") }], next_after_chunk: null,
    }) });
    await waitFor(() => expect(within(region).queryByText("Loading retained body…")).toBeNull());
    if (status === "available") {
      expect(copy).toBeEnabled();
      await user.click(copy);
      expect(writeText).toHaveBeenCalledExactlyOnceWith("new result\n");
    } else {
      expect(copy).toBeDisabled();
      await user.click(copy);
      expect(writeText).not.toHaveBeenCalled();
    }
  });

  it("reports clipboard rejection and lets the user retry with Space", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockRejectedValueOnce(new Error("denied")).mockResolvedValue();
    renderWithProviders(<UsageSessionSheet session={sampleSession()} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("radio", { name: "Tool calls" }));
    fireEvent.click(await screen.findByRole("button", { name: /Bash.*git status/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Input: available/ }));
    const copy = await screen.findByRole("button", { name: "Copy displayed text" });
    await waitFor(() => expect(copy).toBeEnabled());
    await user.click(copy);
    expect(useAppStore.getState().toasts).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "error", title: "Couldn't copy displayed text" })]));
    expect(useAppStore.getState().toasts.some((toast) => toast.kind === "success")).toBe(false);
    expect(copy).toBeEnabled();
    await user.keyboard(" ");
    expect(writeText).toHaveBeenCalledTimes(2);
    expect(useAppStore.getState().toasts).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "success", title: "Displayed text copied" })]));
  });

  it("jumps from a selected agent to its calls and can restore all agents", async () => {
    renderWithProviders(<UsageSessionSheet session={sampleSession()} onClose={vi.fn()} />);
    fireEvent.click((await screen.findAllByTestId("usage-inspection-lane")).find((lane) => lane.textContent?.includes("Worker"))!);
    await screen.findByRole("region", { name: "Worker statistics" });
    fireEvent.click(screen.getByRole("button", { name: "Open Tool calls for this agent" }));
    const filter = await screen.findByRole("combobox", { name: "Filter tool calls by agent" });
    expect(filter).toHaveValue("run:child");
    expect(screen.getByText("Worker")).toBeInTheDocument();
    fireEvent.change(filter, { target: { value: "all" } });
    expect(filter).toHaveValue("all");
  });

  it("switches to Changes with attribution and file evidence", async () => {
    renderWithProviders(<UsageSessionSheet session={sampleSession()} onClose={vi.fn()} />);

    fireEvent.click(await screen.findByRole("radio", { name: "Changes" }));
    expect(await screen.findByText("tool patch")).toBeInTheDocument();
    expect(screen.getByText("confirmed")).toBeInTheDocument();
    expect(screen.getByText("src/demo.py")).toBeInTheDocument();
  });

  it("opens the retained patch body from Changes", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd !== "hub_cmd") return undefined;
      const values = (args as { args?: string[] } | undefined)?.args ?? [];
      if (values.includes("--body")) return { success: true, output: JSON.stringify({ ok: true, body_id: "body:patch", status: "available", content_type: "text/plain", total_bytes: 38, chunks: [{ seq: 0, bytes: 38, base64: btoa("diff --git a/src/demo.py b/src/demo.py") }], next_after_chunk: null }) };
      if (values[1] === "pin" && values[2] === "list") return { success: true, output: JSON.stringify(inspectionFixture.pins) };
      if (values[1] === "inspect") return { success: true, output: JSON.stringify(inspectionFixture.overview) };
      return { success: true, output: "{}" };
    });
    renderWithProviders(<UsageSessionSheet session={sampleSession()} onClose={vi.fn()} />);

    fireEvent.click(await screen.findByRole("radio", { name: "Changes" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open retained patch body" }));
    await waitFor(() => expect(screen.getByRole("region", { name: "Captured body" })).toHaveTextContent("diff --git"));
  });

  it("names a pruned body side and date without offering a retry", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd !== "hub_cmd") return undefined;
      const values = (args as { args?: string[] } | undefined)?.args ?? [];
      if (values[1] === "pin" && values[2] === "list") return { success: true, output: JSON.stringify(inspectionFixture.pins) };
      if (values.includes("--body")) return { success: true, output: JSON.stringify({ ok: false, body_id: "body:pruned", status: "pruned", reason: "pruned", pruned_at: "2026-06-04T00:00:00.000Z" }) };
      if (values.includes("--view") && values.includes("overview")) return { success: true, output: JSON.stringify(inspectionFixture.captured_contract["claude-code"].overview) };
      if (values.includes("--view") && values.includes("tools")) return { success: true, output: JSON.stringify(inspectionFixture.captured_contract["claude-code"].tools) };
      return { success: true, output: JSON.stringify({ ok: true }) };
    });
    renderWithProviders(<UsageInspectionPanel harness="claude-code" sessionId={inspectionFixture.captured_contract["claude-code"].session_id} />);

    fireEvent.click(await screen.findByRole("radio", { name: "Tool calls" }));
    fireEvent.click(await screen.findByRole("button", { name: /Bash.*git status/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Input: available/ }));
    const body = await screen.findByRole("region", { name: "Captured body" });
    await waitFor(() => expect(body).toHaveTextContent(/Input was pruned/));
    expect(body).toHaveTextContent("2026");
    expect(within(body).queryByRole("button", { name: "Retry body" })).toBeNull();
    fireEvent.click(within(body).getByRole("button", { name: "Close" }));
    fireEvent.click(await screen.findByRole("button", { name: /Recorded result: available/ }));
    const resultBody = await screen.findByRole("region", { name: "Captured body" });
    await waitFor(() => expect(resultBody).toHaveTextContent(/Result was pruned/));
  });

  it("rechecks a reopened body and hides cached bytes while it becomes pruned", async () => {
    let bodyReads = 0;
    let releaseSecondRead!: (value: unknown) => void;
    const secondRead = new Promise<unknown>((resolve) => { releaseSecondRead = resolve; });
    const bodyId = inspectionFixture.captured_contract["claude-code"].tools.items[0].input_parts[0].body_id;
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd !== "hub_cmd") return undefined;
      const values = (args as { args?: string[] } | undefined)?.args ?? [];
      if (values[1] === "pin" && values[2] === "list") return { success: true, output: JSON.stringify(inspectionFixture.pins) };
      if (values.includes("--body")) {
        bodyReads += 1;
        if (bodyReads === 1) return { success: true, output: JSON.stringify({ ok: true, body_id: bodyId, status: "available", content_type: "text/plain", total_bytes: 9, chunks: [{ seq: 0, bytes: 9, base64: btoa("old bytes") }], next_after_chunk: null }) };
        return secondRead;
      }
      if (values.includes("--view") && values.includes("overview")) return { success: true, output: JSON.stringify(inspectionFixture.captured_contract["claude-code"].overview) };
      if (values.includes("--view") && values.includes("tools")) return { success: true, output: JSON.stringify(inspectionFixture.captured_contract["claude-code"].tools) };
      return { success: true, output: JSON.stringify({ ok: true }) };
    });
    renderWithProviders(<UsageInspectionPanel harness="claude-code" sessionId={inspectionFixture.captured_contract["claude-code"].session_id} />);

    fireEvent.click(await screen.findByRole("radio", { name: "Tool calls" }));
    fireEvent.click(await screen.findByRole("button", { name: /Bash.*git status/ }));
    const input = await screen.findByRole("button", { name: /Input: available/ });
    fireEvent.click(input);
    const firstBody = await screen.findByRole("region", { name: "Captured body" });
    await waitFor(() => expect(firstBody).toHaveTextContent("old bytes"));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    fireEvent.click(input);
    const reopened = await screen.findByRole("region", { name: "Captured body" });
    await waitFor(() => expect(bodyReads).toBe(2));
    expect(reopened).toHaveTextContent("Loading retained body");
    expect(reopened.querySelector("pre")).toBeNull();
    expect(within(reopened).getByRole("button", { name: "Copy displayed text" })).toBeDisabled();

    releaseSecondRead({ success: true, output: JSON.stringify({ ok: false, body_id: bodyId, status: "pruned", reason: "pruned", pruned_at: "2026-09-16T00:00:00.000Z" }) });
    await waitFor(() => expect(reopened).toHaveTextContent(/Input was pruned/));
    expect(reopened).not.toHaveTextContent("old bytes");
    expect(within(reopened).getByRole("button", { name: "Copy displayed text" })).toBeDisabled();
    expect(within(reopened).queryByRole("button", { name: "Retry body" })).toBeNull();
  });

  it("keeps an open retained body stable across window focus", async () => {
    let bodyReads = 0;
    const bodyId = inspectionFixture.captured_contract["claude-code"].tools.items[0].input_parts[0].body_id;
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd !== "hub_cmd") return undefined;
      const values = (args as { args?: string[] } | undefined)?.args ?? [];
      if (values[1] === "pin" && values[2] === "list") return { success: true, output: JSON.stringify(inspectionFixture.pins) };
      if (values.includes("--body")) {
        bodyReads += 1;
        return { success: true, output: JSON.stringify({ ok: true, body_id: bodyId, status: "available", content_type: "text/plain", total_bytes: 9, chunks: [{ seq: 0, bytes: 9, base64: btoa("stable") }], next_after_chunk: null }) };
      }
      if (values.includes("--view") && values.includes("overview")) return { success: true, output: JSON.stringify(inspectionFixture.captured_contract["claude-code"].overview) };
      if (values.includes("--view") && values.includes("tools")) return { success: true, output: JSON.stringify(inspectionFixture.captured_contract["claude-code"].tools) };
      return { success: true, output: JSON.stringify({ ok: true }) };
    });
    renderWithProviders(<UsageInspectionPanel harness="claude-code" sessionId={inspectionFixture.captured_contract["claude-code"].session_id} />);

    fireEvent.click(await screen.findByRole("radio", { name: "Tool calls" }));
    fireEvent.click(await screen.findByRole("button", { name: /Bash.*git status/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Input: available/ }));
    const body = await screen.findByRole("region", { name: "Captured body" });
    await waitFor(() => expect(body).toHaveTextContent("stable"));
    const readsBeforeFocus = bodyReads;

    focusManager.setFocused(false);
    focusManager.setFocused(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    focusManager.setFocused(undefined);

    expect(bodyReads).toBe(readsBeforeFocus);
    expect(body).toHaveTextContent("stable");
    expect(body.querySelector("pre")).not.toBeNull();
  });

  it("clears an open body when the inspected session changes", async () => {
    const rendered = renderWithProviders(<UsageSessionSheet session={sampleSession()} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("radio", { name: "Tool calls" }));
    fireEvent.click(await screen.findByRole("button", { name: /Bash.*git status/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Input: available/ }));
    await screen.findByRole("region", { name: "Captured body" });
    const other = sampleSession({ id: "other-session", inspection: { ...sampleSession().inspection!, session_id: "other-session", root_session_id: "other-session" } });
    rendered.rerender(<UsageSessionSheet session={other} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.queryByRole("region", { name: "Captured body" })).toBeNull());
  });

  it("surfaces a partial capture and its source notice", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd !== "hub_cmd") return undefined;
      const values = (args as { args?: string[] } | undefined)?.args ?? [];
      if (values[1] === "pin" && values[2] === "list") return { success: true, output: JSON.stringify(inspectionFixture.pins) };
      if (values[1] === "inspect") return { success: true, output: JSON.stringify({ ...inspectionFixture.overview, evidence: { status: "partial", notices: ["One transcript source ended before completion."] } }) };
      return { success: true, output: "{}" };
    });
    renderWithProviders(<UsageSessionSheet session={sampleSession()} onClose={vi.fn()} />);

    expect(await screen.findByRole("status", { name: "Capture evidence: partial" })).toHaveTextContent("One transcript source ended before completion.");
  });

  it("offers a retry for a structured inspection read failure", async () => {
    let reads = 0;
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd !== "hub_cmd") return undefined;
      const values = (args as { args?: string[] } | undefined)?.args ?? [];
      if (values[1] === "pin" && values[2] === "list") return { success: true, output: JSON.stringify({ ok: true, items: [], next_after: null }) };
      if (values[1] === "inspect") {
        reads += 1;
        return { success: true, output: JSON.stringify({ ok: false, reason: "inspection_corrupt" }) };
      }
      return { success: true, output: "{}" };
    });
    renderWithProviders(<UsageInspectionPanel harness="claude-code" sessionId={inspectionFixture.index.sessions[0].session_id} />);

    expect(await screen.findByText(/local store is corrupt/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(reads).toBeGreaterThanOrEqual(2));
  });

  it("keeps unavailable generated token scopes distinct from known zero", async () => {
    const codex = inspectionFixture.captured_contract.codex.overview as unknown as InspectionPayload;
    renderWithProviders(<UsageInspectionTimeline payload={codex} onToolCalls={vi.fn()} />);

    expect((await screen.findAllByTestId("usage-inspection-lane")).some((lane) => lane.textContent?.includes("unavailable tok"))).toBe(true);
    expect(screen.getByRole("region", { name: "Main session statistics" })).toHaveTextContent("Own unavailable");
  });

  it("exposes PR evidence and keeps ccusage totals separate", async () => {
    renderWithProviders(<UsageSessionSheet session={sampleSession()} onClose={vi.fn()} />);

    expect(await screen.findByRole("link", { name: "PR #42" })).toHaveAttribute(
      "href",
      "https://github.com/acme/demo/pull/42",
    );
    fireEvent.click((await screen.findByTestId("usage-inspection-pr-picker")).querySelector("summary")!);
    expect(screen.getByText(/#42 · github.com\/acme\/demo/)).toBeInTheDocument();
    expect(screen.getByText(/ccusage totals remain separate/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("link", { name: "PR #42" }));
    expect(openUrl).toHaveBeenCalledWith("https://github.com/acme/demo/pull/42");
  });

  it("uses the inspection pin control and sends the additive pin command", async () => {
    renderWithProviders(<UsageSessionSheet session={sampleSession()} onClose={vi.fn()} />);

    const sheet = screen.getByTestId("usage-session-sheet");
    const toolbar = sheet.querySelector(".usage-sheet-toolbar");
    expect(toolbar).not.toBeNull();
    const toolbarScope = within(toolbar as HTMLElement);
    const pin = toolbarScope.getByRole("button", { name: "Pin session" });
    fireEvent.click(pin);
    await waitFor(() => expect(vi.mocked(invoke)).toHaveBeenCalledWith("hub_cmd", expect.objectContaining({
      args: expect.arrayContaining(["usage", "pin", "add", inspectionFixture.index.sessions[0].session_id]),
    })));
    expect(await toolbarScope.findByRole("button", { name: "Unpin session" })).toBeInTheDocument();
    fireEvent.click(toolbarScope.getByRole("button", { name: "Unpin session" }));
    expect(await toolbarScope.findByRole("button", { name: "Pin session" })).toBeInTheDocument();
  });
});
