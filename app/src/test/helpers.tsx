import type { ReactElement } from "react";
import { render, type RenderOptions } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { Registry } from "@/types";
import type { SyncReportEnvelope } from "@/lib/syncFreshness";

export interface Deferred<T = unknown> {
  promise: Promise<T>;
  resolve: (value?: T) => void;
  reject: (err?: unknown) => void;
}

/** A promise plus its resolve/reject, for driving pending UI states. */
export function makeDeferred<T = unknown>(): Deferred<T> {
  let resolve!: (value?: T) => void;
  let reject!: (err?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res as (value?: T) => void;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Make the globally-mocked `invoke` (installed in setup.ts) HANG for every
 * command matching `match` until the test resolves/rejects the returned
 * deferred — so pending/busy states are observable. Non-matching commands fall
 * through to whatever implementation setup.ts (or the test) had installed, so
 * this composes with the default mock. Returns `{ promise, resolve, reject }`.
 *
 *   const gate = deferredInvoke((cmd) => cmd === "hub_cmd");
 *   // …assert the control is busy…
 *   gate.resolve({ success: true, output: "" });   // or gate.reject(new Error())
 */
export function deferredInvoke(
  match: (cmd: string, args?: unknown) => boolean = () => true,
): Deferred {
  const gate = makeDeferred();
  const mock = vi.mocked(invoke);
  const prev = mock.getMockImplementation();
  mock.mockImplementation(((cmd: string, args?: unknown) => {
    if (match(cmd, args)) return gate.promise;
    return prev ? prev(cmd as never, args as never) : Promise.resolve(undefined);
  }) as never);
  return gate;
}

export function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  });
}

interface Wrapped {
  initialRoute?: string;
  client?: QueryClient;
}

export function renderWithProviders(
  ui: ReactElement,
  { initialRoute = "/", client = makeQueryClient(), ...options }: Wrapped & Omit<RenderOptions, "wrapper"> = {},
) {
  return {
    ...render(ui, {
      wrapper: ({ children }) => (
        <QueryClientProvider client={client}>
          <MemoryRouter initialEntries={[initialRoute]}>{children}</MemoryRouter>
        </QueryClientProvider>
      ),
      ...options,
    }),
    client,
  };
}

export const sampleRegistry: Registry = {
  version: "1",
  hub_path: "~/skill-hub",
  bootstrap: {
    completed_at: "2026-05-20T18:33:00Z",
    version: 1,
  },
  skills: {
    brainstorm: {
      version: "1.0.0",
      description: "Brainstorm a feature with multiple experts.",
      source: "~/skill-hub/skills/brainstorm",
      type: "claude-skill",
      scope: "global",
      upstream: null,
      managed: "local",
    },
    "rt-android-expert": {
      version: "0.3.0",
      description: "Android compose planner",
      source: "~/skill-hub/skills/rt-android-expert",
      type: "claude-skill",
      scope: "portable",
      upstream: null,
      managed: "local",
    },
    "fs-mcp": {
      version: "0.1.0",
      description: "Filesystem MCP server",
      source: "~/skill-hub/skills/fs-mcp",
      type: "mcp-server",
      scope: "global",
      upstream: null,
      managed: "local",
    },
    "android-compose-ui": {
      version: "1.0.0",
      description: "External: Compose UI patterns shared by an org pack.",
      source: "~/.skill-hub/sources/org-skills/worktree/skills/android-compose-ui",
      type: "claude-skill",
      scope: "portable",
      upstream: "git@github.com:org/skills.git",
      managed: "external",
      origin: {
        source: "org-skills",
        source_type: "git",
        path: "skills/android-compose-ui",
        ref: "abc123",
      },
    },
  },
  projects: {
    "example-app": {
      path: "/Users/dev/example-app",
      bundles: ["android"],
      enabled: ["brainstorm"],
    },
  },
  bundles: {
    android: {
      description: "Android workflows",
      icon: "🤖",
      scope: "project-specific",
      skills: ["rt-android-expert", "android-compose-ui"],
    },
  },
  sources: {
    "org-skills": {
      type: "git",
      name: "Org Skills",
      url: "git@github.com:org/skills.git",
      branch: "main",
      path: "skills",
      auth: "system-git",
      cache: "~/.skill-hub/sources/org-skills/worktree",
      current_ref: "abc123",
      remote_ref: "def456",
      status: "update-available",
      last_checked_at: "2026-05-21T16:40:00Z",
      last_synced_at: "2026-05-21T16:38:00Z",
      error: null,
    },
  },
};

/** Mirror of the JSON shape returned by `hub source list --json`. Tests can
 *  feed this through the mocked `hub_cmd` invoke. */
export const sampleSourceList = {
  sources: [
    {
      id: "local",
      type: "local" as const,
      name: "Local",
      builtin: true,
      status: "local" as const,
      skill_count: 3,
    },
    {
      id: "starter",
      type: "starter" as const,
      name: "Starter Pack",
      builtin: true,
      status: "bundled" as const,
      skill_count: 0,
    },
    {
      id: "org-skills",
      type: "git" as const,
      name: "Org Skills",
      builtin: false,
      status: "update-available" as const,
      skill_count: 1,
      url: "git@github.com:org/skills.git",
      branch: "main",
      path: "skills",
      current_ref: "abc123",
      remote_ref: "def456",
      last_checked_at: "2026-05-21T16:40:00Z",
      last_synced_at: "2026-05-21T16:38:00Z",
    },
  ],
  errors: [],
};

export function primeRegistry(client: QueryClient, registry: Registry = sampleRegistry) {
  client.setQueryData(["registry"], registry);
  client.setQueryData(["python"], {
    ok: true,
    reason: "none",
    detail: null,
    python: "/usr/bin/python3",
  });
}

/** A minimal-but-valid `sync_report` envelope for a project that has synced at
 *  least once. `sync_report` resolves to `null` until the first `hub sync`
 *  ever runs (see setup.ts's default mock + the freshness-signal design), so
 *  StatusBar/NavPanel freshness tests that want the "has synced" branch must
 *  prime this explicitly rather than relying on the (honest) unsynced default. */
export const sampleSyncReportEnvelope: SyncReportEnvelope = {
  report: {
    schema_version: 1,
    generated_at: "2026-05-21T16:40:00Z",
    registry_sha256: "abc123",
    registry_mtime: 0,
    ok: true,
    global: {
      skipped: [],
      skills: { writes: 0, removed: 0 },
      mcp: { writes: 0, removed: 0 },
      permissions: { ok: true, errors: [] },
      remotes: { attempted: 0, alarming: 0 },
    },
    projects: {},
  },
  registry_current: { sha256: "abc123", mtime: 0 },
};

/** Make the globally-mocked `invoke` answer `sync_report` with `envelope`
 *  (chaining to whatever implementation was already installed for every other
 *  command). `client.setQueryData(["syncReport"], …)` alone only covers the
 *  FIRST render — react-query's `staleTime: 0` triggers an immediate
 *  background refetch that would otherwise silently clobber it back to the
 *  default mock's `null` the moment any test `await`s (see truthSyncSignal
 *  test for the established pattern this mirrors). */
export function mockSyncReport(envelope: SyncReportEnvelope | null) {
  const mock = vi.mocked(invoke);
  const prev = mock.getMockImplementation();
  mock.mockImplementation(((cmd: string, args?: unknown) =>
    cmd === "sync_report"
      ? Promise.resolve(envelope)
      : (prev?.(cmd as never, args as never) ?? Promise.resolve(undefined))) as never);
}

/** Prime both the registry and a "has synced" sync report in one call — the
 *  common case for tests that don't care about freshness specifically but
 *  need the StatusBar/NavPanel "in sync" branch instead of the honest
 *  not-synced-yet default. */
export function primeRegistryAndSync(
  client: QueryClient,
  registry: Registry = sampleRegistry,
) {
  primeRegistry(client, registry);
  mockSyncReport(sampleSyncReportEnvelope);
  client.setQueryData(["syncReport"], sampleSyncReportEnvelope);
}
