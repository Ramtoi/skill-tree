import { describe, expect, it, beforeEach, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { Routes, Route } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { LocalAgentUsage } from "@/screens/LocalAgentUsage";
import { UsageProjectRoute } from "@/screens/usage/UsageProjectRoute";
import { UsageSessionRoute } from "@/screens/usage/UsageSessionRoute";
import { ProjectWorkspace } from "@/screens/ProjectWorkspace";
import { makeQueryClient, renderWithProviders, sampleRegistry } from "./helpers";

function view(path: string) {
  const client = makeQueryClient();
  client.setQueryData(["registry"], sampleRegistry);
  return renderWithProviders(
    <Routes>
      <Route path="/usage" element={<LocalAgentUsage />} />
      <Route path="/usage/project/:name" element={<UsageProjectRoute />} />
      <Route path="/usage/session/:id" element={<UsageSessionRoute />} />
      <Route path="/project/:name" element={<ProjectWorkspace />} />
    </Routes>,
    { initialRoute: path, client },
  );
}

describe("usage routes do not scan on visit", () => {
  beforeEach(() => vi.mocked(invoke).mockClear());

  it.each([
    "/usage",
    "/usage/project/moon-base",
    "/usage/session/cccccccc-4444-4444-8444-444444444444?harness=claude-code",
  ])("does not invoke scan-sessions for %s", async (path) => {
    view(path);
    await waitFor(() => expect(vi.mocked(invoke)).toHaveBeenCalled());
    const scanCalls = vi.mocked(invoke).mock.calls.filter(([, args]) => {
      const values = args as { args?: unknown[] } | undefined;
      return values?.args?.[1] === "scan-sessions";
    });
    expect(scanCalls).toHaveLength(0);
  });

  it("does perform the positive project read", async () => {
    view("/usage/project/moon-base");
    await waitFor(() => {
      expect(
        vi.mocked(invoke).mock.calls.filter(([, args]) => {
          const values = args as { args?: unknown[] } | undefined;
          return values?.args?.[0] === "usage" && values?.args?.[1] === "project";
        }),
      ).toHaveLength(1);
    });
  });

  it("does not invoke ccusage scan for a normal fresh /usage cache", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "usage_load_latest_ccusage") {
        return {
          scanned_at: Math.floor(Date.now() / 1000) - 300,
          source: { command: "ccusage", args: ["--json"], resolved_from: "test" },
          raw: "",
          parsed: { daily: [], session: [], totals: {} },
        };
      }
      return undefined;
    });
    view("/usage");
    await waitFor(() => expect(vi.mocked(invoke)).toHaveBeenCalledWith("usage_load_latest_ccusage"));
    expect(vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === "usage_scan_ccusage")).toHaveLength(0);
  });

  it("reads the timeline once on /usage and makes no mutating call", async () => {
    view("/usage");
    await waitFor(() => {
      const calls = vi.mocked(invoke).mock.calls.map(([, args]) => (args as { args?: unknown[] } | undefined)?.args ?? []);
      expect(calls.filter((args) => args[0] === "usage" && args[1] === "timeline")).toHaveLength(1);
    });
    const calls = vi.mocked(invoke).mock.calls.map(([, args]) => (args as { args?: unknown[] } | undefined)?.args ?? []);
    const mutatingVerbs = new Set(["scan-sessions", "scan", "sync", "enable", "disable", "bundle", "rename", "remove"]);
    expect(calls.some((args) => mutatingVerbs.has(String(args[1] ?? args[0])))).toBe(false);
  });

  it.each(["/project/example-app", "/project/example-app?tab=usage"])(
    "does not scan and reads project usage data once on %s",
    async (path) => {
      view(path);
      await waitFor(() => expect(vi.mocked(invoke)).toHaveBeenCalled());
      const calls = vi.mocked(invoke).mock.calls.map(([, args]) => (args as { args?: unknown[] } | undefined)?.args ?? []);
      expect(calls.filter((args) => args[1] === "scan-sessions")).toHaveLength(0);
      expect(calls.filter((args) => args[0] === "usage" && args[1] === "project")).toHaveLength(1);
      expect(calls.filter((args) => args[0] === "usage" && args[1] === "footprint")).toHaveLength(1);
      const mutatingVerbs = new Set(["enable", "disable", "bundle", "sync", "project", "skill", "mcp", "permissions", "hooks", "rename", "remove"]);
      expect(calls.some((args) => mutatingVerbs.has(String(args[0])))).toBe(false);
    },
  );
});
