import { useEffect, useState } from "react";
import { Button } from "@/components/Button";
import { Field } from "@/components/Field";
import { Sheet } from "@/components/Modal";
import { invoke } from "@/lib/ipc";
import {
	recoveryErrorMessage,
	useRecoveryAttach,
	useRecoveryClone,
	useRecoveryDiscover,
} from "@/hooks/useRecovery";
import type { RecoveryRepositoryAssociation } from "@/lib/recoveryContract";
import { useAppStore } from "@/store";

/**
 * A project that already has a repository identity (PLAN.md's "Project has
 * repository" row). Three ways to give it a working directory, none of which
 * ever guesses from a folder or project name: search a root the user picks
 * for an identity-matching checkout, clone fresh, or point directly at a
 * checkout (the backend still validates identity and refuses a mismatch —
 * `attach` surfaces that refusal here rather than silently accepting it).
 */
export function RecoveryAttachPicker({
	open,
	onClose,
	project,
	repository,
}: {
	open: boolean;
	onClose: () => void;
	project: string;
	repository: RecoveryRepositoryAssociation;
}) {
	useEffect(() => {
		const opener = document.activeElement as HTMLElement | null;
		return () => { if (opener?.isConnected) opener.focus(); };
	}, []);
	const [roots, setRoots] = useState<string[]>([]);
	const [error, setError] = useState<string | null>(null);
	// Set only on an `ambiguous_remote`/`repository_mismatch` refusal for the
	// DIRECT-selection path — that is the one case the backend hands back a
	// resolvable ask ("pass --remote to choose one") rather than a dead end.
	const [directPath, setDirectPath] = useState<string | null>(null);
	const [directRemote, setDirectRemote] = useState("origin");
	const [cloneDestination, setCloneDestination] = useState<string | null>(null);
	const [cloneBranch, setCloneBranch] = useState("");
	const addToast = useAppStore((s) => s.addToast);

	const discover = useRecoveryDiscover(project, roots, open && roots.length > 0);
	const attach = useRecoveryAttach();
	const clone = useRecoveryClone();
	const busy = attach.isPending || clone.isPending;

	function close() {
		setRoots([]);
		setError(null);
		setDirectPath(null);
		setDirectRemote("origin");
		setCloneDestination(null);
		setCloneBranch("");
		onClose();
	}

	async function addSearchRoot() {
		try {
			const chosen = await invoke<string | null>("pick_directory");
			if (chosen && !roots.includes(chosen)) setRoots((r) => [...r, chosen]);
		} catch (e) {
			addToast("error", `Couldn't open the folder picker — ${recoveryErrorMessage(e)}`);
		}
	}

	async function attachMatch(path: string, matchedRemote: string) {
		setError(null);
		try {
			await attach.mutateAsync({ project, path, remote: matchedRemote });
			close();
		} catch (e) {
			setError(recoveryErrorMessage(e));
		}
	}

	async function pickDirectSelection() {
		setError(null);
		try {
			const chosen = await invoke<string | null>("pick_directory");
			if (chosen) setDirectPath(chosen);
		} catch (e) {
			addToast("error", `Couldn't open the folder picker — ${recoveryErrorMessage(e)}`);
		}
	}

	// A separate action from the pick itself — an `ambiguous_remote` refusal
	// (or the user just wanting a different remote) must be retryable without
	// re-browsing for the same folder.
	async function attachDirectSelection() {
		if (!directPath) return;
		setError(null);
		try {
			await attach.mutateAsync({
				project,
				path: directPath,
				remote: directRemote.trim() || undefined,
			});
			close();
		} catch (e) {
			setError(recoveryErrorMessage(e));
		}
	}

	async function pickCloneDestination() {
		try {
			const chosen = await invoke<string | null>("pick_directory");
			if (chosen) setCloneDestination(chosen);
		} catch (e) {
			addToast("error", `Couldn't open the folder picker — ${recoveryErrorMessage(e)}`);
		}
	}

	async function cloneToDestination() {
		if (!cloneDestination) return;
		setError(null);
		try {
			await clone.mutateAsync({
				project,
				destination: cloneDestination,
				branch: cloneBranch.trim() || undefined,
			});
			close();
		} catch (e) {
			setError(recoveryErrorMessage(e));
		}
	}

	const discoverError = discover.isError
		? recoveryErrorMessage(discover.error)
		: (discover.data?.error ?? null);

	return (
		<Sheet
			open={open}
			onClose={close}
			side="right"
			width={520}
			title={
				<>
					Attach checkout: <span className="text-mono">{project}</span>
				</>
			}
			aria-label={`Attach a local checkout for ${project}`}
			dismissable={!busy}
		>
			<div className="modal-form">
				<p>
					Repository: <span className="text-mono">{repository.url}</span>
				</p>

				<section>
					<h4>Search a folder for a matching checkout</h4>
					<p className="settings-help">
						Only checkouts of this exact repository are offered — never a match by folder or
						project name.
					</p>
					<Button onClick={() => void addSearchRoot()} disabled={busy}>
						Search a folder…
					</Button>
					{roots.length > 0 && <p className="recovery-row-path">Searching: {roots.join(", ")}</p>}
					{discover.isFetching && <p>Searching…</p>}
					{discoverError && (
						<div className="settings-inline-error" role="alert">
							{discoverError}
						</div>
					)}
					{!discoverError && discover.data && discover.data.matches.length === 0 && (
						<p>No matching checkout found under {roots[roots.length - 1]}.</p>
					)}
					{discover.data && discover.data.matches.length > 0 && (
						<div className="recovery-repo-list" data-testid="recovery-discover-matches">
							{discover.data.matches.map((m) => (
								<button
									key={m.path}
									type="button"
									className="recovery-repo-row"
									disabled={busy}
									onClick={() => void attachMatch(m.path, m.matchedRemote)}
									data-testid={`recovery-discover-match-${m.path}`}
								>
									<span>
										<span className="recovery-repo-name">{m.path}</span>
										<div className="recovery-repo-meta">
											{m.isWorktree ? "Linked worktree" : "Checkout"} · remote {m.matchedRemote}
										</div>
									</span>
								</button>
							))}
						</div>
					)}
				</section>

				<section>
					<h4>Clone into a new folder</h4>
					<Button onClick={() => void pickCloneDestination()} disabled={busy}>
						Choose a destination…
					</Button>
					{cloneDestination && (
						<>
							{/* Explicit review before anything runs — a clone is a network
							    write, and the destination must be visible, not just implied
							    by whatever the last picker dialog returned. */}
							<dl className="settings-details" data-testid="recovery-clone-review">
								<div>
									<dt>Repository</dt>
									<dd>
										<code>{repository.url}</code>
									</dd>
								</div>
								<div>
									<dt>Destination</dt>
									<dd>
										<code>{cloneDestination}</code>
									</dd>
								</div>
							</dl>
							<Field
								label="Branch (optional)"
								htmlFor={`recovery-clone-branch-${project}`}
								hint="Leave blank for the repository's default branch."
							>
								<input
									id={`recovery-clone-branch-${project}`}
									type="text"
									className="text-mono"
									value={cloneBranch}
									disabled={busy}
									onChange={(e) => setCloneBranch(e.target.value)}
								/>
							</Field>
							<Button
								variant="primary"
								busy={clone.isPending}
								disabled={busy}
								onClick={() => void cloneToDestination()}
								data-testid="recovery-clone-btn"
							>
								Clone here
							</Button>
						</>
					)}
				</section>

				<section>
					<h4>Select a local checkout directly</h4>
					<p className="settings-help">
						The folder's identity must match this repository, or the attach is refused.
					</p>
					<Button
						variant="ghost"
						onClick={() => void pickDirectSelection()}
						disabled={busy}
						data-testid="recovery-attach-direct-btn"
					>
						Browse…
					</Button>
					{directPath && (
						<>
							<p className="recovery-row-path">{directPath}</p>
							{/* Always offered, not only after an `ambiguous_remote` refusal
							    — asking a second time after a failure is a dead end if the
							    control that would fix it only appears post-failure. */}
							<Field
								label="Git remote"
								htmlFor={`recovery-attach-remote-${project}`}
								hint="Usually origin. Only matters if the folder has more than one remote."
							>
								<input
									id={`recovery-attach-remote-${project}`}
									type="text"
									className="text-mono"
									value={directRemote}
									disabled={busy}
									onChange={(e) => setDirectRemote(e.target.value)}
								/>
							</Field>
							<Button
								busy={attach.isPending}
								disabled={busy}
								onClick={() => void attachDirectSelection()}
								data-testid="recovery-attach-direct-confirm"
							>
								Attach this folder
							</Button>
						</>
					)}
				</section>

				{error && (
					<div className="settings-inline-error" role="alert" data-testid="recovery-attach-error">
						{error}
					</div>
				)}
			</div>
		</Sheet>
	);
}
