import type { UsageModelBreakdown, UsageTokenCounts } from "@/features/usage/usageTypes";
import type { UsageSessionPresentation } from "./usageSessionPresentation";
import { parseUsageDate } from "./usageAggregate";
import { canonicalHarness, sessionKey } from "@/features/usage/sessionIdentity";

export type UsageSessionFamily<T extends UsageSessionPresentation> = {
  session: T;
  /** Measured rows in the current filter. Never contains a rolled-up row. */
  members: T[];
  parentUnavailable: boolean;
  contextOnly: boolean;
};

export function sessionParentId(session: UsageSessionPresentation): string | undefined {
  if (session.harnessId !== "codex") return undefined;
  return session.parentSessionId ?? (session.inspection?.root_session_id !== session.id ? session.inspection?.root_session_id : undefined);
}

const keyOf = (session: UsageSessionPresentation) =>
  sessionKey(session.harnessId, session.id) ?? `${canonicalHarness(session.harnessId) ?? session.harnessId.toLowerCase()}:${session.id}`;
const zero = (): UsageTokenCounts => ({ input: 0, output: 0, cacheCreation: 0, cacheRead: 0, total: 0 });
function add(target: UsageTokenCounts, value: UsageTokenCounts) {
  for (const key of Object.keys(target) as (keyof UsageTokenCounts)[]) target[key] += value[key];
}

function aggregate<T extends UsageSessionPresentation>(root: T, members: T[]): T {
  if (members.length === 1 && members[0] === root) return root;
  const completeSplit = members.every((member) => "input" in member.tokens);
  const tokens = zero();
  const models = new Map<string, UsageModelBreakdown>();
  const tools = new Map<string, number>();
  for (const member of members) {
    if ("input" in member.tokens) add(tokens, member.tokens);
    else tokens.total += member.tokens.total;
    for (const model of member.modelBreakdown ?? []) {
      const value = models.get(model.modelName) ?? { ...model, tokens: zero(), estimatedCost: { ...model.estimatedCost, usd: 0 } };
      add(value.tokens, model.tokens);
      value.estimatedCost.usd += model.estimatedCost.usd;
      if (model.costKnown === false) value.costKnown = false;
      models.set(model.modelName, value);
    }
    for (const tool of member.toolBreakdown ?? []) tools.set(tool.name, (tools.get(tool.name) ?? 0) + tool.count);
  }
  const sumOptional = (key: "toolCalls" | "reasoningOutputTokens" | "linesAdded" | "linesRemoved") =>
    members.every((member) => member[key] !== undefined) ? members.reduce((sum, member) => sum + member[key]!, 0) : undefined;
  const dates = members.flatMap((member) => [member.lastActivity ?? member.startedAt]).filter((value): value is string => parseUsageDate(value) !== undefined);
  return {
    ...root,
    tokens: completeSplit ? tokens : { total: tokens.total },
    estimatedCost: members.every((member) => member.estimatedCost) ? { usd: members.reduce((sum, member) => sum + member.estimatedCost!.usd, 0), label: "Estimated API-equivalent cost" } : undefined,
    models: [...new Set(members.flatMap((member) => member.models))].sort(),
    modelBreakdown: [...models.values()].sort((a, b) => a.modelName.localeCompare(b.modelName)),
    toolBreakdown: [...tools].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    toolCalls: sumOptional("toolCalls"), reasoningOutputTokens: sumOptional("reasoningOutputTokens"),
    linesAdded: sumOptional("linesAdded"), linesRemoved: sumOptional("linesRemoved"),
    durationMs: undefined,
    lastActivity: dates.sort((a, b) => parseUsageDate(b)! - parseUsageDate(a)!)[0],
  };
}

/** Group only measured rows. The inventory supplies parent identity across filters. */
export function groupCodexSessions<T extends UsageSessionPresentation>(selected: readonly T[], inventory: readonly T[] = selected): UsageSessionFamily<T>[] {
  const byKey = new Map([...inventory, ...selected].map((session) => [keyOf(session), session]));
  const families = new Map<string, UsageSessionFamily<T>>();
  for (const session of new Map(selected.map((member) => [keyOf(member), member])).values()) {
    let root = session;
    let parentUnavailable = false;
    const visited = new Set<string>([session.id]);
    let parent = sessionParentId(root);
    while (parent) {
      if (visited.has(parent)) { root = session; parentUnavailable = true; break; }
      visited.add(parent);
      const candidate = byKey.get(sessionKey("codex", parent) ?? `codex:${parent}`);
      if (!candidate) { parentUnavailable = true; break; }
      root = candidate;
      parent = sessionParentId(root);
    }
    const key = keyOf(root);
    const family = families.get(key) ?? { session: root, members: [], parentUnavailable, contextOnly: false };
    family.members.push(session);
    families.set(key, family);
  }
  return [...families.values()].map((family) => {
    family.members.sort((a, b) => Number(b.id === family.session.id) - Number(a.id === family.session.id) || a.id.localeCompare(b.id));
    family.contextOnly = !family.members.some((member) => keyOf(member) === keyOf(family.session));
    family.session = aggregate(family.session, family.members);
    return family;
  });
}
