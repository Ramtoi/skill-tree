import { describe, expect, it } from "vitest";
import {
	nextSimpleContributionPaths,
	normalizeClassificationValues,
	resolveClassificationContributions,
} from "@/lib/skillClassification";
import type { Registry, SkillRefsGraph } from "@/types";
import { invoke as mockInvoke } from "@/mocks/tauriCore";

const registry = (names: Record<string, object>): Registry => ({
	version: "1", skills: Object.fromEntries(Object.entries(names).map(([name, extra]) => [name, {
		version: "1", description: "", source: "", type: "claude-skill", scope: "global", upstream: null, ...extra,
	}])), projects: {}, bundles: {},
});
const graph = (edges: Array<[string, string]>): SkillRefsGraph => ({ edges: edges.map(([from, to]) => ({ from, to, count: 1 })) });

describe("skill classification resolver", () => {
	it("normalizes with ASCII-only identity", () => {
		expect(normalizeClassificationValues([" Plan ", "plan", "İ", "i", ""])).toEqual(["Plan", "İ", "i"]);
	});
	it("keeps all contributors while choosing nearest provenance", () => {
		const r = registry({ A: { classification: { classes: ["Process"], outputs: ["custom", "plan"] } }, B: { classification: { classes: ["process"], outputs: ["custom2"] } }, C: { classification: { classes: ["PROCESS"], outputs: ["custom3"] } }, D: { classification: { outputs: ["custom"] } } });
		const result = resolveClassificationContributions("A", r, graph([["A", "B"], ["A", "C"], ["B", "D"]]));
		expect(result.classes[0]).toMatchObject({ value: "Process", provenance: "assigned", contributors: ["A", "B", "C"] });
		expect(result.outputs.map((x) => x.value)).toEqual(["plan", "custom", "custom2", "custom3"]);
		expect(result.outputs.find((x) => x.value === "custom")?.contributors).toEqual(["A", "D"]);
	});
	it("orders class chips by provenance then ASCII identity", () => {
		const r = registry({ root: { classification: { classes: ["Zulu", "Beta"] } }, direct: { classification: { classes: ["zebra", "alpha"] } }, indirect: { classification: { classes: ["aardvark"] } }, deeper: { classification: { classes: ["a"] } } });
		const result = resolveClassificationContributions("root", r, graph([["root", "direct"], ["direct", "indirect"], ["indirect", "deeper"]]));
		expect(result.classes.map((item) => [item.value, item.provenance])).toEqual([
			["Beta", "assigned"], ["Zulu", "assigned"], ["alpha", "direct"], ["zebra", "direct"], ["a", "indirect"], ["aardvark", "indirect"],
		]);
	});
	it("summarizes a 26-layer diamond without path enumeration", () => {
		const edges: Array<[string, string]> = [];
		const names: Record<string, object> = { root: {} };
		let previous = "root";
		for (let i = 0; i < 26; i++) {
			const left = `l${i}`, right = `r${i}`; names[left] = {}; names[right] = {};
			edges.push([previous, left], [previous, right]); previous = left; edges.push([right, left]);
		}
		names[previous] = { classification: { outputs: ["plan"] } };
		let visits = 0;
		const nodes = new Set<string>(); let edgeVisits = 0;
		const result = resolveClassificationContributions("root", registry(names), graph(edges), (kind, name) => { if (kind === "node") { if (nodes.has(name)) throw new Error("duplicate node"); nodes.add(name); } else { edgeVisits++; } if (++visits > 200 || edgeVisits > 100) throw new Error("excessive traversal"); });
		expect(result.outputs[0]).toMatchObject({ value: "plan", provenance: "indirect" });
		expect(visits).toBeLessThan(200);
		expect(nodes.size).toBeGreaterThan(40);
		expect(edgeVisits).toBeLessThan(100);
	});
	it("retains A/B/C/D shortcut paths and nearest assigned/direct/indirect values", () => {
		const r = registry({ A: { classification: { outputs: ["assigned"] } }, B: { classification: { outputs: ["direct"] } }, C: { classification: { outputs: ["indirect"] } }, D: { classification: { outputs: ["deep"] } } });
		const g = graph([["A", "B"], ["A", "C"], ["B", "C"], ["C", "D"], ["D", "A"]]);
		const result = resolveClassificationContributions("A", r, g);
		expect(result.outputs.map((item) => [item.value, item.provenance])).toEqual([["assigned", "assigned"], ["direct", "direct"], ["indirect", "direct"], ["deep", "indirect"]]);
		let cursor = null; const paths: string[][] = [];
		do { const page = nextSimpleContributionPaths("A", "C", g, cursor, 10, undefined, 2); paths.push(...page.paths); cursor = page.nextCursor; } while (cursor);
		expect(paths).toEqual([["A", "B", "C"], ["A", "C"]]);
	});
	it("mock hub command returns the flagged graph payload shape", async () => {
		const result = await mockInvoke<{ success: boolean; output: string }>("hub_cmd", { args: ["skill", "refs", "--json"] });
		const payload = JSON.parse(result.output);
		expect(result.success).toBe(true);
		expect(payload.edges).toEqual(expect.arrayContaining([expect.objectContaining({ from: "rt-android-expert", to: "android-compose-ui", count: 1 })]));
	});
	it("pages every simple path once across cycles and duplicate edges", () => {
		const g = graph([["A", "B"], ["A", "B"], ["A", "C"], ["B", "C"], ["C", "A"]]);
		const all: string[][] = []; let cursor = null;
		do { const page = nextSimpleContributionPaths("A", "C", g, cursor, 1); all.push(...page.paths); cursor = page.nextCursor; } while (cursor);
		expect(all).toEqual([["A", "B", "C"], ["A", "C"]]);
		expect(new Set(all.map((p) => p.join("/"))).size).toBe(all.length);
	});
	it("can filter stale graph nodes while paging", () => {
		const page = nextSimpleContributionPaths("A", "C", graph([["A", "missing"], ["missing", "C"]]), null, 5, new Set(["A", "C"]));
		expect(page.paths).toEqual([]);
	});
	it("uses a finite resumable budget through dead diamond branches", () => {
		const edges: Array<[string, string]> = []; const names: Record<string, object> = { root: {}, target: { classification: { outputs: ["plan"] } } };
		let previous = "root";
		for (let i = 0; i < 26; i++) {
			const dead = `a${i}`, live = `z${i}`; names[dead] = {}; names[live] = {};
			edges.push([previous, dead], [previous, live]);
			// Every dead branch continues into another diamond, creating substantial
			// work before the lexically-later live branch is reached.
			edges.push([dead, `a${i}x`]); names[`a${i}x`] = {};
			previous = live;
		}
		edges.push([previous, "target"]);
		let cursor = null; let found = false; let calls = 0;
		const first = nextSimpleContributionPaths("root", "target", graph(edges), null, 1, undefined, 8);
		expect(first.paths).toEqual([]);
		expect(first.nextCursor).not.toBeNull();
		cursor = first.nextCursor;
		do {
			const page = nextSimpleContributionPaths("root", "target", graph(edges), cursor, 1, undefined, 8);
			if (page.paths.some((path) => path[path.length - 1] === "target")) found = true;
			cursor = page.nextCursor; calls++;
			expect(calls).toBeLessThan(1000);
		} while (cursor && !found);
		expect(found).toBe(true);
	});
	it("tracks the same value as assigned, direct, and indirect by root distance", () => {
		const r = registry({ A: { classification: { outputs: ["plan"] } }, B: { classification: { outputs: ["plan"] } }, C: {}, D: { classification: { outputs: ["plan"] } }, X: {} });
		const g = graph([["X", "A"], ["A", "B"], ["B", "C"], ["C", "D"]]);
		expect(resolveClassificationContributions("A", r, g).outputs[0].provenance).toBe("assigned");
		const direct = registry({ A: {}, B: { classification: { outputs: ["plan"] } }, C: {}, D: { classification: { outputs: ["plan"] } }, X: {} });
		expect(resolveClassificationContributions("A", direct, g).outputs[0].provenance).toBe("direct");
		const indirect = registry({ A: {}, B: {}, C: {}, D: { classification: { outputs: ["plan"] } }, X: {} });
		expect(resolveClassificationContributions("A", indirect, g).outputs[0].provenance).toBe("indirect");
	});
	it("does not cross an unregistered intermediate in the summary", () => {
		const r = registry({ root: {}, target: { classification: { outputs: ["plan"] } } });
		expect(resolveClassificationContributions("root", r, graph([["root", "missing"], ["missing", "target"]])).outputs).toEqual([]);
	});
});
