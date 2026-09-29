import type { SkillRefsGraph } from "@/types";

export interface SkillReferenceStats { outgoing: string[]; incoming: string[] }

/** Distinct skill relationships, not invocation counts or mention frequency. */
export function skillReferenceStats(graph: SkillRefsGraph | undefined): Map<string, SkillReferenceStats> | undefined {
  if (!graph || !Array.isArray(graph.edges)) return undefined;
  const refs = new Map<string, { outgoing: Set<string>; incoming: Set<string> }>();
  const get = (name: string) => {
    let row = refs.get(name);
    if (!row) { row = { outgoing: new Set(), incoming: new Set() }; refs.set(name, row); }
    return row;
  };
  for (const edge of graph.edges) {
    if (edge.from === edge.to) continue;
    get(edge.from).outgoing.add(edge.to);
    get(edge.to).incoming.add(edge.from);
  }
  return new Map([...refs].map(([name, row]) => [name, { outgoing: [...row.outgoing].sort(), incoming: [...row.incoming].sort() }]));
}
