import { useEffect, useState } from "react";
import { Field } from "@/components/Field";
import { Button } from "@/components/Button";
import { Sheet } from "@/components/Modal";
import { SearchInput } from "@/components/SearchInput";
import { invoke } from "@/lib/ipc";
import {
	recoveryErrorMessage,
	useRecoveryAttach,
	useRecoveryGithubRepos,
	useRecoveryFetchMoreRepos,
	useRecoverySetRepository,
} from "@/hooks/useRecovery";
import { useAppStore } from "@/store";

type Tab = "github" | "local";

/**
 * A project with no stored repository (PLAN.md's "Project lacks repository"
 * row). Two independent ways to give it one: pick from the authenticated
 * GitHub account (stores an association only — no directory yet), or select
 * an existing local checkout directly (attaches immediately; an unambiguous
 * Git identity found there is adopted, a non-Git folder stays attachable for
 * an existing non-Git project). Search is explicit-submit, never
 * per-keystroke (contract correction: bounded, cached, paginated).
 */
export function RecoveryRepositoryPicker({
	open,
	onClose,
	project,
}: {
	open: boolean;
	onClose: () => void;
	project: string;
}) {
	useEffect(() => {
		const opener = document.activeElement as HTMLElement | null;
		return () => { if (opener?.isConnected) opener.focus(); };
	}, []);
	const [tab, setTab] = useState<Tab>("github");
	const [query, setQuery] = useState("");
	const [submittedQuery, setSubmittedQuery] = useState("");
	const [page, setPage] = useState(1);
	const [localRemote, setLocalRemote] = useState("");
	const [localPath, setLocalPath] = useState<string | null>(null);
	const [localError, setLocalError] = useState<string | null>(null);

	const addToast = useAppStore((s) => s.addToast);
	const repos = useRecoveryGithubRepos(submittedQuery, page, open && tab === "github");
	const fetchMore = useRecoveryFetchMoreRepos();
	const setRepository = useRecoverySetRepository();
	const attach = useRecoveryAttach();

	function reset() {
		setQuery("");
		setSubmittedQuery("");
		setPage(1);
		setLocalPath(null);
		setLocalRemote("");
		setLocalError(null);
		setTab("github");
	}

	function close() {
		reset();
		onClose();
	}

	function submitSearch() {
		setPage(1);
		setSubmittedQuery(query);
	}

	async function selectRepo(url: string) {
		try {
			await setRepository.mutateAsync({ project, url, remote: "origin" });
			close();
		} catch (e) {
			addToast("error", `Couldn't connect that repository — ${recoveryErrorMessage(e)}`);
		}
	}

	async function browseLocal() {
		try {
			const chosen = await invoke<string | null>("pick_directory");
			if (chosen) setLocalPath(chosen);
		} catch (e) {
			addToast("error", `Couldn't open the folder picker — ${recoveryErrorMessage(e)}`);
		}
	}

	async function attachLocal() {
		if (!localPath) return;
		setLocalError(null);
		try {
			await attach.mutateAsync({ project, path: localPath, remote: localRemote.trim() || undefined });
			close();
		} catch (e) {
			setLocalError(recoveryErrorMessage(e));
		}
	}

	const busy = setRepository.isPending || attach.isPending;

	return (
		<Sheet
			open={open}
			onClose={close}
			side="right"
			width={520}
			title={
				<>
					Connect repository: <span className="text-mono">{project}</span>
				</>
			}
			aria-label={`Connect a repository for ${project}`}
			dismissable={!busy}
		>
			<div role="tablist" className="recovery-picker-tabs">
				<button
					type="button"
					role="tab"
					aria-selected={tab === "github"}
					className="recovery-picker-tab"
					disabled={busy}
					onClick={() => setTab("github")}
					data-testid="recovery-picker-tab-github"
				>
					From GitHub
				</button>
				<button
					type="button"
					role="tab"
					aria-selected={tab === "local"}
					className="recovery-picker-tab"
					disabled={busy}
					onClick={() => setTab("local")}
					data-testid="recovery-picker-tab-local"
				>
					Local checkout
				</button>
			</div>

			{tab === "github" ? (
				<div>
					<div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
						<SearchInput
							value={query}
							onChange={setQuery}
							placeholder="Filter your repositories…"
							onKeyDown={(e) => {
								if (e.key === "Enter") submitSearch();
							}}
							inputTestId="recovery-github-search"
						/>
						<Button onClick={submitSearch} disabled={repos.isFetching || busy}>
							Search
						</Button>
					</div>

					{repos.isLoading && <p>Loading repositories…</p>}
					{repos.isError && (
						<p role="alert">Couldn't read your GitHub repositories — {recoveryErrorMessage(repos.error)}</p>
					)}
					{repos.data?.errorKind && (
						<p role="alert">
							{repos.data.errorKind === "unauthenticated"
								? "Not signed in to GitHub — sign in with the gh CLI, or select a local checkout instead."
								: repos.data.errorKind === "gh_unavailable"
									? "The gh CLI isn't available — select a local checkout instead."
									: repos.data.error || "Couldn't list repositories."}
						</p>
					)}

					{(repos.isError || repos.data?.errorKind) && (
						<Button busy={repos.isFetching} onClick={() => void repos.refetch()}>Retry repository list</Button>
					)}

					<div className="recovery-repo-list" data-testid="recovery-repo-list">
						{repos.data?.repositories.map((repo) => (
							<button
								key={repo.fullName}
								type="button"
								className="recovery-repo-row"
								onClick={() => void selectRepo(repo.url)}
								disabled={busy}
								data-testid={`recovery-repo-${repo.fullName}`}
							>
								<span>
									<span className="recovery-repo-name">{repo.fullName}</span>
									<div className="recovery-repo-meta">
										{repo.private ? "Private" : "Public"}
										{repo.defaultBranch ? ` · ${repo.defaultBranch}` : ""}
									</div>
								</span>
							</button>
						))}
						{repos.data && repos.data.repositories.length === 0 && !repos.data.errorKind && (
							<p>No repositories matched.</p>
						)}
					</div>

					{repos.data?.truncated && <div className="recovery-picker-pager">
						<span>More accessible repositories have not been loaded yet.</span>
						<Button busy={fetchMore.isPending} onClick={async () => {
							try { await fetchMore.mutateAsync(); await repos.refetch(); }
							catch (e) { addToast("error", recoveryErrorMessage(e)); }
						}}>Load more repositories</Button>
					</div>}
					{repos.data && (repos.data.page > 1 || repos.data.hasMore) && (
						<div className="recovery-picker-pager">
							<Button
								size="sm"
								variant="ghost"
								disabled={page <= 1 || repos.isFetching}
								onClick={() => setPage((p) => Math.max(1, p - 1))}
							>
								Previous
							</Button>
							<span className="recovery-picker-page-label">Page {repos.data.page}</span>
							<Button
								size="sm"
								variant="ghost"
								disabled={!repos.data.hasMore || repos.isFetching}
								onClick={() => setPage((p) => p + 1)}
							>
								Next
							</Button>
						</div>
					)}
				</div>
			) : (
				<div className="modal-form">
					<p>
						Select the checkout already on this machine. A Git identity found there is adopted
						automatically; a non-Git folder stays attachable too.
					</p>
					<div className="browse-row">
						<button
							type="button"
							className="readonly-value"
							data-empty={!localPath || undefined}
							disabled={busy}
							onClick={() => void browseLocal()}
							title={localPath || "Click to choose a folder"}
						>
							{localPath || "Click Browse to choose a folder…"}
						</button>
						<Button onClick={() => void browseLocal()} disabled={busy}>
							Browse…
						</Button>
					</div>
					<Field label="Git remote, if needed" htmlFor="recovery-local-remote" hint="Choose a remote when the checkout has more than one repository identity.">
						<input id="recovery-local-remote" value={localRemote} disabled={busy}
							onChange={(e) => setLocalRemote(e.target.value)} placeholder="For example, origin" />
					</Field>
					<Button
						variant="primary"
						busy={attach.isPending}
						disabled={!localPath || busy}
						onClick={() => void attachLocal()}
						data-testid="recovery-attach-local-folder"
					>
						Attach this folder
					</Button>
					{localError && (
						<div className="settings-inline-error" role="alert" data-testid="recovery-attach-local-error">
							{localError}
						</div>
					)}
				</div>
			)}
		</Sheet>
	);
}
