import { describe, it, expect, beforeEach, vi } from "vitest";
import type {
	LocalAgentUsageSnapshot,
	UsageSessionRow,
	UsageTokenCounts,
} from "@/features/usage/usageTypes";
import {
	deriveProjectActivity,
	mergeActivity,
	orderProjects,
	readStoredActivity,
	storeActivity,
	PROJECT_ACTIVITY_KEY,
	type ProjectActivity,
} from "@/lib/projectActivity";

function zeroTokens(): UsageTokenCounts {
	return { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, total: 0 };
}

function zeroCost() {
	return { usd: 0, label: "Estimated API-equivalent cost" as const };
}

function makeSession(overrides: Partial<UsageSessionRow>): UsageSessionRow {
	return {
		id: "session-1",
		period: "session",
		harnessId: "claude",
		harnessName: "Claude Code",
		models: [],
		tokens: zeroTokens(),
		estimatedCost: zeroCost(),
		...overrides,
	};
}

function makeSnapshot(sessions: UsageSessionRow[]): LocalAgentUsageSnapshot {
	return {
		scannedAt: "2026-09-01T00:00:00Z",
		runner: { command: "ccusage", args: [], resolved_from: "path" },
		overview: {
			totalTokens: 0,
			estimatedCost: zeroCost(),
			sessions: sessions.length,
			harnessesDetected: 1,
			tokens: zeroTokens(),
			toolCalls: 0,
			cacheHitRate: 0,
			linesAdded: 0,
			linesRemoved: 0,
		},
		harnesses: [],
		detectedSources: [],
		daily: [],
		models: [],
		projects: [],
		sessions,
		privacy: {
			runsLocally: true,
			rawPromptsDisplayed: false,
			fullPathsHiddenByDefault: true,
			costCaveat: "Estimated API-equivalent cost; not an invoice or subscription usage.",
		},
	};
}

const PROJECTS = {
	alpha: { path: "/Users/dev/projects/alpha" },
	beta: { path: "/Users/dev/projects/beta" },
};

describe("deriveProjectActivity", () => {
	it("matches a session to a project by full path", () => {
		const snapshot = makeSnapshot([
			makeSession({
				harnessId: "claude",
				lastActivity: "2026-09-01T10:00:00Z",
				project: {
					label: "alpha",
					anonymized: true,
					fullPath: "/Users/dev/projects/alpha",
				},
			}),
		]);
		const activity = deriveProjectActivity(snapshot, PROJECTS);
		expect(activity.alpha?.last).toBe("2026-09-01T10:00:00Z");
	});

	it("tolerates a trailing slash on either side of the match", () => {
		const snapshot = makeSnapshot([
			makeSession({
				lastActivity: "2026-09-01T10:00:00Z",
				project: {
					label: "alpha",
					anonymized: true,
					fullPath: "/Users/dev/projects/alpha/",
				},
			}),
		]);
		const activity = deriveProjectActivity(snapshot, PROJECTS);
		expect(activity.alpha?.last).toBe("2026-09-01T10:00:00Z");
	});

	it("maps the usage harness id 'claude' to 'claude-code'", () => {
		const snapshot = makeSnapshot([
			makeSession({
				harnessId: "claude",
				lastActivity: "2026-09-01T10:00:00Z",
				project: {
					label: "alpha",
					anonymized: true,
					fullPath: "/Users/dev/projects/alpha",
				},
			}),
		]);
		const activity = deriveProjectActivity(snapshot, PROJECTS);
		expect(Object.keys(activity.alpha?.byHarness ?? {})).toEqual([
			"claude-code",
		]);
	});

	it("leaves a non-claude harness id unchanged", () => {
		const snapshot = makeSnapshot([
			makeSession({
				harnessId: "pi",
				lastActivity: "2026-09-01T10:00:00Z",
				project: {
					label: "alpha",
					anonymized: true,
					fullPath: "/Users/dev/projects/alpha",
				},
			}),
		]);
		const activity = deriveProjectActivity(snapshot, PROJECTS);
		expect(Object.keys(activity.alpha?.byHarness ?? {})).toEqual(["pi"]);
	});

	it("takes the max timestamp per harness across multiple sessions", () => {
		const snapshot = makeSnapshot([
			makeSession({
				harnessId: "claude",
				lastActivity: "2026-09-01T09:00:00Z",
				project: {
					label: "alpha",
					anonymized: true,
					fullPath: "/Users/dev/projects/alpha",
				},
			}),
			makeSession({
				harnessId: "claude",
				lastActivity: "2026-09-02T09:00:00Z",
				project: {
					label: "alpha",
					anonymized: true,
					fullPath: "/Users/dev/projects/alpha",
				},
			}),
		]);
		const activity = deriveProjectActivity(snapshot, PROJECTS);
		expect(activity.alpha?.byHarness["claude-code"]).toBe(
			"2026-09-02T09:00:00Z",
		);
		expect(activity.alpha?.last).toBe("2026-09-02T09:00:00Z");
	});

	it("falls back to startedAt when lastActivity is absent", () => {
		const snapshot = makeSnapshot([
			makeSession({
				startedAt: "2026-09-01T08:00:00Z",
				project: {
					label: "alpha",
					anonymized: true,
					fullPath: "/Users/dev/projects/alpha",
				},
			}),
		]);
		const activity = deriveProjectActivity(snapshot, PROJECTS);
		expect(activity.alpha?.last).toBe("2026-09-01T08:00:00Z");
	});

	it("ignores sessions without a project path", () => {
		const snapshot = makeSnapshot([
			makeSession({ lastActivity: "2026-09-01T10:00:00Z" }),
		]);
		const activity = deriveProjectActivity(snapshot, PROJECTS);
		expect(activity).toEqual({});
	});

	it("ignores a session whose path matches no registered project", () => {
		const snapshot = makeSnapshot([
			makeSession({
				lastActivity: "2026-09-01T10:00:00Z",
				project: {
					label: "elsewhere",
					anonymized: true,
					fullPath: "/Users/dev/projects/elsewhere",
				},
			}),
		]);
		const activity = deriveProjectActivity(snapshot, PROJECTS);
		expect(activity).toEqual({});
	});

	it("returns {} for a null snapshot", () => {
		expect(deriveProjectActivity(null, PROJECTS)).toEqual({});
	});
});

describe("mergeActivity", () => {
	it("keeps the later overall timestamp and unions per-harness entries", () => {
		const a: ProjectActivity = {
			alpha: {
				last: "2026-09-01T10:00:00Z",
				byHarness: { "claude-code": "2026-09-01T10:00:00Z" },
			},
		};
		const b: ProjectActivity = {
			alpha: {
				last: "2026-09-02T10:00:00Z",
				byHarness: { codex: "2026-09-02T10:00:00Z" },
			},
		};
		const merged = mergeActivity(a, b);
		expect(merged.alpha.last).toBe("2026-09-02T10:00:00Z");
		expect(merged.alpha.byHarness["claude-code"]).toBe(
			"2026-09-01T10:00:00Z",
		);
		expect(merged.alpha.byHarness.codex).toBe("2026-09-02T10:00:00Z");
	});

	it("keeps an entry present in only one side", () => {
		const a: ProjectActivity = {
			alpha: { last: "2026-09-01T10:00:00Z", byHarness: {} },
		};
		const merged = mergeActivity(a, {});
		expect(merged).toEqual(a);
	});
});

describe("orderProjects", () => {
	it("orders known-first by recency, then unknown alphabetically", () => {
		const activity: ProjectActivity = {
			gamma: {
				last: "2026-09-01T09:00:00Z",
				byHarness: { "claude-code": "2026-09-01T09:00:00Z" },
			},
			alpha: {
				last: "2026-09-02T09:00:00Z",
				byHarness: { "claude-code": "2026-09-02T09:00:00Z" },
			},
		};
		const { ordered, knownCount } = orderProjects(
			["zebra", "alpha", "beta", "gamma"],
			activity,
			"claude-code",
		);
		expect(ordered).toEqual(["alpha", "gamma", "beta", "zebra"]);
		expect(knownCount).toBe(2);
	});

	it("prefers the per-harness timestamp over the overall one", () => {
		const activity: ProjectActivity = {
			// alpha's OWN `last` is stale, but its claude-code entry is the most
			// recent of either project — proves the per-harness value wins.
			alpha: {
				last: "2026-09-01T09:00:00Z",
				byHarness: { "claude-code": "2026-09-10T09:00:00Z" },
			},
			// beta has no claude-code entry at all, so it falls back to `last`.
			beta: {
				last: "2026-09-05T09:00:00Z",
				byHarness: { codex: "2026-09-05T09:00:00Z" },
			},
		};
		const { ordered } = orderProjects(["alpha", "beta"], activity, "claude-code");
		expect(ordered).toEqual(["alpha", "beta"]);
	});

	it("names with no activity at all sort alphabetically, after every known one", () => {
		const { ordered, knownCount } = orderProjects(
			["zebra", "alpha"],
			{},
			"claude-code",
		);
		expect(ordered).toEqual(["alpha", "zebra"]);
		expect(knownCount).toBe(0);
	});
});

describe("stored activity round-trip", () => {
	beforeEach(() => {
		localStorage.clear();
	});

	it("round-trips through storeActivity/readStoredActivity", () => {
		const map: ProjectActivity = {
			alpha: {
				last: "2026-09-01T10:00:00Z",
				byHarness: { "claude-code": "2026-09-01T10:00:00Z" },
			},
		};
		storeActivity(map);
		expect(readStoredActivity()).toEqual(map);
	});

	it("returns {} for a corrupt stored value", () => {
		localStorage.setItem(PROJECT_ACTIVITY_KEY, "{not json");
		expect(readStoredActivity()).toEqual({});
	});

	it("returns {} for a wrongly-shaped stored value", () => {
		localStorage.setItem(
			PROJECT_ACTIVITY_KEY,
			JSON.stringify({ alpha: "not an object" }),
		);
		expect(readStoredActivity()).toEqual({});
	});

	it("returns {} when nothing is stored", () => {
		expect(readStoredActivity()).toEqual({});
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Adversarial coverage (wave A review).
// ─────────────────────────────────────────────────────────────────────────────

describe("deriveProjectActivity — adversarial", () => {
	it("ignores a session whose project ref carries no fullPath (redacted cache)", () => {
		const snapshot = makeSnapshot([
			makeSession({
				lastActivity: "2026-09-01T10:00:00Z",
				project: { label: "Project 1", anonymized: true, redactedPath: "…/alpha" },
			}),
		]);
		expect(deriveProjectActivity(snapshot, PROJECTS)).toEqual({});
	});

	it("matches nothing against a redacted `~/redacted/<hash>` path", () => {
		// The on-disk cache is path-redacted by the Rust side, so re-normalizing
		// it with includeFullPaths yields a fullPath that is itself the redacted
		// token. It must never accidentally match a registered project.
		const snapshot = makeSnapshot([
			makeSession({
				lastActivity: "2026-09-01T10:00:00Z",
				project: {
					label: "Project 1",
					anonymized: true,
					fullPath: "~/redacted/9f2c1a77b0e34d15",
				},
			}),
		]);
		expect(deriveProjectActivity(snapshot, PROJECTS)).toEqual({});
	});

	it("falls back to a parseable startedAt when lastActivity is junk", () => {
		const snapshot = makeSnapshot([
			makeSession({
				lastActivity: "Unknown date",
				startedAt: "2026-09-01T08:00:00Z",
				project: {
					label: "alpha",
					anonymized: true,
					fullPath: "/Users/dev/projects/alpha",
				},
			}),
		]);
		const activity = deriveProjectActivity(snapshot, PROJECTS);
		expect(activity.alpha?.last).toBe("2026-09-01T08:00:00Z");
	});

	it("skips a session whose timestamps are all unparseable", () => {
		const snapshot = makeSnapshot([
			makeSession({
				lastActivity: "Unknown date",
				startedAt: "also not a date",
				project: {
					label: "alpha",
					anonymized: true,
					fullPath: "/Users/dev/projects/alpha",
				},
			}),
		]);
		expect(deriveProjectActivity(snapshot, PROJECTS)).toEqual({});
	});

	it("tolerates a trailing slash on the REGISTRY side of the match", () => {
		const snapshot = makeSnapshot([
			makeSession({
				lastActivity: "2026-09-01T10:00:00Z",
				project: {
					label: "alpha",
					anonymized: true,
					fullPath: "/Users/dev/projects/alpha",
				},
			}),
		]);
		const activity = deriveProjectActivity(snapshot, {
			alpha: { path: "/Users/dev/projects/alpha/" },
		});
		expect(activity.alpha?.last).toBe("2026-09-01T10:00:00Z");
	});

	it("tracks two harnesses on one project: per-harness max AND overall max", () => {
		const snapshot = makeSnapshot([
			makeSession({
				harnessId: "claude",
				lastActivity: "2026-09-01T10:00:00Z",
				project: {
					label: "alpha",
					anonymized: true,
					fullPath: "/Users/dev/projects/alpha",
				},
			}),
			makeSession({
				harnessId: "claude",
				lastActivity: "2026-09-03T10:00:00Z",
				project: {
					label: "alpha",
					anonymized: true,
					fullPath: "/Users/dev/projects/alpha",
				},
			}),
			makeSession({
				harnessId: "pi",
				lastActivity: "2026-09-05T10:00:00Z",
				project: {
					label: "alpha",
					anonymized: true,
					fullPath: "/Users/dev/projects/alpha",
				},
			}),
			makeSession({
				harnessId: "pi",
				lastActivity: "2026-09-02T10:00:00Z",
				project: {
					label: "alpha",
					anonymized: true,
					fullPath: "/Users/dev/projects/alpha",
				},
			}),
		]);
		const activity = deriveProjectActivity(snapshot, PROJECTS);
		expect(activity.alpha?.byHarness["claude-code"]).toBe("2026-09-03T10:00:00Z");
		expect(activity.alpha?.byHarness.pi).toBe("2026-09-05T10:00:00Z");
		expect(activity.alpha?.last).toBe("2026-09-05T10:00:00Z");
	});

	it("returns {} when no project is registered", () => {
		const snapshot = makeSnapshot([
			makeSession({
				lastActivity: "2026-09-01T10:00:00Z",
				project: {
					label: "alpha",
					anonymized: true,
					fullPath: "/Users/dev/projects/alpha",
				},
			}),
		]);
		expect(deriveProjectActivity(snapshot, {})).toEqual({});
	});
});

describe("mergeActivity — adversarial", () => {
	it("keeps the newer side no matter which argument holds it", () => {
		const older: ProjectActivity = {
			alpha: {
				last: "2026-09-01T10:00:00Z",
				byHarness: { "claude-code": "2026-09-01T10:00:00Z" },
			},
		};
		const newer: ProjectActivity = {
			alpha: {
				last: "2026-09-09T10:00:00Z",
				byHarness: { "claude-code": "2026-09-09T10:00:00Z" },
			},
		};
		expect(mergeActivity(older, newer).alpha).toEqual(newer.alpha);
		expect(mergeActivity(newer, older).alpha).toEqual(newer.alpha);
	});

	it("a malformed timestamp loses to a valid one on either side", () => {
		const bad: ProjectActivity = {
			alpha: { last: "not a date", byHarness: { "claude-code": "nope" } },
		};
		const good: ProjectActivity = {
			alpha: {
				last: "2026-09-01T10:00:00Z",
				byHarness: { "claude-code": "2026-09-01T10:00:00Z" },
			},
		};
		expect(mergeActivity(bad, good).alpha).toEqual(good.alpha);
		expect(mergeActivity(good, bad).alpha).toEqual(good.alpha);
	});

	it("does not mutate either input", () => {
		const a: ProjectActivity = {
			alpha: { last: "2026-09-01T10:00:00Z", byHarness: { pi: "2026-09-01T10:00:00Z" } },
		};
		const b: ProjectActivity = {
			alpha: {
				last: "2026-09-02T10:00:00Z",
				byHarness: { "claude-code": "2026-09-02T10:00:00Z" },
			},
		};
		const snapshotA = JSON.stringify(a);
		const snapshotB = JSON.stringify(b);
		mergeActivity(a, b);
		expect(JSON.stringify(a)).toBe(snapshotA);
		expect(JSON.stringify(b)).toBe(snapshotB);
	});

	it("does not throw when an entry is missing byHarness entirely", () => {
		// Deliberately malformed: the shape a hand-edited localStorage value
		// could take. `as unknown as` because the type FORBIDS it — the point is
		// that the runtime must not throw when it shows up anyway.
		const broken = {
			alpha: { last: "2026-09-01T10:00:00Z" },
		} as unknown as ProjectActivity;
		const ok: ProjectActivity = {
			alpha: {
				last: "2026-09-02T10:00:00Z",
				byHarness: { "claude-code": "2026-09-02T10:00:00Z" },
			},
		};
		// BOTH directions: the b-side entry is the one whose byHarness is
		// iterated, so only `mergeActivity(ok, broken)` exercises that deref.
		expect(() => mergeActivity(broken, ok)).not.toThrow();
		expect(() => mergeActivity(ok, broken)).not.toThrow();
		expect(mergeActivity(broken, ok).alpha.byHarness["claude-code"]).toBe(
			"2026-09-02T10:00:00Z",
		);
		expect(mergeActivity(ok, broken).alpha.byHarness["claude-code"]).toBe(
			"2026-09-02T10:00:00Z",
		);
	});
});

describe("orderProjects — adversarial", () => {
	it("breaks an exact timestamp tie by name", () => {
		const ts = "2026-09-01T10:00:00Z";
		const activity: ProjectActivity = {
			zebra: { last: ts, byHarness: { "claude-code": ts } },
			alpha: { last: ts, byHarness: { "claude-code": ts } },
			mango: { last: ts, byHarness: { "claude-code": ts } },
		};
		const { ordered, knownCount } = orderProjects(
			["zebra", "mango", "alpha"],
			activity,
			"claude-code",
		);
		expect(ordered).toEqual(["alpha", "mango", "zebra"]);
		expect(knownCount).toBe(3);
	});

	it("falls back to `last` when the per-harness timestamp is malformed", () => {
		const activity: ProjectActivity = {
			alpha: {
				last: "2026-09-09T10:00:00Z",
				byHarness: { "claude-code": "garbage" },
			},
			beta: {
				last: "2026-09-01T10:00:00Z",
				byHarness: { "claude-code": "2026-09-01T10:00:00Z" },
			},
		};
		const { ordered, knownCount } = orderProjects(
			["beta", "alpha"],
			activity,
			"claude-code",
		);
		expect(ordered).toEqual(["alpha", "beta"]);
		expect(knownCount).toBe(2);
	});

	it("treats an entry with only malformed timestamps as unknown, without throwing", () => {
		const activity: ProjectActivity = {
			alpha: { last: "garbage", byHarness: { "claude-code": "also garbage" } },
			beta: {
				last: "2026-09-01T10:00:00Z",
				byHarness: { "claude-code": "2026-09-01T10:00:00Z" },
			},
		};
		let result!: { ordered: string[]; knownCount: number };
		expect(() => {
			result = orderProjects(["alpha", "beta", "carrot"], activity, "claude-code");
		}).not.toThrow();
		// beta is the only real timestamp, so it leads; the junk entry sinks in
		// with the unknowns and must NOT inflate knownCount (which gates the
		// "most recent first" hint).
		expect(result.ordered).toEqual(["beta", "alpha", "carrot"]);
		expect(result.knownCount).toBe(1);
	});

	it("does not throw when an entry is missing byHarness entirely", () => {
		const broken = {
			alpha: { last: "2026-09-01T10:00:00Z" },
		} as unknown as ProjectActivity;
		expect(() => orderProjects(["alpha", "beta"], broken, "claude-code")).not.toThrow();
		expect(orderProjects(["alpha", "beta"], broken, "claude-code")).toEqual({
			ordered: ["alpha", "beta"],
			knownCount: 1,
		});
	});

	it("returns an empty list unchanged", () => {
		expect(orderProjects([], {}, "claude-code")).toEqual({
			ordered: [],
			knownCount: 0,
		});
	});
});

describe("readStoredActivity / storeActivity — adversarial", () => {
	beforeEach(() => {
		localStorage.clear();
		vi.restoreAllMocks();
	});

	it("rejects a JSON array", () => {
		localStorage.setItem(PROJECT_ACTIVITY_KEY, JSON.stringify([]));
		expect(readStoredActivity()).toEqual({});
		localStorage.setItem(
			PROJECT_ACTIVITY_KEY,
			JSON.stringify([{ last: "2026-09-01T10:00:00Z", byHarness: {} }]),
		);
		expect(readStoredActivity()).toEqual({});
	});

	it("rejects an entry whose byHarness is a string", () => {
		localStorage.setItem(
			PROJECT_ACTIVITY_KEY,
			JSON.stringify({ alpha: { last: "2026-09-01T10:00:00Z", byHarness: "pi" } }),
		);
		expect(readStoredActivity()).toEqual({});
	});

	it("rejects an entry with no byHarness at all — every consumer dereferences it", () => {
		localStorage.setItem(
			PROJECT_ACTIVITY_KEY,
			JSON.stringify({ alpha: { last: "2026-09-01T10:00:00Z" } }),
		);
		expect(readStoredActivity()).toEqual({});
	});

	it("rejects an entry whose byHarness holds a non-string value", () => {
		localStorage.setItem(
			PROJECT_ACTIVITY_KEY,
			JSON.stringify({ alpha: { last: "2026-09-01T10:00:00Z", byHarness: { pi: 7 } } }),
		);
		expect(readStoredActivity()).toEqual({});
	});

	it("rejects a null entry and a JSON scalar", () => {
		localStorage.setItem(PROJECT_ACTIVITY_KEY, JSON.stringify({ alpha: null }));
		expect(readStoredActivity()).toEqual({});
		localStorage.setItem(PROJECT_ACTIVITY_KEY, JSON.stringify("nope"));
		expect(readStoredActivity()).toEqual({});
		localStorage.setItem(PROJECT_ACTIVITY_KEY, JSON.stringify(null));
		expect(readStoredActivity()).toEqual({});
	});

	it("returns {} when localStorage itself throws on read", () => {
		vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
			throw new DOMException("SecurityError");
		});
		expect(readStoredActivity()).toEqual({});
	});

	it("never throws when localStorage refuses the write", () => {
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new DOMException("QuotaExceededError");
		});
		expect(() =>
			storeActivity({
				alpha: { last: "2026-09-01T10:00:00Z", byHarness: {} },
			}),
		).not.toThrow();
	});
});

describe("deriveProjectActivity — hubProject from the usage enrichment", () => {
	const projects = { "skill-hub": { path: "/Users/dev/Dev/.skill-hub" } };

	it("matches by hubProject when the session carries no full path (cached scan)", () => {
		const snap = makeSnapshot([
			makeSession({
				harnessId: "codex",
				hubProject: "skill-hub",
				project: { label: "skill-hub", anonymized: true, redactedPath: "…/redacted" },
				lastActivity: "2026-08-02T10:00:00Z",
			}),
		]);
		const out = deriveProjectActivity(snap, projects);
		expect(out["skill-hub"]?.byHarness.codex).toBe("2026-08-02T10:00:00Z");
		expect(out["skill-hub"]?.last).toBe("2026-08-02T10:00:00Z");
	});

	it("prefers hubProject over a full path that names a different project", () => {
		const two = { ...projects, other: { path: "/Users/dev/other" } };
		const snap = makeSnapshot([
			makeSession({
				hubProject: "skill-hub",
				project: { label: "x", anonymized: true, fullPath: "/Users/dev/other" },
				lastActivity: "2026-08-03T10:00:00Z",
			}),
		]);
		const out = deriveProjectActivity(snap, two);
		expect(Object.keys(out)).toEqual(["skill-hub"]);
	});

	it("falls back to the full path when hubProject names no registry project", () => {
		const snap = makeSnapshot([
			makeSession({
				hubProject: "gone",
				project: { label: "x", anonymized: true, fullPath: "/Users/dev/Dev/.skill-hub/" },
				lastActivity: "2026-08-04T10:00:00Z",
			}),
		]);
		const out = deriveProjectActivity(snap, projects);
		expect(out["skill-hub"]?.last).toBe("2026-08-04T10:00:00Z");
	});

	it("ignores a hubProject that only exists on the prototype chain", () => {
		const snap = makeSnapshot([
			makeSession({ hubProject: "toString", lastActivity: "2026-08-05T10:00:00Z" }),
		]);
		expect(deriveProjectActivity(snap, projects)).toEqual({});
	});
});

