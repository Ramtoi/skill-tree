import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { invoke } from "@/lib/ipc";

import { Button } from "@/components/Button";
import { LoadingButton } from "@/components/loading/LoadingButton";
import { Spinner } from "@/components/loading/Spinner";
import { BundleChip } from "@/components/BundleChip";
import { bundleColor } from "@/components/bundleColors";
import { EmptyState } from "@/components/EmptyState";
import { Icon } from "@/components/Icon";
import { ScreenHeader } from "@/components/ScreenHeader";
import { SectionHeader } from "@/components/SectionHeader";
import { SkillRow } from "@/components/SkillRow";
import { StatePill } from "@/components/StatePill";
import { Tag } from "@/components/Tag";
import { useToast } from "@/components/Toast";
import { ConfirmDialog } from "@/components/Modal";
import { EquipPicker } from "@/components/EquipPicker";
import { useRemoteEquip } from "@/hooks/useEquip";
import {
	buildRemoteBundleTargets,
	buildRemoteSkillTargets,
} from "@/hooks/useEquipTargets";
import { useRegistry } from "@/hooks/useRegistry";
import {
	useRemoteDiff,
	useRemoteDocs,
	useRemoteImportScan,
	useRemoteSetApplyGlobal,
	useRemoteShow,
} from "@/hooks/useRemotes";
import type {
	HubResult,
	RemoteDiffAction,
	RemoteListEntry,
} from "@/types";
import { invalidateRemotes } from "@/screens/RemotesScreen";
import {
	DriftBadge,
	driftMeta,
	humanizeAction,
	needsResolve,
	resolveActionKey,
	type ResolveOp,
} from "./DriftBadge";
import { RemoteDocEditor } from "./RemoteDocEditor";

interface Props {
	id: string;
	entry?: RemoteListEntry;
	onBack: () => void;
}

export function RemoteDetail({ id, entry, onBack }: Props) {
	const navigate = useNavigate();
	const { data: registry } = useRegistry();
	const { data: show } = useRemoteShow(id);
	const [equipKind, setEquipKind] = useState<null | "bundle" | "skill">(null);
	const onBundleEquip = useRemoteEquip(id, "bundle");
	const onSkillEquip = useRemoteEquip(id, "skill");
	const { data: diff, isLoading: diffLoading, refetch: refetchDiff } =
		useRemoteDiff(id);
	const {
		data: liveDocs,
		isLoading: docsLoading,
		refetch: refetchDocs,
	} = useRemoteDocs(id);
	const toast = useToast();
	const [busy, setBusy] = useState(false);
	// Which specific action is in-flight (e.g. "sync", "resolve:agent_doc:MEMORY.md:pull",
	// "import:foo"). `busy` locks the whole surface; `pending` tells exactly ONE control to
	// show its spinner so the user sees what they clicked react, not every button at once.
	const [pending, setPending] = useState<string | null>(null);
	const [confirm, setConfirm] = useState<null | "remove" | "clear">(null);
	// Import scan is LAZY: opening a remote is instant; the user kicks the scan
	// (one SSH `find` call) on demand. `scanOn` flips the query enabled.
	const [scanOn, setScanOn] = useState(false);
	const {
		data: scan,
		isFetching: scanLoading,
		refetch: refetchScan,
	} = useRemoteImportScan(id, scanOn);

	const syncEnabled = show?.sync_enabled ?? entry?.sync_enabled ?? true;
	// D15: per-remote opt-in for inheriting global-scope bundle skills (default
	// off). Flipping it re-resolves the EQUIPPED list (the mutation invalidates
	// the registry + remote queries via `invalidateRemotes`).
	const applyGlobal =
		show?.apply_global_bundles ?? entry?.apply_global_bundles ?? false;
	const setApplyGlobal = useRemoteSetApplyGlobal(id);
	function toggleApplyGlobal() {
		setApplyGlobal.mutate(!applyGlobal, {
			onSuccess: (res) => {
				if (res.success)
					toast.success(
						applyGlobal
							? "Global skills off"
							: "Global skills on",
						res.output.trim() || undefined,
					);
				else toast.error("Command failed", res.output.trim());
			},
			onError: (e) => toast.error("Command failed", String(e)),
		});
	}

	// Health: the diff command returns a health shape (`ok` present, no actions)
	// when the remote is not ready; otherwise a ready remote IS healthy.
	const health = useMemo(() => {
		if (!diff)
			return { tone: "neutral", label: "checking…", detail: "", alert: false };
		if (diff.actions !== undefined)
			return { tone: "ok", label: "connected", detail: "", alert: false };
		if (diff.ok === false)
			// §5.2 channels: unreachable/not-ready is a neutral absence, an
			// auth/credential failure is a red error — never amber. Both warrant
			// the banner (`alert`), decoupled from the display label.
			return {
				tone: diff.reachable === false ? "neutral" : "error",
				label: diff.reachable === false ? "unreachable" : "not ready",
				detail: diff.detail ?? "",
				alert: true,
			};
		return { tone: "neutral", label: "unknown", detail: "", alert: false };
	}, [diff]);

	const actions = diff?.actions ?? [];
	const mcpActions = actions.filter((a) => a.kind === "mcp");
	const docActions = actions.filter((a) => a.kind === "agent_doc");
	const driftItems = actions.filter((a) => needsResolve(a.drift));

	// The Agent-docs section lists the LIVE docs present on the box (from
	// `remote_list_docs`) — independent of the diff plan — so SOUL/MEMORY/USER
	// surface for a freshly-opened remote even with nothing queued. Any pending
	// diff doc-action is overlaid so drift status still shows. Falls back to the
	// diff doc-actions alone when the live listing is unavailable.
	const docRows = useMemo(() => {
		const byName = new Map<string, RemoteDiffAction>();
		for (const a of docActions) byName.set(a.name, a);
		const present = (liveDocs?.docs ?? []).filter((d) => d.present);
		if (present.length === 0) return docActions;
		return present.map(
			(d): RemoteDiffAction =>
				byName.get(d.name) ?? {
					name: d.name,
					kind: "agent_doc",
					action: "noop",
					drift: "in-sync",
				},
		);
	}, [liveDocs, docActions]);

	async function runHub(
		cmd: string,
		args: Record<string, unknown>,
		okMsg: string,
		actionKey?: string,
	) {
		setBusy(true);
		setPending(actionKey ?? cmd);
		try {
			const res = await invoke<HubResult>(cmd, args);
			await invalidateRemotes(id);
			await refetchDiff();
			if (res.success) toast.success(okMsg, res.output.trim() || undefined);
			else toast.error("Command failed", res.output.trim());
			return res.success;
		} catch (e) {
			toast.error("Command failed", String(e));
			return false;
		} finally {
			setBusy(false);
			setPending(null);
		}
	}

	const resolvedSkills = show?.resolved_skills ?? [];

	return (
		<>
			<ScreenHeader
				back={{ label: "Remotes", onClick: onBack }}
				nameMono={id}
				meta={
					<>
						{show && <Tag size="sm">{show.connector}</Tag>}
						<span
							className="remote-health-chip"
							data-tone={health.tone}
							title={health.detail || undefined}
						>
							<span className="dot" />
							{health.label}
						</span>
					</>
				}
				state={
					!syncEnabled ? (
						<StatePill state="info" icon="power">
							SYNC OFF
						</StatePill>
					) : undefined
				}
				subline={show?.ssh_host ?? undefined}
				primary={
					<LoadingButton
						variant="primary"
						icon="sync"
						loading={pending === "sync"}
						loadingLabel="Syncing…"
						disabled={busy}
						onClick={() =>
							void runHub(
								"remote_sync",
								{ id, force: true },
								`Synced ${id}`,
								"sync",
							)
						}
					>
						Force sync
					</LoadingButton>
				}
				overflow={[
					syncEnabled
						? {
								label: "Disable auto-sync",
								icon: "power",
								onClick: () =>
									void runHub(
										"remote_disable",
										{ id },
										`${id} sync disabled`,
									),
							}
						: {
								label: "Enable auto-sync",
								icon: "power",
								onClick: () =>
									void runHub(
										"remote_enable",
										{ id },
										`${id} sync enabled`,
									),
							},
					{
						label: "Clear ownership (forget sidecars)",
						icon: "unequip",
						onClick: () => setConfirm("clear"),
					},
					{
						label: "Remove remote",
						icon: "trash",
						danger: true,
						onClick: () => setConfirm("remove"),
					},
				]}
			/>

			<div className="remote-detail">
				{health.alert ? (
					<div className="remote-health-banner" data-tone={health.tone}>
						<Icon name="warning" size={13} />
						<span>
							<strong>{health.label}.</strong>{" "}
							{health.detail ||
								"Run through the wizard's host-key + credential steps, then retry."}
						</span>
					</div>
				) : null}

				{/* ── Equipped surface ── */}
				<section className="remote-section">
					<SectionHeader
							label="Equipped"
							count={resolvedSkills.length}
							right={
								<>
								<Button
									variant={equipKind ? "primary" : "soft"}
									size="sm"
									icon="equip"
									onClick={() =>
										setEquipKind((k) => (k ? null : "bundle"))
									}
								>
									{equipKind ? "Done" : "Equip…"}
								</Button>
								<button
									type="button"
									className="remote-applyglobal-toggle"
									data-on={applyGlobal || undefined}
									disabled={busy || setApplyGlobal.isPending}
									aria-pressed={applyGlobal}
									title={
										applyGlobal
											? "This remote inherits your global-scope bundle skills. Click to stop inheriting."
											: "This remote does NOT inherit your global bundles — only its own. Click to opt in."
									}
									onClick={toggleApplyGlobal}
								>
									{setApplyGlobal.isPending ? (
										<Spinner size={11} />
									) : (
										<span className="dot" />
									)}
									{setApplyGlobal.isPending
										? "Working…"
										: applyGlobal
											? "Global skills on"
											: "Global skills off"}
								</button>
								</>
							}
						/>
					{equipKind && registry && (
						<div className="remote-equip-panel">
							<div className="remote-equip-tabs">
								<button
									type="button"
									data-active={equipKind === "bundle" || undefined}
									onClick={() => setEquipKind("bundle")}
								>
									Bundles
								</button>
								<button
									type="button"
									data-active={equipKind === "skill" || undefined}
									onClick={() => setEquipKind("skill")}
								>
									Skills
								</button>
							</div>
							{equipKind === "bundle" ? (
								<EquipPicker
									variant="inline"
									subject={{ kind: "remote", name: id }}
									targets={buildRemoteBundleTargets(
										{ bundles: show?.bundles ?? [] },
										registry,
									)}
									onToggle={onBundleEquip}
									searchPlaceholder="Equip bundle on remote…"
									emptyLabel="No bundles defined."
								/>
							) : (
								<EquipPicker
									variant="inline"
									subject={{ kind: "remote", name: id }}
									targets={buildRemoteSkillTargets(
										{
											bundles: show?.bundles ?? [],
											enabled: show?.enabled ?? [],
										},
										registry,
									)}
									onToggle={onSkillEquip}
									searchPlaceholder="Equip skill on remote…"
									emptyLabel="No skills in the registry."
								/>
							)}
						</div>
					)}
					{show && show.bundles.length > 0 && (
						<div className="remote-bundle-strip">
							{show.bundles.map((b) => (
								<BundleChip
									key={b}
									name={b}
									icon={registry?.bundles?.[b]?.icon ?? "📦"}
									count={registry?.bundles?.[b]?.skills.length}
									color={bundleColor(b)}
								/>
							))}
						</div>
					)}
					{resolvedSkills.length === 0 ? (
						<EmptyState
							icon="equip"
							title="Nothing equipped"
							description="Click Equip… to add bundles or skills to this remote. Changes apply to the registry and reconcile on the next sync."
							action={
								<Button
									variant="primary"
									icon="equip"
									onClick={() => setEquipKind("bundle")}
								>
									Equip bundles or skills
								</Button>
							}
						/>
					) : (
						<div className="remote-skill-list">
							{resolvedSkills.map((name) => {
								const skill = registry?.skills?.[name];
								if (!skill || !registry) {
									return (
										<div className="remote-skill-orphan" key={name}>
											<Icon name="warning" size={12} />
											<span className="text-mono">{name}</span>
											<span className="text-dim">not in registry</span>
										</div>
									);
								}
								return (
									<SkillRow
										key={name}
										name={name}
										skill={skill}
										registry={registry}
										onClick={() =>
											navigate(`/skill/${encodeURIComponent(name)}`)
										}
									/>
								);
							})}
						</div>
					)}
				</section>

				{/* ── Drift / conflict surface ── */}
				<section className="remote-section">
					<SectionHeader
						label="Sync status"
						count={actions.length}
						right={
							<LoadingButton
								variant="ghost"
								size="sm"
								icon="refresh"
								loading={diffLoading}
								loadingLabel="Checking…"
								disabled={busy}
								onClick={() => void refetchDiff()}
							>
								Re-check
							</LoadingButton>
						}
					/>
					{diff?.actions === undefined ? (
						<EmptyState
							icon="warning"
							title="No plan available"
							description={
								diff?.detail ||
								"The remote is not reachable/ready, so its drift plan can't be computed."
							}
						/>
					) : actions.length === 0 ? (
						<EmptyState
							icon="state.ok"
							title="Everything in sync"
							description="No artifacts to push and no drift detected on the box."
						/>
					) : (
						<>
							{driftItems.length > 0 && (
								<div className="remote-drift-callout">
									<Icon name="warning" size={12} />
									<span>
										{driftItems.length} artifact
										{driftItems.length === 1 ? "" : "s"} need
										{driftItems.length === 1 ? "s" : ""} a decision —
										auto-sync never clobbers drift or conflicts.
									</span>
								</div>
							)}
							<div className="remote-drift-list">
								{actions.map((a) => (
									<DriftRow
										key={`${a.kind}:${a.name}`}
										action={a}
										remoteId={id}
										busy={busy}
										pending={pending}
										onResolve={(op) =>
											void runHub(
												"remote_resolve",
												{
													id,
													artifact: a.name,
													op,
													kind: a.kind,
												},
												`Resolved ${a.name} (${op})`,
												resolveActionKey(a.kind, a.name, op),
											)
										}
									/>
								))}
							</div>
						</>
					)}
				</section>

				{/* ── MCP surface (compact, when present) ── */}
				{mcpActions.length > 0 && (
					<section className="remote-section">
						<SectionHeader label="MCP servers" count={mcpActions.length} />
						<div className="remote-drift-list">
							{mcpActions.map((a) => (
								<DriftRow
									key={`mcp:${a.name}`}
									action={a}
									remoteId={id}
									busy={busy}
									pending={pending}
									onResolve={(op) =>
										void runHub(
											"remote_resolve",
											{ id, artifact: a.name, op, kind: "mcp" },
											`Resolved ${a.name} (${op})`,
											resolveActionKey("mcp", a.name, op),
										)
									}
								/>
							))}
						</div>
					</section>
				)}

				{/* ── Agent-docs editor (SOUL / MEMORY / USER) ── */}
				<section className="remote-section">
					<SectionHeader
						label="Agent docs"
						count={docRows.length}
						right={
							<LoadingButton
								variant="ghost"
								size="sm"
								icon="refresh"
								loading={docsLoading}
								loadingLabel="Reading…"
								disabled={busy}
								onClick={() => void refetchDocs()}
							>
								Re-read
							</LoadingButton>
						}
					/>
					<RemoteDocEditor
						remoteId={id}
						docs={docRows}
						busy={busy}
						pending={pending}
						onResolve={(name, op) =>
							void runHub(
								"remote_resolve",
								{ id, artifact: name, op, kind: "agent_doc" },
								`Resolved ${name} (${op})`,
								resolveActionKey("agent_doc", name, op),
							)
						}
						onChanged={() => {
							void refetchDiff();
							void refetchDocs();
						}}
					/>
				</section>

				{/* ── Import candidates (box-native skills) — LAZY scan ── */}
				<section className="remote-section">
					<SectionHeader
						label="Import candidates"
						count={scanOn ? scan?.candidates.length ?? 0 : undefined}
						right={
							<LoadingButton
								variant="ghost"
								size="sm"
								icon="source"
								loading={scanLoading}
								loadingLabel="Scanning…"
								disabled={busy}
								onClick={() => {
									if (!scanOn) setScanOn(true);
									else void refetchScan();
								}}
							>
								{scanOn ? "Re-scan" : "Scan for importable skills"}
							</LoadingButton>
						}
					/>
					{!scanOn ? (
						<EmptyState
							icon="source"
							title="Scan the box for importable skills"
							description="Box-native skills (authored on the box, never hub-managed) aren't fetched until you scan — one SSH call, so opening a remote stays instant. Click Scan to list them, labeled by origin, ready to adopt."
						/>
					) : !scan || scan.candidates.length === 0 ? (
						<EmptyState
							icon="source"
							title="No box-native skills to import"
							description="Skills authored directly on the box (never hub-managed) appear here, labeled by origin, ready to adopt."
						/>
					) : (
						<div className="remote-import-list">
							{scan.candidates.map((c) => (
								<div
									className="remote-import-row"
									key={c.name}
									data-cat={c.category}
								>
									<Icon name="skill" size={13} />
									<span className="name text-mono">{c.name}</span>
									<Tag size="sm" color="var(--amber)" kind="outline">
										{c.origin}
									</Tag>
									{c.category === "INVALID_NAME" && (
										<span className="text-dim">invalid name</span>
									)}
									{c.category === "ALREADY_REGISTERED" && (
										<span className="text-dim">already registered</span>
									)}
									<span className="spacer" />
									<LoadingButton
										variant="soft"
										size="sm"
										icon="equip"
										loading={pending === `import:${c.name}`}
										loadingLabel="Importing…"
										disabled={busy || c.category !== "NEW"}
										onClick={() =>
											void runHub(
												"remote_import_skill",
												{ id, name: c.name },
												`Imported ${c.name}`,
												`import:${c.name}`,
											)
										}
									>
										Import
									</LoadingButton>
								</div>
							))}
						</div>
					)}
				</section>
			</div>

			{confirm && (
				<ConfirmDialog
				open
				title={
					confirm === "remove"
					? `Remove remote “${id}”?`
					: `Clear ownership of “${id}”?`
				}
				confirmLabel={confirm === "remove" ? "Remove" : "Clear"}
				tone="danger"
				confirmIcon={confirm === "remove" ? "trash" : "unequip"}
				onClose={() => setConfirm(null)}
				onConfirm={async () => {
						const c = confirm;
						setConfirm(null);
						const ok = await runHub(
							c === "remove" ? "remote_remove" : "remote_clear",
							{ id },
							c === "remove" ? `Removed ${id}` : `Cleared ${id}`,
						);
						if (ok && c === "remove") onBack();
					}}
				body={
					<>
						{confirm === "remove" ? (
								<p>
									Drops the registry entry and its ownership sidecars. The remote
									box is <strong>not</strong> touched — its files stay exactly as
									they are.
								</p>
								) : (
									<p>
										Forgets hub ownership of this remote's artifacts (clears
											sidecars). The registry entry stays; the box is not touched.
										Cleanup becomes a no-op until the next push re-establishes
										ownership.
									</p>
									)}

							</>
							}
						/>
			)}
		</>
	);
}

// ─── One drift/plan row with status + resolve actions ─────────────────────────

function DriftRow({
	action,
	remoteId: _remoteId,
	busy,
	pending,
	onResolve,
}: {
	action: RemoteDiffAction;
	remoteId: string;
	busy: boolean;
	pending: string | null;
	onResolve: (op: ResolveOp) => void;
}) {
	const resolvable = needsResolve(action.drift);
	const m = driftMeta(action.drift);
	// Loading key must match the one RemoteDetail.runHub stamps for this row+op.
	const loadingFor = (op: ResolveOp) =>
		pending === resolveActionKey(action.kind, action.name, op);
	return (
		<div className="remote-drift-row" data-tone={m.tone}>
			<Icon
				name={action.kind === "skill" ? "skill" : action.kind === "mcp" ? "mcp" : "doc"}
				size={13}
			/>
			<span className="name text-mono">{action.name}</span>
			<DriftBadge status={action.drift} />
			<span className="action-label text-dim" title={action.action}>
				{humanizeAction(action.action)}
			</span>
			<span className="spacer" />
			{resolvable && (
				<div className="remote-resolve-actions">
					{(action.drift === "remote-drifted" ||
						action.drift === "conflict") && (
						<LoadingButton
							variant="ghost"
							size="sm"
							icon="fetch"
							loading={loadingFor("pull")}
							loadingLabel="Pulling…"
							disabled={busy}
							title="Adopt the box's version into the hub"
							onClick={() => onResolve("pull")}
						>
							Pull
						</LoadingButton>
					)}
					{(action.drift === "remote-drifted" ||
						action.drift === "conflict" ||
						action.drift === "orphaned" ||
						action.drift === "missing") && (
						<LoadingButton
							variant="ghost"
							size="sm"
							icon="equip"
							loading={loadingFor("push")}
							loadingLabel="Pushing…"
							disabled={busy}
							title="Force-push the local version to the box"
							onClick={() => onResolve("push")}
						>
							Push
						</LoadingButton>
					)}
					{action.drift === "conflict" && (
						<LoadingButton
							variant="ghost"
							size="sm"
							loading={loadingFor("keep-local")}
							loadingLabel="Keeping…"
							disabled={busy}
							title="Keep local — re-base the sidecar so it fast-forwards next sync"
							onClick={() => onResolve("keep-local")}
						>
							Keep local
						</LoadingButton>
					)}
					{(action.drift === "remote-drifted" ||
						action.drift === "conflict") && (
						<LoadingButton
							variant="ghost"
							size="sm"
							loading={loadingFor("keep-remote")}
							loadingLabel="Keeping…"
							disabled={busy}
							title="Accept the box's version — re-base the sidecar to the remote"
							onClick={() => onResolve("keep-remote")}
						>
							Keep remote
						</LoadingButton>
					)}
				</div>
			)}
		</div>
	);
}
