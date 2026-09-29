import type { ClassificationField, Registry, SkillClassification, SkillRefsGraph } from "@/types";

export type ContributionProvenance = "assigned" | "direct" | "indirect";
export interface ClassificationContribution {
	value: string;
	provenance: ContributionProvenance;
	contributors: string[];
}
export interface ClassificationUpdateState {
	update: <K extends ClassificationField>(field: K, value: SkillClassification[K]) => Promise<void>;
	pendingField: ClassificationField | null;
	settled: { field: ClassificationField; ok: boolean } | null;
}

export interface SimplePathCursor {
	path: string[];
	indexes: number[];
}
export type ClassificationTraversalObserver = (kind: "node" | "edge", name: string, to?: string) => void;

export const asciiIdentity = (value: string): string =>
	value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
const compareIdentity = (a: string, b: string) => {
	const left = asciiIdentity(a), right = asciiIdentity(b);
	return left < right ? -1 : left > right ? 1 : a < b ? -1 : a > b ? 1 : 0;
};

export function compareClassContributions(a: ClassificationContribution, b: ClassificationContribution): number {
	const rank = { assigned: 0, direct: 1, indirect: 2 };
	return rank[a.provenance] - rank[b.provenance] || compareIdentity(a.value, b.value);
}

export function normalizeClassificationValues(values: string[]): string[] {
	const seen = new Set<string>();
	return values.map((value) => value.trim()).filter((value) => {
		const id = asciiIdentity(value);
		if (!id || seen.has(id)) return false;
		seen.add(id);
		return true;
	});
}

function adjacency(graph: SkillRefsGraph): Map<string, string[]> {
	const map = new Map<string, Set<string>>();
	for (const edge of graph.edges ?? []) {
		if (!map.has(edge.from)) map.set(edge.from, new Set());
		map.get(edge.from)!.add(edge.to);
	}
	return new Map([...map].map(([from, tos]) => [from, [...tos].sort(compareIdentity)]));
}

type Found = { distance: number; contributors: Set<string>; spelling: string; spellingContributor: string };
const summaryCache = new WeakMap<object, WeakMap<object, Map<string, { classes: ClassificationContribution[]; outputs: ClassificationContribution[] }>>>();
function valuesFor(skill: SkillClassification | undefined, field: "classes" | "outputs") {
	return skill?.[field] ?? [];
}

function resolveField(
	registry: Registry,
	distances: Map<string, number>,
	field: "classes" | "outputs",
): ClassificationContribution[] {
	const found = new Map<string, Found>();
	for (const [name, distance] of distances) {
		const current = { name, distance };
		const skill = registry.skills[current.name];
		for (const value of valuesFor(skill?.classification, field)) {
			const id = asciiIdentity(value);
			const prior = found.get(id);
			if (!prior || current.distance < prior.distance) {
				found.set(id, { distance: current.distance, contributors: new Set([current.name]), spelling: value, spellingContributor: current.name });
			} else {
				prior.contributors.add(current.name);
				if (current.distance === prior.distance && current.name < prior.spellingContributor) {
					prior.spelling = value;
					prior.spellingContributor = current.name;
				}
			}
		}
	}
	const preset = field === "outputs" ? ["prompt", "plan", "code change", "PR"] : [];
		const rows = [...found.values()].map((item) => ({
			value: item.spelling,
			provenance: (item.distance === 0 ? "assigned" : item.distance === 1 ? "direct" : "indirect") as ContributionProvenance,
			contributors: [...item.contributors].sort(compareIdentity),
			distance: item.distance,
		}));
	const presetRank = (value: string) => {
		const index = preset.findIndex((item) => asciiIdentity(item) === asciiIdentity(value));
		return index < 0 ? 999 : index;
	};
	return rows
		.sort((a, b) => {
			if (field === "classes") return compareClassContributions(a, b);
			const ar = presetRank(a.value), br = presetRank(b.value);
			if (ar !== br) return ar - br;
			if (a.provenance === "assigned" && b.provenance === "assigned") return 0;
			if (a.distance !== b.distance) return a.distance - b.distance;
			return compareIdentity(a.value, b.value);
		})
		.map(({ value, provenance, contributors }) => ({ value, provenance, contributors }));
}

export function resolveClassificationContributions(
	root: string,
	registry: Registry,
	graph: SkillRefsGraph,
	onVisit?: ClassificationTraversalObserver,
): { classes: ClassificationContribution[]; outputs: ClassificationContribution[] } {
	let byGraph = summaryCache.get(registry);
	if (!byGraph) { byGraph = new WeakMap(); summaryCache.set(registry, byGraph); }
	let byRoot = byGraph.get(graph);
	if (!byRoot) { byRoot = new Map(); byGraph.set(graph, byRoot); }
	const cached = byRoot.get(root);
	if (cached && !onVisit) return cached;
	const adj = adjacency(graph);
	const distances = new Map<string, number>([[root, 0]]);
	const queue = [root];
	for (let index = 0; index < queue.length; index++) {
		const name = queue[index];
		onVisit?.("node", name);
		for (const next of adj.get(name) ?? []) {
			onVisit?.("edge", name, next);
			if (!distances.has(next) && registry.skills[next]) {
				distances.set(next, distances.get(name)! + 1);
				queue.push(next);
			}
		}
	}
	const result = { classes: resolveField(registry, distances, "classes"), outputs: resolveField(registry, distances, "outputs") };
	byRoot.set(root, result);
	return result;
}

export function nextSimpleContributionPaths(
	root: string,
	contributor: string,
	graph: SkillRefsGraph,
	cursor: SimplePathCursor | null,
	pageSize: number,
	validNodes?: ReadonlySet<string>,
	stepBudget = 1000,
): { paths: string[][]; nextCursor: SimplePathCursor | null } {
	if (root === contributor) return cursor ? { paths: [], nextCursor: null } : { paths: [[root]], nextCursor: null };
	const adj = adjacency(graph);
	const state: SimplePathCursor = cursor
		? { path: [...cursor.path], indexes: [...cursor.indexes] }
		: { path: [root], indexes: [0] };
	const paths: string[][] = [];
	let steps = 0;
	while (state.path.length && paths.length < Math.max(1, pageSize) && steps < stepBudget) {
		steps++;
		const node = state.path[state.path.length - 1];
		const nexts = adj.get(node) ?? [];
		const frame = state.indexes.length - 1;
		if (state.path.length > 1 && node === contributor) {
			paths.push([...state.path]);
			state.indexes[frame] = nexts.length;
		}
		if (state.indexes[frame] >= nexts.length) {
			state.path.pop(); state.indexes.pop();
			if (state.indexes.length) state.indexes[state.indexes.length - 1]++;
			continue;
		}
		const target = nexts[state.indexes[frame]];
		if (validNodes && !validNodes.has(target)) { state.indexes[frame]++; continue; }
		if (state.path.includes(target)) { state.indexes[frame]++; continue; }
		state.path.push(target); state.indexes.push(0);
	}
	return { paths, nextCursor: state.path.length ? state : null };
}
