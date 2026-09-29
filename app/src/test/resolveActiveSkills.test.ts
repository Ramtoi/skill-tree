import { describe, it, expect } from "vitest";
import { resolveActiveSkills, resolveTargetSkills } from "@/lib/resolveActiveSkills";

const registry = {
	version: "1",
	hub_path: "~/hub",
	skills: {},
	projects: {},
	bundles: {
		workflow: {
			description: "",
			icon: "⚡",
			scope: "project-specific",
			skills: ["brainstorm", "grill"],
		},
		extras: {
			description: "",
			icon: "✨",
			scope: "project-specific",
			skills: ["grill", "reviewer"],
		},
		everywhere: {
			description: "",
			icon: "🌍",
			scope: "global",
			skills: ["global-skill", "grill"],
		},
	},
};

describe("resolveActiveSkills", () => {
	it("deduplicates direct and bundle-provided skills", () => {
		const result = resolveActiveSkills(
			{
				path: "/tmp/x",
				bundles: ["workflow", "extras"],
				enabled: ["grill", "solo"],
			},
			registry as any,
		);

		expect(result.sort()).toEqual(
			["brainstorm", "global-skill", "grill", "reviewer", "solo"].sort(),
		);
	});

	it("handles missing bundles", () => {
		const result = resolveActiveSkills(
			{ path: "/tmp/x", bundles: ["missing"], enabled: ["solo"] },
			registry as any,
		);

		expect(result).toEqual(["global-skill", "grill", "solo"]);
	});

	it("includes global bundle skills for every project", () => {
		const result = resolveActiveSkills(
			{ path: "/tmp/x", bundles: ["workflow"], enabled: [] },
			registry as any,
		);

		expect(result.sort()).toEqual(
			["global-skill", "grill", "brainstorm"].sort(),
		);
	});
});

// ─── resolveTargetSkills — remotes + cloud targets ────────────────────────────
// The ONE count the Remotes card and the navigator row share; mirrors
// `resolve_remote_skills` (order + opt-in globals) and `partition_equipped`
// (unknown names dropped, MCP refused for cloud).
describe("resolveTargetSkills", () => {
	const reg = {
		...registry,
		skills: {
			brainstorm: { type: "claude-skill" },
			grill: { type: "claude-skill" },
			reviewer: { type: "claude-skill" },
			"global-skill": { type: "claude-skill" },
			"fs-mcp": { type: "mcp-server" },
		},
	} as any;

	it("unions bundles ∪ enabled in backend order and dedupes", () => {
		expect(
			resolveTargetSkills({ bundles: ["workflow"], enabled: ["reviewer", "grill"] }, reg),
		).toEqual(["brainstorm", "grill", "reviewer"]);
	});

	it("drops names the registry no longer knows", () => {
		expect(
			resolveTargetSkills({ enabled: ["brainstorm", "gone-skill"] }, reg),
		).toEqual(["brainstorm"]);
	});

	it("inherits scope:global bundles only via apply_global_bundles", () => {
		expect(resolveTargetSkills({ enabled: ["reviewer"] }, reg)).toEqual([
			"reviewer",
		]);
		expect(
			resolveTargetSkills(
				{ enabled: ["reviewer"], apply_global_bundles: true },
				reg,
			),
		).toEqual(["global-skill", "grill", "reviewer"]);
	});

	it("excludes MCP servers only when asked (the cloud rule)", () => {
		const equip = { enabled: ["brainstorm", "fs-mcp"] };
		expect(resolveTargetSkills(equip, reg)).toEqual(["brainstorm", "fs-mcp"]);
		expect(resolveTargetSkills(equip, reg, { excludeMcp: true })).toEqual([
			"brainstorm",
		]);
	});

	it("is empty without an equip block or a loaded registry", () => {
		expect(resolveTargetSkills(undefined, reg)).toEqual([]);
		expect(resolveTargetSkills({ enabled: ["brainstorm"] }, undefined)).toEqual([]);
	});
});
