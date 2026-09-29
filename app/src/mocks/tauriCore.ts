import { mockHeadlessMachines } from "./headlessMachines";
import { mockWorktreeDefaults } from "./worktreeDefaults";
import { mockRemoteDelivery } from "./remoteDelivery";
import { mockRemoteDefaults } from "./remoteDefaults";
import { mockProjectRepository } from "./projectRepository";
import { mockRecovery, ensureRecoveryFixture } from "./recovery";
// ─── Mock stub for @tauri-apps/api/core (invoke) ─────────────────────────────
// Visual-harness only — aliased in vite.config.ts when VISUAL_MOCK=1. Returns
// rich, NON-EMPTY data for every command each screen calls so no screen renders
// blank. Shapes mirror src/types*.ts and the hooks/screens that consume them.
//
// This is a STANDALONE module (does not import the test helpers, which pull in
// vitest). The base registry below is an EXPANDED version of test/helpers.ts's
// sampleRegistry.

import { invocationMock } from "./invocation";
import { sceneFlag, sceneValue } from "./scenes";
import type { BundleScope, Registry, Skill } from "@/types";
import { dispatchSubagent, SLUG_RE } from "./tauriSubagents";
import { dispatchUsageInspection } from "./usageInspection";
import {
  usageFindingsMock,
  usageLoadoutsMock,
  usageFootprintMock,
  usageProjectMock,
  usageScanMock,
  usageSessionMock,
  usageTimelineMock,
  INSPECTION_SESSION,
  CODEX_INSPECTION_SESSION,
} from "./tauriUsageAnalytics";
import { parseGitSourceUrl } from "@/lib/skillSource";
import { effectiveHarnesses } from "@/lib/affinity";
import {
  isHookRef,
  type CompanionItem,
  type CompanionLedgerEntry,
  type CompanionState,
  type CompanionsSetBlock,
  type CompanionsSetResult,
  type CompanionsSummary,
  type ReconcileProjectRecord,
  type ReconcileResult,
  type RuleKey,
  type ShipsWith,
} from "@/lib/companions";
import type { RenamePlan, RenameResult } from "@/types/renameRefs";

/** One mock scan timestamp per run: five minutes before load, so the default
 *  dashboards read fresh (no capture-on-open) and every scan the mock returns
 *  agrees with every other (usageMockFidelity). */
const MOCK_SCANNED_AT = Math.floor(Date.now() / 1000) - 300;

declare global {
  interface Window {
    __invokeCalls: Array<{ cmd: string; args: unknown }>;
  }
}

if (typeof window !== "undefined") window.__invokeCalls = [];

// ─── Expanded registry ───────────────────────────────────────────────────────
// Exported (m-5): `test/navInsights.test.ts`'s fixture-length guard measures
// the panel's copy against this SAME steady-content registry rather than a
// hand-built minimal one — the fixture the guard is supposed to pin per spec
// §8.1.

export const registry: Registry = {
  version: "1",
  hub_path: "~/.skill-hub",
  bootstrap: { completed_at: "2026-06-20T18:33:00Z", version: 1 },
  harnesses_global: ["claude-code"],
  skills: {
    brainstorm: {
      version: "1.2.0",
      description:
        "Spin up a team of expert agents to brainstorm a feature from multiple perspectives.",
      source: "~/.skill-hub/skills/brainstorm",
      type: "claude-skill",
      scope: "global",
      upstream: null,
      managed: "local",
    },
    "rt-android-expert": {
      version: "0.3.0",
      description: "Android Jetpack Compose planner and architecture advisor.",
      source: "~/.skill-hub/skills/rt-android-expert",
      type: "claude-skill",
      scope: "portable",
      upstream: null,
      managed: "local",
    },
    "android-jetpack-compose-material3-theming-helper": {
      version: "2.0.1",
      description:
        "A deliberately very long skill name to stress-test row truncation, ellipsis behaviour, and sidebar wrapping across the whole app at narrow viewport widths.",
      source:
        "~/.skill-hub/skills/android-jetpack-compose-material3-theming-helper",
      type: "claude-skill",
      scope: "portable",
      upstream: null,
      managed: "local",
    },
    "fs-mcp": {
      version: "0.1.0",
      description: "Filesystem MCP server exposing read/write tools over stdio.",
      source: "~/.skill-hub/skills/fs-mcp",
      type: "mcp-server",
      scope: "global",
      upstream: null,
      managed: "local",
      mcp: { command: "python3", args: ["server.py"], env: {} },
    },
    // The http fixture (N5) — every scene/journey that edits a URL points
    // here. `fs-mcp` stays stdio.
    context7: {
      version: "1.0.0",
      description: "Hosted documentation-lookup MCP server (context7.com).",
      source: "~/.skill-hub/mcp-servers/context7",
      type: "mcp-server",
      // Portable, equipped on example-app (below) — not auto-applied
      // everywhere, so its DELIVERY rows are project-scoped (richer variety
      // for the capture scenes: written + a blocked example).
      scope: "portable",
      upstream: null,
      managed: "local",
      mcp: {
        transport: "http",
        url: "https://mcp.context7.com/mcp",
        headers: { Authorization: "Bearer ${CONTEXT7_TOKEN}" },
      },
    },
    "android-compose-ui": {
      version: "1.0.0",
      description: "External: Compose UI patterns shared by an org pack.",
      source:
        "~/.skill-hub/sources/org-skills/worktree/skills/android-compose-ui",
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
    "openspec-apply": {
      version: "0.5.0",
      description: "Implement tasks from an OpenSpec change end to end.",
      source: "~/.skill-hub/skills/openspec-apply",
      type: "claude-skill",
      scope: "portable",
      upstream: null,
      managed: "local",
      // Model-usable; hidden from the user's / menu.
      invocation: "model-only",
    },
    "code-review": {
      version: "1.1.0",
      description: "Review the current diff for correctness bugs and cleanups.",
      source: "~/.skill-hub/skills/code-review",
      type: "claude-skill",
      scope: "global",
      upstream: null,
      managed: "local",
      // Hand-authored contradiction (both frontmatter flags) → warn badge.
      invocation: "conflicted",
    },
    "deep-research": {
      version: "0.9.0",
      description:
        "Deep research harness — fan-out web searches, fetch sources, verify claims, synthesize a cited report.",
      source: "~/.skill-hub/skills/deep-research",
      type: "claude-skill",
      scope: "global",
      upstream: null,
      managed: "local",
      // User-invocable only; Claude never sees the description.
      invocation: "user-only",
    },
    "git-committer-mcp": {
      version: "0.2.0",
      description: "MCP server that clusters and commits changes semantically.",
      source: "~/.skill-hub/skills/git-committer-mcp",
      type: "mcp-server",
      scope: "portable",
      upstream: null,
      managed: "local",
      harnesses: ["claude-code", "codex"],
      mcp: { command: "git-committer-mcp", args: [] },
    },
    // External-source MCP server (design-system): the only base-registry skill
    // owned by that source, so its Sources card has an MCP KindMark to
    // photograph — not an amber Tag.
    "ds-tokens-mcp": {
      version: "0.4.0",
      description: "MCP server exposing the design-system token set as tools.",
      source:
        "~/.skill-hub/sources/design-system/worktree/skills/ds-tokens-mcp",
      type: "mcp-server",
      scope: "portable",
      upstream: "git@github.com:acme/design-system.git",
      managed: "external",
      origin: {
        source: "design-system",
        source_type: "git",
        path: "skills/ds-tokens-mcp",
        ref: "5f1c0aa",
      },
      mcp: { command: "python3", args: ["server.py"] },
    },
    // ── D5 attach-skill provisioning fixtures (registry-known, not yet global) ──
    "needs-global": {
      version: "0.1.0",
      description:
        "Registry skill that does not yet resolve globally — attaching it to a user agent drives the make-global consequence prompt.",
      source: "~/.skill-hub/skills/needs-global",
      type: "claude-skill",
      scope: "portable",
      upstream: null,
      managed: "local",
    },
    "remote-note": {
      version: "0.1.0",
      description:
        "Imported from a remote box — provisioning is hard-refused (quarantine dead stop; see provState).",
      source: "~/.skill-hub/skills/remote-note",
      type: "claude-skill",
      scope: "project-specific",
      upstream: null,
      managed: "local",
    },
    "codex-only": {
      version: "0.1.0",
      description:
        "Harness-narrowed to codex — provisioning for a Claude agent offers to widen the affinity first.",
      source: "~/.skill-hub/skills/codex-only",
      type: "claude-skill",
      scope: "portable",
      upstream: null,
      managed: "local",
      harnesses: ["codex"],
    },
    // `ships_with` (D1/plans/ships-with) fixture — the D6 copy's frontmatter
    // block VERBATIM (C9), pinned by `test/companionsFixtureParity.test.ts`
    // against `tests/fixtures/ships_with/orchestrate-advanced/SKILL.md`. Six
    // agents (W10 added `orch-sub-orchestrator`), three `while-running` hooks,
    // two loop-safe permission rows (A8). No `harnesses:` key on any hook, on
    // purpose (plan 3): the fixture must produce real per-harness verdicts.
    "orchestrate-advanced": {
      version: "0.1.0",
      description:
        "Deep orchestrator: split a large goal into independent chunks, delegate each to a sub-orchestrator running orchestrate in its own branch. Trigger: /orchestrate-advanced, 'split and ship'.",
      source: "~/.skill-hub/skills/orchestrate-advanced",
      type: "claude-skill",
      scope: "portable",
      upstream: null,
      managed: "local",
      ships_with: {
        agents: [
          "orch-sub-orchestrator",
          "orch-researcher",
          "orch-planner",
          "orch-griller",
          "orch-implementer",
          "orch-reviewer",
        ],
        hooks: [
          {
            name: "orch-scope-guard",
            event: "PreToolUse",
            tools: ["Edit", "Write", "MultiEdit", "Bash"],
            command: "scripts/scope-guard.sh",
            activation: "while-running",
          },
          {
            name: "orch-report-guard",
            event: "SubagentStop",
            tools: [],
            command: "scripts/report-guard.sh",
            activation: "while-running",
          },
          {
            name: "orch-unit-brief",
            event: "SubagentStart",
            tools: [],
            command: "scripts/unit-brief.sh",
            activation: "while-running",
          },
        ],
        permissions: {
          deny: ["Bash(git push --force:*)"],
          ask: ["Bash(gh pr merge:*)"],
        },
      },
    },
  },
  projects: {
    "example-app": {
      path: "/Users/dev/projects/example-app",
      bundles: ["android"],
      enabled: ["brainstorm", "context7"],
      harnesses: ["codex"],
      agent_docs: { publish_on_save: true },
    },
    "moon-base": {
      path: "/Users/dev/projects/moon-base-android-client",
      bundles: ["android", "openspec"],
      // codex-only is directly equipped but moon-base is claude-only (no codex
      // in its effective harnesses) → drives the M8 "won't sync here" card badge.
      enabled: ["code-review", "deep-research", "codex-only"],
      agent_docs: { publish_on_save: true },
      // Per-project triggering override on a portable, bundle-provided skill.
      invocation_overrides: { "rt-android-expert": "user-only" },
    },
    "skill-hub": {
      path: "/Users/dev/Dev/.skill-hub",
      bundles: ["openspec"],
      enabled: ["code-review"],
      // TWIN RULE: mirrors `permissionsProject["skill-hub"]` below field for
      // field (minus per-rule `harnesses`/`origin` — this is the pass-through
      // YAML view, not the resolved shape). `project_trust: true` drives the
      // guardrails plaque's amber `trust` row mark.
      permissions: {
        allow: [{ pattern: "Bash(cargo:*)", kind: "allow" }],
        deny: [],
        ask: [],
        project_trust: true,
      },
    },
  },
  bundles: {
    android: {
      description: "Android + Jetpack Compose workflows",
      icon: "🤖",
      scope: "project-specific",
      // git-committer-mcp is here so the bundle editor's numbered grid has an
      // MCP card to photograph (the KindMark, not an amber Tag).
      skills: [
        "rt-android-expert",
        "android-compose-ui",
        "android-jetpack-compose-material3-theming-helper",
        "git-committer-mcp",
      ],
    },
    openspec: {
      description: "Spec-driven change tracking workflows",
      icon: "📋",
      scope: "project-specific",
      skills: ["openspec-apply", "code-review"],
    },
    // Source-LINKED bundle: follows `org-skills`, so its membership is
    // reconciled by `hub source sync org-skills` and the editor locks it.
    "org-pack": {
      description: "Everything Org Skills ships",
      icon: "🔗",
      scope: "project-specific",
      skills: ["android-compose-ui"],
      source: "org-skills",
    },
    // Global bundle: auto-applies to every project. Exercises the via-global
    // provenance path (GLOBAL cluster in Active bundles; skills must NOT read
    // as ◆ DIRECT) that ux-truth-sync-signal fixed.
    essentials: {
      description: "Baseline skills for every project",
      icon: "🧰",
      scope: "global",
      skills: ["brainstorm"],
    },
  },
  // Remote connector targets. The registry carries them verbatim (references
  // only), which is how the navigator can name a remote and count what is
  // equipped on it without probing SSH. Kept in step with `remoteList` below,
  // which is what `hub remote list --json` answers on the Remotes screen.
  remotes: {
    "hermes-main": {
      connector: "hermes",
      sync_enabled: true,
      bundles: ["openspec"],
      enabled: ["brainstorm", "deep-research"],
    },
    "worker-pool": {
      connector: "hermes",
      sync_enabled: false,
      bundles: [],
      enabled: ["code-review"],
    },
  },
  // Cloud apps: claude.ai carries a small, realistic equip set so the drift
  // cluster has something to say; chatgpt-web stays empty so the "nothing
  // equipped yet" resting state is captured too. Neutral for every other scene
  // (nothing outside the cloud surface reads `cloud:`).
  cloud: {
    // fs-mcp is deliberately present: an mcp-server can be in the block
    // (hand-edited registry) but is refused by every cloud target, so the
    // "Not exportable" surface has something real to show.
    "claude-ai": { bundles: ["openspec"], enabled: ["brainstorm", "fs-mcp"] },
    "chatgpt-web": { bundles: [], enabled: [] },
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
      last_checked_at: "2026-06-21T16:40:00Z",
      last_synced_at: "2026-06-21T16:38:00Z",
      error: null,
    },
    // Three more sources so the Sources toolbar has real material: search,
    // the Git/Built-in counts, and each status facet (updates / errors /
    // disabled) all have at least one card to act on.
    "design-system": {
      type: "git",
      name: "Design System",
      url: "git@github.com:acme/design-system.git",
      branch: "main",
      path: "skills",
      // Curated membership: this source was added by picking a subset in the
      // wizard, so later syncs never re-import the rest of the upstream folder.
      include: ["ds-tokens", "ds-icons"],
      auth: "system-git",
      cache: "~/.skill-hub/sources/design-system/worktree",
      current_ref: "5f1c0aa",
      remote_ref: "5f1c0aa",
      status: "up-to-date",
      last_checked_at: "2026-06-21T15:02:00Z",
      last_synced_at: "2026-06-21T15:02:00Z",
      error: null,
    },
    "partner-skills": {
      type: "git",
      name: "Partner Skills",
      url: "git@github.com:partner/agent-skills.git",
      branch: "main",
      path: "",
      auth: "system-git",
      cache: "~/.skill-hub/sources/partner-skills/worktree",
      current_ref: "9910bd2",
      remote_ref: null,
      status: "error",
      last_checked_at: "2026-06-20T09:14:00Z",
      last_synced_at: "2026-06-14T11:20:00Z",
      error: "git fetch failed: Permission denied (publickey).",
    },
    // Disabled: registered and intact, simply out of the sync loop.
    "legacy-pack": {
      type: "git",
      name: "Legacy Pack",
      enabled: false,
      url: "git@github.com:me/legacy-skills.git",
      branch: "master",
      path: "skills",
      auth: "system-git",
      cache: "~/.skill-hub/sources/legacy-pack/worktree",
      current_ref: "77aa31c",
      remote_ref: "77aa31c",
      status: "up-to-date",
      last_checked_at: "2026-05-30T08:00:00Z",
      last_synced_at: "2026-05-30T08:00:00Z",
      error: null,
    },
  },
  // Global permission rule counts — the guardrails group's Permissions block
  // reads only these three list lengths (never a `permissions_show` round-trip).
  // MUST agree with `permissionsGlobal` below: the panel and the Permissions
  // screen render side by side in the same frame.
  permissions_global: {
    allow: [
      { pattern: "Bash(npm:*)", kind: "allow" },
      { pattern: "Bash(git status:*)", kind: "allow" },
      {
        pattern:
          "Bash(./gradlew assembleDebug installDebug --stacktrace --warning-mode all:*)",
        kind: "allow",
      },
      { pattern: "Read(//Users/dev/**)", kind: "allow" },
    ],
    deny: [
      { pattern: "Bash(rm -rf:*)", kind: "deny" },
      { pattern: "Bash(curl:*)", kind: "deny" },
      { pattern: "Read(//Users/dev/.ssh/**)", kind: "deny" },
    ],
    ask: [
      { pattern: "Bash(git push:*)", kind: "ask" },
      {
        pattern: "Bash(gh pr create --title --body --draft:*)",
        kind: "ask",
      },
    ],
    // TWIN RULE: these five fields must equal `permissionsGlobal` below
    // (minus its per-rule `origin` tags — `registry.permissions_global` is the
    // pass-through YAML view, not the resolved-rule shape).
    hooks: [
      {
        event: "PreToolUse",
        matcher: "Bash",
        command: "~/.skill-hub/hooks/audit-bash.sh",
        harnesses: null,
      },
      {
        event: "PostToolUse",
        matcher: "Edit",
        command: "prettier --write $FILE",
        harnesses: ["claude-code"],
      },
    ],
    sandbox_mode: "workspace-write",
    approval_policy: "on-failure",
    additional_dirs: ["/Users/dev/shared", "/Users/dev/.config/skill-hub"],
    _unmanaged: [] as string[],
  },
};

type MockSkillAgent = {
  ok: true;
  skill: string;
  name: string;
  description: string;
  body: string;
  tier: string;
  hash: string;
  editable: boolean;
  harnesses: {
    "claude-code": { model: string };
    codex: { model: string; model_reasoning_effort: string };
  };
};

// Canonical source-owned agent documents persist for the lifetime of the mock
// module, so a route-away/reopen journey exercises the same read contract as
// the real CLI. Native stand-alone sub-agent fixtures remain independent.
const sourceAgentDocs = new Map<string, MockSkillAgent>([
  ["orchestrate-advanced/orch-implementer", {
    ok: true,
    skill: "orchestrate-advanced",
    name: "orch-implementer",
    description: "Implement one delegated unit and report its result.",
    body: "Shared instructions for the orchestrate implementer.",
    tier: "portable",
    hash: "mock-orch-implementer-v1",
    editable: true,
    harnesses: {
      "claude-code": { model: "sonnet" },
      codex: { model: "gpt-5.6-luna", model_reasoning_effort: "" },
    },
  }],
]);

// ─── Cloud targets (`hub cloud …`, routed through hub_cmd) ───────────────────
// Mirrors `cloud_targets.py`: a FIXED catalog, an export-state sidecar keyed by
// skill, and a status grammar derived by comparing a skill's current content
// fingerprint against the one the sidecar recorded. The mock fakes the
// fingerprint as `sha-<skill>` so an "edit" is just a stale recorded value.

const CLOUD_CATALOG = [
  {
    id: "claude-ai",
    label: "claude.ai",
    upload_url: "https://claude.ai/customize/skills",
    upload_path: "Customize > Skills > + > Create skill (upload the .zip)",
    supports: ["skill"],
    notes: [
      "The ZIP must contain the skill folder as its root (not a subfolder) — `<skill>/SKILL.md`. Hub builds exactly that layout.",
      "Skills you enable in claude.ai settings follow your account across claude.ai and the Claude desktop app, and are also available in the Claude add-ins for Excel, PowerPoint, Word and Outlook. Anthropic's docs do not state that they reach the Claude mobile apps — check the app before relying on it.",
      "MCP servers are NOT uploadable here: claude.ai only talks to REMOTE connectors you add by URL in its own settings. A local stdio server (the kind hub manages) cannot connect.",
      "Frontmatter caps: name <= 64 chars, description <= 200 chars.",
    ],
  },
  {
    id: "chatgpt-web",
    label: "ChatGPT (web)",
    upload_url: "https://chatgpt.com",
    upload_path: "Plugins > Skills > Create > Upload from your computer",
    supports: ["skill"],
    notes: [
      "ChatGPT reads the same SKILL.md package format, so hub's ZIP uploads as-is.",
      "Personal skills do NOT sync across surfaces: a skill uploaded on the web is not installed on the ChatGPT mobile app (or vice versa) — upload it again there.",
      "MCP connectors here are developer-mode and REMOTE-only; a local stdio server cannot connect.",
      "ChatGPT's DESKTOP app reads ~/.agents/skills, which the `codex` harness already writes for `scope: global` skills — set a skill's scope to global to land it there. A project equip writes <repo>/.agents/skills instead, so it reaches the desktop app only inside that repo's workspace.",
    ],
  },
];

interface CloudSidecarEntry {
  sha256: string;
  exported_at: string;
  zip_name: string;
}

const cloudSidecar: Record<string, Record<string, CloudSidecarEntry>> = {
  "claude-ai": {
    // Matches the current fingerprint → up to date.
    "code-review": {
      sha256: "sha-code-review",
      exported_at: "2026-08-17T09:12:00",
      zip_name: "code-review.zip",
    },
    // Recorded fingerprint is stale → changed since the last export.
    "openspec-apply": {
      sha256: "sha-openspec-apply-before-edit",
      exported_at: "2026-08-12T18:40:00",
      zip_name: "openspec-apply.zip",
    },
    // Exported once, no longer equipped → orphaned.
    "legacy-widget": {
      sha256: "sha-legacy-widget",
      exported_at: "2026-07-30T11:05:00",
      zip_name: "legacy-widget.zip",
    },
  },
  "chatgpt-web": {},
};

/** Non-blocking frontmatter lints (claude.ai caps), keyed by skill. */
const CLOUD_LINTS: Record<string, string[]> = {
  brainstorm: ["description is 214 chars — claude.ai truncates at 200"],
};

function cloudFingerprint(skill: string): string {
  return `sha-${skill}`;
}

/** Mirrors `cloud_targets.last_exported_at`: the newest ISO stamp in a
 *  target's sidecar, or null when hub has never built a ZIP for it. */
function cloudLastExported(
  recorded: Record<string, CloudSidecarEntry>,
): string | null {
  const stamps = Object.values(recorded).map((e) => e.exported_at);
  return stamps.length > 0 ? stamps.sort().slice(-1)[0] : null;
}

/** Equipped split, mirroring `partition_equipped`: bundles ∪ enabled, with
 *  mcp-servers refused (secrets in `env`) rather than exported. */
function cloudResolved(targetId: string): {
  exportable: string[];
  unsupported: { skill: string; reason: string }[];
} {
  const entry = registry.cloud?.[targetId] ?? { bundles: [], enabled: [] };
  const names = new Set<string>();
  for (const bn of entry.bundles ?? [])
    for (const sn of registry.bundles[bn]?.skills ?? []) names.add(sn);
  for (const sn of entry.enabled ?? []) names.add(sn);
  const exportable: string[] = [];
  const unsupported: { skill: string; reason: string }[] = [];
  for (const name of [...names].sort()) {
    const cfg = registry.skills[name];
    if (!cfg) {
      unsupported.push({ skill: name, reason: "not in the registry any more" });
    } else if (cfg.type === "mcp-server") {
      unsupported.push({
        skill: name,
        reason:
          "MCP server — cloud targets only accept skill ZIPs, and its runtime env may hold secrets",
      });
    } else {
      exportable.push(name);
    }
  }
  return { exportable, unsupported };
}

function cloudStatusPayload(targetId: string) {
  const target =
    CLOUD_CATALOG.find((t) => t.id === targetId) ?? CLOUD_CATALOG[0];
  const recorded = cloudSidecar[targetId] ?? {};
  const { exportable, unsupported } = cloudResolved(targetId);
  const skills = exportable.map((name) => {
    const entry = recorded[name];
    const current = cloudFingerprint(name);
    const status = !entry
      ? "new"
      : entry.sha256 === current
        ? "up_to_date"
        : "changed";
    return {
      skill: name,
      status,
      sha256: current,
      exported_sha256: entry?.sha256 ?? null,
      exported_at: entry?.exported_at ?? null,
      zip_name: entry?.zip_name ?? `${name}.zip`,
      lint: CLOUD_LINTS[name] ?? [],
    };
  });
  const equippedSet = new Set(exportable);
  const orphaned = Object.keys(recorded)
    .filter((n) => !equippedSet.has(n))
    .sort()
    .map((n) => ({
      skill: n,
      sha256: recorded[n].sha256,
      exported_at: recorded[n].exported_at,
      zip_name: recorded[n].zip_name,
    }));
  const count = (st: string) => skills.filter((r) => r.status === st).length;
  return {
    target: target.id,
    label: target.label,
    upload_url: target.upload_url,
    upload_path: target.upload_path,
    last_exported: cloudLastExported(recorded),
    notes: target.notes,
    skills,
    orphaned,
    unsupported,
    summary: {
      equipped: exportable.length,
      new: count("new"),
      changed: count("changed"),
      up_to_date: count("up_to_date"),
      missing: count("missing"),
      orphaned: orphaned.length,
      unsupported: unsupported.length,
      lint_warnings: skills.reduce((n, r) => n + r.lint.length, 0),
    },
  };
}

function cloudTargetsPayload() {
  return CLOUD_CATALOG.map((t) => {
    const st = cloudStatusPayload(t.id);
    return {
      ...t,
      equipped: st.summary.equipped,
      drift: {
        new: st.summary.new,
        changed: st.summary.changed,
        up_to_date: st.summary.up_to_date,
        missing: st.summary.missing,
        orphaned: st.summary.orphaned,
      },
      last_exported: st.last_exported,
    };
  });
}

/** `hub cloud export` — records every equipped skill's current fingerprint and
 *  prunes the sidecar entries that are no longer equipped. */
function cloudExportPayload(targetId: string, only?: string) {
  const target =
    CLOUD_CATALOG.find((t) => t.id === targetId) ?? CLOUD_CATALOG[0];
  const before = cloudStatusPayload(targetId);
  const recorded = (cloudSidecar[targetId] ??= {});
  const outDir = `/Users/dev/.skill-hub/exports/${targetId}`;
  const rows = before.skills.filter((r) => !only || r.skill === only);
  const results = rows.map((r) => {
    recorded[r.skill] = {
      sha256: r.sha256,
      exported_at: "2026-08-19T10:04:00",
      zip_name: `${r.skill}.zip`,
    };
    return {
      skill: r.skill,
      zip_path: `${outDir}/${r.skill}.zip`,
      sha256: r.sha256,
      files: 3,
      status_before: r.status,
      lint: r.lint,
    };
  });
  const pruned = before.orphaned.map((o) => {
    delete recorded[o.skill];
    return { skill: o.skill, removed_zip: `${outDir}/${o.zip_name}` };
  });
  return {
    target: target.id,
    label: target.label,
    upload_url: target.upload_url,
    upload_path: target.upload_path,
    out_dir: outDir,
    results,
    pruned,
    unsupported: before.unsupported,
    errors: [],
    notes: target.notes,
  };
}

// ─── Sync report (sync_report command) ───────────────────────────────────────
// DEFAULT envelope: everything in sync (all projects ok, and registry_current
// matches the report sha → `fresh`). This is what the StatusBar freshness chip
// reads in ~every scene, so the default must NOT be an error/stale state (that
// would paint every frame with a false "sync failed"). The interesting failure
// state (an ok:false project + affinity skips + a drifted sha) lives in
// `syncErrorEnvelope`, served only under the `?syncError=1` scene flag so exactly
// one dedicated frame set demonstrates the chip's error path + the drawer's
// failure row. The stale-only path stays behind `?staleReport=1`.
const SYNCED_SHA =
  "synced1111111111111111111111111111111111111111111111111111111111";
// Exported (m-5): see the `registry` export note above — same fixture-length
// guard, same reasoning.
export const syncReportEnvelope = {
  report: {
    schema_version: 1,
    generated_at: "2026-07-05T14:32:10Z",
    registry_sha256: SYNCED_SHA,
    registry_mtime: 1751725930.482,
    ok: true,
    global: {
      skipped: [],
      // `skipped_unowned: 0` (§7.2 default) — n-5.
      skills: { writes: 9, removed: 0, skipped_unowned: 0 },
      mcp: {
        writes: 1,
        removed: 0,
        // fs-mcp is `scope: global` — reaches every installed harness through
        // the global-MCP pass; opencode has no global MCP target (M2's
        // `no_global_target` — a whole-server refusal, always `skipped`).
        delivery: [
          {
            harness: "claude-code",
            adapter: "claude",
            scope: "global",
            server: "fs-mcp",
            target_file: "/Users/dev/.claude.json",
            state: "written",
            reason: null,
            detail: null,
          },
          {
            harness: "codex",
            adapter: "codex",
            scope: "global",
            server: "fs-mcp",
            target_file: "/Users/dev/.codex/config.toml",
            state: "written",
            reason: null,
            detail: null,
          },
          {
            harness: "opencode",
            adapter: "",
            scope: "global",
            server: "fs-mcp",
            target_file: "",
            state: "skipped",
            reason: "no_global_target",
            detail: null,
          },
        ],
      },
      permissions: { ok: true, errors: [] },
      // `hooks`/`doctor` (§7.2 default) — n-5: applied to `syncErrorEnvelope`
      // but not this steady one, so the twin rule was half-kept.
      hooks: { ok: true, errors: [] },
      doctor: { ok: true, errors: [] },
      remotes: { attempted: 1, alarming: 0 },
    },
    projects: {
      "moon-base": {
        ts: "2026-07-05T14:32:10Z",
        ok: true,
        errors: [],
        writes: 6,
        removed: 0,
        affinity_skips: [],
        // rt-android-expert (active via the `android` bundle) mentions
        // `needs-global` — a portable skill in no bundle and no project's
        // `enabled` — so it is a genuine missing reference here (PR3 surfaces
        // this; inert in PR2).
        missing_refs: [{ skill: "rt-android-expert", refs: ["needs-global"] }],
      },
      "example-app": {
        ts: "2026-07-05T14:32:10Z",
        ok: true,
        errors: [],
        writes: 2,
        removed: 0,
        affinity_skips: [],
        missing_refs: [],
        // context7 (portable, equipped here) — both effective harnesses
        // delivered. `?mcpBlocked=1` overrides the claude-code row below.
        mcp_delivery: [
          {
            harness: "claude-code",
            adapter: "claude",
            scope: "project:example-app",
            server: "context7",
            target_file: "/Users/dev/projects/example-app/.mcp.json",
            state: "written",
            reason: null,
            detail: null,
          },
          {
            harness: "codex",
            adapter: "codex",
            scope: "project:example-app",
            server: "context7",
            target_file: "/Users/dev/projects/example-app/.codex/config.toml",
            state: "written",
            reason: null,
            detail: null,
          },
        ],
      },
      "skill-hub": {
        ts: "2026-07-05T14:32:10Z",
        ok: true,
        errors: [],
        writes: 3,
        removed: 0,
        affinity_skips: [],
        missing_refs: [],
      },
    },
  },
  registry_current: {
    // MATCHES report.registry_sha256 → the aggregate chip resolves to `fresh`.
    sha256: SYNCED_SHA,
    mtime: 1751725930.482,
  },
};

// FAILURE envelope (served under `?syncError=1`): exercises the full freshness
// grammar the drawer + chip render for a bad sync —
//   moon-base   : ok + affinity-skips  → stale (+ "N skills won't reach any agent")
//   example-app : ok:false + error     → error (drives the aggregate chip → error)
//   skill-hub   : absent from report   → unknown ("run sync")
// The report sha deliberately differs from registry_current (a post-sync edit).
const syncErrorEnvelope = {
  report: {
    schema_version: 1,
    generated_at: "2026-07-05T14:32:10Z",
    registry_sha256: SYNCED_SHA,
    registry_mtime: 1751725930.482,
    ok: false,
    global: {
      skipped: [],
      skills: { writes: 9, removed: 0 },
      mcp: { writes: 1, removed: 0 },
      permissions: { ok: true, errors: [] },
      hooks: { ok: true, errors: [] },
      doctor: {
        ok: false,
        errors: [
          { stage: "doctor", message: "UNBOUNDED_BASH: Bash(*) is allowed globally" },
        ],
      },
      remotes: { attempted: 1, alarming: 0 },
    },
    projects: {
      "moon-base": {
        ts: "2026-07-05T14:32:10Z",
        ok: true,
        errors: [],
        writes: 6,
        removed: 0,
        skipped_unowned: 2,
        affinity_skips: [
          {
            skill: "codex-only",
            skill_harnesses: ["codex"],
            project_harnesses: ["claude-code"],
          },
        ],
        missing_refs: [],
      },
      "example-app": {
        ts: "2026-07-05T14:32:10Z",
        ok: false,
        errors: [
          {
            stage: "symlink",
            message: "source missing: ~/.skill-hub/skills/brainstorm/SKILL.md",
          },
        ],
        writes: 2,
        removed: 0,
        affinity_skips: [],
        missing_refs: [],
      },
    },
  },
  registry_current: {
    sha256: "current999999999999999999999999999999999999999999999999999999999",
    mtime: 1751726500.113,
  },
};

/** Mirrors `hooks_model.deep_merge` (Python): recursive per-key merge, project
 *  wins, nested dicts merge recursively, everything else (incl. lists)
 *  replaces wholesale. Backs the `mcp_set_json` mock arm — the stdin path
 *  `useMcpDraft.save()` uses whenever a changed value is a header or env
 *  value (M8). */
function mcpDeepMergeMock(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, val] of Object.entries(override ?? {})) {
    const baseVal = result[key];
    if (
      val !== null &&
      typeof val === "object" &&
      !Array.isArray(val) &&
      baseVal !== null &&
      typeof baseVal === "object" &&
      !Array.isArray(baseVal)
    ) {
      result[key] = mcpDeepMergeMock(
        baseVal as Record<string, unknown>,
        val as Record<string, unknown>,
      );
    } else {
      result[key] = val;
    }
  }
  return result;
}

/** Reads a flag's value whether it arrived as two tokens (`--flag value`,
 *  every writer but the Library's bundle mode) or one merged token
 *  (`--flag=value`, the Library's bundle mode — argparse eats a value that
 *  starts with `-` when it is a separate token). `undefined` when the flag
 *  is absent; `""` is a real, present value (an empty description). */
function flagValue(args: string[], flag: string): string | undefined {
  const prefix = `${flag}=`;
  const merged = args.find((a) => a.startsWith(prefix));
  if (merged !== undefined) return merged.slice(prefix.length);
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

// ─── Sources list payload (hub source list --json) ───────────────────────────

/** Skills a source OWNS and still carries upstream — the only membership a
 *  linked bundle may hold (sorted, as the CLI reconciles them). */
function ownedSkillNames(sourceId: string): string[] {
  return Object.entries(registry.skills)
    .filter(
      ([, s]) =>
        s.managed === "external" &&
        s.origin?.source === sourceId &&
        !s.source_missing,
    )
    .map(([name]) => name)
    .sort();
}

/** Mirror of `_source_remove_impact`: what a source's skills currently reach.
 *  Fed back through `source enable|disable --json` so the undo toast can say
 *  exactly what stopped flowing. */
function sourceImpact(sourceId: string): {
  skills: string[];
  bundles: string[];
  projects: string[];
} {
  const skills = Object.entries(registry.skills)
    .filter(([, s]) => s.managed === "external" && s.origin?.source === sourceId)
    .map(([name]) => name);
  const owned = new Set(skills);
  const bundles = Object.entries(registry.bundles)
    .filter(([, b]) => (b.skills ?? []).some((s) => owned.has(s)))
    .map(([name]) => name);
  const bundleSet = new Set(bundles);
  const projects = Object.entries(registry.projects)
    .filter(
      ([, p]) =>
        (p.enabled ?? []).some((s) => owned.has(s)) ||
        (p.bundles ?? []).some((b) => bundleSet.has(b)),
    )
    .map(([name]) => name);
  return { skills, bundles, projects };
}

/** Built fresh on every call so `source edit|enable|disable` (which mutate the
 *  mock registry) are reflected the next time `useSources()` refetches. */
function sourceListPayload(): string {
  const counts: Record<string, number> = {};
  for (const skill of Object.values(registry.skills)) {
    const sid =
      skill.managed === "external"
        ? skill.origin?.source ?? "unknown"
        : skill.managed === "starter"
          ? "starter"
          : "local";
    counts[sid] = (counts[sid] ?? 0) + 1;
  }
  return JSON.stringify({
    sources: [
      {
        id: "local",
        type: "local",
        name: "Local",
        builtin: true,
        status: "local",
        enabled: true,
        skill_count: counts.local ?? 0,
      },
      {
        id: "starter",
        type: "starter",
        name: "Starter Pack",
        builtin: true,
        status: "bundled",
        enabled: true,
        skill_count: counts.starter ?? 0,
      },
      ...Object.entries(registry.sources ?? {}).map(([id, cfg]) => ({
        id,
        builtin: false,
        skill_count: counts[id] ?? 0,
        ...cfg,
        name: cfg.name ?? id,
        enabled: cfg.enabled ?? true,
      })),
    ],
    errors: [],
  });
}

// ─── Dropped-upstream skills (`hub source dropped|recover`, `archive`,
// `unarchive`) ────────────────────────────────────────────────────────────────
// `?contextAttention=1` seeds two real dropped skills into the LIVE mutable
// `registry` object (not just a per-call clone, unlike the twin-rule pattern
// above) — Archive/Forget really deletes state and Keep-as-local really
// restores it, so every consumer (`read_registry`, `source dropped`, `archive`,
// `unarchive`) has to agree on the same mutable source of truth for an undo or
// a re-fetch to behave honestly across a whole scene/journey.

type DroppedSkillSuccessorMeta = {
  path: string;
  name: string;
  registered_as: string | null;
  similarity: number;
};

type DroppedSkillMeta = {
  source: string;
  source_name: string;
  path: string;
  ref: string;
  ref_short: string;
  last_seen_at: string;
  reason: "renamed" | "deleted" | "unknown";
  successor: DroppedSkillSuccessorMeta | null;
  /** A below-confidence-gate rename guess (similarity < 70) — only ever
   *  present alongside `reason: "deleted"`. */
  possible_successor?: DroppedSkillSuccessorMeta | null;
  recoverable: boolean;
  skill_md: string;
};

const DROPPED_SKILL_META: Record<string, DroppedSkillMeta> = {
  "ds-tokens": {
    source: "design-system",
    source_name: "Design System",
    path: "skills/ds-tokens",
    ref: "694fa30311e02c2639942308513555e61ee84a6f",
    ref_short: "694fa30",
    last_seen_at: "2026-06-10T21:59:34+02:00",
    reason: "deleted",
    successor: null,
    // Below the CLI's 70% confidence gate — a hedge, never a primary action.
    possible_successor: {
      path: "skills/design-tokens-v2",
      name: "design-tokens-v2",
      registered_as: null,
      similarity: 62,
    },
    recoverable: true,
    skill_md:
      "---\nname: ds-tokens\ndescription: |\n  Design tokens for color, spacing, radius, elevation, and typography.\n---\n\nUse the shared token set instead of hand-copied constants.\n",
  },
  diagnose: {
    source: "design-system",
    source_name: "Design System",
    path: "skills/engineering/diagnose",
    ref: "b1c2d3e4f5061728394a5b6c7d8e9f0a1b2c3d4e",
    ref_short: "b1c2d3e",
    last_seen_at: "2026-07-05T09:12:00+02:00",
    reason: "renamed",
    successor: {
      path: "skills/engineering/diagnosing-bugs",
      name: "diagnosing-bugs",
      registered_as: "diagnosing-bugs",
      similarity: 96,
    },
    recoverable: true,
    skill_md:
      "---\nname: diagnose\ndescription: |\n  Diagnose a failing build from the available signals.\n---\n\nSuperseded by diagnosing-bugs.\n",
  },
};

let contextAttentionFixturesApplied = false;

let pickerManyFixturesApplied = false;

function ensurePickerManyFixtures(): void {
  if (!sceneFlag("pickerMany") || pickerManyFixturesApplied) return;
  pickerManyFixturesApplied = true;
  for (const project of ["alpha-console", "beta-lab", "gamma-tools", "delta-api", "epsilon-web", "zeta-mobile", "eta-data", "theta-cli", "a-long-project-name-for-search"]) {
    registry.projects[project] ??= {
      path: `/Users/dev/projects/${project}`,
      bundles: [],
      enabled: [],
      harnesses: ["claude-code"],
    };
  }
}

/** Idempotent: mutates the LIVE `registry` (once), so `archive`/`unarchive`
 *  and a later `read_registry` re-fetch all see the same evolving state. */
function ensureContextAttentionFixtures(): void {
  if (!sceneFlag("contextAttention") || contextAttentionFixturesApplied) return;
  contextAttentionFixturesApplied = true;
  registry.skills["ds-tokens"] = {
    version: "2.4.0",
    description:
      "Design tokens for color, spacing, radius, elevation, and typography shared across every Android and web surface in the organization, kept in one canonical source so no app hand-copies constants that drift out of sync over time.",
    source: "~/.skill-hub/sources/design-system/worktree/skills/ds-tokens",
    type: "claude-skill",
    scope: "portable",
    upstream: "git@github.com:acme/design-system.git",
    managed: "external",
    origin: { source: "design-system", source_type: "git" },
    source_missing: true,
  };
  registry.skills.diagnose = {
    version: "1.0.0",
    description: "Diagnose a failing build or a flaky test from the available signals.",
    source: "~/.skill-hub/sources/design-system/worktree/skills/engineering/diagnose",
    type: "claude-skill",
    scope: "portable",
    upstream: "git@github.com:acme/design-system.git",
    managed: "external",
    origin: { source: "design-system", source_type: "git" },
    source_missing: true,
  };
  registry.skills["diagnosing-bugs"] = {
    version: "1.1.0",
    description: "Diagnose a failing build, a flaky test, or a service outage from the signals you have.",
    source: "~/.skill-hub/sources/design-system/worktree/skills/engineering/diagnosing-bugs",
    type: "claude-skill",
    scope: "portable",
    upstream: "git@github.com:acme/design-system.git",
    managed: "external",
    origin: { source: "design-system", source_type: "git" },
  };
  registry.sources ??= {};
  registry.sources["design-system"] = {
    type: "git",
    name: "Design System",
    url: "git@github.com:acme/design-system.git",
    branch: "main",
    status: "up-to-date",
    current_ref: "9f1a2b3c4d5e6f7890abcdef1234567890abcdef",
    last_checked_at: "2026-09-01T10:00:00Z",
    last_synced_at: "2026-09-01T10:00:00Z",
  };
  // `ds-tokens` is deliberately EQUIPPED (unlike `diagnose`) so the two
  // fixtures exercise both halves of the confirm gate: an equipped dropped
  // skill opens the blast-radius dialog, an unequipped one goes straight
  // through with Undo in the toast.
  const exampleApp = registry.projects["example-app"];
  if (exampleApp) {
    exampleApp.enabled = [...(exampleApp.enabled ?? []), "ds-tokens"];
  }
  registry.bundles["legacy-tools"] = {
    description: "Retired tooling kept for reference.",
    icon: "🧱",
    scope: "project-specific",
    skills: ["brainstorm", "retired-skill"],
  };
}

/** Mirror of `useSkillRemoval`'s `skillReferenceSites` / the CLI's
 *  `_skill_reference_sites`, over the mock's own registry. */
function mockSkillReferenceSites(name: string): {
  projects: string[];
  bundles: string[];
  remotes: string[];
  cloud: string[];
} {
  const projects = Object.entries(registry.projects ?? {})
    .filter(
      ([, p]) =>
        (p.enabled ?? []).includes(name) ||
        Object.prototype.hasOwnProperty.call(p.invocation_overrides ?? {}, name),
    )
    .map(([id]) => id)
    .sort();
  const bundles = Object.entries(registry.bundles ?? {})
    .filter(([, b]) => (b.skills ?? []).includes(name))
    .map(([id]) => id)
    .sort();
  const remotes = Object.entries(registry.remotes ?? {})
    .filter(([, r]) => (r.enabled ?? []).includes(name))
    .map(([id]) => id)
    .sort();
  const cloud = Object.entries(registry.cloud ?? {})
    .filter(([, c]) => (c.enabled ?? []).includes(name))
    .map(([id]) => id)
    .sort();
  return { projects, bundles, remotes, cloud };
}

function droppedSkillRow(name: string, withContent: boolean) {
  const skill = registry.skills[name];
  const meta = DROPPED_SKILL_META[name];
  if (!skill || skill.source_missing !== true) return null;
  return {
    name,
    source: meta?.source ?? "unknown",
    source_name: meta?.source_name ?? "unknown",
    path: meta?.path ?? "",
    ref: meta?.ref ?? null,
    ref_short: meta?.ref_short ?? null,
    last_seen_at: meta?.last_seen_at ?? null,
    reason: meta?.reason ?? "unknown",
    successor: meta?.successor ?? null,
    possible_successor: meta?.possible_successor ?? null,
    equipped: mockSkillReferenceSites(name),
    recoverable: meta?.recoverable ?? false,
    skill_md: withContent ? (meta?.skill_md ?? null) : null,
  };
}

/** `hub source dropped [SOURCE_ID] [--skill NAME] [--content] --json`. */
function droppedSkillsPayload(cmdArgs: string[]): string {
  const skillIdx = cmdArgs.indexOf("--skill");
  const only = skillIdx >= 0 ? cmdArgs[skillIdx + 1] : null;
  const withContent = cmdArgs.includes("--content");
  const names = Object.keys(registry.skills).filter(
    (n) => registry.skills[n].source_missing === true && (!only || n === only),
  );
  const skills = names
    .map((n) => droppedSkillRow(n, withContent))
    .filter((r): r is NonNullable<typeof r> => r != null);
  return JSON.stringify({ ok: true, skills });
}

/** `hub source recover NAME --json` — restores the pinned ref as a local skill. */
function sourceRecoverPayload(name: string): { success: boolean; output: string } {
  const skill = registry.skills[name];
  if (!skill || skill.source_missing !== true) {
    return {
      success: false,
      output: JSON.stringify({ ok: false, error: `not source-missing: ${name}` }),
    };
  }
  const meta = DROPPED_SKILL_META[name];
  const dest = `~/.skill-hub/skills/${name}`;
  registry.skills[name] = {
    version: skill.version,
    description: skill.description,
    source: dest,
    type: skill.type,
    scope: skill.scope,
    upstream: null,
    managed: "local",
  };
  const payload = JSON.stringify({
    ok: true,
    name,
    path: dest,
    ref: meta?.ref ?? null,
    source: meta?.source ?? null,
  });
  return {
    success: true,
    output: `${payload}\nSyncing {example-app} → /Users/dev/{proj}\nsync complete {ok}`,
  };
}

/** One archived skill's full snapshot, for `unarchive` to restore verbatim —
 *  the mock's equivalent of `state/archive/<name>.json`. */
interface ArchivedSnapshot {
  entry: Registry["skills"][string];
  references: {
    bundles: Record<string, number>;
    projects: string[];
    invocationOverrides: Record<string, string>;
    remotes: string[];
    cloud: string[];
  };
}

const archivedSidecar = new Map<string, ArchivedSnapshot>();

/** `hub archive NAME [NAME…] --json` — one registry save for the whole batch,
 *  same as the real CLI. Writes a sidecar per name so `unarchive` can restore
 *  it exactly (registry entry + every reference site). */
function archivePayload(cmdArgs: string[]): { success: boolean; output: string } {
  const names = cmdArgs.slice(1).filter((a) => a !== "--json" && a !== "--dry-run");
  const unknown = names.filter((n) => !registry.skills[n]);
  if (unknown.length > 0) {
    return {
      success: false,
      output: JSON.stringify({ ok: false, errors: [`unknown skill(s): ${unknown.join(", ")}`] }),
    };
  }
  const archived = names.map((name) => {
    const entry = registry.skills[name];
    const references: ArchivedSnapshot["references"] = {
      bundles: Object.fromEntries(
        Object.entries(registry.bundles)
          .filter(([, b]) => (b.skills ?? []).includes(name))
          .map(([bn, b]) => [bn, (b.skills ?? []).indexOf(name)]),
      ),
      projects: Object.entries(registry.projects ?? {})
        .filter(([, p]) => (p.enabled ?? []).includes(name))
        .map(([pn]) => pn),
      invocationOverrides: Object.fromEntries(
        Object.entries(registry.projects ?? {})
          .filter(([, p]) => p.invocation_overrides?.[name] != null)
          .map(([pn, p]) => [pn, p.invocation_overrides![name]]),
      ),
      remotes: Object.entries(registry.remotes ?? {})
        .filter(([, r]) => (r.enabled ?? []).includes(name))
        .map(([rn]) => rn),
      cloud: Object.entries(registry.cloud ?? {})
        .filter(([, c]) => (c.enabled ?? []).includes(name))
        .map(([cn]) => cn),
    };
    archivedSidecar.set(name, { entry: structuredClone(entry), references });

    delete registry.skills[name];
    for (const b of Object.values(registry.bundles)) {
      b.skills = (b.skills ?? []).filter((s) => s !== name);
    }
    for (const p of Object.values(registry.projects ?? {})) {
      p.enabled = (p.enabled ?? []).filter((s) => s !== name);
      if (p.invocation_overrides) delete p.invocation_overrides[name];
    }
    for (const r of Object.values(registry.remotes ?? {})) {
      r.enabled = (r.enabled ?? []).filter((s) => s !== name);
    }
    for (const c of Object.values(registry.cloud ?? {})) {
      c.enabled = (c.enabled ?? []).filter((s) => s !== name);
    }
    return {
      name,
      moved: entry.managed !== "external" && entry.managed !== "starter",
      references: {
        bundles: references.bundles,
        projects: references.projects,
        invocation_overrides: references.invocationOverrides,
        remotes: references.remotes,
        cloud: references.cloud,
      },
    };
  });
  const payload = JSON.stringify({ ok: true, archived, undo: ["unarchive", ...names] });
  return { success: true, output: payload };
}

/** `hub unarchive NAME [NAME…] --json`. */
function unarchivePayload(cmdArgs: string[]): { success: boolean; output: string } {
  const names = cmdArgs.slice(1).filter((a) => a !== "--json");
  const restored: string[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];
  for (const name of names) {
    const snap = archivedSidecar.get(name);
    if (!snap) {
      skipped.push({ name, reason: "sidecar missing" });
      continue;
    }
    if (registry.skills[name]) {
      skipped.push({ name, reason: "already registered" });
      continue;
    }
    registry.skills[name] = snap.entry;
    for (const [bn, idx] of Object.entries(snap.references.bundles)) {
      const b = registry.bundles[bn];
      if (!b) continue;
      const arr = b.skills ?? (b.skills = []);
      arr.splice(Math.min(idx, arr.length), 0, name);
    }
    for (const pn of snap.references.projects) {
      const p = registry.projects?.[pn];
      if (p) p.enabled = [...(p.enabled ?? []), name];
    }
    for (const [pn, mode] of Object.entries(snap.references.invocationOverrides)) {
      const p = registry.projects?.[pn];
      if (p) {
        p.invocation_overrides = {
          ...(p.invocation_overrides ?? {}),
          [name]: mode as "auto" | "user-only" | "model-only",
        };
      }
    }
    for (const rn of snap.references.remotes) {
      const r = registry.remotes?.[rn];
      if (r) r.enabled = [...(r.enabled ?? []), name];
    }
    for (const cn of snap.references.cloud) {
      const c = registry.cloud?.[cn];
      if (c) c.enabled = [...(c.enabled ?? []), name];
    }
    archivedSidecar.delete(name);
    restored.push(name);
  }
  return {
    success: restored.length > 0 || names.length === 0,
    output: JSON.stringify({ ok: restored.length > 0, restored, skipped }),
  };
}

// ─── Harnesses ────────────────────────────────────────────────────────────────

// Every entry carries the `agents` capability object (from `emit_schema()`):
// claude-code + codex support sub-agent definitions; pi/opencode do not.
const harnessGlobalOverrides = new Map<string, boolean>();
let settingsGlobalStrategy = "symlink";
const settingsProjectStrategies = new Map<string, string>();
const harnessList = [
  {
    id: "claude-code",
    label: "Claude Code",
    installed: true,
    on_globally: true,
    used_by_projects: ["example-app", "moon-base", "skill-hub"],
    path: "/usr/local/bin/claude",
    version: "1.0.42",
    agents: {
      supported: true,
      format: "md",
      agents_dir: "~/.claude/agents",
      project_agents_dir: ".claude/agents",
    },
    global_doc: "/Users/dev/.claude/CLAUDE.md",
    global_doc_exists: true,
    config_dir: "/Users/dev/.claude",
    project_skills_dir: ".claude/skills",
  },
  {
    id: "codex",
    label: "Codex",
    installed: true,
    on_globally: false,
    used_by_projects: ["example-app"],
    path: "/usr/local/bin/codex",
    version: "0.142.2",
    agents: {
      supported: true,
      format: "toml",
      agents_dir: "~/.codex/agents",
      project_agents_dir: ".codex/agents",
    },
    global_doc: "/Users/dev/.codex/AGENTS.md",
    global_doc_exists: false,
    config_dir: "/Users/dev/.codex",
    project_skills_dir: ".codex/skills",
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
    global_doc: "/Users/dev/.pi/agent/AGENTS.md",
    global_doc_exists: false,
    config_dir: "/Users/dev/.pi",
    project_skills_dir: ".pi/skills",
  },
  {
    id: "opencode",
    label: "opencode",
    installed: true,
    on_globally: false,
    used_by_projects: [],
    path: "/opt/homebrew/bin/opencode",
    version: "0.3.0",
    agents: {
      supported: false,
      format: null,
      agents_dir: null,
      project_agents_dir: null,
    },
    global_doc: "/Users/dev/.config/opencode/AGENTS.md",
    global_doc_exists: true,
    config_dir: "/Users/dev/.local/share/opencode",
    project_skills_dir: ".config/opencode/skills",
  },
];

// Deterministic per-harness global-doc bodies for the editor scene. Keep them
// boring + side-effect-free (default fixtures leak across the whole gallery).
const GLOBAL_DOCS: Record<string, { path: string; content: string }> = {
  "claude-code": {
    path: "/Users/dev/.claude/CLAUDE.md",
    content:
      "# Global instructions\n\nPrefer concise answers. Cite file paths.\n" +
      "Run `code-review` before opening a pull request, and /brainstorm when the shape is unclear.\n",
  },
  codex: { path: "/Users/dev/.codex/AGENTS.md", content: "" },
  pi: { path: "/Users/dev/.pi/agent/AGENTS.md", content: "" },
  opencode: {
    path: "/Users/dev/.config/opencode/AGENTS.md",
    content: "# opencode global\n\nRun the linter before committing.\n",
  },
};

// ─── Global-doc sharing (`hub harness doc status|link|unlink`) ────────────────
// Raw per-harness state — the mock's analogue of `global_docs.status()`'s
// pre-derivation classification (`"source"` is DERIVED from followers, same
// as the real backend, in `docSharingStatusRows` below). Mutated in place by
// the `hub_cmd` "harness doc link/unlink" branches so a scene/e2e journey can
// link → unlink and see the change on a refetch. codex starts out FOLLOWING
// claude-code so the editor scenes/tests have a populated "shared" example
// out of the box; pi stays genuinely missing.
const docSharingState: Record<
  string,
  { state: "missing" | "standalone" | "follows"; follows: string | null }
> = {
  "claude-code": { state: "standalone", follows: null },
  codex: { state: "follows", follows: "claude-code" },
  pi: { state: "missing", follows: null },
  opencode: { state: "standalone", follows: null },
};

function docSharingFollowers(id: string): string[] {
  return Object.entries(docSharingState)
    .filter(([, st]) => st.state === "follows" && st.follows === id)
    .map(([hid]) => hid)
    .sort();
}

/** The real file backing `id`'s doc: itself, or — when it follows another
 *  harness — that harness's own entry. Mirrors `global_docs.doc_path` +
 *  chain-resolution: a follower always points directly at a real file. */
function docSharingSourceId(id: string): string {
  const st = docSharingState[id];
  return st && st.state === "follows" && st.follows ? st.follows : id;
}

function docSharingStatusRows(): Array<{
  harness: string;
  label: string;
  path: string;
  state: string;
  follows: string | null;
  followers: string[];
  bytes: number | null;
}> {
  return Object.keys(docSharingState).map((id) => {
    const st = docSharingState[id];
    const followers = docSharingFollowers(id);
    const harnessEntry = harnessList.find((h) => h.id === id);
    const doc = GLOBAL_DOCS[id];
    let state: string = st.state;
    if (state === "standalone" && followers.length > 0) state = "source";
    const hasBytes = state === "standalone" || state === "source";
    return {
      harness: id,
      label: harnessEntry?.label ?? id,
      path: doc?.path ?? harnessEntry?.global_doc ?? "",
      state,
      follows: st.follows,
      followers,
      bytes: hasBytes ? (doc?.content.length ?? 0) : null,
    };
  });
}

// ─── Skill document (SKILL.md body — stresses the editor) ─────────────────────

/** Strip a leading YAML frontmatter block, mirroring the real
 *  `split_frontmatter` (`app/src-tauri/src/commands/registry.rs`): the actual
 *  `read_skill_document` command never returns the frontmatter as part of
 *  `body`, so a mocked fixture that keeps it (every `SKILL.md` fixture below
 *  is stored as the raw on-disk file, frontmatter included) must strip it the
 *  same way before answering `read_skill_document`. Tolerates a leading BOM
 *  and a CRLF fence, and strips every trailing blank line after the closing
 *  `---` (not just one) — same as the Rust `trim_start_matches(eol)`. */
function stripFrontmatter(content: string): string {
  const s = content.replace(/^\uFEFF/, "");
  const m = /^---\r?\n[\s\S]*?\r?\n---(\r?\n)/.exec(s);
  if (!m) return s;
  const eol = m[1] === "\r\n" ? "\\r\\n" : "\\n";
  return s.slice(m[0].length).replace(new RegExp(`^(?:${eol})+`), "");
}

const skillBody = `---
name: rt-android-expert
description: Android Jetpack Compose planner and architecture advisor.
version: 0.3.0
---

# rt-android-expert

This skill plans **Android** features using \`Jetpack Compose\`, Clean Architecture,
and Coroutines. It produces detailed implementation plans with code snippets.

A very long unbroken line to stress horizontal overflow and the editor gutter: thisisaverylongunbrokentokenwithnowhitespaceatallthatshouldforcehorizontalscrollingorwrappingdependingonthecodemirrorconfigurationandwemustseehowthecursoraligns1234567890abcdefghijklmnopqrstuvwxyz

## Usage

When the user asks for an Android feature, gather requirements, then:

1. Survey the existing module structure.
2. Propose a \`ViewModel\` + \`UiState\` shape with \`inline code\` annotations.
3. Sketch the Compose tree.

Run \`code-review\` after any Compose change, and again before opening a pull request.
For a wider architecture discussion, try /brainstorm before committing to a shape.
A shared \`needs-global\` helper covers cross-project constants once promoted.
Background lives in references/plan-file.md, not tracked in this skill.

\`\`\`kotlin
@Composable
fun ThoughtDetailScreen(state: UiState, onAction: (Action) -> Unit) {
    Scaffold(topBar = { CollapsingToolbar(title = state.title) }) { padding ->
        LazyColumn(Modifier.padding(padding)) {
            items(state.items, key = { it.id }) { item ->
                ThoughtRow(item, onClick = { onAction(Action.Open(item.id)) })
            }
        }
    }
}
\`\`\`

<!-- skill-hub:snippet:android-conventions:start -->
## Project conventions (managed snippet)

Always use \`StateFlow\` for screen state and **never** expose \`MutableStateFlow\`.
Prefer \`collectAsStateWithLifecycle()\` in Composables. This block is wrapped in
agent-doc snippet markers to surface the editor cursor-misalignment bug — note
how the caret tracks across these marker lines and the **bold**/\`code\` spans.
<!-- skill-hub:snippet:android-conventions:end -->

## Notes

- Edge case: empty list → show \`EmptyState\`.
- Another **bold** line with \`inline code\` and a [link](https://example.com).
`;

// ─── Skill files (editor file navigator) ─────────────────────────────────────
// Per-skill file trees keyed by registry name, mirroring `skill_files.rs`.
// A `null` body is a binary file the editor must refuse to open. The store is
// MUTATED by the create/write arms so a journey that adds or edits a file sees
// it in the next listing.
//
// Fidelity: only states the real backend can reach by default —
//   rt-android-expert  multi-file, hub-owned  (nested dirs + a binary asset)
//   brainstorm         single-file            (the common case: just SKILL.md)
//   android-compose-ui multi-file, `managed: external` → every write refused

const skillFileTrees: Record<string, Record<string, string | null>> = {
  "rt-android-expert": {
    "SKILL.md": skillBody,
    "references/checklist.md": `# Review checklist

- [ ] \`UiState\` is immutable and exhaustive.
- [ ] No \`MutableStateFlow\` leaks past the ViewModel.
- [ ] Every \`LazyColumn\` item has a stable \`key\`.
- [ ] Previews cover the empty, loading and error states.
`,
    "references/patterns.md": `# Compose patterns

## State hoisting

Keep the composable stateless; hoist to the caller and pass \`onAction\`.

## Slot APIs

Prefer a \`content: @Composable () -> Unit\` slot over a boolean flag zoo.
`,
    "scripts/run.py": `#!/usr/bin/env python3
"""Scaffold a Compose screen from the plan in plan.md."""

import sys
from pathlib import Path


def main() -> int:
    plan = Path(sys.argv[1] if len(sys.argv) > 1 else "plan.md")
    if not plan.exists():
        print(f"no plan at {plan}", file=sys.stderr)
        return 1
    print(plan.read_text())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
`,
    "assets/logo.png": null,
  },
  brainstorm: {
    "SKILL.md": `---
name: brainstorm
description: Spin up a team of expert agents to brainstorm a feature.
version: 1.2.0
---

# brainstorm

Run structured multi-round deliberation, then synthesize a single result.

Pair with /rt-android-expert for Compose architecture.
`,
  },
  "android-compose-ui": {
    "SKILL.md": `---
name: android-compose-ui
description: "External: Compose UI patterns shared by an org pack."
version: 1.0.0
---

# android-compose-ui

Shared Compose conventions. Owned upstream — duplicate it to edit.
`,
    "references/theming.md": `# Theming

Use \`MaterialTheme.colorScheme\`; never hard-code a hex.
`,
    "scripts/lint.sh": `#!/usr/bin/env bash
set -euo pipefail
./gradlew lintDebug
`,
  },
  // (F2, case 11) A scaffolded stdio server owns a real folder: FILES must
  // list SKILL.md AND server.py, and the client must actually issue the
  // query (`SkillEditor.tsx`'s `mcpHasFolder` gate).
  "fs-mcp": {
    "SKILL.md": `---
name: fs-mcp
description: Filesystem MCP server exposing read/write tools over stdio.
type: mcp-server
---

# fs-mcp (MCP Server)

- transport: stdio
- endpoint: python3 server.py
`,
    "server.py": `#!/usr/bin/env python3
"""Filesystem MCP server: read/write/list over stdio."""

def main() -> int:
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
`,
  },
};

const SKILL_FILE_BINARY_EXTS = ["png", "jpg", "jpeg", "gif", "webp", "pdf", "zip"];
const SKILL_FILE_KIND_BY_EXT: Record<string, string> = {
  md: "markdown",
  mdx: "markdown",
  markdown: "markdown",
  py: "script",
  sh: "script",
  bash: "script",
  zsh: "script",
  js: "script",
  ts: "script",
  mjs: "script",
  rb: "script",
  txt: "text",
  rst: "text",
  csv: "text",
  log: "text",
  json: "data",
  yaml: "data",
  yml: "data",
  toml: "data",
  xml: "data",
};

function skillFileExt(rel: string): string {
  const base = rel.split("/").pop() ?? rel;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/** 32 hex chars, same width as the real truncated-sha256 fingerprint. */
function skillFileHash(content: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < content.length; i++) {
    h ^= content.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (
    h.toString(16).padStart(8, "0") + content.length.toString(16).padStart(8, "0")
  ).repeat(2);
}

/** Lazily materialize a tree so any skill route works, and so create/write on
 *  a skill without an explicit fixture still persists. */
function skillFilesFor(name: string): Record<string, string | null> {
  return (skillFileTrees[name] ??= {
    "SKILL.md": `---\nname: ${name}\n---\n\n# ${name}\n`,
  });
}

function skillFileEntry(rel: string, body: string | null) {
  const ext = skillFileExt(rel);
  const binary = body === null || SKILL_FILE_BINARY_EXTS.includes(ext);
  return {
    rel,
    size: binary ? 18402 : new TextEncoder().encode(body ?? "").length,
    kind: binary ? "binary" : (SKILL_FILE_KIND_BY_EXT[ext] ?? "other"),
    editable: !binary,
    reason: binary ? "binary" : null,
  };
}

function skillFilesReject(message: string): Promise<never> {
  return Promise.reject(new Error(message));
}

// ─── Rename cascade (`hub rename <old> <new> …`, PR2 plans/3.md §Mocks) ──────
/** The one agent-doc referrer every dry-run reports — fixed, like the
 *  `snippet rename` mock's damaged-location error, so the AGENT DOCS group
 *  and its "no scene flag needed" disclosure are always exercisable. */
const RENAME_AGENT_DOC = {
  project: "moon-base",
  rel: "AGENTS.md",
  path: "/Users/dev/projects/moon-base-android-client/AGENTS.md",
  count: 2,
};

/**
 * Skill rename-cascade dry-run plan. Skill referrers are SCANNED: every other
 * skill whose resolved body (the same `skillFileTrees[name]["SKILL.md"] ??
 * skillBody` fallback `read_skill_document` itself uses) mentions `from` as a
 * backtick or slash reference, plus one fixed `<from>/references/notes.md`
 * row so the SKILLS group is never empty regardless of what got renamed. The
 * snippet and agent-doc rows are fixed fixtures — this mock has no per-
 * snippet body text to scan — so `android-conventions` and `moon-base` are
 * reported every time (skipped instead when the renamed skill's own name
 * collides with the snippet fixture). One `managed: external` skill and one
 * snippet-owned agent doc are always reported skipped too, for the same
 * "no scene flag needed" reason the snippet-rename mock's damaged marker is.
 */
function renameCascadePlan(from: string, to: string): RenamePlan {
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const mentionRe = new RegExp(`\`${escaped}\`|/${escaped}\\b`);
  const scanned = Object.keys(registry.skills)
    .filter((n) => n !== from)
    .filter((n) => {
      const entry = registry.skills[n];
      return entry.managed !== "external" && entry.managed !== "starter" && entry.type !== "mcp-server";
    })
    .filter((n) => {
      const own = Object.prototype.hasOwnProperty.call(skillFileTrees, n)
        ? skillFileTrees[n]["SKILL.md"]
        : null;
      return mentionRe.test(stripFrontmatter(own ?? skillBody));
    })
    .map((n) => ({ name: n, count: 1 }));
  const skills = [...scanned, { name: `${from}/references/notes.md`, count: 1 }];

  const managedExternal = Object.entries(registry.skills).find(
    ([, s]) => s.managed === "external" || s.managed === "starter",
  );
  const skipped: RenamePlan["skipped"] = [];
  if (managedExternal) {
    skipped.push({ kind: "skill", name: managedExternal[0], reason: "source-managed", count: 2 });
  }
  skipped.push({ kind: "agent_doc", name: "moon-base/docs/AGENTS.md", reason: "snippet-owned", count: 1 });

  const snippets =
    from === "android-conventions" || to === "android-conventions"
      ? []
      : [{ name: "android-conventions", count: 1 }];
  const agentDocs = [RENAME_AGENT_DOC];

  const libraryRefs = [...skills, ...snippets].reduce((n, r) => n + r.count, 0);
  const agentDocRefs = agentDocs.reduce((n, r) => n + r.count, 0);

  return {
    dry_run: true,
    old: from,
    new: to,
    referrers: { skills, snippets, agent_docs: agentDocs },
    skipped,
    totals: {
      skills: skills.length,
      snippets: snippets.length,
      agent_docs: agentDocs.length,
      projects: 1,
      library_refs: libraryRefs,
      agent_doc_refs: agentDocRefs,
      refs: libraryRefs + agentDocRefs,
      skipped: skipped.reduce((n, s) => n + s.count, 0),
      files: skills.length + snippets.length + agentDocs.length,
    },
  };
}

/** The backend's `normalize_skill_rel` in miniature — anything that is not a
 *  plain POSIX relative path is refused with `outside:`. */
function skillFileRelEscapes(rel: string): boolean {
  const trimmed = rel.trim();
  if (!trimmed || trimmed.includes("\\") || trimmed.startsWith("/")) return true;
  return trimmed.split("/").some((p) => p === "" || p === "." || p === "..");
}

/** Mirrors the backend's registry gates: an MCP entry has no file tree, and a
 *  source-managed skill refuses every write. */
function skillFilesGate(name: string, write: boolean): Promise<never> | null {
  // (F2) The blanket `mcp-server` refusal is gone — the `skill_files_list`
  // case below special-cases the LISTING for an mcp-server with no
  // folder/only SKILL.md (an empty list, never an error) instead of this
  // shared gate refusing every mcp-server outright.
  const managed = registry.skills[name]?.managed;
  if (write && (managed === "external" || managed === "starter")) {
    return skillFilesReject(`read_only: ${name} is managed by its source`);
  }
  return null;
}

// ─── Permissions ──────────────────────────────────────────────────────────────

const permissionsGlobal = {
  allow: [
    { pattern: "Bash(npm:*)", kind: "allow", harnesses: null, origin: "global" },
    { pattern: "Bash(git status:*)", kind: "allow", harnesses: null, origin: "global" },
    {
      pattern:
        "Bash(./gradlew assembleDebug installDebug --stacktrace --warning-mode all:*)",
      kind: "allow",
      harnesses: ["claude-code", "codex"],
      origin: "global",
    },
    { pattern: "Read(//Users/dev/**)", kind: "allow", harnesses: null, origin: "global" },
  ],
  deny: [
    { pattern: "Bash(rm -rf:*)", kind: "deny", harnesses: null, origin: "global" },
    { pattern: "Bash(curl:*)", kind: "deny", harnesses: null, origin: "global" },
    {
      pattern: "Read(//Users/dev/.ssh/**)",
      kind: "deny",
      harnesses: null,
      origin: "global",
    },
  ],
  ask: [
    { pattern: "Bash(git push:*)", kind: "ask", harnesses: null, origin: "global" },
    {
      pattern: "Bash(gh pr create --title --body --draft:*)",
      kind: "ask",
      harnesses: ["claude-code"],
      origin: "global",
    },
  ],
  hooks: [
    {
      event: "PreToolUse",
      matcher: "Bash",
      command: "~/.skill-hub/hooks/audit-bash.sh",
      harnesses: null,
      origin: "global",
    },
    {
      event: "PostToolUse",
      matcher: "Edit",
      command: "prettier --write $FILE",
      harnesses: ["claude-code"],
      origin: "global",
    },
  ],
  sandbox_mode: "workspace-write",
  approval_policy: "on-failure",
  project_trust: null as boolean | null,
  additional_dirs: ["/Users/dev/shared", "/Users/dev/.config/skill-hub"],
  extras: {},
  _unmanaged: [] as string[],
  adoption_required: null,
};

/** Per-project `permissions_show` twin of `registry.projects[n].permissions`
 *  (M7): the project's OWN rules only, never the merged effective view. Keyed
 *  by project name; a project absent here falls back to an empty block. */
type MockProjectPermissions = typeof permissionsGlobal & {
  worktree_access?: { enabled: boolean; path: string };
};

const permissionsProject: Record<string, MockProjectPermissions> = {
  "skill-hub": {
    allow: [{ pattern: "Bash(cargo:*)", kind: "allow", harnesses: null, origin: "project" }],
    deny: [],
    ask: [],
    hooks: [],
    sandbox_mode: "",
    approval_policy: "",
    project_trust: true,
    additional_dirs: [],
    extras: {},
    _unmanaged: [],
    adoption_required: null,
    worktree_access: { enabled: false, path: "" },
  },
};
// The uncommitted project tier is separate state, matching Claude's
// permissions_local block.  Keep it independent so a save/reopen journey can
// prove that Personal did not leak into Shared.
const permissionsPersonal: Record<string, MockProjectPermissions> = {};
const worktreeFailureProjects = new Set<string>();

const emptyProjectPermissions = {
  allow: [],
  deny: [],
  ask: [],
  hooks: [],
  sandbox_mode: "",
  approval_policy: "",
  project_trust: null,
  additional_dirs: [],
  extras: {},
  _unmanaged: [],
  worktree_access: { enabled: false, path: "" },
} as const;

/** A ships_with rule provisioned with `--with-companions` (D4) is also a real
 *  project-scope permission rule (A12: "shipped rules land where the project
 *  block lands today") — so `permissions_show` for that project must return
 *  it too, or the Permissions screen has no row to hang a `via <skill>` tag
 *  on. Returns (and lazily creates) `permissionsProject[projectName]`, a
 *  plain mutable object distinct from the frozen `emptyProjectPermissions`
 *  fallback. */
function ensureProjectPermissions(projectName: string): MockProjectPermissions {
  if (!permissionsProject[projectName]) {
    permissionsProject[projectName] = {
      allow: [],
      deny: [],
      ask: [],
      hooks: [],
      sandbox_mode: "",
      approval_policy: "",
      project_trust: null,
      additional_dirs: [],
      extras: {},
      _unmanaged: [],
      adoption_required: null,
    };
  }
  return permissionsProject[projectName];
}

function ensurePersonalPermissions(projectName: string): MockProjectPermissions {
  if (!permissionsPersonal[projectName]) {
    permissionsPersonal[projectName] = {
      allow: [], deny: [], ask: [], hooks: [], sandbox_mode: "", approval_policy: "",
      project_trust: null, additional_dirs: [], extras: {}, _unmanaged: [], adoption_required: null,
    };
  }
  return permissionsPersonal[projectName];
}

function persistPermissionPayload(target: MockProjectPermissions | typeof permissionsGlobal, payload: Record<string, unknown>, origin: "global" | "project"): void {
  const mutable = target as unknown as Record<string, unknown>;
  for (const kind of ["allow", "deny", "ask"] as const) {
    if (Array.isArray(payload[kind])) {
      mutable[kind] = (payload[kind] as Array<Record<string, unknown>>).map((rule) => ({
        pattern: String(rule.pattern ?? ""), kind, harnesses: (rule.harnesses as string[] | null | undefined) ?? null, origin,
      }));
    }
  }
  if (Array.isArray(payload.hooks)) mutable.hooks = payload.hooks;
  for (const key of ["sandbox_mode", "approval_policy", "project_trust", "additional_dirs", "extras", "_unmanaged"] as const) {
    if (key in payload) (target as Record<string, unknown>)[key] = payload[key];
  }
}

/** Adds one shipped rule to a project's `permissions_show` twin, deduped on
 *  `pattern` (idempotent across re-equips). Written per-branch (never a
 *  union-keyed `pp[kind] = …`) so each property keeps its own literal type. */
function addProjectPermissionRule(
  pp: ReturnType<typeof ensureProjectPermissions>,
  key: RuleKey,
): void {
  const entry = { pattern: key.pattern, kind: key.kind, harnesses: null, origin: "project" as const };
  if (key.kind === "allow") {
    if (!pp.allow.some((r) => r.pattern === key.pattern)) pp.allow = [...pp.allow, entry];
  } else if (key.kind === "deny") {
    if (!pp.deny.some((r) => r.pattern === key.pattern)) pp.deny = [...pp.deny, entry];
  } else {
    if (!pp.ask.some((r) => r.pattern === key.pattern)) pp.ask = [...pp.ask, entry];
  }
}

/** The inverse of `addProjectPermissionRule`, run on `hub disable` when a
 *  companion's ledger entry is actually dropped. */
function removeProjectPermissionRule(
  pp: ReturnType<typeof ensureProjectPermissions>,
  key: RuleKey,
): void {
  if (key.kind === "allow") pp.allow = pp.allow.filter((r) => r.pattern !== key.pattern);
  else if (key.kind === "deny") pp.deny = pp.deny.filter((r) => r.pattern !== key.pattern);
  else pp.ask = pp.ask.filter((r) => r.pattern !== key.pattern);
}

const permissionsCapabilities = {
  "claude-code": [
    "tool_allowlist",
    "tool_denylist",
    "tool_ask",
    "hooks",
    "additional_directories",
  ],
  pi: ["tool_allowlist", "tool_denylist", "tool_ask", "hooks"],
  codex: [
    "tool_allowlist",
    "tool_denylist",
    "tool_ask",
    "sandbox_mode",
    "approval_policy",
    "project_trust",
  ],
  opencode: ["tool_allowlist", "tool_denylist", "tool_ask"],
};

const permissionsDoctor = {
  findings: [
    {
      code: "broad-bash-allow",
      severity: "warning",
      explanation: "A broad Bash allow rule grants wide command execution.",
      detail: "Bash(npm:*) allows any npm subcommand without confirmation.",
      scope_kind: "global",
      scope_label: "Global",
      harness_id: "claude-code",
    },
    {
      code: "project-trust-activated",
      severity: "danger",
      explanation:
        "Writing project command rules auto-granted trust_level=trusted, which also activates committed config + project-local hooks.",
      detail: "example-app: .codex/config.toml + project hooks now execute.",
      scope_kind: "project",
      scope_label: "example-app",
      harness_id: "codex",
    },
  ],
  danger_count: 1,
};

const permissionsRisksSchema = [
  {
    code: "broad-bash-allow",
    severity: "warning",
    explanation: "A broad Bash allow rule grants wide command execution.",
  },
  {
    code: "deny-shadowed",
    severity: "warning",
    explanation: "A deny rule is shadowed by an earlier allow and never fires.",
  },
  {
    code: "project-trust-activated",
    severity: "danger",
    explanation:
      "Project trust was auto-granted, activating committed config and hooks.",
  },
  {
    code: "rm-rf-allowed",
    severity: "danger",
    explanation: "A destructive `rm -rf` invocation is allowed without prompt.",
  },
];

// ─── Search corpus ───────────────────────────────────────────────────────────
// Bodies behind `read_search_corpus` — the Library's content search. Three
// marker words appear in exactly one or two BODIES and in NO name,
// description, or tag anywhere in this mock (nor in a comment in this file —
// a grep match there would be a false "it's covered" read): `quorum`
// (brainstorm + the android-conventions snippet), `lighthouse` (code-review +
// the review-checklist snippet), and `derivedStateOf` — a single-hit word
// confined to one skill-only body (rt-android-expert). That is what lets a
// screenshot and an e2e test prove a BODY-only match end to end. Every other
// skill/snippet gets a short, unrelated body so no row looks bodiless in the
// preview — and none of them contain the substrings the existing
// "andr"/"conventions" e2e negatives depend on staying negative (see
// library-search.journey.spec.ts).
const searchCorpus: { skills: Record<string, string>; snippets: Record<string, string> } = {
  skills: {
    // Keep this corpus body distinct so library-search negatives remain meaningful.
    brainstorm:
      "## Rounds\n\nEach expert argues, then the panel converges. A round " +
      "closes when a quorum of agents agrees on the framing.\n",
    "rt-android-expert":
      "## State\n\nHoist state to the lowest common owner. Prefer " +
      "derivedStateOf over recomputing inside the composable body. Run " +
      "`code-review` after any Compose change, and again before opening " +
      "a pull request. For a wider discussion, try /brainstorm. A " +
      "shared `needs-global` helper covers cross-project constants. " +
      "Keep the `ViewModel` boundary thin; background lives in " +
      "references/plan-file.md.\n",
    "android-jetpack-compose-material3-theming-helper":
      "## Rows\n\nStress-tests row truncation and sidebar wrapping at " +
      "narrow widths.\n",
    "fs-mcp":
      "## Tools\n\nExposes read, write, and list operations over stdio " +
      "for the sandboxed workspace root.\n",
    "android-compose-ui":
      "## Patterns\n\nShared UI patterns for a design pack: buttons, " +
      "spacing, and elevation tokens. See /rt-android-expert for the " +
      "underlying architecture guidance.\n",
    "openspec-apply":
      "## Tasks\n\nWork through a change's task list top to bottom, " +
      "checking each box before moving on.\n",
    "code-review":
      "## Passes\n\nCorrectness first, then reuse. A lighthouse pass " +
      "flags any risky retry path that writes twice.\n",
    "deep-research":
      "## Fan-out\n\nRun parallel web searches, fetch sources, and cite " +
      "every claim in the final report.\n",
    "git-committer-mcp":
      "## Clustering\n\nGroups related file changes into separate " +
      "commits by domain, not by timestamp.\n",
    "ds-tokens-mcp":
      "## Tokens\n\nExposes the design-system's color, spacing, and " +
      "radius tokens as callable tools.\n",
    "needs-global":
      "## Scope\n\nA registry skill that has not yet been made " +
      "available to every agent.\n",
    "remote-note":
      "## Origin\n\nImported from a remote box; provisioning here is " +
      "refused until it is reviewed.\n",
    "codex-only":
      "## Harness\n\nNarrowed to one harness; widen the affinity before " +
      "attaching it elsewhere.\n",
  },
  snippets: {
    "android-conventions": "State is hoisted; every screen owns one quorum of truth.\n",
    "commit-message-format": "Subject line under 72 chars. Body explains why.\n",
    "review-checklist": "Check the risky paths and the escape routes with a lighthouse pass.\n",
    "orphaned-note": "Left behind after a refactor.\n",
  },
};

// ─── Snippets ──────────────────────────────────────────────────────────────────

// Mirrors `snippets.py`'s NAME_RE — the real CLI's own kebab-case gate.
const SNIPPET_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const snippetsList = [
  {
    name: "android-conventions",
    description: "Project conventions for Android/Compose state management.",
    tags: ["android", "compose", "state"],
    version: 3,
    created: "2026-05-01T10:00:00Z",
    updated: "2026-06-18T14:20:00Z",
    hash: "a1b2c3d4",
    // Must agree with `snippetShow.usage` (16 total, 7 outdated) — see there.
    usage: {
      count: 16,
      summary: "outdated",
      outdated_count: 7,
      locations: [],
    },
  },
  {
    name: "commit-message-format",
    description:
      "Conventional-commit message format with emoji prefixes and a co-author trailer used across every repository in the org.",
    tags: ["git", "conventions"],
    version: 1,
    created: "2026-04-12T09:00:00Z",
    updated: "2026-04-12T09:00:00Z",
    hash: "ee99ff00",
    usage: { count: 2, summary: "applied", outdated_count: 0, locations: [] },
  },
  {
    name: "review-checklist",
    description: "Pre-merge review checklist for correctness and UX.",
    tags: ["review", "quality"],
    version: 2,
    created: "2026-03-20T08:00:00Z",
    updated: "2026-06-01T11:00:00Z",
    hash: "55aa66bb",
    usage: { count: 1, summary: "modified", outdated_count: 0, locations: [] },
  },
  {
    name: "orphaned-note",
    description: "A snippet whose blocks were detached from the library.",
    tags: ["misc"],
    version: 1,
    created: "2026-02-01T08:00:00Z",
    updated: "2026-02-01T08:00:00Z",
    hash: "deadbeef",
    usage: { count: 1, summary: "orphaned", outdated_count: 0, locations: [] },
  },
];

const snippetShow = {
  name: "android-conventions",
  description: "Project conventions for Android/Compose state management.",
  tags: ["android", "compose", "state"],
  version: 3,
  created: "2026-05-01T10:00:00Z",
  updated: "2026-06-18T14:20:00Z",
  hash: "a1b2c3d4",
  body: `## Project conventions (managed snippet)

Always use \`StateFlow\` for screen state and **never** expose \`MutableStateFlow\`.
Prefer \`collectAsStateWithLifecycle()\` in Composables.

- One ViewModel per screen.
- Side effects go through a sealed \`Action\` type.
- Navigation is owned by the caller, not the screen.

Run \`code-review\` on the diff before this snippet ships anywhere.`,
  usage: {
    // 16 total (9 applied + 7 outdated) — the header's "N applied · N
    // outdated" tags and the side panel's Applied-to list read the same
    // object, so the two must agree. The original four are UNCHANGED
    // (kept so any test pinned to them still holds); the 12 more, all
    // nested under "example-app", reproduce the real complaint this dense
    // fixture exists for — many same-basename `AGENTS.md` blocks in one
    // project, past `FILTER_THRESHOLD`, distinguishable only by the
    // relative path a `PathText` row now shows.
    count: 16,
    summary: "outdated",
    outdated_count: 7,
    locations: [
      { project: "example-app", rel: "CLAUDE.md", path: "/Users/dev/projects/example-app/CLAUDE.md", snippet: "android-conventions", version: "3", applied_sha: "a1b2c3d4", status: "applied" },
      { project: "example-app", rel: "AGENTS.md", path: "/Users/dev/projects/example-app/AGENTS.md", snippet: "android-conventions", version: "3", applied_sha: "a1b2c3d4", status: "applied" },
      { project: "moon-base", rel: "AGENTS.md", path: "/Users/dev/projects/moon-base-android-client/AGENTS.md", snippet: "android-conventions", version: "2", applied_sha: "99887766", status: "outdated" },
      { project: "skill-hub", rel: "AGENTS.md", path: "/Users/dev/Dev/.skill-hub/AGENTS.md", snippet: "android-conventions", version: "2", applied_sha: "99887766", status: "outdated" },
      // ── Dense scenario: example-app, 12 nested AGENTS.md blocks ──
      { project: "example-app", rel: "apps/mobile/AGENTS.md", path: "/Users/dev/projects/example-app/apps/mobile/AGENTS.md", snippet: "android-conventions", version: "3", applied_sha: "a1b2c3d4", status: "applied" },
      { project: "example-app", rel: "apps/mobile/ios/AGENTS.md", path: "/Users/dev/projects/example-app/apps/mobile/ios/AGENTS.md", snippet: "android-conventions", version: "2", applied_sha: "99887766", status: "outdated" },
      { project: "example-app", rel: "apps/mobile/android/AGENTS.md", path: "/Users/dev/projects/example-app/apps/mobile/android/AGENTS.md", snippet: "android-conventions", version: "3", applied_sha: "a1b2c3d4", status: "applied" },
      { project: "example-app", rel: "apps/web/AGENTS.md", path: "/Users/dev/projects/example-app/apps/web/AGENTS.md", snippet: "android-conventions", version: "3", applied_sha: "a1b2c3d4", status: "applied" },
      { project: "example-app", rel: "apps/web/admin/AGENTS.md", path: "/Users/dev/projects/example-app/apps/web/admin/AGENTS.md", snippet: "android-conventions", version: "1", applied_sha: "77665544", status: "outdated" },
      { project: "example-app", rel: "packages/ui/AGENTS.md", path: "/Users/dev/projects/example-app/packages/ui/AGENTS.md", snippet: "android-conventions", version: "3", applied_sha: "a1b2c3d4", status: "applied" },
      { project: "example-app", rel: "packages/core/AGENTS.md", path: "/Users/dev/projects/example-app/packages/core/AGENTS.md", snippet: "android-conventions", version: "2", applied_sha: "99887766", status: "outdated" },
      { project: "example-app", rel: "packages/utils/AGENTS.md", path: "/Users/dev/projects/example-app/packages/utils/AGENTS.md", snippet: "android-conventions", version: "3", applied_sha: "a1b2c3d4", status: "applied" },
      { project: "example-app", rel: "services/api/AGENTS.md", path: "/Users/dev/projects/example-app/services/api/AGENTS.md", snippet: "android-conventions", version: "3", applied_sha: "a1b2c3d4", status: "applied" },
      { project: "example-app", rel: "services/worker/AGENTS.md", path: "/Users/dev/projects/example-app/services/worker/AGENTS.md", snippet: "android-conventions", version: "1", applied_sha: "77665544", status: "outdated" },
      { project: "example-app", rel: "tools/scripts/AGENTS.md", path: "/Users/dev/projects/example-app/tools/scripts/AGENTS.md", snippet: "android-conventions", version: "3", applied_sha: "a1b2c3d4", status: "applied" },
      { project: "example-app", rel: "docs/guides/AGENTS.md", path: "/Users/dev/projects/example-app/docs/guides/AGENTS.md", snippet: "android-conventions", version: "2", applied_sha: "99887766", status: "outdated" },
    ],
  },
};

/** `--no-usage` contract: strip the `usage` key without a discard-rename
 *  destructure (that trips `no-unused-vars` under this repo's lint config). */
function dropUsage<T extends { usage?: unknown }>(row: T): Omit<T, "usage"> {
  const copy: Partial<T> = { ...row };
  delete copy.usage;
  return copy as Omit<T, "usage">;
}

const snippetStatus = {
  locations: [
    {
      project: "example-app",
      rel: "CLAUDE.md",
      path: "/Users/dev/projects/example-app/CLAUDE.md",
      snippet: "android-conventions",
      version: "3",
      applied_sha: "a1b2c3d4",
      status: "applied",
    },
    {
      project: "moon-base",
      rel: "AGENTS.md",
      path: "/Users/dev/projects/moon-base-android-client/AGENTS.md",
      snippet: "android-conventions",
      version: "2",
      applied_sha: "99887766",
      status: "outdated",
    },
    {
      project: "skill-hub",
      rel: "docs/CONTRIBUTING.md",
      path: "/Users/dev/Dev/.skill-hub/docs/CONTRIBUTING.md",
      snippet: "review-checklist",
      version: "2",
      applied_sha: "55aa66bb",
      status: "modified",
    },
    {
      project: "example-app",
      rel: "AGENTS.md",
      path: "/Users/dev/projects/example-app/AGENTS.md",
      snippet: "orphaned-note",
      version: "1",
      applied_sha: "deadbeef",
      status: "orphaned",
    },
  ],
  damaged: [
    {
      project: "moon-base",
      rel: "CLAUDE.md",
      kind: "unpaired-start",
      name: "commit-message-format",
      line: 42,
    },
  ],
};

/** `?contextAttention=1` — one helper so `snippets_list`, `snippet_show` and
 *  `snippet_status` can never disagree about `orphaned-note`'s state: it reads
 *  as OUTDATED (not orphaned) so the Context group's attention plaque has a
 *  real "N snippets outdated" line with a real destination. */
const ORPHANED_NOTE_OUTDATED_USAGE = {
  count: 1,
  summary: "outdated",
  outdated_count: 1,
  locations: [],
};

function snippetsListForScene() {
  if (sceneFlag("navSearch")) return [
    ...snippetsList,
    ...Array.from({ length: 9 }, (_, i) => ({ ...snippetsList[0], name: `search-snippet-${i + 1}` })),
  ];
  if (!sceneFlag("contextAttention")) return snippetsList;
  return snippetsList.map((s) =>
    s.name === "orphaned-note" ? { ...s, usage: ORPHANED_NOTE_OUTDATED_USAGE } : s,
  );
}

function snippetShowForScene(name: string | undefined) {
  if (sceneFlag("contextAttention") && name === "orphaned-note") {
    return {
      name: "orphaned-note",
      description: "A snippet whose blocks were detached from the library.",
      tags: ["misc"],
      version: 1,
      created: "2026-02-01T08:00:00Z",
      updated: "2026-02-01T08:00:00Z",
      hash: "deadbeef",
      body: "A snippet whose blocks were detached from the library.",
      usage: ORPHANED_NOTE_OUTDATED_USAGE,
    };
  }
  return snippetShow;
}

function snippetStatusForScene() {
  if (!sceneFlag("contextAttention")) return snippetStatus;
  return {
    ...snippetStatus,
    locations: snippetStatus.locations.map((loc) =>
      loc.snippet === "orphaned-note" ? { ...loc, status: "outdated" } : loc,
    ),
  };
}

// ─── Remotes ──────────────────────────────────────────────────────────────────

const remoteList = [
  {
    id: "hermes-main",
    connector: "hermes",
    sync_enabled: true,
    apply_global_bundles: false,
    ssh_host: "hermes@moon-base",
    bundles: ["openspec"],
    enabled: ["brainstorm", "deep-research"],
  },
  {
    id: "worker-pool",
    connector: "hermes",
    sync_enabled: false,
    apply_global_bundles: false,
    ssh_host: "hermes@worker-01",
    bundles: [],
    enabled: ["code-review"],
  },
];

// Live connector catalog (hub remote connectors --json). Hermes is the built-in
// SSH reference; the https "workers" entry exercises the transport-aware wizard
// branch (endpoint + token step, no host-key steps). An unknown-transport entry
// exercises the CLI-only disabled card.
const remoteConnectorsCatalog = [
  { key: "headless-loadouts", label: "Headless machine", description: "Follow project loadouts in confirmed checkouts.",
    transport_kind: "ssh", deployment_kind: "project-loadouts", publishable: true, available: true, source: "builtin" },
  {
    key: "hermes",
    label: "Hermes",
    description:
      "A self-improving agent box over SSH. Pushes skills, MCP servers, and SOUL/MEMORY/USER docs to a hub-owned dir.",
    transport_kind: "ssh",
    publishable: true,
    available: true,
    source: "builtin",
  },
  {
    key: "workers",
    label: "Worker Pool",
    description:
      "An HTTPS control-plane worker pool. Registers skills against an endpoint with a bearer token.",
    transport_kind: "https",
    publishable: true,
    available: true,
    source: "entry-point",
  },
  {
    key: "socketpool",
    label: "Socket Pool",
    description: "A local-socket worker pool with a transport the wizard cannot onboard.",
    transport_kind: "unix-socket",
    publishable: false,
    available: true,
    source: "drop-in",
  },
];

const remoteShow = {
  id: "hermes-main",
  connector: "hermes",
  ssh_host: "hermes@moon-base",
  host_key_pinned: true,
  secret_ref: "skill-hub:hermes-main",
  home: "~/.hermes",
  sync_enabled: true,
  apply_global_bundles: false,
  bundles: ["openspec"],
  enabled: ["brainstorm", "deep-research"],
  resolved_skills: ["brainstorm", "deep-research", "openspec-apply", "code-review"],
};

// A drift plan exercising every status so the surface renders fully.
const remoteDiff = {
  remote: "hermes-main",
  actions: [
    { name: "brainstorm", kind: "skill", action: "noop", drift: "in-sync" },
    { name: "deep-research", kind: "skill", action: "fast_forward", drift: "local-ahead" },
    { name: "code-review", kind: "skill", action: "SKIP_remote_drifted", drift: "remote-drifted" },
    { name: "openspec-apply", kind: "skill", action: "SKIP_conflict", drift: "conflict" },
    { name: "old-helper", kind: "skill", action: "remove", drift: "orphaned" },
    { name: "fs-mcp", kind: "mcp", action: "fast_forward", drift: "local-ahead" },
    { name: "MEMORY.md", kind: "agent_doc", action: "SKIP_remote_drifted", drift: "remote-drifted" },
    { name: "SOUL.md", kind: "agent_doc", action: "noop", drift: "in-sync" },
    { name: "USER.md", kind: "agent_doc", action: "create", drift: null },
  ],
};

// ─── Project-local skill candidates (local_skill_candidates) ─────────────────
// Mutable so an adopt removes the entry within a session.
let localCandidatesData: Array<{
  name: string;
  project: string;
  path: string;
  category: "NEW" | "INVALID_NAME";
  description?: string;
  reason?: string | null;
}> = [
  {
    name: "hand-authored-linter",
    project: "example-app",
    path: "/Users/dev/projects/example-app/.claude/skills/hand-authored-linter",
    category: "NEW",
    description: "A skill authored directly in the project by Claude Code.",
  },
  {
    name: "Bad Name",
    project: "moon-base",
    path: "/Users/dev/projects/moon-base-android-client/.claude/skills/Bad Name",
    category: "INVALID_NAME",
    reason: "Folder name 'Bad Name' is not a valid skill slug.",
  },
];

// ─── Detected MCP servers (`hub mcp reconcile`, E2 design D5) ────────────────
// Mutable so Adopt/Keep native remove the entry within a session; `mcpKept`
// tracks names parked by `keep` so the payload's `kept` array (F3(d)) reflects
// it and a re-query never shows a kept row again.
type MockMcpScope = "user" | "local" | "project" | "global";
interface MockMcpCandidateSource {
  harness: string;
  file: string;
  scope: MockMcpScope;
  /** The native key VERBATIM (pre-slugify) — E3 rev 2 §2.2/§4. */
  name: string;
  native: Record<string, unknown>;
}
interface MockMcpCandidateOption {
  /** `"registry"` (F5) names no real harness — `scope`/`file` both `null`. */
  harness: string;
  scope: MockMcpScope | null;
  file: string | null;
  spec: Record<string, unknown>;
}
interface MockMcpCandidate {
  name: string;
  status: "new" | "conflict" | "already_managed" | "unsupported" | "stale";
  spec: Record<string, unknown> | null;
  sources: MockMcpCandidateSource[];
  options: MockMcpCandidateOption[];
  reason: string | null;
  warnings: string[];
  /** `null` only for `unsupported/invalid_name` (E3 rev 2 §2.2). */
  import_name: string | null;
}

let mcpCandidatesData: MockMcpCandidate[] = [
  {
    name: "weather-api",
    status: "new",
    spec: { transport: "http", url: "https://weather.example.com/mcp" },
    sources: [
      {
        harness: "claude-code",
        file: "~/.claude.json",
        scope: "user",
        name: "weather-api",
        native: { type: "http", url: "https://weather.example.com/mcp" },
      },
    ],
    options: [],
    reason: null,
    warnings: [],
    import_name: "weather-api",
  },
  {
    name: "linear-mcp",
    status: "new",
    // N7: the real CLI never emits a literal secret value ANYWHERE in a
    // discovery payload — `_redact_copy` masks it to `"<redacted>"` before
    // `spec`/`sources[].native` are ever built (`mcp_reconcile._row`'s "new"
    // branch runs `redacted_spec = _redact_copy(...)`). A frontend fixture
    // that ships the plaintext value instead can only prove the sheet's OWN
    // defensive redaction, never the fidelity of the wire contract.
    spec: {
      transport: "http",
      url: "https://mcp.linear.app/sse",
      headers: { Authorization: "<redacted>" },
    },
    sources: [
      {
        harness: "claude-code",
        file: "~/.claude.json",
        scope: "user",
        name: "linear-mcp",
        native: { type: "http", url: "https://mcp.linear.app/sse", headers: { Authorization: "<redacted>" } },
      },
      {
        // N6: Codex has no "user" scope — its config discovers as "global"
        // (grill finding 5); this fixture used to disagree with context7's.
        harness: "codex",
        file: "~/.codex/config.toml",
        scope: "global",
        name: "linear-mcp",
        native: { url: "https://mcp.linear.app/sse" },
      },
    ],
    options: [],
    reason: null,
    warnings: ["literal_secret:Authorization"],
    import_name: "linear-mcp",
  },
  {
    // E3 rev 2 grill finding 5: Codex user-level config discovers as
    // "global" (INTERFACES §3), not "user" — this option's scope is the
    // fixture the compare-sheet visual scene proves the label against.
    name: "context7",
    status: "conflict",
    spec: null,
    sources: [
      { harness: "claude-code", file: "~/.claude.json", scope: "user", name: "context7", native: {} },
      { harness: "codex", file: "~/.codex/config.toml", scope: "global", name: "context7", native: {} },
    ],
    options: [
      {
        harness: "claude-code",
        scope: "user",
        file: "~/.claude.json",
        spec: { transport: "http", url: "https://mcp.context7.com/mcp" },
      },
      {
        harness: "codex",
        scope: "global",
        file: "~/.codex/config.toml",
        spec: { transport: "http", url: "https://mcp.context7.com/v2/mcp" },
      },
    ],
    reason: null,
    warnings: [],
    import_name: "context7",
  },
  {
    name: "figma-mcp",
    status: "unsupported",
    spec: null,
    sources: [],
    options: [],
    reason: "oauth_block",
    warnings: [],
    import_name: "figma-mcp",
  },
  {
    name: "browser-tools",
    status: "unsupported",
    spec: null,
    sources: [],
    options: [],
    reason: "ws_transport",
    warnings: [],
    import_name: "browser-tools",
  },
];
let mcpKept: string[] = [];

/** The last `mcp check` row per server name, THIS page session only (reset on
 *  every `page.goto` — the mock module re-evaluates fresh). Lets `mcp show`'s
 *  `last_probe` reflect a check that already ran, which
 *  `McpCapabilitiesBlock` (unlike `McpDeliveryBlock`) depends on entirely —
 *  it never reads the live `qk.mcpProbe` query, only `qk.mcpShow`
 *  (plans/G.md §6.4). */
const mcpLastProbeByName = new Map<string, Record<string, unknown>>();

// E3 rev 2 §3 — additional fixtures kept OUT of `mcpCandidatesData` so the
// two pre-existing scenes (`?mcpCandidates=1`/`?mcpConflict=1`) render the
// SAME rows they always have ("keep every existing scene's frame stable").
// Reachable via the new `?mcpLiteral=1` scene flag (the compare-literal
// frame) and by name from the apply arm below, regardless of which flag is
// active — a decision naming "sanity" resolves the same way either way.
let mcpExtraCandidatesData: MockMcpCandidate[] = [
  // The Sanity rename (grill 1/2/10/11) — a single native source under the
  // RAW key "Sanity", registering as "sanity".
  {
    name: "sanity",
    status: "new",
    spec: { command: "npx" },
    sources: [
      { harness: "claude-code", file: "~/.claude.json", scope: "user", name: "Sanity", native: { command: "npx" } },
    ],
    options: [],
    reason: null,
    warnings: ["renamed_from:Sanity"],
    import_name: "sanity",
  },
  // A literal CONFLICT — the url.userinfo case (E3 rev 2 §2.7): only
  // "Adopt anyway" is offered, never "Adopt as ${VAR}". Backs the new
  // `library-detected-mcp-compare-literal` scene.
  {
    name: "creds-mcp",
    status: "conflict",
    spec: null,
    sources: [
      {
        harness: "claude-code",
        file: "~/.claude.json",
        scope: "user",
        name: "creds-mcp",
        // N7: the real CLI strips URL userinfo from BOTH `sources[].native`
        // and `options[].spec` before this ever reaches the wire
        // (`mcp_reconcile._redact_url`/`_redact_copy`) — after redaction this
        // is byte-identical to the codex copy below, which is exactly the
        // W1 scenario (two cards that differ only in a credential).
        native: { url: "https://mcp.example.com" },
      },
      {
        harness: "codex",
        file: "~/.codex/config.toml",
        scope: "global",
        name: "creds-mcp",
        native: { url: "https://mcp.example.com" },
      },
    ],
    options: [
      {
        harness: "claude-code",
        scope: "user",
        file: "~/.claude.json",
        spec: { transport: "http", url: "https://mcp.example.com" },
      },
      {
        harness: "codex",
        scope: "global",
        file: "~/.codex/config.toml",
        spec: { transport: "http", url: "https://mcp.example.com" },
      },
    ],
    reason: null,
    warnings: ["literal_secret:url.userinfo"],
    import_name: "creds-mcp",
  },
  // The F5 unclaimed-native-entry pseudo-option: the registry's own record
  // is one of the conflict's "options", labelled "Skill Tree's own record".
  {
    name: "docs-search",
    status: "conflict",
    spec: null,
    sources: [
      { harness: "claude-code", file: "~/.claude.json", scope: "user", name: "docs-search", native: {} },
    ],
    options: [
      {
        harness: "claude-code",
        scope: "user",
        file: "~/.claude.json",
        spec: { transport: "http", url: "https://docs.example.com/mcp" },
      },
      {
        harness: "registry",
        scope: null,
        file: null,
        spec: { transport: "http", url: "https://docs.example.com/v2/mcp" },
      },
    ],
    reason: null,
    warnings: ["unclaimed_native_entry"],
    import_name: "docs-search",
  },
  // A plain repair warning rendered as a dim line under the row (E3 rev 2 §2.6).
  {
    name: "shell-tool",
    status: "new",
    spec: { command: "npx run-it" },
    sources: [
      { harness: "claude-code", file: "~/.claude.json", scope: "user", name: "shell-tool", native: { command: "npx run-it" } },
    ],
    options: [],
    reason: null,
    warnings: ["command_has_arguments"],
    import_name: "shell-tool",
  },
  // A name_taken row — folded into the "stay native" disclosure, no Adopt
  // button anywhere (E3 rev 2 §2.2/§2.6).
  {
    name: "unslop",
    status: "unsupported",
    spec: null,
    sources: [],
    options: [],
    reason: "name_taken:unslop",
    warnings: [],
    import_name: "unslop",
  },
];

// ─── MCP capability catalogue (`hub mcp catalog`, plans/G.md §6/§7, rev 3
// §11) ─────────────────────────────────────────────────────────────────────
// Types mirror `@/lib/mcpContract`'s `McpCatalog*`/`McpCatalogSummary` shapes
// (imported for compile-time drift protection); values are the mock's own —
// this module never imports `hub`'s Python output.

type MockCatalogParam = {
  name: string;
  type: string | null;
  required: boolean;
  description: string | null;
  enum: (string | number | boolean | null)[] | null;
  enum_truncated: boolean;
  default: string | number | boolean | null;
  items_type: string | null;
};

function mcpParam(p: Partial<MockCatalogParam> & { name: string }): MockCatalogParam {
  return {
    type: null,
    required: false,
    description: null,
    enum: null,
    enum_truncated: false,
    default: null,
    items_type: null,
    ...p,
  };
}

type MockCatalogAnnotations = {
  read_only: boolean | null;
  destructive: boolean | null;
  idempotent: boolean | null;
  open_world: boolean | null;
};

type MockCatalogTool = {
  name: string;
  title: string | null;
  description: string | null;
  parameters: MockCatalogParam[];
  schema_unreadable: boolean;
  parameters_truncated: boolean;
  annotations: MockCatalogAnnotations | null;
  output_parameters?: MockCatalogParam[];
  output_schema_present?: boolean;
  output_schema_unreadable?: boolean;
};

// Five named tools cover every corpus case the plan and rev 3 call out: a
// union type + a scalar `default: false` (`search_docs`), a `title` that
// differs from `name` + an enum (`get_page`), an array-of-object param +
// annotations with only `read_only` declared (`list_versions`), an
// unreadable schema (`resolve_ref`), and an `outputSchema` (`create_page`).
// `search_docs` deliberately declares NO annotations at all (`null`) — the
// "a tool with none" case for both annotations and `output_parameters`.
const MCP_NAMED_TOOLS: MockCatalogTool[] = [
  {
    name: "search_docs",
    title: null,
    description: "Full-text search across the server's indexed documentation.",
    parameters: [
      mcpParam({ name: "query", type: "string", required: true, description: "The search query text." }),
      // The falsy-trap default (§5.7): `false` must survive, not read as absent.
      mcpParam({ name: "case_sensitive", type: "boolean", default: false, description: "Match case exactly." }),
      mcpParam({
        name: "max_results",
        type: "integer|null",
        description: "Cap on returned hits; unlimited when omitted.",
      }),
    ],
    schema_unreadable: false,
    parameters_truncated: false,
    annotations: null,
  },
  {
    name: "get_page",
    title: "Get Page",
    description: "Fetch one documentation page by id.",
    parameters: [
      mcpParam({ name: "id", type: "string", required: true, description: "The page id." }),
      mcpParam({
        name: "format",
        type: "string",
        default: "markdown",
        enum: ["json", "markdown", "text"],
        description: "Output format.",
      }),
    ],
    schema_unreadable: false,
    parameters_truncated: false,
    annotations: { read_only: true, destructive: null, idempotent: null, open_world: null },
  },
  {
    name: "list_versions",
    title: null,
    description: "List every published version of a library.",
    parameters: [
      mcpParam({
        name: "filters",
        type: "array",
        items_type: "object",
        description: "Structured filters, one object per field.",
      }),
    ],
    schema_unreadable: false,
    parameters_truncated: false,
    annotations: null,
  },
  {
    name: "resolve_ref",
    title: null,
    description: "Resolve a short library reference to its canonical id.",
    parameters: [],
    schema_unreadable: true,
    parameters_truncated: false,
    annotations: null,
  },
  {
    name: "create_page",
    title: null,
    description: "Create a new documentation page.",
    parameters: [
      mcpParam({ name: "title", type: "string", required: true, description: "The page title." }),
      mcpParam({ name: "body", type: "string", required: true, description: "Page body, in markdown." }),
    ],
    schema_unreadable: false,
    parameters_truncated: false,
    annotations: { read_only: false, destructive: true, idempotent: null, open_world: null },
    output_parameters: [
      mcpParam({ name: "id", type: "string", required: true, description: "The new page's id." }),
      mcpParam({ name: "url", type: "string", description: "The page's canonical URL." }),
    ],
    output_schema_present: true,
    output_schema_unreadable: false,
  },
];

function mcpFillerTool(i: number): MockCatalogTool {
  return {
    name: `filler_tool_${i}`,
    title: null,
    description: `Filler tool #${i}, padding this fixture to a real ~44-tool server's size.`,
    parameters: [mcpParam({ name: "input", type: "string", required: true, description: "Input text." })],
    schema_unreadable: false,
    parameters_truncated: false,
    annotations: null,
  };
}

const MCP_ALL_TOOLS: MockCatalogTool[] = [
  ...MCP_NAMED_TOOLS,
  ...Array.from({ length: 44 - MCP_NAMED_TOOLS.length }, (_, i) => mcpFillerTool(i + 1)),
];

const MCP_RESOURCES = [
  { uri: "docs://readme", title: null, name: "README", description: "The project readme.", mime_type: "text/markdown" },
  {
    uri: "docs://changelog",
    title: null,
    name: "Changelog",
    description: "Release notes for every published version.",
    mime_type: "text/markdown",
  },
  {
    uri: "https://context7.com/openapi.json",
    title: null,
    name: "OpenAPI schema",
    description: "Machine-readable API schema.",
    mime_type: "application/json",
  },
];

// One template, its `{placeholders}` marked in the sheet's detail pane.
const MCP_TEMPLATES = [
  {
    uri_template: "docs://{library}/{version}",
    title: null,
    name: "Library docs",
    description: "Versioned documentation for a library.",
    mime_type: "text/markdown",
  },
];

const MCP_PROMPTS = [
  {
    name: "summarize_docs",
    title: null,
    description: "Summarize a documentation page.",
    arguments: [{ name: "uri", description: "The resource URI to summarize.", required: true }],
  },
  {
    name: "compare_versions",
    title: null,
    description: "Compare two library versions and describe what changed.",
    arguments: [
      { name: "from", description: "Starting version.", required: true },
      { name: "to", description: "Target version.", required: true },
      { name: "notes", description: "Extra notes to fold into the comparison.", required: false },
    ],
  },
];

const MCP_OFFERED_ALL = { tools: true, resources: true, resource_templates: true, prompts: true };

/** The BASE ("rich") catalogue — every kind offered and populated, no fetch
 *  faults. Backs the default `?`-less scenes (`skill-editor-mcp-capabilities`,
 *  `mcp-capability-sheet`, `mcp-capability-sheet-prompt`). */
const mcpCatalogRecordDefault = {
  schema_version: 1,
  transport: "http",
  protocol_version: "2025-06-18",
  server_name: "context7",
  server_title: "Context7 Docs",
  protocol_fallback: false,
  instructions: "Use search_docs to find a page, then get_page to fetch it in full.",
  capabilities: ["tools", "resources", "prompts"],
  offered: MCP_OFFERED_ALL,
  tools: MCP_ALL_TOOLS,
  resources: MCP_RESOURCES,
  resource_templates: MCP_TEMPLATES,
  prompts: MCP_PROMPTS,
  truncated: { tools: false, resources: false, resource_templates: false, prompts: false },
  bytes_truncated: false,
  fetch_errors: [] as { method: string; error: string }[],
};

const mcpCatalogSummaryDefault = {
  tools: MCP_ALL_TOOLS.length,
  resources: MCP_RESOURCES.length,
  resource_templates: MCP_TEMPLATES.length,
  prompts: MCP_PROMPTS.length,
  offered: MCP_OFFERED_ALL,
  unknown: [] as string[],
  server_name: "context7",
  server_version: "2.4.0",
  instructions: true,
  errors: 0,
};

/** `?mcpCatalogEmpty=1` — every kind offered, every count zero, no errors:
 *  §6.3 row 7, "This server answered but offers no tools, resources or
 *  prompts." */
const mcpCatalogRecordEmpty = {
  ...mcpCatalogRecordDefault,
  instructions: null,
  tools: [],
  resources: [],
  resource_templates: [],
  prompts: [],
  fetch_errors: [] as { method: string; error: string }[],
};
const mcpCatalogSummaryEmpty = {
  ...mcpCatalogSummaryDefault,
  tools: 0,
  resources: 0,
  resource_templates: 0,
  prompts: 0,
  instructions: false,
};

/** `?mcpCatalogErrors=1` — `resources/list` hit a REAL fault (not `-32601`,
 *  so it earns a `fetch_errors` entry and reads "resources: unknown", never
 *  a lying "0 resources"), while `resource_templates` is a genuine ABSENCE
 *  (`offered: false`, omitted from the counts line entirely) — the two rows
 *  §6.3/grill F12 are most often confused, exercised side by side. */
const mcpCatalogRecordErrors = {
  ...mcpCatalogRecordDefault,
  offered: { tools: true, resources: true, resource_templates: false, prompts: true },
  resources: [],
  resource_templates: [],
  fetch_errors: [{ method: "resources/list", error: "deadline exceeded while paginating resources" }],
};
const mcpCatalogSummaryErrors = {
  ...mcpCatalogSummaryDefault,
  resources: 0,
  resource_templates: 0,
  offered: { tools: true, resources: true, resource_templates: false, prompts: true },
  unknown: ["resources"],
  errors: 1,
};

/** `?mcpCatalogUnreadable=1` — a minimal, single-tool catalogue so an e2e
 *  test can assert the unreadable-schema copy without hunting through 44
 *  tools for `resolve_ref`. */
const mcpCatalogRecordUnreadable = {
  ...mcpCatalogRecordDefault,
  instructions: null,
  offered: { tools: true, resources: false, resource_templates: false, prompts: false },
  tools: [
    {
      name: "legacy_tool",
      title: null,
      description: "A tool whose schema this server does not expose in a readable shape.",
      parameters: [] as MockCatalogParam[],
      schema_unreadable: true,
      parameters_truncated: false,
      annotations: null as MockCatalogAnnotations | null,
    },
  ],
  resources: [],
  resource_templates: [],
  prompts: [],
};
const mcpCatalogSummaryUnreadable = {
  ...mcpCatalogSummaryDefault,
  tools: 1,
  resources: 0,
  resource_templates: 0,
  prompts: 0,
  offered: { tools: true, resources: false, resource_templates: false, prompts: false },
  instructions: false,
};

type McpCatalogVariant = "default" | "empty" | "errors" | "unreadable" | "missing";

/** `?mcpCatalogMissing=1` reads as `"missing"` only for the CATALOG call —
 *  the probe row still carries the BASE summary (so the glance block renders
 *  normally); only `hub mcp catalog --json` fails with `no_catalog`, which is
 *  exactly §6.3 row 6 ("summary present, catalogue file missing"). */
function mcpCatalogVariant(): McpCatalogVariant {
  if (sceneFlag("mcpCatalogEmpty")) return "empty";
  if (sceneFlag("mcpCatalogErrors")) return "errors";
  if (sceneFlag("mcpCatalogUnreadable")) return "unreadable";
  if (sceneFlag("mcpCatalogMissing")) return "missing";
  return "default";
}

function mcpCatalogSummaryForVariant(variant: McpCatalogVariant) {
  switch (variant) {
    case "empty":
      return mcpCatalogSummaryEmpty;
    case "errors":
      return mcpCatalogSummaryErrors;
    case "unreadable":
      return mcpCatalogSummaryUnreadable;
    // "missing" still carries the base summary — only the catalog FILE is gone.
    case "missing":
    case "default":
    default:
      return mcpCatalogSummaryDefault;
  }
}

function mcpCatalogRecordForVariant(variant: McpCatalogVariant) {
  switch (variant) {
    case "empty":
      return mcpCatalogRecordEmpty;
    case "errors":
      return mcpCatalogRecordErrors;
    case "unreadable":
      return mcpCatalogRecordUnreadable;
    case "default":
    case "missing":
    default:
      return mcpCatalogRecordDefault;
  }
}

const remoteScan = {
  remote: "hermes-main",
  candidates: [
    { name: "curator-notes", ref: "skills/curator-notes", sha256: "aa11", category: "NEW", origin: "remote:hermes-main" },
    { name: "self-improve-loop", ref: "skills/self-improve-loop", sha256: "bb22", category: "NEW", origin: "remote:hermes-main" },
    { name: "Bad Name", ref: "skills/Bad Name", sha256: "cc33", category: "INVALID_NAME", origin: "remote:hermes-main" },
  ],
};

// ─── Agent docs (safe stubs) ──────────────────────────────────────────────────

const AD_BASE = "/Users/dev/projects/example-app";
function adFile(rel: string, opts: { known?: boolean } = {}) {
  const known = opts.known ?? false;
  return {
    rel,
    name: rel.split("/").pop() ?? rel,
    label: rel,
    absolute_path: `${AD_BASE}/${rel}`,
    exists: true,
    is_known: known,
    is_discovered: !known,
    is_symlink: false,
    symlink_to: null,
    symlink_target_in_project: false,
    can_read: true,
    can_write: true,
    size: 320,
    modified_at: 1716_000_000,
    hash: "deadc0de",
    error: null,
  };
}

// Loaded context: the agent-basename instruction files plus resolved import
// targets. Identical in both browse modes — that stability is the point.
const AD_INSTRUCTION_RELS = [
  "AGENTS.md",
  "CLAUDE.md",
  "docs/agent/rules.md",
  "docs/guides/CLAUDE.md",
];

const importedRules = {
  ...adFile("docs/agent/rules.md"),
  is_import: true,
  imported_by: ["CLAUDE.md"],
  import_class: "in_project",
};

const agentDocsPolicy = {
  requires_claude: true,
  requires_agent: false,
  strategy: "symlink",
  canonical: "CLAUDE.md",
  derived: null,
};

// Default Agent Docs mode: the known agent-doc basenames only.
const agentDocsListing = {
  project_path: AD_BASE,
  root: {
    name: "example-app",
    path: "",
    dirs: [
      {
        name: "docs",
        path: "docs",
        files: [],
        dirs: [
          {
            name: "agent",
            path: "docs/agent",
            dirs: [],
            // Reached through the `@` import graph, not by basename — the case
            // the default map could not render at all before.
            files: [importedRules],
          },
          {
            name: "guides",
            path: "docs/guides",
            dirs: [],
            files: [adFile("docs/guides/CLAUDE.md")],
          },
        ],
      },
    ],
    files: [adFile("AGENTS.md", { known: true }), adFile("CLAUDE.md", { known: true })],
  },
  instruction_sets: [],
  required_formats: ["CLAUDE"],
  policy: agentDocsPolicy,
  all_rels: AD_INSTRUCTION_RELS,
  instruction_rels: AD_INSTRUCTION_RELS,
  external_imports: [
    {
      ...adFile("prefs.md"),
      name: "prefs.md",
      absolute_path: "/Users/example/.claude/my-project-instructions.md",
      can_read: false,
      can_write: false,
      is_import: true,
      imported_by: ["CLAUDE.md"],
      import_class: "external",
    },
  ],
  ignored_count: 0,
  include_ignored: false,
};

// All-Markdown mode (`include_all_markdown: true`): every `.md` in the project.
// A pass-through directory chain (no files of its own, exactly one
// subdirectory each) — an Android `app/src/main/java/com/pkg/` package path
// is the textbook case. Exercises the stub-chain collapse in the gallery.
// `folder.path` is PROJECT-RELATIVE — the real backend builds it from the rel
// in `insert_file_into_tree`. A pass-through stub has no files of its own, so
// its own path is never used as an expansion key; the chain collapses onto the
// first folder that holds something.
function stubDir(
  name: string,
  path: string,
  child: { name: string; path: string; dirs: unknown[]; files: unknown[] },
) {
  return { name, path, dirs: [child], files: [] };
}
const AND = "app/src/main/java/com/notesapp/presentation";
const androidPresentation = {
  name: "presentation",
  path: AND,
  files: [],
  dirs: [
    {
      name: "board",
      path: `${AND}/board`,
      dirs: [],
      files: [adFile(`${AND}/board/README.md`)],
    },
    {
      name: "capture",
      path: `${AND}/capture`,
      dirs: [],
      files: [adFile(`${AND}/capture/README.md`)],
    },
  ],
};
const androidAppDir = stubDir(
  "app",
  "app",
  stubDir(
    "src",
    "app/src",
    stubDir(
      "main",
      "app/src/main",
      stubDir(
        "java",
        "app/src/main/java",
        stubDir("com", "app/src/main/java/com", stubDir("notesapp", "app/src/main/java/com/notesapp", androidPresentation)),
      ),
    ),
  ),
);

const agentDocsMarkdownListing = {
  project_path: AD_BASE,
  root: {
    name: "example-app",
    path: "",
    dirs: [
      {
        name: "docs",
        path: "docs",
        files: [adFile("docs/architecture.md")],
        dirs: [
          {
            name: "guides",
            path: "docs/guides",
            dirs: [],
            // A nested agent-instruction override — exercises the collapsed-
            // folder "contains an agent doc" hint in the visual gallery.
            files: [
              adFile("docs/guides/setup.md"),
              adFile("docs/guides/testing.md"),
              adFile("docs/guides/CLAUDE.md"),
            ],
          },
          {
            name: "agent",
            path: "docs/agent",
            dirs: [],
            files: [importedRules],
          },
        ],
      },
      androidAppDir,
    ],
    files: [
      adFile("README.md"),
      adFile("CHANGELOG.md"),
      adFile("AGENTS.md"),
      adFile("CLAUDE.md"),
    ],
  },
  instruction_sets: [],
  required_formats: ["CLAUDE"],
  policy: agentDocsPolicy,
  all_rels: [
    "README.md",
    "CHANGELOG.md",
    "AGENTS.md",
    "CLAUDE.md",
    "docs/architecture.md",
    "docs/guides/setup.md",
    "docs/guides/testing.md",
    "app/src/main/java/com/notesapp/presentation/board/README.md",
    "app/src/main/java/com/notesapp/presentation/capture/README.md",
    "docs/guides/CLAUDE.md",
    "docs/agent/rules.md",
  ],
  instruction_rels: AD_INSTRUCTION_RELS,
  external_imports: [],
  // A gitignored CI checkout, the case that motivated ignore scoping.
  ignored_count: 555,
  include_ignored: false,
};

// Same browse view with ignore rules switched off — the escape hatch's payload.
const agentDocsMarkdownIgnoredListing = {
  ...agentDocsMarkdownListing,
  all_rels: [...agentDocsMarkdownListing.all_rels, "actions-runner/_work/notes.md"],
  root: {
    ...agentDocsMarkdownListing.root,
    dirs: [
      ...agentDocsMarkdownListing.root.dirs,
      {
        name: "actions-runner",
        path: "actions-runner",
        files: [],
        dirs: [
          {
            name: "_work",
            path: "actions-runner/_work",
            dirs: [],
            files: [adFile("actions-runner/_work/notes.md")],
          },
        ],
      },
    ],
  },
  ignored_count: 0,
  include_ignored: true,
};

// ─── Dispatch ─────────────────────────────────────────────────────────────────

/** Optional IPC latency (ms), off by default so normal harness runs are
 *  unaffected. Set via `window.__IPC_DELAY_MS` or the `?ipcDelay=<ms>` query
 *  param — used by the responsiveness e2e journey to prove the UI stays live
 *  while a command is in flight. The dispatch itself runs eagerly (so mock
 *  state mutations still apply synchronously); only the resolve is delayed. */
let playbookSeeded = false;
function ensurePlaybookFixtures() {
  if (playbookSeeded || !sceneFlag("bundlePlaybook") && !sceneFlag("projectOverview")) return;
  playbookSeeded = true;
  registry.bundles.android.playbook = [
    { id: "workflow", title: "Build and refine", guidance: "The skills I reach for during implementation.", skills: ["rt-android-expert", "android-compose-ui"] },
    { id: "companions", title: "Keep close", guidance: "Useful companions included in every project loadout.", skills: ["android-jetpack-compose-material3-theming-helper", "git-committer-mcp"] },
  ];
  if (sceneFlag("projectOverview")) {
    registry.bundles.essentials.skills = ["brainstorm", "context7", "android-compose-ui"];
    registry.bundles.essentials.playbook = [{ id: "shared", title: "Everyday tools", guidance: "Shared capabilities used throughout the project.", skills: ["brainstorm", "context7", "android-compose-ui"] }];
    registry.bundles.android.skills = [...new Set([...registry.bundles.android.skills, "context7"])];
    registry.bundles.android.playbook[0].skills.push("context7");
    if (sceneFlag("projectOverviewDense")) {
      const names = Array.from({ length: 200 }, (_, index) => `long-project-skill-${index.toString().padStart(3, "0")}-with-a-detailed-capability-name`);
      for (const name of names) registry.skills[name] = { ...registry.skills["android-compose-ui"], description: "A long skill description that explains the capability without taking over the row or hiding its controls." };
      registry.bundles.android.skills.push(...names);
      registry.bundles.android.playbook[0].title = "Implementation and verification across all project capabilities with detailed guidance";
      registry.bundles.android.playbook[0].skills.push(...names);
      registry.bundles.essentials.skills.push(...names.slice(0, 10));
      registry.bundles.essentials.playbook[0].skills.push(...names.slice(0, 10));
    }
  }
  registry.skills["android-compose-ui"].invocation = "user-only";
  registry.skills["android-compose-ui"].version = "2026.09.16";
  registry.skills["rt-android-expert"].classification = { classes: ["design", "planning"], outputs: ["plan", "code change"], interaction_style: "conversational", working_mode: "inline", maturity: "confident" };
  registry.skills["android-compose-ui"].classification = { interaction_style: "autonomous", working_mode: "inline" };
}

function ipcDelayMs(): number {
  if (typeof window === "undefined") return 0;
  const w = window as unknown as { __IPC_DELAY_MS?: number };
  if (typeof w.__IPC_DELAY_MS === "number" && w.__IPC_DELAY_MS > 0) {
    return w.__IPC_DELAY_MS;
  }
  const raw = sceneValue("ipcDelay");
  const n = raw ? Number(raw) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// The `libraryEmpty` scene serves a genuinely empty registry, which would
// otherwise trip the app's fresh-install tips-tour auto-start and overlay the
// empty-state we want to capture. Mark the tour done up front (test-double only)
// so the scene shows a clean empty Library.
if (typeof window !== "undefined") {
  try {
    if (sceneFlag("libraryEmpty")) {
      window.localStorage.setItem("st:tips:done", "1");
    }
  } catch {
    /* storage unavailable — ignore */
  }
}

// ─── `source add git` scan simulation ────────────────────────────────────────
// The real scanner resolves ONE repo-relative base — explicit `--path` wins,
// otherwise the subpath baked into a GitHub tree/blob URL — and either finds
// skills there, finds none, or finds no such directory. The mock reproduces
// exactly that decision so every wizard state is reachable by typing a URL.

interface MockCandidate {
  name: string;
  category: string;
  origin_path: string;
}

interface MockScanScenario {
  ok: boolean;
  scanned_path?: string;
  counts?: { new: number; conflicts: number; imported: number; invalid: number };
  candidates?: MockCandidate[];
  error?: string;
  message?: string;
  hint_path?: string;
}

/** Effective scan base for a `source add git` argv (explicit `--path` wins). */
function scanBaseFor(cmdArgs: string[]): string {
  const url = cmdArgs[3] ?? "";
  const pathIdx = cmdArgs.indexOf("--path");
  const explicit = pathIdx >= 0 ? cmdArgs[pathIdx + 1] ?? "" : "";
  const base = explicit || parseGitSourceUrl(url).subpath || "";
  return base.replace(/^\/+|\/+$/g, "");
}

function countsFor(candidates: MockCandidate[]) {
  const of = (c: string) =>
    candidates.filter((x) => x.category.toUpperCase() === c).length;
  return {
    new: of("NEW"),
    conflicts: of("CONFLICT"),
    // The scanner's own vocabulary (`classify_candidates`):
    // NEW | CONFLICT | IMPORTED | INVALID — not the import wizard's.
    imported: of("IMPORTED"),
    invalid: of("INVALID"),
  };
}

function sourceAddScenario(cmdArgs: string[]): MockScanScenario {
  const scanned = scanBaseFor(cmdArgs);

  // The ground-truth bug: a path relative to the link you were reading rather
  // than to the repo root. Real dir exists one level up → hint it.
  if (scanned === "skills/unslop") {
    // The hint mirrors the backend precondition (`_scan_base_hint`): it exists
    // ONLY when the URL carried a subpath AND `<subpath>/<path>` is a real
    // directory. A plain repo URL gets the bare error, same as the real thing.
    const urlSubpath = parseGitSourceUrl(cmdArgs[3] ?? "").subpath ?? "";
    const composed = urlSubpath ? `${urlSubpath}/${scanned}` : "";
    return {
      ok: false,
      error: "path_not_found",
      message: "skills/unslop does not exist in cursor/plugins@main.",
      ...(composed === "pstack/skills/unslop" ? { hint_path: composed } : {}),
    };
  }
  // A deep link straight at one skill directory → exactly that skill.
  if (scanned === "pstack/skills/unslop") {
    const candidates: MockCandidate[] = [
      { name: "unslop", category: "NEW", origin_path: "pstack/skills/unslop" },
    ];
    return { ok: true, scanned_path: scanned, counts: countsFor(candidates), candidates };
  }
  // A real but skill-less directory: honest empty, not a silent zero.
  if (scanned === "docs" || scanned.endsWith("/docs")) {
    return { ok: true, scanned_path: scanned, counts: countsFor([]), candidates: [] };
  }
  // A folder of skills → several NEW rows worth curating, plus one conflict and
  // one name the registry can never accept (INVALID: it is neither selectable
  // nor importable, and no filter ever lists it).
  if (scanned === "pstack/skills") {
    const candidates: MockCandidate[] = [
      { name: "unslop", category: "NEW", origin_path: "pstack/skills/unslop" },
      { name: "pstack-init", category: "NEW", origin_path: "pstack/skills/pstack-init" },
      { name: "pstack-audit", category: "NEW", origin_path: "pstack/skills/pstack-audit" },
      { name: "code-review", category: "CONFLICT", origin_path: "pstack/skills/code-review" },
      { name: "Bad Name", category: "INVALID", origin_path: "pstack/skills/Bad Name" },
    ];
    return { ok: true, scanned_path: scanned, counts: countsFor(candidates), candidates };
  }
  // Default (whole repo / `skills`): the long-standing 1 NEW + 1 CONFLICT pair.
  const candidates: MockCandidate[] = [
    { name: "new-widget", category: "NEW", origin_path: "skills/new-widget" },
    { name: "code-review", category: "CONFLICT", origin_path: "skills/code-review" },
  ];
  return {
    ok: true,
    scanned_path: scanned,
    counts: countsFor(candidates),
    candidates,
  };
}

// ─── `ships_with` companions (I1/I2/A2/A3/A4/A5/A13) ─────────────────────────
// Installed set the mock's `harness list` answers with (see the `harness`/`list`
// arm below) — pi/opencode are not modeled here, so every companion agent is
// `will_write` on both harnesses this mock knows (codex DOES have sub-agent
// definitions; only pi/opencode agents are `unsupported`, per A3).
const COMPANION_INSTALLED_HARNESSES = ["claude-code", "codex"];

function shipsWithTotal(sw: Registry["skills"][string]["ships_with"]): number {
  if (!sw) return 0;
  return (
    (sw.agents?.length ?? 0) +
    (sw.hooks?.length ?? 0) +
    (sw.permissions?.allow?.length ?? 0) +
    (sw.permissions?.deny?.length ?? 0) +
    (sw.permissions?.ask?.length ?? 0)
  );
}

/** The I2 `items[]` for one skill on one project — every effective harness,
 *  every declared agent/hook/rule, plus the A2 codex trust row whenever a
 *  codex permission row is `will_write` and the project isn't already
 *  trusted. Reasonable-fidelity fixture plumbing for waves B-D to build the
 *  real gate/dialog against; no test in THIS wave exercises it directly. */
function buildCompanionItems(skillName: string, projectName: string): CompanionItem[] {
  const skill = registry.skills[skillName];
  const proj = registry.projects[projectName];
  const sw = skill?.ships_with;
  if (!sw || !proj) return [];
  const harnesses = effectiveHarnesses(proj, registry, COMPANION_INSTALLED_HARNESSES);
  const trusted = !!proj.permissions?.project_trust;
  const items: CompanionItem[] = [];

  for (const harness of harnesses) {
    for (const name of sw.agents ?? []) {
      items.push({
        kind: "agent",
        name,
        harness,
        target: harness === "codex" ? `~/.codex/agents/${name}.toml` : `~/.claude/agents/${name}.md`,
        verdict: "will_write",
        scope: "user",
      });
    }
    for (const hook of sw.hooks ?? []) {
      if (harness === "codex") {
        items.push({
          kind: "hook",
          name: hook.name,
          harness,
          target: proj.path,
          verdict: "unsupported",
          reason: "Codex skips project-attached hooks",
          activation: isHookRef(hook) ? undefined : hook.activation,
        });
      } else {
        items.push({
          kind: "hook",
          name: hook.name,
          harness,
          target: `${proj.path}/.claude/settings.local.json`,
          verdict: "will_write",
          activation: isHookRef(hook) ? undefined : hook.activation,
        });
      }
    }
    let wroteCodexRule = false;
    for (const ruleKind of ["deny", "ask", "allow"] as const) {
      for (const pattern of sw.permissions?.[ruleKind] ?? []) {
        items.push({
          kind: "permission",
          name: pattern,
          harness,
          target:
            harness === "codex"
              ? `${proj.path}/.codex/rules/skill-hub.rules`
              : `${proj.path}/.claude/settings.json`,
          verdict: "will_write",
          rule_kind: ruleKind,
        });
        if (harness === "codex") wroteCodexRule = true;
      }
    }
    if (harness === "codex" && wroteCodexRule && !trusted) {
      items.unshift({
        kind: "trust",
        name: "trust_level",
        harness: "codex",
        target: "~/.codex/config.toml",
        verdict: "will_write",
        reason: "Codex runs a project's committed config.toml and hooks once trusted",
      });
    }
  }
  return items;
}

/** Every agent name the sub-agent mock (`tauriSubagents.ts`) lists on one
 *  harness's user scope — reused verbatim by `dispatchSubagent`, not
 *  duplicated, so the two mocks can never drift apart again (the tail this
 *  fixes: the six `orch-*` agents live in `mockAgents`, but the companions
 *  mock used to hardcode `provisioned: false` regardless, so R21's "only a
 *  lit harness gets a link" guard correctly found nothing and every name
 *  link was a silent no-op). */
function agentNamesOnHarness(harness: string): Set<string> {
  const result = dispatchSubagent("subagent_list", {
    scope: "user",
    project: null,
    harnessId: harness,
  }) as { agents?: Array<{ name: string }> };
  return new Set((result.agents ?? []).map((a) => a.name));
}

/** D16/F10: the companion names `?companionsAbsent=1` hides — derived from
 *  `orchestrate-advanced`'s OWN `ships_with` fixture (agents + hook names),
 *  never a name prefix. A prefix heuristic (`name.startsWith("orch-")`)
 *  would silently stop hiding the moment the fixture renamed something and
 *  the proof frame would quietly show the wrong state — `test/
 *  companionsFixtureParity.test.ts` pins this fixture, so deriving the set
 *  from it (rather than restating it) keeps the two from drifting apart.
 *  Memoized: `registry` is fully populated by the time anything calls this
 *  (dispatch never runs at module-load time). */
let companionHiddenNamesCache: Set<string> | null = null;
function companionHiddenNames(): Set<string> {
  if (!companionHiddenNamesCache) {
    const sw = registry.skills["orchestrate-advanced"]?.ships_with;
    companionHiddenNamesCache = new Set([
      ...(sw?.agents ?? []),
      ...(sw?.hooks ?? []).map((h) => h.name),
    ]);
  }
  return companionHiddenNamesCache;
}

/** D16: whether `name` should be hidden from the mock under
 *  `?companionsAbsent=1` — applied at `hook_list`/`findMockHook`/
 *  `hookAttachedAnywhere` here and at `subagent_list` in `tauriSubagents.ts`
 *  (same predicate, imported). This is the MECHANISM that makes a
 *  project-less, all-absent SHIPS WITH read possible under F2: with every
 *  declared hook missing from the library and every declared agent missing
 *  from the sub-agent list, every row in the flagged scene is genuinely
 *  `absent` and genuinely unroutable — not an incidental detail of the proof
 *  scene. */
export function companionHidden(name: string): boolean {
  return sceneFlag("companionsAbsent") && companionHiddenNames().has(name);
}

/** Whether a hook definition is attached anywhere (global or any project) in
 *  the mock's live `hooksStore` — the declaration-only read's stand-in for
 *  "present" (I5: a project-less read never knows PER-PROJECT attachment,
 *  only whether the definition exists and is in use at all). D16: a hidden
 *  companion hook is never "attached" under the flag, regardless of what the
 *  store still carries. */
function hookAttachedAnywhere(name: string): boolean {
  if (companionHidden(name)) return false;
  const def = hooksStore.find((h) => h.name === name);
  return !!def && (def.attached_global || def.attached_projects.length > 0);
}

/** The declaration-only variant of `buildCompanionItems`, read with no
 *  `--project` (A5's `project: null` shape). Per-harness verdicts are
 *  meaningful even without a project — only the codex trust row needs a real
 *  project (trust can't be known in the abstract), so that row is never
 *  added here. `provisioned` (below, feeding I5's `present`/`absent` via
 *  `companionStateFor`) instead reads whatever project-INDEPENDENT presence
 *  signal each kind actually has: an agent's user-scope file (the sub-agent
 *  mock's own list, per harness) and a hook's attachment (`hooksStore`) — a
 *  permission rule has no such signal without a project, so it stays
 *  `false`/`absent`, same as before. Targets that would otherwise be
 *  `<repo>/...` use a `<project>` placeholder since there is no concrete
 *  path yet. Wave E follow-up: the skill editor's SHIPS WITH section (no
 *  project context) was previously reading `items: []` from this arm — see
 *  reports/5-u7-decl.md. */
function buildCompanionItemsDeclared(skillName: string): CompanionItem[] {
  const skill = registry.skills[skillName];
  const sw = skill?.ships_with;
  if (!sw) return [];
  const items: CompanionItem[] = [];
  const agentNamesByHarness = new Map(
    COMPANION_INSTALLED_HARNESSES.map((h) => [h, agentNamesOnHarness(h)] as const),
  );

  for (const harness of COMPANION_INSTALLED_HARNESSES) {
    for (const name of sw.agents ?? []) {
      items.push({
        kind: "agent",
        name,
        harness,
        target: harness === "codex" ? `~/.codex/agents/${name}.toml` : `~/.claude/agents/${name}.md`,
        verdict: "will_write",
        scope: "user",
        provisioned: agentNamesByHarness.get(harness)?.has(name) ?? false,
      });
    }
    for (const hook of sw.hooks ?? []) {
      if (harness === "codex") {
        items.push({
          kind: "hook",
          name: hook.name,
          harness,
          target: "<project>",
          verdict: "unsupported",
          reason: "Codex skips project-attached hooks",
          activation: isHookRef(hook) ? undefined : hook.activation,
          provisioned: hookAttachedAnywhere(hook.name),
        });
      } else {
        items.push({
          kind: "hook",
          name: hook.name,
          harness,
          target: "<project>/.claude/settings.local.json",
          verdict: "will_write",
          activation: isHookRef(hook) ? undefined : hook.activation,
          provisioned: hookAttachedAnywhere(hook.name),
        });
      }
    }
    for (const ruleKind of ["deny", "ask", "allow"] as const) {
      for (const pattern of sw.permissions?.[ruleKind] ?? []) {
        items.push({
          kind: "permission",
          name: pattern,
          harness,
          target:
            harness === "codex"
              ? "<project>/.codex/rules/skill-hub.rules"
              : "<project>/.claude/settings.json",
          verdict: "will_write",
          rule_kind: ruleKind,
          provisioned: false,
        });
      }
    }
  }
  return items;
}

function companionRuleKeys(sw: Registry["skills"][string]["ships_with"]): RuleKey[] {
  if (!sw?.permissions) return [];
  const out: RuleKey[] = [];
  for (const kind of ["deny", "ask", "allow"] as const) {
    for (const pattern of sw.permissions[kind] ?? []) out.push({ pattern, kind });
  }
  return out;
}

// ─── I5 state/route/summary (wave 2) ─────────────────────────────────────────

/** I5: `state` per item — `unsupported` from the verdict regardless of
 *  project context; otherwise `provisioned`/`pending` with a project,
 *  `present`/`absent` without one (I5's own rule: never `pending` there). */
function companionStateFor(item: CompanionItem, hasProject: boolean): CompanionState {
  if (item.verdict === "unsupported" || item.verdict === "feature_off" || item.verdict === "not_installed") {
    return "unsupported";
  }
  const present = item.provisioned === true || item.verdict === "already_present";
  if (hasProject) return present ? "provisioned" : "pending";
  return present ? "present" : "absent";
}

/** A21: a rule's route is authoritative from the CLI; agent/hook rows carry
 *  none here — `lib/companionRoutes.ts` derives those client-side. */
function companionRouteFor(item: CompanionItem, projectName: string | undefined): string | null {
  if (item.kind !== "permission" || !projectName || !item.rule_kind) return null;
  return `/project/${encodeURIComponent(projectName)}?tab=permissions&focus=${item.rule_kind}:${encodeURIComponent(item.name)}`;
}

/** I5 top-level rollup, counted from each item's OWN `state` — never from
 *  `verdict` — so a declaration-only read (states only ever `present`/
 *  `absent`/`unsupported`) naturally reports `pending: 0`. */
function companionSummaryFor(items: CompanionItem[]): CompanionsSummary {
  const summary: CompanionsSummary = { provisioned: 0, pending: 0, drift: 0, missing: 0 };
  for (const item of items) {
    if (item.state === "provisioned" || item.state === "present") summary.provisioned++;
    else if (item.state === "pending") summary.pending++;
    else if (item.state === "missing") summary.missing++;
    if (item.state === "drift") summary.drift++;
  }
  return summary;
}

// ─── D17 — the project-less read learns where the skill is provisioned ─────
// Mirrors `hub_cli/companions.py`'s D17 fix: a project-less read used to have
// no project-INDEPENDENT presence signal for hooks/rules (only an agent's
// user-scope file counted, via `provisioned` above), so a hook/rule item was
// ALWAYS `absent` there even right after a successful `--with-companions`
// equip. `provisioned_on` names every scope whose ledger actually claims this
// skill; this wave's mock has no `companions_global` yet (A17 stays a
// follow-up — see the `project_context` comment below), so only real project
// ledgers are scanned.

/** The `?companionsProvisioned=1` scene's ledger entry for `orchestrate-
 *  advanced` on moon-base — shared between `read_registry`'s clone-only seed
 *  (below, which deliberately never touches the live `registry` — "every
 *  other read still sees the un-provisioned state") and these D17 helpers,
 *  which check the SAME flag directly rather than reading that mutated
 *  clone, matching the `permissions_show` twin rule's own precedent. One
 *  literal, never restated. */
const COMPANIONS_PROVISIONED_LEDGER_ENTRY: CompanionLedgerEntry = {
  hooks: ["orch-scope-guard", "orch-report-guard", "orch-unit-brief"],
  agents: [
    "orch-sub-orchestrator",
    "orch-researcher",
    "orch-planner",
    "orch-griller",
    "orch-implementer",
    "orch-reviewer",
  ],
  permissions: [
    { pattern: "Bash(git push --force:*)", kind: "deny" },
    { pattern: "Bash(gh pr merge:*)", kind: "ask" },
  ],
  provisioned_at: "2026-09-05T12:00:00Z",
};

/** The virtual `?companionsProvisioned=1` ledger entry for `skillName`, or
 *  `undefined` when the flag is off or the skill isn't the one that scene
 *  seeds. */
function companionsProvisionedFlagEntry(skillName: string): CompanionLedgerEntry | undefined {
  return skillName === "orchestrate-advanced" && sceneFlag("companionsProvisioned")
    ? COMPANIONS_PROVISIONED_LEDGER_ENTRY
    : undefined;
}

/** Whether one ledger entry claims a given companion (a hook/agent by name, a
 *  rule by `(pattern, kind)`) — the one match rule `companionsProvisionedOn`
 *  and `companionClaimedScopes` share. */
function companionLedgerEntryClaims(
  entry: CompanionLedgerEntry,
  kind: "hook" | "agent" | "permission",
  name: string,
  ruleKind?: string,
): boolean {
  if (kind === "hook") return (entry.hooks ?? []).includes(name);
  if (kind === "agent") return (entry.agents ?? []).includes(name);
  return (entry.permissions ?? []).some((p) => p.pattern === name && p.kind === ruleKind);
}

/** Every project name whose `companions.<skill>` ledger entry exists — the
 *  mock's `provisioned_on` for a project-less read. */
function companionsProvisionedOn(skillName: string): string[] {
  const scopes = new Set(
    Object.keys(registry.projects).filter((p) => !!registry.projects[p]?.companions?.[skillName]),
  );
  if (companionsProvisionedFlagEntry(skillName)) scopes.add("moon-base");
  return [...scopes].sort();
}

/** Every project name whose ledger entry for `skillName` claims this exact
 *  companion (a hook/agent by name, a rule by `(pattern, kind)`) — the
 *  per-item scope list D17's `reason` ("from A, B") reads off. */
function companionClaimedScopes(
  skillName: string,
  kind: "hook" | "agent" | "permission",
  name: string,
  ruleKind?: string,
): string[] {
  const scopes = new Set<string>();
  for (const [project, proj] of Object.entries(registry.projects)) {
    const entry = proj.companions?.[skillName];
    if (entry && companionLedgerEntryClaims(entry, kind, name, ruleKind)) scopes.add(project);
  }
  const flagEntry = companionsProvisionedFlagEntry(skillName);
  if (flagEntry && companionLedgerEntryClaims(flagEntry, kind, name, ruleKind)) scopes.add("moon-base");
  return [...scopes].sort();
}

// ─── I6/I7 `companions set` (D10, wave 2) ───────────────────────────────────

/** Whole-block normalize (D10): a ref hook's stored shape is `{ref, name}`
 *  with both fields holding the SAME name (A18) — the mock never invents a
 *  display name a ref didn't carry. Wave 4c unit 2 — an inline hook's
 *  `scaffold` request (§6.2) is stripped here before the block reaches the
 *  registry mirror, mirroring `_apply_set_body`'s `{k: v for k, v in
 *  h.items() if k != "scaffold"}`: `scaffold` is consumed, never persisted. */
function normalizeCompanionsSetBlock(body: CompanionsSetBlock): ShipsWith {
  return {
    agents: (body.agents ?? []).map((a) => a.name),
    hooks: (body.hooks ?? []).map((h) => {
      if ("ref" in h) return { ref: h.ref, name: h.ref };
      const { scaffold: _scaffold, ...rest } = h;
      void _scaffold;
      return rest;
    }),
    permissions: {
      allow: [...(body.permissions?.allow ?? [])],
      deny: [...(body.permissions?.deny ?? [])],
      ask: [...(body.permissions?.ask ?? [])],
    },
  };
}

/**
 * D11's reconcile loop, run right after a `set` normalizes+writes the mirror:
 * for every project that already provisioned this skill (has a ledger entry),
 * diff declared vs. ledgered names per kind. `pending` names what the
 * declared block adds that the ledger doesn't have yet (never auto-written —
 * a real `Provision` still has to run); `stale_removed` names what the
 * ledger has that the block no longer declares, de-provisioned right here
 * (backup-first in the real hub; this mock just mutates the ledger + the
 * hook-attachment/permission-rule mirrors it already keeps). A project with
 * nothing to report is omitted from `projects` entirely.
 */
function reconcileCompanionsAfterSet(skillName: string, sw: ShipsWith): ReconcileResult {
  const declaredHookNames = new Set((sw.hooks ?? []).map((h) => h.name));
  const declaredAgentNames = new Set(sw.agents ?? []);
  const declaredRuleKeys = companionRuleKeys(sw);
  const declaredRuleSet = new Set(declaredRuleKeys.map((r) => `${r.kind}:${r.pattern}`));

  const projects: Record<string, ReconcileProjectRecord> = {};
  for (const [projectName, proj] of Object.entries(registry.projects)) {
    const entry = proj.companions?.[skillName];
    if (!entry) continue; // never provisioned here — nothing to reconcile

    const ledgerHooks = entry.hooks ?? [];
    const ledgerAgents = entry.agents ?? [];
    const ledgerRules = entry.permissions ?? [];

    const pending = [
      ...[...declaredHookNames].filter((n) => !ledgerHooks.includes(n)),
      ...[...declaredAgentNames].filter((n) => !ledgerAgents.includes(n)),
      ...declaredRuleKeys
        .filter((r) => !ledgerRules.some((lr) => lr.pattern === r.pattern && lr.kind === r.kind))
        .map((r) => r.pattern),
    ];
    const staleHooks = ledgerHooks.filter((n) => !declaredHookNames.has(n));
    const staleAgents = ledgerAgents.filter((n) => !declaredAgentNames.has(n));
    const staleRules = ledgerRules.filter((r) => !declaredRuleSet.has(`${r.kind}:${r.pattern}`));
    const staleRemoved = [...staleHooks, ...staleAgents, ...staleRules.map((r) => r.pattern)];

    entry.hooks = ledgerHooks.filter((n) => !staleHooks.includes(n));
    entry.agents = ledgerAgents.filter((n) => !staleAgents.includes(n));
    entry.permissions = ledgerRules.filter(
      (r) => !staleRules.some((s) => s.pattern === r.pattern && s.kind === r.kind),
    );
    for (const hookName of staleHooks) {
      const def = hooksStore.find((h) => h.name === hookName);
      if (def) def.attached_projects = def.attached_projects.filter((p) => p !== projectName);
    }
    const pp = permissionsProject[projectName];
    if (pp) for (const rule of staleRules) removeProjectPermissionRule(pp, rule);

    if (pending.length > 0 || staleRemoved.length > 0) {
      projects[projectName] = {
        pending,
        stale_removed: staleRemoved,
        reattached: [],
        drift: [],
        missing_refs: [],
      };
    }
  }
  return { projects };
}

// `?pendingBundleAdd=1` mirrors `?equipHangs=1` — but instead of hanging
// forever, only `bundle update` resolves 60s late. Unlike the generic
// `ipcDelayMs()` path (eager dispatch, delayed resolve), the MUTATION itself
// is deferred until the timeout fires — an eager dispatch would already put
// the membership into the mock registry for the whole 60s window, so the
// scene would never exercise the optimistic write it exists to show. Held
// back this way, the pending member row (SkillRow's `aria-busy` +
// "adding…") and the tracked process card can only be coming from
// `useBundleMembership`'s own optimistic write while on screen for the
// visual mock / PR preview, design.md "Visual mock". Every other scene's
// command keeps the plain eager-dispatch/delayed-resolve `ipcDelayMs()`
// shape below. The delay is 60s, not 30s: `app/src/lib/queryClient.ts` sets
// `staleTime: 30_000`, and a window-focus refetch landing at exactly 30s
// would race the scene.
interface DispatchTiming {
  delayMs: number;
  /** True only for the delayed `bundle update` under `pendingBundleAdd`:
   *  `dispatch` runs inside the timeout instead of before it. */
  deferDispatch: boolean;
}

function dispatchTiming(cmd: string, args?: Record<string, unknown>): DispatchTiming {
  if (cmd === "hub_cmd" && sceneFlag("pendingBundleAdd")) {
    const cmdArgs = (args?.args as string[] | undefined) ?? [];
    if (cmdArgs[0] === "bundle" && cmdArgs[1] === "update") {
      return { delayMs: 60_000, deferDispatch: true };
    }
  }
  return { delayMs: ipcDelayMs(), deferDispatch: false };
}

export function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (sceneFlag("settingsProbe")) {
    window.dispatchEvent(new CustomEvent("settings-mock-command", { detail: { cmd, args } }));
  }
  const { delayMs, deferDispatch } = dispatchTiming(cmd, args);
  if (deferDispatch) {
    return new Promise((resolve, reject) =>
      setTimeout(() => {
        try {
          resolve(dispatch(cmd, args) as T);
        } catch (e) {
          reject(e);
        }
      }, delayMs),
    );
  }
  const result = dispatch(cmd, args) as T;
  if (delayMs > 0) {
    return new Promise((resolve) => setTimeout(() => resolve(result), delayMs));
  }
  return Promise.resolve(result);
}

// ─── Additional exports from @tauri-apps/api/core ─────────────────────────────
// @tauri-apps/plugin-updater statically imports `Resource` and `Channel` from
// this module, so the alias must provide them (no-op shims) or esbuild's dep
// optimizer fails. plugin-updater itself is only lazy-imported (useUpdate) and
// never exercised by the harness.

export class Resource {
  rid = 0;
  async close(): Promise<void> {}
}

export class Channel<T = unknown> {
  id = 0;
  onmessage: ((msg: T) => void) | null = null;
}

export function transformCallback(_cb: unknown, _once?: boolean): number {
  return 0;
}

export async function convertFileSrc(filePath: string, _protocol?: string): Promise<string> {
  return filePath;
}

export function isTauri(): boolean {
  return false;
}

export class PluginListener {
  async unregister(): Promise<void> {}
}

export async function addPluginListener(): Promise<PluginListener> {
  return new PluginListener();
}

// ─── Scene-scoped variants (empty / error / danger states) ───────────────────
// The visual harness + a few e2e journeys opt INTO a non-happy-path state by
// passing a query flag BEFORE the hash route (e.g. `/?libraryEmpty=1#/`), so the
// default populated mock is untouched for every other scene. `sceneFlag` and
// `sceneValue` (imported above) are the typed scene-flag registry in
// `./scenes`; that module owns every read of the browser's query string.

let classificationFixturesApplied = false;
function ensureClassificationFixtures(): void {
  if (!sceneFlag("classification") || classificationFixturesApplied) return;
  classificationFixturesApplied = true;
  const set = (name: string, classification: Skill["classification"]) => {
    if (registry.skills[name]) registry.skills[name].classification = classification;
  };
  set("rt-android-expert", { classes: ["process"], outputs: ["plan"], working_mode: "mixed", maturity: "confident" });
  if (sceneFlag("classOverflow")) set("rt-android-expert", { classes: ["process", "audit", "planning", "research", "review", "testing", "a-long-custom-class-for-release-validation"], outputs: ["plan"], working_mode: "mixed", maturity: "confident" });
  set("android-compose-ui", { classes: ["implementation"], outputs: ["code change"], working_mode: "inline", interaction_style: "checkpointed", maturity: "trusted" });
  set("brainstorm", { classes: ["setup"], outputs: ["prompt", "research report"], working_mode: "delegator", interaction_style: "conversational", maturity: "experimental" });
  set("deep-research", { classes: ["audit"], outputs: ["research report", "PR"], working_mode: "mixed", interaction_style: "autonomous", maturity: "confident" });
}

export const classificationGraph = (): { edges: Array<{ from: string; to: string; count: number }> } => ({
  edges: [
    { from: "rt-android-expert", to: "android-compose-ui", count: 1 },
    { from: "android-compose-ui", to: "rt-android-expert", count: 1 },
    { from: "rt-android-expert", to: "brainstorm", count: 1 },
    { from: "brainstorm", to: "android-compose-ui", count: 2 },
    { from: "brainstorm", to: "deep-research", count: 1 },
    { from: "deep-research", to: "rt-android-expert", count: 1 },
  ],
});

interface FailedHubResult {
  success: false;
  output: string;
  stdout: string;
  stderr: string;
}

const ESC = String.fromCharCode(27);
const YEL = `${ESC}[33m`;
const RED = `${ESC}[31m`;
const GRN = `${ESC}[32m`;
const BOLD = `${ESC}[1m`;
const OFF = `${ESC}[0m`;

function failed(stdout: string, stderr: string): FailedHubResult {
  return { success: false, output: `${stdout}${stderr}`, stdout, stderr };
}

/** `?syncFails=1` — verbatim shape of a real failed `hub sync` (registry
 *  validation): coloured advisory warnings on stdout, the bold-red failure block
 *  + detail lines + remediation on stderr. */
function failingSyncResult(): FailedHubResult {
  return failed(
    [
      `${YEL}!${OFF} design-an-interface: missing SKILL.md at ~/.skill-hub/skills/design-an-interface/SKILL.md`,
      `${YEL}!${OFF} legacy-notes: missing SKILL.md at ~/.skill-hub/skills/legacy-notes/SKILL.md`,
      "",
    ].join("\n"),
    [
      `${BOLD}${RED}Skill registry validation failed:${OFF}`,
      "  - qa-2: frontmatter name is 'qa' in ~/.skill-hub/skills/qa-2/SKILL.md; must match registry key to avoid collisions",
      "  - duplicate skill name 'qa' declared by both 'qa' and 'qa-2'",
      "",
      "Fix the duplicate/mismatched skill definitions in ~/.skill-hub before running sync.",
      "",
    ].join("\n"),
  );
}

/** `?syncFails=stdout` — `hub.py`'s DOMINANT failure shape, and the one that
 *  broke the old headline logic: everything on stdout, stderr completely empty.
 *  A full sync narration ending in the red "✗ sync completed with danger
 *  findings" tick, so the only correct headline is the LAST meaningful line —
 *  not the leading banner, and not the green ✓ ticks in between. */
function failingSyncStdoutOnly(): FailedHubResult {
  return failed(
    [
      `${BOLD}Syncing registry → agent folders${OFF}`,
      "",
      `  ${GRN}✓${OFF} example-app: 6 skills → .claude/skills`,
      `  ${GRN}✓${OFF} moon-base: 3 skills → .agents/skills`,
      `  ${YEL}!${OFF} moon-base: 'qa' reaches no installed harness — skipped`,
      "",
      `${BOLD}Permissions${OFF}`,
      `  ${GRN}✓${OFF} global → ~/.claude/settings.json`,
      `  ${RED}danger${OFF} example-app: Bash(rm -rf:*) allowed without confirmation`,
      "",
      `${BOLD}${RED}✗ sync completed with danger findings${OFF}`,
      "",
    ].join("\n"),
    "",
  );
}

/** `?enableFails=1` — the worst repro of the old first-stdout-line rule:
 *  `cmd_enable` prints its green success tick and only THEN runs the auto-sync
 *  that fails, so a top-down read headlines "✓ enabled …" as the error. */
function failingEnableStdoutOnly(): FailedHubResult {
  return failed(
    [
      `${GRN}✓${OFF} enabled 'design-an-interface' for 'example-app'.`,
      `${BOLD}Syncing registry → agent folders${OFF}`,
      `  ${YEL}!${OFF} example-app: legacy-notes has no SKILL.md — skipped`,
      "no such project: 'ghost-app' referenced by bundle 'android'",
      "",
    ].join("\n"),
    "",
  );
}

/** A structurally-valid but empty registry (no skills/bundles/projects/sources)
 *  so the Library, Snippets, and Project screens render their empty states. */
function emptyRegistry(): Registry {
  return {
    version: "1",
    hub_path: "~/.skill-hub",
    bootstrap: { completed_at: "2026-06-20T18:33:00Z", version: 1 },
    harnesses_global: ["claude-code"],
    skills: {},
    projects: {},
    bundles: {},
    sources: {},
  };
}

/** One ccusage-shaped `agents[]`/session entry for a single harness at a given
 *  token count: `--by-agent` cost rates approximated from the original fixture
 *  (14.28 / 100_000 for claude, 2.76 / 28_450 for codex), plus a plausible
 *  pi rate. Components are split 0.2/1.3/3/95.5% (input/output/cacheCreation/
 *  cacheRead) with cacheRead absorbing the rounding remainder so the four
 *  components always sum to exactly `tokens` — the real shape a coding-agent
 *  session has (docs/changes/DESIGN-usage-numbers/PLAN.md §V8): about 98% cache reads,
 *  not the old 70/18/6/6 guess, which put the expensive, small output slice
 *  at a fifth of the bar instead of the sliver it actually is. Model names
 *  exercise the R2 formatter's family/store/qualifier branches instead of a
 *  shape it does nothing with. */
function usageAgentEntry(agent: "claude" | "codex" | "pi", tokens: number) {
  const rate = { claude: 0.0001428, codex: 0.000097, pi: 0.00006 }[agent];
  const model = { claude: "claude-fable-5-1", codex: "gpt-5.3-codex", pi: "[pi] gpt-5.5" }[agent];
  const input = Math.round(tokens * 0.002);
  const output = Math.round(tokens * 0.013);
  const cacheCreation = Math.round(tokens * 0.03);
  const cacheRead = tokens - input - output - cacheCreation;
  return {
    agent,
    inputTokens: input,
    outputTokens: output,
    cacheCreationTokens: cacheCreation,
    cacheReadTokens: cacheRead,
    totalTokens: tokens,
    totalCost: Math.round(tokens * rate * 100) / 100,
    modelsUsed: [model],
  };
}

const USAGE_SCALED_KEYS = new Set([
  "inputTokens", "outputTokens", "cacheCreationTokens", "cacheReadTokens", "totalTokens",
  "totalCost", "cost", "toolCalls", "linesAdded", "linesRemoved",
]);

/** Multiply every token/cost/count field of a fixture scan by `factor`, so a
 *  scene can show the magnitudes a real corpus produces without a second
 *  hand-written fixture. Counts stay integers. */
function scaleUsageScan<T>(scan: T, factor: number): T {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        out[k] =
          USAGE_SCALED_KEYS.has(k) && typeof val === "number"
            ? k === "totalCost" || k === "cost" ? val * factor : Math.round(val * factor)
            : walk(val);
      }
      return out;
    }
    return v;
  };
  return walk(scan) as T;
}

/** Sparse activity across June, prepended by the `usageLong` scene so the
 *  day axis runs past the 24-column label-thinning threshold with real gaps
 *  (zero-total stub columns) between the spikes — the shape a real corpus
 *  has, and the one that exposed columns with and without a label drawing
 *  their bars on different baselines. */
const LONG_RANGE_PREFIX_DAYS: Array<{ date: string; claude?: number; codex?: number; pi?: number }> = [
  // `claude: 0` is a day ccusage listed with nothing spent — the chart draws
  // it as a baseline stub, and it must stand on the same line as its neighbours.
  { date: "2026-05-20", claude: 18_000, codex: 6_000 },
  { date: "2026-05-21", claude: 0 },
  { date: "2026-05-22", claude: 7_500 },
  { date: "2026-05-25", claude: 26_000, codex: 11_000 },
  { date: "2026-05-26", claude: 0 },
  { date: "2026-05-27", claude: 3_200 },
  { date: "2026-05-28", codex: 5_000 },
  { date: "2026-05-29", claude: 41_000, codex: 9_000, pi: 4_000 },
  { date: "2026-06-01", claude: 12_000 },
  { date: "2026-06-02", claude: 0 },
  { date: "2026-06-03", claude: 2_100 },
  { date: "2026-06-04", codex: 9_000 },
  { date: "2026-06-05", claude: 31_000, codex: 14_000 },
  { date: "2026-06-08", claude: 0 },
  { date: "2026-06-09", claude: 5_400 },
  { date: "2026-06-11", claude: 4_000 },
  { date: "2026-06-12", claude: 22_000, codex: 7_000 },
  { date: "2026-06-16", pi: 6_000 },
  { date: "2026-06-17", claude: 48_000, codex: 22_000 },
  { date: "2026-06-18", claude: 0 },
  { date: "2026-06-22", claude: 9_000 },
  { date: "2026-06-24", claude: 9_500 },
  { date: "2026-06-25", claude: 0 },
  { date: "2026-06-26", claude: 15_000, codex: 3_000 },
  { date: "2026-06-29", claude: 66_000, codex: 8_000, pi: 3_000 },
  { date: "2026-06-30", claude: 1_800 },
];

const USAGE_HARNESS_NAME: Record<string, string> = { claude: "Claude Code", codex: "Codex", pi: "pi-agent" };

/** One `hub usage history --json` agent row, built off a `visualUsageScan()`
 *  daily row's own agent entry (see `usageAgentEntry`) — same numbers, same
 *  model, just reshaped into the ledger's camelCase `tokens` object and
 *  wrapped with provenance/coverage flags. */
function historyAgentFromScanAgent(
  agent: ReturnType<typeof usageAgentEntry>,
  provenance: "scanned" | "frozen",
  sessions?: number,
) {
  const tokens = {
    input: agent.inputTokens,
    output: agent.outputTokens,
    cacheCreation: agent.cacheCreationTokens,
    cacheRead: agent.cacheReadTokens,
    total: agent.totalTokens,
  };
  return {
    agent: agent.agent,
    name: USAGE_HARNESS_NAME[agent.agent] ?? agent.agent,
    provenance,
    source: "ccusage",
    tokens,
    costUsd: agent.totalCost,
    costKnown: true,
    splitKnown: true,
    models: [{ model: agent.modelsUsed[0] ?? null, tokens, costUsd: agent.totalCost, costKnown: true }],
    ...(sessions === undefined ? { sessionsKnown: false } : { sessions, sessionsKnown: true }),
  };
}

/** One `hub usage history --json` day, built off a `visualUsageScan()` daily
 *  row (`{period, totalTokens, totalCost, agents}`) — the SAME numbers a
 *  scanned-only fixture already renders, so the default `usage-success`
 *  scene never moves when history is wired in. */
function historyDayFromScanRow(
  dayRow: { period: string; totalTokens: number; totalCost: number; agents: ReturnType<typeof usageAgentEntry>[] },
  provenance: "scanned" | "frozen",
) {
  const agents = dayRow.agents.map((a) => historyAgentFromScanAgent(a, provenance, dayRow.period === "2026-08-28" ? undefined : a.agent === "claude" ? 2 : 1));
  const tokens = {
    input: agents.reduce((sum, a) => sum + a.tokens.input, 0),
    output: agents.reduce((sum, a) => sum + a.tokens.output, 0),
    cacheCreation: agents.reduce((sum, a) => sum + a.tokens.cacheCreation, 0),
    cacheRead: agents.reduce((sum, a) => sum + a.tokens.cacheRead, 0),
    total: dayRow.totalTokens,
  };
  const sessionsKnown = agents.every((agent) => agent.sessionsKnown === true);
  return {
    date: dayRow.period,
    provenance,
    tokens,
    costUsd: dayRow.totalCost,
    costKnown: true,
    splitKnown: true,
    agents,
    sessionsKnown,
    ...(sessionsKnown ? { sessions: agents.reduce((sum, agent) => sum + ("sessions" in agent ? agent.sessions ?? 0 : 0), 0) } : {}),
  };
}

/** A pre-import-era day: `claude` only, tokens-only (no cost, no split) —
 *  the shape `hub usage import-claude-stats` backfills from Claude Code's
 *  own `stats-cache.json`. */
function backfilledHistoryDay(date: string, claudeTokens: number) {
  const tokens = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, total: claudeTokens };
  return {
    date,
    provenance: "backfilled" as const,
    tokens,
    costUsd: 0,
    costKnown: false,
    splitKnown: false,
    agents: [
      {
        agent: "claude",
        name: "Claude Code",
        provenance: "backfilled" as const,
        source: "claude-stats-cache",
        tokens,
        costUsd: 0,
        costKnown: false,
        splitKnown: false,
        models: [{ model: null, tokens, costUsd: 0, costKnown: false }],
      },
    ],
  };
}

/** Keys `hub usage history --json` scales magnitudes under — the LEDGER's own
 *  camelCase shape (`tokens.{input,output,cacheCreation,cacheRead,total}` +
 *  `costUsd`), a sibling of `USAGE_SCALED_KEYS` above: the scan envelope and
 *  the history payload name the same concepts differently
 *  (`totalTokens`/`totalCost` vs `total`/`costUsd`), so one key set cannot
 *  cover both. Deliberately excludes `counts.*` and `claude_stats.
 *  importable_days` — those are DAY counts, not magnitudes, and share no key
 *  name with this set regardless. */
const USAGE_HISTORY_SCALED_KEYS = new Set(["input", "output", "cacheCreation", "cacheRead", "total", "costUsd"]);

/** Scales every `tokens.*`/`costUsd` field of a history payload (or any
 *  sub-tree of one) by `factor` — the `?usageBig=1` scene's history sibling
 *  of {@link scaleUsageScan}, so the KPI band, the chart and the sessions
 *  list agree on the same 5,600× magnitude (review W5). */
function scaleHistoryValue<T>(value: T, factor: number): T {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        out[k] =
          USAGE_HISTORY_SCALED_KEYS.has(k) && typeof val === "number"
            ? k === "costUsd" ? val * factor : Math.round(val * factor)
            : walk(val);
      }
      return out;
    }
    return v;
  };
  return walk(value) as T;
}

/** `hub usage history --json` fixture. Default: the SAME 14 days
 *  `visualUsageScan()` produces, all `"scanned"` — so no existing scene's
 *  numbers move now that the screen reads history instead of the scan.
 *  `?usageBackfilled=1`: a handful of pre-June backfilled (tokens-only) days
 *  plus one frozen ccusage day ahead of the same 14 recent scanned days —
 *  the mixed-provenance scene. `?usageBig=1`: the same days scaled 5,600×
 *  (review W5) so the KPI/chart/sessions magnitudes agree with the scaled
 *  scan `usage_load_latest_ccusage` already returns. `empty`: an empty-days
 *  payload for `?usageEmpty=1`/`?usageNoUsage=1` (review W5) —
 *  `importableDays` distinguishes the two: `usageEmpty` never ran a scan at
 *  all, so Claude Code's own stats are still a live, useful CTA; `usageNoUsage`
 *  already imported them. */
/** Appends one unpriced model (real tokens, `costUsd: 0`, `costKnown: true`)
 *  to the LAST day's `claude` agent — additive, same trick the session-level
 *  `?usageUnpriced=1` modelBreakdowns entry uses: the day/agent's own
 *  `tokens`/`costUsd` totals are untouched (KPI totals read those, not a sum
 *  of `models[]`), so this shows up ONLY in `Top models`/the KPI's unpriced
 *  count, never as a phantom addition to the headline numbers. Uses a model
 *  name (`claude-opus-5-1`) absent from the rest of the fixture, so it never
 *  collides with an already-priced row of the same name. */
function withUnpricedHistoryModel<T extends { agents: Array<{ agent: string; models: unknown[] }> }>(
  days: T[],
): T[] {
  if (days.length === 0) return days;
  const lastIndex = days.length - 1;
  return days.map((day, i) => {
    if (i !== lastIndex) return day;
    return {
      ...day,
      agents: day.agents.map((agent) =>
        agent.agent === "claude"
          ? {
              ...agent,
              models: [
                ...agent.models,
                {
                  model: "claude-opus-5-1",
                  tokens: { input: 3_500, output: 800, cacheCreation: 200, cacheRead: 500, total: 5_000 },
                  costUsd: 0,
                  costKnown: true,
                },
              ],
            }
          : agent,
      ),
    };
  });
}

const VISUAL_MODEL_MIX = [
  ["claude-sonnet-5", 0.27],
  ["claude-opus-5", 0.24],
  ["fable-5.1", 0.15],
  ["fable-5", 0.14],
  ["gpt-6-astra", 0.1],
  ["gpt-5.5", 0.1],
] as const;

/** Replaces each mock agent's single model with the six-category mix from
 *  the colour-collision report. Totals stay unchanged; this fixture exists
 *  only so the visual scene can pin the reported palette and hover state. */
function withVisualModelMix<T extends { agents: Array<{ tokens: { input: number; output: number; cacheCreation: number; cacheRead: number; total: number }; costUsd: number; models: unknown[] }> }>(
  days: T[],
): T[] {
  return days.map((day) => ({
    ...day,
    agents: day.agents.map((agent) => ({
      ...agent,
      models: VISUAL_MODEL_MIX.map(([model, share]) => ({
        model,
        tokens: {
          input: Math.round(agent.tokens.input * share),
          output: Math.round(agent.tokens.output * share),
          cacheCreation: Math.round(agent.tokens.cacheCreation * share),
          cacheRead: Math.round(agent.tokens.cacheRead * share),
          total: Math.round(agent.tokens.total * share),
        },
        costUsd: agent.costUsd * share,
        costKnown: true,
      })),
    })),
  }));
}

function usageHistoryPayload({
  backfilled = false,
  big = false,
  empty = false,
  long = false,
  importableDays = 64,
  modelMix = false,
  unpriced = false,
}: {
  backfilled?: boolean;
  big?: boolean;
  empty?: boolean;
  long?: boolean;
  importableDays?: number;
  modelMix?: boolean;
  unpriced?: boolean;
} = {}) {
  if (empty) {
    return {
      schema_version: 1,
      generated_at: "2026-09-04T12:00:00Z",
      horizon: "2026-08-21",
      since: null,
      until: null,
      days: [],
      counts: { days: 0, rows: 0, backfilled_days: 0, frozen_days: 0, scanned_days: 0 },
      claude_stats: {
        available: importableDays > 0,
        path: "~/.claude/stats-cache.json",
        importable_days: importableDays,
        last_computed: importableDays > 0 ? "2026-05-31" : null,
      },
      warnings: [],
    };
  }

  // `?usageLong=1`: the chart reads history, so the 40-column day axis the
  // chart-baseline e2e measures has to come from THIS payload, not the scan.
  const scanDaily = visualUsageScan({ long }).parsed.daily as Array<{
    period: string;
    totalTokens: number;
    totalCost: number;
    agents: ReturnType<typeof usageAgentEntry>[];
  }>;
  const scannedDays = scanDaily.map((row) => historyDayFromScanRow(row, "scanned"));

  const calendarDays = !backfilled && !long
    ? Array.from({ length: 40 }, (_, index) => {
        const date = new Date(Date.UTC(2025, 11, 1 + index * 7));
        if (index % 9 === 0 || date > new Date("2026-09-04T00:00:00Z")) return null;
        const totalTokens = index === 17 ? 900_000 : index === 31 ? 1_500_000 : index % 4 < 2 ? 48_000 : 72_000;
        return historyDayFromScanRow({
          period: date.toISOString().slice(0, 10),
          totalTokens,
          totalCost: totalTokens / 7_000,
          agents: [usageAgentEntry(index % 3 === 0 ? "codex" : "claude", totalTokens)],
        }, "frozen");
      }).filter((day): day is NonNullable<typeof day> => day !== null && !scannedDays.some((scanned) => scanned.date === day.date))
    : [];

  if (!backfilled) {
    const payload = {
      schema_version: 1,
      generated_at: "2026-09-04T12:00:00Z",
      horizon: "2026-08-21",
      since: null,
      until: null,
      days: unpriced
        ? withUnpricedHistoryModel([...calendarDays, ...scannedDays])
        : modelMix
          ? withVisualModelMix([...calendarDays, ...scannedDays])
          : [...calendarDays, ...scannedDays],
      counts: {
        days: calendarDays.length + scannedDays.length,
        rows: [...calendarDays, ...scannedDays].reduce((n, d) => n + d.agents.length, 0),
        backfilled_days: 0,
        frozen_days: 0,
        scanned_days: scannedDays.length,
      },
      claude_stats: {
        available: true,
        path: "~/.claude/stats-cache.json",
        importable_days: 64,
        last_computed: "2026-05-31",
      },
      warnings: [] as string[],
    };
    return big ? scaleHistoryValue(payload, 5_600) : payload;
  }

  const backfilledDays = [
    backfilledHistoryDay("2026-05-18", 42_000),
    backfilledHistoryDay("2026-05-24", 58_000),
    backfilledHistoryDay("2026-05-29", 33_500),
  ];
  const frozenDays = [
    historyDayFromScanRow(
      {
        period: "2026-06-12",
        totalTokens: 270_000,
        totalCost: 38.6,
        agents: [usageAgentEntry("claude", 210_000), usageAgentEntry("codex", 60_000)],
      },
      "frozen",
    ),
  ];
  const days = [...backfilledDays, ...frozenDays, ...scannedDays];
  return {
    schema_version: 1,
    generated_at: "2026-09-04T12:00:00Z",
    horizon: "2026-08-21",
    since: null,
    until: null,
    days,
    counts: {
      days: days.length,
      rows: days.reduce((n, d) => n + d.agents.length, 0),
      backfilled_days: backfilledDays.length,
      frozen_days: frozenDays.length,
      scanned_days: scannedDays.length,
    },
    claude_stats: {
      available: true,
      path: "~/.claude/stats-cache.json",
      importable_days: 0,
      last_computed: "2026-05-31",
    },
    warnings: [] as string[],
  };
}

function visualUsageScan({
  empty = false,
  totalTokens = 128_450,
  includeCodex = true,
  long = false,
  unpriced = false,
} = {}) {
  if (empty) {
    return {
      scanned_at: MOCK_SCANNED_AT,
      source: {
        command: "ccusage",
        args: ["--sections", "daily,weekly,monthly,session", "--by-agent", "--json"],
        resolved_from: "visual-mock",
      },
      raw: "",
      parsed: { daily: [], weekly: [], monthly: [], session: [], totals: { totalTokens: 0, totalCost: 0 } },
    };
  }

  // 14 days, claude every day, codex on most days, pi on a few — realistic
  // magnitudes: claude 40k-900k/day, codex 10k-300k/day, pi 5k-60k/day.
  // The default day-14 claude figure (900k) is overridable via `totalTokens`
  // (unused by any call site today; kept for API compatibility).
  const day14Claude = totalTokens === 128_450 ? 900_000 : totalTokens;
  const rawDays: Array<{ date: string; claude?: number; codex?: number; pi?: number }> = [
    ...(long ? LONG_RANGE_PREFIX_DAYS : []),
    { date: "2026-07-01", claude: 42_000, codex: 15_000 },
    { date: "2026-07-02", claude: 55_000, codex: 20_000, pi: 8_000 },
    { date: "2026-07-03", claude: 68_000 },
    { date: "2026-07-04", claude: 91_000, codex: 34_000 },
    { date: "2026-07-05", claude: 120_000, codex: 41_000 },
    { date: "2026-07-06", claude: 150_000, codex: 55_000 },
    { date: "2026-07-07", claude: 205_000, codex: 71_000, pi: 18_000 },
    { date: "2026-07-08", claude: 175_000, codex: 60_000 },
    { date: "2026-07-09", claude: 260_000 },
    { date: "2026-07-10", claude: 340_000, codex: 95_000, pi: 25_000 },
    { date: "2026-07-11", claude: 410_000, codex: 120_000 },
    { date: "2026-07-12", claude: 520_000, codex: 150_000 },
    { date: "2026-07-13", claude: 680_000, codex: 210_000 },
    { date: "2026-07-14", claude: day14Claude, codex: 300_000, pi: 60_000 },
  ];

  const daily = rawDays.map(({ date, claude, codex, pi }) => {
    const agents = [
      ...(claude !== undefined ? [usageAgentEntry("claude", claude)] : []),
      ...(includeCodex && codex !== undefined ? [usageAgentEntry("codex", codex)] : []),
      ...(pi !== undefined ? [usageAgentEntry("pi", pi)] : []),
    ];
    return {
      period: date,
      totalTokens: agents.reduce((sum, a) => sum + a.totalTokens, 0),
      totalCost: Math.round(agents.reduce((sum, a) => sum + a.totalCost, 0) * 100) / 100,
      agents,
    };
  });

  const allDailyAgents = daily.flatMap((d) => d.agents);
  const totals = {
    inputTokens: allDailyAgents.reduce((sum, a) => sum + a.inputTokens, 0),
    outputTokens: allDailyAgents.reduce((sum, a) => sum + a.outputTokens, 0),
    cacheCreationTokens: allDailyAgents.reduce((sum, a) => sum + a.cacheCreationTokens, 0),
    cacheReadTokens: allDailyAgents.reduce((sum, a) => sum + a.cacheReadTokens, 0),
    totalTokens: daily.reduce((sum, d) => sum + d.totalTokens, 0),
    totalCost: Math.round(daily.reduce((sum, d) => sum + d.totalCost, 0) * 100) / 100,
  };

  const allSessions = [
    // Claude 1 — kept byte-identical to the pre-existing fixture for its id,
    // cost, and metadata (asserted by LocalAgentUsage tests' path/label
    // expectations elsewhere), plus the new metadata contract layered on top.
    // The token SPLIT is now cache-heavy (~95.5/3/1.3/0.2%, same ratios as
    // `usageAgentEntry`) — this is the largest session by tokens, so it is
    // the one the default token-sort opens first, and its expanded detail is
    // what the `usage-session-detail` scene captures; it needs the zoom bar
    // to fire too. A single-model `modelBreakdowns` entry (same total, same
    // cost) replaces the plain `modelsUsed` so its own Models block renders
    // a real row instead of the plain-list fallback.
    {
      agent: "claude",
      period: "591ce7a6-72cc-4d7e-b6ca-3b6f7d7c3e2f",
      inputTokens: 200,
      outputTokens: 1_300,
      cacheCreationTokens: 3_000,
      cacheReadTokens: 95_500,
      totalTokens: 100_000,
      totalCost: 14.28,
      modelBreakdowns: [
        {
          modelName: "claude-sonnet-4",
          inputTokens: 200,
          outputTokens: 1_300,
          cacheCreationTokens: 3_000,
          cacheReadTokens: 95_500,
          totalTokens: 100_000,
          cost: 14.28,
        },
      ],
      metadata: { lastActivity: "2026-07-14T20:41:00Z",
        projectPath: "/Users/alice/private/skill-tree",
        title: "Snippets screen redesign",
        titleSource: "custom",
        gitBranch: "design/snippets",
        prNumber: 90,
        prUrl: "https://github.com/acme/skill-tree/pull/90",
        toolCalls: 212,
        toolBreakdown: { Bash: 169, Read: 24, Edit: 12, Write: 8, Agent: 5, Grep: 4 },
        linesAdded: 2_529,
        linesRemoved: 1_421,
        durationMs: 5_268_720,
        hubProject: "skill-tree",
      },
    },
    // Claude 2 — second custom title, same PR, second "skill-tree" hub project.
    {
      agent: "claude",
      period: "f6e53a79-e8fa-4e45-9c71-1d4d37556f39",
      inputTokens: 38_000,
      outputTokens: 8_200,
      cacheCreationTokens: 2_600,
      cacheReadTokens: 1_900,
      totalTokens: 50_700,
      totalCost: 7.24,
      modelsUsed: ["claude-sonnet-4"],
      metadata: { lastActivity: "2026-07-13T18:02:00Z",
        projectPath: "/Users/alice/private/skill-tree",
        title: "Snippet applied locations follow-up",
        titleSource: "custom",
        gitBranch: "design/snippets",
        prNumber: 90,
        prUrl: "https://github.com/acme/skill-tree/pull/90",
        toolCalls: 76,
        linesAdded: 412,
        linesRemoved: 88,
        durationMs: 1_380_000,
        hubProject: "skill-tree",
      },
    },
    // Claude 3 — AI-generated title, notes-vault hub project, two-model split.
    {
      agent: "claude",
      period: "1dae0a69-6f00-4109-ab1c-873861269996",
      inputTokens: 61_000,
      outputTokens: 14_000,
      cacheCreationTokens: 4_400,
      cacheReadTokens: 3_100,
      totalTokens: 82_500,
      totalCost: 11.62,
      modelBreakdowns: [
        {
          modelName: "claude-sonnet-5",
          inputTokens: 45_000,
          outputTokens: 10_000,
          cacheCreationTokens: 3_200,
          cacheReadTokens: 2_200,
          totalTokens: 60_400,
          cost: 8.4,
        },
        {
          modelName: "claude-opus-5",
          inputTokens: 16_000,
          outputTokens: 4_000,
          cacheCreationTokens: 1_200,
          cacheReadTokens: 900,
          totalTokens: 22_100,
          cost: 3.22,
        },
        // `?usageUnpriced=1`: a model with real tokens but no price in the
        // current table — reads as an "unpriced" tag, never a fabricated
        // "$0.00" (DESIGN-usage-numbers §R3). A name absent from the rest of
        // the fixture (`claude-opus-5-1`, not the already-priced
        // `claude-opus-5` two entries up) so a priced and an unpriced row
        // never share one display name in the same list.
        ...(unpriced
          ? [
              {
                modelName: "claude-opus-5-1",
                inputTokens: 5_000,
                outputTokens: 1_200,
                cacheCreationTokens: 400,
                cacheReadTokens: 300,
                totalTokens: 6_900,
                cost: 0,
              },
            ]
          : []),
      ],
      metadata: { lastActivity: "2026-07-12T09:30:00Z",
        projectPath: "/Users/alice/private/notes-vault",
        title: "Sync engine race condition investigation",
        titleSource: "ai",
        gitBranch: "fix/sync-race",
        toolCalls: 145,
        linesAdded: 903,
        linesRemoved: 512,
        durationMs: 3_040_000,
        hubProject: "notes-vault",
      },
    },
    // Claude 4 — no title, no branch, no PR, no hub project.
    {
      agent: "claude",
      period: "c30a87fd-40d9-4596-9466-26d47ebd7e55",
      inputTokens: 22_000,
      outputTokens: 5_100,
      cacheCreationTokens: 1_400,
      cacheReadTokens: 1_100,
      totalTokens: 29_600,
      totalCost: 4.23,
      modelsUsed: ["claude-sonnet-4"],
      metadata: { lastActivity: "2026-07-10T15:12:00Z",
        projectPath: "/Users/alice/private/scratch-notes",
        toolCalls: 58,
        linesAdded: 210,
        linesRemoved: 64,
        durationMs: 980_000,
      },
    },
    // Codex 1 — plain projectPath, no hub project.
    {
      agent: "codex",
      period: "2026/07/14/rollout-2026-07-14T21-15-00-019fd809-2012-7ef2-8cfb-91696cccd6f4",
      inputTokens: 31_000,
      outputTokens: 8_400,
      cacheCreationTokens: 2_100,
      cacheReadTokens: 3_500,
      totalTokens: 45_000,
      totalCost: 4.37,
      modelsUsed: ["gpt-5.5"],
      metadata: {
        lastActivity: "2026-07-14T21:15:00Z",
        projectPath: "/Users/alice/private/codex-lab",
        toolCalls: 63,
        reasoningOutputTokens: 3_100,
      },
    },
    // Codex 2 — two-model split, hub project match.
    {
      agent: "codex",
      period: "2026/07/11/rollout-2026-07-11T11-45-00-019fc2a1-77b0-7c11-9a10-2b6e3f0d81aa",
      inputTokens: 19_000,
      outputTokens: 5_600,
      cacheCreationTokens: 1_500,
      cacheReadTokens: 1_900,
      totalTokens: 28_000,
      totalCost: 2.72,
      modelBreakdowns: [
        {
          modelName: "gpt-5.5",
          inputTokens: 13_000,
          outputTokens: 3_800,
          cacheCreationTokens: 1_000,
          cacheReadTokens: 1_200,
          totalTokens: 19_000,
          cost: 1.84,
        },
        {
          modelName: "gpt-5.4-mini",
          inputTokens: 6_000,
          outputTokens: 1_800,
          cacheCreationTokens: 500,
          cacheReadTokens: 700,
          totalTokens: 9_000,
          cost: 0.88,
        },
      ],
      metadata: {
        lastActivity: "2026-07-11T11:45:00Z",
        projectPath: "/Users/alice/private/skill-tree",
        toolCalls: 140,
        toolBreakdown: { exec_command: 300, apply_patch: 40 },
        reasoningOutputTokens: 2_050,
        hubProject: "skill-tree",
      },
    },
    // Codex 3 — kept byte-identical to the pre-existing fixture, + toolCalls.
    {
      agent: "codex",
      period: "2026/07/09/rollout-2026-07-09T16-20-00-019fb7e4-3c55-7d02-8e21-5a9c0d1e2f33",
      inputTokens: 19_200,
      outputTokens: 6_250,
      cacheCreationTokens: 1_100,
      cacheReadTokens: 1_900,
      totalTokens: 28_450,
      totalCost: 2.76,
      modelsUsed: ["gpt-5.5"],
      metadata: { lastActivity: "2026-07-09T16:20:00Z", projectPath: "/Users/alice/private/codex-lab", toolCalls: 51 },
    },
    // Pi 1 — ccusage's dash-encoded projectPath form.
    {
      agent: "pi",
      period: "019dc116-ce45-75b8-9b8f-5c111698ec77",
      inputTokens: 4_200,
      outputTokens: 900,
      cacheCreationTokens: 300,
      cacheReadTokens: 600,
      totalTokens: 6_000,
      totalCost: 0.31,
      modelsUsed: ["pi-default"],
      metadata: { lastActivity: "2026-07-08T13:05:00Z", projectPath: "--Users-alice-private-notes-vault--", toolCalls: 22 },
    },
    // Two Claude sessions whose project path matches a mock REGISTRY project
    // (`/Users/dev/projects/…`, distinct from the `/Users/alice/private/…`
    // paths above, which never match anything) — the Harnesses screen's USED
    // BY chip ordering needs at least one real match to demonstrate
    // "most recent first". Distinct `metadata.lastActivity` so ordering is
    // photographable.
    {
      agent: "claude",
      period: "2026-07-15T09:00:00Z",
      inputTokens: 8_000,
      outputTokens: 1_800,
      cacheCreationTokens: 600,
      cacheReadTokens: 300,
      totalTokens: 10_700,
      totalCost: 1.12,
      modelsUsed: ["claude-sonnet-4"],
      metadata: { lastActivity: "2026-07-15T09:20:00Z", projectPath: "/Users/dev/projects/moon-base-android-client", toolCalls: 18 },
    },
    {
      agent: "claude",
      period: "2026-07-13T14:00:00Z",
      inputTokens: 5_200,
      outputTokens: 1_100,
      cacheCreationTokens: 400,
      cacheReadTokens: 200,
      totalTokens: 6_900,
      totalCost: 0.74,
      modelsUsed: ["claude-sonnet-4"],
      metadata: { lastActivity: "2026-07-13T14:35:00Z", projectPath: "/Users/dev/Dev/.skill-hub", toolCalls: 11 },
    },
  ];
  // `allSessions`'s per-entry `metadata` shape varies (title/branch/PR on
  // some, none of that on others), so TS infers a big, exact-shaped union
  // for its element type. The two flags below need a strictly WIDER shape
  // (an `Unregistered` session that omits `projectPath` entirely, a rewrite
  // that overwrites `hubProject` uniformly) than any single union member
  // allows, so `sessions` is re-typed here to the loose shape every
  // downstream reader (`normalizeUsage.ts`, which treats `parsed: unknown`)
  // already tolerates — the cast is a widening, never a narrowing.
  interface ScanSessionEntry {
    agent: string;
    period: string;
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    totalTokens: number;
    totalCost: number;
    modelsUsed?: string[];
    modelBreakdowns?: Array<Record<string, unknown>>;
    metadata: Record<string, unknown>;
  }
  let sessions = allSessions.filter((s) => includeCodex || s.agent !== "codex") as unknown as ScanSessionEntry[];

  // The inspection journeys need ledger rows that join the generated
  // inspection index. Keep the ordinary visual scan byte-stable and opt into
  // the real captured identities only when the browser explicitly asks for
  // the inspection fixture. This changes ccusage row identity only; all
  // inspection fields still come from `inspection-session.json`.
  if (sceneFlag("inspection")) {
    let mappedClaude = false;
    let mappedCodex = false;
    sessions = sessions.map((entry) => {
      if (entry.agent === "claude" && !mappedClaude) {
        mappedClaude = true;
        return { ...entry, period: INSPECTION_SESSION,
          ...(["complete", "partial"].includes(sceneValue("usageTokens") ?? "") ? { inputTokens: 800, outputTokens: 20, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 820, modelBreakdowns: [{ modelName: "claude-sonnet-4", inputTokens: 800, outputTokens: 20, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 820, cost: entry.totalCost }] } : {}),
        };
      }
      if (entry.agent === "codex" && !mappedCodex) {
        mappedCodex = true;
        return { ...entry, period: CODEX_INSPECTION_SESSION };
      }
      return entry;
    });
  }

  if (["complete", "partial"].includes(sceneValue("usageTokens") ?? "")) sessions = sessions.filter((entry) => entry.period === INSPECTION_SESSION);

  if (sceneFlag("projectSessions")) {
    sessions = sessions.map((session) => {
      const claude = session.period === "591ce7a6-72cc-4d7e-b6ca-3b6f7d7c3e2f";
      const codex = session.period.endsWith("019fd809-2012-7ef2-8cfb-91696cccd6f4");
      return claude || codex ? { ...session, metadata: { ...session.metadata,
        hubProject: "moon-base", title: claude ? "Review project navigation" : "Unify the Usage session list",
        gitBranch: claude ? "fix/project-navigation" : "feat/shared-sessions",
        lastActivity: claude ? "2026-09-10T10:00:00Z" : "2026-09-14T18:00:00Z",
      } } : session;
    });
  }

  // `?usageDrilldown=1` (design D14.4) — the fixture's `hubProject` values
  // ("skill-tree", "notes-vault") are not registry keys in the mock
  // registry (which holds "example-app"/"moon-base"), so under the G3 link
  // rule NO Overview project row could ever link in any mock, journey or
  // scene. Rewriting one field under a flag keeps every other scene
  // byte-identical.
  if (sceneFlag("usageDrilldown")) {
    sessions = sessions.map((s) =>
      s.period === "1dae0a69-6f00-4109-ab1c-873861269996"
        ? { ...s, metadata: { ...s.metadata, hubProject: "moon-base" } }
        : s,
    );
  }

  // `?usageUnregistered=1` (design D14.4) — every fixture session above
  // carries a `metadata.projectPath`, so there is no "No project"/
  // `Unregistered` total to render a bucket from. This adds exactly one
  // session with neither `projectPath` nor `hubProject`.
  if (sceneFlag("usageUnregistered")) {
    sessions = [
      ...sessions,
      {
        agent: "claude",
        period: "b7a1c2d3-9e4f-4a5b-8c6d-7e8f9a0b1c2d",
        inputTokens: 900,
        outputTokens: 200,
        cacheCreationTokens: 100,
        cacheReadTokens: 50,
        totalTokens: 1_250,
        totalCost: 0.14,
        modelsUsed: ["claude-sonnet-4"],
        metadata: { lastActivity: "2026-07-10T08:00:00Z", toolCalls: 3 },
      },
    ];
  }

  if (sceneFlag("pickerMany")) {
    const pickerProjects = ["alpha-console", "beta-lab", "gamma-tools", "delta-api", "epsilon-web", "zeta-mobile", "eta-data", "theta-cli", "a-long-project-name-for-search"];
    for (const project of pickerProjects) {
      registry.projects[project] ??= { path: `/Users/dev/projects/${project}`, bundles: [], enabled: [], harnesses: ["claude-code"] };
    }
    sessions = [
      ...sessions,
      ...pickerProjects.map((hubProject, index) => ({
        agent: "claude",
        period: `picker-${index}`,
        inputTokens: 10_000 + index * 1_000,
        outputTokens: 2_000,
        cacheCreationTokens: 500,
        cacheReadTokens: 300,
        totalTokens: 12_800 + index * 1_000,
        totalCost: 1 + index * 0.35,
        modelsUsed: ["claude-sonnet-4"],
        // Yesterday, so the picker has candidates in every overview range, 7 days included.
        metadata: { lastActivity: new Date(Date.now() - 86_400_000).toISOString(), projectPath: `/Users/dev/projects/${hubProject}`, hubProject, toolCalls: 8 },
      })),
    ];
  }

  return {
    scanned_at: MOCK_SCANNED_AT,
    source: {
      command: "ccusage",
      args: ["--sections", "daily,weekly,monthly,session", "--by-agent", "--json"],
      resolved_from: "visual-mock",
    },
    raw: "",
    parsed: {
      daily,
      weekly: [],
      monthly: [],
      session: sessions,
      totals,
    },
  };
}

/** Small opt-in family fixture for the usage identity journey. The default
 * visual scan stays byte-stable; this scene replaces only Codex rows and
 * leaves Claude rows untouched so regression checks can compare both. */
function codexFamiliesUsageScan() {
  const scan = visualUsageScan();
  const parsed = scan.parsed as { session: Array<Record<string, unknown>> };
  const family = [
    { id: CODEX_INSPECTION_SESSION, inputTokens: 50_000, outputTokens: 20_000, totalTokens: 70_000, totalCost: 7, metadata: { title: sceneFlag("longSessionTitles") ? "$plan-it Support invocation modes in Codex wherever their native capabilities allow, and make the actual behavior transparent to users. Keep every workflow understandable." : "Usage identity rollout", titleSource: "native" } },
    { id: "22222222-2222-4222-8222-222222222222", inputTokens: 14_000, outputTokens: 6_000, totalTokens: 20_000, totalCost: 2, metadata: { parentSessionId: CODEX_INSPECTION_SESSION, agentRole: "planner", agentNickname: "Scout" } },
    { id: "33333333-3333-4333-8333-333333333333", inputTokens: 5_000, outputTokens: 3_000, totalTokens: 8_000, totalCost: 0.8, metadata: { parentSessionId: "22222222-2222-4222-8222-222222222222", agentRole: "tester" } },
  ];
  let index = 0;
  const sessions = parsed.session.map((session) => {
    if (session.agent !== "codex") return session;
    const member = family[index++ % family.length];
    return { ...session, period: `2026/07/14/rollout-${member.id}`, inputTokens: member.inputTokens, outputTokens: member.outputTokens, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: member.totalTokens, totalCost: member.totalCost, modelsUsed: ["gpt-5.5"], modelBreakdowns: [{ modelName: "gpt-5.5", inputTokens: member.inputTokens, outputTokens: member.outputTokens, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: member.totalTokens, cost: member.totalCost }], metadata: { ...(session.metadata as Record<string, unknown>), ...member.metadata, hubProject: "skill-tree", projectPath: "/Users/alice/private/skill-tree", toolCalls: 10, toolBreakdown: { exec_command: 7, apply_patch: 3 } } };
  });
  sessions.push({
    agent: "codex",
    period: "2026/07/13/rollout-44444444-4444-4444-8444-444444444444",
    inputTokens: 4_000, outputTokens: 1_000, cacheCreationTokens: 0, cacheReadTokens: 0,
    totalTokens: 5_000, totalCost: 0.25, modelsUsed: ["gpt-5.5"],
    metadata: { title: "Orphan agent", parentSessionId: "missing-parent-id", agentRole: "reviewer" },
  });
  return { ...scan, parsed: { ...(scan.parsed as Record<string, unknown>), session: sessions } };
}

/** A stale-ONLY sync envelope: one project synced ok but the registry sha has
 *  since changed, and NO error project — so the aggregate StatusBar chip resolves
 *  to `stale` ("registry changed — re-sync") rather than `error`. */
const staleSyncReportEnvelope = {
  report: {
    schema_version: 1,
    generated_at: "2026-07-05T14:32:10Z",
    registry_sha256:
      "synced1111111111111111111111111111111111111111111111111111111111",
    registry_mtime: 1751725930.482,
    ok: true,
    global: {
      skipped: [],
      skills: { writes: 9, removed: 0 },
      mcp: { writes: 1, removed: 0 },
      permissions: { ok: true, errors: [] },
      remotes: { attempted: 1, alarming: 0 },
    },
    projects: {
      "moon-base": {
        ts: "2026-07-05T14:32:10Z",
        ok: true,
        errors: [],
        writes: 6,
        removed: 0,
        affinity_skips: [],
      },
    },
  },
  registry_current: {
    sha256: "current999999999999999999999999999999999999999999999999999999999",
    mtime: 1751726500.113,
  },
};

/** A remote-doctor rollup carrying one DANGER finding (host-key mismatch = MITM)
 *  for hermes-main, so the list-level banner + the detail Risks section render. */
const remoteDoctorDanger = {
  findings: [
    {
      remote: "hermes-main",
      code: "host-key-mismatch",
      severity: "danger" as const,
      detail:
        "Live host key SHA256:LIVEmismatchLIVEmismatchLIVEmismatch00 does not match the pinned SHA256:PINnedPINnedPINnedPINnedPINnedPIN00; sync will hard-fail.",
    },
  ],
  danger_count: 1,
};

// ─── Hooks (hooks-surface D7) — stateful mock backend ────────────────────────
// A mutable module-level store so a journey attaches/detaches/edits and re-reads
// realistically (the module reloads per page navigation, so state resets between
// tests — same contract the sub-agents store relies on). Shapes mirror
// useHooks.ts (HookRow / HookShow) EXACTLY so the real screens run unmodified.
interface MockHookScript {
  source: "managed" | "repo";
  path?: string | null;
  interpreter: string;
  args?: string | null;
}

/** One file inside a built-in hook's dir (Wave B — `show --json`'s `builtin`). */
interface MockHookBuiltinFile {
  name: string;
  path: string;
  body: string | null;
}

interface MockHookBuiltinInfo {
  dir: string;
  files: MockHookBuiltinFile[];
}

/** Wave D — the script a plain command hook's command line references. */
interface MockHookCommandScriptLocation {
  project: string | null;
  path: string;
  exists: boolean;
  body: string | null;
  reason: string | null;
}
interface MockHookCommandScript {
  token: string;
  kind: "absolute" | "home" | "relative";
  locations: MockHookCommandScriptLocation[];
}
interface MockHookRepoScriptConversion {
  interpreter: string;
  path: string;
  args: string;
}

interface MockHookDef {
  name: string;
  provenance: "user" | "builtin";
  event: string;
  command: string;
  description: string;
  tools: string[];
  matcher: string;
  timeout: number | null;
  harnesses: string[] | null;
  settings: Record<string, unknown>;
  project_settings: Record<string, Record<string, unknown>>;
  attached_global: boolean;
  attached_projects: string[];
  /** hook-editor-redesign D3: mutually exclusive with a non-empty `command`. */
  script?: MockHookScript | null;
  /** Managed scripts only — the body `hook script show` reads back off disk. */
  script_body?: string | null;
}

function seedHooks(): MockHookDef[] {
  return [
    {
      name: "lsp-report",
      provenance: "builtin",
      event: "PostToolUse",
      command: "python3 lsp_report.py --config lsp-report.json",
      description: "One-shot language diagnostics after file edits",
      tools: ["Edit", "Write", "MultiEdit"],
      matcher: "",
      timeout: null,
      harnesses: null,
      settings: {
        languages: {
          python: { enabled: true, mode: "advisory", timeout: 30 },
          go: { enabled: true, mode: "advisory", timeout: 30 },
          typescript: { enabled: false, mode: "advisory", timeout: 30 },
          rust: { enabled: false, mode: "advisory", timeout: 30 },
        },
      },
      project_settings: {},
      attached_global: true,
      attached_projects: [],
    },
    {
      name: "notify-on-stop",
      provenance: "user",
      event: "Stop",
      command: "say done",
      description: "Announce when the agent stops.",
      tools: [],
      matcher: "",
      timeout: 30,
      harnesses: ["claude-code"],
      settings: {},
      project_settings: {},
      attached_global: false,
      attached_projects: ["example-app"],
    },
    {
      // A MANAGED-script hook (hook-editor-redesign D3) so the editor's script
      // editor, the `script:managed` library discriminator and the destructive
      // mode-switch confirm all have something real to render.
      name: "format-on-write",
      provenance: "user",
      event: "PostToolUse",
      command: "",
      description: "Format files the agent writes.",
      tools: ["Write", "Edit"],
      matcher: "",
      timeout: null,
      harnesses: null,
      settings: {},
      project_settings: {},
      attached_global: false,
      attached_projects: ["example-app", "moon-base"],
      script: { source: "managed", interpreter: "bash", args: "--quiet" },
      script_body:
        "#!/usr/bin/env bash\n# Format every file the agent just wrote.\nset -euo pipefail\n\nfor f in $CLAUDE_FILE_PATHS; do\n  prettier --write \"$f\" || true\ndone\n",
    },
    {
      // A plain COMMAND hook whose command names a repo script (Wave D — read
      // the script behind a command hook + offer to convert it). Attached to
      // TWO projects directly (not global) so `command_script` has a real
      // "one present, one missing" pair to show.
      name: "lint-on-edit",
      provenance: "user",
      event: "PostToolUse",
      command: "bash scripts/lint.sh --fix",
      description: "Lint the files the agent edits.",
      tools: ["Edit", "Write"],
      matcher: "",
      timeout: null,
      harnesses: null,
      settings: {},
      project_settings: {},
      attached_global: false,
      attached_projects: ["example-app", "moon-base"],
    },
    // `ships_with` (D1/A11) companion hooks — orchestrate-advanced's three
    // declared hooks. The real CLI creates a hook DEFINITION on first
    // `--with-companions` apply (`_hook_new`, description "Shipped by
    // <skill>"); the mock instead seeds all three UNATTACHED so the Hooks
    // library and `shipped by orchestrate-advanced` (read from the
    // project-independent mirror, never the ledger — A11) render whether or
    // not any project has actually provisioned them yet. `attached_projects`
    // gains the project name once a live `--with-companions` equip runs (see
    // the `enable`/`disable` ships_with arm below).
    {
      name: "orch-scope-guard",
      provenance: "user",
      event: "PreToolUse",
      command: "scripts/scope-guard.sh",
      description: "Shipped by orchestrate-advanced",
      tools: ["Edit", "Write", "MultiEdit", "Bash"],
      matcher: "",
      timeout: null,
      harnesses: null,
      settings: {},
      project_settings: {},
      attached_global: false,
      attached_projects: [],
    },
    {
      name: "orch-report-guard",
      provenance: "user",
      event: "SubagentStop",
      command: "scripts/report-guard.sh",
      description: "Shipped by orchestrate-advanced",
      tools: [],
      matcher: "",
      timeout: null,
      harnesses: null,
      settings: {},
      project_settings: {},
      attached_global: false,
      attached_projects: [],
    },
    {
      name: "orch-unit-brief",
      provenance: "user",
      event: "SubagentStart",
      command: "scripts/unit-brief.sh",
      description: "Shipped by orchestrate-advanced",
      tools: [],
      matcher: "",
      timeout: null,
      harnesses: null,
      settings: {},
      project_settings: {},
      attached_global: false,
      attached_projects: [],
    },
  ];
}

let hooksStore: MockHookDef[] = seedHooks();
// Share attention fixtures with the editor so a queue action opens the named hook.
if (sceneFlag("hooksAttention")) hooksStore.push({
            name: "audit-bash",
            provenance: "user",
            event: "PreToolUse",
            command: "sudo -n journalctl -n 1",
            description: "Audit recent journal entries before a risky command.",
            tools: [],
            matcher: "",
            timeout: null,
            harnesses: null,
            settings: {},
            project_settings: {},
            attached_global: false,
            attached_projects: [],
          });

/** Absolute path a managed script would live at (mirrors hook_scripts.py). */
function managedScriptPath(h: MockHookDef): string {
  const ext = h.script?.interpreter === "python3" ? "py" : "sh";
  return `/Users/alice/.skill-hub/hooks/${h.name}/script.${ext}`;
}

/** The 2-line stub `hook_scripts.default_stub()` seeds whenever a hook becomes
 *  managed. Mirrored verbatim so the mock cannot show a body shape the real CLI
 *  never writes. */
function managedScriptStub(name: string, interpreter: string): string {
  return interpreter === "python3"
    ? `#!/usr/bin/env python3\n"""${name} — managed hook script."""\n`
    : `#!/usr/bin/env bash\n# ${name} — managed hook script.\n`;
}

// ─── Wave B: `baked_command` + `builtin` (hook show --json) ─────────────────
// Mirrors `hub_cli/hook.py`'s `_hook_baked_command` / `_hook_builtin_info`: the
// command line the harness actually receives after sync, and — for the ONE
// provenance-`builtin` hook — its real, read-only source files.

const BUILTIN_LSP_DIR =
  "/Applications/Skill Tree.app/Contents/Resources/hub/hooks/lsp-report";

const BUILTIN_LSP_BAKED_COMMAND =
  "'/Applications/Skill Tree.app/Contents/Resources/python/bin/python3' " +
  `'${BUILTIN_LSP_DIR}/lsp_report.py' ` +
  "--config '/Users/alice/.skill-hub/state/hooks/lsp-report.global.json'";

// A representative excerpt of the real `hooks/lsp-report/lsp_report.py` (the
// shebang + its full module docstring), not the whole ~600-line file — the
// point is to prove the editor renders REAL bytes, not a fabricated stand-in.
const LSP_REPORT_PY_BODY =
  "#!/usr/bin/env python3\n" +
  '"""Built-in ``lsp-report`` hook — one-shot per-language diagnostics after edits.\n' +
  "\n" +
  "STDLIB-ONLY (no third-party imports) so it runs under any resolved interpreter\n" +
  "with zero dependencies. Invoked as a PostToolUse command hook on claude-code and\n" +
  "codex; the same stdin/stdout contract works on both.\n" +
  "\n" +
  "Contract (hooks-surface spec builtin-lsp-hook / design D5):\n" +
  "  1. Read the hook payload JSON from stdin.\n" +
  "  2. ``--config <path>`` → load per-language {enabled, mode, timeout} config.\n" +
  "  3. Per-harness input resolver → the SET of edited files.\n" +
  "  4. Filter to files under ``cwd``; drop vendored/generated dirs.\n" +
  "  5. Detect language by extension; skip languages disabled in config.\n" +
  "  6. Single-flight lock per (project, language) — a concurrent invocation for\n" +
  "     the same key SKIPS and notes the skip (never double-runs a checker).\n" +
  "  7. Run the one-shot checker (python: ruff [+pyright]; typescript: tsc\n" +
  "     --noEmit; rust: cargo check; go: gopls check). A missing checker binary\n" +
  "     is a SILENT no-op (doctor surfaces it at sync time).\n" +
  "  8. Timeouts are reported honestly (never claim a clean result).\n" +
  "  9. Aggregate into a report capped at ~4KB (truncation stated in the text).\n" +
  " 10. Delivery: advisory ⇒ exit 0 + hookSpecificOutput.additionalContext;\n" +
  "     blocking ⇒ exit 2 + stderr, phrased as an interrupt the agent must\n" +
  "     address (the edit already happened).\n" +
  ' 11. Clean ⇒ exit 0, no output.\n"""\n' +
  "\n" +
  "from __future__ import annotations\n" +
  "\n" +
  "import hashlib\n" +
  "import json\n" +
  "import os\n" +
  "import shutil\n" +
  "import subprocess\n" +
  "import sys\n";

// The real `hooks/lsp-report/hook.yaml`, verbatim (see docstring above for why
// its `command:` is a placeholder — `baked_command` above is what actually runs).
const LSP_REPORT_HOOK_YAML =
  "# Built-in `lsp-report` hook (hooks-surface D5 / spec builtin-lsp-hook).\n" +
  "#\n" +
  "# One-shot per-language diagnostics after a file edit. Resolved by name at\n" +
  "# runtime with provenance: builtin (never stored in registry.yaml). The DIR name\n" +
  "# `lsp-report` is authoritative — a `name:` key here would be ignored.\n" +
  "#\n" +
  "# NOTE on `command`: this is a TEMPLATE / placeholder. At sync time hub REWRITES\n" +
  "# the command per scope — baking the resolved absolute Python interpreter and\n" +
  "# the absolute `--config <data_home>/state/hooks/lsp-report.<scope>.json` path.\n" +
  "description: \"One-shot language diagnostics after file edits\"\n" +
  "event: PostToolUse\n" +
  "tools:\n" +
  "  - Edit\n" +
  "  - Write\n" +
  "  - MultiEdit\n" +
  'command: "python3 lsp_report.py --config lsp-report.json"\n' +
  "settings:\n" +
  "  languages:\n" +
  "    python:\n" +
  "      enabled: true\n" +
  "      mode: advisory\n" +
  "      timeout: 30\n" +
  "    go:\n" +
  "      enabled: true\n" +
  "      mode: advisory\n" +
  "      timeout: 30\n" +
  "    typescript:\n" +
  "      enabled: false\n" +
  "      mode: advisory\n" +
  "      timeout: 30\n" +
  "    rust:\n" +
  "      enabled: false\n" +
  "      mode: advisory\n" +
  "      timeout: 30\n";

/** For a provenance-`builtin` hook only: its readable dir + files. `null` for a
 *  user hook. */
function builtinInfoFor(h: MockHookDef): MockHookBuiltinInfo | null {
  if (h.provenance !== "builtin") return null;
  if (h.name !== "lsp-report") return { dir: BUILTIN_LSP_DIR, files: [] };
  return {
    dir: BUILTIN_LSP_DIR,
    files: [
      { name: "lsp_report.py", path: `${BUILTIN_LSP_DIR}/lsp_report.py`, body: LSP_REPORT_PY_BODY },
      { name: "hook.yaml", path: `${BUILTIN_LSP_DIR}/hook.yaml`, body: LSP_REPORT_HOOK_YAML },
    ],
  };
}

// A ~10-line representative bash body for the `lint-on-edit` seed hook's repo
// script — only `example-app` carries it; `moon-base` is missing it on disk.
const LINT_ON_EDIT_SCRIPT_BODY =
  "#!/usr/bin/env bash\n" +
  "set -euo pipefail\n" +
  "\n" +
  "# Lint every file the agent just edited.\n" +
  "for f in $CLAUDE_FILE_PATHS; do\n" +
  '  eslint --fix "$f" || true\n' +
  "done\n";

/** Wave D: the script a plain command hook's command line references. Only the
 *  `lint-on-edit` seed hook has one — every other hook (built-in, script-backed,
 *  a one-liner like `say done`) returns `null`. */
function commandScriptFor(h: MockHookDef): MockHookCommandScript | null {
  if (h.name !== "lint-on-edit") return null;
  return {
    token: "scripts/lint.sh",
    kind: "relative",
    locations: [
      {
        project: "example-app",
        path: "/Users/alice/dev/example-app/scripts/lint.sh",
        exists: true,
        body: LINT_ON_EDIT_SCRIPT_BODY,
        reason: null,
      },
      {
        project: "moon-base",
        path: "/Users/alice/dev/moon-base/scripts/lint.sh",
        exists: false,
        body: null,
        reason: null,
      },
    ],
  };
}

/** Wave D: a hand-written `<interpreter> <repo path> [args]` command hook,
 *  ready to convert. Only `lint-on-edit` offers one. */
function repoScriptConversionFor(h: MockHookDef): MockHookRepoScriptConversion | null {
  if (h.name !== "lint-on-edit") return null;
  return { interpreter: "bash", path: "scripts/lint.sh", args: "--fix" };
}

/** The bundled interpreter `hook_scripts.resolve_interpreter` bakes for
 *  `python3` — a packaged app has no system python, so the real absolute
 *  bundled path (quoted: it contains spaces) is what a python3 script
 *  actually receives. `bash` is left bare, resolved from PATH at run time. */
const BUNDLED_PYTHON3 =
  "/Applications/Skill Tree.app/Contents/Resources/python/bin/python3";

function resolvedInterpreter(interpreter?: string): string {
  return interpreter === "python3" ? `'${BUNDLED_PYTHON3}'` : "bash";
}

/** The command line the harness actually receives after sync, at the GLOBAL
 *  scope — mirrors `_hook_baked_command` / `hook_scripts.script_command`. */
function bakedCommandFor(h: MockHookDef): string | null {
  if (h.provenance === "builtin") {
    return h.name === "lsp-report" ? BUILTIN_LSP_BAKED_COMMAND : h.command;
  }
  if (h.script?.source === "managed") {
    const args = h.script.args ? ` ${h.script.args}` : "";
    return `${resolvedInterpreter(h.script.interpreter)} '${managedScriptPath(h)}'${args}`;
  }
  if (h.script?.source === "repo") {
    const args = h.script.args ? ` ${h.script.args}` : "";
    return `${resolvedInterpreter(h.script.interpreter)} '${h.script.path ?? ""}'${args}`;
  }
  return h.command;
}

/** The `action` discriminator `hub hook list --json` rows carry. */
function hookAction(h: MockHookDef): string {
  return h.script ? `script:${h.script.source}` : "command";
}

// Default probe verdicts (matches the pre-refactor inline map): claude-code +
// codex supported, opencode unsupported. `?hookCapsVaried=1` swaps in a matrix
// that exercises ALL four verdicts so the reach-badge state palette is proven.
const HOOK_REACH_DEFAULT: Record<string, string> = {
  "claude-code": "supported",
  codex: "supported",
  opencode: "unsupported",
};

const hookCapsDefault = {
  schema_version: 1,
  probed_at: "2026-07-14T00:00:00Z",
  harnesses: {
    "claude-code": {
      harness_id: "claude-code",
      verdict: "supported",
      reason: "Claude Code is installed; command hooks are supported.",
      extra: {},
    },
    codex: {
      harness_id: "codex",
      verdict: "supported",
      reason: "`codex features list` reports the hooks feature enabled.",
      extra: {},
    },
    opencode: {
      harness_id: "opencode",
      verdict: "unsupported",
      reason: "LSP available but off by default; plugins not hub-managed.",
      extra: { lsp_state: "disabled" },
    },
    pi: {
      harness_id: "pi",
      verdict: "unsupported",
      reason: "pi hooks are unsupported in v1 (no native hooks; shim not hub-managed).",
      extra: { shim: "shim_not_detected" },
    },
  },
};

// Capability matrix hitting each of the four verdicts once (Task 5.6.3 badge
// palette). not_installed harnesses (pi) are OMITTED from the badges by design.
const hookCapsVaried = {
  schema_version: 1,
  probed_at: "2026-07-14T00:00:00Z",
  harnesses: {
    "claude-code": {
      harness_id: "claude-code",
      verdict: "supported",
      reason: "Claude Code is installed; command hooks are supported.",
      extra: {},
    },
    codex: {
      harness_id: "codex",
      verdict: "feature_off",
      reason:
        "Codex is installed but the hooks feature is off — run `codex features enable hooks`.",
      extra: { feature: "hooks" },
    },
    opencode: {
      harness_id: "opencode",
      verdict: "unsupported",
      reason: "LSP available but off by default; plugins not hub-managed.",
      extra: { lsp_state: "disabled" },
    },
    pi: {
      harness_id: "pi",
      verdict: "not_installed",
      reason: "pi is not installed on this machine.",
      extra: {},
    },
  },
};

// `?hookDoctorFindings=1` scene (hooks-screen-polish Wave C) — three severities
// on one list, each attributed to one of the seed hooks above.
const HOOK_DOCTOR_FINDINGS = [
  {
    hook: "format-on-write",
    scope: "registry",
    harness: "",
    code: "HOOK_SCRIPT_MISSING",
    severity: "warning" as const,
    explanation:
      "A hook's script file is missing — a managed body was deleted outside Skill Tree, or a repo script does not exist in a project the hook is attached to.",
    detail: "format-on-write: managed script missing at ~/.skill-hub/hooks/format-on-write/script.sh",
  },
  {
    hook: "lsp-report",
    scope: "global",
    harness: "claude-code",
    code: "LSP_CHECKER_MISSING",
    severity: "info" as const,
    explanation:
      "A language is enabled for the lsp-report hook but its checker binary is not on PATH — that language is a silent runtime no-op.",
    detail: "lsp-report [claude-code]: typescript checker 'tsc' not found on PATH",
  },
  {
    hook: "notify-on-stop",
    scope: "global",
    harness: "claude-code",
    code: "HOOK_RUNS_SUDO",
    severity: "danger" as const,
    explanation: "Hook command invokes sudo. Hub-managed hooks must not require elevated privileges.",
    detail: "notify-on-stop (Stop): sudo say done",
  },
];

/** D16: a companion hook this scene hides never resolves, even though the
 *  store still carries its definition — so `/hook/:name` really 404s for it
 *  (via `hook_show`, below) and every other caller (edit/delete/attach/…)
 *  sees no such hook either. */
function findMockHook(name: string | undefined): MockHookDef | undefined {
  if (name && companionHidden(name)) return undefined;
  return hooksStore.find((h) => h.name === name);
}

/** Recursively merge `patch` into `target` in place (mirrors set-settings). */
function deepMergeInto(
  target: Record<string, unknown>,
  patch: Record<string, unknown>,
): void {
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const existing = target[k];
      const next =
        existing && typeof existing === "object" && !Array.isArray(existing)
          ? (existing as Record<string, unknown>)
          : {};
      target[k] = next;
      deepMergeInto(next, v as Record<string, unknown>);
    } else {
      target[k] = v;
    }
  }
}

/** Strip the store's internal `project_settings` / raw script body for a
 *  `hook list` row, and stamp the CLI's `action` discriminator. */
function toHookRow(h: MockHookDef) {
  const { project_settings: _ps, script_body: _sb, ...row } = h;
  void _ps;
  void _sb;
  return { ...row, action: hookAction(h), baked_command: bakedCommandFor(h) };
}

function dispatch(cmd: string, args?: Record<string, unknown>): unknown {
  if (typeof window !== "undefined") window.__invokeCalls.push({ cmd, args });
  // Record every hook_* IPC call so e2e journeys can assert the mutation fired
  // with the expected args (there is no other in-browser call channel).
  if (cmd.startsWith("hook_") && typeof window !== "undefined") {
    const w = window as unknown as {
      __hookCalls?: Array<{ cmd: string; args?: Record<string, unknown> }>;
    };
    (w.__hookCalls ??= []).push({ cmd, args });
  }
  if (cmd.startsWith("subagent_")) {
    // Scene: force a genuinely empty sub-agent list so the empty state renders
    // (the default codex store is populated). Applies only to the list read.
    if (cmd === "subagent_list" && sceneFlag("subagentsEmpty")) {
      const scope = (args?.scope as string) ?? "user";
      const project = (args?.project as string | null) ?? null;
      const harness = (args?.harnessId as string) ?? "claude-code";
      return {
        harness,
        scope,
        project,
        agents_dir:
          harness === "codex"
            ? "/Users/dev/.codex/agents"
            : "/Users/dev/.claude/agents",
        settings_path: harness === "codex" ? "" : "/Users/dev/.claude/settings.json",
        agents: [],
        builtins: [],
        links_warning: null,
      };
    }
    return dispatchSubagent(cmd, args);
  }
  switch (cmd) {
    // ── Boot gate ──
    case "check_python":
      return !sceneFlag("pythonError");
    case "runtime_preflight":
      if (sceneFlag("feedbackLoading")) return new Promise(() => {});
      // Scene: a failed runtime preflight → App renders the PythonError card.
      if (sceneFlag("pythonError")) {
        return { ok: false, reason: "no-python", detail: null, python: null };
      }
      return { ok: true, reason: "none", detail: null, python: "/usr/bin/python3" };
    case "bootstrap_check":
      // Scene: the app-level bootstrap query REJECTS (runtime healthy) → the
      // PythonError card renders the honest "Couldn't initialize" error state.
      if (sceneFlag("screenError")) {
        return Promise.reject(
          new Error(
            "registry.yaml is unreadable: mapping values are not allowed here (line 12, column 8)",
          ),
        );
      }
      // Scene: a healthy but un-bootstrapped install → the BootstrapWizard.
      if (sceneFlag("bootstrap")) {
        return {
          needs_bootstrap: true,
          completed_at: null,
          version: 1,
          legacy_detected: [],
          data_home: "/Users/dev/.skill-hub",
          code_home: "/Users/dev/code/skill-hub",
          candidates: [
            {
              origin: "claude-code",
              name: "brainstorm",
              path: "/Users/dev/.claude/skills/brainstorm",
              description: "Spin up a team of expert agents to brainstorm.",
              version: "1.2.0",
              category: "NEW",
            },
            {
              origin: "codex",
              name: "code-review",
              path: "/Users/dev/.codex/skills/code-review",
              description: "Review the current diff for correctness bugs.",
              version: "1.1.0",
              category: "NEW",
            },
          ],
          conflicts: [],
          blocked: [],
          already_managed: [],
          silent_skip: [],
        };
      }
      return {
        needs_bootstrap: false,
        completed_at: "2026-06-20T18:33:00Z",
        version: 1,
        legacy_detected: [],
        data_home: "/Users/dev/.skill-hub",
        code_home: "/Users/dev/code/skill-hub",
        candidates: [],
        conflicts: [],
        blocked: [],
        already_managed: [],
        silent_skip: [],
      };
    case "bootstrap_run":
      return undefined;

    // ── Registry / harnesses ──
    case "read_registry": {
      ensureRecoveryFixture();
      if (sceneFlag("navSearch")) {
        for (let i = 1; i <= 9; i += 1) {
          registry.bundles[`search-bundle-${i}`] ??= { icon: "📦", skills: [], description: "Navigator search fixture" };
        }
      }
      if (sceneFlag("missingSkills")) {
        for (const [name, description] of Object.entries({
          "review-helper": "Check changes for defects before delivery.",
          "delivery-helper": "Prepare a change for review and publication.",
          "test-helper": "Verify observable behavior with regression tests.",
        })) {
          registry.skills[name] ??= { ...registry.skills["needs-global"], description };
        }
      }
      // Scene: an empty registry so the Library renders its empty state.
      if (sceneFlag("libraryEmpty")) return emptyRegistry();
      // ?contextAttention=1 — two dropped-upstream skills (one renamed, one
      // deleted) + a bundle listing a missing member, for the Context group's
      // attention plaque AND the Sources card's "Dropped upstream" block.
      // Mutates the LIVE registry (idempotently) rather than the clone below,
      // so `archive`/`unarchive`/`source recover` — which also mutate it —
      // stay in sync with every subsequent read.
      ensureContextAttentionFixtures();
      ensureClassificationFixtures();
      ensurePlaybookFixtures();
      ensurePickerManyFixtures();
      // Return a fresh clone so in-place mutations (equip, override, set-meta)
      // are seen as changed data by react-query's structural sharing → the
      // subscribing screens actually re-render on invalidate.
      const out = structuredClone(registry);
      // ?guardrailsAttention=1 — BOTH twins (see permissions_show above).
      if (sceneFlag("guardrailsAttention") && out.permissions_global) {
        out.permissions_global._unmanaged = ["codex"];
        out.permissions_global.approval_policy = "never";
        out.permissions_global.sandbox_mode = "danger-full-access";
      }
      // ?usedByMany=1 — six extra projects (claude-code is on the global
      // switch here) so a Harnesses card's USED BY compartment has to
      // truncate, for the harnesses-used-by-many scene.
      if (sceneFlag("usedByMany")) {
        for (const name of [
          "atlas",
          "beacon",
          "comet",
          "dune",
          "ember",
          "flint",
        ]) {
          out.projects[name] = {
            path: `/Users/dev/projects/${name}`,
            bundles: [],
            enabled: [],
          };
        }
      }
      // ?companionsProvisioned=1 — the moon-base `ships_with` ledger (D4).
      // Default OFF: un-provisioned is the baseline, so `via orchestrate-advanced`
      // appears only when a scene/test opts in. Mutates the CLONE (`out`), never
      // the live `registry`, so every other read still sees the un-provisioned
      // state.
      if (sceneFlag("companionsProvisioned")) {
        const proj = out.projects["moon-base"];
        if (proj) {
          proj.companions = { "orchestrate-advanced": COMPANIONS_PROVISIONED_LEDGER_ENTRY };
        }
      }
      // ?companionsPending=1 — the Loadout's `COMPANIONS_PENDING` banner
      // (A16/D11, wave 2 wave D): `orchestrate-advanced` is declared AND
      // equipped on moon-base but has NO ledger entry yet — the pending case,
      // paired with the matching `sync_report` branch below (this scene never
      // combines with `?companionsProvisioned=1`, which puts a full ledger in
      // place instead — the two together would be self-contradictory).
      // Mutates the CLONE only, same posture as the block above.
      if (sceneFlag("companionsPending")) {
        const proj = out.projects["moon-base"];
        if (proj && !proj.enabled.includes("orchestrate-advanced")) {
          proj.enabled = [...proj.enabled, "orchestrate-advanced"];
        }
      }
      return out;
    }
    case "read_search_corpus":
      return searchCorpus;
    case "sync_report": {
      // Default: all-ok/fresh so the StatusBar chip reads "in sync" everywhere.
      // Scene flags opt into the non-happy paths:
      //   ?staleReport=1 → stale-only ("registry changed — re-sync")
      //   ?syncError=1   → an error project ("last sync failed") + a stale project
      //   ?elsewhereAttention=1 → alarmed remotes + a resolved backup slot
      //   ?remotesSkipped=1     → the post-equip auto-sync steady state
      //   ?mcpBlocked=1         → context7's claude-code row reads BLOCKED
      if (sceneFlag("missingSkills")) {
        const refs = ["needs-global", "review-helper", "delivery-helper", "test-helper"].filter((name) => !registry.projects["moon-base"].enabled.includes(name));
        return {
          ...syncReportEnvelope,
          report: {
            ...syncReportEnvelope.report,
            projects: {
              ...syncReportEnvelope.report.projects,
              "moon-base": {
                ...syncReportEnvelope.report.projects["moon-base"],
                missing_refs: [{ skill: "rt-android-expert", refs }, { skill: "brainstorm", refs: refs.filter((name) => name === "review-helper") }].filter((record) => record.refs.length > 0),
              },
            },
          },
        };
      }
      if (sceneFlag("attentionQueue")) {
        const envelope = structuredClone(syncErrorEnvelope);
        return {
          ...envelope,
          report: {
            ...envelope.report,
            global: { ...envelope.report.global, skills: { ...envelope.report.global.skills, skipped_unowned: 4 } },
            projects: Object.fromEntries(Object.entries(envelope.report.projects).map(([name, record]) => [name, {
              ...record,
              missing_refs: [{ skill: "android-compose-ui", refs: ["needs-global", "code-review"] }],
            }])),
          },
        };
      }
      if (sceneFlag("staleReport")) return staleSyncReportEnvelope;
      if (sceneFlag("syncErrorLong")) {
        const envelope = structuredClone(syncErrorEnvelope);
        envelope.report.projects["example-app"].errors = Array.from({ length: 24 }, (_, index) =>
          ["symlink", "invocation"].map((stage) => ({ stage, message: `source missing: /Users/dev/.skill-hub/sources/pstack/worktree/skill-${index + 1}` })),
        ).flat();
        return envelope;
      }
      if (sceneFlag("syncError")) return syncErrorEnvelope;
      if (sceneFlag("mcpBlocked")) {
        return {
          ...syncReportEnvelope,
          report: {
            ...syncReportEnvelope.report,
            projects: {
              ...syncReportEnvelope.report.projects,
              "example-app": {
                ...syncReportEnvelope.report.projects["example-app"],
                mcp_delivery: [
                  {
                    harness: "claude-code",
                    adapter: "claude",
                    scope: "project:example-app",
                    server: "context7",
                    target_file: "/Users/dev/projects/example-app/.mcp.json",
                    state: "blocked",
                    reason: "claude_project_not_approved",
                    detail: null,
                  },
                  syncReportEnvelope.report.projects["example-app"].mcp_delivery![1],
                ],
              },
            },
          },
        };
      }
      if (sceneFlag("elsewhereAttention")) {
        return {
          ...syncReportEnvelope,
          report: {
            ...syncReportEnvelope.report,
            global: {
              ...syncReportEnvelope.report.global,
              remotes: { attempted: 2, alarming: 1 },
              backup: {
                ran: true,
                skipped: null,
                committed: true,
                pushed: false,
                conflict: false,
                error: null,
                error_kind: null,
                at: "2026-07-05T14:32:10Z",
              },
            },
          },
        };
      }
      if (sceneFlag("remotesSkipped")) {
        return {
          ...syncReportEnvelope,
          report: {
            ...syncReportEnvelope.report,
            global: {
              ...syncReportEnvelope.report.global,
              skipped: ["remotes"],
              remotes: { attempted: 0, alarming: 0 },
            },
          },
        };
      }
      // ?companionsPending=1 (A16/D11, wave 2 wave D) — pairs with the
      // matching `read_registry` branch above (which equips
      // `orchestrate-advanced` on moon-base with no ledger entry): the I7
      // reconcile record this scene's last sync would have produced,
      // evidence for the Loadout's `COMPANIONS_PENDING` banner.
      if (sceneFlag("companionsPending")) {
        return {
          ...syncReportEnvelope,
          report: {
            ...syncReportEnvelope.report,
            projects: {
              ...syncReportEnvelope.report.projects,
              "moon-base": {
                ...syncReportEnvelope.report.projects["moon-base"],
                companions: {
                  pending: ["orchestrate-advanced"],
                  stale_removed: [],
                  reattached: [],
                  drift: [],
                  missing_refs: [],
                },
              },
            },
          },
        };
      }
      return syncReportEnvelope;
    }
    case "usage_load_latest_ccusage":
      if (sceneFlag("usageEmpty")) return null;
      if (sceneFlag("codexFamilies")) return codexFamiliesUsageScan();
      // Real corpora run to tens of billions of tokens and thousands of
      // dollars; this scene proves the hero tiles survive those widths.
      if (sceneFlag("usageBig")) return scaleUsageScan(visualUsageScan(), 5_600);
      // A 40+ day axis: label thinning in play, gap days as stubs.
      if (sceneFlag("usageLong")) return visualUsageScan({ long: true });
      // A model with tokens but no price in the current price table.
      if (sceneFlag("usageUnpriced")) return visualUsageScan({ unpriced: true });
      if (sceneFlag("usageNoUsage")) return visualUsageScan({ empty: true });
      if (sceneFlag("usageAccessError")) return Promise.reject("permission denied reading /Users/alice/.claude/projects");
      if (sceneFlag("usageFailure")) {
        return Promise.reject({
          kind: "process_failure",
          message: "ccusage could not complete the local scan.",
          diagnostic: "Command: ccusage --sections daily,weekly,monthly,session --by-agent --json\nError: fixture process exited with code 1",
        });
      }
      return visualUsageScan();
    case "usage_scan_ccusage":
      // `?usageEmpty=1` — capture-on-open now auto-fires a scan the instant
      // the cached-scan query settles with a null cache (see
      // `useCaptureOnOpen.ts`), which made the old "no cached scan yet"
      // first-run state transient: the mocked scan used to resolve and the
      // screen moved on before a screenshot could land. Never resolving
      // (mirrors `?syncHangs=1`) photographs the ONE state that scene can
      // honestly claim: the first scan in flight.
      if (sceneFlag("usageEmpty")) return new Promise<never>(() => {});
      if (sceneFlag("scanRecoveryHeaderBusy")) {
        return new Promise((resolve) => setTimeout(() => resolve(visualUsageScan()), 900));
      }
      if (sceneFlag("codexFamilies")) return codexFamiliesUsageScan();
      if (sceneFlag("usageLong")) return visualUsageScan({ long: true });
      if (sceneFlag("usageNoUsage")) return visualUsageScan({ empty: true });
      if (sceneFlag("usageAccessError")) return Promise.reject("permission denied reading /Users/alice/.claude/projects");
      if (sceneFlag("usageFailure")) {
        return Promise.reject({
          kind: "process_failure",
          message: "ccusage could not complete the local scan.",
          diagnostic: "Command: ccusage --sections daily,weekly,monthly,session --by-agent --json\nError: fixture process exited with code 1",
        });
      }
      return visualUsageScan();
    case "usage_pricing_info":
      // Read by the Usage screen's Prices popover (`useUsagePricingInfo.ts`).
      // Mirrors the four models the checked-in
      // `ccusage-pricing.json` overrides.
      return {
        ccusage_version: "20.0.17",
        offline: true,
        overrides_path: "/Applications/Skill Tree.app/Contents/Resources/hub/ccusage-pricing.json",
        overrides: [
          { model: "claude-fable-5-1", input: 0.00001, output: 0.00005, cache_write: 0.0000125, cache_read: 0.00000025 },
          { model: "claude-opus-5", input: 0.000005, output: 0.000025, cache_write: 0.00000625, cache_read: 0.0000005 },
          { model: "claude-sonnet-5", input: 0.000002, output: 0.00001, cache_write: 0.0000025, cache_read: 0.0000002 },
          { model: "gpt-6-astra", input: 0.00001, output: 0.00005, cache_write: 0.0000125, cache_read: 0.000001 },
        ],
      };
    case "harness_list":
      return harnessList.map((h) => {
        const nativeScene = sceneValue("invocationNative");
        if (nativeScene) {
          const installed = nativeScene === "all" || nativeScene !== "none" && h.id === (nativeScene.startsWith("opencode") ? "opencode" : "codex");
          return { ...h, installed };
        }
        const scene = sceneFlag("agentsAttention") && h.id === "opencode"
          ? { ...h, on_globally: true, installed: false } : h;
        return { ...scene, on_globally: harnessGlobalOverrides.get(h.id) ?? scene.on_globally };
      });
    case "harness_set_global":
      if (sceneFlag("settingsWriteFails")) throw new Error("Could not save settings. Try again.");
      harnessGlobalOverrides.set(args?.id as string, args?.enabled as boolean);
      return undefined;
    case "harness_open_dir":
      return undefined;
    case "global_doc_read": {
      const gid = (args?.harnessId as string) ?? "claude-code";
      const sourceId = docSharingSourceId(gid);
      const entry = GLOBAL_DOCS[sourceId] ?? {
        path: `/Users/dev/.${gid}/AGENTS.md`,
        content: "",
      };
      const ownEntry = GLOBAL_DOCS[gid] ?? entry;
      return {
        path: ownEntry.path,
        resolved_path: entry.path,
        is_link: sourceId !== gid,
        exists: entry.content !== "",
        content: entry.content,
        sha256: entry.content === "" ? null : "sha-loaded",
      };
    }
    case "global_doc_write": {
      // Write through a follower straight to the SOURCE's own bytes — a
      // symlinked doc has none of its own (mirrors the real Rust write, which
      // resolves through the link before it touches disk).
      const gid = (args?.harnessId as string) ?? "claude-code";
      const sourceId = docSharingSourceId(gid);
      if (GLOBAL_DOCS[sourceId]) {
        GLOBAL_DOCS[sourceId] = {
          ...GLOBAL_DOCS[sourceId],
          content: (args?.content as string) ?? "",
        };
      }
      return { sha256: "sha-written" };
    }

    // ── Sources via hub_cmd ──
    case "hub_cmd": {
      const cmdArgs = (args?.args as string[] | undefined) ?? [];
      if (cmdArgs[0] === "project" && cmdArgs[1] === "worktree-defaults") {
        if (sceneFlag("settingsReadFails") && cmdArgs[2] !== "set") throw new Error("Could not read worktree defaults.");
        if (sceneFlag("settingsWriteFails") && cmdArgs[2] === "set") throw new Error("Could not save worktree defaults.");
        const payload = mockWorktreeDefaults(cmdArgs);
        return { success: payload.ok, output: JSON.stringify(payload) };
      }
      if (cmdArgs[0] === "remote" && cmdArgs[1] === "machine") {
        const payload = mockHeadlessMachines(cmdArgs);
        return { success: true, output: JSON.stringify(payload) };
      }
      if (cmdArgs[0] === "remote" && cmdArgs[1] === "delivery") {
        return { success: true, output: JSON.stringify(mockRemoteDelivery(cmdArgs)) };
      }
      if (cmdArgs[0] === "remote" && cmdArgs[1] === "defaults") {
        const payload = mockRemoteDefaults(cmdArgs);
        return { success: payload.ok, output: JSON.stringify(payload) };
      }
      if (cmdArgs[0] === "project" && cmdArgs[1] === "repository") {
        const payload = mockProjectRepository(cmdArgs);
        return { success: payload.ok, output: JSON.stringify(payload) };
      }
      // See `read_registry`: whichever call reaches this first seeds the
      // dropped-upstream fixtures into the live registry (idempotent).
      ensureContextAttentionFixtures();
      if (cmdArgs[0] === "skill" && cmdArgs[1] === "refs" && cmdArgs.includes("--json")) {
        ensureClassificationFixtures();
        return { success: true, output: JSON.stringify(classificationGraph()) };
      }
      // Canonical source-owned skill agent read/save. This mirrors the real
      // CLI's exit-0 verdict payload and keeps the draft across route changes.
      if (cmdArgs[0] === "skill" && cmdArgs[1] === "companions" && cmdArgs[2] === "agent") {
        const skillName = cmdArgs[3] ?? "";
        const agentName = cmdArgs[cmdArgs.indexOf("--agent") + 1] ?? "";
        const key = `${skillName}/${agentName}`;
        const doc = sourceAgentDocs.get(key);
        if (!doc) {
          return { success: true, output: JSON.stringify({ ok: false, error: `source agent '${agentName}' was not found` }) };
        }
        return { success: true, output: JSON.stringify(doc) };
      }
      if (cmdArgs[0] === "skill" && cmdArgs[1] === "companions" && cmdArgs[2] === "save-agent") {
        const skillName = cmdArgs[3] ?? "";
        const agentName = cmdArgs[cmdArgs.indexOf("--agent") + 1] ?? "";
        const bodyIdx = cmdArgs.indexOf("--json-body");
        const raw = bodyIdx >= 0 ? cmdArgs[bodyIdx + 1] : undefined;
        const key = `${skillName}/${agentName}`;
        const previous = sourceAgentDocs.get(key);
        if (!previous) return { success: true, output: JSON.stringify({ ok: false, error: "source agent was not found" }) };
        if (sceneFlag("agentSaveFails") || sceneFlag("sourceAgentSaveFails")) {
          return { success: true, output: JSON.stringify({ ok: false, error: "source agent changed on disk", conflict: true }) };
        }
        let payload: { expected_hash?: string; description?: string; body?: string; harnesses?: MockSkillAgent["harnesses"] };
        try { payload = JSON.parse(raw ?? "") as typeof payload; } catch { return { success: true, output: JSON.stringify({ ok: false, error: "invalid --json-body" }) }; }
        if (payload.expected_hash !== previous.hash) {
          return { success: true, output: JSON.stringify({ ok: false, error: "source agent changed on disk", conflict: true }) };
        }
        const next: MockSkillAgent = {
          ...previous,
          description: payload.description ?? previous.description,
          body: payload.body ?? previous.body,
          harnesses: {
            "claude-code": { model: payload.harnesses?.["claude-code"]?.model ?? "" },
            codex: {
              model: payload.harnesses?.codex?.model ?? "",
              model_reasoning_effort: payload.harnesses?.codex?.model_reasoning_effort ?? "",
            },
          },
          hash: `${previous.hash}-saved`,
        };
        sourceAgentDocs.set(key, next);
        return { success: true, output: JSON.stringify({ ...next, reconcile: {} }) };
      }
      // `hub new skill|mcp <name> --type … --scope … --description …` — the
      // create-then-follow-up flow's first step (NewSkillSheet.handleSubmit).
      // Registers the entry directly in the mock registry so the very next
      // `read_registry` (which the sheet awaits before it closes) already
      // carries it — without this, the bundle's pending member row (and the
      // `?pendingBundleAdd=1` scene) has nothing to render, since a bundle's
      // member list is registry names filtered to `registry.skills`. Mirrors
      // the real `cmd_new`'s directory-exists guard so a retried submit
      // cannot silently duplicate.
      if (cmdArgs[0] === "new" && (cmdArgs[1] === "skill" || cmdArgs[1] === "mcp")) {
        const name = cmdArgs[2];
        if (!name || registry.skills[name]) {
          return { success: false, output: `error: '${name}' already exists` };
        }
        const type = (flagValue(cmdArgs, "--type") ??
          (cmdArgs[1] === "mcp" ? "mcp-server" : "claude-skill")) as Skill["type"];
        const scope = (flagValue(cmdArgs, "--scope") ?? "global") as Skill["scope"];
        registry.skills[name] = {
          version: "0.1.0",
          description: flagValue(cmdArgs, "--description") ?? "",
          source: `~/.skill-hub/skills/${name}`,
          type,
          scope,
          upstream: null,
          managed: "local",
        };
        return { success: true, output: "" };
      }
      // `?equipHangs=1` mirrors `?syncHangs=1`/`?archiveHangs=1` — never
      // resolve, so an EquipPicker row's in-flight state (R7: aria-busy, the
      // rune trace, the Spinner in place of the Toggle) can be photographed.
      // Covers every verb the picker's `onToggle` handlers call: bundle
      // membership (`bundle update --skills`) and skill↔project equip
      // (`enable`/`disable`).
      if (
        sceneFlag("equipHangs") &&
        (cmdArgs[0] === "enable" ||
          cmdArgs[0] === "disable" ||
          (cmdArgs[0] === "bundle" && cmdArgs[1] === "update"))
      ) {
        return new Promise<never>(() => {});
      }
      // `hub source dropped …` — read-only, never mutates.
      if (cmdArgs[0] === "source" && cmdArgs[1] === "dropped") {
        return { success: true, output: droppedSkillsPayload(cmdArgs) };
      }
      // `hub source recover NAME` (Keep as local).
      if (cmdArgs[0] === "source" && cmdArgs[1] === "recover") {
        return sourceRecoverPayload(cmdArgs[2]);
      }
      // `hub archive NAME [NAME…]` (Archive / Forget). `?archiveHangs=1`
      // mirrors `?syncHangs=1` — never resolves, so the LOCKED page (aria-busy,
      // disabled actions, the loading-label buttons) can be photographed.
      // `?archiveFails=1` exercises the failure path (a stale double-archive,
      // say) — no registry mutation, a real non-zero exit.
      if (cmdArgs[0] === "archive") {
        if (sceneFlag("archiveHangs")) return new Promise<never>(() => {});
        if (sceneFlag("archiveFails")) {
          const names = cmdArgs.slice(1).filter((a) => a !== "--json" && a !== "--dry-run");
          return {
            success: false,
            output:
              `error: already archived (pending undo record) for: ${names.join(", ")}` +
              ` — run \`hub unarchive ${names[0] ?? ""}\` first`,
          };
        }
        return archivePayload(cmdArgs);
      }
      // `hub unarchive NAME [NAME…]` (the archive Undo).
      if (cmdArgs[0] === "unarchive") {
        return unarchivePayload(cmdArgs);
      }
      // `hub mcp show|check` (read-only) and `hub mcp set` (the plain-argv
      // save path — the credential/stdin path goes through the SEPARATE
      // `mcp_set_json` Tauri command, never through here).
      if (cmdArgs[0] === "mcp") {
        const sub = cmdArgs[1];
        const name = cmdArgs[2];
        if (sub === "show") {
          const entry = registry.skills[name];
          if (!entry) return { success: false, output: `unknown MCP server '${name}'` };
          const payload = {
            ok: true,
            name,
            scope: entry.scope ?? "portable",
            description: entry.description ?? "",
            harnesses: entry.harnesses ?? null,
            spec: entry.mcp ?? {},
            secret_refs: [],
            literal_secret_keys: [],
            equipped: { projects: [], bundles: [], remotes: [], cloud: [] },
            resolved: [],
            // `null` until a `Check` click has run in THIS page session — the
            // module-level map below is what `McpCapabilitiesBlock`'s own
            // `qk.mcpShow` read needs to see the catalogue summary after a
            // check (plans/G.md §6.4: it never reads the live probe query
            // `McpDeliveryBlock` owns).
            last_probe: mcpLastProbeByName.get(name) ?? null,
          };
          return { success: true, output: JSON.stringify(payload) };
        }
        if (sub === "check") {
          if (sceneFlag("mcpProbeHangs")) return new Promise<never>(() => {});
          const checkedAt = "2026-09-06T12:00:00Z";
          if (sceneFlag("mcpProbeFails")) {
            const row = {
              name,
              transport: "http",
              state: "unreachable",
              tool_count: null,
              tools: [],
              latency_ms: null,
              protocol_version: null,
              unresolved_refs: [],
              env_from_shell: true,
              error: "Connection refused",
              checked_at: checkedAt,
              // No catalogue call happens on a non-"ok" state (plans/G.md §4).
              catalog: null,
            };
            mcpLastProbeByName.set(name, row);
            return { success: true, output: JSON.stringify({ ...row, ok: false }) };
          }
          // Default (an "ok" probe result) — folds in the catalogue summary
          // (plans/G.md §6, rev 3 §11), picked the same way the `mcp catalog`
          // handler below picks its full record, so the two always describe
          // the same server. There is no `?mcpProbeOk` scene flag: "ok" is
          // what a probe returns unless `mcpProbeFails`/`mcpProbeHangs` says
          // otherwise below.
          const variant = mcpCatalogVariant();
          const row = {
            name,
            transport: "http",
            state: "ok",
            tool_count: 4,
            tools: ["search_docs", "get_page", "list_versions", "resolve_ref"],
            latency_ms: 187,
            protocol_version: "2024-11-05",
            unresolved_refs: [],
            env_from_shell: true,
            error: null,
            checked_at: checkedAt,
            catalog: mcpCatalogSummaryForVariant(variant),
          };
          mcpLastProbeByName.set(name, row);
          return { success: true, output: JSON.stringify({ ...row, ok: true }) };
        }
        if (sub === "catalog") {
          const variant = mcpCatalogVariant();
          if (variant === "missing") {
            return {
              success: false,
              output: JSON.stringify({
                ok: false,
                error: `no stored catalogue for '${name}' — check again to read it`,
                code: "no_catalog",
              }),
            };
          }
          const record = { ...mcpCatalogRecordForVariant(variant), name, fetched_at: "2026-09-06T12:00:00Z" };
          return { success: true, output: JSON.stringify({ ok: true, catalog: record }) };
        }
        if (sub === "set") {
          if (sceneFlag("mcpSetFails")) {
            return { success: false, output: `error: '${name}' looks like it carries a literal secret value` };
          }
          const entry = registry.skills[name];
          if (!entry || entry.type !== "mcp-server") {
            return { success: false, output: `unknown MCP server '${name}'` };
          }
          const priorBlock: Record<string, unknown> = { ...(entry.mcp ?? {}) };
          const block: Record<string, unknown> = { ...priorBlock };
          const argValues: string[] = [];
          for (let i = 3; i < cmdArgs.length; i++) {
            const a = cmdArgs[i];
            if (a === "--transport") block.transport = cmdArgs[++i];
            else if (a === "--url") block.url = cmdArgs[++i];
            else if (a === "--command") block.command = cmdArgs[++i];
            else if (a === "--arg") argValues.push(cmdArgs[++i]);
            else if (a === "--cwd") block.cwd = cmdArgs[++i];
            else if (a === "--timeout-ms") block.timeout_ms = Number(cmdArgs[++i]);
          }
          if (argValues.length > 0) block.args = argValues;
          // A transport swap drops the stale other-half fields — mirrors the
          // real CLI's `_spec_from_flags` (review W4).
          if (cmdArgs.includes("--transport")) {
            if (block.transport === "stdio") {
              delete block.url;
              delete block.headers;
            } else {
              delete block.command;
              delete block.args;
              delete block.env;
            }
          }
          const changedKeys = Object.keys({ ...priorBlock, ...block }).filter(
            (k) =>
              JSON.stringify((priorBlock as Record<string, unknown>)[k] ?? null) !==
              JSON.stringify((block as Record<string, unknown>)[k] ?? null),
          );
          entry.mcp = block;
          return {
            success: true,
            output: JSON.stringify({
              ok: true,
              name,
              spec: block,
              changed_keys: changedKeys,
              warnings: [],
              prior_spec: priorBlock,
            }),
          };
        }
        // `hub mcp reconcile --global --json` (read-only — the Library's
        // Detected MCP servers band, E2 `useMcpCandidates`). Only the three
        // scene flags below ever populate it, so every other scene's Library
        // renders no band (M9: a band with nothing to do is noise).
        // `?mcpLiteral=1` (E3 rev 2) is a SEPARATE fixture set — see
        // `mcpExtraCandidatesData` — so it never changes the row count of
        // the two pre-existing scenes.
        if (sub === "reconcile") {
          const show = sceneFlag("mcpCandidates") || sceneFlag("mcpConflict");
          const showLiteral = sceneFlag("mcpLiteral");
          return {
            success: true,
            output: JSON.stringify({
              ok: true,
              scope_kind: "global",
              project: null,
              candidates: showLiteral ? mcpExtraCandidatesData : show ? mcpCandidatesData : [],
              kept: show || showLiteral ? mcpKept : [],
            }),
          };
        }
      }
      // REAL `hub sync` failures, bytes and all — exercising the failure surface
      // end to end (headline extraction, ANSI stripping, log population).
      //   ?syncFails=1       stdout warnings + the red error block on stderr
      //   ?syncFails=stdout  everything on stdout, stderr empty (hub.py's
      //                      dominant shape: `fail()` and all of cmd_sync)
      if (cmdArgs[0] === "sync") {
        const mode = sceneValue("syncFails");
        if (mode === "1") return failingSyncResult();
        if (mode === "stdout") return failingSyncStdoutOnly();
        // `?syncHangs=1` — never resolve, so a scene can PHOTOGRAPH the
        // in-flight state. Without it the mock settles inside a frame and
        // every busy affordance in the app is unphotographable.
        if (sceneFlag("syncHangs")) return new Promise<never>(() => {});
      }
      // `?enableFails=1` — an equip whose trailing auto-sync fails, so stdout
      // OPENS with a green success tick.
      if (cmdArgs[0] === "enable" && sceneFlag("enableFails")) {
        return failingEnableStdoutOnly();
      }
      // ── Cloud targets (`hub cloud …`) ──
      if (cmdArgs[0] === "cloud") {
        if (cmdArgs[1] === "targets") {
          return { success: true, output: JSON.stringify(cloudTargetsPayload()) };
        }
        if (cmdArgs[1] === "status") {
          return {
            success: true,
            output: JSON.stringify(cloudStatusPayload(cmdArgs[2])),
          };
        }
        if (cmdArgs[1] === "equip") {
          const targetId = cmdArgs[2];
          const kind = cmdArgs[cmdArgs.indexOf("--kind") + 1];
          const name = cmdArgs[cmdArgs.indexOf("--name") + 1];
          const on = cmdArgs[cmdArgs.indexOf("--state") + 1] === "on";
          const block = (registry.cloud ??= {});
          const entry = (block[targetId] ??= { bundles: [], enabled: [] });
          const field = kind === "bundle" ? "bundles" : "enabled";
          const set = new Set(entry[field] ?? []);
          if (on) set.add(name);
          else set.delete(name);
          entry[field] = [...set];
          return {
            success: true,
            output: JSON.stringify({
              ok: true,
              target: targetId,
              bundles: entry.bundles ?? [],
              enabled: entry.enabled ?? [],
            }),
          };
        }
        if (cmdArgs[1] === "export") {
          const si = cmdArgs.indexOf("--skill");
          return {
            success: true,
            output: JSON.stringify(
              cloudExportPayload(cmdArgs[2], si >= 0 ? cmdArgs[si + 1] : undefined),
            ),
          };
        }
      }
      // `hub harness list --json` — the ONLY source of `also_serves` (the Rust
      // harness_list re-implements detection and does not carry it).
      if (cmdArgs[0] === "harness" && cmdArgs[1] === "list") {
        const allProjectNames = Object.keys(registry.projects ?? {}).sort();
        return {
          success: true,
          output: JSON.stringify([
            {
              id: "claude-code",
              label: "Claude Code",
              installed: true,
              on_globally: true,
              used_by_projects: [],
              effective_projects: allProjectNames,
            },
            {
              id: "codex",
              label: "Codex",
              installed: true,
              on_globally: false,
              used_by_projects: [],
              effective_projects: [],
              also_serves: ["ChatGPT desktop app"],
            },
          ]),
        };
      }
      // `hub harness doc status|link|unlink --json` (global-doc-sharing).
      if (cmdArgs[0] === "harness" && cmdArgs[1] === "doc") {
        const sub = cmdArgs[2];
        if (sub === "status") {
          return { success: true, output: JSON.stringify(docSharingStatusRows()) };
        }
        if (sub === "link") {
          const follower = cmdArgs[3];
          const toIdx = cmdArgs.indexOf("--to");
          const source = toIdx >= 0 ? cmdArgs[toIdx + 1] : undefined;
          const ocIdx = cmdArgs.indexOf("--on-conflict");
          const onConflict = ocIdx >= 0 ? cmdArgs[ocIdx + 1] : null;

          if (!follower || !docSharingState[follower]) {
            return {
              success: false,
              output: JSON.stringify({ error: "unknown_harness", harness: follower }),
            };
          }
          if (!source || !docSharingState[source]) {
            return {
              success: false,
              output: JSON.stringify({ error: "unknown_harness", harness: source }),
            };
          }
          if (follower === source) {
            return {
              success: false,
              output: JSON.stringify({ error: "same_harness", harness: follower }),
            };
          }

          // `?docLinkConflict=1` forces the exit-2 conflict shape regardless
          // of the follower's real mock state, so the confirm dialog is
          // deterministically reachable for a test or a visual scene.
          if (sceneFlag("docLinkConflict") && !onConflict) {
            const previewText =
              GLOBAL_DOCS[follower]?.content ||
              "# Its own instructions\n\nDo not remove this line.\n";
            return {
              success: false,
              output: JSON.stringify({
                error: "conflict",
                harness: follower,
                existing_bytes: previewText.length,
                preview: previewText.slice(0, 400),
              }),
            };
          }

          const followerRow = docSharingStatusRows().find((r) => r.harness === follower);
          const followerHasFollowers =
            !!followerRow && followerRow.state === "source" && followerRow.followers.length > 0;
          if (followerHasFollowers) {
            return {
              success: false,
              output: JSON.stringify({
                error: "has_followers",
                harness: follower,
                followers: followerRow!.followers,
              }),
            };
          }
          const followerHasBytes =
            !!followerRow && (followerRow.state === "standalone" || followerRow.state === "source");
          if (followerHasBytes && !onConflict) {
            const content = GLOBAL_DOCS[follower]?.content ?? "";
            return {
              success: false,
              output: JSON.stringify({
                error: "conflict",
                harness: follower,
                existing_bytes: content.length,
                preview: content.slice(0, 400),
              }),
            };
          }
          if (followerHasBytes && onConflict === "merge") {
            const sourceEntry = GLOBAL_DOCS[source];
            const followerText = GLOBAL_DOCS[follower]?.content ?? "";
            if (sourceEntry && followerText && !sourceEntry.content.includes(followerText)) {
              sourceEntry.content = `${sourceEntry.content}\n\n${followerText}`;
            }
          }
          docSharingState[follower] = { state: "follows", follows: source };
          return {
            success: true,
            output: JSON.stringify({
              follower,
              source,
              changed: true,
              backup: followerHasBytes ? "mock-backup.md" : null,
            }),
          };
        }
        if (sub === "unlink") {
          const harnessId = cmdArgs[3];
          const st = harnessId ? docSharingState[harnessId] : undefined;
          if (!st || st.state !== "follows") {
            return {
              success: false,
              output: JSON.stringify({
                error: "not_a_follower",
                harness: harnessId,
                state: st?.state ?? "missing",
              }),
            };
          }
          const sourceEntry = st.follows ? GLOBAL_DOCS[st.follows] : undefined;
          const text = sourceEntry?.content ?? "";
          docSharingState[harnessId] = { state: "standalone", follows: null };
          if (GLOBAL_DOCS[harnessId]) {
            GLOBAL_DOCS[harnessId] = { ...GLOBAL_DOCS[harnessId], content: text };
          }
          return {
            success: true,
            output: JSON.stringify({ changed: true, harness: harnessId, bytes: text.length, backup: null }),
          };
        }
      }
      if (cmdArgs[0] === "source" && cmdArgs[1] === "list" && cmdArgs.includes("--json")) {
        return { success: true, output: sourceListPayload() };
      }
      // Rename a source's DISPLAY name (`hub source edit <id> --name <v>`).
      if (cmdArgs[0] === "source" && cmdArgs[1] === "edit") {
        const sid = cmdArgs[2];
        const ni = cmdArgs.indexOf("--name");
        const cfg = registry.sources?.[sid];
        if (!cfg) {
          return { success: false, output: `unknown source: ${sid}` };
        }
        if (ni >= 0) cfg.name = cmdArgs[ni + 1];
        return {
          success: true,
          output: JSON.stringify({
            source: { id: sid, ...cfg, name: cfg.name ?? sid },
            errors: [],
          }),
        };
      }
      // Turn a source's sync on/off. Skills stay registered either way; the
      // impact block tells the UI exactly what stopped (or resumed) flowing.
      if (
        cmdArgs[0] === "source" &&
        (cmdArgs[1] === "enable" || cmdArgs[1] === "disable")
      ) {
        const sid = cmdArgs[2];
        const cfg = registry.sources?.[sid];
        if (!cfg) {
          // A refusal names no source and reports no outcome flag.
          return {
            success: false,
            output: JSON.stringify({
              source: null,
              errors: [`unknown source: ${sid}`],
            }),
          };
        }
        const enabled = cmdArgs[1] === "enable";
        cfg.enabled = enabled;
        // The real CLI prints ONE compact payload line and then `_auto_sync()`
        // log chatter on the same stdout — keep the mock equally hostile so a
        // bare JSON.parse regression fails in tests, not live.
        const payload = JSON.stringify({
          source: { id: sid, ...cfg, name: cfg.name ?? sid },
          enabled,
          changed: true,
          impact: sourceImpact(sid),
        });
        return {
          success: true,
          output: `${payload}\nSyncing {example-app} → /Users/dev/{proj}\nsync complete {ok}`,
        };
      }
      // `hub source sync <id> --json` — REGISTERS new upstream skills and
      // reconciles every bundle that follows this source.
      if (cmdArgs[0] === "source" && cmdArgs[1] === "sync") {
        const sid = cmdArgs[2];
        const cfg = registry.sources?.[sid];
        if (!cfg) {
          // The source verbs report ONE `error` string — not an `errors` list.
          return {
            success: false,
            output: JSON.stringify({ ok: false, error: `unknown source: ${sid}` }),
          };
        }
        if (cfg.type === "git") {
          cfg.current_ref = cfg.remote_ref ?? cfg.current_ref;
          cfg.status = "up-to-date";
          cfg.last_synced_at = new Date().toISOString();
        }
        // One newly-registered upstream skill per source, so the linked-bundle
        // reconcile has something real to add (idempotent across syncs).
        const newcomer = `${sid}-newcomer`;
        const added: string[] = [];
        if (!registry.skills[newcomer]) {
          registry.skills[newcomer] = {
            version: "1.0.0",
            description: `External: freshly imported from ${sid}.`,
            source: `~/.skill-hub/sources/${sid}/worktree/skills/${newcomer}`,
            type: "claude-skill",
            scope: "portable",
            upstream: cfg.type === "git" ? cfg.url : null,
            managed: "external",
            origin: { source: sid, source_type: "git", path: `skills/${newcomer}`, ref: "def456" },
          };
          added.push(newcomer);
        }
        const bundle_updates: Array<{
          bundle: string;
          added: string[];
          removed: string[];
        }> = [];
        for (const [bn, b] of Object.entries(registry.bundles)) {
          if (b.source !== sid) continue;
          const gained = added.filter((s) => !(b.skills ?? []).includes(s));
          if (gained.length === 0) continue;
          b.skills = [...(b.skills ?? []), ...gained];
          bundle_updates.push({ bundle: bn, added: gained, removed: [] });
        }
        const payload = JSON.stringify({
          ok: true,
          added,
          changed: [],
          removed_upstream: [],
          unchanged: ["android-compose-ui"],
          new_pending: [],
          needs_hub_sync: added.length > 0 || bundle_updates.length > 0,
          bundle_updates,
        });
        return {
          success: true,
          output: `${payload}\nSyncing {example-app} → /Users/dev/{proj}\nsync complete {ok}`,
        };
      }
      // Bundle creation (also used by "create bundle from source"), so the
      // post-create navigate lands on a real /bundle/<name> route. `--source`
      // LINKS the new bundle to a source; `--json` prints the payload FIRST and
      // the auto-sync chatter after it (as the real CLI does).
      if (cmdArgs[0] === "bundle" && cmdArgs[1] === "new") {
        const bn = cmdArgs[2];
        const si = cmdArgs.indexOf("--skills");
        const di = cmdArgs.indexOf("--description");
        const ii = cmdArgs.indexOf("--icon");
        const srci = cmdArgs.indexOf("--source");
        const linked = srci >= 0 ? cmdArgs[srci + 1] : null;
        if (linked && !registry.sources?.[linked]) {
          const err = `unknown source: ${linked}`;
          return {
            success: false,
            output: JSON.stringify({ bundle: null, errors: [err] }),
          };
        }
        const sci = cmdArgs.indexOf("--scope");
        const scopeArg = sci >= 0 ? cmdArgs[sci + 1] : undefined;
        const newScope: BundleScope =
          scopeArg === "global" || scopeArg === "portable"
            ? scopeArg
            : "project-specific";
        const requested =
          si >= 0 ? (cmdArgs[si + 1] ?? "").split(",").filter(Boolean) : [];
        // A linked bundle may only hold skills the source actually owns; the
        // rest are dropped, and the CLI says so in `warnings`.
        const warnings: string[] = [];
        let skills = requested;
        if (linked) {
          const owned = new Set(ownedSkillNames(linked));
          const dropped = requested.filter((s) => !owned.has(s));
          if (dropped.length > 0) {
            skills = requested.filter((s) => owned.has(s));
            warnings.push(
              `dropped ${dropped.length} skill(s) '${linked}' does not own: ${dropped.join(", ")}`,
            );
          }
          if (newScope === "global") {
            warnings.push(
              `bundle '${bn}' is scope: global and follows '${linked}' — every project gets its skills automatically`,
            );
          }
        }
        let newPlaybook: import("@/types").PlaybookSection[] | undefined;
        const rawPlaybook = flagValue(cmdArgs, "--playbook");
        if (rawPlaybook !== undefined) {
          try { newPlaybook = JSON.parse(rawPlaybook); } catch {
            return { success: false, output: JSON.stringify({ bundle: null, errors: ["invalid playbook JSON"] }) };
          }
        }
        registry.bundles[bn] = {
          playbook: newPlaybook,
          description: di >= 0 ? cmdArgs[di + 1] : "",
          icon: ii >= 0 ? cmdArgs[ii + 1] : "📦",
          scope: newScope,
          skills,
          ...(linked ? { source: linked } : {}),
        };
        if (!cmdArgs.includes("--json")) return { success: true, output: "" };
        const payload = JSON.stringify({
          bundle: { name: bn, ...registry.bundles[bn], source: linked },
          created: true,
          // Always present on success — empty when there is nothing to flag.
          warnings,
          errors: [],
        });
        return {
          success: true,
          output: `${payload}\nSyncing {example-app} → /Users/dev/{proj}\nsync complete {ok}`,
        };
      }
      // Bundle rename: the key moves, `bundles:` position stays; every
      // `projects.*.bundles` / `remotes.*.bundles` / `cloud.*.bundles`
      // reference follows (same contract as `hub bundle rename`).
      if (cmdArgs[0] === "bundle" && cmdArgs[1] === "rename") {
        const [, , from, to] = cmdArgs;
        if (!(from in registry.bundles)) {
          return { success: false, output: `Unknown bundle '${from}'.` };
        }
        if (!SLUG_RE.test(to)) {
          return {
            success: false,
            output: `Invalid bundle name '${to}'. Use lowercase letters, numbers, and hyphens only.`,
          };
        }
        if (to === from) return { success: true, output: "" };
        if (to in registry.bundles) {
          return { success: false, output: `Bundle '${to}' already exists.` };
        }
        registry.bundles = Object.fromEntries(
          Object.entries(registry.bundles).map(([k, v]) => [k === from ? to : k, v]),
        );
        for (const p of Object.values(registry.projects ?? {})) {
          if (p.bundles?.includes(from)) {
            p.bundles = p.bundles.map((b) => (b === from ? to : b));
          }
        }
        for (const r of Object.values(registry.remotes ?? {})) {
          if (r.bundles?.includes(from)) {
            r.bundles = r.bundles.map((b) => (b === from ? to : b));
          }
        }
        for (const c of Object.values(registry.cloud ?? {})) {
          if (c.bundles?.includes(from)) {
            c.bundles = c.bundles.map((b) => (b === from ? to : b));
          }
        }
        return { success: true, output: "" };
      }
      // Snippet rename: the name IS the marker id, so the mock mutates every
      // fixture that carries it (same contract as `hub snippet rename`, which
      // rewrites the marker in every applied block).
      if (cmdArgs[0] === "snippet" && cmdArgs[1] === "rename") {
        const [, , from, to] = cmdArgs;
        if (!snippetsList.some((s) => s.name === from)) {
          return { success: false, output: `No snippet named "${from}".` };
        }
        if (!SNIPPET_NAME_RE.test(to)) {
          return {
            success: false,
            output: "Use lowercase kebab-case (letters, digits, single hyphens).",
          };
        }
        // Matches the real CLI: renaming a name to itself is rejected, not a
        // silent no-op.
        if (to === from) {
          return { success: false, output: `"${to}" is already the current name.` };
        }
        if (snippetsList.some((s) => s.name === to)) {
          return { success: false, output: `A snippet named "${to}" already exists.` };
        }
        for (const s of snippetsList) {
          if (s.name === from) s.name = to;
        }
        if (snippetShow.name === from) snippetShow.name = to;
        for (const loc of snippetStatus.locations) {
          if (loc.snippet === from) loc.snippet = to;
        }
        // A damaged location already recorded for this name is a REAL,
        // always-in-sync error case (no scene flag needed to exercise the
        // partial-failure toast) — it genuinely can't be rewritten, same as
        // the real CLI's per-file isolation.
        const errors = snippetStatus.damaged
          .filter((d) => d.name === from)
          .map((d) => ({ project: d.project, rel: d.rel, error: `damaged marker (${d.kind})` }));
        return {
          success: true,
          output: JSON.stringify({ action: "rename", from, to, renamed: [], errors }),
        };
      }
      // Skill rename cascade (`hub rename <old> <new> …`) — distinct from
      // `snippet rename` just above: this is the top-level verb the skill
      // editor's rename dialog drives.
      if (cmdArgs[0] === "rename" && cmdArgs.includes("--dry-run") && cmdArgs.includes("--json")) {
        const [, from, to] = cmdArgs;
        return { success: true, output: JSON.stringify(renameCascadePlan(from, to)) };
      }
      if (cmdArgs[0] === "rename" && cmdArgs.includes("--rewrite-refs")) {
        const [, from, to] = cmdArgs;
        // `?renameHangs=1` mirrors `?syncHangs=1`/`?equipHangs=1` — never
        // resolve, so the dialog's `running` state (dimmed list, step rows,
        // both buttons disabled) is photographable.
        if (sceneFlag("renameHangs")) return new Promise<never>(() => {});
        const plan = renameCascadePlan(from, to);
        const wantsAgentDocs = cmdArgs.includes("--rewrite-agent-docs");
        // `?renameFails=1`: success `false` with the payload still on stdout
        // — the exit-2 shape `hubStreams`/`parseCliJson` read regardless of
        // exit code. The rename itself still "landed" (`renamed: true`) —
        // only the agent-doc write failed, so the disclosure has a `hint`.
        if (sceneFlag("renameFails")) {
          const failResult: RenameResult = {
            renamed: true,
            old: from,
            new: to,
            rewritten: [],
            skipped: plan.skipped,
            errors: [
              {
                kind: "agent_doc",
                name: `${RENAME_AGENT_DOC.project}/${RENAME_AGENT_DOC.rel}`,
                path: RENAME_AGENT_DOC.path,
                error: "[Errno 13] Permission denied",
                hint: "its mirror partner moon-base/CLAUDE.md was rewritten",
              },
            ],
            snippets_outdated: [],
            agent_docs_requested: wantsAgentDocs,
          };
          return { success: false, output: JSON.stringify(failResult) };
        }
        const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const mentionRe = new RegExp(`\`${escaped}\`|/${escaped}\\b`, "g");
        // Keep the mention's form: a slash mention stays a slash mention, a
        // backticked one keeps its backticks — what `rewrite_refs` does.
        const swap = (m: string) => (m.startsWith("/") ? `/${to}` : `\`${to}\``);
        if (
          Object.prototype.hasOwnProperty.call(registry.skills, from) &&
          !Object.prototype.hasOwnProperty.call(registry.skills, to)
        ) {
          registry.skills[to] = registry.skills[from];
          delete registry.skills[from];
          if (Object.prototype.hasOwnProperty.call(skillFileTrees, from)) {
            skillFileTrees[to] = skillFileTrees[from];
            delete skillFileTrees[from];
          }
          if (Object.prototype.hasOwnProperty.call(searchCorpus.skills, from)) {
            searchCorpus.skills[to] = searchCorpus.skills[from];
            delete searchCorpus.skills[from];
          }
        }
        for (const row of plan.referrers.skills) {
          if (row.name === `${from}/references/notes.md`) continue;
          const treeBody = skillFileTrees[row.name]?.["SKILL.md"];
          if (typeof treeBody === "string") {
            skillFileTrees[row.name]["SKILL.md"] = treeBody.replace(mentionRe, swap);
          }
          if (searchCorpus.skills[row.name] !== undefined) {
            searchCorpus.skills[row.name] = searchCorpus.skills[row.name].replace(mentionRe, swap);
          }
        }
        // Bump the matched snippet's version — the mock's stand-in for "the
        // snippet library is rewritten with --rewrite-refs regardless of the
        // agent-docs toggle" (§Dialog states' snippet note).
        for (const row of plan.referrers.snippets) {
          const s = snippetsList.find((x) => x.name === row.name);
          if (s) s.version += 1;
        }
        const rewritten: RenameResult["rewritten"] = [
          ...plan.referrers.skills.map((s) => ({
            kind: "skill" as const,
            name: s.name,
            count: s.count,
            backup: `~/.skill-hub/_hub-backups/rename/skills__${s.name.replace(/\//g, "__")}.md`,
          })),
          ...plan.referrers.snippets.map((s) => ({
            kind: "snippet" as const,
            name: s.name,
            count: s.count,
            version: snippetsList.find((x) => x.name === s.name)?.version ?? 1,
          })),
          ...(wantsAgentDocs
            ? plan.referrers.agent_docs.map((a) => ({
                kind: "agent_doc" as const,
                name: `${a.project}/${a.rel}`,
                path: a.path,
                count: a.count,
                backup: `~/.skill-hub/_hub-backups/rename/${a.project}__${a.rel}`,
              }))
            : []),
        ];
        const applyResult: RenameResult = {
          renamed: true,
          old: from,
          new: to,
          rewritten,
          skipped: plan.skipped,
          errors: [],
          snippets_outdated: plan.referrers.snippets.map((s) => s.name),
          agent_docs_requested: wantsAgentDocs,
        };
        return { success: true, output: JSON.stringify(applyResult) };
      }
      // Add-source dry-run preview. SCOPE-AWARE: the payload answers the
      // url/--path it was given, so the wizard's deep-link, wrong-path and
      // empty-scan states are all expressible from the UI alone.
      if (
        cmdArgs[0] === "source" &&
        cmdArgs[1] === "add" &&
        cmdArgs.includes("--dry-run")
      ) {
        const scenario = sourceAddScenario(cmdArgs);
        return { success: scenario.ok, output: JSON.stringify(scenario) };
      }
      if (cmdArgs[0] === "skill" && cmdArgs[1] === "invocation") {
        const projectIndex = cmdArgs.indexOf("--project");
        return { success: true, output: JSON.stringify(invocationMock(
          registry, cmdArgs[2], projectIndex < 0 ? undefined : cmdArgs[projectIndex + 1],
        )) };
      }
      // I6/A15/D10 — `hub skill companions set <skill> --json-body <json>`:
      // whole-block replace + I7 reconcile. Checked BEFORE the read-only arm
      // below, since both start with `skill companions`.
      if (cmdArgs[0] === "skill" && cmdArgs[1] === "companions" && cmdArgs[2] === "set") {
        const skillName = cmdArgs[3];
        const bodyIdx = cmdArgs.indexOf("--json-body");
        const raw = bodyIdx >= 0 ? cmdArgs[bodyIdx + 1] : undefined;
        const skill = registry.skills[skillName];
        if (!skill) {
          return {
            success: false,
            output: JSON.stringify({ ok: false, error: `unknown skill '${skillName}'` }),
          };
        }
        // D10: same refusal message the invocation override uses for a
        // source-managed skill (`skillFilesGate`'s family of messages).
        if (skill.managed === "external") {
          return {
            success: false,
            output: JSON.stringify({
              ok: false,
              error: `read_only: ${skillName} is managed by its source`,
            }),
          };
        }
        let body: CompanionsSetBlock | null = null;
        try {
          body = raw ? (JSON.parse(raw) as CompanionsSetBlock) : null;
        } catch {
          body = null;
        }
        if (!body) {
          return {
            success: false,
            output: JSON.stringify({ ok: false, error: "invalid or missing --json-body" }),
          };
        }
        // A18: an inline hook and a ref sharing a name is invalid.
        const seenHookNames = new Set<string>();
        for (const h of body.hooks ?? []) {
          const name = "ref" in h ? h.ref : h.name;
          if (seenHookNames.has(name)) {
            return {
              success: false,
              output: JSON.stringify({
                ok: false,
                error: `'${name}' is declared as both an inline hook and a reference`,
                field: "hooks",
              }),
            };
          }
          seenHookNames.add(name);
        }
        // Wave 4c unit 2 (§3.1a/§6.2, grill #13 parity with `_apply_set_body`'s
        // inline arm): a NEW inline hook whose name is already a hooksStore
        // definition is refused UNLESS it's already this skill's own PRIOR
        // declared inline hook (read before this call mutates `ships_with` —
        // a re-save must still work). A `scaffold`-carrying entry is also
        // checked against the scripts/-only + suffix rule before anything is
        // echoed back as scaffolded — never partially applied.
        const priorInlineNames = new Set(
          (skill.ships_with?.hooks ?? []).filter((h) => !isHookRef(h)).map((h) => h.name),
        );
        const scaffolded: string[] = [];
        for (const h of body.hooks ?? []) {
          if ("ref" in h) continue;
          const hookName = h.name;
          if (hooksStore.some((def) => def.name === hookName) && !priorInlineNames.has(hookName)) {
            return {
              success: false,
              output: JSON.stringify({
                ok: false,
                error: `'${hookName}' is already a hooks-library definition — reference it instead`,
                field: `hooks[${hookName}]`,
              }),
            };
          }
          if (!h.scaffold) continue;
          const command = h.command;
          if (
            typeof command !== "string" ||
            !command.startsWith("scripts/") ||
            !/\.(sh|py)$/.test(command)
          ) {
            return {
              success: false,
              output: JSON.stringify({
                ok: false,
                error: `hooks[${hookName}]: cannot scaffold — invalid target`,
                field: `hooks[${hookName}].command`,
              }),
            };
          }
          scaffolded.push(`/Users/test/.skill-hub/skills/${skillName}/${command}`);
        }
        const normalized = normalizeCompanionsSetBlock(body);
        skill.ships_with = normalized;
        const reconcile = reconcileCompanionsAfterSet(skillName, normalized);
        const result: CompanionsSetResult = {
          ok: true,
          skill: skillName,
          block: normalized,
          reconcile,
          scaffolded,
        };
        return { success: true, output: JSON.stringify(result) };
      }
      // `hub skill companions <skill> [--project <p>] --json` (A5/W9, extended
      // by I5, then D17) — read-only: declared companions + per-harness
      // `state` (replacing `verdict` in the panel) + `verdict`/`provisioned`
      // still present for the exit-2 dialog's shared item shape, plus the
      // `summary` rollup, `project_context`, and (D17) `provisioned_on`.
      if (cmdArgs[0] === "skill" && cmdArgs[1] === "companions") {
        const skillName = cmdArgs[2];
        const pIdx = cmdArgs.indexOf("--project");
        const projectName = pIdx >= 0 ? cmdArgs[pIdx + 1] : undefined;
        const sw = registry.skills[skillName]?.ships_with ?? {};
        const items = projectName
          ? buildCompanionItems(skillName, projectName)
          : buildCompanionItemsDeclared(skillName);
        if (projectName) {
          const entry = registry.projects[projectName]?.companions?.[skillName];
          for (const item of items) {
            if (item.kind === "hook") item.provisioned = (entry?.hooks ?? []).includes(item.name);
            else if (item.kind === "agent") {
              item.provisioned = (entry?.agents ?? []).includes(item.name);
            } else if (item.kind === "permission") {
              item.provisioned = (entry?.permissions ?? []).some(
                (p) => p.pattern === item.name && p.kind === item.rule_kind,
              );
            }
          }
        }
        for (const item of items) {
          item.state = companionStateFor(item, !!projectName);
          item.route = companionRouteFor(item, projectName);
        }
        // D17/W2: `provisioned_on` (top-level AND per item, S2) lists EVERY
        // scope whose ledger claims this skill/companion — ALWAYS, including
        // under `--project P` — mirroring `hub_cli/companions.py`'s decision
        // (the CLI is the source of truth for this shape, not this mock):
        // "where is this provisioned" is a fact about the skill, never
        // narrowed to the one scope the caller happened to pass. Only a
        // project-less read's per-item STATE is upgraded to `provisioned`
        // (`unsupported`/`missing` are never overridden — a codex hook stays
        // `unsupported`) — a project-scoped read's `state` still comes from
        // that project's own ledger via `companionStateFor` above.
        const provisionedOn = companionsProvisionedOn(skillName);
        for (const item of items) {
          const claimed =
            item.state === "unsupported" || item.state === "missing"
              ? []
              : companionClaimedScopes(
                  skillName,
                  item.kind === "permission" ? "permission" : (item.kind as "hook" | "agent"),
                  item.name,
                  item.rule_kind,
                );
          item.provisioned_on = claimed;
          if (!projectName && claimed.length > 0) {
            item.state = "provisioned";
            item.reason = `from ${claimed.join(", ")}`;
          }
        }
        return {
          success: true,
          output: JSON.stringify({
            skill: skillName,
            project: projectName ?? null,
            declared: sw,
            items,
            summary: companionSummaryFor(items),
            // A17 (global-scope `companions_global` reads) is a follow-up —
            // this wave's mock only ever sees a real project or none.
            project_context: !!projectName,
            provisioned_on: provisionedOn,
          }),
        };
      }
      // `ships_with` (D1-D5, I1/A4/A13): a skill that declares companions gates
      // `enable`/`disable` on `--with-companions`/`--skill-only`/
      // `--keep-companions`. Falls through to the plain equip branch below for
      // every other skill.
      if (
        (cmdArgs[0] === "enable" || cmdArgs[0] === "disable") &&
        cmdArgs[2] === "--project"
      ) {
        const skillName = cmdArgs[1];
        const projectName = cmdArgs[3];
        const skill = registry.skills[skillName];
        const proj = registry.projects[projectName];
        const sw = skill?.ships_with;
        if (proj && shipsWithTotal(sw) > 0) {
          if (cmdArgs[0] === "enable") {
            const set = new Set(proj.enabled ?? []);
            set.add(skillName);
            proj.enabled = [...set];
            const withCompanions = cmdArgs.includes("--with-companions");
            const skillOnly = cmdArgs.includes("--skill-only");
            if (!withCompanions && !skillOnly) {
              const items = buildCompanionItems(skillName, projectName);
              return {
                success: false,
                output: JSON.stringify({
                  needs_provisioning: { skill: skillName, project: projectName, items },
                }),
              };
            }
            if (withCompanions) {
              const entries = (proj.companions ??= {});
              entries[skillName] = {
                hooks: (sw?.hooks ?? []).map((h) => h.name),
                agents: sw?.agents ?? [],
                permissions: companionRuleKeys(sw),
                provisioned_at: new Date().toISOString(),
              };
              // A12: a shipped rule lands where the project block lands
              // today — reflect it into the `permissions_show` twin so the
              // Permissions screen has a row to tag `via <skill>`.
              const pp = ensureProjectPermissions(projectName);
              for (const key of companionRuleKeys(sw)) addProjectPermissionRule(pp, key);
              // Mirrors the real CLI's `_hook_attach` — the Hooks library's
              // attach chip reads real project state, not just the ledger.
              for (const hook of sw?.hooks ?? []) {
                const def = hooksStore.find((h) => h.name === hook.name);
                if (def && !def.attached_projects.includes(projectName)) {
                  def.attached_projects = [...def.attached_projects, projectName];
                }
              }
            }
            return { success: true, output: "" };
          }
          // disable
          const set = new Set(proj.enabled ?? []);
          set.delete(skillName);
          proj.enabled = [...set];
          const keepCompanions = cmdArgs.includes("--keep-companions");
          const entry = proj.companions?.[skillName];
          const removed = {
            hooks: entry?.hooks ?? [],
            agents: entry?.agents ?? [],
            permissions: entry?.permissions ?? [],
          };
          if (entry && !keepCompanions && proj.companions) {
            delete proj.companions[skillName];
            const pp = permissionsProject[projectName];
            if (pp) {
              for (const key of removed.permissions) removeProjectPermissionRule(pp, key);
            }
            for (const hookName of removed.hooks) {
              const def = hooksStore.find((h) => h.name === hookName);
              if (def) def.attached_projects = def.attached_projects.filter((p) => p !== projectName);
            }
          }
          return {
            success: true,
            output: JSON.stringify({
              removed_companions: keepCompanions
                ? { hooks: [], agents: [], permissions: [] }
                : removed,
            }),
          };
        }
      }
      // Skill → project equip (mutates so a re-read reflects the toggle).
      if (
        (cmdArgs[0] === "enable" || cmdArgs[0] === "disable") &&
        cmdArgs[2] === "--project"
      ) {
        const skill = cmdArgs[1];
        const proj = registry.projects[cmdArgs[3]];
        if (proj) {
          const set = new Set(proj.enabled ?? []);
          if (cmdArgs[0] === "enable") set.add(skill);
          else set.delete(skill);
          proj.enabled = [...set];
        }
        return { success: true, output: "" };
      }
      // Bundle apply / remove on a project (mutates project.bundles so a
      // re-read — and an undo round-trip — reflects the toggle).
      if (
        cmdArgs[0] === "bundle" &&
        (cmdArgs[1] === "apply" || cmdArgs[1] === "remove") &&
        cmdArgs[3] === "--project"
      ) {
        const bn = cmdArgs[2];
        const proj = registry.projects[cmdArgs[4]];
        if (proj) {
          const set = new Set(proj.bundles ?? []);
          if (cmdArgs[1] === "apply") set.add(bn);
          else set.delete(bn);
          proj.bundles = [...set];
        }
        return { success: true, output: "" };
      }
      // Bundle delete: drops the definition and unassigns it everywhere.
      // `--json` is payload-first, like every other writing verb.
      if (cmdArgs[0] === "bundle" && cmdArgs[1] === "delete") {
        const bn = cmdArgs[2];
        const json = cmdArgs.includes("--json");
        if (!registry.bundles[bn]) {
          const err = `unknown bundle: ${bn}`;
          return {
            success: false,
            output: json ? JSON.stringify({ deleted: null, errors: [err] }) : err,
          };
        }
        const wouldUnassign = Object.entries(registry.projects)
          .filter(([, p]) => (p.bundles ?? []).includes(bn))
          .map(([pn]) => pn);
        if (cmdArgs.includes("--dry-run")) {
          return {
            success: true,
            output: JSON.stringify({
              deleted: null,
              dry_run: true,
              would_unassign: wouldUnassign,
            }),
          };
        }
        delete registry.bundles[bn];
        for (const p of Object.values(registry.projects)) {
          p.bundles = (p.bundles ?? []).filter((b) => b !== bn);
        }
        if (!json) return { success: true, output: "" };
        const payload = JSON.stringify({ deleted: bn, errors: [] });
        return {
          success: true,
          output: `${payload}\nSyncing {example-app} → /Users/dev/{proj}\nsync complete {ok}`,
        };
      }
      // Bundle update: membership / metadata / source link. A LINKED bundle
      // refuses `--skills` exactly like the real CLI.
      if (cmdArgs[0] === "bundle" && cmdArgs[1] === "update") {
        const bn = cmdArgs[2];
        const json = cmdArgs.includes("--json");
        // A failure payload carries NO outcome flag — only `bundle: null` plus
        // the errors. Anything more forgiving would let the mocked app pass
        // where the real CLI refuses.
        const fail = (err: string) => ({
          success: false,
          output: json ? JSON.stringify({ bundle: null, errors: [err] }) : err,
        });
        const b = registry.bundles[bn];
        if (!b) return fail(`unknown bundle: ${bn}`);
        const si = cmdArgs.indexOf("--skills");
        const srci = cmdArgs.indexOf("--source");
        const detach = cmdArgs.includes("--detach-source");
        // Mutually exclusive flag pairs, refused before anything is written.
        if (srci >= 0 && si >= 0) {
          return fail("--source cannot be combined with --skills");
        }
        if (srci >= 0 && detach) {
          return fail("--source cannot be combined with --detach-source");
        }
        if (si >= 0 && b.source) {
          return fail(
            `bundle '${bn}' follows source '${b.source}' — its skill list is managed; use --detach-source first`,
          );
        }
        let changed = false;
        const scopei = cmdArgs.indexOf("--scope");
        if (scopei >= 0) {
          const nextScope = cmdArgs[scopei + 1];
          if (nextScope !== "global" && nextScope !== "portable" && nextScope !== "project-specific") {
            return fail(`invalid bundle scope: ${nextScope}`);
          }
          b.scope = nextScope;
          changed = true;
        }
        if (si >= 0) {
          const nextSkills = (cmdArgs[si + 1] ?? "").split(",").filter(Boolean);
          // Mirrors `hub.py` `cmd_bundle_update`: every `--skills` csv is
          // refused outright if it names a skill the registry doesn't know —
          // the Library's bundle mode relies on this to prove it never emits
          // one (every csv it builds is pre-filtered to known names).
          const unknown = nextSkills.filter((s) => !registry.skills[s]);
          if (unknown.length > 0) {
            return fail(`Unknown skills for bundle '${bn}': ${unknown.join(", ")}`);
          }
          b.skills = nextSkills;
          changed = true;
        }
        const playbook = flagValue(cmdArgs, "--playbook");
        if (playbook !== undefined) {
          try {
            const parsed = JSON.parse(playbook);
            if (!Array.isArray(parsed)) return fail("playbook must be an array");
            b.playbook = parsed;
            changed = true;
          } catch { return fail("invalid playbook JSON"); }
        }
        // The Library's bundle mode passes `--description`/`--icon` as ONE
        // merged token (`--flag=value`) so argparse never mistakes a value
        // starting with `-` for a flag; every other writer still passes two.
        const desc = flagValue(cmdArgs, "--description");
        if (desc !== undefined) {
          b.description = desc;
          changed = true;
        }
        const icon = flagValue(cmdArgs, "--icon");
        if (icon !== undefined) {
          b.icon = icon;
          changed = true;
        }
        const warnings: string[] = [];
        if (srci >= 0) {
          const linked = cmdArgs[srci + 1];
          if (!registry.sources?.[linked]) return fail(`unknown source: ${linked}`);
          b.source = linked;
          // Linking reconciles membership immediately: keep the current order,
          // then append the source's owned, non-missing skills. Anything the
          // source does NOT own is dropped, with a warning.
          const owned = ownedSkillNames(linked);
          const ownedSet = new Set(owned);
          const kept = (b.skills ?? []).filter((s) => ownedSet.has(s));
          const dropped = (b.skills ?? []).filter((s) => !ownedSet.has(s));
          const next = [...kept];
          for (const s of owned) if (!next.includes(s)) next.push(s);
          b.skills = next;
          if (dropped.length > 0) {
            warnings.push(
              `dropped ${dropped.length} skill(s) '${linked}' does not own: ${dropped.join(", ")}`,
            );
          }
          if (b.scope === "global") {
            warnings.push(
              `bundle '${bn}' is scope: global and follows '${linked}' — every project gets its skills automatically`,
            );
          }
          changed = true;
        }
        if (detach) {
          delete b.source;
          changed = true;
        }
        if (!json) return { success: true, output: "" };
        const payload = JSON.stringify({
          bundle: { name: bn, ...b, source: b.source ?? null },
          changed,
          warnings,
          errors: [],
        });
        return {
          success: true,
          output: `${payload}\nSyncing {example-app} → /Users/dev/{proj}\nsync complete {ok}`,
        };
      }
      // Library-default triggering (set-meta --invocation <mode>). Refuses for
      // external / mcp in the real CLI; the UI disables it so we don't model the
      // refusal here (mutates the mirror so a re-read shows the new badge).
      if (cmdArgs[0] === "set-meta") {
        const classificationFlags = ["--classes-json", "--outputs-json", "--working-mode", "--interaction-style", "--maturity"];
        const classificationFlag = classificationFlags.find((flag) => cmdArgs.includes(flag));
        if (classificationFlag) {
          const skill = registry.skills[cmdArgs[1]];
          if (!skill) return { success: false, output: "unknown skill" };
          const value = cmdArgs[cmdArgs.indexOf(classificationFlag) + 1] ?? "";
          const current = { ...(skill.classification ?? {}) };
          const field = classificationFlag === "--classes-json" ? "classes" : classificationFlag === "--outputs-json" ? "outputs" : classificationFlag.slice(2).replace(/-/g, "_");
          if (classificationFlag.endsWith("-json")) {
            let parsed: unknown;
            try { parsed = JSON.parse(value); } catch { return { success: false, output: "invalid JSON" }; }
            if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) return { success: false, output: "classification lists must be string arrays" };
            const seen = new Set<string>();
            const normalized = parsed.map((item) => item.trim()).filter((item) => {
              const id = item.replace(/[A-Z]/g, (letter: string) => letter.toLowerCase());
              if (!id || seen.has(id)) return false;
              seen.add(id); return true;
            });
            if (normalized.length) current[field as "classes" | "outputs"] = normalized;
            else delete current[field as "classes" | "outputs"];
          } else if (value) {
            const allowed: Record<string, string[]> = { "working-mode": ["inline", "delegator", "mixed"], "interaction-style": ["conversational", "checkpointed", "autonomous"], maturity: ["experimental", "confident", "trusted"] };
            if (!allowed[field.replace(/_/g, "-")]?.includes(value)) return { success: false, output: "invalid classification enum" };
            current[field as "working_mode" | "interaction_style" | "maturity"] = value as never;
          }
          else delete current[field as keyof typeof current];
          if (Object.keys(current).length) skill.classification = current; else delete skill.classification;
          return { success: true, output: "" };
        }
        const idx = cmdArgs.indexOf("--invocation");
        if (idx >= 0) {
          if (sceneFlag("invocationHangs")) return new Promise<never>(() => {});
          const skill = registry.skills[cmdArgs[1]];
          const mode = cmdArgs[idx + 1];
          if (skill) {
            if (mode === "auto") delete skill.invocation;
            else if (mode === "user-only" || mode === "model-only")
              skill.invocation = mode;
          }
          if (sceneFlag("invocationPartial")) {
            return new Promise((resolve) => setTimeout(() => resolve({
              success: true,
              output: "✗ sync completed with danger findings\n",
              stdout: "✗ sync completed with danger findings\n",
              stderr: "  ! auto-sync exited with rc 2 (doctor danger findings) — the mutation itself succeeded\n",
            }), 450));
          }
          return { success: true, output: "" };
        }
      }
      // Per-project triggering override (project invocation --skill --mode).
      if (cmdArgs[0] === "project" && cmdArgs[1] === "invocation") {
        const proj = registry.projects[cmdArgs[2]];
        const si = cmdArgs.indexOf("--skill");
        const mi = cmdArgs.indexOf("--mode");
        if (proj && si >= 0 && mi >= 0) {
          const skill = cmdArgs[si + 1];
          const mode = cmdArgs[mi + 1];
          const overrides = { ...(proj.invocation_overrides ?? {}) };
          if (mode === "inherit") delete overrides[skill];
          else if (mode === "auto" || mode === "user-only" || mode === "model-only")
            overrides[skill] = mode;
          proj.invocation_overrides = overrides;
        }
        return { success: true, output: "" };
      }
      // ── Skill share: export a .skillpack ──
      if (cmdArgs[0] === "skill" && cmdArgs[1] === "export") {
        const oi = cmdArgs.indexOf("--out");
        return {
          success: true,
          output: JSON.stringify({
            exported: cmdArgs[2],
            out: oi >= 0 ? cmdArgs[oi + 1] : `./${cmdArgs[2]}.skillpack`,
            files: 3,
          }),
        };
      }
      // ── Skill share: import a .skillpack (dry-run preview, then apply) ──
      if (cmdArgs[0] === "skill" && cmdArgs[1] === "import") {
        const ni = cmdArgs.indexOf("--name");
        const packName = "shared-widget";
        // A pack whose name is free in this registry → no collision to resolve.
        const collision = !!registry.skills[packName];
        if (cmdArgs.includes("--dry-run")) {
          return {
            success: true,
            output: JSON.stringify({
              valid: true,
              errors: [],
              name: packName,
              version: "1.4.0",
              description:
                "A shared widget skill exported from another Skill Tree install.",
              type: "claude-skill",
              scope: "portable",
              files: [
                { path: "SKILL.md", bytes: 2417 },
                { path: "reference.md", bytes: 8140 },
                { path: "scripts/build.py", bytes: 1032 },
              ],
              collision,
              existing: collision
                ? {
                    version: registry.skills[packName]?.version,
                    source: registry.skills[packName]?.source,
                    scope: registry.skills[packName]?.scope,
                  }
                : null,
            }),
          };
        }
        // Apply: register the skill so the post-import navigate lands on a real
        // detail route (and the Library count reflects it).
        const finalName = ni >= 0 ? cmdArgs[ni + 1] : packName;
        registry.skills[finalName] = {
          version: "1.4.0",
          description:
            "A shared widget skill exported from another Skill Tree install.",
          source: `~/.skill-hub/skills/${finalName}`,
          type: "claude-skill",
          scope: "portable",
          upstream: null,
          managed: "local",
        };
        return {
          success: true,
          output: JSON.stringify({ imported: finalName, files: 3 }),
        };
      }
      // Adopt a detected project-local skill.
      if (cmdArgs[0] === "project" && cmdArgs[1] === "import-skill") {
        const name = cmdArgs[2];
        const proj = cmdArgs[4];
        registry.skills[name] = {
          version: "0.1.0",
          description: `Adopted from ${proj}.`,
          source: `~/.skill-hub/skills/${name}`,
          type: "claude-skill",
          scope: "project-specific",
          upstream: null,
          managed: "local",
        };
        const p = registry.projects[proj];
        if (p) p.enabled = [...new Set([...(p.enabled ?? []), name])];
        localCandidatesData = localCandidatesData.filter((c) => c.name !== name);
        return { success: true, output: "" };
      }
      // Rename a project in place: the key moves, its block and position stay
      // (same contract as `hub project rename`).
      if (cmdArgs[0] === "project" && cmdArgs[1] === "rename") {
        const [, , from, to] = cmdArgs;
        if (!(from in registry.projects)) {
          return { success: false, output: `Unknown project '${from}'.` };
        }
        if (to in registry.projects) {
          return { success: false, output: `Project '${to}' already exists.` };
        }
        registry.projects = Object.fromEntries(
          Object.entries(registry.projects).map(([k, v]) => [k === from ? to : k, v]),
        );
        return { success: true, output: "" };
      }
      // `hub usage history --json` — see `usageHistoryPayload` above.
      // `?usageBackfilled=1` serves the mixed-provenance scene (backfilled +
      // frozen + scanned days); `?usageBig=1` scales those same 14 days
      // 5,600× (review W5), so the KPI/chart/sessions magnitudes stay
      // consistent with the equally-scaled scan; `?usageEmpty=1`/
      // `?usageNoUsage=1` return an empty-days payload — every other flag
      // combination gets the scanned-only fixture built off the SAME 14 days
      // `usage_scan_ccusage` returns, so no existing usage scene moves.
      if (cmdArgs[0] === "usage" && cmdArgs[1] === "history") {
        // `usageAccessError`/`usageFailure` are the "ccusage has never once
        // been able to run here" scenes — an empty ledger too (W1 fallout:
        // without this, the default scanned-only history fixture kept the
        // dashboard rendering THROUGH the scan failure with no visible
        // failure at all, since the durable ledger doesn't care why the
        // live scan failed).
        const empty =
          sceneFlag("usageEmpty") ||
          sceneFlag("usageNoUsage") ||
          sceneFlag("usageAccessError") ||
          sceneFlag("usageFailure");
        return {
          success: true,
          output: JSON.stringify(
            usageHistoryPayload({
              backfilled: sceneFlag("usageBackfilled"),
              big: sceneFlag("usageBig"),
              long: sceneFlag("usageLong"),
              modelMix: sceneFlag("usageModelMix"),
              unpriced: sceneFlag("usageUnpriced"),
              empty,
              importableDays: sceneFlag("usageNoUsage") ? 0 : 64,
            }),
          ),
        };
      }
      // `hub usage import-claude-stats --json` — the one-click Claude Code
      // stats-cache import CTA. Always a real (non-dry-run) success here; the
      // caller's `useUsageHistory()` invalidates the history query on
      // success, which re-reads `usageHistoryPayload` above.
      if (cmdArgs[0] === "usage" && cmdArgs[1] === "import-claude-stats") {
        return {
          success: true,
          output: JSON.stringify({
            path: "~/.claude/stats-cache.json",
            skipped_existing: 0,
            skipped_ccusage_days: 0,
            dry_run: false,
            inserted: 64,
            warnings: [] as string[],
          }),
        };
      }
      // The five `hub usage <verb> --json` ledger reads/mutations behind the
      // usage drill-downs (design D14.4) — delegated to `tauriUsageAnalytics.ts`
      // so this file stays a shell rather than growing a second feature's
      // fixtures inline.
      if (cmdArgs[0] === "usage" && cmdArgs[1] === "project") {
        return { success: true, output: JSON.stringify(usageProjectMock(cmdArgs)) };
      }
      if (cmdArgs[0] === "usage" && cmdArgs[1] === "session") {
        return { success: true, output: JSON.stringify(usageSessionMock(cmdArgs)) };
      }
      if (cmdArgs[0] === "usage" && cmdArgs[1] === "footprint") {
        return { success: true, output: JSON.stringify(usageFootprintMock(cmdArgs)) };
      }
      if (cmdArgs[0] === "usage" && cmdArgs[1] === "findings") {
        return { success: true, output: JSON.stringify(usageFindingsMock(cmdArgs)) };
      }
      if (cmdArgs[0] === "usage" && cmdArgs[1] === "loadouts") {
        return { success: true, output: JSON.stringify(usageLoadoutsMock(cmdArgs)) };
      }
      if (cmdArgs[0] === "usage" && cmdArgs[1] === "timeline") {
        return { success: true, output: JSON.stringify(usageTimelineMock(cmdArgs)) };
      }
      if (cmdArgs[0] === "usage" && cmdArgs[1] === "scan-sessions") {
        return usageScanMock();
      }
      if (cmdArgs[0] === "usage" && (cmdArgs[1] === "inspect" || cmdArgs[1] === "inspect-index" || cmdArgs[1] === "pin")) {
        return { success: true, output: JSON.stringify(dispatchUsageInspection({ args: cmdArgs })) };
      }
      return { success: true, output: "" };
    }

    // ── Skill editor ──
    case "read_skill_document": {
      const name = (args?.name as string) ?? "rt-android-expert";
      // A skill with an EXPLICIT file-tree fixture reads its own SKILL.md, so
      // the editor body, the FILES row's size and the footer's line count all
      // describe the same document. (Only the explicit fixtures — falling
      // through to `skillFilesFor` would lazily mint a stub tree for every
      // other skill and swap the rich `skillBody` every other scene relies on
      // for a two-line placeholder.)
      const own = Object.prototype.hasOwnProperty.call(skillFileTrees, name)
        ? skillFileTrees[name]["SKILL.md"]
        : null;
      return {
        name,
        description:
          registry.skills[name]?.description ??
          "Android Jetpack Compose planner and architecture advisor.",
        // The real `body` never carries the frontmatter — see
        // `stripFrontmatter` above (mirrors `split_frontmatter` in
        // app/src-tauri/src/commands/registry.rs).
        body: stripFrontmatter(own ?? skillBody),
      };
    }
    case "save_skill_full": {
      const name = (args?.name as string) ?? "";
      const doc = args?.document as { name?: string } | undefined;
      const meta = args?.meta as { harnesses?: string } | undefined;
      // Re-key so a reload after a rename (plain OR cascade — the cascade's
      // confirm invokes this with `name` already equal to the new name, so
      // `newName === name` and this is a no-op, exactly as the real
      // `save_skill_full` skips its own rename branch) finds the skill under
      // its new name.
      const newName = doc?.name || name;
      if (newName !== name && registry.skills[name] && !registry.skills[newName]) {
        registry.skills[newName] = registry.skills[name];
        delete registry.skills[name];
      }
      const sk = registry.skills[newName];
      if (sk && meta) {
        const csv = (meta.harnesses ?? "").trim();
        if (csv) sk.harnesses = csv.split(",").filter(Boolean);
        else delete sk.harnesses;
      }
      return newName || "saved";
    }

    // ── Skill files (editor file navigator) ──
    case "skill_files_list": {
      const name = (args?.name as string) ?? "rt-android-expert";
      const gate = skillFilesGate(name, false);
      if (gate) return gate;
      const entry = registry.skills[name];
      const isMcpServer = entry?.type === "mcp-server";
      // (F2) `source: null` (a mock without an explicit fixture never has
      // one either, mirroring the control-plane entry) — nothing to list.
      if (isMcpServer && !entry?.source) {
        return { root: "", files: [], truncated: false };
      }
      const tree = skillFilesFor(name);
      const rels = Object.keys(tree).sort((a, b) => {
        if (a === "SKILL.md") return -1;
        if (b === "SKILL.md") return 1;
        return a < b ? -1 : a > b ? 1 : 0;
      });
      // (F2) An mcp-server whose folder holds nothing beyond SKILL.md — same
      // "nothing to list here" result, never an error.
      if (isMcpServer && rels.length <= 1) {
        return { root: "", files: [], truncated: false };
      }
      return {
        root: (registry.skills[name]?.source ?? `~/.skill-hub/skills/${name}`).replace(
          /^~/,
          "/Users/dev",
        ),
        files: rels.map((rel) => skillFileEntry(rel, tree[rel])),
        truncated: false,
      };
    }
    case "skill_file_read": {
      const name = (args?.name as string) ?? "rt-android-expert";
      const rel = (args?.rel as string) ?? "SKILL.md";
      const gate = skillFilesGate(name, false);
      if (gate) return gate;
      if (skillFileRelEscapes(rel)) {
        return skillFilesReject(`outside: ${rel} is not inside the skill directory`);
      }
      const tree = skillFilesFor(name);
      if (!(rel in tree)) return skillFilesReject(`not_found: ${rel}`);
      const body = tree[rel];
      if (body === null || SKILL_FILE_BINARY_EXTS.includes(skillFileExt(rel))) {
        return skillFilesReject(`binary: ${rel} has no text representation`);
      }
      return {
        rel,
        content: body,
        hash: skillFileHash(body),
        size: new TextEncoder().encode(body).length,
      };
    }
    case "skill_file_write": {
      const name = (args?.name as string) ?? "rt-android-expert";
      const rel = (args?.rel as string) ?? "SKILL.md";
      const content = (args?.content as string) ?? "";
      const expected = (args?.expectedHash as string | null) ?? null;
      const gate = skillFilesGate(name, true);
      if (gate) return gate;
      if (skillFileRelEscapes(rel)) {
        return skillFilesReject(`outside: ${rel} is not inside the skill directory`);
      }
      const tree = skillFilesFor(name);
      const current = tree[rel];
      if (current === undefined) return skillFilesReject(`not_found: ${rel}`);
      if (expected !== null && current !== null && skillFileHash(current) !== expected) {
        return skillFilesReject(`conflict: ${rel} changed on disk`);
      }
      tree[rel] = content;
      return { hash: skillFileHash(content) };
    }
    case "skill_file_create": {
      const name = (args?.name as string) ?? "rt-android-expert";
      const rel = (args?.rel as string) ?? "";
      const gate = skillFilesGate(name, true);
      if (gate) return gate;
      if (skillFileRelEscapes(rel)) {
        return skillFilesReject(`outside: ${rel} is not inside the skill directory`);
      }
      const tree = skillFilesFor(name);
      if (rel in tree) return skillFilesReject(`exists: ${rel}`);
      tree[rel] = "";
      return { hash: skillFileHash("") };
    }

    // ── Equip / candidates (ux-equip-connections) ──
    case "local_skill_candidates":
      // Scene: keep the empty Library clean (no detected-local-skills banner).
      if (sceneFlag("libraryEmpty")) return [];
      return localCandidatesData;
    case "remote_equip": {
      const rid = args?.id as string;
      const kind = args?.kind as "bundle" | "skill";
      const name = args?.name as string;
      const on = !!args?.on;
      const field = kind === "bundle" ? "bundles" : "enabled";
      const listEntry = remoteList.find((r) => r.id === rid);
      const apply = (arr: string[]) => {
        const set = new Set(arr);
        if (on) set.add(name);
        else set.delete(name);
        return [...set];
      };
      if (rid === remoteShow.id) {
        remoteShow[field] = apply(remoteShow[field]);
      }
      if (listEntry) listEntry[field] = apply(listEntry[field]);
      return {
        ok: true,
        bundles: rid === remoteShow.id ? remoteShow.bundles : listEntry?.bundles ?? [],
        enabled: rid === remoteShow.id ? remoteShow.enabled : listEntry?.enabled ?? [],
      };
    }
    case "source_add_apply": {
      const decisions = (args?.decisions as Record<string, string>) ?? {};
      const applyArgv = (args?.args as string[]) ?? [];
      // `selected_new` absent (null) means "import every NEW candidate" — the
      // back-compatible contract. A list means the user curated a subset.
      const selectedNew = (args?.selectedNew as string[] | null) ?? null;
      const scenario = sourceAddScenario(applyArgv);
      const discoveredNew = (scenario.candidates ?? [])
        .filter((c) => c.category.toUpperCase() === "NEW")
        .map((c) => c.name);
      const importedNew = selectedNew ?? discoveredNew;
      const resolved = Object.entries(decisions)
        .filter(([, action]) => action !== "skip")
        .map(([name, action]) => ({
          name,
          action,
          final_name: action === "suffix" ? `${name}-2` : name,
        }));

      const idIdx = applyArgv.indexOf("--id");
      const sourceId =
        idIdx >= 0 ? applyArgv[idIdx + 1] : parseGitSourceUrl(applyArgv[3] ?? "").cloneUrl;
      const registered = [...importedNew, ...resolved.map((r) => r.final_name)];

      for (const name of registered) {
        registry.skills[name] = {
          version: "0.1.0",
          description: `Imported from source ${sourceId}.`,
          source: `~/.skill-hub/skills/${name}`,
          type: "claude-skill",
          scope: "portable",
          upstream: null,
          managed: "external",
          origin: { source: sourceId },
        };
      }
      // Register the source itself so the card shows up on the list behind the
      // closed wizard — the whole point of the journey.
      if (sourceId && !registry.sources?.[sourceId]) {
        const parsed = parseGitSourceUrl(applyArgv[3] ?? "");
        const branchIdx = applyArgv.indexOf("--branch");
        registry.sources = registry.sources ?? {};
        registry.sources[sourceId] = {
          type: "git",
          name: sourceId,
          url: parsed.cloneUrl,
          branch: branchIdx >= 0 ? applyArgv[branchIdx + 1] : parsed.branch ?? "main",
          path: scanBaseFor(applyArgv),
          status: "up-to-date",
          error: null,
          // A curated subset persists as the source's include filter.
          ...(selectedNew && selectedNew.length < discoveredNew.length
            ? { include: registered }
            : {}),
        };
      }
      return {
        ok: true,
        registered,
        skipped: discoveredNew.filter((n) => !importedNew.includes(n)),
        resolved,
        counts: { registered: registered.length },
      };
    }

    // ── Permissions ──
    case "permissions_show": {
      const scope = (args as { scope?: { kind: string; name?: string } } | undefined)?.scope;
      const personal = Boolean((args as { personal?: boolean } | undefined)?.personal);
      if (scope?.kind === "project") {
        const base = personal
          ? ensurePersonalPermissions(scope.name ?? "")
          : permissionsProject[scope.name ?? ""] ?? emptyProjectPermissions;
        const projectPath = base.worktree_access?.path || `/Users/dev/Dev/worktrees/${scope.name ?? "project"}`;
        const worktreeEnabled = base.worktree_access?.enabled ?? false;
        const worktreeFailed = worktreeFailureProjects.has(scope.name ?? "");
        // TWIN RULE (`?companionsProvisioned=1`): mirrors the ledger mutation
        // `read_registry` applies to moon-base below (D4) — a shipped rule
        // lands where the project block lands today (A12), so the
        // Permissions screen must have a real row to tag `via
        // orchestrate-advanced`, not just a ledger entry with nothing to
        // point at.
        if (scope.name === "moon-base" && sceneFlag("companionsProvisioned")) {
          return {
            ...base,
            deny: [
              ...base.deny,
              { pattern: "Bash(git push --force:*)", kind: "deny", harnesses: null, origin: "project" },
            ],
            ask: [
              ...base.ask,
              { pattern: "Bash(gh pr merge:*)", kind: "ask", harnesses: null, origin: "project" },
            ],
          };
        }
        return {
          ...base,
          worktree_access_suggestion: `/Users/dev/Dev/worktrees/${scope.name ?? "project"}`,
          worktree_access_status: {
            requested_path: worktreeEnabled ? projectPath : null,
            missing_parent: false,
            harnesses: [
              { harness: "claude-code", config_state: worktreeFailed ? "failed" : worktreeEnabled ? "configured" : "unmanaged", runtime_state: worktreeFailed ? "not_verified" : worktreeEnabled ? "restart_required" : "not_applicable", target_file: "/Users/dev/projects/.claude/settings.local.json", reason: worktreeFailed ? "Native file write failed; retry Sync." : null },
              { harness: "codex", config_state: worktreeFailed ? "failed" : worktreeEnabled ? "configured" : "unmanaged", runtime_state: worktreeFailed ? "not_verified" : worktreeEnabled ? "needs_session_check" : "not_applicable", target_file: "/Users/dev/projects/.codex/config.toml", reason: worktreeFailed ? "Native file write failed; retry Sync." : worktreeEnabled ? "Start a new session; Desktop profile precedence is not verified." : null },
              { harness: "opencode", config_state: "unsupported", runtime_state: "not_applicable", target_file: null, reason: "This harness does not support project worktree grants." },
              { harness: "pi", config_state: "not_installed", runtime_state: "not_applicable", target_file: null, reason: "Harness is not installed." },
            ],
          },
        };
      }
      // Scene: registry-vs-native divergence (staleness + unmanaged rules) so
      // the DivergenceBanner + reconcile drawer states are visually testable.
      // Counts match the `permissions_reconcile_candidates` fixture below —
      // claude-code: cargo + terraform plan + the shared pytest row (3);
      // codex: its 3 gradlew rows + the shared pytest row + the npm conflict
      // + the un-importable default.rules row (6); total = sum (9). The
      // kept Bash(*) row is excluded — kept rules don't count as unmanaged.
      if (sceneFlag("permDivergence")) {
        return {
          ...permissionsGlobal,
          divergence: {
            unmanaged_count: 9,
            stale: true,
            last_written_at: "2026-08-26T12:06:51Z",
            harnesses: {
              "claude-code": { unmanaged: 3, stale: true },
              codex: { unmanaged: 6, stale: null },
            },
          },
        };
      }
      // TWIN RULE (`?guardrailsAttention=1`): mirrors the mutation applied to
      // `registry.permissions_global` in `read_registry` below — the panel and
      // the Permissions screen must never disagree in the same frame.
      if (sceneFlag("guardrailsAttention")) {
        return {
          ...permissionsGlobal,
          _unmanaged: ["codex"],
          approval_policy: "never",
          sandbox_mode: "danger-full-access",
        };
      }
      return permissionsGlobal;
    }
    // Nothing recently imported — ImportedBanner renders nothing for an empty
    // array, matching the honest "absent" state rather than a fake import.
    case "permissions_recent_imports":
      return [];
    case "permissions_capabilities":
      return permissionsCapabilities;
    case "permissions_doctor":
      return permissionsDoctor;
    case "permissions_risks_schema":
      return permissionsRisksSchema;
    case "permissions_validate":
      return { ok: true, error: null };
    case "permissions_set": {
      // Echo the saved payload as the normalized result so the editor's
      // save() path completes cleanly (used by the trust-confirm journey).
      // sync_rc: 0 = the auto-sync a real save now runs applied cleanly.
      const p = (args as { payload?: unknown } | undefined)?.payload;
      const scope = (args as { scope?: { kind?: string; name?: string } } | undefined)?.scope;
      const personal = Boolean((args as { personal?: boolean } | undefined)?.personal);
      if (p && typeof p === "object" && scope?.kind === "global") {
        persistPermissionPayload(permissionsGlobal, p as Record<string, unknown>, "global");
        registry.permissions_global = { ...registry.permissions_global, ...structuredClone(p) };
      } else if (p && typeof p === "object" && scope?.kind === "project" && scope.name) {
        const target = personal ? ensurePersonalPermissions(scope.name) : ensureProjectPermissions(scope.name);
        persistPermissionPayload(target, p as Record<string, unknown>, "project");
        const project = registry.projects[scope.name] as unknown as Record<string, unknown> | undefined;
        if (project) {
          const key = personal ? "permissions_local" : "permissions";
          project[key] = { ...(project[key] as Record<string, unknown> | undefined), ...structuredClone(p) };
        }
      }
      if (scope?.kind === "project" && scope.name && p && typeof p === "object") {
        const project = personal ? ensurePersonalPermissions(scope.name) : ensureProjectPermissions(scope.name);
        const payload = p as Record<string, unknown>;
        if (payload.worktree_access && typeof payload.worktree_access === "object") {
          const access = payload.worktree_access as { enabled?: unknown; path?: unknown };
          if (typeof access.enabled === "boolean" && typeof access.path === "string") {
            project.worktree_access = { enabled: access.enabled, path: access.path };
          }
        } else {
          project.worktree_access = { enabled: false, path: "" };
        }
        if (sceneFlag("worktreeAccessFails")) worktreeFailureProjects.add(scope.name);
        else worktreeFailureProjects.delete(scope.name);
      }
      const status = scope?.kind === "project" && scope.name && sceneFlag("worktreeAccessFails")
        ? { requested_path: (p as { worktree_access?: { path?: string } } | undefined)?.worktree_access?.path ?? null, missing_parent: false, harnesses: [
            { harness: "claude-code", config_state: "failed", runtime_state: "not_verified", target_file: "/Users/dev/projects/.claude/settings.local.json", reason: "Native file write failed; retry Sync." },
            { harness: "codex", config_state: "failed", runtime_state: "not_verified", target_file: "/Users/dev/projects/.codex/config.toml", reason: "Native file write failed; retry Sync." },
          ] }
        : undefined;
      return { changed: true, normalized: p ?? permissionsGlobal, sync_rc: sceneFlag("worktreeAccessFails") ? 1 : 0, ...(status ? { worktree_access_status: status } : {}) };
    }
    // `mcp_set_json` (M8) — the ONE Tauri command E1 adds: a credential
    // (header/env) edit's stdin-safe write path. Returns the payload
    // directly (the Rust command's `Result<Value, String>`, not a
    // `{success, output}` envelope) — `throw` on a refusal.
    case "mcp_set_json": {
      const mcpArgs = (args?.args as string[] | undefined) ?? [];
      const body = (args?.body as string | undefined) ?? "{}";
      const name = mcpArgs[2];
      if (sceneFlag("mcpSetFails")) {
        throw new Error(`'${name}' looks like it carries a literal secret value`);
      }
      const entry = registry.skills[name];
      if (!entry || entry.type !== "mcp-server") {
        throw new Error(`unknown MCP server '${name}'`);
      }
      const priorBlock: Record<string, unknown> = { ...(entry.mcp ?? {}) };
      let partial: Record<string, unknown> = {};
      try {
        partial = JSON.parse(body) as Record<string, unknown>;
      } catch {
        throw new Error(`invalid JSON on stdin`);
      }
      const merged = mcpDeepMergeMock(priorBlock, partial);
      entry.mcp = merged;
      const changedKeys = Object.keys({ ...priorBlock, ...merged }).filter(
        (k) => JSON.stringify(priorBlock[k] ?? null) !== JSON.stringify(merged[k] ?? null),
      );
      return {
        ok: true,
        name,
        spec: merged,
        changed_keys: changedKeys,
        warnings: [],
        prior_spec: priorBlock,
      };
    }
    // `mcp_add_json` (E2, M8) — the New sheet's ONE submit path for BOTH the
    // paste and the details mode: a pasted-or-assembled native server object
    // on stdin, never argv. Mirrors `hub mcp add --json-stdin --probe --json`.
    case "mcp_add_json": {
      // E3 rev 2 §2.5 — the structured-failure path (`{"ok":false,"error",
      // "code"}`), reachable regardless of what was pasted so every suite
      // can see BOTH the success and the failure toast.
      if (sceneFlag("adoptFails")) {
        return { ok: false, error: "a credential is written as plain text", code: "literal_secret" };
      }
      const mcpArgs = (args?.args as string[] | undefined) ?? [];
      const body = (args?.body as string | undefined) ?? "{}";
      const name = mcpArgs[2];
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(body) as Record<string, unknown>;
      } catch {
        throw new Error("invalid JSON on stdin");
      }
      let serverObj: Record<string, unknown> = parsed;
      if (parsed.mcpServers && typeof parsed.mcpServers === "object") {
        const servers = parsed.mcpServers as Record<string, Record<string, unknown>>;
        serverObj = servers[name] ?? Object.values(servers)[0] ?? {};
      }
      const allowLiteral = mcpArgs.includes("--allow-literal");
      const headers = (serverObj.headers as Record<string, string> | undefined) ?? {};
      const hasLiteral = Object.entries(headers).some(
        ([k, v]) => /token|secret|key|password/i.test(k) || /sk-[a-z0-9]{6,}/i.test(v),
      );
      if (hasLiteral && !allowLiteral) {
        throw new Error(`'${name}' looks like it carries a literal secret value`);
      }
      const transport =
        (serverObj.type as string | undefined) ?? (serverObj.command ? "stdio" : "http");
      const block: Record<string, unknown> = { transport };
      if (transport === "stdio") {
        block.command = (serverObj.command as string) || "python3";
        if (Array.isArray(serverObj.args) && serverObj.args.length) block.args = serverObj.args;
        if (serverObj.env && Object.keys(serverObj.env as object).length) block.env = serverObj.env;
      } else {
        if (serverObj.url) block.url = serverObj.url;
        if (Object.keys(headers).length) block.headers = headers;
      }
      if (typeof serverObj.timeout === "number") block.timeout_ms = serverObj.timeout;

      const scopeIdx = mcpArgs.indexOf("--scope");
      const scopeArg = scopeIdx >= 0 ? mcpArgs[scopeIdx + 1] : "global";
      const projIdx = mcpArgs.indexOf("--project");
      const project = projIdx >= 0 ? mcpArgs[projIdx + 1] : null;

      registry.skills[name] = {
        version: "1.0.0",
        description: `Registered MCP server: ${name}`,
        source: "",
        type: "mcp-server",
        scope: (scopeArg as Skill["scope"]) ?? "global",
        upstream: null,
        mcp: block,
      } as Skill;

      let equipped: { project: string } | null = null;
      if (project && registry.projects[project]) {
        const enabled = registry.projects[project].enabled ?? [];
        if (!enabled.includes(name)) registry.projects[project].enabled = [...enabled, name];
        equipped = { project };
      }

      const wantsProbe = mcpArgs.includes("--probe");
      const probe = wantsProbe
        ? {
            name,
            transport,
            state: "ok" as const,
            tool_count: 3,
            tools: ["search", "fetch", "list"],
            latency_ms: 120,
            protocol_version: "2024-11-05",
            unresolved_refs: [] as string[],
            env_from_shell: true,
            error: null,
            checked_at: "2026-09-06T12:00:00Z",
          }
        : null;

      return {
        ok: true,
        name,
        created_dir: `~/.skill-hub/mcp-servers/${name}`,
        registered: true,
        equipped,
        spec: block,
        warnings: [],
        probe,
      };
    }
    // `mcp_reconcile_apply` (E2) — one decision per action (Adopt / Adopt as
    // ${VAR} / Adopt anyway / Keep native / Adopt this one from the compare
    // sheet), all funneled through `hub mcp reconcile --apply --decisions-stdin`.
    case "mcp_reconcile_apply": {
      // E3 rev 2 §2.5 — same structured-failure shape as `mcp_add_json`,
      // so both doors' failure toasts are visible to every suite.
      if (sceneFlag("adoptFails")) {
        return { ok: false, error: "a credential is written as plain text", code: "literal_secret" };
      }
      const decisionsBody =
        (args?.decisions as { decisions?: Array<Record<string, unknown>> } | undefined) ?? {};
      const decisions = decisionsBody.decisions ?? [];
      const cliArgs = (args?.args as string[] | undefined) ?? [];
      const scopeKind: "global" | "project" = cliArgs.includes("--project") ? "project" : "global";
      const imported: string[] = [];
      const kept: string[] = [];
      const unkept: string[] = [];
      const skipped: string[] = [];
      const suggestedRefs: { name: string; key: string; var: string }[] = [];
      // E3 rev 2 §2.2/§2.3/§2.6 — `renamed` when the resolved name differs
      // from a source's own raw key. At GLOBAL scope `claimed`/`removed_native`
      // stay empty (§2.3: "nothing to claim, nothing to remove") EXCEPT that a
      // rename always removes every native source (§2.2), regardless of
      // scope. At PROJECT scope (W6): a Claude LOCAL source is removed
      // unconditionally, every other source is claimed.
      const renamed: { from: string; to: string }[] = [];
      const claimed: { harness: string; scope: string; file: string }[] = [];
      const removedNative: { harness: string; scope: string; file: string }[] = [];
      const errors: string[] = [];
      for (const d of decisions) {
        const name = (d.as as string | undefined) ?? (d.name as string);
        const candName = d.name as string;
        const action = d.action as string;
        const fromMain = mcpCandidatesData.find((c) => c.name === candName);
        const fromExtra = mcpExtraCandidatesData.find((c) => c.name === candName);
        const cand = fromMain ?? fromExtra;
        if (!cand) {
          errors.push(`unknown candidate '${candName}'`);
          continue;
        }
        if (action === "import") {
          let spec = cand.spec;
          if (!spec && d.harness) {
            const opt = cand.options.find(
              (o) => o.harness === d.harness && (!d.scope || o.scope === d.scope),
            );
            spec = opt?.spec ?? cand.options[0]?.spec ?? null;
          }
          registry.skills[name] = {
            version: "1.0.0",
            description: `Registered MCP server: ${name}`,
            source: "",
            type: "mcp-server",
            scope: "global",
            upstream: null,
            mcp: spec ?? {},
          } as Skill;
          if (d.replace_with_ref) {
            const literalKey =
              cand.warnings.find((w) => w.startsWith("literal_secret:"))?.split(":")[1] ??
              "Authorization";
            const keyPart = literalKey.toLowerCase() === "authorization" ? "TOKEN" : literalKey.toUpperCase();
            const varName = `${name.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_${keyPart}`;
            suggestedRefs.push({ name, key: literalKey, var: varName });
          }
          const renamedSource = cand.sources.find((s) => s.name !== name);
          if (renamedSource) {
            renamed.push({ from: renamedSource.name, to: name });
            // W6: a rename removes EVERY native source (E3 rev 2 §2.2) — the
            // mock used to leave `removed_native` empty even here, so the
            // flagship "Removed the ... copy." toast could never be seen in
            // the visual mock, the PR preview, or any suite sharing this mock.
            for (const s of cand.sources) {
              removedNative.push({ harness: s.harness, scope: s.scope, file: s.file });
            }
          } else if (scopeKind === "project") {
            // W6/E3 rev 2 §2.3 (project scope, non-renamed import): a Claude
            // LOCAL source is removed unconditionally; every other source is
            // claimed so the next sync rewrites it.
            for (const s of cand.sources) {
              if (s.harness === "claude-code" && s.scope === "local") {
                removedNative.push({ harness: s.harness, scope: s.scope, file: s.file });
              } else {
                claimed.push({ harness: s.harness, scope: s.scope, file: s.file });
              }
            }
          }
          if (fromMain) mcpCandidatesData = mcpCandidatesData.filter((c) => c.name !== candName);
          if (fromExtra) mcpExtraCandidatesData = mcpExtraCandidatesData.filter((c) => c.name !== candName);
          imported.push(name);
        } else if (action === "keep") {
          if (fromMain) mcpCandidatesData = mcpCandidatesData.filter((c) => c.name !== candName);
          if (fromExtra) mcpExtraCandidatesData = mcpExtraCandidatesData.filter((c) => c.name !== candName);
          if (!mcpKept.includes(candName)) mcpKept = [...mcpKept, candName];
          kept.push(candName);
        } else if (action === "unkeep") {
          mcpKept = mcpKept.filter((n) => n !== candName);
          unkept.push(candName);
        } else {
          skipped.push(candName);
        }
      }
      return {
        ok: errors.length === 0,
        imported,
        kept,
        unkept,
        skipped,
        conflicts_resolved: decisions.filter((d) => typeof d.harness === "string").length,
        synced: imported.length > 0,
        suggested_refs: suggestedRefs,
        renamed,
        claimed,
        removed_native: removedNative,
        errors,
      };
    }
    case "permissions_adopt":
      return {
        scope_kind: "global",
        harness_id: null,
        action: "import",
        imported: 0,
        backup_path: null,
        unmanaged_after: [],
      };
    case "permissions_import_candidates":
      return {
        scope_kind: "global",
        project: null,
        merged: [],
        conflicts: [],
        un_importable: [],
      };
    case "permissions_import_apply":
      return { imported: 0, dropped: 0, kept: 0 };
    case "permissions_reconcile_candidates":
      // Mirrors the permDivergence scene: general rules, specific approvals,
      // one previously kept rule, and one conflict. No action has a default.
      if (sceneFlag("permDivergence")) {
        return {
          scope_kind: "global",
          project: null,
          merged: [
            {
              pattern: "Bash(cargo:*)",
              kind: "allow",
              harnesses: null,
              kept: false,
              sources: [
                {
                  harness: "claude-code",
                  source: "settings.json",
                  file: "/Users/dev/.claude/settings.json",
                },
              ],
            },
            {
              pattern: "Bash(terraform plan:*)",
              kind: "allow",
              harnesses: null,
              kept: false,
              sources: [
                {
                  harness: "claude-code",
                  source: "settings.local.json",
                  file: "/Users/dev/projects/example-app/.claude/settings.local.json",
                },
              ],
            },
            {
              pattern: "Bash(*)",
              kind: "allow",
              harnesses: null,
              kept: true,
              sources: [
                {
                  harness: "claude-code",
                  source: "settings.json",
                  file: "/Users/dev/.claude/settings.json",
                },
              ],
            },
            {
              pattern:
                "Bash(./gradlew :app:compileDebugKotlin :app:testDebugUnitTest --tests com.example.presentation.capture.CaptureViewModelTest :data:testDebugUnitTest --tests com.example.data.local.MigrationTest --no-daemon --build-cache:*)",
              kind: "allow",
              harnesses: null,
              kept: false,
              sources: [
                {
                  harness: "codex",
                  source: "default.rules",
                  file: "/Users/dev/.codex/rules/default.rules",
                },
              ],
            },
            {
              pattern: "Bash(./gradlew :app:compileDebugKotlin:*)",
              kind: "allow",
              harnesses: null,
              kept: false,
              sources: [
                {
                  harness: "codex",
                  source: "default.rules",
                  file: "/Users/dev/.codex/rules/default.rules",
                },
              ],
            },
            {
              pattern: "Bash(./gradlew :domain:test:*)",
              kind: "ask",
              harnesses: null,
              kept: false,
              sources: [
                {
                  harness: "codex",
                  source: "default.rules",
                  file: "/Users/dev/.codex/rules/default.rules",
                },
              ],
            },
            {
              pattern: "Bash(pytest:*)",
              kind: "allow",
              harnesses: null,
              kept: false,
              sources: [
                {
                  harness: "claude-code",
                  source: "settings.json",
                  file: "/Users/dev/.claude/settings.json",
                },
                {
                  harness: "codex",
                  source: "default.rules",
                  file: "/Users/dev/.codex/rules/default.rules",
                },
              ],
            },
          ],
          conflicts: [
            {
              pattern: "Bash(npm:*)",
              options: { allow: ["claude-code"], ask: ["codex"] },
            },
          ],
          un_importable: [
            {
              source: "default.rules",
              harness: "codex",
              reason: "uses match/not_match argument constraints",
              file: "/Users/dev/.codex/rules/default.rules",
            },
          ],
        };
      }
      return {
        scope_kind: "global",
        project: null,
        merged: [],
        conflicts: [],
        un_importable: [],
      };
    case "permissions_reconcile_apply":
      return {
        imported: 0,
        dropped: 0,
        kept: 0,
        conflicts_resolved: 0,
        synced_files: [],
      };
    case "permissions_disable":
      return { mode: "restore", apply: false, entries: [], scopes_touched: [] };

    // ── Snippets ──
    case "snippets_list":
      // Scene: an empty snippet library so the Snippets list renders its empty state.
      if (sceneFlag("snippetsEmpty")) return [];
      // The mock stays honest about the real CLI contract: `--no-usage` drops
      // `usage` from every row, so a component that forgot to gate on it
      // would visibly break instead of quietly reading stale usage.
      if (args?.noUsage) return snippetsListForScene().map(dropUsage);
      return snippetsListForScene();
    case "snippet_show": {
      const shown = snippetShowForScene(args?.name as string | undefined);
      if (args?.noUsage) return dropUsage(shown);
      return shown;
    }
    case "snippet_status": {
      // `?snippetScanHangs=1` — never resolve, so a scene can photograph the
      // editor's body painted while the applied-locations scan is still
      // running (skeleton pill + spinner + disabled Delete).
      if (sceneFlag("snippetScanHangs")) return new Promise<never>(() => {});
      const scanned = snippetStatusForScene();
      // The real CLI honors `--name`; without this filter the editor's
      // Applied-to panel would list other snippets' blocks as its own.
      // android-conventions' rows come from the show payload so the list's
      // "4 applied · 2 outdated" and the panel agree.
      if (args?.name) {
        const own =
          args.name === "android-conventions"
            ? snippetShow.usage.locations
            : scanned.locations.filter((l) => l.snippet === args.name);
        return { ...scanned, locations: own };
      }
      return scanned;
    }
    case "snippet_new":
    case "snippet_apply":
    case "snippet_remove":
    case "snippet_delete":
      return snippetShow;
    case "snippet_edit":
      // An honest `SnippetEditResult`: a body edit bumps the version and
      // reports the outdated count so the Save flow's "Save & update N" and
      // its process-card wording have real numbers to show.
      return {
        ...snippetShow,
        version: snippetShow.version + 1,
        body_changed: true,
        outdated_locations: 4,
      };
    case "snippet_update":
      if (args?.all) {
        // `?snippetUpdateHangs=1` — never resolve, so a scene can photograph
        // Save's own refresh phase (busy button, process card, rows marked
        // "updating") instead of the settled after-state.
        if (sceneFlag("snippetUpdateHangs")) return new Promise<never>(() => {});
        return {
          action: "update-everywhere",
          snippet: args.name,
          refreshed: snippetShow.usage.locations.map((l) => ({
            action: "update",
            snippet: l.snippet,
            project: l.project,
            rel: l.rel,
            path: l.path,
            backup: null,
            mirrored: [],
          })),
          skipped: [],
        };
      }
      return snippetShow;

    // ── Projects ──
    case "path_exists":
      return true;
    case "project_scan_candidates":
      return [];
    case "project_add_with_path": {
      const name = String(args?.name);
      if (!registry.projects[name]) {
        const path = String(args?.path);
        const preview = mockWorktreeDefaults(["project", "worktree-defaults", "preview", "--name", name, "--path", path]).preview!;
        registry.projects[name] = { path, enabled: [], bundles: [], permissions: {
          worktree_access: { enabled: preview.access_enabled, path: preview.path },
        } };
      }
      return undefined;
    }
    case "project_edit_path":
    case "project_remove_clean":
    case "project_set_harnesses":
    case "create_empty_file":
      return undefined;
    case "project_remove_preview":
      return {
        project: "example-app",
        project_path: "/Users/dev/projects/example-app",
        removed_symlinks: [],
        removed_mcp_entries: [],
        removed_empty_dirs: [],
        warnings: [],
      };
    case "pick_directory":
      return sceneFlag("settingsPickFolder") ? "/Users/dev/projects/new-settings-project" : null;

    // ── Skill share (.skillpack) file sheets ──
    // Both resolve to a fake path so the export/import journeys can run end to
    // end without a native dialog (the real ones are Rust-side).
    case "save_file_dialog":
      return `/Users/dev/Downloads/${
        (args?.defaultName as string) ?? "skill.skillpack"
      }`;
    case "pick_file":
      return "/Users/dev/Downloads/shared-widget.skillpack";

    // ── Remotes ──
    case "remote_connectors":
      return remoteConnectorsCatalog;
    case "remote_list":
      return remoteList;
    case "remote_show": {
      const rid = args?.id as string;
      if (rid && rid !== remoteShow.id) {
        const entry = remoteList.find((r) => r.id === rid);
        if (entry) {
          return {
            ...remoteShow,
            id: entry.id,
            connector: entry.connector,
            ssh_host: entry.ssh_host,
            sync_enabled: entry.sync_enabled,
            bundles: entry.bundles,
            enabled: entry.enabled,
            resolved_skills: entry.enabled,
          };
        }
      }
      return remoteShow;
    }
    case "remote_diff":
      return remoteDiff;
    case "remote_health":
      return {
        remote: (args?.id as string) ?? "hermes-main",
        reachable: true,
        authenticated: true,
        host_key_match: true,
        ready: true,
        ok: true,
        detail_kind: "ready",
        detail: "~/.hermes",
      };
    case "remote_pin":
      return {
        remote: (args?.id as string) ?? "",
        pinned: true,
        changed: true,
        old_pins: [],
        new_pin: "SHA256:REPINnedTESTfingerprintREPINnedTEST00",
      };
    case "remote_probe":
      return {
        ssh_host: (args?.sshHost as string) ?? "",
        reachable: true,
        authenticated: true,
        ok: true,
        detail: "ready",
        detail_kind: "ready",
      };
    case "remote_scan_imports":
      return remoteScan;
    case "remote_add": {
      // Reflect the new remote in the list so the wizard's onCreated hand-off
      // (navigate → detail, and a back-nav to the list) shows it (D: registry
      // -driven cards + https journey).
      const rid = args?.id as string;
      if (rid && !remoteList.some((r) => r.id === rid)) {
        remoteList.push({
          id: rid,
          connector: (args?.connector as string) ?? "hermes",
          sync_enabled: true,
          apply_global_bundles: false,
          ssh_host: (args?.sshHost as string) ?? (args?.endpoint as string) ?? "",
          bundles: [],
          enabled: [],
        });
      }
      return { success: true, output: "ok" };
    }
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
    case "remote_list_docs":
      return {
        remote: (args?.id as string) ?? "",
        ok: true,
        docs: [
          { name: "SOUL.md", present: true, sha256: "deadbeef", managed: true },
          { name: "MEMORY.md", present: true, sha256: "deadbeef", managed: true },
          { name: "USER.md", present: false, sha256: null, managed: false },
        ],
      };
    case "remote_fetch_doc":
      return {
        doc: "MEMORY.md",
        ok: true,
        content: "# MEMORY\n\nremote agent doc content",
        sha256: "deadbeef",
      };
    case "remote_doctor":
      // Scene: one danger finding → the list banner + detail Risks section.
      if (sceneFlag("remoteDoctor")) return remoteDoctorDanger;
      return { findings: [], danger_count: 0 };
    case "remote_fetch_host_key":
      return {
        fingerprint: "SHA256:TESTfingerprintTESTfingerprintTESTfinger00",
        detail: "host key fetched",
      };
    case "remote_set_secret":
    case "remote_delete_secret":
      return undefined;
    case "remote_has_secret":
      return true;

    // ── Hooks (hooks-surface D7) — stateful; see the store above ──
    case "hook_list": {
      if (sceneFlag("hooksEmpty")) return { hooks: [], reach: {} };
      // D16: a hidden companion hook is absent from the LIBRARY under the
      // flag — the mechanism `companionRoute`'s `hookNames` gate (F2) relies
      // on to keep every `orch-*` row unroutable in that scene.
      const hooks = hooksStore.filter((h) => !companionHidden(h.name)).map(toHookRow);
      return { hooks, reach: HOOK_REACH_DEFAULT };
    }
    case "hook_capabilities":
      return sceneFlag("hookCapsVaried") ? hookCapsVaried : hookCapsDefault;
    case "hook_doctor":
      if (sceneFlag("hookDoctorFindings")) {
        return { findings: HOOK_DOCTOR_FINDINGS, danger_count: 1 };
      }
      return { findings: [], danger_count: 0 };
    case "hook_show": {
      // D16: a hidden companion hook really 404s under the flag, rather than
      // silently falling back to an unrelated hook's content.
      const requestedName = args?.name as string | undefined;
      if (requestedName && companionHidden(requestedName)) {
        throw new Error(`hook '${requestedName}' not found`);
      }
      const h = findMockHook(requestedName) ?? hooksStore[0];
      return {
        ...toHookRow(h),
        project_settings: h.project_settings,
        // Repo scripts report per-attached-project existence; the seed makes the
        // second project MISS the file so the warning badge is exercised.
        script_projects:
          h.script?.source === "repo"
            ? h.attached_projects.map((p, i) => ({ project: p, path_exists: i === 0 }))
            : undefined,
        reach: sceneFlag("hookCapsVaried")
          ? { "claude-code": "supported", codex: "feature_off" }
          : { "claude-code": "supported", codex: "supported" },
        baked_command: bakedCommandFor(h),
        builtin: builtinInfoFor(h),
        command_script: commandScriptFor(h),
        repo_script_conversion: repoScriptConversionFor(h),
      };
    }
    case "hook_script_show": {
      const h = findMockHook(args?.name as string);
      if (!h || h.script?.source !== "managed") {
        throw new Error(`hook '${args?.name}' has no managed script`);
      }
      return {
        name: h.name,
        source: "managed",
        interpreter: h.script.interpreter,
        path: managedScriptPath(h),
        // `?hookScriptMissing=1` is the ONE way to reach the "file vanished off
        // disk" state. It is a real state (someone deleted the file behind the
        // hub's back) but it is NOT reachable by any hub-driven flow, so it must
        // be opted into explicitly rather than falling out of a mock gap.
        body: sceneFlag("hookScriptMissing") ? null : (h.script_body ?? null),
      };
    }
    case "hook_script_save": {
      const h = findMockHook(args?.name as string);
      if (h) h.script_body = (args?.body as string) ?? "";
      return { success: true, output: "ok" };
    }
    case "hook_new": {
      const nm = (args?.name as string) ?? "";
      if (nm && !findMockHook(nm)) {
        const source = args?.scriptSource as string | null | undefined;
        hooksStore.push({
          name: nm,
          provenance: "user",
          event: (args?.event as string) ?? "PostToolUse",
          command: (args?.command as string) ?? "",
          description: (args?.description as string) ?? "",
          tools: (args?.tools as string[]) ?? [],
          matcher: (args?.matcher as string) ?? "",
          timeout: (args?.timeout as number | null) ?? null,
          harnesses: (args?.harnesses as string[] | null) ?? null,
          settings: {},
          project_settings: {},
          attached_global: false,
          attached_projects: [],
          script:
            source === "managed" || source === "repo"
              ? {
                  source,
                  interpreter: (args?.scriptInterpreter as string) ?? "bash",
                  path: (args?.scriptPath as string) ?? null,
                  args: (args?.scriptArgs as string) ?? null,
                }
              : null,
          // A managed hook always has a body: the CLI seeds the stub when the
          // caller sends none (`ensure_managed_script`).
          script_body:
            source === "managed"
              ? (args?.scriptBody as string) ||
                managedScriptStub(nm, (args?.scriptInterpreter as string) ?? "bash")
              : null,
        });
      }
      return { success: true, output: "ok" };
    }
    case "hook_edit": {
      const h = findMockHook(args?.name as string);
      if (h) {
        if (args?.event != null) h.event = args.event as string;
        if (args?.command != null) h.command = args.command as string;
        if (args?.description != null) h.description = args.description as string;
        if (args?.tools != null) h.tools = args.tools as string[];
        if (args?.matcher != null) h.matcher = args.matcher as string;
        if (args?.timeout !== undefined) h.timeout = args.timeout as number | null;
        if (args?.harnesses !== undefined)
          h.harnesses = args.harnesses as string[] | null;
        const source = args?.scriptSource as string | null | undefined;
        if (source === "") {
          // The CLI's clear sentinel: dropping the block also deletes the
          // managed file (what the editor's confirm dialog warns about).
          h.script = null;
          h.script_body = null;
        } else if (source === "managed" || source === "repo") {
          const interpreter = (args?.scriptInterpreter as string) ?? "bash";
          h.script = {
            source,
            interpreter,
            path: source === "repo" ? ((args?.scriptPath as string) ?? null) : null,
            args: (args?.scriptArgs as string) ?? null,
          };
          h.command = "";
          // The CLI SEEDS a runnable stub when a hook becomes managed
          // (`ensure_managed_script`), so a managed hook never exists without a
          // body. Leaving it null here fabricated a "missing on disk" state the
          // real backend cannot produce — a mock-only bug report.
          if (source === "managed" && h.script_body == null) {
            h.script_body = managedScriptStub(h.name, interpreter);
          }
          if (source === "repo") h.script_body = null;
        }
      }
      return { success: true, output: "ok" };
    }
    case "hook_delete":
      hooksStore = hooksStore.filter((h) => h.name !== (args?.name as string));
      return { success: true, output: "ok" };
    case "hook_attach": {
      const h = findMockHook(args?.name as string);
      if (h) {
        if (args?.global) h.attached_global = true;
        else {
          const p = args?.project as string;
          if (p && !h.attached_projects.includes(p)) h.attached_projects.push(p);
        }
      }
      return { success: true, output: "ok" };
    }
    case "hook_detach": {
      const h = findMockHook(args?.name as string);
      if (h) {
        if (args?.global) h.attached_global = false;
        else {
          const p = args?.project as string;
          h.attached_projects = h.attached_projects.filter((x) => x !== p);
        }
      }
      return { success: true, output: "ok" };
    }
    case "hook_set_settings": {
      const h = findMockHook(args?.name as string);
      const patch = (args?.settings as Record<string, unknown>) ?? {};
      if (h) {
        if (args?.global) {
          deepMergeInto(h.settings, patch);
        } else {
          const p = args?.project as string;
          if (p) {
            // A project override starts from the base settings (server merges
            // base ⊕ override into `show`), then folds in the patch.
            const base =
              h.project_settings[p] ??
              (JSON.parse(JSON.stringify(h.settings)) as Record<string, unknown>);
            deepMergeInto(base, patch);
            h.project_settings[p] = base;
          }
        }
      }
      return { success: true, output: "ok" };
    }

    // ── Agent docs ──
    case "list_agent_docs":
      if (!args?.includeAllMarkdown) return agentDocsListing;
      return args?.includeIgnored
        ? agentDocsMarkdownIgnoredListing
        : agentDocsMarkdownListing;
    // The gallery's fixtures are already fully sized, so there is nothing to
    // top up — the command still has to answer, though.
    case "resolve_agent_doc_dir_meta":
      return [];
    case "read_agent_doc": {
      const adRel = (args?.relativePath as string) ?? "CLAUDE.md";
      const markerErrorContent = [
        `# ${adRel.split("/").pop() ?? adRel}`,
        "",
        "Project documentation.",
        "",
        "This file includes a damaged snippet marker for preview review.",
        "<!-- skill-tree:snippet id=delivery v=1 sha=deadbeef --> trailing",
        "",
      ].join("\n");
      return {
        rel: adRel,
        absolute_path: `${AD_BASE}/${adRel}`,
        content: sceneFlag("agentDocMarkerError")
          ? markerErrorContent
          : `# ${adRel.split("/").pop() ?? adRel}\n\nProject documentation.\n\n` +
            "Use `code-review` on every diff; /brainstorm when the shape is unclear.\n",
        size: 40,
        modified_at: null,
        hash: "deadc0de",
        is_symlink: false,
        symlink_to: null,
        oversized: false,
        is_derived_pointer: false,
      };
    }
    case "write_agent_doc":
      if (sceneFlag("agentDocMarkerError")) {
        throw JSON.stringify({
          kind: "snippet_markers",
          rel: String(args?.relativePath ?? "CLAUDE.md"),
          diagnostics: [{ kind: "malformed-token", name: null, line: 6 }],
        });
      }
      return { written: [], derived: false, content: String(args?.content ?? "") };
    case "agent_docs_root_status":
      return {
        project: "example-app",
        state: "ok",
        canonical: "CLAUDE.md",
        derived: null,
        strategy: "symlink",
        reason: "",
        nested_deviations: 0,
      };
    case "agent_docs_strategy_get":
    case "agent_docs_strategy_set": {
      if (sceneFlag("settingsReadFails") && cmd === "agent_docs_strategy_get") throw new Error("Could not read linking policy.");
      const project = (args?.projectName as string | undefined) ?? null;
      if (cmd === "agent_docs_strategy_set") {
        if (sceneFlag("settingsWriteFails")) throw new Error("Could not save settings. Try again.");
        if (project) {
          if (args?.clear) settingsProjectStrategies.delete(project);
          else settingsProjectStrategies.set(project, String(args?.value));
        } else settingsGlobalStrategy = String(args?.value);
      }
      const override = project ? settingsProjectStrategies.get(project) ?? null : null;
      return { global: settingsGlobalStrategy, project, override_value: override, effective: project ? override ?? settingsGlobalStrategy : null };
    }
    case "agent_docs_publish_get":
    case "agent_docs_publish_set":
      return { project: "example-app", enabled: true, remote: "origin", branch: "main" };
    case "agent_docs_publish_now":
      return {
        project: "example-app",
        enabled: true,
        attempted: true,
        published: true,
        committed: true,
        sha: "c0ffee1",
        remote: "origin",
        branch: "main",
        reason: "published",
        message: "Published commit c0ffee1 to origin/main.",
      };
    case "agent_docs_fix_plan":
      return {
        strategy: "symlink",
        policy: { requires_claude: true, requires_agent: false, canonical: "CLAUDE.md", derived: null },
        steps: [],
        attention: [],
        flagged: [],
      };
    case "agent_docs_fix_apply":
      return { applied: false, executed: [], backups: [] };
    case "agent_docs_resolve":
      return { applied: false };

    // ─── Backup & restore ──────────────────────────────────────────────────
    // Scene flags (see `sceneFlag`):
    //   ?backupUnconfigured=1 → never set up (empty state)
    //   ?backupStale=1        → 4 consecutive push failures (StatusBar danger)
    //   ?backupPending=1      → pending_reconcile after a restore (StatusBar warn)
    //   ?backupNoKeyring=1    → degraded PAT rung (the keyring lib is missing)
    case "backup_status":
      return mockBackupStatus();
    case "backup_auth_status":
      return mockBackupAuth();
    case "backup_auth_login_pat":
      return { ...mockBackupAuth(), pat_available: true, stored: true };
    case "backup_auth_logout":
      return { ...mockBackupAuth(), pat_available: false, deleted: true };
    case "backup_init":
      backupInitialized = true;
      return {
        ok: true,
        dir: "~/.skill-tree-backup",
        remote: "git@github.com:me/skill-tree-backup.git",
        repo: "me/skill-tree-backup",
        branch: "main",
        created: true,
        create_detail: "created private repo me/skill-tree-backup",
        auth: "ssh",
        gh_login: "me",
        enabled: true,
        initialized: true,
        warnings: [],
      };
    case "backup_now": {
      // Real `hub backup now --json` shape (`backup.run_backup` + the
      // `acknowledged_restore` stamp). Note `error_kind` is absent on the
      // success path — it exists only on the `{ok:false}` refusal.
      //
      // `--acknowledge-restore` clears `pending_reconcile` in hub.py, so the
      // mock records it and `mockBackupStatus()` reports the cleared state —
      // otherwise the banner could never be seen to go away.
      const acknowledging =
        (args as { acknowledgeRestore?: boolean } | undefined)?.acknowledgeRestore === true;
      if (acknowledging) restoreAcknowledged = true;
      backupSnapshotTaken = true;
      return {
        ok: true,
        dir: "~/.skill-tree-backup",
        skipped: null,
        committed: true,
        commit: "9f2c1ab77e40d3b1c5e8a0f49b3d7e21c60a4d88",
        push_attempted: true,
        pushed: true,
        conflict: false,
        push_detail: "pushed to origin/main",
        auth: "ssh",
        counts: {
          skills: 12,
          mcp_servers: 3,
          snippets: 4,
          connectors: 1,
          state_files: 6,
          subagents: 6,
          global_docs: 2,
        },
        warnings: [],
        error: null,
        acknowledged_restore: acknowledging,
      };
    }
    case "backup_enable":
    case "backup_disable":
      if (sceneFlag("settingsWriteFails")) throw new Error("Could not save backup preferences.");
      backupEnabled = cmd === "backup_enable";
      return { ok: true, enabled: backupEnabled };
    case "restore_preview":
      if (sceneFlag("restoreConnectionFailed")) return { ok: false, error: "Could not access the backup repository. Host key verification failed." };
      return mockRestorePlan(false, args);
    case "restore_apply":
      return mockRestorePlan(true, args);
    case "recovery_command":
      return mockRecovery((args?.args as string[] | undefined) ?? []);

    default:
      console.warn(`[tauriCore mock] unhandled command: ${cmd}`);
      return undefined;
  }
}

// ─── Backup mock builders ────────────────────────────────────────────────────

/** Set by a `backup_now` carrying `--acknowledge-restore`; makes the
 *  `?backupPending=1` scene's banner clear the way the real one does. */
let restoreAcknowledged = false;

/** Set by `backup_init`, so the guided journey can actually be walked in the
 *  mocked app: stage 2 completing must move the current stage to 3. */
let backupInitialized = false;
let backupEnabled = true;
/** Set by the first successful `backup_now`, so stage 3 completes and the
 *  screen flips from the journey to the health layout — exactly as it does
 *  against the real CLI. */
let backupSnapshotTaken = false;

function mockBackupStatus() {
  const configured = !sceneFlag("backupUnconfigured") || backupInitialized;
  const stale = sceneFlag("backupStale");
  const pending = sceneFlag("backupPending") && !restoreAcknowledged;
  // `backupNoSnapshot` = a repo is configured but nothing has been committed:
  // the state the journey's third stage exists for.
  const hasSnapshot =
    configured && (!sceneFlag("backupNoSnapshot") || backupSnapshotTaken) &&
    (!sceneFlag("backupUnconfigured") || backupSnapshotTaken);
  return {
    enabled: backupEnabled,
    initialized: configured && !sceneFlag("backupUninitialized"),
    configured,
    dir: "~/.skill-tree-backup",
    remote: configured ? "git@github.com:me/skill-tree-backup.git" : null,
    repo: configured ? "me/skill-tree-backup" : null,
    branch: configured ? "main" : null,
    auth: {
      configured: "auto",
      pat_available: !sceneFlag("backupNoKeyring"),
      pat_detail: sceneFlag("backupNoKeyring")
        ? "the `keyring` package is not installed"
        : "token stored in your OS keychain",
      gh_login: "me",
      gh_active_login: sceneFlag("backupStale") ? "other-account" : "me",
      gh_account_mismatch: sceneFlag("backupStale"),
    },
    push_failures: stale ? 4 : 0,
    last_push_error: stale ? "remote: Invalid username or password" : null,
    pending_reconcile: pending,
    last_commit: hasSnapshot
      ? {
          sha: "9f2c1ab77e40d3b1c5e8a0f4",
          ts: "2026-08-04T09:12:44Z",
          subject: "snapshot from moon-base",
        }
      : null,
    ahead: configured ? 0 : null,
    behind: configured ? 0 : null,
    drift: configured ? "in-sync" : "unknown",
    // The real status embeds the whole snapshot manifest; nothing in the UI
    // reads it yet, but it must not be mocked as `null` on a configured repo.
    manifest: configured
      ? {
          schema_version: 1,
          created_at: "2026-08-04T09:12:44Z",
          hostname: "moon-base",
          hub_version: "0.9.0",
          tree_digest: "10da2fca02d59b02cd3939d7a23a25b32b8d892524208bf962f930ab4473a3c3",
          counts: { skills: 12, mcp_servers: 3, snippets: 4, connectors: 1, state_files: 6 },
          prefixes: { code_home: "/opt/skill-hub", data_home: "~/.skill-hub", home: "/Users/alice" },
        }
      : null,
    // NO push-failure warning: `backup.py` stopped restating the counters as
    // prose, because the app renders `push_failures` in the error channel and
    // the duplicate landed in the blue informational one.
    warnings: [],
  };
}

function mockBackupAuth() {
  const noKeyring = sceneFlag("backupNoKeyring");
  // `backupNoCredential` = the worst first-run case: nothing works yet, so
  // every rung must state its own concrete fix.
  const none = sceneFlag("backupNoCredential");
  if (none) {
    return {
      method: null,
      configured: "auto",
      ladder: [
        {
          method: "ssh",
          available: false,
          detail: "git@github.com: Permission denied (publickey).",
          user: null,
        },
        { method: "gh", available: false, detail: "gh CLI not installed", user: null },
        {
          method: "pat",
          available: false,
          detail: "no token stored yet — fine-grained PAT, scoped to the single backup repo",
          user: null,
        },
      ],
      keyring_available: true,
      pat_available: false,
      pat_ref: null,
      pat_detail: "no token stored yet",
      gh_login: null,
      create_method: null,
      ok: true,
    };
  }
  // `backupNoGh` = the product owner's actual machine: ssh + a stored token both
  // work, `gh` is simply not installed. The rung must read as an OPTIONAL
  // enhancement there, never as a failure.
  const noGh = sceneFlag("backupNoGh");
  return {
    method: "ssh",
    configured: "auto",
    ladder: [
      {
        method: "ssh",
        available: true,
        detail: "authenticated to github.com as me",
        user: "me",
      },
      {
        method: "gh",
        available: !noGh,
        detail: noGh ? "gh CLI not installed" : "gh CLI authenticated as me",
        user: noGh ? null : "me",
      },
      {
        method: "pat",
        available: !noKeyring,
        detail: noKeyring
          ? "the `keyring` package is not installed"
          : "token stored in your OS keychain",
        user: null,
        ref: noKeyring ? null : "skill-hub:github-backup",
      },
    ],
    keyring_available: !noKeyring,
    pat_available: !noKeyring,
    pat_ref: noKeyring ? null : "skill-hub:github-backup",
    pat_detail: noKeyring
      ? "the `keyring` package is not installed"
      : "token stored in your OS keychain",
    gh_login: noGh ? null : "me",
    create_method: noGh ? null : "gh",
    // `cmd_backup_auth` stamps ok:true on every reply, including --login-pat.
    ok: true,
  };
}

/**
 * A restore plan in the REAL `hub restore --json` shape (`_restore_public(plan)`
 * — `restore.py::build_plan` minus `resolved_registry`), carrying one of every
 * consequence class so the confirm dialog and the bootstrap restore step both
 * render their full disclosure.
 *
 * Deliberately structured, not flat: losses live inside `registry.diff.sections`,
 * executable state is three typed arrays under one object, out-of-home writes are
 * the `subagents` / `global_docs` three-way verdicts, and quarantined projects
 * are `projects` entries with `exists: false`. A mock that pre-flattened these
 * would let the adapter's real derivation rot untested.
 *
 * Scene flags: `restoreUnverified` (TOFU new-key consent path),
 * `restoreTampered` (fatal — truncated plan, no consent path at all).
 */
function mockRestorePlan(applied: boolean, args?: unknown) {
  // Echo back the source + mode that were actually requested, so the rendered
  // plan can never contradict the controls that produced it.
  const req = (args ?? {}) as { source?: string; mode?: string };
  const source = req.source || "git@github.com:me/skill-tree-backup.git";
  const mode = req.mode || "replace";
  const tampered = sceneFlag("restoreTampered");
  const newKey = sceneFlag("restoreUnverified");

  const trust = tampered
    ? {
        state: "key-mismatch",
        ok: false,
        hard: true,
        detail:
          "this source is pinned to signing key SHA256:1111aaaa2222bbbb but the snapshot is " +
          "signed by SHA256:9999ffff8888eeee — refusing.",
        key_id: "SHA256:9999ffff8888eeee",
        pinned_key_id: "SHA256:1111aaaa2222bbbb",
      }
    : newKey
      ? {
          state: "unverified-new-key",
          ok: false,
          hard: false,
          detail:
            "UNVERIFIED SNAPSHOT (new signing key SHA256:9999ffff8888eeee) — this machine has " +
            "never seen a snapshot from this source. Re-run with --trust-new-key to accept and pin it.",
          key_id: "SHA256:9999ffff8888eeee",
          pinned_key_id: null,
        }
      : {
          state: "verified",
          ok: true,
          hard: false,
          detail: "signed by the key pinned for this source",
          key_id: "SHA256:9999ffff8888eeee",
          pinned_key_id: "SHA256:9999ffff8888eeee",
        };

  const integrity = {
    tree_digest: { ok: true, detail: "tree digest matches" },
    signature: {
      state: "signed",
      pubkey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAEXAMPLEEXAMPLE skill-hub-signing",
      key_id: "SHA256:9999ffff8888eeee",
      detail: "signature verifies against the key the manifest names",
    },
    trust,
    ok: !tampered && !newKey,
  };

  const head = {
    ok: !tampered && !newKey,
    fatal: tampered,
    schema_version: 1,
    apply: applied,
    source,
    snapshot_dir: "~/.skill-hub/state/restore-cache/skill-tree-backup-1a2b3c4d5e",
    fetch_detail: "cloned to the restore cache",
    mode,
    force: false,
    integrity,
    manifest: {
      created_at: "2026-08-04T09:12:44Z",
      hostname: "moon-base",
      hub_version: "0.9.0",
      counts: {
        skills: 12,
        mcp_servers: 3,
        snippets: 4,
        connectors: 1,
        state_files: 6,
        subagents: 6,
        global_docs: 2,
      },
      prefixes: { code_home: "/opt/skill-hub", data_home: "~/.skill-hub", home: "/Users/alice" },
    },
    warnings: [
      "project 'moon-base' does not exist on this machine — kept but QUARANTINED " +
        "(path_unresolved: true). Sync skips it entirely.",
      "hook 'legacy-format' names script path(s) that do not exist here: " +
        "/Users/alice/bin/format.sh — it will fail on every PreToolUse until you fix it",
    ],
  };

  // A fatal plan is TRUNCATED after `manifest` — build_plan returns before it
  // inspects anything else. Mocking a full body here would hide that.
  if (tampered) {
    return {
      ...head,
      integrity: {
        ...integrity,
        tree_digest: { ok: false, detail: "tree digest mismatch — snapshot is incomplete" },
      },
      warnings: [],
      errors: ["integrity: tree digest mismatch — snapshot is incomplete"],
    };
  }

  const errors = [
    ...(newKey ? [`trust: ${trust.detail}`] : []),
    "this snapshot installs executable state (2 hook(s), 1 permission rule(s), " +
      "1 Codex trust grant(s)). Review the list above, then re-run with --accept-executable-state.",
  ];

  const emptySection = { added: [], lost: [], conflicts: [] };
  return {
    ...head,
    errors,
    registry: {
      target_populated: true,
      // The UI always sends a mode, so the CLI never demands one back.
      mode_required: false,
      diff: {
        sections: {
          projects: { added: ["moon-base"], lost: ["scratch-app"], conflicts: [] },
          bundles: { added: [], lost: [], conflicts: ["android"] },
          skills: { added: ["planner"], lost: ["local-only-helper"], conflicts: [] },
          remotes: emptySection,
          sources: emptySection,
          hooks: { added: ["lsp-report", "legacy-format"], lost: [], conflicts: [] },
          snippets: emptySection,
        },
        top_level_added: ["permissions_global"],
        top_level_lost: [],
        totals: { added: 5, lost: 2, conflicts: 1 },
      },
    },
    projects: [
      {
        name: "moon-base",
        path: "/Users/alice/Dev/moon-base",
        resolved: "/Users/alice/Dev/moon-base",
        exists: false,
      },
      {
        name: "note-board",
        path: "/Users/alice/Dev/note-board",
        resolved: "/Users/alice/Dev/note-board",
        exists: true,
      },
    ],
    data: {
      // `retained` = files this machine keeps that the snapshot doesn't carry.
      skills: {
        entries: ["planner", "reviewer"],
        files: 12,
        retained: ["skills/local-only/SKILL.md"],
      },
      "mcp-servers": { entries: ["fetch"], files: 3, retained: [] },
      snippets: { entries: [], files: 4, retained: ["snippets/scratch.md"] },
      connectors: { entries: [], files: 1, retained: [] },
    },
    rejected: [],
    subagents: [
      {
        rel: "harness/claude-code/agents/reviewer.md",
        harness: "claude-code",
        name: "reviewer.md",
        target: "~/.claude/agents/reviewer.md",
        action: "write",
        detail: "not present on this machine",
      },
      {
        rel: "harness/codex/agents/planner.toml",
        harness: "codex",
        name: "planner.toml",
        target: "~/.codex/agents/planner.toml",
        action: "write",
        detail: "not present on this machine",
      },
      {
        rel: "harness/claude-code/agents/unchanged.md",
        harness: "claude-code",
        name: "unchanged.md",
        target: "~/.claude/agents/unchanged.md",
        // `skip` writes nothing — it must NOT appear as an out-of-home write.
        action: "skip",
        detail: "identical",
      },
    ],
    global_docs: [
      {
        rel: "global-docs/claude-code/CLAUDE.md",
        harness: "claude-code",
        name: "CLAUDE.md",
        target: "~/.claude/CLAUDE.md",
        action: "sibling",
        detail: "differs from the local file — written alongside it as CLAUDE.md.from-backup",
      },
    ],
    links: { restored: [], dropped: [], present: false },
    executable_state: {
      hooks: [
        {
          name: "lsp-report",
          event: "PostToolUse",
          command: "python3 ~/.skill-hub/hooks/lsp_report.py --advisory",
          harnesses: ["claude-code"],
          broken: false,
          missing_paths: [],
          attached_global: true,
          attached_projects: [],
        },
        {
          name: "legacy-format",
          event: "PreToolUse",
          command: "/Users/alice/bin/format.sh",
          harnesses: null,
          broken: true,
          missing_paths: ["/Users/alice/bin/format.sh"],
          attached_global: false,
          attached_projects: ["note-board"],
        },
      ],
      permission_rules: [{ scope: "project:note-board", kind: "allow", pattern: "Bash(npm:*)" }],
      codex_trust: [
        {
          project: "note-board",
          path: "/Users/alice/Dev/note-board",
          explicit: false,
          reason:
            "has 1 translatable Bash rule(s); sync auto-grants Codex trust_level = trusted so they load",
        },
      ],
      // Restored connector / MCP-server SOURCE — code hub imports into its own
      // process, as opposed to a command it hands to a harness. An `identical`
      // entry installs nothing and carries no consent, so it is not displayed.
      code_dirs: [
        {
          kind: "connector",
          section: "connectors",
          name: "hermes",
          files: ["__init__.py", "hermes.py"],
          action: "new",
        },
        {
          kind: "mcp-server",
          section: "mcp-servers",
          name: "fetch",
          files: ["server.py"],
          action: "overwrite",
        },
        {
          kind: "connector",
          section: "connectors",
          name: "moon-base",
          files: ["__init__.py"],
          action: "identical",
        },
      ],
      any: true,
      broken_hooks: ["legacy-format"],
      accepted: false,
      requires_consent: true,
    },
    report: {
      retained_extra_files: ["state/harness-capabilities.json"],
      audit_ledgers_note: "2 append-only ledgers were merged, not replaced",
      dangling_secret_refs: [],
      redacted_mcp_env: [{ skill: "fetch", keys: ["FETCH_TOKEN", "FETCH_ORG"] }],
      dangling_skill_sources: [],
      external_connectors: [],
      nested_git: [],
      unresolved_projects: ["moon-base"],
      machine_absolute: [
        { field: "hooks.legacy-format.command", value: "/Users/alice/bin/format.sh" },
      ],
      source_restore_commands: [{ source: "starter", command: "hub source restore starter" }],
      remote_baseline_note: null,
      snapshot_warnings: [],
    },
    next_steps: [
      "hub source restore starter",
      "re-enter the redacted MCP env values (they never travel)",
      "`hub project edit-path <name> <path>` for each quarantined project",
      "review the restored registry, then run `hub sync`",
      "`hub backup now --acknowledge-restore` once you are happy — until then backup will not " +
        "push over the snapshot you restored from",
    ],
    ...(applied
      ? {
          // `applied` is an OBJECT on the wire, not a boolean.
          applied: {
            applied: true,
            backup_dir: "~/.skill-hub/_hub-backups/restore/20260804T091244Z",
            backups: [],
            writes: [
              { kind: "registry", target: "~/.skill-hub/registry.yaml" },
              { kind: "agent-file", target: "~/.claude/agents/reviewer.md", action: "write" },
            ],
            warnings: [],
            registry_backup:
              "~/.skill-hub/_hub-backups/registry/pre-restore-20260804T091244Z.yaml",
            pinned: newKey ? "SHA256:9999ffff8888eeee" : null,
          },
        }
      : {}),
  };
}
