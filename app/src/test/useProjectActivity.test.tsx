import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import type { ReactNode } from "react";

import { useProjectActivity } from "@/hooks/useProjectActivity";
import { PROJECT_ACTIVITY_KEY } from "@/lib/projectActivity";
import type { UsageScan } from "@/features/usage/usageTypes";
import type { Registry } from "@/types";
import { makeQueryClient, primeRegistry, sampleRegistry } from "./helpers";

/** A raw `usage_load_latest_ccusage` payload — the shape the hook re-normalizes
 *  with `includeFullPaths: true`. `projectPath` is what a LIVE scan carries; the
 *  on-disk cache holds a redacted token there instead. */
function scanWith(
  sessions: Array<Record<string, unknown>>,
): UsageScan {
  return {
    scanned_at: 1_788_000_000,
    source: { command: "ccusage", args: [], resolved_from: "path" },
    parsed: { session: sessions, daily: [], totals: {} },
  };
}

const registryWithProjects: Registry = {
  ...sampleRegistry,
  projects: {
    alpha: { path: "/Users/dev/projects/alpha", bundles: [], enabled: [] },
    beta: { path: "/Users/dev/projects/beta", bundles: [], enabled: [] },
  },
};

function setup(scan: UsageScan | null, registry: Registry = registryWithProjects) {
  const client = makeQueryClient();
  primeRegistry(client, registry);
  vi.mocked(invoke).mockImplementation((async (cmd: string) => {
    if (cmd === "usage_load_latest_ccusage") return scan;
    return undefined;
  }) as never);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(() => useProjectActivity(), { wrapper });
}

let setItemSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  localStorage.clear();
  setItemSpy = vi.spyOn(Storage.prototype, "setItem");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useProjectActivity", () => {
  it("returns {} and writes nothing when there is no cached scan", async () => {
    const { result } = setup(null);
    await waitFor(() => expect(result.current).toEqual({}));
    // `normalizeCcusageScan` is never handed a null scan (it types its argument
    // non-null), and an empty derivation must not clobber the stored map.
    expect(setItemSpy).not.toHaveBeenCalledWith(
      PROJECT_ACTIVITY_KEY,
      expect.anything(),
    );
  });

  it("derives from a live-shaped scan, persists once, and does not rewrite on a re-render", async () => {
    const { result, rerender } = setup(
      scanWith([
        {
          agent: "claude",
          projectPath: "/Users/dev/projects/alpha",
          lastActivity: "2026-09-02T10:00:00Z",
        },
      ]),
    );

    await waitFor(() =>
      expect(result.current.alpha?.byHarness["claude-code"]).toBe(
        "2026-09-02T10:00:00Z",
      ),
    );
    const writes = () =>
      setItemSpy.mock.calls.filter((c) => c[0] === PROJECT_ACTIVITY_KEY).length;
    const afterFirst = writes();
    expect(afterFirst).toBe(1);

    // The effect is keyed on the DERIVED map, not on render: re-rendering with
    // the same query data must not write again (a write-per-render would hit
    // localStorage on every parent state change on the Harnesses screen).
    rerender();
    rerender();
    expect(writes()).toBe(afterFirst);
  });

  it("keeps a previously stored project that the current scan cannot see", async () => {
    localStorage.setItem(
      PROJECT_ACTIVITY_KEY,
      JSON.stringify({
        beta: {
          last: "2026-08-01T10:00:00Z",
          byHarness: { "claude-code": "2026-08-01T10:00:00Z" },
        },
      }),
    );
    const { result } = setup(
      scanWith([
        {
          agent: "claude",
          projectPath: "/Users/dev/projects/alpha",
          lastActivity: "2026-09-02T10:00:00Z",
        },
      ]),
    );

    await waitFor(() => expect(result.current.alpha).toBeTruthy());
    // Only a live scan yields real paths, so the persisted map is the memory of
    // the last one — a later cache-only session must not erase it.
    expect(result.current.beta?.last).toBe("2026-08-01T10:00:00Z");
  });

  it("derives nothing from a path-redacted cache scan", async () => {
    const { result } = setup(
      scanWith([
        {
          agent: "claude",
          projectPath: "~/redacted/9f2c1a77b0e34d15",
          lastActivity: "2026-09-02T10:00:00Z",
        },
      ]),
    );
    await waitFor(() => expect(result.current).toEqual({}));
    expect(
      setItemSpy.mock.calls.filter((c) => c[0] === PROJECT_ACTIVITY_KEY),
    ).toHaveLength(0);
  });

  it("derives nothing when no project is registered", async () => {
    const { result } = setup(
      scanWith([
        {
          agent: "claude",
          projectPath: "/Users/dev/projects/alpha",
          lastActivity: "2026-09-02T10:00:00Z",
        },
      ]),
      { ...sampleRegistry, projects: {} },
    );
    await waitFor(() => expect(result.current).toEqual({}));
  });

  it("C4: never invokes usage_scan_ccusage, with or without a cached scan", async () => {
    // Capture-on-open used to live INSIDE `useLocalAgentUsage()` (review
    // C4), so every consumer — this hook included — fired its own scan as a
    // side effect of merely reading the cache. `useProjectActivity`'s own
    // doc comment claims "adds no new IPC"; this pins that claim.
    const { result: withNoCache } = setup(null);
    await waitFor(() => expect(withNoCache.current).toEqual({}));
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("usage_scan_ccusage");

    vi.mocked(invoke).mockClear();
    const staleScan = scanWith([
      { agent: "claude", projectPath: "/Users/dev/projects/alpha", lastActivity: "2020-01-01T10:00:00Z" },
    ]);
    const { result: withStaleCache } = setup(staleScan);
    await waitFor(() => expect(withStaleCache.current.alpha).toBeTruthy());
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("usage_scan_ccusage");
  });

  it("survives a localStorage that throws on both read and write", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("SecurityError");
    });
    setItemSpy.mockImplementation(() => {
      throw new DOMException("QuotaExceededError");
    });
    const { result } = setup(
      scanWith([
        {
          agent: "claude",
          projectPath: "/Users/dev/projects/alpha",
          lastActivity: "2026-09-02T10:00:00Z",
        },
      ]),
    );
    await waitFor(() => expect(result.current.alpha).toBeTruthy());
  });
});
