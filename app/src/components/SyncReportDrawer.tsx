import { useEffect, useMemo, useRef, useState } from "react";
import { useRegistry } from "@/hooks/useRegistry";
import { useSyncReport } from "@/hooks/useSyncReport";
import { useRunSync } from "@/hooks/useRunSync";
import { useAppStore } from "@/store";
import { Button } from "@/components/Button";
import { Icon } from "@/components/Icon";
import { FreshnessDot } from "@/components/FreshnessBadge";
import {
	freshnessLabel,
	projectFreshness,
	projectRecord,
	relTime,
	type Freshness,
} from "@/lib/syncFreshness";

export interface SyncReportDrawerProps {
	open: boolean;
	onClose: () => void;
}

// Problems first so the drawer is glanceable: error → stale → unknown → fresh.
const STATE_RANK: Record<Freshness, number> = {
	error: 0,
	stale: 1,
	unknown: 2,
	fresh: 3,
};

/** Sync-report popover anchored above the StatusBar registry chip (design D4 /
 *  spec freshness-signal). Shows the last sync time, a per-project freshness
 *  row list with expandable errors + harness-affinity skips, and an honest
 *  empty state when no report exists. Esc / click-outside close it. */
export function SyncReportDrawer({ open, onClose }: SyncReportDrawerProps) {
	const { data: registry } = useRegistry();
	const { data: envelope } = useSyncReport();
	const runSync = useRunSync();
	const syncStatus = useAppStore((s) => s.syncStatus);
	const ref = useRef<HTMLDivElement | null>(null);
	const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

	useEffect(() => {
		if (!open) return;
		function onKey(e: KeyboardEvent) {
			if (e.key === "Escape") {
				e.stopPropagation();
				onClose();
			}
		}
		function onDown(e: MouseEvent) {
			const t = e.target as HTMLElement;
			// The toggling chip lives outside the drawer — let its own onClick
			// handle close, so a click on it doesn't double-fire (close then reopen).
			if (ref.current && !ref.current.contains(t) && !t.closest?.(".sync-chip")) {
				onClose();
			}
		}
		document.addEventListener("keydown", onKey);
		document.addEventListener("mousedown", onDown);
		return () => {
			document.removeEventListener("keydown", onKey);
			document.removeEventListener("mousedown", onDown);
		};
	}, [open, onClose]);

	const rows = useMemo(() => {
		const names = registry ? Object.keys(registry.projects) : [];
		return names
			.map((name) => ({
				name,
				state: projectFreshness(name, envelope),
				record: projectRecord(name, envelope),
			}))
			.sort(
				(a, b) =>
					STATE_RANK[a.state] - STATE_RANK[b.state] ||
					a.name.localeCompare(b.name),
			);
	}, [registry, envelope]);

	if (!open) return null;

	const report = envelope?.report ?? null;
	const syncing = syncStatus === "syncing";

	function toggle(name: string) {
		setExpanded((prev) => {
			const next = new Set(prev);
			if (next.has(name)) next.delete(name);
			else next.add(name);
			return next;
		});
	}

	return (
		<div className="sync-report-drawer" ref={ref} role="dialog" aria-label="Sync report">
			<div className="srd-head">
				<div className="srd-title">
					<Icon name="sync" size={12} />
					<span>Last sync</span>
					<span className="srd-when">
						{report ? relTime(report.generated_at) : "no record"}
					</span>
				</div>
				<Button
					variant="primary"
					size="sm"
					icon="refresh"
					disabled={syncing}
					onClick={() => void runSync()}
				>
					{syncing ? "Syncing…" : "Sync now"}
				</Button>
			</div>

			<div className="srd-body">
				{!report ? (
					<div className="srd-empty">
						<FreshnessDot state="unknown" />
						<div>
							<div className="srd-empty-title">No sync recorded yet</div>
							<div className="srd-empty-sub">
								Run a sync to write the registry to your agent folders and see
								per-project freshness here.
							</div>
						</div>
					</div>
				) : rows.length === 0 ? (
					<div className="srd-empty">
						<div>
							<div className="srd-empty-title">No projects registered</div>
						</div>
					</div>
				) : (
					<ul className="srd-list">
						{rows.map(({ name, state, record }) => {
							const errs = record?.errors ?? [];
							const skips = record?.affinity_skips ?? [];
							const hasDetail = errs.length > 0 || skips.length > 0;
							const isOpen = expanded.has(name);
							return (
								<li key={name} className="srd-row" data-state={state}>
									<button
										type="button"
										className="srd-row-head"
										onClick={() => hasDetail && toggle(name)}
										data-detail={hasDetail || undefined}
										aria-expanded={hasDetail ? isOpen : undefined}
									>
										<FreshnessDot state={state} />
										<span className="srd-name">{name}</span>
										{skips.length > 0 && (
											<span className="srd-skip-pip" title="skills reach no agent">
												{skips.length} skipped
											</span>
										)}
										{errs.length > 0 && (
											<span className="srd-err-pip">{errs.length} error</span>
										)}
										<span className="srd-when">
											{record ? relTime(record.ts) : freshnessLabel(state)}
										</span>
										{hasDetail && (
											<Icon
												name={isOpen ? "chevronUp" : "chevronDown"}
												size={11}
											/>
										)}
									</button>
									{hasDetail && isOpen && (
										<div className="srd-detail">
											{skips.length > 0 && (
												<div className="srd-skips">
													<div className="srd-skips-line">
														{skips.length}{" "}
														{skips.length === 1 ? "skill" : "skills"} won't reach
														any harness on <span className="mono">{name}</span>
													</div>
													<ul>
														{skips.map((s) => (
															<li key={s.skill}>
																<span className="mono">{s.skill}</span>
																<span className="srd-skip-why">
																	needs {s.skill_harnesses.join(", ") || "—"} ·
																	project has{" "}
																	{s.project_harnesses.join(", ") || "none"}
																</span>
															</li>
														))}
													</ul>
												</div>
											)}
											{errs.length > 0 && (
												<ul className="srd-errs">
													{errs.map((e, i) => (
														<li key={i}>
															<span className="srd-err-stage">{e.stage}</span>
															{e.message}
														</li>
													))}
												</ul>
											)}
										</div>
									)}
								</li>
							);
						})}
					</ul>
				)}
			</div>
		</div>
	);
}
