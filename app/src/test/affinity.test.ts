import { describe, expect, it } from "vitest";
import { affinityMismatch, effectiveHarnesses } from "@/lib/affinity";
import type { Project, Registry, Skill } from "@/types";

function skill(harnesses?: string[]): Skill {
	return {
		version: "1.0.0",
		description: "",
		source: "",
		type: "claude-skill",
		scope: "portable",
		upstream: null,
		...(harnesses ? { harnesses } : {}),
	};
}

const registry = {
	version: "1",
	hub_path: "~",
	skills: {},
	projects: {},
	bundles: {},
	harnesses_global: ["claude-code"],
} as unknown as Registry;

const claudeProject: Project = { path: "/p", bundles: [], enabled: [] };

describe("effectiveHarnesses", () => {
	it("intersects the global∪project union with installed", () => {
		const proj: Project = { path: "/p", bundles: [], enabled: [], harnesses: ["codex", "pi"] };
		expect(
			effectiveHarnesses(proj, registry, ["claude-code", "codex"]).sort(),
		).toEqual(["claude-code", "codex"]);
	});
	it("returns the raw union when installed is omitted", () => {
		const proj: Project = { path: "/p", bundles: [], enabled: [], harnesses: ["codex"] };
		expect(effectiveHarnesses(proj, registry).sort()).toEqual([
			"claude-code",
			"codex",
		]);
	});
});

describe("affinityMismatch", () => {
	it("badges a codex-only skill on a claude-only project (empty intersection)", () => {
		expect(
			affinityMismatch(skill(["codex"]), claudeProject, registry, [
				"claude-code",
			]),
		).toBe(true);
	});

	it("does not badge when affinity intersects effective harnesses", () => {
		expect(
			affinityMismatch(skill(["claude-code", "codex"]), claudeProject, registry, [
				"claude-code",
			]),
		).toBe(false);
	});

	it("never badges a skill with no declared affinity", () => {
		expect(affinityMismatch(skill(), claudeProject, registry, ["claude-code"])).toBe(
			false,
		);
		expect(
			affinityMismatch(skill([]), claudeProject, registry, ["claude-code"]),
		).toBe(false);
	});

	it("badges when the declared harness is not installed (empty effective set)", () => {
		// codex declared + in project.harnesses, but not installed → effective ∅.
		const proj: Project = { path: "/p", bundles: [], enabled: [], harnesses: ["codex"] };
		expect(affinityMismatch(skill(["codex"]), proj, registry, ["claude-code"])).toBe(
			true,
		);
	});
});
