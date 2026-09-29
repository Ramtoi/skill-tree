import { Fragment, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { Icon } from "@/components/Icon";
import { SkillCard } from "@/components/SkillCard";
import { StatusBadge } from "@/components/StatusBadge";
import { InvocationBadge } from "@/components/InvocationBadge";
import { SkillInvocationOverride } from "@/components/SkillInvocationOverride";
import { type OverrideChoice } from "@/lib/invocation";
import { getBundleScope } from "@/lib/resolveActiveSkills";
import { affinityMismatch } from "@/lib/affinity";
import { skillMissesRefs, missingRefsIn } from "@/lib/missingRefs";
import { fromNav, projectBackTarget } from "@/lib/backTarget";
import type { Registry, Project } from "@/types";
import type { MissingRef } from "@/lib/syncFreshness";
import type { EquipSort, EquipStatus } from "@/screens/ProjectWorkspace";
import type { UsageFinding, UsageProjectPayload, UsageUtilizationRow } from "@/features/usage/usageAnalyticsTypes";
import type { HarnessFootprintTokens } from "@/lib/footprintTokens";
import { LoadoutUsageHeader } from "@/screens/project/LoadoutUsageHeader";
import { LoadoutUsageTrail } from "@/screens/project/LoadoutUsageTrail";
import { IdleExplanation } from "@/screens/project/IdleExplanation";
import { IdleBadge } from "@/components/IdleBadge";
import { useProjectReview } from "@/screens/project/ProjectReviewProvider";

export function loadoutBadges({
	affinity,
	missingRefs,
	idle,
	invocation,
}: {
	affinity?: ReactNode;
	missingRefs?: ReactNode;
	idle?: ReactNode;
	invocation?: ReactNode;
}): { leading?: ReactNode; rest?: ReactNode } {
	const ordered = [
		[affinity, true],
		[missingRefs, true],
		[idle, true],
		[invocation, false],
	] as const;
	const present = ordered.filter(([node]) => node !== undefined && node !== null);
	const leading = present.find(([, canLead]) => canLead)?.[0];
	const rest = present
		.filter(([node]) => node !== leading)
		.map(([node], index) => <Fragment key={`loadout-badge-${index}`}>{node}</Fragment>);
	return { leading, rest: rest.length ? <>{rest}</> : undefined };
}

export function EquippedSkillsGrid({
	projectName,
	proj,
	registry,
	equipped,
	orderedEquipped,
	equipSort,
	onSetEquipSort,
	dragOver,
	onSetDragOver,
	onDrop,
	bundleProvidedSet,
	installedHarnessIds,
	recentlyEquipped,
	equipStatus,
	missingRefs,
	onSetInvocationOverride,
	onDisableSkill,
	usage,
	footprintTokens,
}: {
	projectName: string;
	proj: Project;
	registry: Registry;
	equipped: string[];
	orderedEquipped: string[];
	equipSort: EquipSort;
	onSetEquipSort: (sort: EquipSort) => void;
	dragOver: "equipped" | "avail" | null;
	onSetDragOver: (zone: "equipped" | "avail" | null) => void;
	onDrop: (zone: "equipped" | "avail", skillName: string) => void;
	bundleProvidedSet: Set<string>;
	installedHarnessIds: string[];
	recentlyEquipped: Record<string, number>;
	equipStatus: Record<string, EquipStatus>;
	/** Evidence from the last sync report: equipped skills whose references
	 *  this project lacks. `[]` for a clean or never-synced project. */
	missingRefs: MissingRef[];
	onSetInvocationOverride: (
		skillName: string,
		choice: OverrideChoice,
		previous: "auto" | "user-only" | "model-only" | undefined,
	) => void;
	onDisableSkill: (skillName: string) => void;
	usage: UsageProjectPayload | undefined;
	footprintTokens: HarnessFootprintTokens | null;
}) {
	const navigate = useNavigate();
	const review = useProjectReview();
	const idleFinding: UsageFinding | undefined = usage?.findings.find((finding) => finding.kind === "idle");
	const utilization = new Map<string, UsageUtilizationRow>(usage?.utilization.map((row) => [row.key, row]) ?? []);

	return (
		<div
			className={`loadout-section${review.isParticipating("loadout") ? " review-area-emphasis" : ""}`}
			data-review-area={review.isParticipating("loadout") ? "loadout" : undefined}
		>
			<div className="loadout-head">
				<h3>
					<Icon name="plug" size={14} />
					<span style={{ whiteSpace: "nowrap" }}>Equipped skills</span>
					<span className="count">{equipped.length}</span>
				</h3>
				<span className="stretch" />
				<div className="loadout-tools">
						<LoadoutUsageHeader lastScanAt={usage?.last_scan_at ?? null} />
							<label className="loadout-sort">
								<span>sort</span>
								<select
									value={equipSort}
									onChange={(e) => onSetEquipSort(e.target.value as EquipSort)}
									aria-label="Sort equipped skills"
								>
									<option value="newest">Newest</option>
									<option value="name">Name</option>
								</select>
							</label>
							<span
								style={{
									display: "flex",
									alignItems: "center",
									gap: 12,
									fontFamily: "var(--font-mono)",
									fontSize: 10.5,
									color: "var(--fg-mute)",
								}}
							>
								<span
									style={{
										display: "inline-flex",
										alignItems: "center",
										gap: 4,
									}}
								>
									<span
										style={{
											width: 8,
											height: 8,
											borderRadius: 2,
											background:
												"color-mix(in oklab, var(--amber) 50%, transparent)",
										}}
									/>{" "}
									direct
								</span>
								<span
									style={{
										display: "inline-flex",
										alignItems: "center",
										gap: 4,
									}}
								>
									<span
										style={{
											width: 8,
											height: 8,
											borderRadius: 2,
											background: "var(--fg-dim)",
										}}
									/>{" "}
									from bundle
								</span>
							</span>
				</div>
			</div>
				<div
					className={`skill-grid ${dragOver === "equipped" ? "dropzone-active" : ""}`}
					onDragOver={(e) => {
						e.preventDefault();
						onSetDragOver("equipped");
					}}
					onDragLeave={() => onSetDragOver(null)}
					onDrop={(e) => onDrop("equipped", e.dataTransfer.getData("text/skill"))}
					style={{ minHeight: 80 }}
				>
					{equipped.length === 0 && (
						<div
							style={{
								gridColumn: "1 / -1",
								textAlign: "center",
								padding: "28px 0",
								color: "var(--fg-mute)",
								fontSize: 12,
								border: "1px dashed var(--border)",
								borderRadius: 6,
							}}
						>
							No skills equipped. Drag a skill here, or apply a bundle.
						</div>
					)}
					{orderedEquipped.map((name) => {
						const skill = registry.skills[name];
						if (!skill) return null;
						const inDirect = proj.enabled.includes(name);
						const viaBundle = bundleProvidedSet.has(name) && !inDirect;
						// Providing bundles = applied OR globally-scoped bundles
						// that contain this skill (design D1 — includes globals).
						const viaNames = Object.entries(registry.bundles)
							.filter(
								([bn, b]) =>
									(getBundleScope(b) === "global" ||
										proj.bundles.includes(bn)) &&
									(b.skills ?? []).includes(name),
							)
							.map(([bn]) => bn);
						// M8: an equipped skill whose harness affinity excludes
						// every effective harness of this project won't sync here.
						const wontSync = affinityMismatch(
							skill,
							proj,
							registry,
							installedHarnessIds,
						);
						// Triggering doesn't apply to MCP servers (no frontmatter
						// invocation flags) — the control and its at-rest badge are
						// both gated the same way the old `invocationControl` was.
						const canOverrideInvocation = skill.type !== "mcp-server";
						const invocationOverride = proj.invocation_overrides?.[name];
						const reviewHighlight = review.highlight.includes(name);
						// skill-refs: this skill mentions a registry skill the project
						// does not have (evidence from the last sync report — see
						// lib/missingRefs.ts). A skill that also won't reach any
						// harness is the more severe fact, so the affinity badge keeps
						// the leading slot and this one is demoted into `badges`.
						const missesRefs = skillMissesRefs(missingRefs, name);
						const missingRefNames = missesRefs
							? missingRefsIn(missingRefs, name)
							: [];
						const missingRefsBadge = missesRefs ? (
							<StatusBadge
								channel="warn"
								shape="pill"
								icon="link"
								className="skill-missing-refs-badge"
								ariaLabel="References a skill this project does not have"
								title={`This skill references ${missingRefNames.join(", ")}, which ${missingRefNames.length === 1 ? "is" : "are"} not equipped on ${projectName} — the reference will not resolve when the agent follows it.`}
							/>
						) : undefined;
						const row = utilization.get(name);
						const isIdle = row?.idle === true;
						const idleBadge = isIdle ? (idleFinding ? (
							<IdleExplanation
								finding={idleFinding}
								row={row}
								skillKey={name}
								projectName={projectName}
								bundleName={viaBundle ? viaNames[0] : undefined}
								canUnequip={inDirect && !viaBundle}
								canOverrideInvocation={canOverrideInvocation}
								tokens={footprintTokens}
							/>
						) : <IdleBadge />) : undefined;
						const invocationBadge =
							canOverrideInvocation && invocationOverride !== undefined ? (
								<InvocationBadge
									invocation={invocationOverride}
									requested
									className="invocation-override-badge"
								/>
							) : undefined;
						const badges = loadoutBadges({
							affinity: wontSync ? (
								<StatusBadge
									channel="warn"
									shape="pill"
									icon="warning"
									className="skill-affinity-badge"
									ariaLabel="Won't sync here — no matching harness"
									title={`This skill declares harnesses: [${(skill.harnesses ?? []).join(", ")}], none of which are active on this project — it won't sync here. Enable a matching harness.`}
								/>
							) : undefined,
							missingRefs: missingRefsBadge,
							idle: idleBadge,
							invocation: invocationBadge,
						});
						return (
							<SkillCard
								key={name}
								className={
									[
										reviewHighlight ? "skill-card-review" : "",
										recentlyEquipped[name]
											? "skill-card-newly-equipped"
											: "",
										equipStatus[name] === "pending"
											? "skill-card-unequipping"
											: "",
									]
										.filter(Boolean)
										.join(" ") || undefined
								}
								leadingBadge={badges.leading}
								name={name}
								kind={skill.type}
								scope={skill.scope}
								description={skill.description}
								version={skill.version}
								badges={badges.rest}
									trail={row ? (
									<LoadoutUsageTrail
										row={row}
										tokens={footprintTokens}
										skillKey={name}
										lastScanAt={usage?.last_scan_at ?? null}
									/>
									) : undefined}
								dim={isIdle && !wontSync && !missesRefs}
								// Hover-revealed inside SkillCard's `.card-actions` (decision 4)
								// — the at-rest signal is the badge above, not this trigger.
								actions={
									canOverrideInvocation ? (
										<SkillInvocationOverride
											skillName={name}
											projectName={projectName}
											libraryInvocation={skill.invocation}
											override={invocationOverride}
											scope={skill.scope}
											onPick={(choice, prev) =>
												void onSetInvocationOverride(name, choice, prev)
											}
										/>
									) : undefined
								}
								draggable
								onDragStart={(e) => e.dataTransfer.setData("text/skill", name)}
								onClick={() =>
									navigate(
										`/skill/${encodeURIComponent(name)}`,
										fromNav(projectBackTarget(projectName)),
									)
								}
								equipped={inDirect && !viaBundle}
								via={viaBundle ? "bundle" : null}
								onUnequipped={
									inDirect && !viaBundle ? () => onDisableSkill(name) : undefined
								}
								source={
									viaBundle ? (
										<span style={{ color: "var(--fg-mute)" }}>
											via{" "}
											{viaNames.map((bn, i) => (
												<Fragment key={bn}>
													{i > 0 && ", "}
													<button
														type="button"
														className="via-bundle-link"
														onClick={(e) => {
															e.stopPropagation();
															navigate(
																`/bundle/${encodeURIComponent(bn)}`,
																fromNav(projectBackTarget(projectName)),
															);
														}}
													>
														{bn}
													</button>
												</Fragment>
											))}
										</span>
									) : (
										<span style={{ color: "var(--amber)" }} title="Equipped directly">
											◆
										</span>
									)
								}
							/>
						);
					})}
				</div>
		</div>
	);
}
