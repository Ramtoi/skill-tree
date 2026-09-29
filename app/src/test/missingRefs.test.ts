import { describe, it, expect, vi } from "vitest";
import {
	announceMissingRefs,
	missingRefsIn,
	projectMissingRefs,
	skillMissesRefs,
	type RefsGuardrailDeps,
	type RefsGuardrailToastInput,
} from "@/lib/missingRefs";
import type { MissingRef, SyncReportEnvelope } from "@/lib/syncFreshness";

function envelopeWith(projects: Record<string, { missing_refs?: MissingRef[] }>): SyncReportEnvelope {
	return {
		report: {
			schema_version: 1,
			generated_at: "2026-09-04T00:00:00Z",
			registry_sha256: "abc",
			registry_mtime: 0,
			ok: true,
			global: {
				skipped: [],
				skills: { writes: 0, removed: 0 },
				mcp: { writes: 0, removed: 0 },
				permissions: { ok: true, errors: [] },
				remotes: { attempted: 0, alarming: 0 },
			},
			projects: Object.fromEntries(
				Object.entries(projects).map(([name, p]) => [
					name,
					{
						ts: "2026-09-04T00:00:00Z",
						ok: true,
						errors: [],
						writes: 0,
						removed: 0,
						affinity_skips: [],
						...p,
					},
				]),
			),
		},
		registry_current: { sha256: "abc", mtime: 0 },
	};
}

function makeDeps(overrides: Partial<RefsGuardrailDeps> = {}): {
	deps: RefsGuardrailDeps;
	pushed: RefsGuardrailToastInput[];
	equipCalls: Array<[string, string]>;
} {
	const pushed: RefsGuardrailToastInput[] = [];
	const equipCalls: Array<[string, string]> = [];
	const deps: RefsGuardrailDeps = {
		toast: { push: (t) => pushed.push(t) },
		equipRefs: vi.fn(async (skill: string, project: string) => {
			equipCalls.push([skill, project]);
		}),
		readEnv: vi.fn(async () => null),
		...overrides,
	};
	return { deps, pushed, equipCalls };
}

describe("missingRefs", () => {
	it("announces a toast when the fresh sync report lists missing_refs for the just-equipped skill", async () => {
		const env = envelopeWith({
			"moon-base": {
				missing_refs: [{ skill: "rt-android-expert", refs: ["needs-global", "proof-it"] }],
			},
		});
		const { deps, pushed } = makeDeps({ readEnv: vi.fn(async () => env) });

		const result = await announceMissingRefs(["rt-android-expert"], "moon-base", deps);

		expect(result).toEqual([{ skill: "rt-android-expert", refs: ["needs-global", "proof-it"] }]);
		expect(pushed).toHaveLength(1);
		const [toast] = pushed;
		expect(toast.kind).toBe("info");
		expect(toast.title).toBe("rt-android-expert references needs-global, proof-it");
		expect(toast.body).toBe("Not equipped on moon-base.");
		expect(toast.duration).toBe(8000);
		expect(toast.action?.label).toBe("Equip 2");
	});

	it("awaits readEnv before deciding", async () => {
		const env = envelopeWith({
			"moon-base": { missing_refs: [{ skill: "rt-android-expert", refs: ["needs-global"] }] },
		});
		let resolveEnv!: (v: SyncReportEnvelope) => void;
		const pending = new Promise<SyncReportEnvelope>((resolve) => {
			resolveEnv = resolve;
		});
		const { deps, pushed } = makeDeps({ readEnv: () => pending });

		const announced = announceMissingRefs(["rt-android-expert"], "moon-base", deps);
		await Promise.resolve();
		await Promise.resolve();
		expect(pushed).toHaveLength(0);

		resolveEnv(env);
		const result = await announced;

		expect(result).toHaveLength(1);
		expect(pushed).toHaveLength(1);
	});

	it("runs one enable --with-refs per flagged skill when the action fires", async () => {
		const env = envelopeWith({
			"moon-base": {
				missing_refs: [{ skill: "rt-android-expert", refs: ["needs-global", "proof-it"] }],
			},
		});
		const { deps, pushed, equipCalls } = makeDeps({ readEnv: vi.fn(async () => env) });

		await announceMissingRefs(["rt-android-expert"], "moon-base", deps);
		await pushed[0].action?.onClick();

		expect(equipCalls).toEqual([["rt-android-expert", "moon-base"]]);
	});

	it("emits one aggregate toast for several flagged skills", async () => {
		const env = envelopeWith({
			"moon-base": {
				missing_refs: [
					{ skill: "android", refs: ["needs-global", "proof-it"] },
					{ skill: "openspec", refs: ["proof-it", "unslop", "zzz-extra"] },
				],
			},
		});
		const { deps, pushed, equipCalls } = makeDeps({ readEnv: vi.fn(async () => env) });

		const result = await announceMissingRefs(["android", "openspec"], "moon-base", deps);

		expect(result).toHaveLength(2);
		expect(pushed).toHaveLength(1);
		const [toast] = pushed;
		expect(toast.title).toBe("2 skills reference 4 skills");
		expect(toast.body).toBe("needs-global, proof-it, unslop, +1 more · not equipped on moon-base");
		expect(toast.action?.label).toBe("Equip 4");

		await toast.action?.onClick();
		expect(equipCalls).toEqual([
			["android", "moon-base"],
			["openspec", "moon-base"],
		]);
	});

	it("singularizes the ref count when several flagged skills share one ref", async () => {
		const env = envelopeWith({
			"moon-base": {
				missing_refs: [
					{ skill: "android", refs: ["needs-global"] },
					{ skill: "openspec", refs: ["needs-global"] },
				],
			},
		});
		const { deps, pushed } = makeDeps({ readEnv: vi.fn(async () => env) });

		await announceMissingRefs(["android", "openspec"], "moon-base", deps);

		expect(pushed).toHaveLength(1);
		expect(pushed[0].title).toBe("2 skills reference 1 skill");
	});

	it("threads opts.subject into the multi-skill title (bundle apply)", async () => {
		const env = envelopeWith({
			"moon-base": {
				missing_refs: [
					{ skill: "android", refs: ["needs-global", "proof-it"] },
					{ skill: "openspec", refs: ["proof-it", "unslop"] },
				],
			},
		});
		const { deps, pushed } = makeDeps({ readEnv: vi.fn(async () => env) });

		await announceMissingRefs(["android", "openspec"], "moon-base", deps, { subject: "android" });

		expect(pushed).toHaveLength(1);
		expect(pushed[0].title).toBe("android references 3 skills");
		expect(pushed[0].body).toBe("needs-global, proof-it, unslop · not equipped on moon-base");
	});

	it("stays silent for a skill with no entry", async () => {
		const env = envelopeWith({
			"moon-base": { missing_refs: [{ skill: "rt-android-expert", refs: ["needs-global"] }] },
		});
		const { deps, pushed } = makeDeps({ readEnv: vi.fn(async () => env) });

		const result = await announceMissingRefs(["other-skill"], "moon-base", deps);

		expect(result).toEqual([]);
		expect(pushed).toHaveLength(0);
	});

	it("stays silent for a project with no record, an absent envelope, and a report predating the field", async () => {
		const noEnvelope = makeDeps({ readEnv: vi.fn(async () => null) });
		expect(await announceMissingRefs(["rt-android-expert"], "moon-base", noEnvelope.deps)).toEqual([]);
		expect(noEnvelope.pushed).toHaveLength(0);

		const env = envelopeWith({ "moon-base": { missing_refs: [] } });
		const unknownProject = makeDeps({ readEnv: vi.fn(async () => env) });
		expect(await announceMissingRefs(["rt-android-expert"], "other-project", unknownProject.deps)).toEqual([]);
		expect(unknownProject.pushed).toHaveLength(0);

		const envNoField = envelopeWith({ "moon-base": {} });
		const predating = makeDeps({ readEnv: vi.fn(async () => envNoField) });
		expect(await announceMissingRefs(["rt-android-expert"], "moon-base", predating.deps)).toEqual([]);
		expect(predating.pushed).toHaveLength(0);
	});

	it("names at most three refs and then +N more", async () => {
		const env = envelopeWith({
			"moon-base": {
				missing_refs: [
					{ skill: "rt-android-expert", refs: ["e", "d", "c", "b", "a"] },
				],
			},
		});
		const { deps, pushed } = makeDeps({ readEnv: vi.fn(async () => env) });

		await announceMissingRefs(["rt-android-expert"], "moon-base", deps);

		expect(pushed[0].title).toBe("rt-android-expert references a, b, c, +2 more");
		expect(pushed[0].action?.label).toBe("Equip 5");
	});

	it("skillMissesRefs is the Loadout badge predicate over a resolved record list", () => {
		const records: MissingRef[] = [{ skill: "rt-android-expert", refs: ["needs-global"] }];

		expect(skillMissesRefs(records, "rt-android-expert")).toBe(true);
		expect(skillMissesRefs(records, "other-skill")).toBe(false);
		expect(skillMissesRefs([], "rt-android-expert")).toBe(false);
		expect(missingRefsIn(records, "rt-android-expert")).toEqual(["needs-global"]);
	});

	it("projectMissingRefs returns every flagged pair for one project", () => {
		const env = envelopeWith({
			"moon-base": {
				missing_refs: [
					{ skill: "rt-android-expert", refs: ["needs-global"] },
					{ skill: "openspec", refs: ["proof-it"] },
				],
			},
			"clean-project": { missing_refs: [] },
		});

		expect(projectMissingRefs("moon-base", env)).toEqual([
			{ skill: "rt-android-expert", refs: ["needs-global"] },
			{ skill: "openspec", refs: ["proof-it"] },
		]);
		expect(projectMissingRefs("clean-project", env)).toEqual([]);
		expect(projectMissingRefs("unknown-project", env)).toEqual([]);
		expect(projectMissingRefs("moon-base", null)).toEqual([]);
	});
});
