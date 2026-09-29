import { HeadlessMachineDetail } from "@/components/remotes/HeadlessMachineDetail";
import { useMachines } from "@/hooks/useHeadlessMachines";
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { invoke } from "@/lib/ipc";
import { trackProcess } from "@/lib/trackProcess";

import { Button } from "@/components/Button";
import { LoadingButton } from "@/components/loading/LoadingButton";
import { EmptyState } from "@/components/EmptyState";
import { Icon } from "@/components/Icon";
import { ScreenHeader } from "@/components/ScreenHeader";
import { SectionHeader } from "@/components/SectionHeader";
import { Tag } from "@/components/Tag";
import { useToast } from "@/components/Toast";
import { useRegistry } from "@/hooks/useRegistry";
import { useRemotes, useRemoteHealth, useRemoteDoctor } from "@/hooks/useRemotes";
import { RemoteDoctorBanner } from "@/components/remotes/RemoteDoctorFindings";
import { classifyRemoteHealth } from "@/lib/remoteHealth";
import { resolveTargetSkills } from "@/lib/resolveActiveSkills";
import { queryClient } from "@/lib/queryClient";
import { qk } from "@/lib/queryKeys";
import { invalidateRegistry } from "@/lib/invalidate";
import type { HubResult, RemoteListEntry } from "@/types";
import { RemoteDetail } from "@/components/remotes/RemoteDetail";
import { AddRemoteWizard } from "@/components/remotes/AddRemoteWizard";
import { CloudAppsSection } from "@/components/cloud/CloudAppsSection";
import { CONNECTOR_LABELS } from "@/components/remotes/connectors";
import { clickSink } from "@/lib/pressable";

/** Invalidate everything a remote mutation can touch (its own views + the
 *  registry, since add/remove rewrite `remotes:`). */
export async function invalidateRemotes(id?: string) {
	await queryClient.invalidateQueries({ queryKey: qk.remotes.list() });
	await invalidateRegistry(queryClient);
	// A remediation (sync / resolve / re-pin) can change the risk picture, so mark
	// the doctor rollup stale too. It refetches for the ACTIVE list observer
	// (enabled there) and is left stale for the detail view — whose observer is
	// disabled (F1), so this never re-triggers the expensive per-remote SSH sweep
	// off a background equip; the detail re-reads fresh findings on its next
	// explicit Re-check.
	await queryClient.invalidateQueries({ queryKey: qk.remotes.doctor() });
	if (id) await queryClient.invalidateQueries({ queryKey: qk.remotes.all(id) });
}

export function RemotesScreen() {
	const { id } = useParams<{ id: string }>();
	const navigate = useNavigate();
	const [searchParams, setSearchParams] = useSearchParams();
	const { data: allRemotes, isLoading, error } = useRemotes();
  const machines = useMachines();
  const machineIds = new Set(machines.data?.map(machine => machine.id) || []);
  const remotes = allRemotes?.filter(remote => remote.connector !== "headless-loadouts" && !machineIds.has(remote.id));
	const [wizardOpen, setWizardOpen] = useState(false);

	// `?add=1` (the navigator's elsewhere-group "Add remote" row): open the
	// wizard and strip the param, mirroring Sources.tsx's `?add=1` handling.
	useEffect(() => {
		if (searchParams.get("add") === "1") {
			setWizardOpen(true);
			const next = new URLSearchParams(searchParams);
			next.delete("add");
			setSearchParams(next, { replace: true });
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [searchParams]);
	// Aggregate risk rollup — background/non-blocking (runs only when there are
	// remotes to check); a danger finding (e.g. host-key mismatch) surfaces a
	// banner without slowing the list render.
	const { data: doctor } = useRemoteDoctor(!!remotes && remotes.length > 0 && !id);

	// Detail route: render the per-remote detail.
	if (id) {
    if (isLoading || machines.isLoading) return <p className="screen-pad">Loading remote…</p>;
    if (machineIds.has(id) || allRemotes?.some(remote => remote.id === id && remote.connector === "headless-loadouts")) {
      return <HeadlessMachineDetail id={id} onBack={() => navigate("/remotes")} />;
    }
    if (machines.isError && !allRemotes?.some(remote => remote.id === id)) return <div className="screen-pad"><p role="alert">Could not identify this machine.</p><Button onClick={() => void machines.refetch()}>Retry</Button></div>;
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
				icon="remote"
				title="Remotes"
				meta={<Tag size="sm">{(remotes?.length ?? 0) + (machines.data?.length ?? 0)} configured</Tag>}
				subline="Off-machine surfaces · boxes sync over SSH, cloud apps take a manual ZIP upload"
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
				) : (!remotes || remotes.length === 0) && !machines.isLoading && !machines.isError && !machines.data?.length ? (
					<EmptyState
						icon="remote"
						title="No remotes yet"
						description="Connect a remote agent box or set up a headless machine to follow project loadouts."
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
					<>
						{doctor && (
							<RemoteDoctorBanner
								findings={doctor.findings}
								onOpenRemote={(rid) =>
									navigate(`/remote/${encodeURIComponent(rid)}`)
								}
							/>
						)}
						<SectionHeader label="Remote boxes" count={remotes?.length ?? 0} />
						<div className="remotes-grid">
							{remotes?.map((r) => (
								<RemoteCard
									key={r.id}
									remote={r}
									onOpen={() =>
										navigate(`/remote/${encodeURIComponent(r.id)}`)
									}
								/>
							))}
						</div>
					</>
				)}

				{/* Cloud apps are NOT remotes (nothing connects), but they answer the
				    same question and are reached rarely enough not to earn a rail slot
				    of their own — so they band in under the boxes. */}
				<SectionHeader label="Headless machines" count={machines.data?.length ?? 0} />
        {machines.isError ? <div role="alert"><p>Could not load machine drafts.</p><Button variant="ghost" onClick={() => void machines.refetch()}>Retry machines</Button></div> :
          <div className="remotes-grid">{machines.data?.map(machine => <div className="remote-card" key={machine.id}>
            <div className="remote-card-head"><strong>{machine.id}</strong><Tag size="sm">{machine.phase.replace(/_/g, " ")}</Tag></div>
            <p>{machine.draft?.input.ssh_host || "Connection incomplete"}</p>
            <Button variant="ghost" onClick={() => navigate(`/remote/${encodeURIComponent(machine.id)}`)}>Open machine</Button>
          </div>)}</div>}
        <CloudAppsSection />
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
	// The SSH health probe is EXPENSIVE (a round-trip per card) and only cached
	// 30s, so we no longer fire it eagerly on mount — a list of N remotes would
	// burst N simultaneous SSH connects and pin every card on a fake "checking…"
	// until each resolved (B1-01). Instead the card renders instantly with an
	// honest "not checked" chip; the user (or the aggregate doctor) triggers the
	// probe explicitly. `probe` gates the query `enabled` flag.
	const [probe, setProbe] = useState(false);
	const {
		data: health,
		isLoading: healthLoading,
		isFetching: healthFetching,
		isError: healthError,
		error: healthErrorDetail,
		refetch: refetchHealth,
	} = useRemoteHealth(remote.id, probe);
	const healthChip = ((): {
		tone: string;
		label: string;
		title?: string;
		action?: boolean;
	} => {
		// Resting (never probed): an honest "not checked yet" — NOT a fake
		// "checking…". The chip is a button that fires the probe on click.
		if (!probe)
			return {
				tone: "neutral",
				label: "check health",
				title: "Health isn't probed until you ask — click to run a live SSH check.",
				action: true,
			};
		// A failed probe is a stable neutral "check failed" — never a permanent
		// "checking…" (which would only ever mean "still in flight"). It stays a
		// BUTTON (not a dead-end span) so the user can retry the probe (B1 dead-end
		// fix); clicking `refetch`es the health query.
		if (healthError)
			return {
				tone: "neutral",
				label: "check failed — retry",
				title: String(healthErrorDetail),
				action: true,
			};
		if (healthLoading || healthFetching || health === undefined)
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

	// The same resolver the navigator row uses, so the two never disagree.
	const equipCount = useMemo(
		() => resolveTargetSkills(remote, registry).length,
		[remote, registry],
	);

	async function forceSync() {
		setBusy(true);
		try {
			// An SSH push to the box — the longest live process the app runs, so
			// it gets the same card as a registry sync or a source fetch.
			const res = await trackProcess(
				{
					title: `Syncing ${remote.id}`,
					body: "planning + pushing over ssh",
					kind: "remote",
					target: `remote:${remote.id}`,
				},
				() =>
					invoke<HubResult>("remote_sync", {
						id: remote.id,
						force: true,
					}),
				{
					successBody: "remote aligned",
					failWhen: (r) => (r.success ? null : r.output.trim() || "sync failed"),
					retry: () => void forceSync(),
				},
			);
			await invalidateRemotes(remote.id);
			if (res.success) {
				toast.success(`Synced ${remote.id}`, res.output.trim() || undefined);
			} else {
				toast.error("Couldn't sync remote", res.output.trim());
			}
		} catch (e) {
			toast.error("Couldn't sync remote", String(e));
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
					{healthChip.action ? (
						<button
							type="button"
							className="remote-health-chip"
							data-tone={healthChip.tone}
							data-action="check"
							title={healthChip.title || undefined}
							// Safe button reset so the class-controlled tone/bg still win;
							// the CSS writer adds the hover affordance (see report).
							style={{
								appearance: "none",
								border: 0,
								cursor: "pointer",
								display: "inline-flex",
								alignItems: "center",
								gap: 5,
							}}
							onClick={(e) => {
								e.stopPropagation();
								// First click arms the query (enabled); a retry after a
								// failed probe re-fires it via refetch (probe already true).
								if (!probe) setProbe(true);
								else void refetchHealth();
							}}
						>
							<span className="dot" />
							{healthChip.label}
						</button>
					) : (
						<span
							className="remote-health-chip"
							data-tone={healthChip.tone}
							title={healthChip.title || undefined}
						>
							<span className="dot" />
							{healthChip.label}
						</span>
					)}
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

			<div className="remote-card-foot" {...clickSink()}>
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
