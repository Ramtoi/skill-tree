import { describe, it, expect } from "vitest";
import {
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
		for (const s of ["fresh", "stale", "unknown", "error"] as const) {
			expect(freshnessLabel(s).length).toBeGreaterThan(0);
		}
	});
});
