import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { invoke } from "@/lib/ipc";

import { Button } from "@/components/Button";
import { LoadingButton } from "@/components/loading/LoadingButton";
import { trackProcess } from "@/lib/trackProcess";
import { Spinner } from "@/components/loading/Spinner";
import { BundleChip } from "@/components/BundleChip";
import { bundleColor } from "@/components/bundleColors";
import { EmptyState } from "@/components/EmptyState";
import { Icon } from "@/components/Icon";
import { ResourceRow } from "@/components/ResourceRow";
import { ScreenHeader } from "@/components/ScreenHeader";
import { SectionHeader } from "@/components/SectionHeader";
import { SkillRow } from "@/components/SkillRow";
import { StatePill } from "@/components/StatePill";
import { Tag } from "@/components/Tag";
import { useToast } from "@/components/Toast";
import { ConfirmDialog } from "@/components/Modal";
import { EquipPicker } from "@/components/EquipPicker";
import { useRemoteEquip } from "@/hooks/useEquip";
import { fromNav } from "@/lib/backTarget";
import { clickSink } from "@/lib/pressable";
import {
	buildRemoteBundleTargets,
	buildRemoteSkillTargets,
} from "@/hooks/useEquipTargets";
import { useRegistry } from "@/hooks/useRegistry";
import {
	useRemoteDiff,
	useRemoteDocs,
	useRemoteDoctor,
	useRemoteImportScan,
	useRemoteSetApplyGlobal,
	useRemoteShow,
} from "@/hooks/useRemotes";
import { RemoteDoctorFindingsList } from "./RemoteDoctorFindings";
import { classifyRemoteHealth } from "@/lib/remoteHealth";
import { copyToClipboard } from "@/lib/clipboard";
import { useAppStore } from "@/store";
import type { HubResult, RemoteDetailCommand, RemoteDiffAction, RemoteListEntry, RemotePinResult } from "@/types";
import { invalidateRemotes } from "@/screens/RemotesScreen";
import {
	DriftBadge,
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
	// Aggregate risk rollup filtered to this remote — host-key mismatch
	// (MITM/danger), stale sidecars, unresolved drift. DISABLED by default (F1): a
	// cold deep-link to /remote/:id must not kick off `remote_doctor`, which sweeps
	// EVERY remote with ~3 SSH ops each. We render whatever the query cache holds
	// (populated when the user visited the list) and gate a fresh run behind the
	// explicit "Re-check" button, which `refetch()` fires even while disabled.
	const {
		data: doctor,
		isLoading: doctorLoading,
		refetch: refetchDoctor,
	} = useRemoteDoctor(false);
	const remoteFindings = useMemo(
		() => (doctor?.findings ?? []).filter((f) => f.remote === id),
		[doctor, id],
	);
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
				else toast.error("Couldn't run command", res.output.trim());
			},
			onError: (e) => toast.error("Couldn't run command", String(e)),
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
	const docActions = actions.filter((a) => a.kind === "agent_doc");
	const driftItems = actions.filter((a) => needsResolve(a.drift));

	// B5: the merged list's row set — the union of resolved-equipped skills
	// and whatever the diff plan still tracks (an orphan, an MCP server), so
	// a unit never falls off screen just because it stopped being equipped.
	const skillActions = useMemo(
		() =>
			new Map(
				actions
					.filter((a) => a.kind === "skill" || a.kind === "mcp")
					.map((a) => [a.name, a] as const),
			),
		[actions],
	);
	const unitNames = Array.from(
		new Set([...(show?.resolved_skills ?? []), ...skillActions.keys()]),
	);
	// undefined = "no plan" — an unreachable remote must never read in-sync.
	const driftOf = (name: string) =>
		diff?.actions === undefined
			? undefined
			: (skillActions.get(name)?.drift ?? "in-sync");

	// The Agent-docs section lists the union of the LIVE docs present on the
	// box (from `remote_list_docs`) and whatever the diff plan still tracks —
	// so SOUL/MEMORY/USER surface for a freshly-opened remote even with
	// nothing queued, AND a doc the plan expects but the box no longer has
	// (`missing`, REVIEW-B #2) never drops off the list just because
	// `remote_list_docs` stopped reporting it present. `driftOf` mirrors the
	// skill union's "no plan → undefined, never in-sync" rule.
	const docRows = useMemo(() => {
		const byName = new Map<string, RemoteDiffAction>();
		for (const a of docActions) byName.set(a.name, a);
		const rows = new Map<string, RemoteDiffAction>();
		for (const d of liveDocs?.docs ?? []) {
			if (!d.present) continue;
			rows.set(
				d.name,
				byName.get(d.name) ?? {
					name: d.name,
					kind: "agent_doc",
					action: "noop",
					drift: "in-sync",
				},
			);
		}
		for (const a of docActions) if (!rows.has(a.name)) rows.set(a.name, a);
		return Array.from(rows.values());
	}, [liveDocs, docActions]);
	// Unlike `driftOf`, a doc action is ALWAYS explicit (the backend tracks
	// every known doc, including a not-yet-created one as `drift: null`), so
	// there is no "untracked → in-sync" fallback to invent here — only the
	// "no plan → undefined, never in-sync" rule carries over from the skill
	// union.
	const docDriftOf = (a: RemoteDiffAction) =>
		diff?.actions === undefined ? undefined : a.drift;
	const livePresentDocs = useMemo(
		() => new Set((liveDocs?.docs ?? []).filter((d) => d.present).map((d) => d.name)),
		[liveDocs],
	);

	/**
	 * The one funnel for this screen's remote commands. Every one of them is an
	 * SSH round-trip, so wrapping it HERE gives sync, resolve, push-doc, import
	 * and the rest the same process-card banner from a single definition —
	 * rather than each button inventing its own feedback. `busy` + `pending`
	 * stay: the card says WHAT is running, the pressed control says WHICH.
	 */
	async function runHub(
		cmd: RemoteDetailCommand,
		args: Record<string, unknown>,
		okMsg: string,
		actionKey?: string,
	) {
		setBusy(true);
		setPending(actionKey ?? cmd);
		try {
			const res = await trackProcess(
				{
					title: okMsg,
					body: `${id} · over ssh`,
					kind: "remote",
					target: `remote:${id}`,
				},
				async () => {
					const out = await invoke<HubResult>(cmd, args);
					await invalidateRemotes(id);
					await refetchDiff();
					return out;
				},
				{
					// A non-zero hub command resolves rather than throwing, so the
					// card would otherwise go green on a failed push.
					failWhen: (r) =>
						r.success ? null : r.output.trim() || "command failed",
				},
			);
			if (res.success) toast.success(okMsg, res.output.trim() || undefined);
			else toast.error("Couldn't run command", res.output.trim());
			return res.success;
		} catch (e) {
			toast.error("Couldn't run command", String(e));
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
			toast.error("Couldn't re-pin host key", String(e));
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
			else toast.error("Couldn't re-pin host key", res.detail || "unknown error");
		} catch (e) {
			toast.error("Couldn't re-pin host key", String(e));
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

	// B5-b: one row in the merged "Skills on this remote" list. No `skill` =
	// a unit the diff plan tracks but that dropped out of the registry
	// (`orphaned`) — a glyph-less `ResourceRow`, not a `SkillRow`.
	function unitRow(name: string) {
		const skill = registry?.skills?.[name];
		const a = skillActions.get(name);
		const drift = driftOf(name);
		const resolvable = a ? needsResolve(a.drift) : false;
		const dataset = { drift: resolvable ? "needs-resolve" : undefined };
		const badges = (
			<>
				{drift && <DriftBadge status={drift} />}
				<span className="action-label text-dim" title={a?.action}>
					{humanizeAction(a?.action ?? "noop")}
				</span>
			</>
		);
		const actionsSlot =
			a && resolvable ? (
				<RemoteResolveActions
					action={a}
					busy={busy}
					pending={pending}
					onResolve={(op) =>
						void runHub(
							"remote_resolve",
							{ id, artifact: a.name, op, kind: a.kind },
							`Resolved ${a.name} (${op})`,
							resolveActionKey(a.kind, a.name, op),
						)
					}
				/>
			) : undefined;

		if (!skill || !registry) {
			return (
				<ResourceRow
					key={name}
					className="remote-unit remote-unit-orphan"
					name={name}
					dataset={dataset}
					badges={
						<>
							{badges}
							<span className="text-dim">not in registry</span>
						</>
					}
					actions={actionsSlot}
				/>
			);
		}
		const viaBundleNames = (show?.bundles ?? []).filter((b) =>
			registry.bundles?.[b]?.skills?.includes(name),
		);
		return (
			<SkillRow
				key={name}
				name={name}
				skill={skill}
				registry={registry}
				className="remote-unit"
				dataset={dataset}
				onClick={() =>
					navigate(
						`/skill/${encodeURIComponent(name)}`,
						fromNav({
							label: id,
							path: `/remote/${encodeURIComponent(id)}`,
							crumbs: ["remote", id],
						}),
					)
				}
				badges={badges}
				actions={actionsSlot}
				detail={
					<>
						{skill.description && (
							<p className="remote-unit-desc">{skill.description}</p>
						)}
						<span className="ver">v{skill.version || "—"}</span>
						{viaBundleNames.length > 0 && (
							<span className="text-dim"> via {viaBundleNames.join(", ")}</span>
						)}
					</>
				}
				detailLabel={`${name} details`}
			/>
		);
	}

	// REVIEW-B #2: one row per agent doc the diff plan knows about, present on
	// the box or not — the same `RemoteResolveActions` the skill union uses,
	// so a `missing`/`conflict` doc keeps its Push/Keep-local/Keep-remote
	// affordance instead of losing it with the deleted `DriftRow`. A doc
	// present on the box also gets the disclosure chevron, whose panel is the
	// live fetch → edit → push pane (`RemoteDocEditor`, mounted only while
	// open — GRILL #2's "aria-controls only while the panel is mounted").
	function docRow(a: RemoteDiffAction) {
		const drift = docDriftOf(a);
		const resolvable = needsResolve(a.drift);
		const dataset = { drift: resolvable ? "needs-resolve" : undefined };
		const present = livePresentDocs.has(a.name);
		return (
			<ResourceRow
				key={a.name}
				className="remote-unit"
				glyph={<Icon name="doc" size={13} />}
				name={a.name}
				ariaLabel={a.name}
				dataset={dataset}
				badges={
					<>
						{drift && <DriftBadge status={drift} />}
						<span className="action-label text-dim" title={a.action}>
							{humanizeAction(a.action)}
						</span>
					</>
				}
				actions={
					<RemoteResolveActions
						action={a}
						busy={busy}
						pending={pending}
						onResolve={(op) =>
							void runHub(
								"remote_resolve",
								{ id, artifact: a.name, op, kind: "agent_doc" },
								`Resolved ${a.name} (${op})`,
								resolveActionKey("agent_doc", a.name, op),
							)
						}
					/>
				}
				detail={
					present ? (
						<RemoteDocEditor
							remoteId={id}
							docName={a.name}
							busy={busy}
							onChanged={() => {
								void refetchDiff();
								void refetchDocs();
							}}
						/>
					) : undefined
				}
				detailLabel={`${a.name} editor`}
			/>
		);
	}

	return (
		<>
			<ScreenHeader
				back={{ label: "Remotes", onClick: onBack }}
				nameMono={id}
				// C5: identity chip in `meta`, everything status-shaped in `state`.
				// The right cluster is for ACTIONS — a status cluster parked there
				// also escaped the narrow-width collapse rules, which only target
				// `.btn`.
				meta={show ? <Tag size="sm">{show.connector}</Tag> : undefined}
				state={
					<span className="remote-header-status">
						{!syncEnabled && (
							<StatePill state="info" icon="power">
								SYNC OFF
							</StatePill>
						)}
						<span
							className="remote-health-chip"
							data-tone={health.tone}
							data-loading={healthLoading || undefined}
							title={health.detail || undefined}
						>
							{healthLoading ? <Spinner size={10} /> : <span className="dot" />}
							{/* Wrapped so the narrow ladder can shed the WORD and keep the
							    dot: the tone dot plus the chip's own tooltip still carry
							    the state once the title row runs out of room. */}
							<span className="remote-health-label">
								{healthLoading ? "checking…" : health.label}
							</span>
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
					</span>
				}
				// An identifier, not prose — the header's solo subline renders in sans
				// now, so the ssh host asks for mono explicitly (COMPONENTS.md §Type).
				// C2: NEVER conditional. A placeholder holds the line until the
				// health query lands, so the route doesn't self-jump on load.
				subline={
					<span style={{ fontFamily: "var(--font-mono)" }}>
						{show?.ssh_host ?? "—"}
					</span>
				}
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

				{/* ── Risks (remote doctor rollup) ── */}
				{/* Always rendered so the explicit Re-check trigger is reachable even
				    on a cold open where the doctor query is disabled (F1) and holds no
				    cached data. `doctor === undefined` is the honest "not checked yet"
				    resting state — a compact hint, never a spinner. */}
				<section className="remote-section" data-testid="remote-risks">
					<SectionHeader
						label="Risks"
						count={doctor ? remoteFindings.length : undefined}
						right={
							<LoadingButton
								variant="ghost"
								size="sm"
								icon="refresh"
								loading={doctorLoading}
								loadingLabel="Checking…"
								disabled={busy}
								onClick={() => void refetchDoctor()}
							>
								Re-check
							</LoadingButton>
						}
					/>
					{doctorLoading ? (
						<div className="remote-section-loading">
							<Spinner size={15} />
							<span>Running the remote doctor…</span>
						</div>
					) : doctor === undefined ? (
						<div className="remote-section-hint" data-testid="remote-risks-unchecked">
							Not checked yet — run the remote doctor to surface host-key,
							drift, and stale-sidecar risks for this remote.
						</div>
					) : remoteFindings.length > 0 ? (
						<RemoteDoctorFindingsList findings={remoteFindings} />
					) : (
						<div className="remote-section-hint">
							No risks detected on this remote.
						</div>
					)}
				</section>

				{/* Page-level: spans skills/MCP + agent docs (resolved below). */}
				{diff?.actions !== undefined && driftItems.length > 0 && (
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

				{/* ── Skills on this remote (B5) — the merged equipped+drift list ── */}
				<section className="remote-section">
					<SectionHeader
							label="Skills on this remote"
							count={unitNames.length}
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
									settledLabel="queued"
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
									settledLabel="queued"
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
					{/* Loading/hint lines sit ABOVE the list, never instead of it. */}
					{healthLoading && (
						<div className="remote-section-loading">
							<Spinner size={15} />
							<span>Checking the box for drift…</span>
						</div>
					)}
					{!healthLoading && diff?.actions === undefined && (
						<div className="remote-section-hint">
							Drift plan unavailable —{" "}
							{diff?.detail || "the remote is not reachable or not ready"}
						</div>
					)}
					{!healthLoading && diff?.actions !== undefined && actions.length === 0 && unitNames.length > 0 && (
						<div className="remote-section-hint">
							Everything in sync — no artifacts to push and no drift detected on the box.
						</div>
					)}
					{unitNames.length === 0 ? (
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
						<div className="remote-skill-list">{unitNames.map(unitRow)}</div>
					)}
				</section>

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
					{docRows.length === 0 ? (
						<EmptyState
							icon="doc"
							title="No agent docs on the box"
							description="SOUL.md, MEMORY.md, and USER.md appear here when they exist on the box, or once the plan tracks them. Open one to read, edit, then push it through the connector's diff gate (backup-on-change, drift-refused)."
						/>
					) : (
						<div className="remote-skill-list">{docRows.map(docRow)}</div>
					)}
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

// ─── B5-c: resolve-action cluster for one drifted unit ─────────────────────────
// `clickSink()` stops a click from reaching the enclosing `SkillRow`'s own
// `onClick` (which navigates to `/skill/:name`) — GRILL #3.

function RemoteResolveActions({
	action,
	busy,
	pending,
	onResolve,
}: {
	action: RemoteDiffAction;
	busy: boolean;
	pending: string | null;
	onResolve: (op: ResolveOp) => void;
}) {
	// Loading key must match the one RemoteDetail.runHub stamps for this row+op.
	const loadingFor = (op: ResolveOp) =>
		pending === resolveActionKey(action.kind, action.name, op);
	return (
		<div className="remote-resolve-actions" {...clickSink()}>
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
	);
}
