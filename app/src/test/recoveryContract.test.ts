import { describe, expect, it } from "vitest";
import {
	hasUnresolvedRows,
	openLocalSourceRows,
	openProjectRows,
	openSourceRows,
	recoveryFinishCounts,
	stageRowsResolved,
	toDiscoverResult,
	toGithubRepos,
	toRecoveryStatus,
	toSyncResult,
} from "@/lib/recoveryContract";

/**
 * The contract adapter's tolerant-parsing behavior is what makes the wizard
 * survive a still-moving backend shape (PLAN.md's implementation order runs
 * UI wiring after the contract, but the contract itself iterated across the
 * draft → corrected round documented in /tmp/restore-recovery-contract.md).
 * These fixtures are the corrected shape; the degrade-safe assertions pin
 * what happens when a field the corrections added is simply absent.
 */

describe("toRecoveryStatus", () => {
	it("normalizes a populated status payload (the F1/F2 incident shape)", () => {
		const status = toRecoveryStatus({
			ok: true,
			operation_id: "op-1",
			stage: "projects",
			needs_recovery: true,
			dismissed: false,
			completed: false,
			bootstrap: { completed: true, completed_at: "2026-09-23T18:03:01Z", restored_from: "backup-repo" },
			backup: { pending_reconcile: true },
			projects: [
				{
					name: "skill-tree",
					path: "~/Dev/skill-tree",
					path_unresolved: true,
					attached: false,
					repository: { url: "https://github.com/x/skill-tree.git", remote: "origin", subdirectory: "." },
					status: "pending",
					detail: null,
					updated_at: null,
				},
				{
					name: "spectrebox",
					path: "~/Dev/spectrebox",
					path_unresolved: false,
					attached: true,
					repository: null,
					status: "ready",
					detail: null,
					updated_at: "2026-09-23T18:04:00Z",
				},
			],
			projects_summary: { ready: 1, pending: 1, skipped: 0, failed: 0, interrupted: 0, total: 2 },
			sources: [
				{ id: "unslop", url: "https://x/unslop.git", cache: "~/cache/unslop", healthy: false, status: "failed", detail: "timeout" },
			],
			local_sources: [
				{ skill: "gh-fix-ci", missing_path: "~/.codex/skills/gh-fix-ci", status: "pending", detail: null, path: null },
			],
		});

		expect(status.operationId).toBe("op-1");
		expect(status.stage).toBe("projects");
		expect(status.needsRecovery).toBe(true);
		expect(status.backupPendingReconcile).toBe(true);
		expect(status.projects).toHaveLength(2);
		expect(status.projects[0].pathUnresolved).toBe(true);
		expect(status.projects[0].repository?.url).toBe("https://github.com/x/skill-tree.git");
		expect(status.projects[1].attached).toBe(true);
		expect(status.sources[0].status).toBe("failed");
		expect(status.localSources[0].missingPath).toBe("~/.codex/skills/gh-fix-ci");
	});

	it("degrades to a safe empty status when the record is entirely absent (A14: older installs)", () => {
		const status = toRecoveryStatus(undefined);
		expect(status.needsRecovery).toBe(false);
		expect(status.projects).toEqual([]);
		expect(status.sources).toEqual([]);
		expect(status.localSources).toEqual([]);
	});

	it("never needs recovery for a healthy install with an empty record", () => {
		// The exact shape a fully-synced, never-restored machine would read:
		// `operation_id: null`, everything empty, no explicit `needs_recovery`.
		const status = toRecoveryStatus({
			ok: true,
			operation_id: null,
			stage: null,
			bootstrap: { completed: true },
			projects: [],
			sources: [],
			local_sources: [],
		});
		expect(status.needsRecovery).toBe(false);
	});

	it("derives needs_recovery from outstanding rows when the backend omits the flag", () => {
		const status = toRecoveryStatus({
			operation_id: "op-2",
			stage: "sources",
			projects: [],
			sources: [{ id: "x", url: "u", cache: "c", healthy: false, status: "failed", detail: null }],
			local_sources: [],
		});
		expect(status.needsRecovery).toBe(true);
	});

	it("a 'running' row with a dead owner reads back as interrupted, not running", () => {
		// The backend never hands the frontend "running" for a stale row — the
		// corrected contract says a dead-owner row resolves server-side. This
		// pins that the adapter renders whatever verdict it is given rather than
		// re-deriving staleness itself.
		const status = toRecoveryStatus({
			operation_id: "op-3",
			projects: [
				{ name: "p", path: "/p", path_unresolved: true, attached: false, repository: null, status: "interrupted", detail: "owner process is gone" },
			],
			sources: [],
			local_sources: [],
		});
		expect(status.projects[0].status).toBe("interrupted");
	});

	it("falls back to an unknown row status rather than throwing on a bad enum", () => {
		const status = toRecoveryStatus({
			operation_id: "op-4",
			projects: [{ name: "p", path: "/p", status: "not-a-real-status" }],
			sources: [],
			local_sources: [],
		});
		expect(status.projects[0].status).toBe("pending");
	});
});

describe("open*Rows", () => {
	const status = toRecoveryStatus({
		operation_id: "op-5",
		projects: [
			{ name: "ready", path: "/r", attached: true, status: "ready" },
			{ name: "skipped", path: "/s", attached: false, status: "skipped" },
			{ name: "open", path: "/o", attached: false, status: "pending" },
		],
		sources: [
			{ id: "ready", status: "ready" },
			{ id: "skipped", status: "skipped" },
			{ id: "open", status: "failed" },
		],
		local_sources: [
			{ skill: "ready", status: "ready" },
			{ skill: "open", status: "pending" },
		],
	});

	it("openProjectRows excludes attached and skipped rows", () => {
		expect(openProjectRows(status).map((p) => p.name)).toEqual(["open"]);
	});

	it("openSourceRows excludes ready and skipped rows", () => {
		expect(openSourceRows(status).map((s) => s.id)).toEqual(["open"]);
	});

	it("openLocalSourceRows excludes ready rows", () => {
		expect(openLocalSourceRows(status).map((s) => s.skill)).toEqual(["open"]);
	});
});

describe("recoveryFinishCounts", () => {
	it("never counts a skipped project as ready, and pools failed+interrupted", () => {
		const status = toRecoveryStatus({
			operation_id: "op-6",
			projects: [
				{ name: "a", path: "/a", attached: true, status: "ready" },
				{ name: "b", path: "/b", attached: false, status: "skipped" },
				{ name: "c", path: "/c", attached: false, status: "failed" },
				{ name: "d", path: "/d", attached: false, status: "interrupted" },
			],
			sources: [],
			local_sources: [],
		});
		expect(recoveryFinishCounts(status)).toEqual({ ready: 1, skipped: 1, failed: 2 });
	});
});

describe("toGithubRepos", () => {
	it("normalizes a paginated repository page and a typed error", () => {
		const page = toGithubRepos({
			ok: true,
			repositories: [
				{ full_name: "org/a", url: "https://x/a.git", ssh_url: "git@x:a.git", private: true, updated_at: "t", default_branch: "main" },
			],
			page: 2,
			per_page: 30,
			has_more: true,
			error_kind: null,
			error: null,
		});
		expect(page.repositories[0].fullName).toBe("org/a");
		expect(page.hasMore).toBe(true);

		const failed = toGithubRepos({ ok: false, error_kind: "unauthenticated", error: "not signed in" });
		expect(failed.errorKind).toBe("unauthenticated");
		expect(failed.repositories).toEqual([]);
	});
});

describe("toDiscoverResult", () => {
	it("normalizes identity-matched checkout candidates", () => {
		const result = toDiscoverResult({
			ok: true,
			matches: [{ path: "/dev/x", git_root: "/dev/x", is_worktree: false, matched_remote: "origin", subdirectories: ["."] }],
			issues: [],
			truncated: false,
		});
		expect(result.matches).toHaveLength(1);
		expect(result.matches[0].matchedRemote).toBe("origin");
	});

	it("reads the typed {code,message,field} issue objects the real scan returns, not just bare strings", () => {
		// A plain `strings()` read silently dropped every issue here (they are
		// objects) — this is what let a scan permission error go unrendered.
		const result = toDiscoverResult({
			ok: true,
			matches: [],
			issues: [{ code: "permission_denied", message: "cannot read /root/private", field: null }],
			truncated: false,
		});
		expect(result.issues).toEqual(["cannot read /root/private"]);
	});

	it("carries the top-level error through for a failed scan", () => {
		const result = toDiscoverResult({ ok: false, matches: [], issues: [], truncated: false, error: "boom" });
		expect(result.error).toBe("boom");
	});
});

describe("hasUnresolvedRows / stageRowsResolved", () => {
	it("requires an explicit outcome for pending, running and failed rows", () => {
		const status = toRecoveryStatus({
			operation_id: "op-7",
			projects: [{ name: "a", path: "/a", attached: false, status: "pending" }],
			sources: [{ id: "b", status: "failed" }],
			local_sources: [{ skill: "c", status: "skipped" }],
		});
		expect(hasUnresolvedRows(status)).toBe(true);

		const resolved = toRecoveryStatus({
			operation_id: "op-8",
			projects: [{ name: "a", path: "/a", attached: true, status: "ready" }],
			sources: [{ id: "b", status: "failed" }],
			local_sources: [{ skill: "c", status: "skipped" }],
		});
		expect(hasUnresolvedRows(resolved)).toBe(true);
	});

	it("stageRowsResolved reads real row outcomes, never 'the user clicked past it'", () => {
		const status = toRecoveryStatus({
			operation_id: "op-9",
			projects: [],
			sources: [{ id: "b", status: "pending" }],
			local_sources: [],
		});
		expect(stageRowsResolved(status, "sources")).toBe(false);

		const done = toRecoveryStatus({
			operation_id: "op-10",
			projects: [],
			sources: [{ id: "b", status: "failed" }],
			local_sources: [],
		});
		expect(stageRowsResolved(done, "sources")).toBe(false);

		// `sync` has no row collection of its own — never reads as resolved from
		// `status` alone (the caller tracks an actual attempt).
		expect(stageRowsResolved(done, "sync")).toBe(false);

		const deferred = toRecoveryStatus({
			operation_id: "op-11",
			projects: [],
			sources: [{ id: "b", status: "deferred" }],
			local_sources: [],
		});
		expect(stageRowsResolved(deferred, "sources")).toBe(false);
	});
});

describe("toSyncResult", () => {
	it("separates project failures from global failures and never inflates success", () => {
		const result = toSyncResult({
			ok: true,
			counts: { success: 1, skipped: 2, failed: 1 },
			failed_projects: ["dev"],
			project_failures: { dev: ["Skill source is missing", "Could not write files"] },
			global_failures: ["backup dir unwritable"],
			error: null,
		});
		expect(result.counts).toEqual({ success: 1, skipped: 2, failed: 1 });
		expect(result.failedProjects).toEqual(["dev"]);
		expect(result.projectFailures).toEqual({ dev: ["Skill source is missing", "Could not write files"] });
		expect(result.globalFailures).toEqual(["backup dir unwritable"]);
	});

	it("degrades an absent project failure map to an empty map", () => {
		expect(toSyncResult({ counts: {}, failed_projects: [], global_failures: [] }).projectFailures).toEqual({});
	});

	it("keeps readable context from legacy object-shaped failure entries", () => {
		const result = toSyncResult({
			counts: { success: 0, skipped: 0, failed: 1 },
			failed_projects: ["dev"],
			project_failures: {
				dev: [
					{ stage: "symlink", message: "source missing" },
					{ error: "could not write files" },
				],
			},
			global_failures: [
				{ scope: "hooks", error: "hook stream failed" },
				{ scope: "permissions", message: "not allowed" },
			],
		});

		expect(result.projectFailures).toEqual({
			dev: ["symlink: source missing", "could not write files"],
		});
		expect(result.globalFailures).toEqual(["hooks: hook stream failed", "permissions: not allowed"]);
		expect(result.globalFailures.join(" ")).not.toContain("[object Object]");
	});
});
