import "@testing-library/jest-dom";
import { vi, beforeEach } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

window.HTMLElement.prototype.scrollIntoView = function () {};

// __APP_VERSION__ is injected by Vite's `define` in real builds; vitest doesn't
// apply it, so provide a stand-in for components that read it (e.g. StatusBar).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).__APP_VERSION__ = "0.0.0-test";

// Mock Tauri invoke globally
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

// Sample source-list payload used as the default `hub_cmd ["source","list","--json"]`
// reply so component tests that consume `useSources()` don't need to mock it
// manually. Tests can override via vi.mocked(invoke).mockImplementation(...).
const defaultSourceListPayload = JSON.stringify({
  sources: [
    { id: "local", type: "local", name: "Local", builtin: true, status: "local", skill_count: 0 },
    { id: "starter", type: "starter", name: "Starter Pack", builtin: true, status: "bundled", skill_count: 0 },
  ],
  errors: [],
});

// Sensible default implementations so tests that don't care about the new
// bootstrap / project_* commands don't need to mock them every time.
// Tests that DO care override via vi.mocked(invoke).mockImplementation(...).
const defaultImpl = async (cmd: string, args?: unknown) => {
  switch (cmd) {
    case "check_python":
      return true;
    case "runtime_preflight":
      return {
        ok: true,
        reason: "none",
        detail: null,
        python: "/usr/bin/python3",
      };
    case "bootstrap_check":
      return {
        needs_bootstrap: false,
        completed_at: "2026-05-20T18:33:00Z",
        version: 1,
        legacy_detected: [],
        data_home: "/home/test/.skill-hub",
        code_home: "/home/test/code/skill-hub",
        candidates: [],
        conflicts: [],
        blocked: [],
        already_managed: [],
        silent_skip: [],
      };
    case "bootstrap_run":
      return undefined;
    case "project_add_with_path":
    case "project_edit_path":
    case "project_remove_clean":
      return undefined;
    case "project_remove_preview":
      return {
        project: "test-project",
        project_path: "/path/to/test-project",
        removed_symlinks: [],
        removed_mcp_entries: [],
        removed_empty_dirs: [],
        warnings: [],
      };
    case "pick_directory":
      return null;
    case "path_exists":
      return false;
    case "create_empty_file":
      return undefined;
    case "hub_cmd": {
      const cmdArgs = (args as { args?: string[] } | undefined)?.args ?? [];
      // Return a parseable JSON payload for `source list --json` so the
      // default fetchSources() call in component tests resolves cleanly.
      if (cmdArgs[0] === "source" && cmdArgs[1] === "list" && cmdArgs.includes("--json")) {
        return { success: true, output: defaultSourceListPayload };
      }
      return { success: true, output: "" };
    }
    case "harness_list":
      return [];
    case "list_agent_docs":
      return {
        project_path: "/",
        all_rels: [],
        truncated: false,
        warning: null,
        root: { name: "", path: "", dirs: [], files: [] },
      };
    case "read_agent_doc":
      return {
        rel: "CLAUDE.md",
        absolute_path: "/CLAUDE.md",
        content: "",
        size: 0,
        modified_at: null,
        hash: "",
        is_symlink: false,
        symlink_to: null,
        oversized: false,
        is_derived_pointer: false,
      };
    case "write_agent_doc":
      return { written: [], mirrored: false };
    case "agent_docs_root_status":
      return {
        project: "test",
        state: "ok",
        canonical: "CLAUDE.md",
        derived: null,
        strategy: "symlink",
        reason: "",
      };
    case "agent_docs_strategy_get":
      return {
        global: "symlink",
        project: null,
        override_value: null,
        effective: null,
      };
    case "agent_docs_strategy_set":
      return {
        global: "symlink",
        project: null,
        override_value: null,
        effective: null,
      };
    case "agent_docs_migrate":
      return {
        project: "test",
        action: "noop",
        state: "ok",
        strategy: "symlink",
        canonical: "CLAUDE.md",
        derived: null,
        details: "",
        applied: false,
        backups: [],
      };
    case "snippets_list":
      return [];
    case "snippet_status":
      return { locations: [], damaged: [] };
    default:
      return undefined;
  }
};

beforeEach(async () => {
  const { invoke } = await import("@tauri-apps/api/core");
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(defaultImpl as never);
});
