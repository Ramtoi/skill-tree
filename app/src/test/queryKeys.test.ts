import { describe, it, expect } from "vitest";
import { qk } from "@/lib/queryKeys";
import { REGISTRY_WRITE_KEYS } from "@/lib/invalidate";

// Pins every factory's exact literal so a later rename cannot silently re-key
// a cache entry (several tests elsewhere assert a key by deep equality:
// `test/commandLayerPalette.test.tsx`, `test/SubagentsCodex.test.tsx`,
// `test/undoLayer.test.tsx`).
describe("qk (query-key registry)", () => {
  it("top-level keys", () => {
    expect(qk.registry()).toEqual(["registry"]);
    expect(qk.skillRefsGraph()).toEqual(["skill-refs-graph"]);
    expect(qk.syncReport()).toEqual(["syncReport"]);
    expect(qk.python()).toEqual(["python"]);
    expect(qk.bootstrap()).toEqual(["bootstrap"]);
    expect(qk.sources()).toEqual(["sources"]);
    expect(qk.localCandidates()).toEqual(["localCandidates"]);
    expect(qk.searchCorpus()).toEqual(["search-corpus"]);
    expect(qk.connectorCatalog()).toEqual(["connector-catalog"]);
    expect(qk.harnessAlsoServes()).toEqual(["harness-also-serves"]);
    expect(qk.remoteDefaults()).toEqual(["remote-defaults"]);
    expect(qk.globalDoc("x")).toEqual(["global-doc", "x"]);
    expect(qk.envExists("/a/b")).toEqual(["env-exists", "/a/b"]);
    expect(qk.projectCandidates("example-app")).toEqual([
      "project-candidates",
      "example-app",
    ]);
    expect(qk.projectRepository("example-app")).toEqual([
      "project-repository",
      "example-app",
    ]);
    expect(qk.projectRemovePreview("example-app", 3)).toEqual([
      "project-remove-preview",
      "example-app",
      3,
    ]);
    expect(qk.usageTimeline("2026-09-01", "2026-09-07", "claude-code")).toEqual([
      "usage", "timeline", "2026-09-01", "2026-09-07", "claude-code",
    ]);
    expect(qk.usageTimeline("2026-09-01", "2026-09-07", "codex")).toEqual([
      "usage", "timeline", "2026-09-01", "2026-09-07", "codex",
    ]);
    expect(qk.usageTimeline("2026-09-01", "2026-09-07", "pi")).not.toEqual(
      qk.usageTimeline("2026-09-01", "2026-09-07", "claude-code"),
    );
  });

  it("backup", () => {
    expect(qk.backup.status()).toEqual(["backupStatus"]);
    expect(qk.backup.auth()).toEqual(["backupAuth"]);
  });

  it("hooks", () => {
    expect(qk.hooks.all()).toEqual(["hooks"]);
    expect(qk.hooks.list()).toEqual(["hooks", "list"]);
    expect(qk.hooks.show("x")).toEqual(["hooks", "show", "x"]);
    expect(qk.hooks.capabilities()).toEqual(["hooks", "capabilities"]);
    expect(qk.hooks.script("x")).toEqual(["hooks", "script", "x"]);
    expect(qk.hooks.doctor()).toEqual(["hooks", "doctor"]);
  });

  it("permissions", () => {
    expect(qk.permissions.capabilities()).toEqual(["permissions", "capabilities"]);
    expect(qk.permissions.doctor()).toEqual(["permissions", "doctor"]);
    expect(qk.permissions.risksSchema()).toEqual(["permissions", "risks-schema"]);
  });

  it("remotes", () => {
    expect(qk.remotes.list()).toEqual(["remotes"]);
    expect(qk.remotes.doctor()).toEqual(["remote-doctor"]);
    expect(qk.remotes.all("hermes")).toEqual(["remote", "hermes"]);
    expect(qk.remotes.show("hermes")).toEqual(["remote", "hermes", "show"]);
    expect(qk.remotes.diff("hermes")).toEqual(["remote", "hermes", "diff"]);
    expect(qk.remotes.docs("hermes")).toEqual(["remote", "hermes", "docs"]);
    expect(qk.remotes.health("hermes")).toEqual(["remote", "hermes", "health"]);
    expect(qk.remotes.scan("hermes")).toEqual(["remote", "hermes", "scan"]);
  });

  it("cloud", () => {
    expect(qk.cloud.targets()).toEqual(["cloud-targets"]);
    expect(qk.cloud.statusAll()).toEqual(["cloud-status"]);
    expect(qk.cloud.status("claude-ai")).toEqual(["cloud-status", "claude-ai"]);
  });

  it("snippets", () => {
    expect(qk.snippets.listAll()).toEqual(["snippets"]);
    expect(qk.snippets.list("tag", "q")).toEqual(["snippets", "tag", "q"]);
    expect(qk.snippets.oneAll()).toEqual(["snippet"]);
    expect(qk.snippets.one("x")).toEqual(["snippet", "x"]);
    expect(qk.snippets.scanAll()).toEqual(["snippet-scan"]);
    expect(qk.snippets.scan("x", "example-app")).toEqual([
      "snippet-scan",
      "x",
      "example-app",
    ]);
  });

  it("agentDocs", () => {
    expect(qk.agentDocs.all()).toEqual(["agent-docs"]);
    expect(qk.agentDocs.forProject("/repo")).toEqual(["agent-docs", "/repo"]);
    expect(qk.agentDocs.listing("/repo", true, false)).toEqual([
      "agent-docs",
      "/repo",
      true,
      false,
    ]);
    expect(qk.agentDocs.dirMetaAll()).toEqual(["agent-docs-dir-meta"]);
    expect(qk.agentDocs.dirMeta("/repo", "sub")).toEqual([
      "agent-docs-dir-meta",
      "/repo",
      "sub",
    ]);
    expect(qk.agentDocs.rootStatusAll()).toEqual(["agent-docs-root-status"]);
    expect(qk.agentDocs.rootStatus("/repo")).toEqual(["agent-docs-root-status", "/repo"]);
    expect(qk.agentDocs.strategyAll()).toEqual(["agent-docs-strategy"]);
    expect(qk.agentDocs.strategy("example-app")).toEqual([
      "agent-docs-strategy",
      "example-app",
    ]);
  });

  it("subagents", () => {
    expect(qk.subagents.list("user")).toEqual(["subagents", "claude-code", "user", null]);
    expect(qk.subagents.list("project", "example-app")).toEqual([
      "subagents",
      "claude-code",
      "project",
      "example-app",
    ]);
    expect(qk.subagents.list("project", "example-app", "codex")).toEqual([
      "subagents",
      "codex",
      "project",
      "example-app",
    ]);
    expect(qk.subagents.one("user", null, "reviewer")).toEqual([
      "subagent",
      "claude-code",
      "user",
      null,
      "reviewer",
    ]);
    expect(qk.subagents.attachable("user")).toEqual([
      "subagent-attachable",
      "claude-code",
      "user",
      null,
    ]);
    expect(qk.subagents.skillUsage()).toEqual(["subagent-skill-usage"]);
    expect(qk.subagents.linkStatus("user")).toEqual(["subagent-link-status", "user"]);
  });
});

describe("REGISTRY_WRITE_KEYS", () => {
  it("is exactly registry + syncReport + hooks doctor + dropped skills + search corpus + mcp candidates", () => {
    expect(REGISTRY_WRITE_KEYS).toEqual([
      ["registry"],
      ["skill-refs-graph"],
      ["syncReport"],
      ["hooks", "doctor"],
      ["source", "dropped"],
      ["search-corpus"],
      ["mcpCandidates", "global"],
    ]);
  });
});
