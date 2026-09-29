// Mock for `hub recovery <action> …` (`recovery_command` bridge). Dispatched
// from `tauriCore.ts`'s `recovery_command` case, args[0] === the action name
// (matches the real `skill_hub/entrypoints/cli/recovery.py` parser).
//
// State lives in one object, persisted to `sessionStorage` after every
// mutation and reloaded on module init — a browser reload (the visual
// harness, a manual PR-preview reload, or a real app restart) must resume
// the SAME journey rather than silently re-seeding (A10: "restart resumes
// recovery without applying the snapshot again"). `sessionStorage`, not
// `localStorage`: this is synthetic fixture state for one tab's session, not
// something that should survive across separate preview loads.
//
// `?restoreRecovery=1` seeds the same F1–F4 incident shape FINDINGS.md
// describes on first load, without waiting for a `start` call — the direct
// `/recovery` journey (reopened from Backup, or a project's own "Attach
// directory") must render fully on a fresh mock load.

import { registry } from "./tauriCore";
import { sceneFlag } from "./scenes";

type RowStatus = "pending" | "running" | "ready" | "skipped" | "deferred" | "failed" | "interrupted";

interface SourceRow {
	id: string;
	url: string;
	cache: string;
	healthy: boolean;
	status: RowStatus;
	detail: string | null;
	attempts: number;
}

interface ProjectRow {
	name: string;
	path: string;
	path_unresolved: boolean;
	attached: boolean;
	repository: { url: string; remote: string; subdirectory: string } | null;
	status: RowStatus;
	detail: string | null;
	updated_at: string | null;
}

interface LocalSourceRow {
	skill: string;
	missing_path: string;
	status: RowStatus;
	detail: string | null;
	path: string | null;
}

interface MockState {
	operationId: string | null;
	stage: string | null;
	dismissed: boolean;
	completed: boolean;
	seeded: boolean;
	sources: SourceRow[];
	projects: ProjectRow[];
	localSources: LocalSourceRow[];
	syncResult: unknown | null;
	syncFingerprint: string | null;
}

const STORAGE_KEY = sceneFlag("restoreRecoveryDense") ? "st:mock:recovery:dense" : "st:mock:recovery";

function emptyState(): MockState {
	return {
		operationId: null,
		stage: null,
		dismissed: false,
		completed: false,
		seeded: false,
		sources: [],
		projects: [],
		localSources: [],
		syncResult: null,
		syncFingerprint: null,
	};
}

function loadState(): MockState {
	if (typeof window === "undefined") return emptyState();
	try {
		const raw = window.sessionStorage.getItem(STORAGE_KEY);
		if (!raw) return emptyState();
		const parsed = JSON.parse(raw) as Partial<MockState>;
		return { ...emptyState(), ...parsed };
	} catch {
		return emptyState();
	}
}

const state: MockState = loadState();

function persist() {
	if (typeof window === "undefined") return;
	try {
		window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
	} catch {
		// Storage full/unavailable (private mode) — the mock still works for
		// the current render, it just won't survive a reload. Non-fatal.
	}
}

const GITHUB_REPOS = Array.from({ length: 8 }, (_, i) => ({
	full_name: `example-org/repo-${i + 1}`,
	url: `https://github.com/example-org/repo-${i + 1}.git`,
	ssh_url: `git@github.com:example-org/repo-${i + 1}.git`,
	private: i % 3 === 0,
	updated_at: "2026-09-20T12:00:00Z",
	default_branch: "main",
}));

function seedIncident() {
	if (state.seeded) return;
	state.seeded = true;
	state.operationId = "mock-op-1";
	state.stage = "sources";
	state.sources = [
		{
			id: "diagnosing-bugs",
			url: "https://github.com/example-org/diagnosing-bugs.git",
			cache: "~/.skill-hub/sources/diagnosing-bugs",
			healthy: false,
			status: "pending",
			detail: "cache missing — clone required",
			attempts: 0,
		},
		{
			id: "codebase-design",
			url: "https://github.com/example-org/codebase-design.git",
			cache: "~/.skill-hub/sources/codebase-design",
			healthy: false,
			status: "pending",
			detail: "cache missing — clone required",
			attempts: 0,
		},
		{
			id: "unslop",
			url: "https://github.com/example-org/unslop.git",
			cache: "~/.skill-hub/sources/unslop",
			healthy: false,
			status: "failed",
			detail: "previous attempt timed out",
			// Already one failed attempt on load — retrying it in the mock
			// SUCCEEDS (attempts >= 1), so the retry affordance is provably
			// reachable end to end, not just rendered.
			attempts: 1,
		},
	];
	state.projects = [
		{
			name: "skill-tree",
			path: "~/Dev/skill-tree",
			path_unresolved: true,
			attached: false,
			repository: {
				url: "https://github.com/example-org/skill-tree.git",
				remote: "origin",
				subdirectory: ".",
			},
			status: "pending",
			detail: null,
			updated_at: null,
		},
		{
			name: "dev",
			path: "~/Dev/dev",
			path_unresolved: true,
			attached: false,
			repository: null,
			status: "pending",
			detail: null,
			updated_at: null,
		},
		{
			name: "spectrebox",
			path: "~/Dev/spectrebox",
			path_unresolved: false,
			attached: true,
			repository: {
				url: "https://github.com/example-org/spectrebox.git",
				remote: "origin",
				subdirectory: ".",
			},
			status: "ready",
			detail: null,
			updated_at: "2026-09-23T18:03:01Z",
		},
	];
	state.localSources = [
		{
			skill: "gh-fix-ci",
			missing_path: "~/.codex/skills/gh-fix-ci",
			status: "pending",
			detail: null,
			path: null,
		},
		{
			skill: "skt-mcp",
			missing_path: "~/Dev/.skill-hub/skills/skill-tree-mcp",
			status: "pending",
			detail: null,
			path: null,
		},
	];
}

export function ensureRecoveryFixture() {
	if (sceneFlag("restoreRecovery") || sceneFlag("restoreRecoveryDense")) {
		const wasSeeded = state.seeded;
		seedIncident();
		if (!wasSeeded && sceneFlag("restoreRecoveryDense")) {
			const template = state.projects[0];
			state.projects = Array.from({ length: 15 }, (_, i) => ({
				...template, name: `project-${String(i + 1).padStart(2, "0")}`,
				path: `/old-machine/engineering/a-very-long-directory-name/research/project-${i + 1}`,
				status: i < 3 ? "ready" : i < 10 ? "skipped" : i < 12 ? "failed" : "pending",
				attached: i < 3, path_unresolved: i >= 3,
				repository: { url: `https://github.com/example-organization-with-a-long-name/project-${i + 1}.git`, remote: "origin", subdirectory: "." },
				detail: i >= 10 && i < 12 ? "Clone failed. Check access and retry." : null,
			}));
			state.stage = "projects";
		}
	}
	if (state.seeded) {
		const existing = registry.projects;
		Object.assign(registry, { projects: Object.fromEntries(state.projects.map((row) => [row.name, {
			...(existing[row.name] ?? { enabled: ["code-review"], bundles: [] }),
			path: row.path, path_unresolved: row.path_unresolved, repository: row.repository,
		}])) });
	}
}

function stateFingerprint() {
	return JSON.stringify([state.projects, state.sources, state.localSources]);
}

function syncCurrent() {
	return state.syncResult !== null && state.syncFingerprint === stateFingerprint();
}

function arg(args: string[], flag: string): string | undefined {
	const i = args.indexOf(flag);
	return i >= 0 ? args[i + 1] : undefined;
}

function argAll(args: string[], flag: string): string[] {
	const out: string[] = [];
	for (let i = 0; i < args.length; i++) if (args[i] === flag) out.push(args[i + 1]);
	return out;
}

function rowsOutstanding(): boolean {
	return [...state.sources, ...state.projects, ...state.localSources].some(
		(r) => r.status !== "ready" && r.status !== "skipped" && r.status !== "deferred",
	);
}

function summary(rows: { status: RowStatus }[]) {
	const out = { ready: 0, pending: 0, skipped: 0, failed: 0, interrupted: 0, total: rows.length };
	for (const r of rows) {
		if (r.status === "running") continue;
		(out as unknown as Record<string, number>)[r.status] += 1;
	}
	return out;
}

/** A `{ok:false, error:{code,message}}` refusal — the real CLI's shape for
 *  every command-level failure. Mirrored here (rather than a bare string) so
 *  the mock exercises the exact path `recoveryCommand` throws on. */
function refusal(code: string, message: string) {
	return { ok: false, error: { code, message } };
}

function statusPayload() {
	ensureRecoveryFixture();
	const needsRecovery = state.operationId !== null && !state.dismissed && (rowsOutstanding() || !state.completed);
	return {
		ok: true,
		schema_version: 1,
		operation_id: state.operationId,
		stage: state.stage,
		needs_recovery: needsRecovery,
		dismissed: state.dismissed,
		completed: state.completed,
		sync_result: state.syncResult,
		sync_current: syncCurrent(),
		bootstrap: {
			completed: true,
			completed_at: "2026-09-23T18:03:01Z",
			restored_from: "example-org/skill-tree-backup",
		},
		backup: { pending_reconcile: state.operationId !== null },
		projects: state.projects,
		projects_summary: summary(state.projects),
		sources: state.sources,
		local_sources: state.localSources,
	};
}

/** Registry-attachment consistency, matching `recovery.py::project_status_rows`:
 *  `attached` is derived from path presence + `path_unresolved`, never set
 *  independently of them — a mock row can't drift into "attached but
 *  path_unresolved" or vice versa the way a hand-set boolean could. */
function markAttached(row: ProjectRow, path: string) {
	row.path = path;
	row.path_unresolved = false;
	row.attached = true;
	row.status = "ready";
	row.detail = null;
	row.updated_at = new Date().toISOString();
}

export function mockRecovery(args: string[]): unknown {
	const action = args[0];
	let result: unknown;

	switch (action) {
		case "status":
			return statusPayload();

		case "start": {
			if (state.operationId === null) {
				state.operationId = `mock-op-${Date.now()}`;
				seedIncident();
			}
			const requested = arg(args, "--stage");
			state.stage = requested ?? state.stage ?? "sources";
			state.dismissed = false;
			state.completed = false;
			result = statusPayload();
			break;
		}

		case "stage": {
			state.stage = arg(args, "--stage") ?? state.stage;
			result = statusPayload();
			break;
		}

		case "finish": {
			if (!args.includes("--defer") && (rowsOutstanding() || !syncCurrent())) {
				return refusal("unresolved_items", "Resolve or skip each item and run local sync before finishing.");
			}
			if (args.includes("--defer")) {
				for (const row of [...state.projects, ...state.sources, ...state.localSources]) {
					if (!["ready", "skipped", "deferred"].includes(row.status)) row.status = "deferred";
				}
			}
			state.completed = true;
			state.dismissed = true;
			result = statusPayload();
			break;
		}

		case "skip": {
			const project = arg(args, "--project");
			const row = state.projects.find((p) => p.name === project);
			if (!row) {
				result = refusal("unknown_project", `unknown project '${project}'`);
				break;
			}
			row.status = "skipped";
			row.detail = arg(args, "--reason") ?? null;
			result = statusPayload();
			break;
		}

		case "skip-source": {
			const id = args[1];
			const row = state.sources.find((s) => s.id === id);
			if (!row) {
				result = refusal("unknown_source", `unknown source '${id}'`);
				break;
			}
			row.status = "skipped";
			result = statusPayload();
			break;
		}

		case "skip-local-source": {
			const skill = arg(args, "--skill");
			const row = state.localSources.find((s) => s.skill === skill);
			if (!row) {
				result = refusal("unknown_skill", `unknown skill '${skill}'`);
				break;
			}
			row.status = "skipped";
			row.detail = arg(args, "--reason") ?? null;
			result = statusPayload();
			break;
		}

		case "set-repository": {
			const project = arg(args, "--project");
			const url = arg(args, "--url") ?? "";
			const remote = arg(args, "--remote") ?? "origin";
			const subdirectory = arg(args, "--subdirectory") ?? ".";
			const row = state.projects.find((p) => p.name === project);
			if (!row) {
				result = refusal("unknown_project", `unknown project '${project}'`);
				break;
			}
			row.repository = { url, remote, subdirectory };
			if (row.status === "skipped" || row.status === "deferred") row.status = "pending";
			result = statusPayload();
			break;
		}

		case "github-repos": {
			const query = (arg(args, "--query") ?? "").toLowerCase();
			const page = Number(arg(args, "--page") ?? "1");
			const perPage = Number(arg(args, "--per-page") ?? "5");
			const filtered = query
				? GITHUB_REPOS.filter((r) => r.full_name.toLowerCase().includes(query))
				: GITHUB_REPOS;
			const start = (page - 1) * perPage;
			const pageRows = filtered.slice(start, start + perPage);
			return {
				ok: true,
				repositories: pageRows,
				page,
				per_page: perPage,
				has_more: start + perPage < filtered.length,
				error_kind: null,
				error: null,
			};
		}

		case "discover": {
			const project = arg(args, "--project");
			const roots = argAll(args, "--root");
			const row = state.projects.find((p) => p.name === project);
			if (!row) {
				return { ok: false, matches: [], issues: [], truncated: false, error: `unknown project '${project}'` };
			}
			if (!row.repository) {
				return { ok: false, matches: [], issues: [], truncated: false, error: `project '${project}' has no repository association` };
			}
			if (roots.length === 0) return { ok: true, matches: [], issues: [], truncated: false, error: null };
			// One deterministic identity-matching hit under the first search root.
			return {
				ok: true,
				matches: [
					{
						path: `${roots[0]}/${project}`,
						git_root: `${roots[0]}/${project}`,
						is_worktree: false,
						matched_remote: row.repository.remote,
						subdirectories: ["."],
					},
				],
				issues: [],
				truncated: false,
				error: null,
			};
		}

		case "attach": {
			const project = arg(args, "--project");
			const path = arg(args, "--path") ?? "";
			const remote = arg(args, "--remote");
			const row = state.projects.find((p) => p.name === project);
			if (!row) {
				result = refusal("unknown_project", `unknown project '${project}'`);
				break;
			}
			// Deterministic `ambiguous_remote` fixture: a magic path segment so
			// the retry-with-remote flow (RecoveryAttachPicker's remote field)
			// is exercised end to end without needing a real multi-remote repo.
			if (path.includes("multi-remote") && !remote) {
				result = refusal(
					"ambiguous_remote",
					`'${path}' has multiple remotes (origin, upstream) — pass --remote to choose one`,
				);
				break;
			}
			markAttached(row, path);
			if (!row.repository) {
				row.repository = {
					url: `https://github.com/example-org/${project}.git`,
					remote: remote || "origin",
					subdirectory: ".",
				};
			}
			result = statusPayload();
			break;
		}

		case "clone": {
			const project = arg(args, "--project");
			const destination = arg(args, "--destination") ?? "";
			const row = state.projects.find((p) => p.name === project);
			if (!row) {
				result = refusal("unknown_project", `unknown project '${project}'`);
				break;
			}
			if (!row.repository) {
				result = refusal("no_repository", `project '${project}' has no repository to clone`);
				break;
			}
			markAttached(row, destination);
			result = statusPayload();
			break;
		}

		case "restore-source": {
			const all = args.includes("--all");
			const id = all ? null : args[1];
			const targets = state.sources.filter((s) => all ? !["ready", "skipped", "deferred"].includes(s.status) : s.id === id);
			if (!all && targets.length === 0) {
				result = refusal("unknown_source", `unknown source '${id}'`);
				break;
			}
			const results = targets.map((row) => {
				row.attempts += 1;
				// The scripted "unslop" incident source fails its first
				// (pre-seeded) attempt, then succeeds — proves the retry
				// affordance actually resolves the row, not just re-renders it.
				const ok = row.attempts >= 1;
				if (ok) {
					row.status = "ready";
					row.healthy = true;
					row.detail = null;
				} else {
					row.status = "failed";
					row.detail = "clone failed — retry";
				}
				return { source: row.id, ok, detail: row.detail };
			});
			result = { ok: results.every((r) => r.ok), results };
			break;
		}

		case "set-local-source": {
			const skill = arg(args, "--skill");
			const path = arg(args, "--path") ?? "";
			const row = state.localSources.find((s) => s.skill === skill);
			if (!row) {
				result = refusal("unknown_skill", `unknown skill '${skill}'`);
				break;
			}
			row.status = "ready";
			row.path = path;
			row.detail = null;
			result = statusPayload();
			break;
		}

		case "sync": {
			const failedProjects = state.projects
				.filter((p) => p.attached && p.status === "failed")
				.map((p) => p.name);
			result = {
				ok: failedProjects.length === 0,
				counts: {
					success: state.projects.filter((p) => p.attached && p.status === "ready").length,
					skipped: state.projects.filter((p) => p.status === "skipped").length,
					failed: failedProjects.length,
				},
				failed_projects: failedProjects,
				global_failures: [],
				error: null,
			};
			state.syncResult = result;
			state.syncFingerprint = stateFingerprint();
			break;
		}

		default:
			return refusal("unknown_action", `Unknown recovery action: ${action}`);
	}

	persist();
	return result;
}
