import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { invoke } from "@/lib/ipc";

import { Button } from "@/components/Button";
import { LoadingButton } from "@/components/loading/LoadingButton";
import { EmptyState } from "@/components/EmptyState";
import { Icon } from "@/components/Icon";
import { ScreenHeader } from "@/components/ScreenHeader";
import { Tag } from "@/components/Tag";
import { useToast } from "@/components/Toast";
import { useRegistry } from "@/hooks/useRegistry";
import { useRemotes, useRemoteHealth } from "@/hooks/useRemotes";
import { classifyRemoteHealth } from "@/lib/remoteHealth";
import { queryClient } from "@/lib/queryClient";
import type { HubResult, RemoteListEntry } from "@/types";
import { RemoteDetail } from "@/components/remotes/RemoteDetail";
import { AddRemoteWizard } from "@/components/remotes/AddRemoteWizard";
import { CONNECTOR_LABELS } from "@/components/remotes/connectors";

/** Invalidate everything a remote mutation can touch (its own views + the
 *  registry, since add/remove rewrite `remotes:`). */
export async function invalidateRemotes(id?: string) {
	await queryClient.invalidateQueries({ queryKey: ["remotes"] });
	await queryClient.invalidateQueries({ queryKey: ["registry"] });
	if (id) await queryClient.invalidateQueries({ queryKey: ["remote", id] });
}

export function RemotesScreen() {
	const { id } = useParams<{ id: string }>();
	const navigate = useNavigate();
	const { data: remotes, isLoading, error } = useRemotes();
	const [wizardOpen, setWizardOpen] = useState(false);

	// Detail route: render the per-remote detail.
	if (id) {
		const entry = remotes?.find((r) => r.id === id);
		return (
			<RemoteDetail
				id={id}
				entry={entry}
				onBack={() => navigate("/remotes")}
			/>
		);
	}

	return (
		<>
			<ScreenHeader
				leading={<Icon name="remote" size={14} />}
				title="Remotes"
				meta={<Tag size="sm">{remotes?.length ?? 0} configured</Tag>}
				subline="Off-machine agent surfaces · skills, MCP, and agent docs sync to each box"
				primary={
					<Button
						variant="primary"
						icon="plus"
						onClick={() => setWizardOpen(true)}
					>
						Add remote
					</Button>
				}
			/>

			<div className="remotes-screen">
				{error ? (
					<EmptyState
						icon="warning"
						title="Could not load remotes"
						description={String(error)}
					/>
				) : isLoading ? (
					<div className="remotes-loading">Loading remotes…</div>
				) : !remotes || remotes.length === 0 ? (
					<EmptyState
						icon="remote"
						title="No remotes yet"
						description="Connect a remote agent box — a Hermes self-improving agent, a worker pool — to push your equipped skills, MCP servers, and agent docs to it."
						action={
							<Button
								variant="primary"
								icon="plus"
								onClick={() => setWizardOpen(true)}
							>
								Add your first remote
							</Button>
						}
					/>
				) : (
					<div className="remotes-grid">
						{remotes.map((r) => (
							<RemoteCard
								key={r.id}
								remote={r}
								onOpen={() =>
									navigate(`/remote/${encodeURIComponent(r.id)}`)
								}
							/>
						))}
					</div>
				)}
			</div>

			{wizardOpen && (
				<AddRemoteWizard
					onClose={() => setWizardOpen(false)}
					onCreated={async (newId) => {
						setWizardOpen(false);
						await invalidateRemotes(newId);
						navigate(`/remote/${encodeURIComponent(newId)}`);
					}}
				/>
			)}
		</>
	);
}

// ─── List card ────────────────────────────────────────────────────────────────

function RemoteCard({
	remote,
	onOpen,
}: {
	remote: RemoteListEntry;
	onOpen: () => void;
}) {
	const { data: registry } = useRegistry();
	const toast = useToast();
	const [busy, setBusy] = useState(false);
	// Lazy health probe fired when the card renders (off-thread; opening the list
	// stays instant). Chip channel neutral/ok/error — never amber (§5.2).
	const {
		data: health,
		isLoading: healthLoading,
		isError: healthError,
		error: healthErrorDetail,
	} = useRemoteHealth(remote.id);
	const healthChip = ((): { tone: string; label: string; title?: string } => {
		// A failed probe is a stable neutral "check failed" — never a permanent
		// "checking…" (which would only ever mean "still in flight").
		if (healthError)
			return {
				tone: "neutral",
				label: "check failed",
				title: String(healthErrorDetail),
			};
		if (healthLoading || health === undefined)
			return { tone: "neutral", label: "checking…" };
		// One classifier for chip + banner: home_missing / unreachable are NEUTRAL,
		// only auth/host-key failures are RED (§5.2 — never amber for these).
		const v = classifyRemoteHealth(health);
		return {
			tone: v.tone,
			label: v.tone === "ok" ? "reachable" : v.label,
			title: [v.hint, v.detail].filter(Boolean).join(" · ") || undefined,
		};
	})();

	const equipCount = useMemo(() => {
		// Resolved-skill count is best-effort from the registry bundles + enabled.
		const enabled = new Set(remote.enabled);
		const bundles = registry?.bundles ?? {};
		for (const b of remote.bundles) {
			for (const s of bundles[b]?.skills ?? []) enabled.add(s);
		}
		return enabled.size;
	}, [remote, registry]);

	async function forceSync() {
		setBusy(true);
		try {
			const res = await invoke<HubResult>("remote_sync", {
				id: remote.id,
				force: true,
			});
			await invalidateRemotes(remote.id);
			if (res.success) {
				toast.success(`Synced ${remote.id}`, res.output.trim() || undefined);
			} else {
				toast.error(`Sync failed`, res.output.trim());
			}
		} catch (e) {
			toast.error("Sync failed", String(e));
		} finally {
			setBusy(false);
		}
	}

	return (
		<div
			className="remote-card"
			data-sync={remote.sync_enabled ? "on" : "off"}
			onClick={onOpen}
			role="button"
			tabIndex={0}
			onKeyDown={(e) => {
				if (e.key === "Enter" || e.key === " ") onOpen();
			}}
		>
			<div className="remote-card-head">
				<span className="remote-card-glyph">
					<Icon name="remote" size={20} />
				</span>
				<div className="remote-card-id">
					<div className="remote-card-name text-mono">{remote.id}</div>
					<div className="remote-card-sub">
						<span className="text-mono">{remote.connector}</span>
						{remote.ssh_host && (
							<>
								<span className="sep">·</span>
								<span className="text-mono text-dim">{remote.ssh_host}</span>
							</>
						)}
					</div>
				</div>
				<span
					className="remote-sync-pill"
					data-on={remote.sync_enabled || undefined}
					title={
						remote.sync_enabled
							? "Auto-sync on every hub sync"
							: "Excluded from auto-sync"
					}
				>
					<span className="dot" />
					{remote.sync_enabled ? "sync on" : "sync off"}
				</span>
			</div>

			<div className="remote-card-meta">
				<div className="remote-meta-row">
					<span>health</span>
					<span
						className="remote-health-chip"
						data-tone={healthChip.tone}
						title={healthChip.title || undefined}
					>
						<span className="dot" />
						{healthChip.label}
					</span>
				</div>
				<div className="remote-meta-row">
					<span>equipped</span>
					<span className="text-mono">
						{equipCount} skill{equipCount === 1 ? "" : "s"}
					</span>
				</div>
				<div className="remote-meta-row">
					<span>bundles</span>
					<span className="text-mono">
						{remote.bundles.length || "—"}
					</span>
				</div>
			</div>

			<div className="remote-card-foot" onClick={(e) => e.stopPropagation()}>
				<LoadingButton
					variant="soft"
					size="sm"
					icon="sync"
					loading={busy}
					loadingLabel="Syncing…"
					onClick={() => void forceSync()}
				>
					Force sync
				</LoadingButton>
				<Button variant="ghost" size="sm" icon="arrow-right" onClick={onOpen}>
					Open
				</Button>
			</div>
		</div>
	);
}

export { CONNECTOR_LABELS };
