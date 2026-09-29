import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useRegistry } from "@/hooks/useRegistry";
import { useSyncReport } from "@/hooks/useSyncReport";
import { useRunSync, useSyncing } from "@/hooks/useRunSync";
import { LoadingButton } from "@/components/loading";
import { Icon } from "@/components/Icon";
import { FreshnessDot } from "@/components/FreshnessBadge";
import {
	freshnessLabel,
	groupedSyncErrors,
	projectFreshness,
	projectRecord,
	relTime,
	type Freshness,
} from "@/lib/syncFreshness";

export interface SyncReportDrawerProps {
	open: boolean;
	onClose: () => void;
}

// Problems first so the drawer is glanceable: error → quarantined (F1: not a
// failure, but never a healthy sync either) → stale → unknown → fresh.
const STATE_RANK: Record<Freshness, number> = {
	error: 0,
	quarantined: 1,
	stale: 2,
	unknown: 3,
	fresh: 4,
};

/** Sync-report popover anchored above the StatusBar registry chip (design D4 /
 *  spec freshness-signal). Shows the last sync time, a per-project freshness
 *  row list with expandable errors + harness-affinity skips, and an honest
 *  empty state when no report exists. Esc / click-outside close it. */
export function SyncReportDrawer({ open, onClose }: SyncReportDrawerProps) {
	const { data: registry } = useRegistry();
	const { data: envelope } = useSyncReport();
	const runSync = useRunSync();
	const syncing = useSyncing();
	const navigate = useNavigate();
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
				state: projectFreshness(name, envelope, registry?.projects[name]),
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

	function toggle(name: string) {
		setExpanded((prev) => {
			const next = new Set(prev);
			if (next.has(name)) next.delete(name);
			else next.add(name);
			return next;
		});
	}

	// F1/A6: "Attach directory" leaves the popover (a route change), so close
	// it first — otherwise it would stay mounted over the recovery route.
	function goAttach() {
		onClose();
		navigate("/recovery");
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
				<LoadingButton
					variant="primary"
					size="sm"
					icon="refresh"
					loading={syncing}
					loadingLabel="Syncing…"
					onClick={() => void runSync()}
				>
					Sync now
				</LoadingButton>
			</div>

			<div className="srd-body">
        {report?.global.skills.ok === false && (
          <div role="status" className="srd-empty-sub">
            Global skill delivery failed.
            {(report.global.skills.errors ?? []).map((error, index) => <p key={index}>{error.message}</p>)}
          </div>
        )}
        {(report?.global.skills.invocation ?? []).filter((row) => row.delivery === "failed" || row.support === "unsupported" || row.support === "unknown").map((row) => (
          <p key={`${row.skill}:${row.harness}`} className="srd-empty-sub">
            {row.skill} · {row.harness}: {row.delivery === "failed" ? "Failed to apply" : row.support === "unknown" ? "Not verified" : "Saved with limits"}.
            {" "}{row.reason ?? row.limitations?.join(" ")}
          </p>
        ))}
        {!!report?.global.skills.skipped_unowned && <p className="srd-empty-sub">
          {report.global.skills.skipped_unowned} global links belong to another installation. Sync left them unchanged to protect that installation.
        </p>}
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
							// F3: group raw stage errors (symlink + invocation, one root
							// cause each) so "10 errors" from 5 missing sources reads as
							// 5 actionable items — full stage detail stays on expand.
							const errorGroups = groupedSyncErrors(errs);
							const skips = record?.affinity_skips ?? [];
							const protectedLinks = record?.skipped_unowned ?? 0;
							const invocationLimits = (record?.invocation ?? []).filter(
								(row) => row.delivery === "failed" || row.support === "unsupported" || row.support === "unknown",
							);
							// F1: quarantined is its own kind of detail — no errors/skips,
							// just why sync refuses to touch this project, plus a way out.
							const quarantined = state === "quarantined";
							const hasDetail = errs.length > 0 || skips.length > 0 || protectedLinks > 0 || invocationLimits.length > 0 || quarantined;
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
										{quarantined && (
											<span className="srd-quarantine-pip" title="no local directory attached">
												no directory
											</span>
										)}
										{skips.length > 0 && (
											<span className="srd-skip-pip" title="skills reach no agent">
												{skips.length} skipped
											</span>
										)}
										{errorGroups.length > 0 && (
											<span className="srd-err-pip">
												{errorGroups.length} error{errorGroups.length === 1 ? "" : "s"}
											</span>
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
                      {quarantined && (
                        <p className="srd-quarantine-detail">
                          No local directory attached.{" "}
                          {record?.quarantined ?? record?.skip_reason ?? "Sync makes no writes for this project until a directory is attached."}
                          <button type="button" className="srd-quarantine-link" onClick={goAttach}>
                            Attach directory →
                          </button>
                        </p>
                      )}
                      {invocationLimits.map((row) => <p key={`${row.skill}:${row.harness}`}>
                        {row.skill} · {row.harness}: {row.delivery === "failed" ? "Failed to apply" : row.support === "unknown" ? "Not verified" : "Saved with limits"}.
                        {" "}{row.reason ?? row.limitations?.join(" ")}
                      </p>)}
                      {protectedLinks > 0 && <p>{protectedLinks} links belong to another installation. Sync left them unchanged.</p>}
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
											{errorGroups.length > 0 && (
												<ul className="srd-errs">
											{errorGroups.map((group) => (
														<li key={group.message}>
															<div>{group.message}</div>
                            {group.message.startsWith("source missing:") && <button type="button" className="srd-quarantine-link" onClick={() => { onClose(); navigate("/recovery?stage=sources"); }}>Recover sources →</button>}
															<ul className="srd-err-stages">
																{group.stages.map((stage, i) => (
																	<li key={i}>
																		<span className="srd-err-stage">{stage.stage}</span>
														{stage.skill ? `${stage.skill} · ` : ""}
																		{stage.harnesses?.length ? stage.harnesses.join(", ") : null}
																	</li>
																))}
															</ul>
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
