import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@/lib/ipc";
import { qk } from "@/lib/queryKeys";
import { invalidateRegistry } from "@/lib/invalidate";
import { trackProcess } from "@/lib/trackProcess";
import {
	toDiscoverResult,
	toGithubRepos,
	toRecoveryStatus,
	toSyncResult,
	type RecoveryDiscoverResult,
	type RecoveryGithubRepos,
	type RecoveryStage,
	type RecoveryStatus,
	type RecoverySyncResult,
} from "@/lib/recoveryContract";

/** `String(e)` on any `Error` subclass prints `"<name>: <message>"` — fine in
 *  a log, wrong in a toast/inline error the user reads as one sentence. Every
 *  recovery call site's `catch` should read the message through this instead
 *  of interpolating the caught value directly. */
export function recoveryErrorMessage(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/** A `hub recovery` refusal: the CLI's own `{code, message}`, always inside a
 *  top-level `error` — never `error: null` for a genuine command failure. */
export interface RecoveryCommandError {
	code: string;
	message: string;
}

/** Thrown by [`recoveryCommand`] for a genuine command-level refusal — never
 *  for a row-level partial outcome (see below). `.message` is the CLI's own
 *  sentence, so every `catch`/`addToast(String(e))` call site already reads
 *  it correctly with no special-casing. */
export class RecoveryCommandFailure extends Error {
	readonly code: string;
	constructor(error: RecoveryCommandError) {
		super(error.message || `recovery command failed (${error.code})`);
		this.name = "RecoveryCommandFailure";
		this.code = error.code;
	}
}

/** Nested command refusals reject. Structured read and sync results keep
 * their flat error, counts, and guidance available to the caller. */
async function recoveryCommand(args: string[]): Promise<unknown> {
	const raw = await invoke<unknown>("recovery_command", { args });
	const error =
		raw && typeof raw === "object" && !Array.isArray(raw)
			? (raw as Record<string, unknown>).error
			: undefined;
	if (error !== null && typeof error === "object" && !Array.isArray(error)) {
		const e = error as Record<string, unknown>;
		throw new RecoveryCommandFailure({
			code: typeof e.code === "string" ? e.code : "recovery_error",
			message: typeof e.message === "string" ? e.message : String(error),
		});
	}
	return raw;
}

/** Invalidate the one query every recovery mutation may have moved. Registry
 *  invalidation is opt-in per hook below — most recovery actions (skip,
 *  discover, github-repos) never touch `registry.yaml`. */
function useInvalidateRecoveryStatus() {
	const qc = useQueryClient();
	return () => qc.invalidateQueries({ queryKey: qk.recovery.status() });
}

/**
 * The one read every step of the wizard (and the Backup screen's reopen
 * entry) shares. Polls only while genuinely live work is outstanding — a
 * finished or dismissed recovery has nothing left to watch.
 */
export function useRecoveryStatus(enabled = true) {
	const pending = useIsMutating({ predicate: (mutation) => mutation.options.meta?.recovery === true });
	return useQuery({
		queryKey: qk.recovery.status(),
		queryFn: async () => toRecoveryStatus(await recoveryCommand(["status"])),
		enabled,
		refetchOnWindowFocus: false,
		refetchInterval: (query) => {
			const data = query.state.data as RecoveryStatus | undefined;
			if (!data) return false;
			const running = [...data.projects, ...data.sources, ...data.localSources].some(
				(row) => row.status === "running",
			);
			return running || pending > 0 ? 2_000 : false;
		},
	});
}

export function useRecoveryStart() {
	const invalidate = useInvalidateRecoveryStatus();
	return useMutation({
		meta: { recovery: true },
		mutationFn: (stage?: RecoveryStage) =>
			recoveryCommand(stage ? ["start", "--stage", stage] : ["start"]),
		onSettled: invalidate,
	});
}

export function useRecoveryStage() {
	const invalidate = useInvalidateRecoveryStatus();
	return useMutation({
		meta: { recovery: true },
		mutationFn: (stage: RecoveryStage) => recoveryCommand(["stage", "--stage", stage]),
		onSettled: invalidate,
	});
}

export function useRecoveryFinish() {
	const invalidate = useInvalidateRecoveryStatus();
	return useMutation({
		meta: { recovery: true },
		mutationFn: (defer: boolean = false) => recoveryCommand(defer ? ["finish", "--defer"] : ["finish"]),
		onSettled: invalidate,
	});
}

export function useRecoverySkipProject() {
	const invalidate = useInvalidateRecoveryStatus();
	return useMutation({
		meta: { recovery: true },
		mutationFn: ({ project, reason }: { project: string; reason?: string }) =>
			recoveryCommand(
				reason ? ["skip", "--project", project, "--reason", reason] : ["skip", "--project", project],
			),
		onSettled: invalidate,
	});
}

export function useRecoverySetRepository() {
	const invalidate = useInvalidateRecoveryStatus();
	const qc = useQueryClient();
	return useMutation({
		meta: { recovery: true },
		mutationFn: ({
			project,
			url,
			remote,
			subdirectory,
		}: {
			project: string;
			url: string;
			remote?: string;
			subdirectory?: string;
		}) => {
			const args = ["set-repository", "--project", project, "--url", url];
			if (remote) args.push("--remote", remote);
			if (subdirectory) args.push("--subdirectory", subdirectory);
			return recoveryCommand(args);
		},
		onSettled: () => {
			invalidate();
			void invalidateRegistry(qc);
		},
	});
}

/** Explicit submit search (per the corrected contract: no per-keystroke
 *  refetch of the whole account). `enabled` stays false until the caller
 *  fires a fetch — see `refetch()` in the picker. */
export function useRecoveryGithubRepos(query: string, page: number, enabled: boolean) {
	return useQuery({
		queryKey: qk.recovery.githubRepos(query.trim() || null, page),
		queryFn: async (): Promise<RecoveryGithubRepos> => {
			const args = ["github-repos", "--page", String(page)];
			if (query.trim()) args.push("--query", query.trim());
			return toGithubRepos(await recoveryCommand(args));
		},
		enabled,
		staleTime: 30_000,
		refetchOnWindowFocus: false,
	});
}

export function useRecoveryFetchMoreRepos() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: () => recoveryCommand(["github-repos", "--fetch-more"]),
		onSuccess: () => qc.invalidateQueries({ queryKey: qk.recovery.githubReposAll() }),
	});
}

export function useRecoveryDiscover(project: string, roots: string[], enabled: boolean) {
	return useQuery({
		queryKey: qk.recovery.discover(project, roots),
		queryFn: async (): Promise<RecoveryDiscoverResult> => {
			const args = ["discover", "--project", project];
			for (const root of roots) args.push("--root", root);
			return toDiscoverResult(await recoveryCommand(args));
		},
		enabled: enabled && !!project && roots.length > 0,
		refetchOnWindowFocus: false,
	});
}

export function useRecoveryAttach() {
	const invalidate = useInvalidateRecoveryStatus();
	const qc = useQueryClient();
	return useMutation({
		meta: { recovery: true },
		mutationFn: ({ project, path, remote }: { project: string; path: string; remote?: string }) => {
			const args = ["attach", "--project", project, "--path", path];
			if (remote) args.push("--remote", remote);
			return recoveryCommand(args);
		},
		onSettled: () => {
			invalidate();
			void invalidateRegistry(qc);
		},
	});
}

/** Process-card target for a clone — genuine network work, same treatment as
 *  `BACKUP_TARGET` / `RESTORE_TARGET` in `useBackup.ts`. */
export const RECOVERY_CLONE_TARGET = "recovery:clone";

export function useRecoveryClone() {
	const invalidate = useInvalidateRecoveryStatus();
	const qc = useQueryClient();
	return useMutation({
		meta: { recovery: true },
		mutationFn: ({ project, destination, branch }: { project: string; destination: string; branch?: string }) =>
			trackProcess(
				{
					title: "Cloning repository",
					body: destination,
					kind: "remote",
					target: `${RECOVERY_CLONE_TARGET}:${project}`,
				},
				() => {
					const args = ["clone", "--project", project, "--destination", destination];
					if (branch) args.push("--branch", branch);
					return recoveryCommand(args);
				},
				{ successBody: "Cloned and attached" },
			),
		onSettled: () => {
			invalidate();
			void invalidateRegistry(qc);
		},
	});
}

export const RECOVERY_SOURCE_TARGET = "recovery:restore-source";

/** One entry of `restore-source`'s `results` array — read only for a truthful
 *  process-card body; the per-row status the wizard actually renders still
 *  comes from the next `status` read, never from this shape. */
interface RestoreSourceResult {
	ok: boolean;
	source?: string;
}

function asRestoreSourceResults(raw: unknown): RestoreSourceResult[] {
	const results = raw && typeof raw === "object" ? (raw as Record<string, unknown>).results : undefined;
	if (!Array.isArray(results)) return [];
	return results.filter((r): r is RestoreSourceResult => typeof r === "object" && r !== null && "ok" in r);
}

export function useRecoveryRestoreSource() {
	const invalidate = useInvalidateRecoveryStatus();
	return useMutation({
		meta: { recovery: true },
		mutationFn: (id: string | "all") =>
			trackProcess(
				{
					title: id === "all" ? "Recovering sources" : "Recovering source",
					body: id === "all" ? "every missing skill source" : id,
					kind: "remote",
					target: `${RECOVERY_SOURCE_TARGET}:${id}`,
				},
				() => recoveryCommand(id === "all" ? ["restore-source", "--all"] : ["restore-source", id]),
				{
					// `ok: false` at the top of THIS payload means "at least one
					// source in this batch failed" — a real, partial outcome (kept,
					// never thrown — see `recoveryCommand`), not a command refusal.
					// The card should say so rather than a bare "Source recovered".
					successBody: (raw) => {
						const results = asRestoreSourceResults(raw);
						const failed = results.filter((r) => !r.ok).length;
						if (results.length === 0) return "Source recovered";
						if (failed === 0) return results.length === 1 ? "Source recovered" : `${results.length} sources recovered`;
						return `${results.length - failed} of ${results.length} recovered — ${failed} still failing`;
					},
					failWhen: (raw) => {
						const results = asRestoreSourceResults(raw);
						const failed = results.filter((r) => !r.ok).length;
						return failed > 0
							? `${failed} of ${results.length} source${results.length === 1 ? "" : "s"} still failing — retry below`
							: null;
					},
				},
			),
		onSettled: invalidate,
	});
}

export function useRecoverySkipSource() {
	const invalidate = useInvalidateRecoveryStatus();
	return useMutation({
		meta: { recovery: true },
		mutationFn: (id: string) => recoveryCommand(["skip-source", id]),
		onSettled: invalidate,
	});
}

export function useRecoverySetLocalSource() {
	const invalidate = useInvalidateRecoveryStatus();
	const qc = useQueryClient();
	return useMutation({
		meta: { recovery: true },
		mutationFn: ({ skill, path }: { skill: string; path: string }) =>
			recoveryCommand(["set-local-source", "--skill", skill, "--path", path]),
		onSettled: () => {
			invalidate();
			void invalidateRegistry(qc);
		},
	});
}

export function useRecoverySkipLocalSource() {
	const invalidate = useInvalidateRecoveryStatus();
	return useMutation({
		meta: { recovery: true },
		mutationFn: ({ skill, reason }: { skill: string; reason?: string }) =>
			recoveryCommand(
				reason
					? ["skip-local-source", "--skill", skill, "--reason", reason]
					: ["skip-local-source", "--skill", skill],
			),
		onSettled: invalidate,
	});
}

export const RECOVERY_SYNC_TARGET = "recovery:sync";

export function useRecoverySync() {
	const invalidate = useInvalidateRecoveryStatus();
	const qc = useQueryClient();
	return useMutation<RecoverySyncResult>({
		meta: { recovery: true },
		mutationFn: () =>
			trackProcess(
				{
					title: "Syncing",
					body: "delivering attached projects locally",
					kind: "fs",
					target: RECOVERY_SYNC_TARGET,
				},
				async () => toSyncResult(await recoveryCommand(["sync"])),
				{
					successBody: (r) =>
						`${r.counts.success} synced · ${r.counts.skipped} skipped · ${r.counts.failed} failed`,
					// A sync that delivered SOME projects and failed others is a
					// partial result the caller must still receive (the promise
					// resolves; `RecoverySyncStep` renders the counts either way) —
					// `failWhen` only decides whether the process card reads as a
					// success or a failure, never whether the data comes back.
					failWhen: (r) =>
						r.error
							? r.error
							: r.counts.failed > 0
								? `${r.counts.failed} project${r.counts.failed === 1 ? "" : "s"} failed to sync`
								: r.globalFailures.length > 0 ? r.globalFailures.join(" · ") : !r.ok ? "Local sync failed" : null,
				},
			),
		onSettled: () => {
			invalidate();
			void invalidateRegistry(qc);
		},
	});
}
