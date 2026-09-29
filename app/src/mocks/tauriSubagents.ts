/**
 * The stateful sub-agents backend of the Tauri IPC mock (Claude + Codex
 * stores, linked twins, provisioning, `dispatchSubagent`). Cut verbatim out of
 * tauriCore.ts (wave 25 of AUDIT.md). It reads `registry` and `sceneFlag`
 * from tauriCore at call time only, so the import cycle between the two files
 * is safe (live bindings, nothing evaluated at module load).
 */
import { companionHidden, registry } from "./tauriCore";
import { sceneFlag } from "./scenes";

// ─── Sub-agents (STATEFUL, per-harness) ───────────────────────────────────────
// Module-level in-memory backend so a journey mutates and re-reads realistically
// (Wave 5/6). Shapes mirror the D2 contract in lib/subagents.ts EXACTLY so the
// real components run unmodified. Two SEPARATE in-memory stores — one per
// harness — so a Codex journey never bleeds into the Claude list. The invoke
// arg is camelCase `harnessId` (omitted ⇒ claude-code); `subagent_save` reads
// `payload.harness` instead.

export const SLUG_RE = /^[a-z0-9-]+$/;
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
    body: "You are a careful code reviewer. Inspect the diff, surface correctness bugs first, then reuse and simplification opportunities. Never modify files. Follow `code-review` for the severity ladder, and /brainstorm only when the shape is unclear.",
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
  // ── `ships_with` (D1) companion agents — orchestrate-advanced's six agent
  // definitions, user scope (D2: agents are user-scope, shared across every
  // project that provisions them). Tier → Claude model per plans/1.md's
  // TIER_MODELS (utility, scout, worker, planner, deep; model plus effort per harness). W10 added
  // orch-sub-orchestrator (the only one carrying Agent, tier deep). Provenance
  // ("shipped by orchestrate-advanced") is derived from the registry mirror
  // (`companionsIndex`), not from anything on the agent row itself.
  {
    scope: "user",
    project: null,
    name: "orch-sub-orchestrator",
    description:
      "Run the orchestrate loop for one chunk in its own worktree and branch; report 12 lines.",
    model: "fable",
    tools_mode: "allowlist",
    tools: ["Read", "Edit", "Write", "Bash", "Grep", "Glob", "Agent", "SendMessage", "Skill"],
    disallowed_tools: [],
    skills: [],
    color: "",
    advanced_yaml: "",
    body: "You are depth 2 of 3. Run `orchestrate` end to end for the chunk in your brief, Mode auto. Spawn only the five orch-* worker/planner agents — never general-purpose, never fork, never another orch-sub-orchestrator. Commit your waves on your branch; never push or merge. Never ask a human: a pause point becomes a `blocked` report with numbered options.",
  },
  {
    scope: "user",
    project: null,
    name: "orch-researcher",
    description:
      "Two-pass repo research for one chunk: discovery by grep and glob, then targeted reads.",
    model: "sonnet",
    tools_mode: "allowlist",
    tools: ["Read", "Grep", "Glob", "Bash"],
    disallowed_tools: [],
    skills: [],
    color: "",
    advanced_yaml: "",
    body: "Discovery pass with no reads; tag candidates low/med/high, stop above 12 med/high, then read only med and high. No write tool, so the pass cannot start editing what it found.",
  },
  {
    scope: "user",
    project: null,
    name: "orch-planner",
    description:
      "Write one design plan for a chunk: objective, approach, changes table, interfaces, test tasks.",
    model: "opus",
    tools_mode: "allowlist",
    tools: ["Read", "Grep", "Glob", "Write"],
    disallowed_tools: [],
    skills: [],
    color: "",
    advanced_yaml: "",
    body: "Write exactly one file, the plan path in your brief. No Edit, so you can create a plan but not alter a repo file; no Bash, so you run nothing. Every plan names real files and has test tasks.",
  },
  {
    scope: "user",
    project: null,
    name: "orch-griller",
    description: "Adversarial review of a plan or interface set. Finds problems; never confirms work.",
    model: "fable",
    tools_mode: "allowlist",
    tools: ["Read", "Grep", "Glob"],
    disallowed_tools: [],
    skills: [],
    color: "",
    advanced_yaml: "",
    body: "Read-only by construction. Classify every finding Apply / Acknowledge / Dismiss with the severity ladder; a multi-plan grill must output the interface table.",
  },
  {
    scope: "user",
    project: null,
    name: "orch-implementer",
    description: "Implement one wave inside its allowed file list, run the wave gate, report. Never commits.",
    model: "sonnet",
    tools_mode: "allowlist",
    tools: ["Read", "Edit", "Write", "Bash", "Grep", "Glob"],
    disallowed_tools: [],
    skills: [],
    color: "",
    advanced_yaml: "",
    body: "One wave, your brief's Allowed files and nothing else. Run the brief's exact gate. Never commit, push or spawn. No Agent tool — the depth cap made structural.",
  },
  {
    scope: "user",
    project: null,
    name: "orch-reviewer",
    description: "Review a committed wave against its plan for problems. Reads and runs; never edits.",
    model: "opus",
    tools_mode: "allowlist",
    tools: ["Read", "Grep", "Glob", "Bash"],
    disallowed_tools: [],
    skills: [],
    color: "",
    advanced_yaml: "",
    body: "Read the plan and the wave's diff, look for problems rather than confirmation, and verify a flagged CRITICAL exists before reporting it. No Edit/Write: a fixer stops reviewing.",
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

export function dispatchSubagent(cmd: string, args?: Record<string, unknown>): unknown {
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
      // D16: a hidden companion agent drops out of the list under
      // `?companionsAbsent=1` — the same predicate `tauriCore.ts` applies to
      // hooks, so `agentNamesOnHarness` (which calls this very case) inherits
      // the hiding for free and the mock's project-less companions read
      // reports every `orch-*` agent `absent` too. `subagent_show`/
      // `subagent_skill_usage`/`subagent_link_status` still read `mockAgents`
      // directly and are deliberately left unfiltered (Risk, F14) — nothing
      // in the flagged scene navigates to them.
      const agents = store
        .filter(
          (a) =>
            a.scope === scope &&
            (scope !== "project" || a.project === project) &&
            !companionHidden(a.name),
        )
        .map((a) => toListItem(a, harness));
      // ?agentsAttention=1 — one invalid (bad slug) sub-agent, for the agents
      // group's "invalid sub-agent" attention line.
      if (!isCodex && scope === "user" && sceneFlag("agentsAttention")) {
        agents.push(
          toListItem(
            {
              scope: "user",
              project: null,
              name: "Bad Name",
              description: "Invalid slug — fails the SLUG_RE check.",
              model: "",
              tools_mode: "all",
              tools: [],
              disallowed_tools: [],
              skills: [],
              color: "gray",
              advanced_yaml: "",
              body: "",
            },
            harness,
          ),
        );
      }
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

