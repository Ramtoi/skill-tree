import { describe, it, expect } from "vitest";
import {
	classifySyncFailure,
	groupedSyncErrors,
	projectFreshness,
	projectRecord,
	freshnessLabel,
	type SyncReportEnvelope,
} from "@/lib/syncFreshness";

function envelope(over: {
	reportSha: string;
	currentSha: string;
	projects: SyncReportEnvelope["report"]["projects"];
}): SyncReportEnvelope {
	return {
		report: {
			schema_version: 1,
			generated_at: "2026-07-05T14:32:10Z",
			registry_sha256: over.reportSha,
			registry_mtime: 1,
			ok: true,
			global: {
				skipped: [],
				skills: { writes: 0, removed: 0 },
				mcp: { writes: 0, removed: 0 },
				permissions: { ok: true, errors: [] },
				remotes: { attempted: 0, alarming: 0 },
			},
			projects: over.projects,
		},
		registry_current: { sha256: over.currentSha, mtime: 2 },
	};
}

const okRecord = {
	ts: "2026-07-05T14:32:10Z",
	ok: true,
	errors: [],
	writes: 3,
	removed: 0,
	affinity_skips: [],
};

describe("projectFreshness state machine (D4)", () => {
	it("unknown when there is no envelope", () => {
		expect(projectFreshness("p", null)).toBe("unknown");
		expect(projectFreshness("p", undefined)).toBe("unknown");
	});

	it("unknown when the project is absent from the report", () => {
		const env = envelope({ reportSha: "a", currentSha: "a", projects: {} });
		expect(projectFreshness("p", env)).toBe("unknown");
	});

	it("fresh when synced ok and the registry sha is unchanged", () => {
		const env = envelope({
			reportSha: "abc",
			currentSha: "abc",
			projects: { p: okRecord },
		});
		expect(projectFreshness("p", env)).toBe("fresh");
	});

	it("stale when the registry sha changed since the sync", () => {
		const env = envelope({
			reportSha: "old",
			currentSha: "new",
			projects: { p: okRecord },
		});
		expect(projectFreshness("p", env)).toBe("stale");
	});

	it("error takes precedence over sha comparison when ok is false", () => {
		const env = envelope({
			reportSha: "old",
			currentSha: "new",
			projects: {
				p: {
					...okRecord,
					ok: false,
					errors: [{ stage: "symlink", message: "boom" }],
				},
			},
		});
		expect(projectFreshness("p", env)).toBe("error");
	});

	it("projectRecord returns the record or null", () => {
		const env = envelope({
			reportSha: "a",
			currentSha: "a",
			projects: { p: okRecord },
		});
		expect(projectRecord("p", env)?.writes).toBe(3);
		expect(projectRecord("missing", env)).toBeNull();
		expect(projectRecord("p", null)).toBeNull();
	});

	it("every state has a non-empty label", () => {
		for (const s of ["fresh", "stale", "unknown", "error", "quarantined"] as const) {
			expect(freshnessLabel(s).length).toBeGreaterThan(0);
		}
	});

	// F1: a quarantined project must never read as "fresh"/"in sync" — the
	// backend keeps `ok: true` on a quarantined record deliberately (skipping
	// it is expected, not a failure), so a reader that only checks `ok` and
	// the registry sha would wrongly call it "fresh".
	it("quarantined when the sync report record says so, even with ok: true and a matching sha", () => {
		const env = envelope({
			reportSha: "abc",
			currentSha: "abc",
			projects: { p: { ...okRecord, ok: true, quarantined: "path_unresolved (restored from a backup)" } },
		});
		expect(projectFreshness("p", env)).toBe("quarantined");
	});

	it("quarantined takes precedence over a recorded error", () => {
		const env = envelope({
			reportSha: "abc",
			currentSha: "abc",
			projects: {
				p: { ...okRecord, ok: false, errors: [{ stage: "x", message: "boom" }], quarantined: "no path recorded" },
			},
		});
		expect(projectFreshness("p", env)).toBe("quarantined");
	});

	it("quarantined from the LIVE registry's path_unresolved even when the report predates the field (stale/legacy report)", () => {
		// The report has no `quarantined` field at all and says `ok: true` — an
		// older backend, or a report written before this project went stale.
		const env = envelope({ reportSha: "abc", currentSha: "abc", projects: { p: okRecord } });
		expect(projectFreshness("p", env, { path_unresolved: true })).toBe("quarantined");
	});

	it("quarantined even with no envelope at all, from the live registry alone", () => {
		expect(projectFreshness("p", null, { path_unresolved: true })).toBe("quarantined");
	});

	it("not quarantined when path_unresolved is absent/false", () => {
		const env = envelope({ reportSha: "abc", currentSha: "abc", projects: { p: okRecord } });
		expect(projectFreshness("p", env, { path_unresolved: false })).toBe("fresh");
		expect(projectFreshness("p", env, {})).toBe("fresh");
	});

	// Recovery attach regression: a project WAS quarantined, the user attached
	// a directory (live `path_unresolved` now false, registry sha bumped by
	// that mutation), but no sync has run since — the report on hand still
	// carries the OLD "quarantined" verdict. That old verdict is stale
	// evidence, not a live "still unattached" claim: reading it as
	// `quarantined` here would re-show "No local directory attached" right
	// after the user just fixed that. The honest read is "needs a re-sync".
	it("stale, not quarantined, when a since-run recovery attached the project but the held report predates it", () => {
		const env = envelope({
			reportSha: "before-attach",
			currentSha: "after-attach",
			projects: { p: { ...okRecord, ok: true, quarantined: "path_unresolved (restored from a backup)" } },
		});
		expect(projectFreshness("p", env, { path_unresolved: false })).toBe("stale");
	});

	// Live precedence still holds: if the directory is NOT yet attached, an
	// old held report changes nothing — still quarantined, stale or not.
	it("still quarantined when path_unresolved is live-true, even against a stale report", () => {
		const env = envelope({
			reportSha: "before-attach",
			currentSha: "after-attach",
			projects: { p: { ...okRecord, ok: true, quarantined: "path_unresolved (restored from a backup)" } },
		});
		expect(projectFreshness("p", env, { path_unresolved: true })).toBe("quarantined");
	});

	it("requires a new sync to recheck an old missing-path report without a live quarantine flag", () => {
		const env = envelope({
			reportSha: "old", currentSha: "changed",
			projects: { p: { ...okRecord, quarantined: "path does not exist: /gone" } },
		});
		expect(projectFreshness("p", env, {})).toBe("stale");
	});

	// A fresh (non-stale) report's own quarantine verdict is still trusted as
	// long as nothing live contradicts it — the common case (no recovery run
	// yet, sha unchanged since the quarantined sync).
	it("quarantined from a non-stale report even without a live project fact to consult", () => {
		const env = envelope({
			reportSha: "same",
			currentSha: "same",
			projects: { p: { ...okRecord, ok: true, quarantined: "path_unresolved (restored from a backup)" } },
		});
		expect(projectFreshness("p", env)).toBe("quarantined");
	});

	// Additive backend contract: `skill_variants.py` now also sets
	// `outcome: "skipped"` / `skip_reason` alongside legacy `quarantined` —
	// either one alone must be recognized (forward/backward compatibility).
	it("quarantined from the additive outcome/skip_reason pair, without the legacy quarantined field", () => {
		const env = envelope({
			reportSha: "same",
			currentSha: "same",
			projects: { p: { ...okRecord, ok: true, outcome: "skipped", skip_reason: "no path recorded" } },
		});
		expect(projectFreshness("p", env)).toBe("quarantined");
	});

	it("quarantined from skip_reason alone", () => {
		const env = envelope({
			reportSha: "same",
			currentSha: "same",
			projects: { p: { ...okRecord, ok: true, skip_reason: "path does not exist" } },
		});
		expect(projectFreshness("p", env)).toBe("quarantined");
	});
});

describe("groupedSyncErrors (F3)", () => {
	it("groups a missing source's symlink + invocation stages into one root cause", () => {
		const errors = [
			{ stage: "symlink", message: "source missing: ~/.skill-hub/skills/diagnosing-bugs" },
			{ stage: "invocation", message: "source missing: ~/.skill-hub/skills/diagnosing-bugs", skill: "diagnosing-bugs", harnesses: ["claude-code"] },
			{ stage: "symlink", message: "source missing: ~/.skill-hub/skills/unslop" },
			{ stage: "invocation", message: "source missing: ~/.skill-hub/skills/unslop", skill: "unslop", harnesses: ["claude-code"] },
		];
		const groups = groupedSyncErrors(errors);
		expect(groups).toHaveLength(2);
		expect(groups[0].message).toBe("source missing: ~/.skill-hub/skills/diagnosing-bugs");
		expect(groups[0].stages).toHaveLength(2);
		expect(groups[0].stages.map((s) => s.stage)).toEqual(["symlink", "invocation"]);
		// Ten raw errors from five missing sources (A2) still reduce to five —
		// prove it holds at that scale, not just for two.
		const five = ["a", "b", "c", "d", "e"].flatMap((n) => [
			{ stage: "symlink", message: `source missing: ~/.skill-hub/skills/${n}` },
			{ stage: "invocation", message: `source missing: ~/.skill-hub/skills/${n}`, skill: n, harnesses: ["claude-code"] },
		]);
		expect(five).toHaveLength(10);
		expect(groupedSyncErrors(five)).toHaveLength(5);
	});

	it("keeps distinct messages as distinct groups, even with the same stage", () => {
		const errors = [
			{ stage: "symlink", message: "source missing: ~/a" },
			{ stage: "symlink", message: "source missing: ~/b" },
		];
		expect(groupedSyncErrors(errors)).toHaveLength(2);
	});

	it("returns an empty list for no errors", () => {
		expect(groupedSyncErrors([])).toEqual([]);
	});
});

describe("classifySyncFailure — doctor danger vs hard failure", () => {
	const NOW = Date.parse("2026-07-05T14:32:10Z");
	const fresh = (over: {
		doctorOk?: boolean;
		permsOk?: boolean;
		hooksOk?: boolean;
		projectOk?: boolean;
		generatedAt?: string;
	}): SyncReportEnvelope => {
		const env = envelope({
			reportSha: "a",
			currentSha: "a",
			projects: { p: { ...okRecord, ok: over.projectOk ?? true } },
		});
		env.report.generated_at = over.generatedAt ?? "2026-07-05T14:32:10Z";
		env.report.global.permissions.ok = over.permsOk ?? true;
		env.report.global.hooks = { ok: over.hooksOk ?? true, errors: [] };
		env.report.global.doctor = { ok: over.doctorOk ?? true, errors: [] };
		return env;
	};

	it("danger_only: fresh report, streams and projects ok, doctor not", () => {
		expect(classifySyncFailure(fresh({ doctorOk: false }), NOW)).toBe(
			"danger_only",
		);
	});

	it("hard_failure when a project recorded errors", () => {
		expect(
			classifySyncFailure(fresh({ doctorOk: false, projectOk: false }), NOW),
		).toBe("hard_failure");
	});

	it("hard_failure when the permissions stream failed", () => {
		expect(
			classifySyncFailure(fresh({ doctorOk: false, permsOk: false }), NOW),
		).toBe("hard_failure");
	});

	it("hard_failure when the report predates this run (stale report)", () => {
		expect(
			classifySyncFailure(
				fresh({ doctorOk: false, generatedAt: "2026-07-05T13:00:00Z" }),
				NOW,
			),
		).toBe("hard_failure");
	});

	it("hard_failure when the doctor slot is fine (some other cause)", () => {
		expect(classifySyncFailure(fresh({}), NOW)).toBe("hard_failure");
	});

	it("hard_failure on a missing envelope", () => {
		expect(classifySyncFailure(null, NOW)).toBe("hard_failure");
	});

	it("tolerates reports that predate the doctor slot (treated as hard)", () => {
		const env = envelope({ reportSha: "a", currentSha: "a", projects: {} });
		expect(classifySyncFailure(env, Date.parse(env.report.generated_at))).toBe(
			"hard_failure",
		);
	});
});
