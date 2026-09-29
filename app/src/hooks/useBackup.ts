import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@/lib/ipc";
import { qk } from "@/lib/queryKeys";
import { invalidateRegistry } from "@/lib/invalidate";
import { trackProcess } from "@/lib/trackProcess";
import {
	summarizeBackupResult,
	scrubTokens,
	toRestorePlan,
	type BackupAuth,
	type BackupNowResult,
	type BackupStatus,
	type RestoreMode,
	type RestorePlan,
} from "@/lib/backupContract";

/**
 * React-query layer for the backup surface. Two queries with deliberately
 * different cost profiles:
 *
 * - `useBackupStatus` is cheap (no network dial except the `gh` account check),
 *   so it can back the always-visible StatusBar warning.
 * - `useBackupAuth` walks the full credential ladder — it dials ssh and gh — so
 *   it is only fetched by the Backup screen's auth card, never by the StatusBar.
 */

export const BACKUP_STATUS_KEY = qk.backup.status();
export const BACKUP_AUTH_KEY = qk.backup.auth();

export function useBackupStatus(enabled = true) {
	return useQuery({
		queryKey: BACKUP_STATUS_KEY,
		queryFn: async () => (await invoke<BackupStatus | null>("backup_status")) ?? null,
		enabled,
		// "Cheap" is relative: once `gh_login` is set, `backup status` shells out
		// to `gh` (and `git` for the ahead/behind counts), so a window-focus
		// refetch is a subprocess + a network dial every time the user alt-tabs.
		// The chip it feeds is invalidated explicitly after every backup action.
		refetchOnWindowFocus: false,
	});
}

export function useBackupAuth(enabled = true) {
	return useQuery({
		queryKey: BACKUP_AUTH_KEY,
		queryFn: async () => (await invoke<BackupAuth | null>("backup_auth_status")) ?? null,
		enabled,
		// The ladder shells out to ssh/gh with timeouts; don't re-walk it on
		// every window focus.
		staleTime: 60_000,
		refetchOnWindowFocus: false,
	});
}

/** Invalidate everything the backup surface derives. `["syncReport"]` is
 *  included because the report carries the `global.backup` staleness slot. */
export function useInvalidateBackup() {
	const qc = useQueryClient();
	return () => {
		void qc.invalidateQueries({ queryKey: BACKUP_STATUS_KEY });
		void qc.invalidateQueries({ queryKey: BACKUP_AUTH_KEY });
		void qc.invalidateQueries({ queryKey: qk.syncReport() });
	};
}

/** Process-card target id for a `backup now` run. */
export const BACKUP_TARGET = "backup:now";

/**
 * Take a snapshot and push it.
 *
 * A push is a git round-trip to GitHub — seconds of real network work — so it
 * reports itself through the app's one live-work banner (a process card),
 * exactly like a registry sync or a source fetch. Wrapping it HERE rather than
 * at a button means the maintenance screen, the bootstrap step, the setup
 * journey and the palette's "Back up now" all get the same banner from one
 * definition, and none of them can forget it.
 *
 * `backup now` reports a refused publish in its PAYLOAD rather than by failing,
 * so `failWhen` turns that into a red card instead of a green one that lies.
 */
export function useBackupNow() {
	const invalidate = useInvalidateBackup();
	return useMutation({
		mutationFn: (vars?: {
			noPush?: boolean;
			allowSecret?: string[];
			/** `--acknowledge-restore`: clears `pending_reconcile` so pushes resume.
			 *  Without it the "Acknowledge & back up" button is just a backup. */
			acknowledgeRestore?: boolean;
		}) =>
			trackProcess(
				{
					title: "Backing up",
					body: vars?.noPush ? "committing snapshot" : "committing + pushing snapshot",
					kind: "remote",
					target: BACKUP_TARGET,
				},
				() =>
					invoke<BackupNowResult>("backup_now", {
						noPush: vars?.noPush ?? false,
						allowSecret: vars?.allowSecret ?? [],
						acknowledgeRestore: vars?.acknowledgeRestore ?? false,
					}),
				{
					successBody: summarizeBackupResult,
					failWhen: (r) =>
						r.ok === false || r.error ? summarizeBackupResult(r) : null,
				},
			),
		onSettled: invalidate,
	});
}

export function useBackupSetEnabled() {
	const invalidate = useInvalidateBackup();
	return useMutation({
		mutationFn: (enabled: boolean) =>
			invoke<unknown>(enabled ? "backup_enable" : "backup_disable"),
		onSettled: invalidate,
	});
}

export function useBackupInit() {
	const invalidate = useInvalidateBackup();
	return useMutation({
		mutationFn: (vars: {
			repo?: string;
			remote?: string;
			dir?: string;
			create?: boolean;
		}) => invoke<Record<string, unknown>>("backup_init", vars),
		onSettled: invalidate,
	});
}

/**
 * Store a PAT. The token is passed straight through to the Tauri boundary and
 * is NOT retained: the resolved value is the re-probed auth ladder (which never
 * contains the token), and the mutation is configured so react-query keeps
 * nothing either.
 *
 * That second part is not automatic. A mutation's `variables` — here, the raw
 * token — live on in the MutationCache after it settles, for `gcTime` (5min by
 * default) and are readable by anything holding the client. `gcTime: 0` drops
 * the entry the moment it settles; `retry: false` stops a failed store from
 * being re-sent (and re-held) behind the user's back. A token is not something
 * to keep "just in case".
 */
export function useBackupLoginPat() {
	const invalidate = useInvalidateBackup();
	return useMutation({
		mutationFn: (token: string) => invoke<BackupAuth>("backup_auth_login_pat", { token }),
		gcTime: 0,
		retry: false,
		onSettled: invalidate,
	});
}

export function useBackupLogoutPat() {
	const invalidate = useInvalidateBackup();
	return useMutation({
		mutationFn: () => invoke<BackupAuth>("backup_auth_logout"),
		onSettled: invalidate,
	});
}

/** Process-card target id shared by the restore preview and the apply — they
 *  are two phases of one job and never run at the same time. */
export const RESTORE_TARGET = "backup:restore";

/** Dry-run. Normalizes through the contract adapter so no caller ever touches
 *  the raw M3 payload. */
export function useRestorePreview() {
	return useMutation<RestorePlan, Error, { source: string; mode?: RestoreMode }>({
		mutationFn: ({ source, mode }) =>
			trackProcess(
				{
					title: "Previewing restore",
					body: "fetching + verifying the snapshot",
					kind: "remote",
					target: RESTORE_TARGET,
				},
				async () => {
					const raw = await invoke<unknown>("restore_preview", {
						source,
						mode: mode ?? null,
					}).catch((error: unknown) => { throw new Error(scrubTokens(error)); });
					// The requested source/mode are frozen INTO the plan here, at the
					// one point where they are unambiguously the ones asked for.
					return toRestorePlan(raw, source, mode ?? null);
				},
				{ successBody: "plan ready — nothing written", failWhen: (plan) => plan.error ? scrubTokens(plan.error) : null },
			),
	});
}

/** Destructive apply. Invalidates the whole registry surface on completion —
 *  a restore rewrites registry.yaml wholesale. */
export function useRestoreApply() {
	const qc = useQueryClient();
	const invalidate = useInvalidateBackup();
	return useMutation<
		RestorePlan,
		Error,
		{
			source: string;
			mode?: RestoreMode | null;
			acceptExecutableState?: boolean;
			/** `--trust-new-key`: accept AND pin a signer this machine has not seen. */
			trustNewKey?: boolean;
			force?: boolean;
		}
	>({
		mutationFn: ({ source, mode, acceptExecutableState, trustNewKey, force }) =>
			trackProcess(
				{
					title: "Restoring from snapshot",
					body: "rewriting the registry",
					kind: "fs",
					target: RESTORE_TARGET,
				},
				async () => {
					const raw = await invoke<unknown>("restore_apply", {
						source,
						mode: mode ?? null,
						acceptExecutableState: acceptExecutableState ?? false,
						trustNewKey: trustNewKey ?? false,
						force: force ?? false,
					}).catch((error: unknown) => { throw new Error(scrubTokens(error)); });
					return toRestorePlan(raw, source, mode ?? null);
				},
				// No `retry`: a restore rewrites registry.yaml wholesale. Re-firing
				// it from a toast-sized affordance is not a decision to make in one
				// click — the screen's own flow re-asks for consent.
				{ successBody: "registry restored", failWhen: (plan) => plan.error ? scrubTokens(plan.error) : null },
			),
		onSettled: () => {
			void invalidateRegistry(qc);
			void qc.invalidateQueries({ queryKey: qk.bootstrap() });
			invalidate();
		},
	});
}
