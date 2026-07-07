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
import { classifyRemoteHealth } from "@/lib/remoteHealth";
import { copyToClipboard } from "@/lib/clipboard";
import { useAppStore } from "@/store";
import type {
	HubResult,
	RemoteDiffAction,
	RemoteListEntry,
	RemotePinResult,
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
	const {
		data: diff,
		isLoading: diffLoading,
		isFetching: diffFetching,
		refetch: refetchDiff,
	} = useRemoteDiff(id);
	const {
		data: liveDocs,
		isLoading: docsLoading,
		refetch: refetchDocs,
	} = useRemoteDocs(id);
	// An in-flight GLOBAL `hub sync` may be pushing this box right now — surface it
	// as a subtle chip so the user knows the remote could be changing underfoot.
	const globalSyncing = useAppStore((s) => s.syncStatus === "syncing");
	const toast = useToast();
	const [busy, setBusy] = useState(false);
	// Which specific action is in-flight (e.g. "sync", "resolve:agent_doc:MEMORY.md:pull",
	// "import:foo"). `busy` locks the whole surface; `pending` tells exactly ONE control to
	// show its spinner so the user sees what they clicked react, not every button at once.
	const [pending, setPending] = useState<string | null>(null);
	const [confirm, setConfirm] = useState<null | "remove" | "clear">(null);
	// Host-key re-pin: a differing live key is the MITM case — the backend refuses
	// it and returns both fingerprints, which we surface in a ConfirmDialog before
	// re-invoking with --yes. `null` = no dialog.
	const [pinConfirm, setPinConfirm] = useState<{
		oldPins: string[];
		next: string;
	} | null>(null);
	// Inline result panel for "Install key on box" (persistent, not a transient
	// toast) — mirrors the wizard: shows the backend message + a copyable fallback.
	const [keyResult, setKeyResult] = useState<{
		ok: boolean;
		message: string;
		fallback?: string;
	} | null>(null);
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
	// when the remote is not ready; otherwise a ready remote IS healthy. The
	// not-ready shape is classified by the SHARED helper so the chip + banner
	// read identically to the list (home_missing/unreachable neutral; only
	// auth/host-key mismatch red — never amber, §5.2).
	const health = useMemo(() => {
		// A plan (actions present) IS the "connected/ready" signal for a diff — a
		// domain fact the generic classifier can't see, so keep it explicit.
		if (diff?.actions !== undefined)
			return {
				tone: "ok" as const,
				label: "connected",
				detail: "",
				hint: "",
				recovery: "none" as const,
				alert: false,
			};
		// Everything else — `!diff` ("checking…"), a `diff.ok === false` health
		// shape, and the unknown fallback — flows through the ONE shared classifier
		// so the chip + banner read identically to the RemotesScreen list.
		return classifyRemoteHealth(diff);
	}, [diff]);

	// Initial diff/health probe is in flight and we have nothing to show yet — the
	// health chip + the Sync-status section render a loading state (not a stale
	// "not reachable" empty) so a freshly-opened remote doesn't look broken.
	const healthLoading = !diff && (diffLoading || diffFetching);

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

	// R5/R8: re-pin the host key. First try WITHOUT --yes — the backend applies a
	// first/idempotent pin freely but REFUSES to replace a different existing pin
	// (the MITM case), returning both fingerprints. On refusal we open a confirm
	// dialog; confirming re-invokes with yes:true.
	async function runPin() {
		setBusy(true);
		setPending("pin");
		try {
			const res = await invoke<RemotePinResult>("remote_pin", {
				id,
				yes: false,
			});
			if (res.refused) {
				setPinConfirm({
					oldPins: res.old_pins ?? [],
					next: res.new_pin ?? "",
				});
			} else if (res.pinned) {
				// invalidateRemotes invalidates ["remote", id] (a prefix of the diff
				// query), which already refetches the active diff — no extra refetch.
				await invalidateRemotes(id);
				toast.success(`Re-pinned ${id}`, res.new_pin || undefined);
			} else {
				toast.push({
					kind: "info",
					title: `${id} host key unchanged`,
					body: res.detail || "Live key already matches the pin.",
				});
			}
		} catch (e) {
			toast.error("Re-pin failed", String(e));
		} finally {
			setBusy(false);
			setPending(null);
		}
	}

	async function confirmPin() {
		setPinConfirm(null);
		setBusy(true);
		setPending("pin");
		try {
			const res = await invoke<RemotePinResult>("remote_pin", { id, yes: true });
			await invalidateRemotes(id);
			if (res.pinned)
				toast.success(`Re-pinned ${id}`, res.new_pin || undefined);
			else toast.error("Re-pin failed", res.detail || "unknown error");
		} catch (e) {
			toast.error("Re-pin failed", String(e));
		} finally {
			setBusy(false);
			setPending(null);
		}
	}

	// R2/R8: install our SSH key on the box. Surface the result as a PERSISTENT
	// inline panel (not just a toast) — on failure show the backend message + a
	// copyable `ssh-copy-id <host>` fallback the user can run in their terminal.
	async function runInstallKey() {
		setBusy(true);
		setPending("setup-key");
		setKeyResult(null);
		try {
			const res = await invoke<HubResult>("remote_setup_key", { id });
			if (res.success) {
				setKeyResult({ ok: true, message: res.output.trim() || "Key installed." });
				toast.success("Key installed on box");
				// One invalidation refreshes show/health/diff (a prefix match) — no
				// separate refetch needed.
				await invalidateRemotes(id);
			} else {
				setKeyResult({
					ok: false,
					message: res.output.trim(),
					fallback: sshHost ? `ssh-copy-id ${sshHost}` : undefined,
				});
			}
		} catch (e) {
			setKeyResult({
				ok: false,
				message: String(e),
				fallback: sshHost ? `ssh-copy-id ${sshHost}` : undefined,
			});
		} finally {
			setBusy(false);
			setPending(null);
		}
	}

	const sshHost = show?.ssh_host ?? entry?.ssh_host ?? "";

	const resolvedSkills = show?.resolved_skills ?? [];

	return (
		<>
			<ScreenHeader
				back={{ label: "Remotes", onClick: onBack }}
				nameMono={id}
				state={
					!syncEnabled ? (
						<StatePill state="info" icon="power">
							SYNC OFF
						</StatePill>
					) : undefined
				}
				subline={show?.ssh_host ?? undefined}
				primary={
					// The connector tag + health chip live in the header-RIGHT cluster
					// (not the title-glued `meta` slot) so they center on the full
					// header height, reading as one row with Force-sync + the kebab —
					// the 2-row title column no longer pushes them above center.
					<>
						<div className="remote-header-status">
							{show && <Tag size="sm">{show.connector}</Tag>}
							<span
								className="remote-health-chip"
								data-tone={health.tone}
								data-loading={healthLoading || undefined}
								title={health.detail || undefined}
							>
								{healthLoading ? (
									<Spinner size={10} />
								) : (
									<span className="dot" />
								)}
								{healthLoading ? "checking…" : health.label}
							</span>
							{globalSyncing && (
								<span
									className="remote-syncing-chip"
									title="A global sync is running — this box may be getting updated."
								>
									<Spinner size={10} />
									syncing…
								</span>
							)}
						</div>
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
					</>
				}
				overflow={[
					{
						label: "Re-pin host key",
						icon: "shield",
						onClick: () => void runPin(),
					},
					{
						label: "Install key on box",
						icon: "link",
						onClick: () => void runInstallKey(),
					},
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
						<Icon
							name={health.tone === "error" ? "warning" : "remote"}
							size={13}
						/>
						<div className="remote-health-banner-body">
							<span>
								<strong>{health.label}.</strong>{" "}
								{health.hint ||
									"Run through the wizard's host-key + credential steps, then retry."}
							</span>
							{health.detail && health.detail !== health.hint && (
								<span className="remote-health-banner-detail text-mono text-dim">
									{health.detail}
								</span>
							)}
							<div className="remote-health-banner-actions">
								{(health.recovery === "re-pin" ||
									health.tone === "error") && (
									<LoadingButton
										variant="soft"
										size="sm"
										icon="shield"
										loading={pending === "pin"}
										loadingLabel="Re-pinning…"
										disabled={busy}
										onClick={() => void runPin()}
									>
										Re-pin host key
									</LoadingButton>
								)}
								{(health.recovery === "install-key" ||
									health.tone === "error") && (
									<LoadingButton
										variant="soft"
										size="sm"
										icon="link"
										loading={pending === "setup-key"}
										loadingLabel="Installing…"
										disabled={busy}
										onClick={() => void runInstallKey()}
									>
										Install key on box
									</LoadingButton>
								)}
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
							</div>
						</div>
					</div>
				) : null}

				{/* Install-key result — PERSISTENT, and independent of the banner so it
				    shows even when the remote is otherwise healthy (overflow-triggered). */}
				{keyResult && (
					<div
						className="remote-keyresult"
						data-ok={keyResult.ok || undefined}
						role="status"
					>
						<span>{keyResult.message}</span>
						{keyResult.fallback && (
							<div className="remote-keyresult-fallback">
								<span className="text-dim">
									The in-app install needs the box to already accept a key. Run
									this in your own terminal instead:
								</span>
								<div className="remote-copyrow">
									<code className="text-mono">{keyResult.fallback}</code>
									<Button
										variant="ghost"
										size="sm"
										icon="md.link"
										onClick={() =>
											copyToClipboard(keyResult.fallback ?? "")
										}
									>
										Copy
									</Button>
								</div>
							</div>
						)}
					</div>
				)}

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
					{healthLoading ? (
						<div className="remote-section-loading">
							<Spinner size={15} />
							<span>Checking the box for drift…</span>
						</div>
					) : diff?.actions === undefined ? (
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

			{pinConfirm && (
				<ConfirmDialog
					open
					title={`Replace the host key for “${id}”?`}
					confirmLabel="Re-pin (I trust this key)"
					tone="danger"
					confirmIcon="shield"
					onClose={() => setPinConfirm(null)}
					onConfirm={() => void confirmPin()}
					body={
						<>
							<p>
								The box is presenting a <strong>different</strong> host key than
								the one pinned. This is expected after a legitimate rekey — but a
								mismatch can also mean a machine-in-the-middle. Only re-pin if you
								know this rotation is genuine.
							</p>
							<div className="remote-pin-fprs">
								<div>
									<span className="text-dim">pinned</span>
									<code className="text-mono">
										{pinConfirm.oldPins.join(", ") || "—"}
									</code>
								</div>
								<div>
									<span className="text-dim">live</span>
									<code className="text-mono">{pinConfirm.next}</code>
								</div>
							</div>
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
