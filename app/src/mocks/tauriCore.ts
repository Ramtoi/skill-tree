// ─── Mock stub for @tauri-apps/api/core (invoke) ─────────────────────────────
// Visual-harness only — aliased in vite.config.ts when VISUAL_MOCK=1. Returns
// rich, NON-EMPTY data for every command each screen calls so no screen renders
// blank. Shapes mirror src/types*.ts and the hooks/screens that consume them.
//
// This is a STANDALONE module (does not import the test helpers, which pull in
// vitest). The base registry below is an EXPANDED version of test/helpers.ts's
// sampleRegistry.

import type { Registry } from "@/types";

// ─── Expanded registry ───────────────────────────────────────────────────────

const registry: Registry = {
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
  },
  projects: {
    "example-app": {
      path: "/Users/dev/projects/example-app",
      bundles: ["android"],
      enabled: ["brainstorm"],
      harnesses: ["codex"],
    },
    "moon-base": {
      path: "/Users/dev/projects/moon-base-android-client",
      bundles: ["android", "openspec"],
      // codex-only is directly equipped but moon-base is claude-only (no codex
      // in its effective harnesses) → drives the M8 "won't sync here" card badge.
      enabled: ["code-review", "deep-research", "codex-only"],
      // Per-project triggering override on a portable, bundle-provided skill.
      invocation_overrides: { "rt-android-expert": "user-only" },
    },
    "skill-hub": {
      path: "/Users/dev/Dev/.skill-hub",
      bundles: ["openspec"],
      enabled: ["code-review"],
    },
  },
  bundles: {
    android: {
      description: "Android + Jetpack Compose workflows",
      icon: "🤖",
      scope: "project-specific",
      skills: [
        "rt-android-expert",
        "android-compose-ui",
        "android-jetpack-compose-material3-theming-helper",
      ],
    },
    openspec: {
      description: "Spec-driven change tracking workflows",
      icon: "📋",
      scope: "project-specific",
      skills: ["openspec-apply", "code-review"],
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
  },
};

// ─── Sync report (sync_report command) ───────────────────────────────────────
// Representative envelope exercising the freshness grammar (D4). The report sha
// deliberately differs from registry_current (a post-sync registry edit), so
// synced projects read `stale` — the interesting NEW signal this change lands.
//   moon-base : ok + affinity-skips  → stale (+ "N skills won't reach any agent")
//   example-app : ok:false + error     → error
//   skill-hub   : absent from report   → unknown ("run sync")
// (A `fresh` project + a `stale` one can't coexist under one global registry
//  sha — see design D3; fresh is covered by the freshness unit tests.)
const syncReportEnvelope = {
  report: {
    schema_version: 1,
    generated_at: "2026-07-05T14:32:10Z",
    registry_sha256: "synced1111111111111111111111111111111111111111111111111111111111",
    registry_mtime: 1751725930.482,
    ok: false,
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
        affinity_skips: [
          {
            skill: "codex-only",
            skill_harnesses: ["codex"],
            project_harnesses: ["claude-code"],
          },
        ],
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
      },
    },
  },
  registry_current: {
    sha256: "current999999999999999999999999999999999999999999999999999999999",
    mtime: 1751726500.113,
  },
};

// ─── Sources list payload (hub source list --json) ───────────────────────────

const sourceListPayload = JSON.stringify({
  sources: [
    { id: "local", type: "local", name: "Local", builtin: true, status: "local", skill_count: 7 },
    { id: "starter", type: "starter", name: "Starter Pack", builtin: true, status: "bundled", skill_count: 0 },
    {
      id: "org-skills",
      type: "git",
      name: "Org Skills",
      builtin: false,
      status: "update-available",
      skill_count: 1,
      url: "git@github.com:org/skills.git",
      branch: "main",
      path: "skills",
      current_ref: "abc123",
      remote_ref: "def456",
      last_checked_at: "2026-06-21T16:40:00Z",
      last_synced_at: "2026-06-21T16:38:00Z",
    },
  ],
  errors: [],
});

// ─── Harnesses ────────────────────────────────────────────────────────────────

// Every entry carries the `agents` capability object (from `emit_schema()`):
// claude-code + codex support sub-agent definitions; pi/opencode do not.
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
    path: "/opt/homebrew/bin/opencode",
    version: "0.3.0",
    agents: {
      supported: false,
      format: null,
      agents_dir: null,
      project_agents_dir: null,
    },
  },
];

// ─── Skill document (SKILL.md body — stresses the editor) ─────────────────────

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
  project_trust: null,
  additional_dirs: ["/Users/dev/shared", "/Users/dev/.config/skill-hub"],
  extras: {},
  _unmanaged: [],
  adoption_required: null,
};

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

// ─── Snippets ──────────────────────────────────────────────────────────────────

const snippetsList = [
  {
    name: "android-conventions",
    description: "Project conventions for Android/Compose state management.",
    tags: ["android", "compose", "state"],
    version: 3,
    created: "2026-05-01T10:00:00Z",
    updated: "2026-06-18T14:20:00Z",
    hash: "a1b2c3d4",
    usage: {
      count: 4,
      summary: "outdated",
      outdated_count: 2,
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
- Navigation is owned by the caller, not the screen.`,
  usage: {
    count: 4,
    summary: "outdated",
    outdated_count: 2,
    locations: [],
  },
};

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

const remoteScan = {
  remote: "hermes-main",
  candidates: [
    { name: "curator-notes", ref: "skills/curator-notes", sha256: "aa11", category: "NEW", origin: "remote:hermes-main" },
    { name: "self-improve-loop", ref: "skills/self-improve-loop", sha256: "bb22", category: "NEW", origin: "remote:hermes-main" },
    { name: "Bad Name", ref: "skills/Bad Name", sha256: "cc33", category: "INVALID_NAME", origin: "remote:hermes-main" },
  ],
};

// ─── Agent docs (safe stubs) ──────────────────────────────────────────────────

const agentDocsListing = {
  project_path: "/Users/dev/projects/example-app",
  root: { name: "example-app", path: "/Users/dev/projects/example-app", dirs: [], files: [] },
  instruction_sets: [],
  required_formats: ["CLAUDE"],
  policy: {
    requires_claude: true,
    requires_agent: false,
    strategy: "symlink",
    canonical: "CLAUDE.md",
    derived: null,
  },
  all_rels: ["CLAUDE.md"],
  truncated: false,
  warning: null,
};

// ─── Sub-agents (STATEFUL, per-harness) ───────────────────────────────────────
// Module-level in-memory backend so a journey mutates and re-reads realistically
// (Wave 5/6). Shapes mirror the D2 contract in lib/subagents.ts EXACTLY so the
// real components run unmodified. Two SEPARATE in-memory stores — one per
// harness — so a Codex journey never bleeds into the Claude list. The invoke
// arg is camelCase `harnessId` (omitted ⇒ claude-code); `subagent_save` reads
// `payload.harness` instead.

const SLUG_RE = /^[a-z0-9-]+$/;
const CODEX_SLUG_RE = /^[a-z0-9_-]+$/;

interface MockAgent {
  scope: "user" | "project";
  project: string | null;
  name: string;
  description: string;
  model: string; // "" = inherit
  tools_mode: "all" | "allowlist" | "denylist";
  tools: string[];
  disallowed_tools: string[];
  skills: string[];
  color: string;
  advanced_yaml: string;
  body: string;
  // Codex-only (present on codex-store agents).
  sandbox_mode?: string;
  model_reasoning_effort?: string;
  nickname_candidates?: string[];
  foreign_skill_entries?: Array<{ path: string; enabled: boolean }>;
}

interface MockBuiltin {
  name: string;
  model: string;
  description: string;
}

// Per-scope settings.json `permissions.deny` Agent(...) sets (drives `disabled`
// for claude-code).
const denySets: Record<string, Set<string>> = {
  user: new Set<string>(["legacy-helper"]), // one user agent seeded disabled
  "project:moon-base": new Set<string>(),
};

// Codex disable = file rename out of the *.toml glob; the mock models it as a
// per-name set (user scope only in this wave).
const codexDisabled = new Set<string>();

function scopeKey(scope: string, project: string | null): string {
  return scope === "project" ? `project:${project}` : "user";
}

function isDisabled(
  harness: string,
  scope: string,
  project: string | null,
  name: string,
): boolean {
  if (harness === "codex") return codexDisabled.has(name);
  return denySets[scopeKey(scope, project)]?.has(name) ?? false;
}

const BUILTINS: MockBuiltin[] = [
  {
    name: "general-purpose",
    model: "inherit",
    description: "General-purpose agent for researching complex, multi-step tasks.",
  },
  {
    name: "Explore",
    model: "inherit",
    description: "Read-only fan-out search agent for broad codebase exploration.",
  },
  {
    name: "Plan",
    model: "inherit",
    description: "Software architect agent for designing implementation plans.",
  },
];

// Codex built-ins have no file — read-only, never disable-able from the hub.
const CODEX_BUILTINS: MockBuiltin[] = [
  { name: "default", model: "inherit", description: "The default Codex agent." },
  { name: "worker", model: "inherit", description: "Focused implementation worker." },
  { name: "explorer", model: "inherit", description: "Read-only exploration agent." },
];

// Seed: 3 user agents (one with skills, one disabled via deny) + 2 project agents.
const mockAgents: MockAgent[] = [
  {
    scope: "user",
    project: null,
    name: "code-reviewer",
    description:
      "Reviews diffs for correctness bugs and reuse/simplification cleanups. Use proactively after a chunk of work.",
    model: "sonnet",
    tools_mode: "allowlist",
    tools: ["Read", "Glob", "Grep", "Skill"],
    disallowed_tools: [],
    skills: ["code-review", "deep-research"],
    color: "blue",
    advanced_yaml: "",
    body: "You are a careful code reviewer. Inspect the diff, surface correctness bugs first, then reuse and simplification opportunities. Never modify files.",
  },
  {
    scope: "user",
    project: null,
    name: "doc-writer",
    description: "Writes and maintains project documentation after verified implementation.",
    model: "",
    tools_mode: "all",
    tools: [],
    disallowed_tools: [],
    skills: [],
    color: "",
    advanced_yaml: "",
    body: "You maintain documentation. Update docs to reflect the verified change manifest.",
  },
  {
    // Disabled (in user denySet) + carries a warning so the validity dot shows.
    scope: "user",
    project: null,
    name: "legacy-helper",
    description: "An older helper kept around but disabled; references a missing skill.",
    model: "",
    tools_mode: "allowlist",
    tools: ["Read", "FancyUnknownTool"],
    disallowed_tools: [],
    skills: ["missing-skill"],
    color: "orange",
    advanced_yaml: "permissionMode: bypassPermissions\n",
    body: "Legacy helper system prompt.",
  },
  {
    scope: "project",
    project: "moon-base",
    name: "android-planner",
    description: "Plans Android/Compose features for the moon-base client.",
    model: "opus",
    tools_mode: "all",
    tools: [],
    disallowed_tools: [],
    skills: ["rt-android-expert"],
    color: "green",
    advanced_yaml: "",
    body: "You are an Android planning agent. Produce detailed Compose implementation plans.",
  },
  {
    scope: "project",
    project: "moon-base",
    name: "spec-runner",
    description: "Runs OpenSpec changes end to end for this project.",
    model: "",
    tools_mode: "denylist",
    tools: [],
    disallowed_tools: ["Bash"],
    skills: [],
    color: "purple",
    advanced_yaml: "",
    body: "You execute OpenSpec changes; do not run shell commands.",
  },
  {
    // Linked twin (in `linkedNames`) — its Codex core diverges on `description`
    // so opening it surfaces one drifted field (D3).
    scope: "user",
    project: null,
    name: "shared-agent",
    description: "Shared agent — the Claude-side description.",
    model: "sonnet",
    tools_mode: "all",
    tools: [],
    disallowed_tools: [],
    skills: ["code-review"],
    color: "blue",
    advanced_yaml: "",
    body: "You are the shared linked agent. Keep both harnesses consistent.",
  },
  {
    // Suggested pair — same name exists in both stores but NOT linked.
    scope: "user",
    project: null,
    name: "twin-suggest",
    description: "Exists in both harnesses but was never linked.",
    model: "",
    tools_mode: "all",
    tools: [],
    disallowed_tools: [],
    skills: [],
    color: "",
    advanced_yaml: "",
    body: "A candidate for linking across harnesses.",
  },
];

// Codex store — user scope only in this wave (project scope is trust-gated).
// One agent carries a foreign `skills.config` entry so the read-only
// "Other skill entries" list renders; one sets a sandbox mode + effort.
const mockCodexAgents: MockAgent[] = [
  {
    scope: "user",
    project: null,
    name: "pr_explorer",
    description: "Read-only codebase explorer for pull-request triage.",
    model: "gpt-5.3-codex-spark",
    tools_mode: "all",
    tools: [],
    disallowed_tools: [],
    skills: ["code-review"],
    color: "",
    advanced_yaml: "",
    body: "Stay in exploration mode.\nPrefer fast search over broad scans.\n",
    sandbox_mode: "read-only",
    model_reasoning_effort: "medium",
    nickname_candidates: ["Scout"],
    foreign_skill_entries: [],
  },
  {
    scope: "user",
    project: null,
    name: "release_captain",
    description: "Drives release checklists; inherits the session sandbox.",
    model: "",
    tools_mode: "all",
    tools: [],
    disallowed_tools: [],
    skills: [],
    color: "",
    advanced_yaml: 'custom_key = "kept"\n',
    body: "Run the release checklist end to end and report every step.",
    sandbox_mode: "",
    model_reasoning_effort: "",
    nickname_candidates: [],
    foreign_skill_entries: [
      { path: "/Users/dev/hand-authored/SKILL.md", enabled: false },
    ],
  },
  {
    // Codex side of the linked "shared-agent". Its description differs from the
    // Claude side → drift on `description`; the body + skills match.
    scope: "user",
    project: null,
    name: "shared-agent",
    description: "Shared agent — the Codex-side description (drifted).",
    model: "",
    tools_mode: "all",
    tools: [],
    disallowed_tools: [],
    skills: ["code-review"],
    color: "",
    advanced_yaml: "",
    body: "You are the shared linked agent. Keep both harnesses consistent.",
    sandbox_mode: "read-only",
    model_reasoning_effort: "",
    nickname_candidates: [],
    foreign_skill_entries: [],
  },
  {
    // Codex side of the suggested (unlinked) pair.
    scope: "user",
    project: null,
    name: "twin-suggest",
    description: "Exists in both harnesses but was never linked.",
    model: "",
    tools_mode: "all",
    tools: [],
    disallowed_tools: [],
    skills: [],
    color: "",
    advanced_yaml: "",
    body: "A candidate for linking across harnesses.",
    sandbox_mode: "",
    model_reasoning_effort: "",
    nickname_candidates: [],
    foreign_skill_entries: [],
  },
];

// ─── Linked twins (D3) — user-scope link sidecar membership + drift ───────────

// Names explicitly linked across harnesses (membership only, never content).
const linkedNames = new Set<string>(["shared-agent"]);

function userNamesIn(store: MockAgent[]): Set<string> {
  return new Set(store.filter((a) => a.scope === "user").map((a) => a.name));
}

/** The store for the "other" harness (link twins live in claude+codex). */
function otherStoreFor(harness: string): MockAgent[] {
  return harness === "codex" ? mockAgents : mockCodexAgents;
}

function otherHarnessOf(harness: string): string {
  return harness === "codex" ? "claude-code" : "codex";
}

/** `link` field for one agent: linked / suggested / null (D3). User scope only. */
function linkInfoFor(
  agent: MockAgent,
  harness: string,
): { linked: boolean; harnesses: string[]; twin_lost: boolean; suggested: boolean } | null {
  if (agent.scope !== "user") return null;
  const otherNames = userNamesIn(otherStoreFor(harness));
  if (linkedNames.has(agent.name)) {
    return {
      linked: true,
      harnesses: ["claude-code", "codex"],
      twin_lost: !otherNames.has(agent.name),
      suggested: false,
    };
  }
  if (otherNames.has(agent.name)) {
    return {
      linked: false,
      harnesses: [otherHarnessOf(harness), harness].sort(),
      twin_lost: false,
      suggested: true,
    };
  }
  return null;
}

function sharedCoreOf(a: MockAgent): {
  description: string;
  instructions: string;
  skills: string[];
} {
  return {
    description: a.description,
    instructions: (a.body || "").replace(/\s+$/, ""),
    skills: [...a.skills],
  };
}

/** Per-field drift between the claude + codex user-scope files of `name`. */
function computeMockDrift(
  name: string,
): Array<{ field: string; values: Record<string, unknown> }> {
  const c = mockAgents.find((a) => a.scope === "user" && a.name === name);
  const x = mockCodexAgents.find((a) => a.scope === "user" && a.name === name);
  if (!c || !x) return [];
  const cc = sharedCoreOf(c);
  const xc = sharedCoreOf(x);
  const out: Array<{ field: string; values: Record<string, unknown> }> = [];
  const eq = (f: "description" | "instructions" | "skills") =>
    f === "skills"
      ? JSON.stringify(cc.skills) === JSON.stringify(xc.skills)
      : cc[f] === xc[f];
  for (const f of ["description", "instructions", "skills"] as const) {
    if (!eq(f))
      out.push({ field: f, values: { "claude-code": cc[f], codex: xc[f] } });
  }
  return out;
}

// ─── D5 two-phase provisioning state ──────────────────────────────────────────
// Registry-known skills that do NOT yet resolve; `subagent_save` reports a
// newly-attached one as a blocking `needs_provisioning` error, and
// `subagent_provision_skill` flips its resolution so the re-save validates clean.
//   - needs-global : plain make-global path.
//   - remote-note  : remote-quarantined → provisioning hard-refuses (dead stop).
//   - codex-only   : harness-narrowed → widen_available on a claude provision.
interface ProvSkill {
  invocable: boolean;
  origin?: string; // "remote:<id>" → hard refuse
  affinity?: string[]; // harnesses: restriction
  resolvedUser: boolean; // resolves in every user-scope (global)
  resolvedProjects: Set<string>;
}
const provState: Record<string, ProvSkill> = {
  "needs-global": { invocable: true, resolvedUser: false, resolvedProjects: new Set() },
  "remote-note": {
    invocable: true,
    origin: "remote:box",
    resolvedUser: false,
    resolvedProjects: new Set(),
  },
  "codex-only": {
    invocable: true,
    affinity: ["codex"],
    resolvedUser: false,
    resolvedProjects: new Set(),
  },
};

function provResolved(ps: ProvSkill, scope: string, project: string | null): boolean {
  return scope === "user" ? ps.resolvedUser : ps.resolvedProjects.has(project ?? "");
}

// Attachable-skills options per scope. Includes a non-invocable
// (disable-model-invocation) skill that the picker must show DISABLED, and at
// least one resolvable/attachable skill.
function attachableFor(scope: string, _project: string | null): AttachableSkill[] {
  const base: AttachableSkill[] = [
    {
      name: "code-review",
      description: "Review the current diff for correctness bugs and cleanups.",
      resolved: true,
      invocable: true,
      project_only: false,
      attachable: true,
      reason: "",
    },
    {
      name: "deep-research",
      description: "Deep research harness — fan-out web searches, verify, synthesize.",
      resolved: true,
      invocable: true,
      project_only: false,
      attachable: true,
      reason: "",
    },
    {
      name: "brainstorm",
      description: "Spin up a team of expert agents to brainstorm a feature.",
      resolved: true,
      invocable: true,
      project_only: false,
      attachable: true,
      reason: "",
    },
    {
      // disable-model-invocation: cannot be preloaded → blocked in the picker.
      name: "fs-mcp",
      description: "Filesystem MCP server (model invocation disabled).",
      resolved: true,
      invocable: false,
      project_only: false,
      attachable: false,
      reason: "Skill has disable-model-invocation: true and cannot be preloaded.",
    },
  ];
  if (scope === "project") {
    base.push({
      name: "rt-android-expert",
      description: "Android Jetpack Compose planner and architecture advisor.",
      resolved: true,
      invocable: true,
      project_only: true,
      attachable: true,
      reason: "",
    });
  }
  // D5 provisioning fixtures — registry-known, resolution tracked in provState.
  for (const [nm, ps] of Object.entries(provState)) {
    const resolved = provResolved(ps, scope, _project);
    base.push({
      name: nm,
      description: registry.skills[nm]?.description ?? nm,
      resolved,
      invocable: ps.invocable,
      project_only: false,
      attachable: resolved && ps.invocable,
      reason: resolved ? "" : "not synced/resolvable in this scope",
    });
  }
  return base;
}

interface AttachableSkill {
  name: string;
  description: string;
  resolved: boolean;
  invocable: boolean;
  project_only: boolean;
  attachable: boolean;
  reason: string;
}

// Derived list item (the `valid`/`warnings` the card reads).
function toListItem(a: MockAgent, harness = "claude-code") {
  const isCodex = harness === "codex";
  const warnings: Array<{ field: string; level: "warn" | "error"; message: string; value?: unknown }> = [];
  if (!(isCodex ? CODEX_SLUG_RE : SLUG_RE).test(a.name)) {
    warnings.push({ field: "name", level: "error", message: "Invalid name slug.", value: a.name });
  }
  const att = attachableFor(a.scope, a.project);
  for (const s of a.skills) {
    const hit = att.find((x) => x.name === s);
    if (!hit) {
      warnings.push({ field: "skills", level: "warn", message: `Skill ${s} does not resolve in scope.`, value: s });
    } else if (!hit.invocable) {
      warnings.push({ field: "skills", level: "error", message: `Skill ${s} cannot be preloaded (disable-model-invocation).`, value: s });
    }
  }
  if (/permissionMode:\s*bypassPermissions/.test(a.advanced_yaml)) {
    warnings.push({ field: "advanced_yaml", level: "warn", message: "permissionMode: bypassPermissions is risky.", value: "bypassPermissions" });
  }
  const valid = !warnings.some((w) => w.level === "error");
  const ext = isCodex ? "toml" : "md";
  const dir = isCodex ? ".codex/agents" : ".claude/agents";
  return {
    name: a.name,
    file: `${a.name}.${ext}`,
    relpath: `${a.scope === "project" ? "<project>/" : "~/"}${dir}/${a.name}.${ext}`,
    description: a.description,
    model: a.model,
    tools_mode: a.tools_mode,
    tools: a.tools,
    disallowed_tools: a.disallowed_tools,
    skills: a.skills,
    color: a.color,
    disabled: isDisabled(harness, a.scope, a.project, a.name),
    builtin: false,
    valid,
    warnings,
    link: linkInfoFor(a, harness),
    // Codex-only extras (absent from the claude contract).
    ...(isCodex
      ? {
          sandbox_mode: a.sandbox_mode ?? "",
          model_reasoning_effort: a.model_reasoning_effort ?? "",
          nickname_candidates: a.nickname_candidates ?? [],
        }
      : {}),
  };
}

function allowDiscovery(a: MockAgent): boolean {
  if (a.tools_mode === "all") return true;
  if (a.tools_mode === "allowlist") return a.tools.includes("Skill");
  return true; // denylist: discovery on unless Skill denied
}

function dispatchSubagent(cmd: string, args?: Record<string, unknown>): unknown {
  const scope = (args?.scope as string) ?? "user";
  const project = (args?.project as string | null) ?? null;
  const name = args?.name as string | undefined;
  // Camelcase invoke arg (mirrors the Rust command signature); `subagent_save`
  // carries the harness inside its payload instead.
  const harness = (args?.harnessId as string) ?? "claude-code";
  const isCodex = harness === "codex";
  const store = isCodex ? mockCodexAgents : mockAgents;

  switch (cmd) {
    case "subagent_list": {
      const agents = store
        .filter((a) => a.scope === scope && (scope !== "project" || a.project === project))
        .map((a) => toListItem(a, harness));
      return {
        harness,
        scope,
        project,
        agents_dir: isCodex
          ? "/Users/dev/.codex/agents"
          : scope === "project"
            ? `/Users/dev/projects/${project}/.claude/agents`
            : "/Users/dev/.claude/agents",
        // Codex has no settings.json disable target — deterministic "" (D6).
        settings_path: isCodex
          ? ""
          : scope === "project"
            ? `/Users/dev/projects/${project}/.claude/settings.json`
            : "/Users/dev/.claude/settings.json",
        agents,
        builtins: (isCodex ? CODEX_BUILTINS : BUILTINS).map((b) => ({
          ...b,
          disabled: isCodex ? false : isDisabled(harness, scope, project, b.name),
          builtin: true,
        })),
        links_warning: null,
      };
    }

    case "subagent_show": {
      const a = store.find(
        (x) => x.name === name && x.scope === scope && (scope !== "project" || x.project === project),
      );
      if (!a) {
        return {
          name: name ?? "",
          scope,
          harness,
          file: "",
          exists: false,
          safe: {
            name: name ?? "",
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
          advanced_format: isCodex ? "toml" : "yaml",
          foreign_skill_entries: [],
          body: "",
          disabled: false,
          validation: { valid: true, warnings: [] },
        };
      }
      const item = toListItem(a, harness);
      const file = isCodex
        ? `/Users/dev/.codex/agents/${a.name}.toml`
        : `${a.scope === "project" ? `/Users/dev/projects/${a.project}` : "/Users/dev"}/.claude/agents/${a.name}.md`;
      return {
        name: a.name,
        scope: a.scope,
        harness,
        file,
        exists: true,
        safe: {
          name: a.name,
          description: a.description,
          model: a.model,
          tools_mode: a.tools_mode,
          tools: a.tools,
          disallowed_tools: a.disallowed_tools,
          allow_skill_discovery: allowDiscovery(a),
          skills: a.skills,
          color: a.color,
          ...(isCodex
            ? {
                sandbox_mode: a.sandbox_mode ?? "",
                model_reasoning_effort: a.model_reasoning_effort ?? "",
                nickname_candidates: a.nickname_candidates ?? [],
              }
            : {}),
        },
        advanced_yaml: a.advanced_yaml,
        advanced_format: isCodex ? "toml" : "yaml",
        foreign_skill_entries: isCodex ? a.foreign_skill_entries ?? [] : [],
        body: a.body,
        disabled: isDisabled(harness, a.scope, a.project, a.name),
        validation: { valid: item.valid, warnings: item.warnings },
        link: linkInfoFor(a, harness),
        drift:
          a.scope === "user" && linkedNames.has(a.name)
            ? computeMockDrift(a.name)
            : null,
        links_warning: null,
      };
    }

    case "subagent_save": {
      const payload = args?.payload as
        | {
            harness?: string;
            scope: "user" | "project";
            project: string | null;
            original_name: string | null;
            safe: {
              name: string;
              description: string;
              model: string;
              tools_mode: "all" | "allowlist" | "denylist";
              tools: string[];
              disallowed_tools: string[];
              allow_skill_discovery: boolean;
              skills: string[];
              color: string;
              sandbox_mode?: string;
              model_reasoning_effort?: string;
              nickname_candidates?: string[];
            };
            advanced_yaml: string;
            body: string;
          }
        | undefined;
      if (!payload) return { ok: false, warnings: [], errors: [{ field: "_", level: "error", message: "Missing payload." }] };
      const saveHarness = payload.harness ?? "claude-code";
      const saveCodex = saveHarness === "codex";
      const saveStore = saveCodex ? mockCodexAgents : mockAgents;
      const s = payload.safe;
      const errors: Array<{
        field: string;
        level: "error";
        message: string;
        value?: unknown;
        needs_provisioning?: {
          skill: string;
          scope_fix: "make-global" | "project-enable";
          consequence: string;
        };
      }> = [];

      // Blocking rules the UI relies on (D3 subset; codex allows underscores).
      if (!(saveCodex ? CODEX_SLUG_RE : SLUG_RE).test(s.name.trim())) {
        errors.push({
          field: "name",
          level: "error",
          message: saveCodex
            ? "Name must use lowercase letters, numbers, hyphens, and underscores only."
            : "Name must use lowercase letters, numbers, and hyphens only.",
          value: s.name,
        });
      }
      if (!s.description.trim()) {
        errors.push({ field: "description", level: "error", message: "Description is required." });
      }
      if (saveCodex && payload.scope === "project") {
        errors.push({ field: "scope", level: "error", message: "Codex project agents ship in a later wave (requires project trust)." });
      }
      if (
        saveCodex &&
        !["", "read-only", "workspace-write", "danger-full-access"].includes(s.sandbox_mode ?? "")
      ) {
        errors.push({ field: "sandbox_mode", level: "error", message: `Invalid sandbox_mode: ${s.sandbox_mode}.`, value: s.sandbox_mode });
      }
      const att = attachableFor(payload.scope, payload.project);
      // Skills that were already on the agent (by original_name) are NOT "newly
      // attached" — a pre-existing unresolved skill stays a plain warning (D5).
      const priorAgent = saveStore.find(
        (x) =>
          x.name === (payload.original_name ?? "") &&
          x.scope === payload.scope &&
          (payload.scope !== "project" || x.project === payload.project),
      );
      const priorSkills = new Set(priorAgent?.skills ?? []);
      for (const sk of s.skills) {
        const hit = att.find((x) => x.name === sk);
        if (hit && !hit.invocable) {
          errors.push({ field: "skills", level: "error", message: `Skill ${sk} cannot be preloaded (disable-model-invocation).`, value: sk });
          continue;
        }
        // D5 phase 1: a NEWLY-attached, registry-known, unresolved skill blocks
        // the save with a needs_provisioning detail (never provisions here).
        const ps = provState[sk];
        if (ps && !priorSkills.has(sk) && !(hit?.resolved)) {
          const scopeFix =
            payload.scope === "user" ? "make-global" : "project-enable";
          const consequence =
            scopeFix === "make-global"
              ? `Makes '${sk}' global — it is installed into every harness's user-level skill directory, not just this agent.`
              : `Enables '${sk}' for project '${payload.project ?? "?"}' and syncs it so the agent can preload it.`;
          errors.push({
            field: "skills",
            level: "error",
            message: `Skill ${sk} does not resolve in this scope yet — provisioning required.`,
            value: sk,
            needs_provisioning: { skill: sk, scope_fix: scopeFix, consequence },
          });
        }
      }
      // Name collision within scope (excluding self).
      const collision = saveStore.find(
        (x) =>
          x.name === s.name.trim() &&
          x.scope === payload.scope &&
          (payload.scope !== "project" || x.project === payload.project) &&
          x.name !== payload.original_name,
      );
      if (collision) {
        errors.push({ field: "name", level: "error", message: `An agent named ${s.name} already exists in this scope.`, value: s.name });
      }
      if (errors.length) return { ok: false, warnings: [], errors };

      // ── Linked co-write prep (D3): capture pre-save drift + old shared core.
      const linkName = payload.original_name ?? s.name.trim();
      const isLinkedSave =
        payload.scope === "user" && linkedNames.has(linkName);
      const preDrift = new Set(
        isLinkedSave ? computeMockDrift(linkName).map((d) => d.field) : [],
      );
      const oldSelf = isLinkedSave
        ? saveStore.find((a) => a.scope === "user" && a.name === linkName)
        : undefined;
      const oldSelfCore = oldSelf ? sharedCoreOf(oldSelf) : null;
      if (isLinkedSave && oldSelfCore) {
        const newCore = {
          description: s.description,
          instructions: (payload.body || "").replace(/\s+$/, ""),
          skills: [...s.skills],
        };
        const blocked: string[] = [];
        for (const f of preDrift) {
          const ch =
            f === "skills"
              ? JSON.stringify(newCore.skills) !==
                JSON.stringify(oldSelfCore.skills)
              : (newCore as Record<string, unknown>)[f] !==
                (oldSelfCore as unknown as Record<string, unknown>)[f];
          if (ch) blocked.push(f);
        }
        if (blocked.length) {
          return {
            ok: false,
            warnings: [],
            errors: blocked.map((f) => ({
              field: f,
              level: "error" as const,
              message:
                "this field has drifted between the linked files — resolve the drift first",
              value: f,
            })),
          };
        }
      }

      const warnings: Array<{ field: string; level: "warn"; message: string; value?: unknown }> = [];
      if (!saveCodex && /permissionMode:\s*bypassPermissions/.test(payload.advanced_yaml)) {
        warnings.push({ field: "advanced_yaml", level: "warn", message: "permissionMode: bypassPermissions is risky." });
      }

      // Persist (create or update; honor rename). Foreign skills.config entries
      // are preserved verbatim across a codex save (D2/M6).
      const idx = saveStore.findIndex(
        (x) =>
          x.name === (payload.original_name ?? s.name.trim()) &&
          x.scope === payload.scope &&
          (payload.scope !== "project" || x.project === payload.project),
      );
      // Skill tool reflects discovery toggle for allowlist agents.
      let tools = [...s.tools];
      if (s.tools_mode === "allowlist") {
        tools = tools.filter((t) => t !== "Skill");
        if (s.allow_skill_discovery) tools.push("Skill");
      }
      const next: MockAgent = {
        scope: payload.scope,
        project: payload.scope === "project" ? payload.project : null,
        name: s.name.trim(),
        description: s.description,
        model: s.model,
        tools_mode: s.tools_mode,
        tools,
        disallowed_tools: s.disallowed_tools,
        skills: s.skills,
        color: s.color,
        advanced_yaml: payload.advanced_yaml,
        body: payload.body,
        ...(saveCodex
          ? {
              sandbox_mode: s.sandbox_mode ?? "",
              model_reasoning_effort: s.model_reasoning_effort ?? "",
              nickname_candidates: s.nickname_candidates ?? [],
              foreign_skill_entries:
                idx >= 0 ? saveStore[idx].foreign_skill_entries ?? [] : [],
            }
          : {}),
      };
      const renamed_from =
        payload.original_name && payload.original_name !== s.name.trim()
          ? payload.original_name
          : null;
      if (idx >= 0) {
        saveStore[idx] = next;
        // Carry the disable state across a rename.
        if (renamed_from) {
          if (saveCodex) {
            if (codexDisabled.has(renamed_from)) {
              codexDisabled.delete(renamed_from);
              codexDisabled.add(next.name);
            }
          } else {
            const k = scopeKey(payload.scope, next.project);
            if (denySets[k]?.has(renamed_from)) {
              denySets[k].delete(renamed_from);
              denySets[k].add(next.name);
            }
          }
        }
      } else {
        saveStore.push(next);
      }
      // ── Linked co-write (D3): push changed non-drifted shared-core fields to
      // the twin (drifted fields frozen); rename the twin file too.
      let cowrote_twin = false;
      let twin_harness: string | null = null;
      if (isLinkedSave && oldSelfCore) {
        const twinStore = otherStoreFor(saveHarness);
        const twinIdx = twinStore.findIndex(
          (a) => a.scope === "user" && a.name === linkName,
        );
        if (twinIdx >= 0) {
          const twin = twinStore[twinIdx];
          const newCore = sharedCoreOf(next);
          let changed = false;
          if (
            !preDrift.has("description") &&
            newCore.description !== oldSelfCore.description
          ) {
            twin.description = newCore.description;
            changed = true;
          }
          if (
            !preDrift.has("instructions") &&
            newCore.instructions !== oldSelfCore.instructions
          ) {
            twin.body = next.body;
            changed = true;
          }
          if (
            !preDrift.has("skills") &&
            JSON.stringify(newCore.skills) !== JSON.stringify(oldSelfCore.skills)
          ) {
            twin.skills = [...next.skills];
            changed = true;
          }
          if (renamed_from) {
            twin.name = next.name;
            changed = true;
            if (linkedNames.has(renamed_from)) {
              linkedNames.delete(renamed_from);
              linkedNames.add(next.name);
            }
          }
          if (changed) {
            cowrote_twin = true;
            twin_harness = otherHarnessOf(saveHarness);
          }
        }
      }

      const file = saveCodex
        ? `/Users/dev/.codex/agents/${next.name}.toml`
        : `${next.scope === "project" ? `/Users/dev/projects/${next.project}` : "/Users/dev"}/.claude/agents/${next.name}.md`;
      return {
        ok: true,
        name: next.name,
        file,
        warnings,
        renamed_from,
        cowrote_twin,
        twin_harness,
      };
    }

    case "subagent_delete": {
      const idx = store.findIndex(
        (x) => x.name === name && x.scope === scope && (scope !== "project" || x.project === project),
      );
      if (idx >= 0) store.splice(idx, 1);
      if (isCodex) codexDisabled.delete(name ?? "");
      else denySets[scopeKey(scope, project)]?.delete(name ?? "");
      return { ok: true };
    }

    case "subagent_set_disabled": {
      const disabled = !!args?.disabled;
      if (isCodex) {
        // Codex built-ins have no file — the backend refuses to disable them.
        // (Rejected promise, not a throw: it flattens through Promise.resolve.)
        if (CODEX_BUILTINS.some((b) => b.name === name)) {
          return Promise.reject(
            new Error(`Cannot disable built-in codex agent ${name}.`),
          );
        }
        if (disabled) codexDisabled.add(name ?? "");
        else codexDisabled.delete(name ?? "");
        return { ok: true, disabled };
      }
      const k = scopeKey(scope, project);
      if (!denySets[k]) denySets[k] = new Set<string>();
      if (disabled) denySets[k].add(name ?? "");
      else denySets[k].delete(name ?? "");
      return { ok: true, disabled };
    }

    case "subagent_attachable_skills":
      return attachableFor(scope, project);

    // ── D5 phase 2: provision so the re-save resolves (mutates provState) ──────
    case "subagent_provision_skill": {
      const skill = (args?.skill as string) ?? "";
      const isGlobal = !!args?.global;
      const provProject = (args?.project as string | null) ?? null;
      const provHarness = (args?.harnessId as string) ?? "claude-code";
      const widen = !!args?.widenAffinity;
      const ps = provState[skill];
      if (!ps) return { ok: false, error: `unknown skill '${skill}' (not in the registry)` };
      // Guard 1 — remote quarantine: hard refuse, no override.
      if (ps.origin?.startsWith("remote:")) {
        const rid = ps.origin.slice("remote:".length) || "?";
        return {
          ok: false,
          error: `skill '${skill}' is quarantined (imported from remote '${rid}'). Remote-origin skills are held project-specific by design and cannot be provisioned — no override.`,
        };
      }
      // Guard 2 — affinity excludes the agent's harness → offer widen or refuse.
      let widened = false;
      if (ps.affinity && !ps.affinity.includes(provHarness)) {
        if (!widen) {
          return {
            ok: false,
            error: `skill '${skill}' is restricted to harnesses ${JSON.stringify(ps.affinity)}, which excludes '${provHarness}'; the provisioned link would dangle. Widen the affinity to clear the restriction.`,
            affinity: [...ps.affinity],
            widen_available: true,
          };
        }
        delete ps.affinity;
        widened = true;
      }
      if (isGlobal) {
        ps.resolvedUser = true;
        return {
          ok: true,
          skill,
          mode: "make-global",
          path: `/Users/dev/.claude/skills/${skill}/SKILL.md`,
          widened_affinity: widened,
        };
      }
      ps.resolvedProjects.add(provProject ?? "");
      return {
        ok: true,
        skill,
        mode: "project-enable",
        path: `/Users/dev/projects/${provProject}/.claude/skills/${skill}/SKILL.md`,
        widened_affinity: widened,
      };
    }

    case "subagent_skill_usage": {
      const usage: Record<
        string,
        Array<{ agent: string; scope: string; project: string | null; harness: string }>
      > = {};
      for (const a of mockAgents) {
        for (const sk of a.skills) {
          (usage[sk] ??= []).push({ agent: a.name, scope: a.scope, project: a.project, harness: "claude-code" });
        }
      }
      for (const a of mockCodexAgents) {
        for (const sk of a.skills) {
          (usage[sk] ??= []).push({ agent: a.name, scope: a.scope, project: a.project, harness: "codex" });
        }
      }
      return usage;
    }

    // ── Linked twins (D3) — user scope only ──────────────────────────────────
    case "subagent_link": {
      const nm = name ?? "";
      const copyFrom = args?.copyFrom as string | undefined;
      const inClaude = mockAgents.some((a) => a.scope === "user" && a.name === nm);
      const inCodex = mockCodexAgents.some(
        (a) => a.scope === "user" && a.name === nm,
      );
      if (!inClaude || !inCodex) {
        if (!copyFrom)
          return { ok: false, error: `agent '${nm}' is missing in a harness` };
        const srcStore = copyFrom === "codex" ? mockCodexAgents : mockAgents;
        const src = srcStore.find((a) => a.scope === "user" && a.name === nm);
        if (!src)
          return {
            ok: false,
            error: `copyFrom '${copyFrom}' has no agent '${nm}'`,
          };
        const tgtStore = copyFrom === "codex" ? mockAgents : mockCodexAgents;
        const tgtIsCodex = tgtStore === mockCodexAgents;
        if (!tgtStore.some((a) => a.scope === "user" && a.name === nm)) {
          // Project the shared core; model resets to inherit (namespaces differ).
          tgtStore.push({
            scope: "user",
            project: null,
            name: nm,
            description: src.description,
            model: "",
            tools_mode: "all",
            tools: [],
            disallowed_tools: [],
            skills: [...src.skills],
            color: "",
            advanced_yaml: "",
            body: src.body,
            ...(tgtIsCodex
              ? {
                  sandbox_mode: "",
                  model_reasoning_effort: "",
                  nickname_candidates: [],
                  foreign_skill_entries: [],
                }
              : {}),
          });
        }
      }
      linkedNames.add(nm);
      return {
        ok: true,
        name: nm,
        harnesses: ["claude-code", "codex"],
        drift: computeMockDrift(nm),
      };
    }

    case "subagent_unlink": {
      const nm = name ?? "";
      const had = linkedNames.delete(nm);
      return { ok: true, name: nm, unlinked: had };
    }

    case "subagent_link_status": {
      const links = [...linkedNames].map((nm) => ({
        name: nm,
        harnesses: ["claude-code", "codex"],
        twin_lost: !(
          mockAgents.some((a) => a.scope === "user" && a.name === nm) &&
          mockCodexAgents.some((a) => a.scope === "user" && a.name === nm)
        ),
        drift: computeMockDrift(nm),
      }));
      const claudeNames = userNamesIn(mockAgents);
      const codexNames = userNamesIn(mockCodexAgents);
      const suggestions = [...claudeNames]
        .filter((n) => codexNames.has(n) && !linkedNames.has(n))
        .map((n) => ({ name: n, harnesses: ["claude-code", "codex"] }));
      return { links, suggestions };
    }

    case "subagent_resolve_drift": {
      const nm = name ?? "";
      const decisions = (args?.decisions as Record<string, string>) ?? {};
      const c = mockAgents.find((a) => a.scope === "user" && a.name === nm);
      const x = mockCodexAgents.find((a) => a.scope === "user" && a.name === nm);
      if (!c || !x) return { ok: false, error: "a linked twin file is missing" };
      for (const [field, winner] of Object.entries(decisions)) {
        const win = winner === "codex" ? x : c;
        const lose = winner === "codex" ? c : x;
        if (field === "description") lose.description = win.description;
        else if (field === "instructions") lose.body = win.body;
        else if (field === "skills") lose.skills = [...win.skills];
      }
      return { ok: true, name: nm, drift: computeMockDrift(nm) };
    }

    default:
      return undefined;
  }
}

// ─── Dispatch ─────────────────────────────────────────────────────────────────

/** Optional IPC latency (ms), off by default so normal harness runs are
 *  unaffected. Set via `window.__IPC_DELAY_MS` or the `?ipcDelay=<ms>` query
 *  param — used by the responsiveness e2e journey to prove the UI stays live
 *  while a command is in flight. The dispatch itself runs eagerly (so mock
 *  state mutations still apply synchronously); only the resolve is delayed. */
function ipcDelayMs(): number {
  if (typeof window === "undefined") return 0;
  const w = window as unknown as { __IPC_DELAY_MS?: number };
  if (typeof w.__IPC_DELAY_MS === "number" && w.__IPC_DELAY_MS > 0) {
    return w.__IPC_DELAY_MS;
  }
  try {
    const raw = new URLSearchParams(window.location.search).get("ipcDelay");
    const n = raw ? Number(raw) : 0;
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

export function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const result = dispatch(cmd, args) as T;
  const delay = ipcDelayMs();
  if (delay > 0) {
    return new Promise((resolve) => setTimeout(() => resolve(result), delay));
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

function dispatch(cmd: string, args?: Record<string, unknown>): unknown {
  if (cmd.startsWith("subagent_")) return dispatchSubagent(cmd, args);
  switch (cmd) {
    // ── Boot gate ──
    case "check_python":
      return true;
    case "runtime_preflight":
      return { ok: true, reason: "none", detail: null, python: "/usr/bin/python3" };
    case "bootstrap_check":
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
    case "read_registry":
      // Return a fresh clone so in-place mutations (equip, override, set-meta)
      // are seen as changed data by react-query's structural sharing → the
      // subscribing screens actually re-render on invalidate.
      return structuredClone(registry);
    case "sync_report":
      return syncReportEnvelope;
    case "harness_list":
      return harnessList;
    case "harness_set_global":
      return undefined;

    // ── Sources via hub_cmd ──
    case "hub_cmd": {
      const cmdArgs = (args?.args as string[] | undefined) ?? [];
      if (cmdArgs[0] === "source" && cmdArgs[1] === "list" && cmdArgs.includes("--json")) {
        return { success: true, output: sourceListPayload };
      }
      // Add-source dry-run preview (with a CONFLICT candidate to resolve).
      if (
        cmdArgs[0] === "source" &&
        cmdArgs[1] === "add" &&
        cmdArgs.includes("--dry-run")
      ) {
        return {
          success: true,
          output: JSON.stringify({
            ok: true,
            counts: { new: 1, conflicts: 1, imported: 0, invalid: 0 },
            candidates: [
              { name: "new-widget", category: "NEW", origin_path: "skills/new-widget" },
              {
                name: "code-review",
                category: "CONFLICT",
                origin_path: "skills/code-review",
              },
            ],
          }),
        };
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
      // Bundle membership update.
      if (cmdArgs[0] === "bundle" && cmdArgs[1] === "update") {
        const bn = cmdArgs[2];
        const si = cmdArgs.indexOf("--skills");
        if (si >= 0 && registry.bundles[bn]) {
          registry.bundles[bn].skills = (cmdArgs[si + 1] ?? "")
            .split(",")
            .filter(Boolean);
        }
        return { success: true, output: "" };
      }
      // Library-default triggering (set-meta --invocation <mode>). Refuses for
      // external / mcp in the real CLI; the UI disables it so we don't model the
      // refusal here (mutates the mirror so a re-read shows the new badge).
      if (cmdArgs[0] === "set-meta") {
        const idx = cmdArgs.indexOf("--invocation");
        if (idx >= 0) {
          const skill = registry.skills[cmdArgs[1]];
          const mode = cmdArgs[idx + 1];
          if (skill) {
            if (mode === "auto") delete skill.invocation;
            else if (mode === "user-only" || mode === "model-only")
              skill.invocation = mode;
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
      return { success: true, output: "" };
    }

    // ── Skill editor ──
    case "read_skill_document": {
      const name = (args?.name as string) ?? "rt-android-expert";
      return {
        name,
        description:
          registry.skills[name]?.description ??
          "Android Jetpack Compose planner and architecture advisor.",
        body: skillBody,
      };
    }
    case "save_skill_full": {
      const name = (args?.name as string) ?? "";
      const meta = args?.meta as { harnesses?: string } | undefined;
      const sk = registry.skills[name];
      if (sk && meta) {
        const csv = (meta.harnesses ?? "").trim();
        if (csv) sk.harnesses = csv.split(",").filter(Boolean);
        else delete sk.harnesses;
      }
      return name || "saved";
    }

    // ── Equip / candidates (ux-equip-connections) ──
    case "local_skill_candidates":
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
      const resolved = Object.entries(decisions)
        .filter(([, action]) => action !== "skip")
        .map(([name, action]) => ({
          name,
          action,
          final_name: action === "suffix" ? `${name}-2` : name,
        }));
      // Register a demo new skill + any resolved conflicts into the registry.
      for (const r of resolved) {
        registry.skills[r.final_name] = {
          version: "0.1.0",
          description: `Imported from source (${r.action}).`,
          source: `~/.skill-hub/skills/${r.final_name}`,
          type: "claude-skill",
          scope: "portable",
          upstream: null,
          managed: "external",
        };
      }
      return {
        ok: true,
        registered: resolved.map((r) => r.final_name),
        skipped: [],
        resolved,
        counts: { registered: resolved.length },
      };
    }

    // ── Permissions ──
    case "permissions_show":
      return permissionsGlobal;
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
      const p = (args as { payload?: unknown } | undefined)?.payload;
      return { changed: true, normalized: p ?? permissionsGlobal };
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
    case "permissions_disable":
      return { mode: "restore", apply: false, entries: [], scopes_touched: [] };

    // ── Snippets ──
    case "snippets_list":
      return snippetsList;
    case "snippet_show":
      return snippetShow;
    case "snippet_status":
      return snippetStatus;
    case "snippet_new":
    case "snippet_edit":
    case "snippet_apply":
    case "snippet_remove":
    case "snippet_update":
    case "snippet_delete":
      return snippetShow;

    // ── Projects ──
    case "path_exists":
      return true;
    case "project_scan_candidates":
      return [];
    case "project_add_with_path":
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
      return null;

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

    // ── Agent docs ──
    case "list_agent_docs":
      return agentDocsListing;
    case "read_agent_doc":
      return {
        rel: "CLAUDE.md",
        absolute_path: "/Users/dev/projects/example-app/CLAUDE.md",
        content: "# example-app\n\nProject instructions.\n",
        size: 34,
        modified_at: null,
        hash: "deadc0de",
        is_symlink: false,
        symlink_to: null,
        oversized: false,
        is_derived_pointer: false,
      };
    case "write_agent_doc":
      return { written: [], derived: false };
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
    case "agent_docs_strategy_set":
      return { global: "symlink", project: null, override_value: null, effective: null };
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

    default:
      // eslint-disable-next-line no-console
      console.warn(`[tauriCore mock] unhandled command: ${cmd}`);
      return undefined;
  }
}
