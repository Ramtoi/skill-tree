import { mockHeadlessMachines } from "@/mocks/headlessMachines";
import { mockWorktreeDefaults } from "@/mocks/worktreeDefaults";
import { mockRemoteDelivery } from "@/mocks/remoteDelivery";
import { mockRemoteDefaults } from "@/mocks/remoteDefaults";
import { mockProjectRepository } from "@/mocks/projectRepository";
import "@testing-library/jest-dom";
import { configure } from "@testing-library/dom";
import { vi, beforeEach } from "vitest";
import { __resetCaptureOnOpenForTests } from "@/features/usage/useCaptureOnOpen";
// The checked-in wave-1 fixtures back the default `hub usage <verb> --json`
// replies below, so a component test that renders a screen touching the new
// usage-analytics hooks doesn't have to mock five commands to test one thing
// (design D14.4). Same pattern `src/lib/mcpContract.ts` already uses for
// `tests/fixtures/mcp_secret_corpus.json`.
import usageProjectFixture from "../../../tests/fixtures/usage/project.json";
import usageSessionFixture from "../../../tests/fixtures/usage/session.json";
import usageFootprintFixture from "../../../tests/fixtures/usage/footprint.json";
import usageFindingsFixture from "../../../tests/fixtures/usage/findings.json";
import usageScanSessionsFixture from "../../../tests/fixtures/usage/scan-sessions.json";
import usageTimelineFixture from "../../../tests/fixtures/usage/timeline.json";
import usageInspectionFixture from "../../../tests/fixtures/usage/inspection-session.json";

let testInspectionPins = [...(usageInspectionFixture.pins.items ?? [])];

// testing-library's default 1000ms `findBy*` / `waitFor` budget is a WALL-CLOCK
// wait for an async react-query resolution, so it gets tighter as the suite
// grows and the worker pool contends. That produced flakes in files nobody had
// touched (AgentDocsView, SourcesRemove) whenever the run got slower. Raising
// the ceiling cannot mask a real failure — a query that never resolves still
// times out — it only stops a healthy assertion from losing a race with the
// scheduler. The per-test 5s vitest timeout is still the hard stop.
configure({ asyncUtilTimeout: 4000 });

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
// Exported so `mockCommands` (helpers.tsx) can fall through to it for any
// command a test's table doesn't list.
export const defaultImpl = async (cmd: string, args?: unknown) => {
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
    case "read_search_corpus":
      // Every component consuming the cached corpus should see the protocol
      // shape even when a test does not care about body search.
      return { skills: {}, snippets: {} };
    case "sync_report":
      // No report by default → the freshness signal reads `unknown`. Tests that
      // exercise freshness override this via mockImplementation.
      return null;
    case "usage_load_latest_ccusage":
      return null;
    case "usage_pricing_info":
      return null;
    case "usage_scan_ccusage":
      return {
        scanned_at: 1_784_068_400,
        source: {
          command: "ccusage",
          args: ["--json"],
          resolved_from: "test",
        },
        raw: "",
        parsed: { daily: [], session: [], totals: {} },
      };
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
    // The share file sheets default to "cancelled" so a test that renders the
    // Library / skill editor without exercising import/export stays inert.
    // eslint-disable-next-line no-fallthrough
    case "save_file_dialog":
    case "pick_file":
      return null;
    case "path_exists":
      return false;
    case "create_empty_file":
      return undefined;
    case "hub_cmd": {
      const wtArgs = (args as { args?: string[] } | undefined)?.args ?? [];
      if (wtArgs[0] === "project" && wtArgs[1] === "worktree-defaults") {
        const payload = mockWorktreeDefaults(wtArgs);
        return { success: payload.ok, output: JSON.stringify(payload) };
      }
      if (wtArgs[0] === "remote" && wtArgs[1] === "machine") {
        const payload = mockHeadlessMachines(wtArgs);
        return { success: true, output: JSON.stringify(payload) };
      }
      if (wtArgs[0] === "remote" && wtArgs[1] === "delivery") {
        return { success: true, output: JSON.stringify(mockRemoteDelivery(wtArgs)) };
      }
      if (wtArgs[0] === "remote" && wtArgs[1] === "defaults") {
        const payload = mockRemoteDefaults(wtArgs);
        return { success: payload.ok, output: JSON.stringify(payload) };
      }
      if (wtArgs[0] === "project" && wtArgs[1] === "repository") {
        const payload = mockProjectRepository(wtArgs);
        return { success: payload.ok, output: JSON.stringify(payload) };
      }
      const cmdArgs = (args as { args?: string[] } | undefined)?.args ?? [];
      // Return a parseable JSON payload for `source list --json` so the
      // default fetchSources() call in component tests resolves cleanly.
      if (cmdArgs[0] === "source" && cmdArgs[1] === "list" && cmdArgs.includes("--json")) {
        return { success: true, output: defaultSourceListPayload };
      }
      // `hub harness doc status --json` (global-doc-sharing) — an empty scan
      // by default so `useGlobalDocStatus()` (now read unconditionally by the
      // Harnesses screen) resolves cleanly for every test that doesn't care.
      if (cmdArgs[0] === "harness" && cmdArgs[1] === "doc" && cmdArgs[2] === "status") {
        return { success: true, output: "[]" };
      }
      // The five usage-analytics ledger reads/mutations (design D14.4) — the
      // checked-in fixtures, never hung, never failed, so a test that renders
      // a screen touching `hooks/useUsageAnalytics.ts` without exercising a
      // specific state resolves cleanly by default.
      if (cmdArgs[0] === "usage" && cmdArgs[1] === "project") {
        return { success: true, output: JSON.stringify(usageProjectFixture) };
      }
      if (cmdArgs[0] === "usage" && cmdArgs[1] === "session") {
        return { success: true, output: JSON.stringify(usageSessionFixture) };
      }
      if (cmdArgs[0] === "usage" && cmdArgs[1] === "footprint") {
        return { success: true, output: JSON.stringify(usageFootprintFixture) };
      }
      if (cmdArgs[0] === "usage" && cmdArgs[1] === "findings") {
        return { success: true, output: JSON.stringify(usageFindingsFixture) };
      }
      if (cmdArgs[0] === "usage" && cmdArgs[1] === "scan-sessions") {
        return { success: true, output: JSON.stringify(usageScanSessionsFixture) };
      }
      if (cmdArgs[0] === "usage" && cmdArgs[1] === "timeline") {
        return { success: true, output: JSON.stringify({ ...usageTimelineFixture, days: [] }) };
      }
      if (cmdArgs[0] === "usage" && cmdArgs[1] === "inspect-index") {
        return { success: true, output: JSON.stringify(usageInspectionFixture.index) };
      }
      if (cmdArgs[0] === "usage" && cmdArgs[1] === "inspect") {
        if (cmdArgs.includes("--view") && cmdArgs.includes("body")) {
          const bodyId = cmdArgs[cmdArgs.indexOf("--body") + 1];
          return { success: true, output: JSON.stringify(bodyId === usageInspectionFixture.body.body_id ? usageInspectionFixture.body : { ok: false, body_id: bodyId, status: "unavailable", reason: "body_not_retained" }) };
        }
        const view = cmdArgs[cmdArgs.indexOf("--view") + 1];
        return { success: true, output: JSON.stringify(view === "tools" ? { ...usageInspectionFixture.overview, tool_calls: usageInspectionFixture.overview.tool_calls } : usageInspectionFixture.overview) };
      }
      if (cmdArgs[0] === "usage" && cmdArgs[1] === "pin" && cmdArgs[2] === "list") {
        return { success: true, output: JSON.stringify({ ...usageInspectionFixture.pins, items: testInspectionPins }) };
      }
      if (cmdArgs[0] === "usage" && cmdArgs[1] === "pin") {
        const sessionId = cmdArgs[3] ?? usageInspectionFixture.index.sessions[0].session_id;
        const harness = cmdArgs[cmdArgs.indexOf("--harness") + 1] ?? "claude-code";
        const runId = cmdArgs.includes("--run") ? cmdArgs[cmdArgs.indexOf("--run") + 1] : null;
        const existing = testInspectionPins.find((pin) => pin.harness === harness && pin.session_id === sessionId && pin.run_id === runId);
        if (cmdArgs[2] === "add" && !existing) testInspectionPins.push({ ...usageInspectionFixture.pins.items![0], harness, session_id: sessionId, root_session_id: sessionId, run_id: runId! });
        if (cmdArgs[2] === "remove") testInspectionPins = testInspectionPins.filter((pin) => !(pin.harness === harness && pin.session_id === sessionId && pin.run_id === runId));
        return { success: true, output: JSON.stringify({ ok: true, schema_version: 1, action: cmdArgs[2], pin: { harness, session_id: sessionId, root_session_id: sessionId, run_id: runId } }) };
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
          global_doc: "/home/test/.claude/CLAUDE.md",
          global_doc_exists: true,
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
          global_doc: "/home/test/.codex/AGENTS.md",
          global_doc_exists: false,
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
          global_doc: "/home/test/.pi/agent/AGENTS.md",
          global_doc_exists: false,
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
          global_doc: "/home/test/.config/opencode/AGENTS.md",
          global_doc_exists: true,
        },
      ];
    case "global_doc_read":
      return {
        path: "/home/test/.claude/CLAUDE.md",
        exists: true,
        content: "# Global instructions\n\nBe concise.\n",
        sha256: "sha-loaded",
      };
    case "global_doc_write":
      return { sha256: "sha-written" };
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
        instruction_rels: [],
        external_imports: [],
        ignored_count: 0,
        include_ignored: false,
        root: { name: "", path: "", dirs: [], files: [] },
      };
    case "resolve_agent_doc_dir_meta":
      return [];
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
      return {
        written: [],
        mirrored: false,
        content: String((args as { content?: unknown } | undefined)?.content ?? ""),
      };
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
    case "agent_docs_publish_get":
    case "agent_docs_publish_set":
      return { project: "test", enabled: false, remote: "origin", branch: "main" };
    case "agent_docs_publish_now":
      return {
        project: "test",
        enabled: false,
        attempted: false,
        published: false,
        committed: false,
        sha: null,
        remote: "origin",
        branch: "main",
        reason: "disabled",
        message: "Publish on save is off for this project.",
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
    case "hook_list":
      return { hooks: [], reach: {} };
    case "hook_show":
      return {
        name: (args as { name?: string })?.name ?? "",
        provenance: "user",
        event: "PostToolUse",
        command: "",
        description: "",
        tools: [],
        matcher: "",
        timeout: null,
        harnesses: null,
        settings: {},
        attached_global: false,
        attached_projects: [],
        project_settings: {},
        reach: {},
      };
    case "hook_capabilities":
      return null;
    case "hook_doctor":
      return { findings: [], danger_count: 0 };
    case "permissions_risks_schema":
      return [];
    case "hook_script_show":
      // Default hook fixture is a COMMAND hook, so `script show` has nothing to
      // return; the editor only enables this query for managed-script hooks.
      return null;
    case "hook_new":
    case "hook_edit":
    case "hook_delete":
    case "hook_attach":
    case "hook_detach":
    case "hook_set_settings":
    case "hook_script_save":
      return { success: true, output: "ok" };
    case "local_skill_candidates":
      return [];
    // ─── Skill files (the editor's FILES navigator) ─────────────────────────
    // Every skill has at least SKILL.md; a suite that cares about siblings
    // overrides these wholesale the way the skill-editor suites already do.
    case "skill_files_list":
      return {
        root: `/tmp/skill-hub/skills/${(args as { name?: string })?.name ?? "skill"}`,
        files: [
          { rel: "SKILL.md", size: 128, kind: "markdown", editable: true, reason: null },
        ],
        truncated: false,
      };
    case "skill_file_read":
      return {
        rel: (args as { rel?: string })?.rel ?? "SKILL.md",
        content: "",
        hash: "h0",
        size: 0,
      };
    case "skill_file_write":
    case "skill_file_create":
      return { hash: "h1" };
    case "remote_equip":
      return { ok: true, bundles: [], enabled: [] };
    case "source_add_apply":
      return { ok: true, registered: [], skipped: [], resolved: [], counts: {} };
    // ipcParity.test.ts's "every command the frontend calls has a default
    // arm in setup.ts" (F ⊆ S) check — these commands have no scenario that
    // needs a real reply shape yet, so they fall through to the SAME value
    // the unlisted-command default branch already returns. A component test
    // that starts to care about one of these moves it to its own case above.
    case "agent_docs_fix_apply":
    case "agent_docs_fix_plan":
    case "agent_docs_resolve":
    case "backup_auth_login_pat":
    case "backup_auth_logout":
    case "backup_auth_status":
    case "backup_disable":
    case "backup_enable":
    case "backup_init":
    case "backup_now":
    case "backup_status":
    case "harness_open_dir":
    case "harness_set_global":
    case "mcp_add_json":
    case "mcp_reconcile_apply":
    case "mcp_set_json":
    case "permissions_adopt":
    case "permissions_capabilities":
    case "permissions_disable":
    case "permissions_doctor":
    case "permissions_recent_imports":
    case "permissions_reconcile_apply":
    case "permissions_reconcile_candidates":
    case "permissions_set":
    case "permissions_show":
    case "permissions_validate":
    case "project_set_harnesses":
    case "read_registry":
    case "read_skill_document":
    case "recovery_command":
    case "remote_connectors":
    case "remote_list_docs":
    case "restore_apply":
    case "restore_preview":
    case "save_skill_full":
    case "snippet_apply":
    case "snippet_delete":
    case "snippet_edit":
    case "snippet_new":
    case "snippet_remove":
    case "snippet_show":
    case "snippet_update":
      return undefined;
    default:
      return undefined;
  }
};

beforeEach(async () => {
  // Persisted UI state (`st:*`) is per-origin and jsdom keeps one origin for
  // the whole file, so a test that flips a persisted toggle would otherwise
  // decide the starting state of every test after it.
  try {
    localStorage.clear();
  } catch {
    /* storage unavailable — nothing to clear */
  }
  // `useCaptureOnOpen`'s "already attempted this cache state" set (review W3)
  // is deliberately module-level (a real app session), which means vitest —
  // it does not reset ES module state between `it()`s in one file, only
  // between files — would otherwise leak a "no cache" attempt from one
  // capture-on-open test into the next.
  __resetCaptureOnOpenForTests();
  const { useAppStore } = await import("@/store");
  useAppStore.setState({ settingsOpen: false, settingsCategory: "appearance", tweaksPersistenceError: null, harnessesError: null, harnessScans: 0, toasts: [] });
  // `Processes` is a module-level zustand store outside `useAppStore`, so it
  // survives across tests in the same file unless cleared explicitly here
  // (the `UsageScanAction.test.tsx` idiom, generalized for every file).
  const { Processes } = await import("@/store/processes");
  for (const p of Processes.list()) Processes.dismiss(p.id);
  const { useUsagePreferences } = await import("@/store/usagePreferences");
  const { readUsagePreferences } = await import("@/lib/usagePreferences");
  useUsagePreferences.setState({ ...readUsagePreferences(), persistenceError: null });
  testInspectionPins = [...(usageInspectionFixture.pins.items ?? [])];
  const { invoke } = await import("@tauri-apps/api/core");
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(defaultImpl as never);
});
