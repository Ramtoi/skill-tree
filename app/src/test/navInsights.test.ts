import { describe, expect, it } from "vitest";
import {
	agentsInsights,
	attentionText,
	bundleRowMark,
	cloudRowMark,
	contextInsights,
	elsewhereInsights,
	firstOffender,
	formatUsd,
	guardrailsInsights,
	harnessRowMark,
	hookRowMark,
	projectRowMark,
	projectsInsights,
	remoteRowMark,
	shortSandbox,
	skillRowMark,
	snippetRowMark,
	sourceRowMark,
	type NavGroupInsights,
} from "@/lib/navInsights";
import type { Registry } from "@/types";
import type { SyncReportEnvelope } from "@/lib/syncFreshness";
import type { HarnessStatus } from "@/store";
import type { SnippetInfo } from "@/types/snippets";
import type { HookRow } from "@/hooks/useHooks";
import type { BackupStatus } from "@/lib/backupContract";
import { isUnsafeCodexCombo, SUDO_RE } from "@/lib/permissionsRisks";
import {
	registry as mockRegistry,
	syncReportEnvelope as mockSyncEnvelope,
} from "@/mocks/tauriCore";
import { isFreshUsage } from "@/lib/usageGuidance";

function baseRegistry(overrides: Partial<Registry> = {}): Registry {
	return {
		version: "1",
		skills: {},
		projects: {},
		bundles: {},
		...overrides,
	};
}

function envelope(overrides: Partial<SyncReportEnvelope["report"]> = {}): SyncReportEnvelope {
	return {
		report: {
			schema_version: 1,
			generated_at: "2026-07-05T14:32:10Z",
			registry_sha256: "abc",
			registry_mtime: 0,
			ok: true,
			global: {
				skipped: [],
				skills: { writes: 6, removed: 0 },
				mcp: { writes: 2, removed: 0 },
				permissions: { ok: true, errors: [] },
				remotes: { attempted: 0, alarming: 0 },
			},
			projects: {},
			...overrides,
		},
		registry_current: { sha256: "abc", mtime: 0 },
	};
}

function harness(overrides: Partial<HarnessStatus> = {}): HarnessStatus {
	return {
		id: "claude-code",
		label: "Claude Code",
		installed: true,
		on_globally: true,
		used_by_projects: [],
		...overrides,
	};
}

// ─── firstOffender / attentionText ──────────────────────────────────────────

describe("firstOffender", () => {
	it("sorts alphabetically, not by discovery order", () => {
		expect(firstOffender(["zeta", "alpha"])).toBe("alpha");
	});
});

describe("attentionText", () => {
	it("names the item at N = 1", () => {
		expect(attentionText("projects.failed", ["example-app"])).toBe(
			"example-app sync failed",
		);
	});
	it("carries only the count at N > 1", () => {
		expect(attentionText("projects.failed", ["zeta", "alpha"])).toBe("2 project syncs failed");
	});
});

// ─── Projects ───────────────────────────────────────────────────────────────

describe("projectsInsights", () => {
	it("treats future and stale scan timestamps as not fresh", () => {
		const now = Date.parse("2026-09-08T12:00:00Z");
		expect(isFreshUsage("2026-09-08T12:01:00Z", now)).toBe(false);
		expect(isFreshUsage("2026-08-31T11:59:59Z", now)).toBe(false);
		expect(isFreshUsage("2026-09-05T12:00:00Z", now)).toBe(true);
	});
	it("IN SYNC: fresh/total and the worst-fact sub (failed beats stale)", () => {
		const reg = baseRegistry({
			projects: {
				a: { path: "/a", bundles: [], enabled: [] },
				b: { path: "/b", bundles: [], enabled: [] },
				c: { path: "/c", bundles: [], enabled: [] },
			},
		});
		const env = envelope({
			registry_sha256: "current",
			projects: {
				a: { ts: "t", ok: false, errors: [], writes: 0, removed: 0, affinity_skips: [] },
				b: { ts: "t", ok: true, errors: [], writes: 0, removed: 0, affinity_skips: [] },
			},
		});
		env.registry_current = { sha256: "different", mtime: 0 };
		const { tiles } = projectsInsights(reg, env, []);
		expect(tiles[0].label).toBe("IN SYNC");
		expect(tiles[0].sub).toBe("1 failed");
		expect(tiles[0].title).toContain("1 failed");
		expect(tiles[0].title).toContain("1 stale");
	});

	// F1/A1: 13 quarantined + 2 failed must show ZERO successes — a quarantined
	// project's own bucket, never folded into "stale" (that reads as "needs a
	// re-sync", which is not the fix) or counted toward IN SYNC.
	it("IN SYNC: quarantined projects never count as fresh, and get their own 'unattached' bucket", () => {
		const reg = baseRegistry({
			projects: {
				a: { path: "/a", bundles: [], enabled: [], path_unresolved: true },
				b: { path: "/b", bundles: [], enabled: [] },
				c: { path: "/c", bundles: [], enabled: [], path_unresolved: true },
			},
		});
		const env = envelope({
			registry_sha256: "current",
			projects: {
				a: { ts: "t", ok: true, errors: [], writes: 0, removed: 0, affinity_skips: [], quarantined: "path_unresolved" },
				b: { ts: "t", ok: true, errors: [], writes: 0, removed: 0, affinity_skips: [] },
				c: { ts: "t", ok: true, errors: [], writes: 0, removed: 0, affinity_skips: [], quarantined: "path_unresolved" },
			},
		});
		env.registry_current = { sha256: "current", mtime: 0 };
		const { tiles } = projectsInsights(reg, env, []);
		expect(tiles[0].value).toBe("1/3");
		expect(tiles[0].sub).toBe("2 unattached");
		expect(tiles[0].title).not.toContain("stale");
	});

	it("unattached line: one action per project plus a bulk 'Attach directory' action to /recovery", () => {
		const reg = baseRegistry({
			projects: {
				alpha: { path: "/a", bundles: [], enabled: [], path_unresolved: true },
				beta: { path: "/b", bundles: [], enabled: [], path_unresolved: true },
			},
		});
		const env = envelope({
			projects: {
				alpha: { ts: "t", ok: true, errors: [], writes: 0, removed: 0, affinity_skips: [], quarantined: "path_unresolved" },
				beta: { ts: "t", ok: true, errors: [], writes: 0, removed: 0, affinity_skips: [], quarantined: "path_unresolved" },
			},
		});
		const { lines } = projectsInsights(reg, env, []);
		const line = lines.find((l) => l.key === "projects.unattached")!;
		expect(line).toBeDefined();
		expect(line.text).toBe("2 projects have no local directory attached");
		expect(line.explanation.action).toEqual({ label: "Attach directory", href: "/recovery" });
		expect(line.explanation.affected.map((a) => a.label)).toEqual(["alpha", "beta"]);
		expect(line.explanation.affected[0]?.action?.href).toBe("/project/alpha?tab=loadout");
	});

	it("no unattached line when nothing is quarantined", () => {
		const reg = baseRegistry({ projects: { a: { path: "/a", bundles: [], enabled: [] } } });
		const env = envelope({ projects: { a: { ts: "t", ok: true, errors: [], writes: 0, removed: 0, affinity_skips: [] } } });
		const { lines } = projectsInsights(reg, env, []);
		expect(lines.find((l) => l.key === "projects.unattached")).toBeUndefined();
	});

	it("LAST SYNC reads never/run sync with no envelope", () => {
		const reg = baseRegistry({ projects: { a: { path: "/a", bundles: [], enabled: [] } } });
		const { tiles } = projectsInsights(reg, null, []);
		expect(tiles[1].value).toBe("never");
		expect(tiles[1].sub).toBe("run sync");
	});

	it("failed-to-sync line hrefs the first offender, alphabetically", () => {
		const reg = baseRegistry({
			projects: {
				zeta: { path: "/z", bundles: [], enabled: [] },
				alpha: { path: "/a", bundles: [], enabled: [] },
			},
		});
		const env = envelope({
			projects: {
				zeta: { ts: "t", ok: false, errors: [], writes: 0, removed: 0, affinity_skips: [] },
				alpha: { ts: "t", ok: false, errors: [], writes: 0, removed: 0, affinity_skips: [] },
			},
		});
		const { lines } = projectsInsights(reg, env, []);
		const line = lines.find((l) => l.key === "projects.failed")!;
		expect(line.text).toBe("2 project syncs failed");
		expect(line.explanation.affected[0]?.label).toBe("alpha");
		expect(line.explanation.affected[0]?.action?.href).toBe("/project/alpha?tab=loadout");
	});

	it("N = 1 names the project; N > 1 carries the offender token", () => {
		const reg = baseRegistry({ projects: { solo: { path: "/s", bundles: [], enabled: [] } } });
		const env = envelope({
			projects: {
				solo: { ts: "t", ok: false, errors: [], writes: 0, removed: 0, affinity_skips: [] },
			},
		});
		const { lines } = projectsInsights(reg, env, []);
		const line = lines.find((l) => l.key === "projects.failed")!;
		expect(line.text).toBe("solo sync failed");
		expect(line.explanation.affected[0]?.label).toBe("solo");
	});

	it("reached-no-agent names the skill, links to its owning project", () => {
		const reg = baseRegistry({
			projects: {
				"moon-base": { path: "/m", bundles: [], enabled: [] },
				"example-app": { path: "/e", bundles: [], enabled: [] },
			},
		});
		const env = envelope({
			projects: {
				"moon-base": {
					ts: "t",
					ok: true,
					errors: [],
					writes: 0,
					removed: 0,
					affinity_skips: [
						{ skill: "zeta-skill", skill_harnesses: ["codex"], project_harnesses: ["claude-code"] },
					],
				},
				"example-app": {
					ts: "t",
					ok: true,
					errors: [],
					writes: 0,
					removed: 0,
					affinity_skips: [
						{ skill: "alpha-skill", skill_harnesses: ["codex"], project_harnesses: ["claude-code"] },
					],
				},
			},
		});
		const { lines } = projectsInsights(reg, env, []);
		const line = lines.find((l) => l.key === "projects.affinitySkip")!;
		expect(line.text).toBe("2 skills cannot reach an agent");
		expect(line.explanation.affected.map((item) => item.label)).toEqual([
			"zeta-skill · moon-base",
			"alpha-skill · example-app",
		]);
		expect(line.explanation.affected.every((item) => item.action?.href.includes("/project/"))).toBe(true);
	});

	it("write-to-no-agent is absent when harnesses=[] (never alarm on missing data)", () => {
		const reg = baseRegistry({
			projects: { a: { path: "/a", bundles: [], enabled: [] } },
		});
		const { lines } = projectsInsights(reg, null, []);
		expect(lines.find((l) => l.key === "projects.noAgent")).toBeUndefined();
	});

	it("write-to-no-agent fires once harnesses are known and none are effective", () => {
		const reg = baseRegistry({
			harnesses_global: [],
			projects: { a: { path: "/a", bundles: [], enabled: [] } },
		});
		const { lines } = projectsInsights(reg, null, [harness({ id: "codex", installed: true })]);
		const line = lines.find((l) => l.key === "projects.noAgent")!;
		expect(line.text).toBe("a has no active agent");
		expect(line.explanation.affected[0]?.action?.href).toBe("/project/a?tab=loadout");
	});

	it("skipped_unowned sums global + every project", () => {
		const reg = baseRegistry({
			projects: {
				a: { path: "/a", bundles: [], enabled: [] },
				b: { path: "/b", bundles: [], enabled: [] },
			},
		});
		const env = envelope({
			global: {
				skipped: [],
				skills: { writes: 0, removed: 0, skipped_unowned: 3 },
				mcp: { writes: 0, removed: 0 },
				permissions: { ok: true, errors: [] },
				remotes: { attempted: 0, alarming: 0 },
			},
			projects: {
				a: { ts: "t", ok: true, errors: [], writes: 0, removed: 0, affinity_skips: [], skipped_unowned: 2 },
				b: { ts: "t", ok: true, errors: [], writes: 0, removed: 0, affinity_skips: [] },
			},
		});
		const { lines } = projectsInsights(reg, env, []);
		expect(lines.map((line) => line.key)).not.toContain("projects.skippedUnowned");
	});

	it("raises a missing-reference attention line from the sync report", () => {
		const reg = baseRegistry({
			projects: {
				"moon-base": { path: "/m", bundles: [], enabled: [] },
				"example-app": { path: "/e", bundles: [], enabled: [] },
			},
		});
		const oneEnv = envelope({
			projects: {
				"moon-base": {
					ts: "t",
					ok: true,
					errors: [],
					writes: 0,
					removed: 0,
					affinity_skips: [],
					missing_refs: [{ skill: "rt-android-expert", refs: ["needs-global"] }],
				},
			},
		});
		const oneLine = projectsInsights(reg, oneEnv, []).lines.find(
			(l) => l.key === "projects.missingRefs",
		)!;
		expect(oneLine.tone).toBe("warn");
		expect(oneLine.text).toBe("1 equipped skill lacks referenced skills");
		expect(oneLine.explanation.affected[0]?.action?.href).toBe("/project/moon-base?tab=loadout");

		const twoEnv = envelope({
			projects: {
				"moon-base": {
					ts: "t",
					ok: true,
					errors: [],
					writes: 0,
					removed: 0,
					affinity_skips: [],
					missing_refs: [{ skill: "rt-android-expert", refs: ["needs-global"] }],
				},
				"example-app": {
					ts: "t",
					ok: true,
					errors: [],
					writes: 0,
					removed: 0,
					affinity_skips: [],
					missing_refs: [{ skill: "android", refs: ["proof-it"] }],
				},
			},
		});
		const twoLine = projectsInsights(reg, twoEnv, []).lines.find(
			(l) => l.key === "projects.missingRefs",
		)!;
		expect(twoLine.text).toBe("2 equipped skills lack referenced skills");
		expect(twoLine.explanation.affected[0]?.label).toBe("android · example-app");
	});

	it("raises no line when no project has missing refs", () => {
		const reg = baseRegistry({
			projects: {
				"moon-base": { path: "/m", bundles: [], enabled: [] },
			},
		});
		const env = envelope({
			projects: {
				"moon-base": {
					ts: "t",
					ok: true,
					errors: [],
					writes: 0,
					removed: 0,
					affinity_skips: [],
					missing_refs: [],
				},
			},
		});
		const { lines } = projectsInsights(reg, env, []);
		expect(lines.find((l) => l.key === "projects.missingRefs")).toBeUndefined();
	});

	it("raises no line for a report record whose project left the registry", () => {
		const reg = baseRegistry({
			projects: {
				"moon-base": { path: "/m", bundles: [], enabled: [] },
			},
		});
		const env = envelope({
			projects: {
				"gone-project": {
					ts: "t",
					ok: true,
					errors: [],
					writes: 0,
					removed: 0,
					affinity_skips: [],
					missing_refs: [{ skill: "rt-android-expert", refs: ["needs-global"] }],
				},
			},
		});
		const { lines } = projectsInsights(reg, env, []);
		expect(lines.find((l) => l.key === "projects.missingRefs")).toBeUndefined();
	});

	it("row mark: failed beats no-agent beats skipped beats re-sync", () => {
		const reg = baseRegistry({ projects: { a: { path: "/a", bundles: [], enabled: [] } } });
		const env = envelope({
			projects: {
				a: { ts: "t", ok: false, errors: [], writes: 0, removed: 0, affinity_skips: [] },
			},
		});
		const mark = projectRowMark("a", reg.projects.a, reg, env, []);
		expect(mark.hint).toBe("failed");
		expect(mark.hintTone).toBe("error");
		expect(mark.title).toContain("a");
	});

	it("row mark: quarantined shows 'no directory' (F1), never 'failed' — the record's ok stays true", () => {
		const reg = baseRegistry({
			projects: { a: { path: "/a", bundles: [], enabled: [], path_unresolved: true } },
		});
		const env = envelope({
			projects: {
				a: { ts: "t", ok: true, errors: [], writes: 0, removed: 0, affinity_skips: [], quarantined: "path_unresolved" },
			},
		});
		const mark = projectRowMark("a", reg.projects.a, reg, env, []);
		expect(mark.hint).toBe("no directory");
		expect(mark.hintTone).toBe("warn");
	});
});

// ─── Context ────────────────────────────────────────────────────────────────

describe("contextInsights", () => {
	function contextRegistry(): Registry {
		return baseRegistry({
			skills: {
				"global-idle": {
					version: "1",
					description: "x",
					source: "s",
					type: "claude-skill",
					scope: "global",
					upstream: null,
				},
				"portable-used": {
					version: "1",
					description: "x",
					source: "s",
					type: "claude-skill",
					scope: "portable",
					upstream: null,
				},
				"portable-idle": {
					version: "1",
					description: "x",
					source: "s",
					type: "claude-skill",
					scope: "portable",
					upstream: null,
				},
				"mcp-one": {
					version: "1",
					description: "x",
					source: "s",
					type: "mcp-server",
					scope: "global",
					upstream: null,
				},
			},
			projects: {
				p: { path: "/p", bundles: [], enabled: ["portable-used"] },
			},
			bundles: {},
		});
	}

	it("B3: a scope:global skill equipped nowhere counts as in use, not idle", () => {
		const reg = contextRegistry();
		const { tiles } = contextInsights(reg, undefined);
		// in use = global-idle, mcp-one (global scope) + portable-used (equipped) = 3
		// idle = portable-idle only = 1
		expect(tiles[1].value).toBe("3");
		expect(tiles[1].sub).toBe("1 idle");
	});

	it("description length tiers: 200 is ok, 201 is not", () => {
		const reg = baseRegistry({
			skills: {
				ok: {
					version: "1",
					description: "a".repeat(200),
					source: "s",
					type: "claude-skill",
					scope: "portable",
					upstream: null,
				},
				over: {
					version: "1",
					description: "a".repeat(201),
					source: "s",
					type: "claude-skill",
					scope: "portable",
					upstream: null,
				},
			},
		});
		const { lines } = contextInsights(reg, undefined);
		const line = lines.find((l) => l.key === "context.descriptionOver200")!;
		expect(line.text).toBe("over description too long");
	});

	it("conflicted invocation and dropped-upstream lines", () => {
		const reg = baseRegistry({
			skills: {
				"bad-invocation": {
					version: "1",
					description: "x",
					source: "s",
					type: "claude-skill",
					scope: "portable",
					upstream: null,
					invocation: "conflicted",
				},
				dropped: {
					version: "1",
					description: "x",
					source: "s",
					type: "claude-skill",
					scope: "portable",
					upstream: null,
					source_missing: true,
				},
			},
		});
		const { lines } = contextInsights(reg, undefined);
		expect(lines.find((l) => l.key === "context.conflicted")!.text).toBe(
			"bad-invocation invocation conflicts",
		);
		const droppedLine = lines.find((l) => l.key === "context.sourceMissing")!;
		expect(droppedLine.text).toBe("dropped removed upstream");
		// One offender → straight to the skill.
		expect(droppedLine.explanation.affected[0]?.action?.href).toBe("/skill/dropped");
	});

	it("dropped-upstream line: more than one offender sharing a source scopes to that card", () => {
		const reg = baseRegistry({
			skills: {
				alpha: {
					version: "1",
					description: "x",
					source: "s",
					type: "claude-skill",
					scope: "portable",
					upstream: null,
					managed: "external",
					origin: { source: "acme" },
					source_missing: true,
				},
				beta: {
					version: "1",
					description: "x",
					source: "s",
					type: "claude-skill",
					scope: "portable",
					upstream: null,
					managed: "external",
					origin: { source: "acme" },
					source_missing: true,
				},
			},
		});
		const { lines } = contextInsights(reg, undefined);
		const line = lines.find((l) => l.key === "context.sourceMissing")!;
		expect(line.text).toBe("2 skills removed upstream");
		expect(line.explanation.action?.href).toBe("/sources?focus=acme");
	});

	it("dropped-upstream line: more than one offender across different sources falls back to the screen", () => {
		const reg = baseRegistry({
			skills: {
				alpha: {
					version: "1",
					description: "x",
					source: "s",
					type: "claude-skill",
					scope: "portable",
					upstream: null,
					managed: "external",
					origin: { source: "acme" },
					source_missing: true,
				},
				beta: {
					version: "1",
					description: "x",
					source: "s",
					type: "claude-skill",
					scope: "portable",
					upstream: null,
					managed: "external",
					origin: { source: "other-org" },
					source_missing: true,
				},
			},
		});
		const { lines } = contextInsights(reg, undefined);
		const line = lines.find((l) => l.key === "context.sourceMissing")!;
		expect(line.explanation.action?.href).toBe("/sources");
	});

	it("a bundle listing a missing skill", () => {
		const reg = baseRegistry({
			bundles: {
				broken: { description: "d", icon: "x", skills: ["ghost"] },
			},
		});
		const { lines } = contextInsights(reg, undefined);
		const line = lines.find((l) => l.key === "context.bundleMissing")!;
		expect(line.text).toBe("broken lists missing skills");
		expect(line.explanation.affected[0]?.action?.href).toBe("/bundle/broken");
	});

	it("snippet outdated line + unused row mark", () => {
		const reg = baseRegistry();
		const snippets: SnippetInfo[] = [
			{
				name: "outdated-one",
				description: "d",
				tags: [],
				version: 1,
				created: "t",
				updated: "t",
				hash: "h",
				usage: { count: 1, summary: "outdated", outdated_count: 1 },
			},
			{
				name: "unused-one",
				description: "d",
				tags: [],
				version: 1,
				created: "t",
				updated: "t",
				hash: "h",
				usage: { count: 0, summary: "none", outdated_count: 0 },
			},
		];
		const { lines } = contextInsights(reg, snippets);
		const line = lines.find((l) => l.key === "context.snippetOutdated")!;
		expect(line.text).toBe("outdated-one has older applied copies");
		expect(line.explanation.affected[0]?.action?.href).toBe("/snippet/outdated-one");
		const mark = snippetRowMark(snippets[1]);
		expect(mark.hint).toBe("unused");
		expect(mark.dim).toBe(true);
	});

	it("bundle row mark precedence: N missing > linked > global > none", () => {
		const reg = baseRegistry({
			skills: {
				present: {
					version: "1",
					description: "x",
					source: "s",
					type: "claude-skill",
					scope: "portable",
					upstream: null,
				},
			},
			bundles: {
				broken: { description: "d", icon: "x", skills: ["present", "ghost"] },
				linked: { description: "d", icon: "x", skills: ["present"], source: "org-skills" },
				essentials: { description: "d", icon: "x", scope: "global", skills: ["present"] },
			},
			projects: {},
		});
		expect(bundleRowMark("broken", reg.bundles.broken, reg).hint).toBe("1 missing");
		expect(bundleRowMark("linked", reg.bundles.linked, reg).hint).toBe("linked");
		expect(bundleRowMark("essentials", reg.bundles.essentials, reg).hint).toBe("global");
	});

	it("skill row mark precedence: dropped > conflicted > over-200 > none", () => {
		const dropped = skillRowMark("s", {
			version: "1",
			description: "x",
			source: "s",
			type: "claude-skill",
			scope: "portable",
			upstream: null,
			source_missing: true,
			invocation: "conflicted",
		});
		expect(dropped.hint).toBe("dropped");
		const clean = skillRowMark("s", {
			version: "1",
			description: "short",
			source: "s",
			type: "claude-skill",
			scope: "portable",
			upstream: null,
		});
		expect(clean.hint).toBeUndefined();
		expect(clean.title).not.toContain("agents:");
	});
});

// ─── Guardrails ─────────────────────────────────────────────────────────────

describe("guardrailsInsights", () => {
	it("tiles come from the registry twin only", () => {
		const reg = baseRegistry({
			permissions_global: {
				allow: [{ pattern: "a" }],
				deny: [{ pattern: "b" }, { pattern: "c" }],
				ask: [],
				sandbox_mode: "danger-full-access",
				approval_policy: "on-failure",
			},
		});
		const { tiles } = guardrailsInsights(reg, null, undefined);
		expect(tiles[0].value).toBe("3");
		expect(tiles[0].sub).toBe("2 deny");
		expect(tiles[1].value).toBe("on-failure");
		expect(tiles[1].sub).toBe("full access");
	});

	it("shortSandbox('danger-full-access') === 'full access'", () => {
		expect(shortSandbox("danger-full-access")).toBe("full access");
		expect(shortSandbox(undefined)).toBe("—");
	});

	it("isUnsafeCodexCombo is imported (no local redeclaration) and drives a line", () => {
		const reg = baseRegistry({
			permissions_global: {
				allow: [],
				deny: [],
				ask: [],
				approval_policy: "never",
				sandbox_mode: "danger-full-access",
			},
		});
		expect(isUnsafeCodexCombo("never", "danger-full-access")).toBe(true);
		const { lines } = guardrailsInsights(reg, null, undefined);
		expect(lines.some((l) => l.key === "guardrails.unsafeCombo")).toBe(true);
	});

	it("_unmanaged copies through as a plain line", () => {
		const reg = baseRegistry({
			permissions_global: { allow: [], deny: [], ask: [], _unmanaged: ["codex"] },
		});
		const { lines } = guardrailsInsights(reg, null, undefined);
		expect(lines.find((l) => l.key === "guardrails.unmanaged")!.text).toBe(
			"codex rules not managed here",
		);
	});

	it("SUDO_RE matches a sudo invocation, not a lookalike word", () => {
		expect(SUDO_RE.test("sudo -n x")).toBe(true);
		expect(SUDO_RE.test("pseudo random")).toBe(false);
	});

	it("attached-nowhere + runs-sudo hook lines, and NO reach line ever", () => {
		const reg = baseRegistry();
		const hooks: HookRow[] = [
			{
				name: "audit-bash",
				provenance: "user",
				event: "PreToolUse",
				command: "sudo -n journalctl -n 1",
				description: "",
				tools: [],
				matcher: "",
				timeout: null,
				harnesses: null,
				settings: {},
				attached_global: false,
				attached_projects: [],
			},
		];
		const { lines } = guardrailsInsights(reg, null, hooks);
		expect(lines.map((line) => line.key)).not.toContain("guardrails.hookNowhere");
		expect(lines.find((l) => l.key === "guardrails.hookSudo")!.text).toBe(
			"audit-bash runs sudo",
		);
		expect(lines.some((l) => l.text.toLowerCase().includes("reach"))).toBe(false);
		const mark = hookRowMark(hooks[0]);
		expect(mark.dot).toBe("error");
	});

	it("doctor + stream-failed lines", () => {
		const reg = baseRegistry();
		const env = envelope({
			global: {
				skipped: [],
				skills: { writes: 0, removed: 0 },
				mcp: { writes: 0, removed: 0 },
				permissions: { ok: false, errors: [] },
				hooks: { ok: false, errors: [] },
				doctor: { ok: false, errors: [{ stage: "doctor", message: "x" }] },
				remotes: { attempted: 0, alarming: 0 },
			},
		});
		const { lines } = guardrailsInsights(reg, env, undefined);
		expect(lines.find((l) => l.key === "guardrails.doctor")!.text).toBe(
			"1 permission risks reported",
		);
		expect(lines.some((l) => l.key === "guardrails.permissionsStreamFailed")).toBe(true);
		expect(lines.some((l) => l.key === "guardrails.hooksStreamFailed")).toBe(true);
	});
});

// ─── Agents ─────────────────────────────────────────────────────────────────

describe("agentsInsights", () => {
	it("HARNESSES tile reads N/M", () => {
		const harnesses = [
			harness({ id: "claude-code", installed: true, on_globally: true }),
			harness({ id: "codex", installed: true, on_globally: false }),
			harness({ id: "pi", installed: false, on_globally: false }),
			harness({ id: "opencode", installed: false, on_globally: false }),
		];
		const { tiles } = agentsInsights(harnesses, { snapshot: null, isError: false }, {});
		expect(tiles[0].value).toBe("2/4");
		expect(tiles[0].sub).toBe("1 on globally");
	});

	it("USAGE tile compacts a real corpus's token count and keeps the exact figure in the title", () => {
		const snapshot = {
			overview: { totalTokens: 29_492_592_142, estimatedCost: { usd: 6921.07 } },
			scannedAt: new Date().toISOString(),
		} as unknown as NonNullable<Parameters<typeof agentsInsights>[1]["snapshot"]>;
		const { tiles } = agentsInsights([], { snapshot, isError: false }, {});
		expect(tiles[1].value).toBe("29.5B");
		expect(tiles[1].title).toContain("29,492,592,142 tokens");
		const small = { ...snapshot, overview: { ...snapshot.overview, totalTokens: 845 } };
		expect(agentsInsights([], { snapshot: small, isError: false }, {}).tiles[1].value).toBe("845");
	});

	it("USAGE tile rolls a near-unit token count up rather than printing a four-digit mantissa", () => {
		// 999,950 rounds to "1000.0k" under a per-unit round — the tile must
		// read "1M", matching the Usage screen's own formatCompact.
		const mk = (totalTokens: number) =>
			({
				overview: { totalTokens, estimatedCost: { usd: 1 } },
				scannedAt: new Date().toISOString(),
			}) as unknown as NonNullable<Parameters<typeof agentsInsights>[1]["snapshot"]>;
		expect(agentsInsights([], { snapshot: mk(999_950), isError: false }, {}).tiles[1].value).toBe("1M");
		expect(agentsInsights([], { snapshot: mk(999_949), isError: false }, {}).tiles[1].value).toBe("999.9k");
		expect(agentsInsights([], { snapshot: mk(1_000), isError: false }, {}).tiles[1].value).toBe("1k");
	});

	it("USAGE tile's cost uses the same narrowSymbol rule as the Usage screen", () => {
		const snapshot = {
			overview: { totalTokens: 10, estimatedCost: { usd: 6921.07 } },
			scannedAt: new Date().toISOString(),
		} as unknown as NonNullable<Parameters<typeof agentsInsights>[1]["snapshot"]>;
		const sub = agentsInsights([], { snapshot, isError: false }, {}).tiles[1].sub;
		// Under a locale that disambiguates USD the default display is "US$";
		// the panel tile and the screen must never print the figure two ways.
		expect(sub).not.toContain("US$");
		expect(sub).toContain("$");
	});

	it("no-harness-on-globally fires only when the store is non-empty", () => {
		const harnesses = [harness({ installed: true, on_globally: false })];
		const { lines } = agentsInsights(harnesses, { snapshot: null, isError: false }, {});
		expect(lines.map((line) => line.key)).not.toContain("agents.noHarnessGlobal");
		const empty = agentsInsights([], { snapshot: null, isError: false }, {});
		expect(empty.lines.map((line) => line.key)).not.toContain("agents.noHarnessGlobal");
	});

	it("on-but-not-installed line", () => {
		const harnesses = [
			harness({ id: "claude-code", installed: true, on_globally: true }),
			harness({ id: "opencode", label: "opencode", installed: false, on_globally: true }),
		];
		const { lines } = agentsInsights(harnesses, { snapshot: null, isError: false }, {});
		const line = lines.find((l) => l.key === "agents.onNotInstalled")!;
		expect(line.text).toBe("opencode enabled but not installed");
		expect(line.explanation.affected[0]?.action?.href).toBe("/harnesses");
	});

	it("invalid + twin_lost sub-agents are counted", () => {
		const harnesses = [
			harness({
				id: "claude-code",
				installed: true,
				on_globally: true,
				agents: { supported: true, format: "md", agents_dir: "~/.claude/agents", project_agents_dir: null },
			}),
		];
		const subagentsByHarness = {
			"claude-code": [
				{ name: "Bad Name", valid: false } as never,
				{ name: "twin-agent", valid: true, link: { linked: true, harnesses: [], twin_lost: true, suggested: false } } as never,
				{ name: "fine-agent", valid: true } as never,
			],
		};
		const { lines } = agentsInsights(
			harnesses,
			{ snapshot: null, isError: false },
			subagentsByHarness,
		);
		const line = lines.find((l) => l.key === "agents.invalidSubagent")!;
		expect(line.text).toBe("2 sub-agent definitions to review");
	});

	it("usage tile: no scan yet / scan failed", () => {
		const noScan = agentsInsights([], { snapshot: null, isError: false }, {});
		expect(noScan.tiles[1].value).toBe("—");
		expect(noScan.tiles[1].sub).toBe("no scan yet");
		const failed = agentsInsights([], { snapshot: null, isError: true }, {});
		expect(failed.tiles[1].sub).toBe("scan failed");
		expect(failed.lines.some((l) => l.key === "agents.usageScanFailed")).toBe(true);
	});

	it("formatUsd renders a currency string", () => {
		expect(formatUsd(12.4)).toContain("12.40");
	});

	it("harness row mark: not-installed hint (the health dot is AgentsBody's own — n-2)", () => {
		const mark = harnessRowMark(harness({ id: "opencode", installed: false, on_globally: true }));
		expect(mark.hint).toBe("not installed");
		expect(mark.dot).toBeUndefined();
	});
});

// ─── Elsewhere ──────────────────────────────────────────────────────────────

describe("elsewhereInsights", () => {
	it("source dot precedence: a disabled+up-to-date source reads never/off/dim (bug fix)", () => {
		const mark = sourceRowMark({ name: "Legacy", status: "up-to-date", enabled: false });
		expect(mark.dot).toBe("never");
		expect(mark.hint).toBe("off");
		expect(mark.dim).toBe(true);
	});

	it("update/error lines name the source by its DISPLAY NAME, link by id (m-1)", () => {
		const reg = baseRegistry({
			sources: {
				zeta: { type: "git", name: "Zeta", url: "u", status: "update-available" },
				alpha: { type: "git", name: "Zeta", url: "u", status: "update-available" },
				broken: { type: "git", name: "Broken", url: "u", status: "error", error: "boom" },
			},
		});
		const { lines } = elsewhereInsights(reg, null, undefined);
		const update = lines.find((l) => l.key === "elsewhere.sourceUpdate")!;
		// Sorted by NAME ("Zeta" < "Zeta"), not by id — the offender is what the
		// row itself displays.
		expect(update.explanation.affected.map((item) => item.label)).toEqual(["Zeta", "Zeta"]);
		expect(update.explanation.affected.map((item) => item.action?.href)).toEqual([
			"/sources?focus=zeta",
			"/sources?focus=alpha",
		]);
		const failing = lines.find((l) => l.key === "elsewhere.sourceFailing")!;
		expect(failing.text).toBe("Broken update failed");
		expect(failing.explanation.affected[0]?.action?.href).toBe("/sources?focus=broken");
	});

	it("n-4: a disabled source's failing status does not alarm either line", () => {
		const reg = baseRegistry({
			sources: {
				quiet: {
					type: "git",
					name: "Quiet",
					url: "u",
					status: "error",
					error: "boom",
					enabled: false,
				},
			},
		});
		const { lines } = elsewhereInsights(reg, null, undefined);
		expect(lines.some((l) => l.key === "elsewhere.sourceFailing")).toBe(false);
	});

	it("remote sync-off row mark", () => {
		const mark = remoteRowMark("worker-pool", "hermes", false);
		expect(mark.hint).toBe("sync off");
		expect(mark.dim).toBe(true);
	});

	it("cloud unshippable: mcp servers and unknown names both drop", () => {
		const reg = baseRegistry({
			skills: {
				"fs-mcp": {
					version: "1",
					description: "x",
					source: "s",
					type: "mcp-server",
					scope: "global",
					upstream: null,
				},
			},
			cloud: { "claude-ai": { bundles: [], enabled: ["fs-mcp", "ghost-skill"] } },
		});
		const { lines } = elsewhereInsights(reg, null, undefined);
		const line = lines.find((l) => l.key === "elsewhere.cloudUnexportable")!;
		expect(line.text).toBe("2 cloud selections excluded");
		expect(line.explanation.affected[0]?.action?.href).toBe("/cloud/claude-ai");
		const mark = cloudRowMark("claude-ai", 2);
		expect(mark.hint).toBe("2 unshippable");
	});

	it("backup tile: undefined -> checking, null -> not set up", () => {
		const checking = elsewhereInsights(baseRegistry(), null, undefined);
		expect(checking.tiles[0].value).toBe("—");
		expect(checking.tiles[0].sub).toBe("checking");
		const notConfigured = elsewhereInsights(baseRegistry(), null, null);
		expect(notConfigured.tiles[0].value).toBe("not set up");
	});

	it("backup tile: a configured fixture reads its health short label", () => {
		const status: BackupStatus = {
			enabled: true,
			initialized: true,
			configured: true,
			dir: "~/.skill-hub-backup",
			remote: "origin",
			repo: "me/backup",
			branch: "main",
			auth: {
				configured: "gh",
				pat_available: true,
				pat_detail: "",
				gh_login: "me",
				gh_active_login: "me",
				gh_account_mismatch: false,
			},
			push_failures: 0,
			last_push_error: null,
			pending_reconcile: false,
			last_commit: { sha: "abc", ts: "2026-07-05T14:00:00Z", subject: "snapshot" },
			ahead: 0,
			behind: 0,
			drift: "in-sync",
			manifest: null,
			warnings: [],
		};
		const { tiles } = elsewhereInsights(baseRegistry(), null, status);
		expect(tiles[0].value).not.toBe("—");
		expect(tiles[0].sub).not.toBe("checking");
	});

	it("B4: REMOTE SYNC reads —/auto-sync when the pass was skipped", () => {
		const env = envelope({
			global: {
				skipped: ["remotes"],
				skills: { writes: 0, removed: 0 },
				mcp: { writes: 0, removed: 0 },
				permissions: { ok: true, errors: [] },
				remotes: { attempted: 0, alarming: 0 },
			},
		});
		const { tiles } = elsewhereInsights(baseRegistry(), env, undefined);
		expect(tiles[1].value).toBe("—");
		expect(tiles[1].sub).toBe("auto-sync");
	});

	it("REMOTE SYNC reads N pushed with an alarming sub tone", () => {
		const env = envelope({
			global: {
				skipped: [],
				skills: { writes: 0, removed: 0 },
				mcp: { writes: 0, removed: 0 },
				permissions: { ok: true, errors: [] },
				remotes: { attempted: 2, alarming: 1 },
			},
		});
		const { tiles, lines } = elsewhereInsights(baseRegistry(), env, undefined);
		expect(tiles[1].value).toBe("2 pushed");
		expect(tiles[1].sub).toBe("1 alarming");
		expect(tiles[1].subTone).toBe("error");
		expect(lines.some((l) => l.key === "elsewhere.remotesAlarmed")).toBe(true);
	});
});

describe("attention explanation contract", () => {
	it("keeps every affected item reachable and explains the recorded condition", () => {
		const groups: NavGroupInsights[] = [
			projectsInsights(mockRegistry, mockSyncEnvelope as unknown as SyncReportEnvelope, [harness()]),
			contextInsights(mockRegistry, undefined),
			guardrailsInsights(mockRegistry, mockSyncEnvelope as unknown as SyncReportEnvelope, []),
			agentsInsights([harness()], { snapshot: null, isError: true }, {}),
			elsewhereInsights(mockRegistry, mockSyncEnvelope as unknown as SyncReportEnvelope, null),
		];
		for (const group of groups) {
			for (const line of group.lines) {
				expect(line.explanation.happened.length).toBeGreaterThan(0);
				expect(line.explanation.impact.length).toBeGreaterThan(0);
				expect(line.explanation.nextStep.length).toBeGreaterThan(0);
				expect(line.explanation.affected.length).toBeGreaterThan(0);
				for (const item of line.explanation.affected) {
					expect(item.id.length).toBeGreaterThan(0);
					expect(item.action?.href || line.explanation.action?.href).toBeTruthy();
				}
			}
		}
	});

	it("keeps duplicate display names distinct by item id", () => {
		const reg = baseRegistry({
			sources: {
				first: { type: "git", name: "Same", url: "u", status: "update-available" },
				second: { type: "git", name: "Same", url: "v", status: "update-available" },
			},
		});
		const line = elsewhereInsights(reg, null, undefined).lines.find((item) => item.key === "elsewhere.sourceUpdate")!;
		expect(line.explanation.affected.map((item) => item.id)).toEqual(["first", "second"]);
		expect(new Set(line.explanation.affected.map((item) => item.action?.href)).size).toBe(2);
	});
});

// ─── Fixture length guard (§8.1) ────────────────────────────────────────────

describe("fixture length guard", () => {
	it("every tile value/sub and line text stay inside the panel's budget — minimal fixtures", () => {
		const groups: NavGroupInsights[] = [
			projectsInsights(
				baseRegistry({ projects: { "example-app": { path: "/e", bundles: [], enabled: [] } } }),
				envelope(),
				[harness()],
			),
			contextInsights(baseRegistry(), []),
			guardrailsInsights(baseRegistry({ permissions_global: { allow: [], deny: [], ask: [] } }), envelope(), []),
			agentsInsights([harness()], { snapshot: null, isError: false }, {}),
			elsewhereInsights(baseRegistry(), envelope(), null),
		];
		for (const group of groups) {
			for (const tile of group.tiles) {
				expect(tile.value.length).toBeLessThanOrEqual(12);
				expect(tile.sub.length).toBeLessThanOrEqual(15);
			}
			for (const line of group.lines) {
			expect(line.text.length).toBeLessThanOrEqual(60);
			}
		}
	});

	// m-5: the pass above uses hand-built minimal fixtures that emit zero or
	// near-zero attention lines, so `text.length <= 34` was never actually
	// exercised. This pass runs the SAME five functions over the real mock
	// registry + default envelope (`mocks/tauriCore.ts`, exported for this) plus
	// every §7.3 attention-flag mutation applied at once — the worst case a
	// real scene can produce.
	it("every tile value/sub and line text stay inside the panel's budget — the mock registry + default envelope + §7.3 attention states", () => {
		const attnRegistry: Registry = structuredClone(mockRegistry);
		// `?contextAttention=1`
		attnRegistry.skills["ds-tokens"] = {
			version: "1",
			description: "x".repeat(230),
			source: "design-system",
			type: "claude-skill",
			scope: "portable",
			upstream: null,
			managed: "external",
			origin: { source: "design-system" },
			source_missing: true,
		};
		attnRegistry.bundles["legacy-tools"] = {
			description: "Legacy tooling kept for one holdout project.",
			icon: "🧱",
			scope: "project-specific",
			skills: ["brainstorm", "retired-skill"],
		};
		// `?guardrailsAttention=1`
		attnRegistry.permissions_global = {
			...attnRegistry.permissions_global,
			_unmanaged: ["codex"],
			approval_policy: "never",
			sandbox_mode: "danger-full-access",
		};

		const attnEnvelope = structuredClone(mockSyncEnvelope) as unknown as SyncReportEnvelope;
		// `?syncError=1`-shaped project + doctor findings.
		attnEnvelope.report.projects["moon-base"] = {
			...attnEnvelope.report.projects["moon-base"],
			skipped_unowned: 2,
			missing_refs: [{ skill: "rt-android-expert", refs: ["needs-global"] }],
		};
		attnEnvelope.report.global.doctor = {
			ok: false,
			errors: [{ stage: "doctor", message: "UNBOUNDED_BASH: Bash(*) is allowed globally" }],
		};
		// `?elsewhereAttention=1`
		attnEnvelope.report.global.remotes = { attempted: 2, alarming: 1 };

		// `?hooksAttention=1`
		const hooks: HookRow[] = [
			{
				name: "audit-bash",
				provenance: "user",
				event: "PreToolUse",
				command: "sudo -n journalctl -n 1",
				description: "",
				tools: [],
				matcher: "",
				timeout: null,
				harnesses: null,
				settings: {},
				attached_global: false,
				attached_projects: [],
			},
		];

		// `?agentsAttention=1`
		const harnesses = [
			harness(),
			harness({ id: "opencode", label: "opencode", installed: false, on_globally: true }),
		];
		const subagentsByHarness = {
			"claude-code": [{ name: "Bad Name", valid: false } as never],
		};

		const snippets: SnippetInfo[] = [
			{
				name: "orphaned-note",
				description: "A note that outlived its skill.",
				tags: [],
				version: 2,
				created: "2026-01-01T00:00:00Z",
				updated: "2026-01-02T00:00:00Z",
				hash: "abc123",
				usage: { count: 1, summary: "outdated", outdated_count: 1 },
			},
		];

		const backupStatus: BackupStatus = {
			enabled: true,
			initialized: true,
			configured: true,
			dir: "~/.skill-hub-backup",
			remote: "origin",
			repo: "me/backup",
			branch: "main",
			auth: {
				configured: "gh",
				pat_available: true,
				pat_detail: "",
				gh_login: "me",
				gh_active_login: "me",
				gh_account_mismatch: false,
			},
			push_failures: 0,
			last_push_error: null,
			// `pending_reconcile: true` → `health.cause === "paused"` (§7.3's
			// `?backupPending=1`).
			pending_reconcile: true,
			last_commit: { sha: "abc", ts: "2026-07-05T14:00:00Z", subject: "snapshot" },
			ahead: 0,
			behind: 0,
			drift: "in-sync",
			manifest: null,
			warnings: [],
		};

		const groups: NavGroupInsights[] = [
			projectsInsights(attnRegistry, attnEnvelope, harnesses),
			contextInsights(attnRegistry, snippets),
			guardrailsInsights(attnRegistry, attnEnvelope, hooks),
			agentsInsights(harnesses, { snapshot: null, isError: true }, subagentsByHarness),
			elsewhereInsights(attnRegistry, attnEnvelope, backupStatus),
		];
		for (const group of groups) {
			for (const tile of group.tiles) {
				expect(tile.value.length).toBeLessThanOrEqual(12);
				expect(tile.sub.length).toBeLessThanOrEqual(15);
			}
			for (const line of group.lines) {
		expect(line.text.length).toBeLessThanOrEqual(60);
			}
		}
	});
});


describe("aggregate identities and evidence", () => {
  it("keeps the same skill on two projects, including harness and reference evidence", () => {
    const reg = baseRegistry({ projects: {
      "one / project": { path: "/one", enabled: [], bundles: [] },
      two: { path: "/two", enabled: [], bundles: [] },
    } });
    const record = { ts: "t", ok: true, errors: [], writes: 0, removed: 0,
      affinity_skips: [{ skill: "same", skill_harnesses: ["codex"], project_harnesses: ["claude-code"] }],
      missing_refs: [{ skill: "same", refs: ["first", "second"] }, { skill: "another", refs: ["third"] }],
    };
    const result = projectsInsights(reg, envelope({ projects: { "one / project": record, two: record } }), []);
    const skips = result.lines.find((line) => line.key === "projects.affinitySkip")!.explanation.affected;
    expect(new Set(skips.map((item) => item.id)).size).toBe(2);
    expect(skips.map((item) => item.action?.href)).toEqual(["/project/one%20%2F%20project?tab=loadout", "/project/two?tab=loadout"]);
    expect(skips[0].detail).toContain("Skill supports: codex");
    const refs = result.lines.find((line) => line.key === "projects.missingRefs")!.explanation;
    expect(refs.happened).toContain("not equipped");
    expect(refs.affected).toHaveLength(4);
    expect(new Set(refs.affected.map((item) => item.id)).size).toBe(4);
    expect(refs.affected.map((item) => item.detail)).toEqual(["same needs: first, second", "another needs: third", "same needs: first, second", "another needs: third"]);
  });

  it("keeps identical sub-agent names in separate harnesses and selects each agent", () => {
    const hs = ["claude-code", "codex"].map((id) => harness({ id, label: id, installed: true, on_globally: true, agents: { supported: true, format: "md", agents_dir: "/agents", project_agents_dir: null } }));
    const result = agentsInsights(hs, { snapshot: null, isError: false }, {
      "claude-code": [{ name: "same / name", valid: false } as never],
      codex: [{ name: "same / name", valid: true, link: { twin_lost: true } } as never],
    });
    const items = result.lines[0].explanation.affected;
    expect(new Set(items.map((item) => item.id)).size).toBe(2);
    expect(items.map((item) => item.action?.href)).toEqual(["/harness/claude-code?agent=same%20%2F%20name", "/harness/codex?agent=same%20%2F%20name"]);
    expect(items[0].detail).toBe("Invalid definition");
    expect(items[1].detail).toBe("Linked copy is missing");
  });

  it("keeps the same excluded cloud skill on both targets", () => {
    const reg = baseRegistry({ cloud: { "claude-ai": { enabled: ["missing"] }, chatgpt: { enabled: ["missing"] } } });
    const items = elsewhereInsights(reg, null, null).lines.find((line) => line.key === "elsewhere.cloudUnexportable")!.explanation.affected;
    expect(items).toHaveLength(2);
    expect(new Set(items.map((item) => item.id)).size).toBe(2);
    expect(new Set(items.map((item) => item.action?.href)).size).toBe(2);
  });

  it("keeps usage observations and every review destination, but excludes stale findings", () => {
    const cache = { last_scan_at: "2026-09-10T12:00:00Z", findings: [
      { id: "finding/one", project: "one", observation: "One skill was never used.", moves: [{ label: "Unequip the unused skill" }], review: { project: "one", area: "loadout" } },
      { id: "finding/two", project: "two", observation: "Instructions repeat each other.", review: { project: "two", area: "agent-docs" } },
    ] };
    const now = Date.parse("2026-09-10T13:00:00Z");
    const line = projectsInsights(baseRegistry(), null, [], cache, now).lines[0];
    expect(line.text).toBe("2 usage suggestions to review");
    expect(line.explanation.affected[0].detail).toBe("One skill was never used.\nSuggested change: Unequip the unused skill");
    expect(line.explanation.affected[1].detail).toBe(cache.findings[1].observation);
    expect(line.explanation.affected[1].action?.href).toBe("/project/two?tab=agent-docs&review=finding%2Ftwo");
    expect(projectsInsights(baseRegistry(), null, [], cache, now + 8 * 86400000).lines).toHaveLength(0);
  });
});

 it("includes invalid sub-agents from a harness enabled only by a project", () => {
    const h = harness({ installed: true, on_globally: false, used_by_projects: ["moon-base"], agents: { supported: true, format: "md", agents_dir: "/agents", project_agents_dir: null } });
    const result = agentsInsights([h], { snapshot: null, isError: false }, { [h.id]: [{ name: "broken", valid: false } as never] });
    expect(result.lines.find((line) => line.key === "agents.invalidSubagent")?.explanation.affected[0].label).toContain("broken");
  });
