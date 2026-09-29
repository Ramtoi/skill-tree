import { Fragment, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Button } from "@/components/Button";
import { Icon } from "@/components/Icon";
import { Spinner, SkeletonRow } from "@/components/loading";
import { ConfirmDialog } from "@/components/Modal";
import { OverflowMenu, type OverflowMenuItem } from "@/components/OverflowMenu";
import { PathText } from "@/components/PathText";
import { SearchInput } from "@/components/SearchInput";
import { useToast } from "@/components/Toast";
import { SidePanelSection } from "@/components/SidePanelSection";
import { StatusBadge } from "@/components/StatusBadge";
import { snipStatusMeta } from "@/components/snippets/SnippetStatusBadge";
import { removeSnippet, updateSnippet } from "@/hooks/useSnippets";
import { copyToClipboard } from "@/lib/clipboard";
import { FILTER_THRESHOLD } from "@/lib/navRules";
import type { SnippetLocation } from "@/types/snippets";

// ─── Applied-locations panel (snippet detail, side column) ──────────────────
//
// Split out of `screens/Snippets.tsx` so that file stays under the 1000-line
// component-size guard. It owns the frequent job of the panel: which files
// this snippet is applied to, and the Update/Remove verbs on each — as one
// `SidePanelSection` over one recessed `.equip-stack` well, grouped by
// project in the FILES navigator's grammar. Per-location in-flight keys mean
// only the acted-on control busies; "update everywhere" is its own flag.
//
// A row's identity is the path RELATIVE TO THE PROJECT ROOT, not the bare
// filename — a project with many nested `AGENTS.md` files used to render as
// an unreadable stack of identical rows with no way in but the trash. It
// wraps via `PathText` (the filename stays whole, the full absolute path
// rides on `title`). State is a dot (a hollow ring for `modified`, so it is
// never confused with `outdated`'s filled dot — see `snipStatusMeta`), and
// the applied version rides beside it ONLY on outdated rows: `outdated` is a
// SHA mismatch against the current library body (`status_of_block` in
// snippets.py), never a version-number comparison, so the version shown here
// is the usual proxy for that fact, not the fact itself — a snippet edited
// A→B→A leaves a stale marker version on a block whose SHA still matches,
// which reads (correctly) as `applied` with no version shown at all.

/** Which refresh is rewriting rows: Save's phase 2 (`"save"`, right after a
 *  version bump — applied + outdated) or "Update everywhere" (`"outdated"`). */
export type RefreshScope = "save" | "outdated";

export function AppliedLocationsPanel({
	name,
	version,
	locations,
	scanning = false,
	refreshing = null,
	locked = false,
	onApplyOpen,
	onUpdateEverywhere,
	onMutated,
	storageKey,
}: {
	name: string;
	version: number;
	locations: SnippetLocation[];
	/** True while the applied-locations scan (`snippet status --name`) is
	 *  still in flight — `locations` is `[]` in that state, which is NOT the
	 *  same thing as "not applied anywhere" (see the guards below). */
	scanning?: boolean;
	/** A refresh — either this panel's own "Update everywhere" or the editor's
	 *  Save-triggered one — is in flight. Owned by the caller: only one such
	 *  refresh can ever run at once, so it's a single flag either way. */
	refreshing?: RefreshScope | null;
	/** Another write on this snippet (the library save) is running: hide
	 *  "Update everywhere" so a second `snippet update --all` cannot start. */
	locked?: boolean;
	onApplyOpen: () => void;
	onUpdateEverywhere: () => void;
	onMutated: () => void;
	/** localStorage key for the shared disclosure map (`st:snippet-editor:sections`). */
	storageKey?: string;
}) {
	const navigate = useNavigate();
	const toast = useToast();
	const [removeTarget, setRemoveTarget] = useState<SnippetLocation | null>(null);
	const [query, setQuery] = useState("");
	// The route stays on the same `<SnippetEditor>` instance across
	// `/snippet/a` → `/snippet/b` (no `key`) — a query typed for one snippet
	// must not silently pre-filter the next one's Applied To list.
	useEffect(() => setQuery(""), [name]);
	// Per-location in-flight set (key = project:rel). Only the acted-on control
	// disables; siblings stay interactive.
	const [pending, setPending] = useState<Set<string>>(() => new Set());
	const locKey = (loc: SnippetLocation) => `${loc.project}:${loc.rel}`;
	const withPending = async (key: string, fn: () => Promise<void>) => {
		setPending((p) => new Set(p).add(key));
		try {
			await fn();
		} finally {
			setPending((p) => {
				const n = new Set(p);
				n.delete(key);
				return n;
			});
		}
	};
	const outdatedCount = locations.filter((l) => l.status === "outdated").length;
	const modifiedCount = locations.filter((l) => l.status === "modified").length;
	// What the refresh in flight actually rewrites: `update --all` touches
	// outdated blocks only; Save's phase 2 runs right after a version bump,
	// when every applied block has just become outdated as well.
	const inRefreshScope = (loc: SnippetLocation) =>
		loc.status === "outdated" || (refreshing === "save" && loc.status === "applied");
	const refreshCount = refreshing ? locations.filter(inRefreshScope).length : 0;
	const isRowRefreshing = (loc: SnippetLocation) => !!refreshing && inRefreshScope(loc);

	async function doRemove(loc: SnippetLocation, force = false) {
		await withPending(locKey(loc), async () => {
			try {
				await removeSnippet({
					name,
					project: loc.project,
					relativePath: loc.rel,
					force,
				});
				toast.info(`Removed from ${loc.rel}`, `${loc.project} · block excised`);
				onMutated();
			} catch (err) {
				toast.error("Couldn't remove snippet", String(err));
			}
		});
	}
	async function doUpdate(loc: SnippetLocation) {
		await withPending(locKey(loc), async () => {
			try {
				await updateSnippet({ name, project: loc.project, relativePath: loc.rel });
				toast.success(`Updated in ${loc.rel}`, `${loc.project} · now v${version}`);
				onMutated();
			} catch (err) {
				toast.error("Couldn't update snippet", String(err));
			}
		});
	}
	function copyPath(path: string) {
		copyToClipboard(path, {
			onSuccess: () => toast.success("Path copied", path),
			onError: () => toast.error("Couldn't copy the path", path),
		});
	}
	function revealInFinder(path: string) {
		// A location is scan-derived and can be stale — the file may have been
		// deleted since the scan ran — so the promise can reject for real.
		revealItemInDir(path).catch(() => toast.error("Couldn't reveal the file", path));
	}

	// Filter is a VIEW concern only — it narrows which rows RENDER, never the
	// counts the head/summary/Update-everywhere logic above reads (those stay
	// keyed off the full `locations`). Past `FILTER_THRESHOLD` total rows, a
	// search box appears at the top of the well (the EquipPicker idiom) and
	// matches project name or relative path.
	const showFilter = locations.length > FILTER_THRESHOLD;
	const filteredLocations = useMemo(() => {
		const q = query.trim().toLowerCase();
		// `!showFilter` matters on its own: Remove can shrink `locations` to
		// `FILTER_THRESHOLD` or below while a typed query survives (the box
		// itself unmounts right under the reader) — without this the well
		// would show "No locations match" with no input left on screen to
		// clear it.
		if (!showFilter || !q) return locations;
		return locations.filter(
			(l) => l.project.toLowerCase().includes(q) || l.rel.toLowerCase().includes(q),
		);
	}, [locations, query, showFilter]);

	// Group rows by project, preserving first-seen order — one `.equip-group`
	// per project, the same well USED BY shares for PROJECTS/BUNDLES.
	const groups: [string, SnippetLocation[]][] = [];
	for (const loc of filteredLocations) {
		const existing = groups.find(([project]) => project === loc.project);
		if (existing) existing[1].push(loc);
		else groups.push([loc.project, [loc]]);
	}

	const showUpdateAll = !scanning && !refreshing && !locked && outdatedCount > 0;
	// Closed is not hidden: the head states scanning/refreshing in flight, else
	// the static rollup a reader would otherwise open the section to see. Not
	// read when the button below is showing — it already carries the count.
	const summaryText = scanning
		? "scanning…"
		: refreshing
			? `refreshing ${refreshCount}…`
			: locations.length === 0
				? "not applied"
				: outdatedCount > 0
					? `${outdatedCount} outdated`
					: modifiedCount > 0
						? `${modifiedCount} hand-edited`
						: "all current";

	function menuItemsFor(loc: SnippetLocation): OverflowMenuItem[] {
		// The menu closes (unmounts) the instant an item is clicked — before
		// `withPending` ever runs — so an item's own `busy` can never render;
		// `disabled` is what has to carry the lock, gating the SAME two flags
		// the row frame and the inline Update button already read, so the row
		// and its menu never disagree about whether a mutation is in flight.
		const mutating = isRowRefreshing(loc) || pending.has(locKey(loc));
		return [
			{
				icon: "view.docs",
				label: "Open in Agent Docs",
				// No per-file deep link exists yet (Agent Docs auto-selects the
				// canonical root on load) — this lands on the project's Agent
				// Docs area, not this exact file.
				onClick: () =>
					navigate(`/project/${encodeURIComponent(loc.project)}?tab=agent-docs`),
			},
			{
				icon: "folder",
				label: "Reveal in Finder",
				onClick: () => revealInFinder(loc.path),
			},
			{
				icon: "link",
				label: "Copy path",
				onClick: () => copyPath(loc.path),
			},
			{ divider: true },
			{
				icon: "trash",
				label: "Remove",
				variant: "danger",
				disabled: mutating,
				onClick: () =>
					loc.status === "modified" ? setRemoveTarget(loc) : void doRemove(loc),
			},
		];
	}

	return (
		<>
		<SidePanelSection
			id="applied"
			title="Applied to"
			// Locations are unknown mid-scan (see below) — a hard `0` would lie
			// the same way "Not applied to any file yet" would.
			count={scanning ? undefined : locations.length}
			summary={
				// "Update everywhere" is the library's core propagate verb — it stays
				// in the HEAD row (rendered outside the toggle button) rather than
				// behind the disclosure, so collapsing the section never hides it.
				// The slot holds EITHER the button OR the plain summary, never both —
				// the button already carries the count, and the head row has no room
				// at the docked panel width for a title, a count, a summary line AND
				// a button all at once.
				showUpdateAll ? (
					<button
						type="button"
						className="snip-update-all"
						onClick={onUpdateEverywhere}
						title="Refresh every outdated location"
					>
						<Icon name="state.update" size={11} /> Update everywhere · {outdatedCount}
					</button>
				) : (
					summaryText
				)
			}
			defaultOpen
			storageKey={storageKey}
		>
			{scanning ? (
				// Locations are unknown mid-scan — showing "Not applied to any file
				// yet" here would be a lie if the scan turns up real ones. Two row
				// skeletons stand in for the eventual list.
				<div className="snip-loc-list">
					<SkeletonRow />
					<SkeletonRow />
				</div>
			) : locations.length === 0 ? (
				<div className="snip-applied-empty">
					<p>Not applied to any file yet.</p>
					<Button size="sm" icon="plus" onClick={onApplyOpen}>
						Apply to a file…
					</Button>
				</div>
			) : (
				<div className="equip-stack snip-applied-stack">
					{showFilter && (
						<div className="equip-picker-search">
							<SearchInput
								value={query}
								onChange={setQuery}
								placeholder="Filter by project or path…"
							/>
						</div>
					)}
					<div className="snip-applied-rows">
					{groups.length === 0 ? (
						<div className="equip-picker-empty">No locations match “{query}”.</div>
					) : (
						groups.map(([project, rows]) => (
							<Fragment key={project}>
								<div className="equip-group">
									<span className="equip-group-name">{project}</span>
									<span className="equip-group-count">{rows.length}</span>
								</div>
								{rows.map((loc, i) => {
									const rowRefreshing = isRowRefreshing(loc);
									const rowMutating = pending.has(locKey(loc));
									const { label, channel, shape, icon, transitional } = snipStatusMeta(
										loc.status,
									);
									return (
										<div
											key={loc.project + loc.rel + i}
											className="snip-loc"
											data-status={loc.status}
											// Also true for a row-local Remove/Update in flight, not
											// only the panel-wide refresh — the menu closes on click,
											// so the row frame is the only place left to carry that
											// feedback until the mutation settles and its toast fires.
											data-busy={rowRefreshing || rowMutating || undefined}
											// Dot-only on the row itself (R6: state rides on a dot,
											// never a word beside it) — the status word lives here
											// and on the dot's own `aria-label` instead. The section
											// summary already carries the rollup ("7 outdated").
											title={rowRefreshing ? "updating" : label}
										>
											<div className="snip-loc-name">
												<Icon name="doc" size={13} className="snip-loc-glyph" />
												<PathText
													path={loc.rel}
													title={loc.path}
													className="snip-loc-file"
													data-wrap
												/>
											</div>
											<div className="snip-loc-meta">
												{rowRefreshing ? (
													<span className="snip-loc-refreshing">
														<Spinner size={10} color="currentColor" /> updating
													</span>
												) : (
													<span className="snip-loc-status">
														<StatusBadge
															channel={channel}
															shape={shape}
															icon={icon}
															motion={transitional ? "pulse" : "none"}
															ariaLabel={label}
														/>
														{/* Shown only on outdated rows — see the file header
														    comment for why this is a proxy, not the fact. */}
														{loc.status === "outdated" && (
															<span className="snip-loc-version">v{loc.version}</span>
														)}
													</span>
												)}
												<div className="snip-loc-actions">
													{loc.status === "outdated" && (
														<Button
															size="sm"
															icon="state.update"
															busy={rowMutating}
															// One indicator per row while the refresh runs: the busy
															// frame above. The actions only lock, so a row never
															// shows two indicators at once.
															disabled={rowRefreshing}
															onClick={() => doUpdate(loc)}
															title={`Update ${loc.rel}`}
														/>
													)}
													<OverflowMenu
														triggerSize="sm"
														align="right"
														label={`More · ${loc.rel}`}
														items={menuItemsFor(loc)}
													/>
												</div>
											</div>
										</div>
									);
								})}
							</Fragment>
						))
					)}
					</div>
				</div>
			)}
		</SidePanelSection>

		{/* Hoisted out of the section body: it is portalled (so it never pollutes
		    the `.editor-side` disclosure guard) but the body unmounts on collapse,
		    which would otherwise strand a pending confirm with nothing on screen
		    to answer it. */}
		{removeTarget && (
			<ConfirmDialog
				open
				title="Remove a modified block?"
				confirmLabel="Remove anyway"
				tone="danger"
				confirmIcon="trash"
				onClose={() => setRemoveTarget(null)}
				onConfirm={() => {
					const l = removeTarget;
					setRemoveTarget(null);
					doRemove(l, true);
				}}
				body={
					<p>
						This block was edited by hand in{" "}
						<span className="text-mono">{removeTarget.rel}</span> (
						{removeTarget.project}). Removing it will{" "}
						<strong>discard those in-file edits</strong> — they aren&rsquo;t
						stored anywhere else.
					</p>
				}
			/>
		)}
		</>
	);
}
