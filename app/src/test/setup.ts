import "@testing-library/jest-dom";
import { vi, beforeEach } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

window.HTMLElement.prototype.scrollIntoView = function () {};

// jsdom has no layout engine, so window.matchMedia is undefined. AppShell uses
// it for narrow-window detection (NavPanel drawer). Default to non-matching so
// component tests render the normal docked layout.
if (!window.matchMedia) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as any;
}

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
    case "project_scan_candidates":
      return [];
    case "sync_report":
      // No report by default → the freshness signal reads `unknown`. Tests that
      // exercise freshness override this via mockImplementation.
      return null;
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
      // Carries the `agents` capability (Wave 3 gating): claude-code + codex
      // support sub-agent definitions; pi/opencode do not.
      return [
        {
          id: "claude-code",
          label: "Claude Code",
          installed: true,
          on_globally: true,
          used_by_projects: [],
          path: "/usr/bin/claude",
          version: "1.0",
          agents: {
            supported: true,
            format: "md",
            agents_dir: "~/.claude/agents",
            project_agents_dir: ".claude/agents",
          },
        },
        {
          id: "codex",
          label: "Codex",
          installed: true,
          on_globally: false,
          used_by_projects: [],
          path: "/usr/bin/codex",
          version: "0.142.2",
          agents: {
            supported: true,
            format: "toml",
            agents_dir: "~/.codex/agents",
            project_agents_dir: ".codex/agents",
          },
        },
        {
          id: "pi",
          label: "Pi",
          installed: false,
          on_globally: false,
          used_by_projects: [],
          path: null,
          version: null,
          agents: {
            supported: false,
            format: null,
            agents_dir: null,
            project_agents_dir: null,
          },
        },
        {
          id: "opencode",
          label: "opencode",
          installed: true,
          on_globally: false,
          used_by_projects: [],
          path: "/usr/bin/opencode",
          version: "0.3.0",
          agents: {
            supported: false,
            format: null,
            agents_dir: null,
            project_agents_dir: null,
          },
        },
      ];
    case "subagent_list":
      return {
        scope: "user",
        project: null,
        agents_dir: "/home/test/.claude/agents",
        settings_path: "/home/test/.claude/settings.json",
        agents: [],
        builtins: [],
      };
    case "subagent_show":
      return {
        name: "",
        scope: "user",
        file: "",
        exists: false,
        safe: {
          name: "",
          description: "",
          model: "",
          tools_mode: "all",
          tools: [],
          disallowed_tools: [],
          allow_skill_discovery: true,
          skills: [],
          color: "",
        },
        advanced_yaml: "",
        body: "",
        disabled: false,
        validation: { valid: true, warnings: [] },
      };
    case "subagent_attachable_skills":
      return [];
    case "subagent_skill_usage":
      return {};
    case "subagent_provision_skill":
      // Inert benign success so tests that don't exercise D5 provisioning don't
      // need to mock it (real scenarios override via mockImplementation).
      return {
        ok: true,
        skill: (args as { skill?: string })?.skill ?? "",
        mode: "make-global",
        path: "/provisioned/SKILL.md",
        widened_affinity: false,
      };
    case "subagent_save":
      return { ok: true, name: "", file: "", warnings: [], renamed_from: null };
    case "subagent_delete":
      return { ok: true };
    case "subagent_set_disabled":
      return { ok: true, disabled: false };
    // Linked twins (D3) — inert defaults so tests that don't care don't mock them.
    case "subagent_link":
      return {
        ok: true,
        name: (args as { name?: string })?.name ?? "",
        harnesses: [],
        drift: [],
      };
    case "subagent_unlink":
      return {
        ok: true,
        name: (args as { name?: string })?.name ?? "",
        unlinked: true,
      };
    case "subagent_link_status":
      return { links: [], suggestions: [] };
    case "subagent_resolve_drift":
      return {
        ok: true,
        name: (args as { name?: string })?.name ?? "",
        drift: [],
      };
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
    case "remote_list":
      return [];
    case "remote_show":
      return {
        id: "",
        connector: "hermes",
        ssh_host: null,
        host_key_pinned: false,
        secret_ref: null,
        home: null,
        sync_enabled: true,
        bundles: [],
        enabled: [],
        resolved_skills: [],
      };
    case "remote_diff":
      return { remote: "", actions: [] };
    case "remote_health":
      return {
        remote: "",
        reachable: true,
        authenticated: true,
        host_key_match: true,
        ready: true,
        ok: true,
        detail_kind: "ready",
        detail: "",
      };
    case "remote_pin":
      return { remote: "", pinned: true, changed: true, old_pins: [], new_pin: "SHA256:new" };
    case "remote_probe":
      return {
        ssh_host: "",
        reachable: true,
        authenticated: true,
        ok: true,
        detail: "ready",
        detail_kind: "ready",
      };
    case "remote_scan_imports":
      return { remote: "", candidates: [] };
    case "remote_add":
    case "remote_sync":
    case "remote_resolve":
    case "remote_disable":
    case "remote_enable":
    case "remote_set_apply_global":
    case "remote_remove":
    case "remote_clear":
    case "remote_import_skill":
    case "remote_setup_key":
    case "remote_push_doc":
      return { success: true, output: "ok" };
    case "remote_fetch_doc":
      return { doc: "MEMORY.md", ok: true, content: "remote doc body", sha256: "abc" };
    case "remote_doctor":
      return { findings: [], danger_count: 0 };
    case "remote_fetch_host_key":
      return { fingerprint: "SHA256:test", detail: "host key fetched" };
    case "remote_set_secret":
    case "remote_delete_secret":
      return undefined;
    case "remote_has_secret":
      return false;
    case "local_skill_candidates":
      return [];
    case "remote_equip":
      return { ok: true, bundles: [], enabled: [] };
    case "source_add_apply":
      return { ok: true, registered: [], skipped: [], resolved: [], counts: {} };
    default:
      return undefined;
  }
};

beforeEach(async () => {
  const { invoke } = await import("@tauri-apps/api/core");
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(defaultImpl as never);
});
