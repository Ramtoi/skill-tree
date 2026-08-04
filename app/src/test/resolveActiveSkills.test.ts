import { describe, it, expect } from "vitest";
import { resolveActiveSkills } from "@/lib/resolveActiveSkills";

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
