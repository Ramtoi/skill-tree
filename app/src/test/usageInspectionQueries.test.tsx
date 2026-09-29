import { describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { fetchUsageInspectionPins, TOOL_PAGE_LIMIT, useUsageInspection, useUsageInspectionBody } from "@/features/usage/useUsageInspection";
import { dispatchUsageInspection } from "@/mocks/usageInspection";
import inspectionFixture from "../../../tests/fixtures/usage/inspection-session.json";
import { makeQueryClient } from "./helpers";

describe("usage inspection query pagination", () => {
  it("preserves a pruned tombstone when a later body page changes state", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd !== "hub_cmd") return undefined;
      const values = (args as { args?: string[] } | undefined)?.args ?? [];
      if (!values.includes("--after-chunk")) {
        return { success: true, output: JSON.stringify({ ok: true, body_id: "body:stale", status: "available", content_type: "text/plain", total_bytes: 11, chunks: [{ seq: 0, bytes: 6, base64: btoa("prefix") }], next_after_chunk: 1 }) };
      }
      return { success: true, output: JSON.stringify({ ok: false, body_id: "body:stale", status: "pruned", reason: "pruned", pruned_at: "2026-06-04T00:00:00.000Z" }) };
    });

    const client = makeQueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const view = renderHook(() => useUsageInspectionBody("claude-code", "stale-session", "body:stale"), { wrapper });

    await waitFor(() => expect(view.result.current.data?.reason).toBe("pruned"));
    expect(view.result.current.data).toMatchObject({ ok: false, body_id: "body:stale", status: "pruned", pruned_at: "2026-06-04T00:00:00.000Z" });
    expect(view.result.current.data?.chunks).toHaveLength(1);
    expect(view.result.current.data?.retrieval_status).toBeUndefined();
  });

  it("keeps an ordinary later-page failure retryable while retaining the prefix", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd !== "hub_cmd") return undefined;
      const values = (args as { args?: string[] } | undefined)?.args ?? [];
      if (!values.includes("--after-chunk")) {
        return { success: true, output: JSON.stringify({ ok: true, body_id: "body:partial", status: "available", content_type: "text/plain", total_bytes: 11, chunks: [{ seq: 0, bytes: 6, base64: btoa("prefix") }], next_after_chunk: 1 }) };
      }
      return { success: true, output: JSON.stringify({ ok: false, body_id: "body:partial", status: "unavailable", reason: "read_failed" }) };
    });

    const client = makeQueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const view = renderHook(() => useUsageInspectionBody("claude-code", "partial-session", "body:partial"), { wrapper });

    await waitFor(() => expect(view.result.current.data?.retrieval_status).toBe("failed"));
    expect(view.result.current.data).toMatchObject({ ok: true, reason: "body_page_unavailable", retrieval_status: "failed", chunks: [{ seq: 0, bytes: 6 }] });
  });

  it("loads every pinned page and keeps the cursor scoped to the next request", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd !== "hub_cmd") return undefined;
      const values = (args as { args?: string[] } | undefined)?.args ?? [];
      const after = values.includes("--after") ? values[values.indexOf("--after") + 1] : undefined;
      const item = (sessionId: string) => ({ harness: "claude-code", session_id: sessionId, root_session_id: sessionId, run_id: null, status: "available" as const });
      if (!after) return { success: true, output: JSON.stringify({ ok: true, items: [item("first")], next_after: "cursor-1", evidence: { status: "complete", notices: [] } }) };
      expect(after).toBe("cursor-1");
      return { success: true, output: JSON.stringify({ ok: true, items: [item("last")], next_after: null, evidence: { status: "complete", notices: [] } }) };
    });

    await expect(fetchUsageInspectionPins()).resolves.toMatchObject({ items: [{ session_id: "first" }, { session_id: "last" }], next_after: null });
  });

  it("marks a later pin page failure as partial instead of an empty list", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd !== "hub_cmd") return undefined;
      const values = (args as { args?: string[] } | undefined)?.args ?? [];
      if (!values.includes("--after")) return { success: true, output: JSON.stringify({ ok: true, items: [{ harness: "claude-code", session_id: "first", root_session_id: "first", run_id: null, status: "available" }], next_after: "cursor-1", evidence: { status: "complete", notices: [] } }) };
      return { success: true, output: JSON.stringify({ ok: false, reason: "read_failed" }) };
    });

    await expect(fetchUsageInspectionPins()).resolves.toMatchObject({ items: [{ session_id: "first" }], evidence: { status: "partial" } });
  });

  it("pins and lists a generated captured session without transplanting another pin's scope", () => {
    const sessionId = inspectionFixture.captured_contract["claude-code"].session_id;
    const add = dispatchUsageInspection({ args: ["usage", "pin", "add", sessionId, "--harness", "claude-code", "--json"] });
    expect(add).toMatchObject({ ok: true, pin: { session_id: sessionId, run_id: null } });

    const list = dispatchUsageInspection({ args: ["usage", "pin", "list", "--harness", "claude-code", "--json"] }) as { items: Array<{ session_id: string; run_id: string | null; scopes?: { own: { tokens: { total: number } } } }> };
    const pin = list.items.find((item) => item.session_id === sessionId && item.run_id === null);
    expect(pin?.scopes?.own.tokens.total).toBe(inspectionFixture.captured_contract["claude-code"].overview.session.summary.own.tokens.total);

    const bodyId = inspectionFixture.captured_contract["claude-code"].body.body_id;
    const patchBodyId = inspectionFixture.captured_contract["claude-code"].changes.changes[0].patch.body_id;
    expect(dispatchUsageInspection({ args: ["usage", "inspect", sessionId, "--harness", "claude-code", "--view", "body", "--body", patchBodyId, "--json"] })).toMatchObject({ ok: true, body_id: patchBodyId });
    const invocationBodyId = inspectionFixture.captured_contract["claude-code"].tools.items[0].input_parts[0].body_id;
    expect(dispatchUsageInspection({ args: ["usage", "inspect", sessionId, "--harness", "claude-code", "--view", "body", "--body", invocationBodyId, "--json"] })).toMatchObject({ ok: true, body_id: invocationBodyId });
    expect(dispatchUsageInspection({ args: ["usage", "inspect", "wrong-session", "--harness", "claude-code", "--view", "body", "--body", bodyId, "--json"] })).toMatchObject({ ok: false, reason: "not_captured" });
    expect(dispatchUsageInspection({ args: ["usage", "pin", "remove", sessionId, "--harness", "claude-code", "--json"] })).toMatchObject({ ok: true, action: "remove" });
  });
});

describe("usage inspection tool pages stream in", () => {
  const overview = inspectionFixture.captured_contract["claude-code"].overview;
  const sessionId = inspectionFixture.captured_contract["claude-code"].session_id;
  const item = (id: string) => ({ id, run_id: overview.runs[0].id, ordinal: 0, at: "2026-09-07T12:00:00.000Z", tool: { name: "Bash", kind: "local" }, operation: { summary: id, signature: `op:${id}`, status: "available" }, execution: "completed", input_parts: [], result_parts: [], source_epoch: "e", evidence: [] });
  function wrapper({ children }: { children: ReactNode }) { return <QueryClientProvider client={makeQueryClient()}>{children}</QueryClientProvider>; }

  it("renders the first page before the second page resolves, then appends it", async () => {
    let releaseSecond: (() => void) | null = null;
    const second = new Promise<void>((resolve) => { releaseSecond = resolve; });
    const seen: string[][] = [];
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd !== "hub_cmd") return undefined;
      const values = (args as { args?: string[] } | undefined)?.args ?? [];
      seen.push(values);
      if (values.includes("overview")) return { success: true, output: JSON.stringify(overview) };
      const after = values.includes("--after") ? values[values.indexOf("--after") + 1] : undefined;
      if (!after) return { success: true, output: JSON.stringify({ ok: true, items: [item("first")], next_after: "cursor-1", total: 2 }) };
      await second;
      return { success: true, output: JSON.stringify({ ok: true, items: [item("second")], next_after: null, total: 2 }) };
    });
    const view = renderHook(() => useUsageInspection("claude-code", sessionId, "tools"), { wrapper });
    await waitFor(() => expect(view.result.current.data?.tool_calls?.items.map((call) => call.id)).toEqual(["first"]));
    expect(view.result.current.isLoadingMore).toBe(true);
    expect(view.result.current.data?.tool_calls?.total).toBe(2);
    const toolPages = seen.filter((values) => values.includes("tools"));
    expect(toolPages[0]).toContain("--limit");
    expect(toolPages[0][toolPages[0].indexOf("--limit") + 1]).toBe(String(TOOL_PAGE_LIMIT));
    releaseSecond!();
    await waitFor(() => expect(view.result.current.data?.tool_calls?.items.map((call) => call.id)).toEqual(["first", "second"]));
    expect(view.result.current.isLoadingMore).toBe(false);
    expect(view.result.current.data?.tool_calls?.next_after).toBeNull();
    // The overview was read once and shared by the tool pages.
    expect(seen.filter((values) => values.includes("overview"))).toHaveLength(1);
  });

  it("marks the payload partial when a later page fails, keeping the pages already read", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd !== "hub_cmd") return undefined;
      const values = (args as { args?: string[] } | undefined)?.args ?? [];
      if (values.includes("overview")) return { success: true, output: JSON.stringify(overview) };
      const after = values.includes("--after") ? values[values.indexOf("--after") + 1] : undefined;
      if (!after) return { success: true, output: JSON.stringify({ ok: true, items: [item("first")], next_after: "cursor-1", total: 3 }) };
      return { success: true, output: JSON.stringify({ ok: false, reason: "read_failed" }) };
    });
    const view = renderHook(() => useUsageInspection("claude-code", sessionId, "tools"), { wrapper });
    await waitFor(() => expect(view.result.current.data?.tool_calls?.status).toBe("partial"));
    expect(view.result.current.isError).toBe(false);
    expect(view.result.current.data?.tool_calls?.items.map((call) => call.id)).toEqual(["first"]);
    expect(view.result.current.data?.evidence?.status).toBe("partial");
    expect(view.result.current.isLoadingMore).toBe(false);
  });
});
