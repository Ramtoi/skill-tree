// ─── The scene-flag registry ───────────────────────────────────────────────
// Every `?name=value` query flag the visual harness (`app/visual/*.mjs`) and
// the Playwright journeys (`app/e2e/**`) use to opt the mocked backend into a
// non-default state. This module is the ONLY file under `app/src/mocks/**`
// that may read `window.location.search` — every mock reads a flag through
// `sceneFlag`/`sceneValue` here instead, so a typo or an undeclared flag is a
// compile error, not a silently-ignored query string.
//
// `app/src/test/sceneRegistry.test.ts` enforces:
//   1. No other mock file reads the query string directly (`URLSearchParams`,
//      `location.search`/`.href`, `searchParams`, `document.URL`).
//   2. Every declared flag is used by an e2e spec or a visual scene, or is
//      listed in `KNOWN_UNUSED` with a reason.
//   3. Every flag an e2e spec or a visual scene uses is declared here (or is
//      a product route param in that test's `APP_ROUTE_PARAMS` allowlist).
// `app/src/test/sceneFidelity.test.ts` enforces that every declared flag (and
// every value of an enumerated flag) changes at least one command's response
// — hangs it, fails it, or changes its shape — unless `KNOWN_NO_FIDELITY_ROW`
// excuses it; every `oneOf` value has its own row, and every row's value is
// one the flag declares.
//
// Two separate excuse lists, because they answer different questions and a
// flag can need only one of them:
//   `KNOWN_UNUSED` — no e2e spec or visual scene sets this flag (yet).
//      Excuses rule 2 above ONLY. A flag here still needs a real fidelity
//      row: the seventeen entries below all have one, proven by vitest
//      instead of a browser.
//   `KNOWN_NO_FIDELITY_ROW` — the flag cannot be shown through a command
//      response at all (a side-channel event). Excuses the fidelity
//      requirement ONLY. Its one current entry (`settingsProbe`) IS read by
//      a real spec, so rule 2 does not need it. (`ipcDelay` used to be here;
//      it now has a `hang` row, since a long delay keeps a query in flight.)
// A flag can appear in neither, either, or (in principle) both maps; today
// none appear in both.

interface BoolFlag {
  kind: "bool";
  /** Which command(s) the flag changes, one line. */
  comment: string;
}
interface NumberFlag {
  kind: "number";
  comment: string;
}
interface OneOfFlag<V extends readonly string[] = readonly string[]> {
  kind: "oneOf";
  values: V;
  comment: string;
}

function bool(comment: string): BoolFlag {
  return { kind: "bool", comment };
}
function number(comment: string): NumberFlag {
  return { kind: "number", comment };
}
function oneOf<const V extends readonly string[]>(values: V, comment: string): OneOfFlag<V> {
  return { kind: "oneOf", values, comment };
}

/**
 * The typed registry. `sceneFlag`/`sceneValue` only accept a key of this
 * object, so a caller that misspells a flag, or that reads a flag no mock
 * declares, gets a compile error instead of a silently-false read.
 */
export const SCENE_FLAGS = {
  // ── shell / sync ──────────────────────────────────────────────────────
  attentionQueue: bool("sync_report — adds an attention-queue entry so the shell's queue plaque has a real destination"),
  bootstrap: bool("bootstrap_check — reports a healthy but un-bootstrapped install, for the BootstrapWizard"),
  screenError: bool("bootstrap_check — the check rejects, for the PythonError \"Couldn't initialize\" card"),
  elsewhereAttention: bool("sync_report — adds an elsewhere-attention row (companions living outside the current project)"),
  mcpBlocked: bool("sync_report — reports an MCP server blocked by policy"),
  missingSkills: bool("read_registry and sync_report — reports a skill the registry references but the library lacks"),
  remotesSkipped: bool("sync_report — reports a remote source skipped during the last sync"),
  staleReport: bool("sync_report — returns a report timestamped well in the past, for the stale-report banner"),
  syncError: bool("sync_report — returns a short sync error envelope"),
  syncErrorLong: bool("sync_report — returns a long, ANSI-bearing sync error envelope"),
  syncFails: oneOf(["1", "stdout"] as const, "hub_cmd \"sync\" — \"1\" fails on stdout+stderr, \"stdout\" fails on stdout only"),
  syncHangs: bool("hub_cmd \"sync\" — never resolves, so the in-flight sync state can be photographed"),

  // ── library / registry ───────────────────────────────────────────────
  classification: bool("read_registry — seeds a skill's classification (classes/outputs/working_mode/maturity)"),
  classOverflow: bool("read_registry — widens one skill's classification with more classes than the row can show inline"),
  contextAttention: bool("snippets_list, snippet_show, snippet_status and read_registry — marks the \"orphaned-note\" snippet outdated with a real destination"),
  docLinkConflict: bool("hub_cmd \"harness doc write\" — reports a link conflict instead of writing"),
  guardrailsAttention: bool("read_registry and permissions_show — adds a permissions-guardrails attention entry"),
  libraryEmpty: bool("read_registry and local_skill_candidates — returns an empty registry/candidate list (module init also marks the tips-tour done)"),
  bundlePlaybook: bool("read_registry — seeds the \"android\" bundle's playbook (build/refine + companions groups)"),
  navSearch: bool("read_registry and snippets_list — pads the library and snippet lists so NavPanel's search groups have enough rows to page"),
  noScan: bool("usage_project, usage_session, usage_footprint, usage_findings (usageAnalytics mock) — reports no scan has ever run"),
  pendingBundleAdd: bool("hub_cmd \"bundle update\" — delays dispatch 60s (deferDispatch), so the pending-add state can be photographed"),
  permDivergence: bool("permissions_show and permissions_reconcile_candidates — reports a permissions divergence between scopes"),
  pickerMany: bool("read_registry (seeds nine extra projects) and usage_load_latest_ccusage session list — gives the project picker enough rows to scroll"),
  projectOverview: bool("read_registry (bundle playbook/skills) and usage_footprint (mcp_schemas part) — seeds a fuller project-overview bundle shape"),
  projectOverviewDense: bool("read_registry — adds 200 extra skills to the project-overview bundle, for the dense-list layout"),
  projectSessions: bool("usage_load_latest_ccusage and usage_project — returns a fixed set of named sessions instead of the generated ones"),
  usedByMany: bool("read_registry — reports a skill used by many projects, for the \"used by\" attention line"),

  // ── mcp / agents ─────────────────────────────────────────────────────
  adoptFails: bool("mcp_add_json and mcp_reconcile_apply — the adopt step rejects instead of applying"),
  agentDocMarkerError: bool("read_agent_doc and write_agent_doc — reports a marker-parsing error on the agent doc"),
  agentsAttention: bool("harness_list and subagent_list — adds an invalid sub-agent (bad slug) row for the agents attention line"),
  companionsAbsent: bool("hook_list, subagent_list (via companionHidden) — hides every companion hook/agent so a SHIPS WITH read shows every row absent"),
  companionsPending: bool("read_registry and sync_report — reports a companion provisioning still pending"),
  companionsProvisioned: bool("read_registry, permissions_show and mcp reconcile — seeds a companion-provisioned ledger entry for \"orchestrate-advanced\""),
  hookCapsVaried: bool("hook_capabilities and hook_show — varies one hook's reported capability reach"),
  hookDoctorFindings: bool("hook_doctor — reports doctor findings instead of a clean bill"),
  hookScriptMissing: bool("hook_script_show — reports a null script body (the file is missing on disk)"),
  hooksAttention: bool("hook_list — module init pushes an extra \"audit-bash\" hook, for the hooks attention line"),
  hooksEmpty: bool("hook_list — returns an empty hook list"),
  invocationHangs: bool("hub_cmd invocation save — never resolves, so the in-flight save state can be photographed"),
  invocationNative: oneOf(
    ["all", "codex", "opencode-command", "opencode-shared", "opencode-unknown", "yaml-failure", "none"] as const,
    "invocationMock (native-invocation preview) — which harnesses report a native install and how they resolve",
  ),
  invocationPartial: bool("hub_cmd invocation save — reports a partial/incomplete sync after saving"),
  mcpCandidates: bool("hub_cmd \"mcp reconcile\" — shows reconcile candidates"),
  mcpCatalogEmpty: bool("mcp catalog (hub_cmd, via mcpCatalogVariant) — the catalogue summary/record report as empty"),
  mcpCatalogErrors: bool("mcp catalog (hub_cmd, via mcpCatalogVariant) — the catalogue summary/record report errors"),
  mcpCatalogMissing: bool("mcp catalog (hub_cmd, via mcpCatalogVariant) — the catalogue file is missing (the probe summary is unaffected)"),
  mcpCatalogUnreadable: bool("mcp catalog (hub_cmd, via mcpCatalogVariant) — the catalogue file is unreadable"),
  mcpConflict: bool("hub_cmd \"mcp reconcile\" — shows reconcile candidates in a conflicting state"),
  mcpLiteral: bool("hub_cmd \"mcp reconcile\" — shows the literal (unresolved-ref) reconcile view"),
  mcpProbeFails: bool("hub_cmd \"mcp probe\" — the probe call rejects"),
  mcpProbeHangs: bool("hub_cmd \"mcp probe\" — never resolves, so the in-flight probe state can be photographed"),
  mcpSetFails: bool("mcp_set_json and hub_cmd \"mcp set\" — the write rejects"),
  subagentsEmpty: bool("subagent_list — returns a genuinely empty sub-agent list (the default store is populated)"),

  // ── permissions / hooks / archive ────────────────────────────────────
  archiveFails: bool("hub_cmd \"archive\" — the archive call rejects"),
  archiveHangs: bool("hub_cmd \"archive\" — never resolves, so the in-flight archive state can be photographed"),
  enableFails: bool("hub_cmd \"enable\" — the trailing auto-sync fails after stdout already printed a success tick"),
  equipHangs: bool("hub_cmd \"enable\"/\"disable\"/\"bundle update\" — never resolves, so an EquipPicker row's in-flight state can be photographed"),
  renameFails: bool("hub_cmd rename — the rename call rejects"),
  renameHangs: bool("hub_cmd rename — never resolves, so the in-flight rename state can be photographed"),
  worktreeAccessFails: bool("permissions_set — a project-scoped write reports a worktree access failure"),

  // ── remotes / sources / backup ───────────────────────────────────────
  backupNoCredential: bool("backup_auth_status — no auth method works yet (first-run worst case)"),
  backupNoGh: bool("backup_auth_status — ssh and a stored PAT both work, only the gh CLI is absent"),
  backupNoKeyring: bool("backup_status and backup_auth_status — the OS keyring is unavailable, so no PAT can be stored/read"),
  backupNoSnapshot: bool("backup_status — configured but nothing has been committed yet"),
  backupPending: bool("backup_status — a reconcile is pending acknowledgement"),
  backupStale: bool("backup_status — reports push failures and a GitHub account mismatch"),
  backupUnconfigured: bool("backup_status — no backup repo configured yet"),
  backupUninitialized: bool("backup_status — configured but never initialized"),
  machineConflict: bool("hub_cmd remote machine — seeds a build-box receiver whose feed is claimed by another controller"),
  machineBlocked: bool("hub_cmd remote machine — automatic delivery is enabled but the receiver blocked the latest loadout"),
  remoteDoctor: bool("remote_doctor — returns doctor findings"),
  restoreConnectionFailed: bool("restore_preview — the preview call reports a connection failure"),
  restoreTampered: bool("restore_preview/restore_apply (mockRestorePlan) — the snapshot's signing key mismatches (fatal, no consent path)"),
  restoreUnverified: bool("restore_preview/restore_apply (mockRestorePlan) — a new, not-yet-trusted signing key (TOFU consent path)"),
  restoreRecovery: bool("recovery_command — seeds the F1-F4 incident shape without waiting for a \"start\" call"),
  restoreRecoveryDense: bool("recovery_command — seeds 15 projects instead of the small default set, and picks a separate sessionStorage bucket"),
  scanFails: bool("usage scan-sessions (hub_cmd) — the scan reports ok:false with a parse error"),
  scanHangs: bool("usage scan-sessions (hub_cmd) — never resolves, so the in-flight scan state can be photographed"),
  scanRecoveryDelayed: bool("usage scan-sessions (hub_cmd) — first call replans, later calls resolve slowly"),
  scanRecoveryHeaderBusy: bool("usage_scan_ccusage and usage scan-sessions (hub_cmd) — first call replans, so the header stays busy"),
  scanRecoveryTransport: bool("usage scan-sessions (hub_cmd) — first call replans, second call's transport rejects"),
  scanReplan: bool("usage scan-sessions (hub_cmd) — reports state: \"replan_required\""),
  sessionMissing: bool("usage_session (usageAnalytics mock) — reports the requested session as not found"),
  settingsPickFolder: bool("pick_directory — returns a fixed project path instead of the default"),
  settingsProbe: bool("invoke() — dispatches a window \"settings-mock-command\" event for every call; no command response changes, so this has no fidelity row"),
  settingsReadFails: bool("hub_cmd and agent_docs_strategy_set — a settings read rejects"),
  settingsWriteFails: bool("harness_set_global, hub_cmd, agent_docs_strategy_set and backup_disable — a settings write rejects"),
  snippetScanHangs: bool("snippet_status — never resolves, so the in-flight scan state can be photographed"),
  snippetsEmpty: bool("snippets_list — returns an empty snippet list"),
  snippetUpdateHangs: bool("snippet_update — never resolves, so the in-flight update state can be photographed"),
  agentSaveFails: bool("hub_cmd (agent doc save) — the save call rejects"),
  sourceAgentSaveFails: bool("hub_cmd (source-managed agent doc save) — the save call rejects"),

  // ── usage ─────────────────────────────────────────────────────────────
  codexFamilies: bool("usage_load_latest_ccusage, usage_scan_ccusage and usage inspect-index (via usageInspection.ts) — adds a Codex agent-family session group"),
  codexNotAnalysed: bool("usage_findings (usageAnalytics mock) — reports every Codex session as not analysed"),
  feedback: oneOf(["sending", "blocked", "uncertain", "limited"] as const, "feedbackTransport — the send call's outcome (sending never resolves, the rest resolve with that kind)"),
  feedbackLoading: bool("runtime_preflight — never resolves, so the app renders its loading state"),
  inspection: bool("usage_load_latest_ccusage and usage_session (usageAnalytics mock) — maps a ccusage row onto the captured inspection-session fixture identity"),
  ipcDelay: number("invoke() dispatch timing only (ms) — delays every command's resolve; no response shape changes, so its fidelity row is a hang"),
  longSessionTitles: bool("usage_load_latest_ccusage (codexFamiliesUsageScan, needs codexFamilies too) — gives the Codex inspection session a long title, for title-overflow layout"),
  pruned: bool("usage_session (usageAnalytics mock) — reports the transcript as pruned (not retained)"),
  pythonError: bool("check_python and runtime_preflight — reports a Python-runtime startup failure"),
  usageAccessError: bool("usage_load_latest_ccusage and usage_scan_ccusage — the read rejects with a permission error"),
  usageBackfilled: bool("hub usage history (hub_cmd) — marks a handful of days backfilled (mixed-provenance scene)"),
  usageBig: bool("usage_load_latest_ccusage and usage_scan_ccusage — returns a scaled-up (5,600-session) usage scan"),
  usageDrilldown: bool("usage_load_latest_ccusage session list — seeds rows for the drill-down journey"),
  usageEmpty: bool("usage_load_latest_ccusage and usage_scan_ccusage — reports no usage data at all (the scan call never resolves)"),
  usageFailure: bool("usage_load_latest_ccusage and usage_scan_ccusage — the read rejects with a generic failure"),
  usageIdle: bool("richUsageEnabled (usage_load_latest_ccusage/usage_footprint via tauriUsageAnalytics) — enables the rich-scene idle-session data"),
  usageLong: bool("usage_load_latest_ccusage and usage_scan_ccusage — returns a long usage scan (extra history)"),
  usageModelMix: bool("hub usage history (hub_cmd) — mixes multiple models into the history payload"),
  usageNative: oneOf(["observed", "partial", "unavailable"] as const, "usage inspect-index (via usageInspection.ts) — the native-facts field_status for the claude-code session"),
  usageNoUsage: bool("usage_load_latest_ccusage and usage_scan_ccusage — reports zero importable days"),
  usageRecent: bool("hub usage timeline (hub_cmd, visualTimelineDates) — extends the timeline back 450 recent days instead of the default fixture window"),
  usageRich: bool("richUsageEnabled (usage_load_latest_ccusage/usage_footprint via tauriUsageAnalytics) — enables the rich-scene project/footprint data"),
  usagePruned: bool("usage inspect-index/tools (via usageInspection.ts) — layers the retention demo (a pruned tool result, a pruned input, a pruned patch) onto the claude-code session"),
  timelineEmpty: bool("usage_timeline (usageAnalytics mock) — returns an empty timeline (no days); alias of usageTimelineEmpty"),
  usageTimelineEmpty: bool("usage_timeline (usageAnalytics mock) — returns an empty timeline (no days)"),
  usageTokens: oneOf(["complete", "partial"] as const, "usage inspect-index and usage_load_latest_ccusage (via usageInspection.ts/tauriCore.ts) — provider-token coverage shown on session rows"),
  usageUnpriced: bool("usage_load_latest_ccusage and usage_scan_ccusage — returns usage data with no pricing applied"),
  usageUnregistered: bool("usage_load_latest_ccusage session list — seeds an unregistered-project session"),

  // ── window / misc primitives ─────────────────────────────────────────
  fullscreen: bool("getCurrentWindow().isFullscreen() (tauriWindow mock) — reports the window as fullscreen"),
} as const;

export type SceneFlagName = keyof typeof SCENE_FLAGS;

/**
 * No e2e spec or visual scene sets this flag (yet) — excuses
 * `sceneRegistry.test.ts` rule 2 only. Every flag below still has a real
 * `sceneFidelity.test.ts` row; vitest is what proves it today.
 */
export const KNOWN_UNUSED: Record<string, string> = {
  machineConflict: "no e2e spec or visual scene reads this yet; the hub_cmd remote machine list response is proven by a vitest fidelity row instead",
  adoptFails: "no e2e spec or visual scene reads this yet; mcp_add_json/mcp_reconcile_apply's rejection is proven by a vitest fidelity row instead",
  agentDocMarkerError: "no e2e spec or visual scene reads this yet; read_agent_doc/write_agent_doc's marker-error response is proven by a vitest fidelity row instead",
  agentSaveFails: "no e2e spec or visual scene reads this yet; the hub_cmd agent-doc-save rejection is proven by a vitest fidelity row instead",
  archiveFails: "no e2e spec or visual scene reads this yet; the hub_cmd archive rejection is proven by a vitest fidelity row instead",
  backupUninitialized: "no e2e spec or visual scene reads this yet; backup_status's uninitialized response is proven by a vitest fidelity row instead",
  codexNotAnalysed: "no e2e spec or visual scene reads this yet; usage_findings's not-analysed badge is proven by a vitest fidelity row instead",
  hookScriptMissing: "no e2e spec or visual scene reads this yet; hook_script_show's null-body response is proven by a vitest fidelity row instead",
  mcpCatalogEmpty: "no e2e spec or visual scene reads this yet; the mcp-catalog-empty response is proven by a vitest fidelity row instead",
  mcpCatalogErrors: "no e2e spec or visual scene reads this yet; the mcp-catalog-errors response is proven by a vitest fidelity row instead",
  mcpCatalogMissing: "no e2e spec or visual scene reads this yet; the mcp-catalog-missing response is proven by a vitest fidelity row instead",
  mcpProbeFails: "no e2e spec or visual scene reads this yet; the hub_cmd mcp-probe rejection is proven by a vitest fidelity row instead",
  mcpSetFails: "no e2e spec or visual scene reads this yet; mcp_set_json's rejection is proven by a vitest fidelity row instead",
  navSearch: "the navigator-search journey was cut; the header search disclosure is proven by a vitest fidelity row instead",
  renameFails: "no e2e spec or visual scene reads this yet; the hub_cmd rename rejection is proven by a vitest fidelity row instead",
  restoreConnectionFailed: "no e2e spec or visual scene reads this yet; restore_preview's connection-failure response is proven by a vitest fidelity row instead",
  restoreTampered: "no e2e spec or visual scene reads this yet; restore_preview/restore_apply's fatal signing-key mismatch is proven by a vitest fidelity row instead",
  restoreUnverified: "no e2e spec or visual scene reads this yet; restore_preview/restore_apply's unverified-new-key response is proven by a vitest fidelity row instead",
  settingsReadFails: "no e2e spec or visual scene reads this yet; the settings-read rejection is proven by a vitest fidelity row instead",
  sourceAgentSaveFails: "no e2e spec or visual scene reads this yet; the hub_cmd source-agent-doc-save rejection is proven by a vitest fidelity row instead",
  timelineEmpty: "no e2e spec or visual scene reads this yet; the empty-timeline response is proven by a vitest fidelity row instead",
  usageTimelineEmpty: "no e2e spec or visual scene reads this yet; the empty-timeline response is proven by a vitest fidelity row instead",
};

/**
 * The flag cannot be shown through a command response at all — excuses
 * `sceneFidelity.test.ts`'s row requirement only. The entry here IS read
 * by a real e2e spec, so it does not need `KNOWN_UNUSED` too.
 */
export const KNOWN_NO_FIDELITY_ROW: Record<string, string> = {
  settingsProbe: "dispatches a window CustomEvent on every invoke() call; no command response changes, so no diff can prove it",
};

/** `=== "1"` semantics, matching every scene's `?name=1` convention. */
export function sceneFlag(name: SceneFlagName): boolean {
  if (typeof window === "undefined") return false;
  try {
    return new URLSearchParams(window.location.search).get(name) === "1";
  } catch {
    return false;
  }
}

/** Raw value of a scene query param, for flags with more than one variant. */
export function sceneValue(name: SceneFlagName): string | null {
  if (typeof window === "undefined") return null;
  try {
    return new URLSearchParams(window.location.search).get(name);
  } catch {
    return null;
  }
}
