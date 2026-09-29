import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { fromNav, type BackTarget } from "@/lib/backTarget";
import { withQueryFocus } from "@/lib/queryFocus";
import { Button } from "@/components/Button";
import { trackProcess } from "@/lib/trackProcess";
import { cliErrorMessage, errText, runRegistryWrite } from "@/lib/hubWrite";
// Was a local `{success, output}` wrapper that discarded the bridge's
// stdout/stderr split; the shared runner has the same call signature.
import { hubCmd, hubStreams } from "@/lib/hubCmd";
import { Chip, Chips } from "@/components/Chips";
import { ScreenHeader } from "@/components/ScreenHeader";
import { SearchInput } from "@/components/SearchInput";
import { SubheaderGroup } from "@/components/SubheaderGroup";
import { EmptyState } from "@/components/EmptyState";
import { SectionHeader } from "@/components/SectionHeader";
import { ConfirmDialog } from "@/components/Modal";
import { Tag } from "@/components/Tag";
import { useRegistry } from "@/hooks/useRegistry";
import { useListNav } from "@/hooks/useListNav";
import { useUndoableAction } from "@/hooks/useUndoableAction";
import { useSourceDroppedSkills } from "@/hooks/useSourceDroppedSkills";
import {
	blastRadiusLines,
	removalConfirmBody,
	removalConfirmTitle,
} from "@/hooks/useSkillRemoval";
import { useToast } from "@/components/Toast";
import { queryClient } from "@/lib/queryClient";
import { qk } from "@/lib/queryKeys";
import { invalidateRegistry } from "@/lib/invalidate";
import { resolveActiveSkills } from "@/lib/resolveActiveSkills";
import { deriveSources, isSourceEnabled, skillNamesForSource } from "@/lib/skillSource";
import type { Registry, SourceSyncPayload, SourceView } from "@/types";
import { plural } from "@/screens/sources/sourceFormat";
import { SourceCard } from "@/screens/sources/SourceCard";
import { RenameSourceModal } from "@/screens/sources/RenameSourceModal";
import { BundleFromSourceModal } from "@/screens/sources/BundleFromSourceModal";
import { AddSourceToBundleModal } from "@/screens/sources/AddSourceToBundleModal";
import { AddSourceModal } from "@/screens/sources/AddSourceModal";

// Sources is a single-page section, so every detail route opened from it
// returns to the same place.
const SOURCES_BACK: BackTarget = {
	label: "Sources",
	path: "/sources",
	crumbs: ["sources"],
};

type FilterKind = "all" | "builtin" | "git";
/** Status facets are one-at-a-time toggles layered on top of the type filter. */
type StatusFilter = "updates" | "errors" | "disabled" | null;
type SortKey = "name" | "skills" | "synced" | "status";

/** Persisted sort preference (plan §Visual spec). */
const SORT_STORAGE_KEY = "st:sources:sort";

const SORT_LABEL: Record<SortKey, string> = {
	name: "Name",
	skills: "Skills",
	synced: "Last synced",
	status: "Status",
};

/** Attention-first ordering for the Status sort: what needs a human first. */
const STATUS_RANK: Record<string, number> = {
	error: 0,
	"update-available": 1,
	syncing: 2,
	unknown: 3,
	"up-to-date": 4,
	bundled: 5,
	local: 6,
};

function readSortPref(): SortKey {
	try {
		const raw = window.localStorage.getItem(SORT_STORAGE_KEY);
		if (raw === "name" || raw === "skills" || raw === "synced" || raw === "status") {
			return raw;
		}
	} catch {
		/* private mode / disabled storage — fall through to the default */
	}
	return "name";
}

// ─── Impact ─────────────────────────────────────────────────────────────────
// What stops (or resumes) flowing when a source is toggled. Computed locally so
// the confirmation copy is always available, then REPLACED by the backend's own
// `impact` block when `hub source disable --json` reports it.

export interface SourceImpact {
	skills: string[];
	bundles: string[];
	projects: string[];
}

export function computeSourceImpact(
	registry: Registry | undefined,
	sourceId: string,
): SourceImpact {
	const skills = skillNamesForSource(registry, sourceId);
	const owned = new Set(skills);
	const bundles = Object.entries(registry?.bundles ?? {})
		.filter(([, b]) => (b.skills ?? []).some((s) => owned.has(s)))
		.map(([name]) => name);
	const projects = Object.entries(registry?.projects ?? {})
		.filter(([, p]) =>
			registry
				? resolveActiveSkills(p, registry).some((s) => owned.has(s))
				: false,
		)
		.map(([name]) => name);
	return { skills, bundles, projects };
}

interface SourceCmdPayload {
	/** The resulting source. `null` on a refusal — the half that keeps an
	 *  outcome flag from being mistaken for a landed write. */
	source?: { id?: string } | null;
	/** Present whenever the registry write actually landed. */
	changed?: boolean;
	enabled?: boolean;
	impact?: Partial<SourceImpact>;
	errors?: unknown;
}

// ─── Source sync payload → human summary ────────────────────────────────────

/** A `source sync` landed when the payload says so. The sync payload carries no
 *  `errors` key, so anything less would leave the raw auto-sync log as the
 *  user-facing message. */
function syncLanded(p: SourceSyncPayload): boolean {
	return p.ok === true;
}

/** Counts tolerate either a name list or a bare number (see SourceSyncPayload). */
function countOf(v: string[] | number | unknown[] | undefined): number {
	if (Array.isArray(v)) return v.length;
	return typeof v === "number" ? v : 0;
}

/** "2 imported, 1 updated, 1 missing upstream" — omits the zero parts, and
 *  falls back to a plain confirmation when the source had nothing to report. */
export function syncSummary(payload: SourceSyncPayload | null): string {
	if (!payload) return "registry updated";
	const parts: string[] = [];
	const imported = countOf(payload.added);
	const updated = countOf(payload.changed);
	const missing = countOf(payload.removed_upstream);
	if (imported) parts.push(`${imported} imported`);
	if (updated) parts.push(`${updated} updated`);
	if (missing) parts.push(`${missing} missing upstream`);
	if (parts.length === 0) return "already up to date";
	return parts.join(", ");
}

/** "bundle android: +2 −1" per reconciled linked bundle. */
export function bundleUpdateLines(payload: SourceSyncPayload | null): string[] {
	return (payload?.bundle_updates ?? []).map((u) => {
		const bits: string[] = [];
		if (u.added?.length) bits.push(`+${u.added.length}`);
		if (u.removed?.length) bits.push(`−${u.removed.length}`);
		return `bundle ${u.bundle}: ${bits.join(" ") || "no change"}`;
	});
}

/** Read the `impact` block out of a parsed payload. */
function impactOf(payload: SourceCmdPayload | null): SourceImpact | null {
	const i = payload?.impact;
	if (!i) return null;
	return {
		skills: i.skills ?? [],
		bundles: i.bundles ?? [],
		projects: i.projects ?? [],
	};
}

function impactSentence(impact: SourceImpact): string {
	return `${plural(impact.skills.length, "skill")} across ${plural(
		impact.bundles.length,
		"bundle",
	)}, ${plural(impact.projects.length, "project")}`;
}

export function Sources() {
	const navigate = useNavigate();
	const location = useLocation();
	const [searchParams, setSearchParams] = useSearchParams();
	const toast = useToast();
	const runUndoable = useUndoableAction();
	const { data: registry } = useRegistry();
	const [q, setQ] = useState("");
	const [filter, setFilter] = useState<FilterKind>("all");
	const [statusFilter, setStatusFilter] = useState<StatusFilter>(null);
	const [sort, setSort] = useState<SortKey>(readSortPref);
	const [showAdd, setShowAdd] = useState(false);
	// Transient ring for the navigator's `?focus=<id>` deep-link (elsewhere
	// group). Cleared on a short timer, not on the next render, so it survives
	// unrelated re-renders (a sync landing mid-highlight, say).
	const [focusedId, setFocusedId] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	// Cards whose detail block the user collapsed (Enter on the focused row).
	const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
	// Git source staged for removal — drives the destructive ConfirmDialog.
	const [removeTarget, setRemoveTarget] = useState<SourceView | null>(null);
	const [renameTarget, setRenameTarget] = useState<SourceView | null>(null);
	const [bundleFromTarget, setBundleFromTarget] = useState<SourceView | null>(null);
	const [addToBundleTarget, setAddToBundleTarget] = useState<SourceView | null>(null);

	// Dropped-upstream batch resolution (spec: no new screen — lives here).
	// Pulled into its own hook so this screen stays under the component-size
	// guard's `useState` cap.
	const {
		droppedBySource,
		removal,
		keepingLocalNames,
		onDroppedAction,
		onOpenPossibleSuccessor,
		onForgetAllDropped,
	} = useSourceDroppedSkills(SOURCES_BACK);

	useEffect(() => {
		if (searchParams.get("add") === "1") {
			setShowAdd(true);
		}
	}, [searchParams]);

	// `?focus=<id>` (the navigator's elsewhere-group Sources rows): scroll the
	// matching card into view and ring it briefly. An unknown id finds no card
	// and the param is still stripped — silent, not an error. The id is
	// carried forward in history state (M-3) so the navigator's own "you are
	// here" match — which reads the URL fresh on every render — survives the
	// strip instead of losing the source the moment this effect runs.
	useEffect(() => {
		const focus = searchParams.get("focus");
		if (!focus) return;
		setFocusedId(focus);
		document
			.querySelector(`.source-card[data-source="${focus}"]`)
			?.scrollIntoView({ block: "center" });
		const next = new URLSearchParams(searchParams);
		next.delete("focus");
		setSearchParams(next, withQueryFocus(focus, location.state));
	}, [searchParams, setSearchParams, location.state]);

	useEffect(() => {
		if (!focusedId) return;
		const t = window.setTimeout(() => setFocusedId(null), 1500);
		return () => window.clearTimeout(t);
	}, [focusedId]);

	useEffect(() => {
		try {
			window.localStorage.setItem(SORT_STORAGE_KEY, sort);
		} catch {
			/* storage unavailable — the preference is simply not persisted */
		}
	}, [sort]);

	function closeAdd() {
		setShowAdd(false);
		if (searchParams.get("add") === "1") {
			const next = new URLSearchParams(searchParams);
			next.delete("add");
			setSearchParams(next, { replace: true });
		}
	}

	const sources = useMemo<SourceView[]>(() => deriveSources(registry), [registry]);
	const externalCount = sources.filter((s) => !s.builtin).length;
	const managedCount = sources.reduce(
		(acc, s) => acc + (s.builtin ? 0 : s.skill_count ?? 0),
		0,
	);

	// Chip counts double as this screen's overview stats, so they count over the
	// SEARCH-narrowed set (what the user is looking at) but ignore the chips
	// themselves — otherwise the active facet would always read its own total.
	const searched = useMemo(() => {
		const lq = q.trim().toLowerCase();
		if (!lq) return sources;
		return sources.filter((s) =>
			`${s.name} ${s.id} ${s.url ?? ""}`.toLowerCase().includes(lq),
		);
	}, [sources, q]);

	const counts = useMemo(
		() => ({
			all: searched.length,
			git: searched.filter((s) => s.type === "git").length,
			builtin: searched.filter((s) => s.builtin).length,
			updates: searched.filter((s) => s.status === "update-available").length,
			errors: searched.filter((s) => s.status === "error").length,
			disabled: searched.filter((s) => !isSourceEnabled(s)).length,
		}),
		[searched],
	);

	const visible = useMemo(() => {
		const byType = searched.filter((s) => {
			if (filter === "builtin") return s.builtin;
			if (filter === "git") return s.type === "git";
			return true;
		});
		const byStatus = byType.filter((s) => {
			if (statusFilter === "updates") return s.status === "update-available";
			if (statusFilter === "errors") return s.status === "error";
			if (statusFilter === "disabled") return !isSourceEnabled(s);
			return true;
		});
		const cmp = (a: SourceView, b: SourceView): number => {
			switch (sort) {
				case "skills":
					return (b.skill_count ?? 0) - (a.skill_count ?? 0);
				case "synced": {
					// Never-synced sorts last, not first — `0` would beat real dates.
					const at = a.last_synced_at ? Date.parse(a.last_synced_at) : -Infinity;
					const bt = b.last_synced_at ? Date.parse(b.last_synced_at) : -Infinity;
					return bt - at;
				}
				case "status":
					return (
						(STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9)
					);
				default:
					return 0;
			}
		};
		return [...byStatus].sort(
			(a, b) => cmp(a, b) || a.name.localeCompare(b.name),
		);
	}, [searched, filter, statusFilter, sort]);

	const configured = useMemo(
		() => visible.filter((s) => s.type !== "litellm"),
		[visible],
	);
	const comingSoon = useMemo(
		() => visible.filter((s) => s.type === "litellm"),
		[visible],
	);

	const toggleCollapsed = useCallback((id: string) => {
		setCollapsed((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	}, []);

	// Roving keyboard nav over the configured list. Enter expands/collapses the
	// focused card's detail block (there is no separate "open" destination for a
	// source — the card IS the detail view).
	const nav = useListNav({
		count: configured.length,
		onOpen: (i) => {
			const s = configured[i];
			if (s) toggleCollapsed(s.id);
		},
	});

	async function onCheckAll() {
		setBusy(true);
		try {
			let checked = 0;
			for (const s of sources.filter((x) => x.type === "git")) {
				try {
					await hubCmd(["source", "check", s.id, "--json"]);
					checked++;
				} catch {
					/* per-source errors land in the source entry's `error` field */
				}
			}
			await invalidateRegistry(queryClient);
			toast.success(`Checked ${checked} source${checked === 1 ? "" : "s"}`);
		} finally {
			setBusy(false);
		}
	}

	async function onSyncAll() {
		setBusy(true);
		try {
			let synced = 0;
			let failed = 0;
			let imported = 0;
			let updated = 0;
			const bundleLines: string[] = [];
			for (const s of sources.filter(
				(x) =>
					x.type === "git" &&
					x.status === "update-available" &&
					// A disabled source is out of the sync loop by definition — a bulk
					// sync must not grow its registry entries behind the user's back.
					isSourceEnabled(x),
			)) {
				try {
					// Only a landed payload counts: `hub_cmd` resolves (never throws) on
					// a non-zero exit, so a failing source used to be tallied as synced.
					const { payload } = await runRegistryWrite<SourceSyncPayload>(
						["source", "sync", s.id, "--json"],
						syncLanded,
					);
					imported += countOf(payload?.added);
					updated += countOf(payload?.changed);
					bundleLines.push(...bundleUpdateLines(payload));
					synced++;
				} catch {
					/* per-source detail lands in the source entry's `error` field */
					failed++;
				}
			}
			await invalidateRegistry(queryClient);
			const detail = [
				imported ? `${imported} imported` : null,
				updated ? `${updated} updated` : null,
				...bundleLines,
			]
				.filter(Boolean)
				.join(" · ");
			if (failed > 0) {
				toast.error(
					`${plural(synced, "source")} synced, ${failed} failed`,
					detail || "Open the failing cards for the reason.",
				);
			} else {
				toast.success(`Synced ${plural(synced, "source")}`, detail || undefined);
			}
		} finally {
			setBusy(false);
		}
	}

	async function onSyncSource(source: SourceView) {
		if (source.type !== "git") return;
		setBusy(true);
		// `source sync` writes the registry and THEN auto-syncs, so a doctor
		// danger finding exits non-zero on work that already landed. `ok: true`
		// is the proof; without it there is no landed write to report.
		let syncWarning: string | null = null;
		try {
			const payload = await trackProcess(
				{
					title: `Syncing ${source.name}`,
					body: "git fetch origin",
					kind: "remote",
					target: source.id,
				},
				async () => {
					const { payload: parsed, warning } =
						await runRegistryWrite<SourceSyncPayload>(
							["source", "sync", source.id, "--json"],
							syncLanded,
						);
					syncWarning = warning;
					await invalidateRegistry(queryClient);
					return parsed;
				},
				{
					// What actually moved, not "registry updated".
					successBody: (p) => `${source.name} · ${syncSummary(p)}`,
					retry: () => void onSyncSource(source),
				},
			);
			// A linked bundle's membership changing is a registry edit the user
			// didn't make by hand — it outlives the auto-dismissing process card.
			const lines = bundleUpdateLines(payload);
			if (lines.length > 0) {
				toast.success(`Synced ${source.name}`, lines.join(" · "));
			}
			if (syncWarning) toast.info("Sync reported findings", syncWarning);
		} catch {
			/* concise error surfaced on the process card */
		} finally {
			setBusy(false);
		}
	}

	async function onCheckSource(source: SourceView) {
		if (source.type !== "git") return;
		setBusy(true);
		try {
			const res = await hubCmd(["source", "check", source.id, "--json"]);
			if (!res.success)
				throw new Error(cliErrorMessage(res.output, hubStreams(res)));
			await invalidateRegistry(queryClient);
			toast.success(`Checked ${source.name}`);
		} catch (err) {
			toast.error("Couldn't check source", errText(err));
		} finally {
			setBusy(false);
		}
	}

	function onRemoveSource(source: SourceView) {
		if (source.type !== "git") return;
		setRemoveTarget(source);
	}

	async function confirmRemoveSource() {
		const source = removeTarget;
		if (!source) return;
		setBusy(true);
		try {
			const res = await hubCmd([
				"source",
				"remove",
				source.id,
				"--mode",
				"unequip",
				"--json",
			]);
			if (!res.success) throw new Error(res.output);
			await invalidateRegistry(queryClient);
			toast.success(`Removed ${source.name}`);
			setRemoveTarget(null);
		} catch (err) {
			toast.error("Couldn't remove source", errText(err));
		} finally {
			setBusy(false);
		}
	}

	/** Disable/enable is reversible and cheap, so it runs immediately behind an
	 *  undo toast rather than a confirm dialog (plan §UX framing). */
	async function onToggleEnabled(source: SourceView) {
		const turningOff = isSourceEnabled(source);
		const verb = turningOff ? "disable" : "enable";
		const inverse = turningOff ? "enable" : "disable";
		// Seeded from the registry so the toast has copy even if the CLI omits an
		// impact block; replaced by the backend's own numbers when it reports them.
		let impact = computeSourceImpact(registry, source.id);
		// Set when the toggle landed but the auto-sync that follows it reported a
		// problem — surfaced beside the undo toast, never instead of it.
		let syncWarning: string | null = null;

		/** `hub source enable|disable` writes the registry FIRST, then runs
		 *  `_auto_sync()`, whose doctor exits non-zero on a danger finding. In that
		 *  case hub_cmd reports `success: false` even though the toggle DID happen.
		 *  A payload carrying `changed` is the proof the write landed, so treat it
		 *  as success-with-a-warning — telling the user nothing happened (and
		 *  withholding their Undo) would be a lie about the registry. */
		const runToggle = async (which: string): Promise<SourceCmdPayload | null> => {
			const { payload, warning } = await runRegistryWrite<SourceCmdPayload>(
				["source", which, source.id, "--json"],
				(p) => p.source != null && "changed" in p,
			);
			if (warning) syncWarning = warning;
			return payload;
		};

		setBusy(true);
		try {
			await runUndoable({
				do: async () => {
					impact = impactOf(await runToggle(verb)) ?? impact;
				},
				undo: async () => {
					await runToggle(inverse);
				},
				// A getter, not a string: the impact numbers only exist once `do()`
				// has run, and useUndoableAction reads `label` after awaiting it.
				get label() {
					return `${turningOff ? "Disabled" : "Enabled"} ${source.name} — ${impactSentence(impact)}`;
				},
				invalidate: [["registry"], ["sources"]],
			});
			if (syncWarning) {
				toast.info("Sync reported findings", syncWarning);
			}
		} catch (err) {
			toast.error(`Couldn't ${verb} source`, errText(err));
		} finally {
			setBusy(false);
		}
	}

	async function onRename(source: SourceView, name: string) {
		setBusy(true);
		try {
			const res = await hubCmd(["source", "edit", source.id, "--name", name, "--json"]);
			if (!res.success) throw new Error(res.output);
			await invalidateRegistry(queryClient);
			await queryClient.invalidateQueries({ queryKey: qk.sources() });
			toast.success(`Renamed to "${name}"`);
			setRenameTarget(null);
		} catch (err) {
			toast.error("Couldn't rename source", errText(err));
		} finally {
			setBusy(false);
		}
	}

	return (
		<>
			<ScreenHeader
				icon="source"
				title="External Sources"
				meta={
					<Tag size="sm" color="var(--fg-mute)" style={{ textTransform: "none" }}>
						{externalCount} external · {managedCount} managed skills
					</Tag>
				}
				crumbs={["skill-tree", "sources"]}
				primary={
					<Button variant="primary" icon="plus" onClick={() => setShowAdd(true)}>
						Add source
					</Button>
				}
				overflow={[
					{
						icon: "refresh",
						label: "Check all sources",
						disabled: busy,
						onClick: () => void onCheckAll(),
					},
					{
						icon: "bolt",
						label: "Sync all updates",
						disabled: busy,
						onClick: () => void onSyncAll(),
					},
				]}
				subheader={{
					left: (
						<>
							{/* NEVER autoFocus: the command-layer + hooks e2e journeys start
							    from /sources precisely because it has no focused input. */}
							<SearchInput
								value={q}
								onChange={setQ}
								placeholder="Search sources by name, id, or URL…"
								screenSearch
							/>
							<SubheaderGroup>
								<Chips role="tablist">
									<Chip
										pressed={filter === "all"}
										onClick={() => setFilter("all")}
										count={counts.all}
									>
										All
									</Chip>
									<Chip
										pressed={filter === "git"}
										onClick={() => setFilter("git")}
										count={counts.git}
									>
										Git
									</Chip>
									<Chip
										pressed={filter === "builtin"}
										onClick={() => setFilter("builtin")}
										count={counts.builtin}
									>
										Built-in
									</Chip>
								</Chips>
							</SubheaderGroup>
							<SubheaderGroup>
								<Chips>
									<Chip
										pressed={statusFilter === "updates"}
										onClick={() =>
											setStatusFilter(statusFilter === "updates" ? null : "updates")
										}
										count={counts.updates}
										title="Only sources with an update waiting"
									>
										Updates
									</Chip>
									<Chip
										pressed={statusFilter === "errors"}
										onClick={() =>
											setStatusFilter(statusFilter === "errors" ? null : "errors")
										}
										count={counts.errors}
										title="Only sources that failed to check or sync"
									>
										Errors
									</Chip>
									<Chip
										pressed={statusFilter === "disabled"}
										onClick={() =>
											setStatusFilter(statusFilter === "disabled" ? null : "disabled")
										}
										count={counts.disabled}
										title="Only sources you turned off"
									>
										Disabled
									</Chip>
								</Chips>
							</SubheaderGroup>
						</>
					),
					right: (
						<label className="loadout-sort">
							<span>sort</span>
							<select
								value={sort}
								onChange={(e) => setSort(e.target.value as SortKey)}
								aria-label="Sort sources"
							>
								{(Object.keys(SORT_LABEL) as SortKey[]).map((k) => (
									<option key={k} value={k}>
										{SORT_LABEL[k]}
									</option>
								))}
							</select>
						</label>
					),
				}}
			/>

			<div className="main-body sources-body">
				{visible.length === 0 ? (
					// The two built-ins always exist, so an empty list can only be the
					// result of the search box or a filter chip.
					<EmptyState
						icon="search"
						title="No matching sources"
						description="Try clearing the search or the filter chips."
					/>
				) : (
					<>
						<SectionHeader label="Configured sources" count={configured.length} />
						<div {...nav.containerProps} className="source-list">
							{configured.map((source, i) => (
								<SourceCard
									key={source.id}
									source={source}
									registry={registry}
									navProps={nav.itemProps(i)}
									detailOpen={!collapsed.has(source.id)}
									highlighted={focusedId === source.id}
									onToggleDetail={() => toggleCollapsed(source.id)}
									onCheck={() => void onCheckSource(source)}
									onSync={() => void onSyncSource(source)}
									onRemove={() => void onRemoveSource(source)}
									onRename={() => setRenameTarget(source)}
									onToggleEnabled={() => void onToggleEnabled(source)}
									onCreateBundle={() => setBundleFromTarget(source)}
									onAddToBundle={() => setAddToBundleTarget(source)}
									onSkillClick={(name) =>
										navigate(
											`/skill/${encodeURIComponent(name)}`,
											fromNav(SOURCES_BACK),
										)
									}
									onBundleClick={(name) =>
										navigate(
											`/bundle/${encodeURIComponent(name)}`,
											fromNav(SOURCES_BACK),
										)
									}
									busy={busy}
									dropped={droppedBySource[source.id]}
									onDroppedAction={onDroppedAction}
									onOpenPossibleSuccessor={onOpenPossibleSuccessor}
									onForgetAllDropped={onForgetAllDropped}
									droppedBusy={removal.busy}
									keepingLocalNames={keepingLocalNames}
								/>
							))}
						</div>

						{comingSoon.length > 0 && (
							<>
								<SectionHeader label="Coming soon" count={comingSoon.length} />
								<div className="source-list">
									{comingSoon.map((source) => (
										<SourceCard
											key={source.id}
											source={source}
											registry={registry}
											detailOpen={false}
											disabled
										/>
									))}
								</div>
							</>
						)}
						<div style={{ height: 80 }} />
					</>
				)}
			</div>

			{showAdd && <AddSourceModal onClose={closeAdd} registry={registry} />}

			{renameTarget && (
				<RenameSourceModal
					source={renameTarget}
					busy={busy}
					onClose={() => setRenameTarget(null)}
					onSubmit={(name) => void onRename(renameTarget, name)}
				/>
			)}

			{bundleFromTarget && (
				<BundleFromSourceModal
					source={bundleFromTarget}
					registry={registry}
					onClose={() => setBundleFromTarget(null)}
				/>
			)}

			{addToBundleTarget && (
				<AddSourceToBundleModal
					source={addToBundleTarget}
					registry={registry}
					onClose={() => setAddToBundleTarget(null)}
					onCreateBundle={() => {
						const src = addToBundleTarget;
						setAddToBundleTarget(null);
						setBundleFromTarget(src);
					}}
				/>
			)}

			{removeTarget && (
				<ConfirmDialog
					open
					tone="danger"
					title={`Remove source "${removeTarget.name}"?`}
					confirmLabel="Remove source"
					confirmIcon="trash"
					busy={busy}
					onClose={() => setRemoveTarget(null)}
					onConfirm={() => void confirmRemoveSource()}
					body={
						<p>
							This unequips its{" "}
							<strong>{removeTarget.skill_count ?? 0}</strong> skill
							{(removeTarget.skill_count ?? 0) === 1 ? "" : "s"} from every
							bundle and project. There is no undo. Use the CLI for keep-local
							mode. To stop syncing without losing anything, disable it instead.
						</p>
					}
				/>
			)}

			{/* The one archive/forget confirm (useSkillRemoval) — a single row's
			    "Forget" when it is equipped somewhere, or always for "Forget all". */}
			<ConfirmDialog
				open={!!removal.pending}
				onClose={removal.cancel}
				onConfirm={removal.confirm}
				tone="danger"
				busy={removal.busy}
				title={removal.pending ? removalConfirmTitle(removal.pending) : ""}
				body={removal.pending ? removalConfirmBody(removal.pending) : ""}
				confirmLabel={removal.pending?.verb === "forget" ? "Forget" : "Archive"}
				blastRadius={
					removal.pending && blastRadiusLines(removal.pending.refs).length > 0 ? (
						<ul>
							{blastRadiusLines(removal.pending.refs).map((line) => (
								<li key={line.label}>
									{line.label}: {line.items.join(", ")}
								</li>
							))}
						</ul>
					) : undefined
				}
			/>
		</>
	);
}


