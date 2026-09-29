import type { ReactElement } from "react";
import { render, type RenderOptions } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { NavigationGuard } from "@/lib/navGuard";
import type { Registry } from "@/types";
import type { SyncReportEnvelope } from "@/lib/syncFreshness";
import { defaultImpl as defaultInvokeImpl } from "./setup";

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

// ─── mockCommands ───────────────────────────────────────────────────────────
//
// A shared replacement for the 12 near-identical local `mockInvoke(...)`
// helpers that used to live one per test file (equipGuardrail, HarnessDocRefs,
// SkillLibrarySearch, TipsTour, …). Each of those hand-rolled a per-command
// `vi.mocked(invoke).mockImplementation(...)`, and most of them reinvented the
// same three shapes: "resolve with this value", "never resolve" (a pending
// state) and "reject" (an error state) — see `headerPresence.test.tsx`'s own
// small `mockCommands`/`hang` pair, which this generalizes and makes shared.

/** Sentinel: a table entry (or a per-call function's return value) of `hang`
 *  makes that `invoke(cmd, …)` call return a promise that never settles —
 *  the only reliable way to keep a screen in its pending/loading branch for
 *  the lifetime of a test. */
export const hang: unique symbol = Symbol("mockCommands.hang");

/** A table entry produced by `fail()`/`hubFail()` — never constructed by
 *  hand. `kind` picks which shape of failure `mockCommands` synthesizes:
 *  see the doc comments on `fail` and `hubFail` below for when to use each. */
export interface CommandFail {
  readonly kind: "reject" | "hub";
  readonly message: string;
}

/** Most Tauri commands fail by REJECTING the `invoke(...)` promise — a plain
 *  JS error the caller's `catch`/react-query `error` sees directly. Use this
 *  for every command except `hub_cmd` (see `hubFail`). */
export function fail(message: string): CommandFail {
  return { kind: "reject", message };
}

/** `hub_cmd` is different: a non-zero `hub.py` exit is a RESOLVED
 *  `{ success: false, output }` (see `HubResult`/`HubCommandError` in
 *  `src/lib/hubCmd.ts`) — the bridge never rejects on it. `runHubCmd` is what
 *  turns that into a thrown `HubCommandError` on the caller's side. Use this
 *  for a `hub_cmd` table entry (or a `hub_cmd` function's return value) that
 *  should exercise a screen's "the hub command failed" branch. */
export function hubFail(message: string): CommandFail {
  return { kind: "hub", message };
}

function isCommandFail(value: unknown): value is CommandFail {
  return (
    !!value &&
    typeof value === "object" &&
    ((value as CommandFail).kind === "reject" || (value as CommandFail).kind === "hub") &&
    typeof (value as CommandFail).message === "string"
  );
}

/** One row per `invoke(cmd, args)` call the mocked bridge saw while a
 *  `mockCommands` table was installed (every call, not just matched ones —
 *  mirrors `deferredInvoke`'s "compose with the default" spirit by still
 *  recording the pass-through calls). */
export interface RecordedCall {
  cmd: string;
  args: unknown;
}

export interface CommandRecorder {
  calls: RecordedCall[];
  /** The `args` of every recorded call to `cmd`, in call order — e.g.
   *  `of("hub_cmd").map(a => (a as { args: string[] }).args)` for argv. */
  of(cmd: string): unknown[];
}

export type CommandEntry =
  | unknown
  | typeof hang
  | CommandFail
  | ((args: unknown) => unknown);

export type CommandTable = Record<string, CommandEntry>;

function resolveEntry(entry: CommandEntry, args: unknown): unknown {
  return typeof entry === "function" ? (entry as (args: unknown) => unknown)(args) : entry;
}

/**
 * Install `vi.mocked(invoke).mockImplementation(...)` from a per-command
 * table: `{ cmd: value }` resolves `invoke(cmd, …)` with `value`; `{ cmd: (args)
 * => value }` computes it from the call's `args`; `{ cmd: hang }` (or a
 * function returning `hang`) leaves that call pending forever; `{ cmd:
 * fail("message") }` rejects; `{ cmd: hubFail("message") }` resolves with the
 * `{ success: false, output: "message" }` shape `hub_cmd` failures actually
 * take. A command NOT in the table falls through to `setup.ts`'s own default
 * mock — the same one every test starts with — so a screen's unrelated reads
 * (e.g. a background `read_registry` a `hub_cmd`-driven screen doesn't care
 * about) keep behaving normally.
 *
 * Each call — matched by the table or not — is recorded; the returned
 * recorder lets a test assert argv without reaching into `vi.mocked(invoke)`
 * directly (`recorder.of("hub_cmd")`).
 */
export function mockCommands(table: CommandTable): CommandRecorder {
  const calls: RecordedCall[] = [];
  vi.mocked(invoke).mockImplementation(((cmd: string, args?: unknown) => {
    calls.push({ cmd, args });
    if (!(cmd in table)) return defaultInvokeImpl(cmd as never, args as never);
    const resolved = resolveEntry(table[cmd], args);
    if (resolved === hang) return new Promise(() => {});
    if (isCommandFail(resolved)) {
      return resolved.kind === "hub"
        ? Promise.resolve({ success: false, output: resolved.message })
        : Promise.reject(new Error(resolved.message));
    }
    return Promise.resolve(resolved);
  }) as never);
  return {
    calls,
    of(cmd: string) {
      return calls.filter((c) => c.cmd === cmd).map((c) => c.args);
    },
  };
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
  /** A path, or a full MemoryRouter entry when the test needs navigation
   *  `state` — e.g. the palette's "Back up now" request, which rides in state
   *  precisely so that a URL alone can never fire a push. */
  initialRoute?: string | { pathname: string; search?: string; state?: unknown };
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
          {/* Mirrors App.tsx: the navigator is wrapped so a screen's unsaved
              guard can refuse a programmatic navigation. Inert until one is
              armed. */}
          <MemoryRouter initialEntries={[initialRoute]}>
            <NavigationGuard>{children}</NavigationGuard>
          </MemoryRouter>
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
  permissions_global: {
    allow: [{ pattern: "Bash(npm:*)", kind: "allow" }],
    deny: [{ pattern: "Bash(rm -rf:*)", kind: "deny" }],
    ask: [],
    hooks: [],
    sandbox_mode: "workspace-write",
    approval_policy: "on-failure",
    additional_dirs: [],
    _unmanaged: [],
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
