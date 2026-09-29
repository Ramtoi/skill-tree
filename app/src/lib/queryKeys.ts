/**
 * The one typed query-key registry. Every `useQuery`/`useMutation`/
 * `invalidateQueries` call in the app reads its key from here — no module
 * outside this file holds a `queryKey: [...]` literal (enforced by
 * `test/queryKeyGuard.data.test.ts` + `test/queryKeyGuard.ui.test.ts`).
 *
 * Do NOT change a key's literal value when touching this file: a rename
 * silently orphans cached data and breaks the several tests that assert a
 * key by deep equality (see `test/queryKeys.test.ts`).
 */
export const qk = {
  machines: {
    list: () => ["machines"] as const,
    show: (id: string) => ["machine", id] as const,
  },
  worktreeDefaultsAll: () => ["worktree-defaults"] as const,
  worktreeDefaults: () => ["worktree-defaults", "saved"] as const,
  remoteDelivery: () => ["remote-delivery"] as const,
  remoteDefaults: () => ["remote-defaults"] as const,
  worktreePreview: (name: string, path: string, defaults: string | null) =>
    ["worktree-defaults", "preview", name, path, defaults] as const,
  registry: () => ["registry"] as const,
  invocation: (skill: string, project?: string) => ["invocation", skill, project ?? null] as const,
  invocationAll: () => ["invocation"] as const,
  skillRefsGraph: () => ["skill-refs-graph"] as const,
  syncReport: () => ["syncReport"] as const,
  python: () => ["python"] as const,
  bootstrap: () => ["bootstrap"] as const,
  sources: () => ["sources"] as const,
  /** Every `source_missing` skill (`hub source dropped --json`). */
  droppedSkills: () => ["source", "dropped"] as const,
  /** One skill's `--skill NAME --content` variant, for the editor body. */
  droppedSkill: (name: string) => ["source", "dropped", name] as const,
  localCandidates: () => ["localCandidates"] as const,
  /** Every skill + snippet BODY, for the Library's content search. */
  searchCorpus: () => ["search-corpus"] as const,
  connectorCatalog: () => ["connector-catalog"] as const,
  harnessAlsoServes: () => ["harness-also-serves"] as const,
  globalDoc: (id: string) => ["global-doc", id] as const,
  /** `hub harness doc status --json` — every harness's follow/source/broken
   *  state (global-doc-sharing). One query for the whole app: the Harnesses
   *  card hints and the doc editor's SHARED WITH rows both read it. */
  globalDocStatus: () => ["global-doc-status"] as const,
  envExists: (path: string) => ["env-exists", path] as const,
  /** `hub skill companions <skill> [--project <p>] --json` (A5) — a skill's
   *  declared companions plus per-harness verdicts, optionally provisioned
   *  status for one project. `project` collapses to `null` for the
   *  project-independent (declaration-only) read, so the two shapes never
   *  collide in the cache. Invalidated broadly by `skillCompanionsAll` (see
   *  `lib/invalidate.ts`) since a provision/removal changes verdicts for a
   *  skill+project pair the writer doesn't always know in advance. */
  skillCompanions: (skill: string, project?: string | null) =>
    ["skill-companions", skill, project ?? null] as const,
  /** The family prefix above — invalidating it stales every
   *  `skillCompanions(...)` combination via React Query's default prefix
   *  match, without enumerating every skill/project pair by hand. */
  skillCompanionsAll: () => ["skill-companions"] as const,
  /** The durable usage ledger view (`hub usage history --json`) — every
   *  range-scoped token/cost aggregate on the Usage screen reads it,
   *  alongside the separate `["usage","ccusage","latest"]` scan-cache key
   *  `useLocalAgentUsage.ts` still declares inline (that file lives under
   *  `src/features/**`, outside this guard's reach). */
  usageHistory: () => ["usage", "history"] as const,
  usageTimeline: (since: string | null, until: string | null, harness: string | null) =>
    ["usage", "timeline", since, until, harness] as const,
  usageProjectTimeline: (project: string, since: string, until: string, harness: string | null) =>
    ["usage", "timeline", project, since, until, harness] as const,
  /** `usage_pricing_info` — ccusage version, last-scan offline/online mode,
   *  and the parsed `ccusage-pricing.json` override rows. Read by the Usage
   *  screen's Prices popover (`useUsagePricingInfo.ts`); see Plan A
   *  Addendum A2. */
  usagePricingInfo: () => ["usage", "pricing-info"] as const,
  /** Durable captured transcript index. One read joins all overview rows. */
  usageInspectionIndex: () => ["usage", "inspection-index"] as const,
  /** Durable captured session detail, keyed by view and optional focused run. */
  usageInspectionRoot: () => ["usage", "inspection"] as const,
  usageInspection: (harness: string, sessionId: string, view: string, runId?: string | null) =>
    ["usage", "inspection", harness, sessionId, view, runId ?? null] as const,
  usageInspectionBody: (harness: string, sessionId: string, bodyId: string, afterChunk?: number | null) =>
    ["usage", "inspection-body", harness, sessionId, bodyId, afterChunk ?? null] as const,
  usagePins: () => ["usage", "pins"] as const,
  /** `hub usage project <name> --window <w> --json` — the drill-down's five
   *  bands (design D14.2/D14.6). */
  usageProject: (name: string, window: number) => ["usage", "project", name, window] as const,
  usageProjectAll: () => ["usage", "project"] as const,
  /** `hub usage session <id> [--harness <h>] --json` — the session timeline
   *  (design D14.7). `harness` is normalized to `null` at the hook boundary
   *  (G17) so `undefined` and `null` never split one read into two cache
   *  entries. */
  usageSession: (id: string, harness: string | null) => ["usage", "session", id, harness] as const,
  /** `hub usage footprint <name> --json` — wave 3's footprint drill-down. */
  usageFootprint: (name: string) => ["usage", "footprint", name] as const,
  usageFootprintAll: () => ["usage", "footprint"] as const,
  /** `hub usage findings [--project <name>] --json`. `project` is normalized
   *  to `null` at the hook boundary for the same reason as `usageSession`. */
  usageFindings: (project: string | null) => ["usage", "findings", project] as const,
  usageLoadouts: (project: string) => ["usage", "loadouts", project] as const,
  /** Latest settled transcript scan payload for cross-route recovery copy. */
  usageScanRecovery: () => ["usage", "scan-recovery"] as const,
  skillDocument: (name: string) => ["skill-document", name] as const,
  /** Canonical source-owned companion agent document. */
  skillAgent: (skill: string, agent: string) => ["skill-agent", skill, agent] as const,
  /** The family prefix above every `usage*` key this block defines — see
   *  `usageHistory`'s sibling comment for the caveat about the OTHER usage
   *  key above (`["usage","ccusage","latest"]`, declared inline in
   *  `useLocalAgentUsage.ts`) also sharing this prefix. Invalidating this
   *  after `hub usage scan-sessions` stales every project/session/footprint/
   *  findings combination via React Query's default prefix match, without
   *  enumerating pairs — the `skillCompanionsAll` precedent (design D14.2). */
  usageAnalytics: () => ["usage"] as const,
  projectRepository: (project: string) => ["project-repository", project] as const,
  projectCandidates: (project: string) => ["project-candidates", project] as const,
  projectRemovePreview: (project: string, version: number) =>
    ["project-remove-preview", project, version] as const,
  backup: {
    status: () => ["backupStatus"] as const,
    auth: () => ["backupAuth"] as const,
  },
  recovery: {
    /** `hub recovery status --json` — the one read every step of the wizard
     *  (and the Backup screen's reopen entry) polls. Singleton: the backend
     *  record is machine-local, not keyed by operation id (contract §Persisted
     *  record). */
    status: () => ["recovery", "status"] as const,
    /** `hub recovery github-repos --query Q --page N --json`. `query` folds
     *  to `null` so an empty box and an untouched box share one cache entry,
     *  same convention as `usageSession`'s `harness` normalization. */
    githubReposAll: () => ["recovery", "github-repos"] as const,
    githubRepos: (query: string | null, page: number) =>
      ["recovery", "github-repos", query ?? null, page] as const,
    /** `hub recovery discover --project NAME --root PATH...`. `roots` joins
     *  into the key so a different search-root set never reads another
     *  project's stale candidate list. */
    discover: (project: string, roots: string[]) =>
      ["recovery", "discover", project, [...roots].sort()] as const,
  },
  hooks: {
    all: () => ["hooks"] as const,
    list: () => ["hooks", "list"] as const,
    show: (name: string) => ["hooks", "show", name] as const,
    capabilities: () => ["hooks", "capabilities"] as const,
    script: (name: string) => ["hooks", "script", name] as const,
    doctor: () => ["hooks", "doctor"] as const,
  },
  permissions: {
    capabilities: () => ["permissions", "capabilities"] as const,
    doctor: () => ["permissions", "doctor"] as const,
    risksSchema: () => ["permissions", "risks-schema"] as const,
  },
  remotes: {
    list: () => ["remotes"] as const,
    doctor: () => ["remote-doctor"] as const,
    all: (id: string) => ["remote", id] as const,
    show: (id: string) => ["remote", id, "show"] as const,
    diff: (id: string) => ["remote", id, "diff"] as const,
    docs: (id: string) => ["remote", id, "docs"] as const,
    health: (id: string) => ["remote", id, "health"] as const,
    scan: (id: string) => ["remote", id, "scan"] as const,
  },
  cloud: {
    targets: () => ["cloud-targets"] as const,
    statusAll: () => ["cloud-status"] as const,
    status: (id: string) => ["cloud-status", id] as const,
  },
  snippets: {
    listAll: () => ["snippets"] as const,
    list: (tag: string, query: string) => ["snippets", tag, query] as const,
    // Names-only list (no usage scan) — prefixed with "snippets" so
    // `useInvalidateSnippets`'s `listAll()` invalidation already covers it.
    names: () => ["snippets", "names"] as const,
    oneAll: () => ["snippet"] as const,
    one: (name: string) => ["snippet", name] as const,
    scanAll: () => ["snippet-scan"] as const,
    scan: (name: string, project: string) => ["snippet-scan", name, project] as const,
  },
  skillFiles: {
    all: () => ["skill-files"] as const,
    forSkill: (name: string) => ["skill-files", name] as const,
  },
  /** `hub mcp check <name> --json` — the lazy liveness probe (design D3/D6).
   *  Armed only on click, the `RemoteCard` health-chip pattern. E2 adds
   *  `qk.mcpCandidates()`. */
  mcpProbe: (name: string) => ["mcpProbe", name] as const,
  /** `hub mcp show <name> --json` — read-only (no liveness probe of its own),
   *  so `McpDeliveryBlock` may fetch it on mount to hydrate the persisted
   *  `last_probe` cache line (INTERFACES §3 names E1 as a consumer). Distinct
   *  key from `mcpProbe` — this is a different verb. */
  mcpShow: (name: string) => ["mcpShow", name] as const,
  /** `hub mcp catalog <name> --json` — the full record for the browse sheet
   *  (design G.md §6.2). Read-only, never probes; enabled only while the
   *  sheet is open. Distinct key from `mcpShow`/`mcpProbe` — a different
   *  verb, a much larger payload. */
  mcpCatalog: (name: string) => ["mcpCatalog", name] as const,
  /** `hub mcp reconcile --json` — the Library's "Detected MCP servers" band
   *  (design D5). `scope` defaults to `"global"`, the only scope E2 reads. */
  mcpCandidates: (scope: string = "global") => ["mcpCandidates", scope] as const,
  agentDocs: {
    all: () => ["agent-docs"] as const,
    forProject: (projectPath: string) => ["agent-docs", projectPath] as const,
    listing: (projectPath: string, includeAllMarkdown: boolean, includeIgnored: boolean) =>
      ["agent-docs", projectPath, includeAllMarkdown, includeIgnored] as const,
    dirMetaAll: () => ["agent-docs-dir-meta"] as const,
    dirMeta: (projectPath: string, relativeDir: string) =>
      ["agent-docs-dir-meta", projectPath, relativeDir] as const,
    rootStatusAll: () => ["agent-docs-root-status"] as const,
    rootStatus: (projectPath: string) => ["agent-docs-root-status", projectPath] as const,
    strategyAll: () => ["agent-docs-strategy"] as const,
    strategy: (projectName: string) => ["agent-docs-strategy", projectName] as const,
    publishAll: () => ["agent-docs-publish"] as const,
    publish: (projectName: string) => ["agent-docs-publish", projectName] as const,
  },
  subagents: {
    // Verbatim move of `hooks/useSubagents.ts:27-46`'s factory bodies (that
    // file keeps `export const subagentKeys = qk.subagents;` — zero call-site
    // churn). The harness dimension is inserted right after the tag so a
    // Claude query and a Codex query of the same scope/project never collide;
    // it defaults to `claude-code` so shipped call sites keep their identity.
    list: (
      scope: "user" | "project",
      project?: string | null,
      harness: "claude-code" | "codex" = "claude-code",
    ) => ["subagents", harness, scope, project ?? null] as const,
    one: (
      scope: "user" | "project",
      project: string | null,
      name: string,
      harness: "claude-code" | "codex" = "claude-code",
    ) => ["subagent", harness, scope, project ?? null, name] as const,
    attachable: (
      scope: "user" | "project",
      project?: string | null,
      harness: "claude-code" | "codex" = "claude-code",
    ) => ["subagent-attachable", harness, scope, project ?? null] as const,
    skillUsage: () => ["subagent-skill-usage"] as const,
    linkStatus: (scope: "user" | "project") => ["subagent-link-status", scope] as const,
  },
};
