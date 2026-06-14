import type { ReactElement } from "react";
import { render, type RenderOptions } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Registry } from "@/types";

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
