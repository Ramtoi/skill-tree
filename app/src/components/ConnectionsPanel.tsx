import { useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import type { Registry, SourceView } from "@/types";
import { EquipPicker } from "./EquipPicker";
import { SkillPreloadedBy } from "./subagents/SkillPreloadedBy";
import { SourceChip } from "./SourceChip";
import { Icon } from "./Icon";
import { HarnessGlyph } from "./harness/HarnessGlyph";
import { harnessLabel } from "./harness/harnessRegistry";
import {
	buildSkillProjectTargets,
	buildSkillBundleTargets,
} from "@/hooks/useEquipTargets";
import { useSkillProjectEquip, useSkillBundleEquip } from "@/hooks/useEquip";
import type { EquipState } from "./EquipPicker";

interface ConnectionsPanelProps {
	skillName: string;
	registry: Registry;
	ownerSource?: SourceView | null;
	installedHarnesses: string[];
	/** Editor-managed affinity ([] = all effective harnesses). */
	affinity: string[];
	onAffinityChange: (next: string[]) => void;
}

interface SectionProps {
	id: string;
	title: string;
	count?: number;
	summary?: ReactNode;
	defaultOpen?: boolean;
	children: ReactNode;
}

function Section({ id, title, count, summary, defaultOpen, children }: SectionProps) {
	const [open, setOpen] = useState(!!defaultOpen);
	return (
		<div className="conn-section" data-open={open || undefined} data-conn={id}>
			<div className="conn-head-row">
				<button
					type="button"
					className="conn-head"
					aria-expanded={open}
					onClick={() => setOpen((v) => !v)}
				>
					<Icon name={open ? "chevronDown" : "chevronRight"} size={12} />
					<span className="conn-title">{title}</span>
					{count !== undefined && <span className="conn-count">{count}</span>}
				</button>
				{/* Summary lives OUTSIDE the toggle button so it may hold links/chips. */}
				<span className="conn-summary">{summary}</span>
			</div>
			{open && <div className="conn-body">{children}</div>}
		</div>
	);
}

/** Compact glanceable dots summarizing target states. */
function StateDots({ states }: { states: EquipState[] }) {
	const on = states.filter((s) => s === "on").length;
	const via = states.filter((s) => s === "via-bundle").length;
	if (states.length === 0) return <span className="text-dim">none</span>;
	return (
		<span className="conn-dots" title={`${on} direct · ${via} via bundle`}>
			{on > 0 && (
				<span className="conn-dot" data-state="on">
					{on} on
				</span>
			)}
			{via > 0 && (
				<span className="conn-dot" data-state="via-bundle">
					{via} via bundle
				</span>
			)}
			{on === 0 && via === 0 && <span className="text-dim">none</span>}
		</span>
	);
}

/**
 * The skill editor's unified neighborhood view (D4). One glanceable section per
 * relation (Projects · N / Bundles · N / Harness targets / Sub-agents / Source),
 * each disclosing an actionable edge list — the inline EquipPicker for projects
 * and bundles, the affinity control for harnesses, and the embedded
 * SkillPreloadedBy for sub-agents (unchanged).
 */
export function ConnectionsPanel({
	skillName,
	registry,
	ownerSource,
	installedHarnesses,
	affinity,
	onAffinityChange,
}: ConnectionsPanelProps) {
	const navigate = useNavigate();
	const projectTargets = useMemo(
		() => buildSkillProjectTargets(skillName, registry),
		[skillName, registry],
	);
	const bundleTargets = useMemo(
		() => buildSkillBundleTargets(skillName, registry),
		[skillName, registry],
	);
	const onProjectToggle = useSkillProjectEquip(skillName);
	const onBundleToggle = useSkillBundleEquip(skillName);

	const bundlesEquipped = bundleTargets.filter((t) => t.state === "on").length;

	// affinity = [] → all effective. A chip is "active" (targeted) when affinity
	// is empty or lists it.
	const allMode = affinity.length === 0;
	const targeted = new Set(allMode ? installedHarnesses : affinity);

	function toggleHarness(id: string) {
		const next = new Set(targeted);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		// Empty or every-installed → store [] (all effective).
		if (next.size === 0 || next.size === installedHarnesses.length) {
			onAffinityChange([]);
		} else {
			onAffinityChange(installedHarnesses.filter((h) => next.has(h)));
		}
	}

	return (
		<div className="connections-panel" aria-label="Connections">
			<Section
				id="projects"
				title="Projects"
				count={projectTargets.length}
				summary={<StateDots states={projectTargets.map((t) => t.state)} />}
				defaultOpen
			>
				<EquipPicker
					variant="inline"
					subject={{ kind: "skill", name: skillName }}
					targets={projectTargets}
					onToggle={onProjectToggle}
					searchPlaceholder="Filter projects…"
					emptyLabel="No projects registered."
				/>
			</Section>

			<Section
				id="bundles"
				title="Bundles"
				count={bundleTargets.length}
				summary={
					<span className="text-dim">
						{bundlesEquipped > 0 ? `in ${bundlesEquipped}` : "none"}
					</span>
				}
			>
				<EquipPicker
					variant="inline"
					subject={{ kind: "skill", name: skillName }}
					targets={bundleTargets}
					onToggle={onBundleToggle}
					searchPlaceholder="Add to bundle…"
					emptyLabel="No bundles defined."
				/>
			</Section>

			<Section
				id="harness"
				title="Harness targets"
				summary={
					<span className="text-dim">
						{allMode ? "all effective" : `${affinity.length} narrowed`}
					</span>
				}
			>
				<div className="conn-affinity" role="group" aria-label="Harness affinity">
					<p className="conn-hint">
						Empty selection targets every effective harness. Narrow to run only on
						specific harnesses.
					</p>
					<div className="conn-affinity-chips">
						{installedHarnesses.map((id) => {
							const active = targeted.has(id);
							return (
								<button
									key={id}
									type="button"
									className="conn-harness-chip"
									data-active={active || undefined}
									aria-pressed={active}
									title={`${harnessLabel(id)}${active ? " — targeted" : " — excluded"}`}
									onClick={() => toggleHarness(id)}
								>
									<HarnessGlyph id={id} size={15} decorative />
									<span>{harnessLabel(id)}</span>
								</button>
							);
						})}
						{installedHarnesses.length === 0 && (
							<span className="text-dim">no harnesses installed</span>
						)}
					</div>
				</div>
			</Section>

			<Section
				id="subagents"
				title="Sub-agents"
				defaultOpen
				summary={<span className="text-dim">preload</span>}
			>
				<SkillPreloadedBy skillName={skillName} />
			</Section>

			<Section
				id="source"
				title="Source"
				summary={
					<span className="text-dim text-mono">
						{ownerSource ? ownerSource.name : "local"}
					</span>
				}
			>
				{ownerSource ? (
					<div className="conn-source-body">
						<SourceChip source={ownerSource} compact onClick={() => navigate("/sources")} />
						<button
							type="button"
							className="conn-source-link"
							onClick={() => navigate("/sources")}
						>
							Manage source <Icon name="chevronRight" size={11} />
						</button>
					</div>
				) : (
					<span className="text-dim text-mono">Authored locally in this hub.</span>
				)}
			</Section>
		</div>
	);
}
