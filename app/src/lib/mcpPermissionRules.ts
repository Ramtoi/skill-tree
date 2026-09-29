import { harnessSupportsRule, type Capabilities, type NormalizedPermissions, type Rule, type RuleKind } from "@/types/permissions";

export type McpPermissionChoice = "default" | RuleKind;
export type McpPermissionChange = { server: string; tool?: string | null; decision: McpPermissionChoice; harnesses?: string[] | null };
export const MCP_RULE_KINDS: RuleKind[] = ["allow", "ask", "deny"];
const rank: Record<RuleKind, number> = { allow: 1, ask: 2, deny: 3 };

export function validMcpSegment(value: string): boolean {
  return /^[a-zA-Z0-9_.-]+$/.test(value) && !value.includes("__");
}
export function mcpTarget(server: string, tool?: string | null): string {
  if (!validMcpSegment(server) || (tool != null && !validMcpSegment(tool))) {
    throw new Error("Use an exact MCP name with letters, digits, dots, hyphens, or single underscores.");
  }
  return tool ? `mcp__${server}__${tool}` : `mcp__${server}`;
}
export const mcpAllToolsTarget = (server: string) => mcpTarget(server);
export const mcpToolTarget = (server: string, tool: string) => mcpTarget(server, tool);
export const mcpRules = (p: NormalizedPermissions): Rule[] => MCP_RULE_KINDS.flatMap((kind) => p[kind]);
export function mcpRuleIsBroad(rule: Rule, server: string): boolean {
  return rule.pattern === `mcp__${server}` || rule.pattern === `mcp__${server}__*`;
}
export function mcpRuleMatches(rule: Rule, server: string, tool?: string | null): boolean {
  return tool ? rule.pattern === `mcp__${server}__${tool}` : mcpRuleIsBroad(rule, server);
}
const owned = (rule: Rule, scope: "global" | "project") => scope === "global" ? rule.origin !== "project" : rule.origin !== "global";
const affinityKey = (rule: Rule) => JSON.stringify(rule.harnesses == null ? null : [...new Set(rule.harnesses)].sort());

export function projectMcpDecision(p: NormalizedPermissions, server: string, tool?: string | null) {
  const matches = mcpRules(p).filter((rule) => mcpRuleMatches(rule, server, tool));
  const ambiguous = new Set(matches.map((rule) => `${rule.kind}:${affinityKey(rule)}`)).size > 1;
  return { decision: (matches[0]?.kind ?? "default") as McpPermissionChoice, rule: matches[0], ambiguous };
}

/** Only the supplied writable scope changes. A rejected batch leaves the input intact. */
export function applyMcpPermissionChanges(p: NormalizedPermissions, changes: McpPermissionChange[], scope: "global" | "project" = "global"): NormalizedPermissions {
  const next = { ...p, allow: [...p.allow], ask: [...p.ask], deny: [...p.deny] };
  for (const change of changes) {
    const pattern = mcpTarget(change.server, change.tool);
    const matches = mcpRules(next).filter((rule) => owned(rule, scope) && mcpRuleMatches(rule, change.server, change.tool));
    if (new Set(matches.map((rule) => `${rule.kind}:${affinityKey(rule)}`)).size > 1) {
      throw new Error(`Edit the separate rules for ${pattern} in Permissions; their decisions or coding-tool scopes differ.`);
    }
    const current = matches[0];
    if (current?.kind === change.decision || (!current && change.decision === "default")) continue;
    for (const kind of MCP_RULE_KINDS) {
      next[kind] = next[kind].filter((rule) => !(owned(rule, scope) && mcpRuleMatches(rule, change.server, change.tool)));
    }
    if (change.decision !== "default") {
      next[change.decision].push({
        ...(current ?? {}), pattern, kind: change.decision,
        harnesses: current ? current.harnesses : change.harnesses ?? null,
        ...(scope === "project" ? { origin: "project" as const } : {}),
      });
    }
  }
  return next;
}

function affinitiesOverlap(a: Rule, b: Rule, capabilities: Capabilities): boolean {
  const installed = Object.keys(capabilities);
  if (installed.length) {
    return installed.some((id) => (a.harnesses == null || a.harnesses.includes(id)) &&
      (b.harnesses == null || b.harnesses.includes(id)) && harnessSupportsRule(id, a, capabilities) && harnessSupportsRule(id, b, capabilities));
  }
  if (a.harnesses?.length === 0 || b.harnesses?.length === 0) return false;
  return a.harnesses == null || b.harnesses == null || a.harnesses.some((id) => b.harnesses!.includes(id));
}

/** Conservative blocker notice, not a runtime simulator for arbitrary MCP patterns. */
export function mcpChoiceBlocker(draft: NormalizedPermissions, context: NormalizedPermissions[], change: McpPermissionChange, capabilities: Capabilities, scope: "global" | "project"): string | null {
  if (change.decision === "default") return null;
  let next: NormalizedPermissions;
  try { next = applyMcpPermissionChanges(draft, [change], scope); } catch (error) { return String(error); }
  const candidate = projectMcpDecision(next, change.server, change.tool).rule;
  if (!candidate) return null;
  const relevant = [next, ...context].flatMap(mcpRules).filter((rule) => {
    if (rank[rule.kind] <= rank[change.decision as RuleKind] || !affinitiesOverlap(candidate, rule, capabilities)) return false;
    return mcpRuleIsBroad(rule, change.server) || (Boolean(change.tool) && mcpRuleMatches(rule, change.server, change.tool)) ||
      (rule.pattern.includes("*") && (rule.pattern.startsWith(`mcp__${change.server}__`) || rule.pattern.startsWith("mcp__*")));
  }).sort((a, b) => rank[b.kind] - rank[a.kind]);
  const blocker = relevant[0];
  return blocker ? `${blocker.kind === "deny" ? "Deny" : "Ask"} rule ${blocker.pattern} can block this choice. Edit that rule in Permissions first.` : null;
}
