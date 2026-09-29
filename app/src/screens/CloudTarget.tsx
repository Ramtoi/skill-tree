import { Fragment, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";

import { hubCmd } from "@/lib/hubCmd";
import { Button } from "@/components/Button";
import { LoadingButton } from "@/components/loading";
import { trackProcess } from "@/lib/trackProcess";
import { EmptyState } from "@/components/EmptyState";
import { EquipPicker, type EquipTarget } from "@/components/EquipPicker";
import { Icon } from "@/components/Icon";
import { ResourceRow } from "@/components/ResourceRow";
import { ScreenHeader } from "@/components/ScreenHeader";
import { SectionHeader } from "@/components/SectionHeader";
import { Tag } from "@/components/Tag";
import { useToast } from "@/components/Toast";
import { CloudStatusBadge } from "@/components/cloud/CloudStatusBadge";
import { useRegistry } from "@/hooks/useRegistry";
import { relTime } from "@/lib/syncFreshness";
import { useCloudStatus, useCloudTargets, invalidateCloud } from "@/hooks/useCloud";
import {
	buildCloudBundleTargets,
	buildCloudSkillTargets,
} from "@/hooks/useEquipTargets";
import {
	cloudCatalogLabel,
	parseHubJson,
	type CloudExportResult,
} from "@/lib/cloud";

/**
 * Style the `backtick` spans the backend authors inside a note, without
 * changing a character of it. The notes are quoted verbatim by contract, and
 * raw backticks on screen read as a rendering bug — this only swaps the
 * delimiters for the mono treatment the same identifiers get everywhere else.
 */
function renderNote(note: string) {
	const parts = note.split("`");
	// An unbalanced backtick means the text is not marked up the way we assume —
	// leave it completely alone rather than eat a character.
	if (parts.length < 3 || parts.length % 2 === 0) return note;
	return parts.map((p, i) =>
		i % 2 === 1 ? (
			<code key={i}>{p}</code>
		) : (
			<Fragment key={i}>{p}</Fragment>
		),
	);
}

/**
 * One cloud target (`/cloud/:id`).
 *
 * The manual upload is a seam nothing can remove, so the screen is built around
 * it honestly rather than around a fake sync: ONE primary action that does the
 * two mechanical steps for you (build the ZIPs, put the product's upload page
 * and the folder in front of you), a status list that says only what hub can
 * actually know — whether each skill still matches the ZIP it last built — and
 * the product's own limits quoted verbatim. Every action here is reversible and
 * cheap, so nothing asks for confirmation.
 */
export function CloudTarget() {
	const { id = "" } = useParams<{ id: string }>();
	const navigate = useNavigate();
	const toast = useToast();
	const { data: registry } = useRegistry();
	const { data: targets } = useCloudTargets();
	const { data: status, isLoading, error } = useCloudStatus(id);
	const [equipKind, setEquipKind] = useState<"bundle" | "skill" | null>(null);
	const [exporting, setExporting] = useState(false);

	const catalogTarget = targets?.find((t) => t.id === id);
	const label = status?.label ?? catalogTarget?.label ?? cloudCatalogLabel(id) ?? id;
	const uploadPath = status?.upload_path ?? catalogTarget?.upload_path;
	const notes = status?.notes ?? catalogTarget?.notes ?? [];
	// The equip model is the project model (bundles ∪ enabled), read straight off
	// the registry's `cloud:` block — the same source `hub cloud equip` writes.
	const equipped = registry?.cloud?.[id] ?? { bundles: [], enabled: [] };
	const rows = status?.skills ?? [];
	const summary = status?.summary;

	async function toggleEquip(
		kind: "bundle" | "skill",
		target: EquipTarget,
		next: "on" | "off",
	) {
		const res = await hubCmd([
			"cloud",
			"equip",
			id,
			"--kind",
			kind,
			"--name",
			target.name,
			"--state",
			next,
		]);
		if (!res.success) {
			toast.error(`Couldn't equip ${kind}`, res.output?.trim() || undefined);
			// Reject so the picker reverts its optimistic row.
			throw new Error(res.output);
		}
		await invalidateCloud(id);
	}

	/** Build the ZIPs, then hand the user the two things the upload needs: the
	 *  product's page and the folder holding the archives.
	 *
	 *  A partial export exits NON-ZERO but still prints its full JSON, so the
	 *  payload — not `res.success` — decides what the user is told. One toast
	 *  per outcome: a success toast followed by an error toast contradicted
	 *  itself, and claiming "Exported 3 skills" when one of them failed is the
	 *  overclaim this whole screen exists to avoid. */
	async function exportAndOpen() {
		setExporting(true);
		try {
			// Building one ZIP per equipped skill is real disk work, so it reports
			// through the app's one live-work banner like every other action. The
			// toasts below stay: they carry the manual UPLOAD step, which outlives
			// an auto-dismissing card.
			const res = await trackProcess(
				{
					title: `Exporting for ${label}`,
					body: "building one ZIP per equipped skill",
					kind: "fs",
					target: `cloud:${id}`,
				},
				() => hubCmd(["cloud", "export", id, "--json"]),
				{ successBody: "ZIPs written — upload them yourself" },
			);
			let payload: CloudExportResult | null = null;
			try {
				payload = parseHubJson<CloudExportResult>(res.output);
			} catch {
				payload = null;
			}
			if (!payload) {
				toast.error(
					`Couldn't export to ${label}`,
					res.output?.trim() || undefined,
				);
				return;
			}
			await invalidateCloud(id);

			const n = payload.results.length;
			const failed = payload.errors.length;

			// Opening the browser / Finder is a convenience, not the result — a
			// failure there must not read as a failed export. Skipped entirely when
			// nothing was built: throwing the user at an empty folder and a browser
			// tab after a total failure is noise on top of bad news.
			if (n > 0) {
				// Reveal a ZIP, not the folder: revealing `out_dir` highlighted the
				// DIRECTORY in its parent, and dragging that highlighted item onto
				// claude.ai's dropzone fails with "must have a .skill, .zip, or .md
				// extension". Revealing a file opens the export folder with that
				// archive selected, so what is under the cursor is uploadable.
				try {
					await revealItemInDir(payload.results[0].zip_path);
				} catch {
					/* no reveal available — the toast still names the folder */
				}
				try {
					await openUrl(payload.upload_url);
				} catch {
					/* no browser available — the toast still names the upload path */
				}
			}

			if (failed === 0) {
				toast.info(
					`Exported ${n} skill${n === 1 ? "" : "s"} for ${label}`,
					`ZIPs are in ${payload.out_dir} — upload them at ${payload.upload_path}`,
				);
			} else {
				toast.error(
					n > 0
						? `Exported ${n} of ${n + failed} skills for ${label}`
						: `Couldn't export to ${label}`,
					n > 0
						? `${payload.errors.join(" · ")} — the ${n} that worked are in ${payload.out_dir}`
						: payload.errors.join(" · "),
				);
			}
		} catch (e) {
			toast.error(`Couldn't export to ${label}`, String(e));
		} finally {
			setExporting(false);
		}
	}

	// Only claim "nothing to export" once the status actually resolved — a
	// primary that is briefly dead while a query lands reads as broken.
	const nothingEquipped = !!status && summary?.equipped === 0;

	return (
		<>
			{/* No `crumbs`: a crumb trail renders mono (crumbs are identifiers), and
			    passing one forces the honest-state subline into that same mono run
			    — where it was guillotined at 1024 and dropped outright at 520. The
			    in-product upload path is prose about somebody else's UI, so it
			    lives in the two-step strip below instead. */}
			<ScreenHeader
				back={{ label: "Remotes", onClick: () => navigate("/remotes") }}
				title={label}
				/* C5: the title-row chip is a Tag, not a bespoke span. `Tag` is
				   already mono; the id keeps its own case. */
				meta={
					<Tag size="sm" style={{ textTransform: "none" }}>
						{id}
					</Tag>
				}
				subline="Manual ZIP upload · hub tracks what you last exported"
				primary={
					<LoadingButton
						variant="primary"
						icon="export"
						loading={exporting}
						loadingLabel="Exporting…"
						disabled={nothingEquipped}
						disabledReason={
							nothingEquipped
								? "Equip a bundle or a skill first — there is nothing to export."
								: undefined
						}
						onClick={() => void exportAndOpen()}
						data-testid="cloud-export"
					>
						{`Export & open ${label}`}
					</LoadingButton>
				}
			/>

			<div className="cloud-detail">
				{error ? (
					<EmptyState
						icon="warning"
						title="Couldn't load this cloud target"
						description={String(error)}
					/>
				) : (
					<>
						{(status?.warnings ?? []).map((w) => (
							<div key={w} className="cloud-warning">
								<Icon name="warning" size={13} /> {w}
							</div>
						))}

						{/* The seam, stated where the user lands — before and AFTER the
						    export, which throws them out to Finder and a browser tab.
						    A toast would have said this once and evaporated; the one
						    step hub cannot do for you has to stay on the screen. */}
						{uploadPath && (
							<ol className="cloud-howto" data-testid="cloud-howto">
								<li>
									<span className="cloud-howto-num">1</span>
									<span>
										<b>Export</b> — hub writes one ZIP per equipped skill and
										opens the folder.
									</span>
								</li>
								<li>
									<span className="cloud-howto-num">2</span>
									<span>
										<b>Upload each ZIP yourself</b> in {label}:{" "}
										<code>{uploadPath}</code> — drop the{" "}
										<code>.zip</code> files one at a time, not the folder.
										Hub cannot do this step — {label} has no API to sync into.
									</span>
								</li>
							</ol>
						)}

						{/* ── Equipped ── */}
						<section className="cloud-detail-section">
							<SectionHeader
								label="Equipped"
								count={summary?.equipped}
								right={
									/* Soft in BOTH states: a section-level disclosure toggle is
									   not the screen's primary, and going violet while the
									   header's "Export & open …" is also violet put two
									   primaries on one screen. */
									<Button
										variant="soft"
										size="sm"
										icon="equip"
										onClick={() => setEquipKind((k) => (k ? null : "bundle"))}
									>
										{equipKind ? "Done" : "Equip…"}
									</Button>
								}
							/>

							{equipKind && registry && (
								<div className="remote-equip-panel cloud-equip-panel">
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
											subject={{ kind: "cloud", name: label }}
											targets={buildCloudBundleTargets(equipped, registry)}
											onToggle={(t, next) => toggleEquip("bundle", t, next)}
											searchPlaceholder="Equip bundle on this cloud app…"
											emptyLabel="No bundles defined."
											settledLabel="queued"
										/>
									) : (
										<EquipPicker
											variant="inline"
											subject={{ kind: "cloud", name: label }}
											targets={buildCloudSkillTargets(equipped, registry)}
											onToggle={(t, next) => toggleEquip("skill", t, next)}
											searchPlaceholder="Equip skill on this cloud app…"
											emptyLabel="No skills in the registry."
											settledLabel="queued"
										/>
									)}
								</div>
							)}

							{isLoading ? (
								<div className="cloud-section-hint">Reading export state…</div>
							) : rows.length === 0 ? (
								<EmptyState
									icon="equip"
									title="Nothing equipped"
									/* The two mechanical steps are spelled out in the strip
									   above; this says only what that strip cannot. */
									description="Equipping changes the registry only — nothing leaves this machine until you export."
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
								<div className="cloud-skill-list" data-testid="cloud-skill-list">
									{rows.map((r) => (
										<ResourceRow
											key={r.skill}
											name={r.skill}
											meta={
												/* Only for rows that HAVE an export: "never exported"
												   next to a `new` badge says the same thing twice
												   (COMPONENTS.md show-don't-tell). The raw ISO stamp
												   is kept on hover — a glance wants "2d ago". */
												r.exported_at ? (
													<span
														className="cloud-row-when text-dim"
														title={r.exported_at}
													>
														last export {relTime(r.exported_at)}
													</span>
												) : undefined
											}
											desc={
												r.lint.length > 0 ? (
													<span className="cloud-lint">
														<Icon name="warning" size={10} />{" "}
														{r.lint.join(" · ")}
													</span>
												) : undefined
											}
											badges={<CloudStatusBadge status={r.status} />}
											dataset={{ status: r.status }}
											className="cloud-skill-row"
										/>
									))}
								</div>
							)}
						</section>

						{/* ── Orphans: exported before, no longer equipped ── */}
						{(status?.orphaned ?? []).length > 0 && (
							<section className="cloud-detail-section">
								<SectionHeader
									label="Orphaned"
									count={status?.orphaned.length}
								/>
								<p className="cloud-section-hint">
									Exported before, no longer equipped. The next export deletes
									each ZIP hub wrote — remove them inside {label} yourself.
								</p>
								<div className="cloud-skill-list">
									{(status?.orphaned ?? []).map((o) => (
										<ResourceRow
											key={o.skill}
											name={o.skill}
											meta={
												<span className="text-dim text-mono">{o.zip_name}</span>
											}
											badges={<CloudStatusBadge status="orphaned" />}
											className="cloud-skill-row"
										/>
									))}
								</div>
							</section>
						)}

						{/* ── Not exportable ── */}
						{(status?.unsupported ?? []).length > 0 && (
							<section className="cloud-detail-section">
								<SectionHeader
									label="Not exportable"
									count={status?.unsupported.length}
								/>
								<div className="cloud-skill-list">
									{(status?.unsupported ?? []).map((u) => (
										<ResourceRow
											key={u.skill}
											name={u.skill}
											desc={
												<span className="cloud-lint">
													<Icon name="warning" size={10} /> {u.reason}
												</span>
											}
											className="cloud-skill-row"
										/>
									))}
								</div>
							</section>
						)}

						{/* ── The product's own limits, quoted verbatim ── */}
						{notes.length > 0 && (
							<section className="cloud-detail-section">
								<SectionHeader label="Limits" />
								<ul className="cloud-notes" data-testid="cloud-notes">
									{notes.map((n) => (
										<li key={n}>{renderNote(n)}</li>
									))}
								</ul>
							</section>
						)}
					</>
				)}
			</div>
		</>
	);
}
