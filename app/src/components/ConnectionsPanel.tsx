import { useMemo } from "react";
import type { Registry } from "@/types";
import { EquipPicker } from "./EquipPicker";
import { Icon } from "./Icon";
import { SkillPreloadedBy, useSkillPreloaders } from "./subagents/SkillPreloadedBy";
import { SidePanelSection } from "./SidePanelSection";
import {
	buildSkillProjectTargets,
	buildSkillBundleTargets,
} from "@/hooks/useEquipTargets";
import { useSkillProjectEquip, useSkillBundleEquip } from "@/hooks/useEquip";
import { FILTER_THRESHOLD } from "@/lib/navRules";

interface ConnectionsPanelProps {
	skillName: string;
	registry: Registry;
	/** An archive/forget is in flight. NOT `readOnly`: a source-managed skill
	 *  is still equippable. */
	disabled?: boolean;
	/** localStorage key for the disclosure map these sections persist into. */
	storageKey?: string;
}

function plural(n: number, word: string) {
	return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * Who uses this skill. USED BY is one recessed well with two sub-groups —
 * BUNDLES and PROJECTS — in the FILES navigator's group grammar, because both
 * answer the same question ("what is this skill related to?") and used to
 * look like two unrelated widgets. BUNDLES comes first (cause above effect):
 * toggling a bundle flips the project rows right under it to `via <bundle>`,
 * which is the in-place answer to "applied already?". SUB-AGENTS follows as
 * its own disclosure: its rows navigate rather than toggle.
 */
export function ConnectionsPanel({
	skillName,
	registry,
	disabled = false,
	storageKey,
}: ConnectionsPanelProps) {
	// Same row anatomy as a bundle: a glyph, the name, then the checkbox. A
	// project's path is the Library's business — here it only pushed the
	// state off the line.
	const projectTargets = useMemo(
		() =>
			buildSkillProjectTargets(skillName, registry).map((t) => ({
				...t,
				glyph: <Icon name="project" size={14} className="equip-project-glyph" />,
				meta: undefined,
			})),
		[skillName, registry],
	);
	const bundleTargets = useMemo(
		() => buildSkillBundleTargets(skillName, registry),
		[skillName, registry],
	);
	const preloaders = useSkillPreloaders(skillName);
	const onProjectToggle = useSkillProjectEquip(skillName);
	const onBundleToggle = useSkillBundleEquip(skillName);
	// Gate the MUTATION, not just the pointer: `pointer-events: none` on an
	// ancestor stops a click but not Enter/Space on a control that was already
	// focused when the lock engaged. `EquipPicker`'s own `lockedReason` is the
	// gate — it refuses `isActionable()` before any state is touched, unlike a
	// hand-rolled `Promise.resolve()` wrapper, which used to flip the checkbox
	// optimistically, print `synced` for a write that never left the browser,
	// and never clear its own stuck override.
	// Passed to BOTH pickers below: the well shows the line twice, once above
	// each list — acceptable here, since Bundles and Projects are two separate
	// lists, each stating its own reason (EquipPicker never repeats it per row).
	const lockedReason = disabled ? "Archiving this skill…" : undefined;

	const projectsUsing = projectTargets.filter((t) => t.state !== "off").length;
	const bundlesOn = bundleTargets.filter((t) => t.state === "on").length;
	const summary =
		projectsUsing + bundlesOn === 0
			? "none"
			: `${plural(projectsUsing, "project")} · ${plural(bundlesOn, "bundle")}`;

	return (
		<div className="connections-panel" aria-label="Connections">
			<SidePanelSection
				id="usedby"
				title="Used by"
				summary={<span className="text-dim">{summary}</span>}
				defaultOpen
				storageKey={storageKey}
			>
				<div className="equip-stack">
					<div className="equip-group">
						<span className="equip-group-name">Bundles</span>
						<span className="equip-group-count">{bundleTargets.length}</span>
					</div>
					<EquipPicker
						variant="inline"
						filterThreshold={FILTER_THRESHOLD}
						subject={{ kind: "skill", name: skillName }}
						targets={bundleTargets}
						onToggle={onBundleToggle}
						listLabel="Bundles"
						searchPlaceholder="Add to bundle…"
						emptyLabel="No bundles defined."
						lockedReason={lockedReason}
					/>
					<div className="equip-group">
						<span className="equip-group-name">Projects</span>
						<span className="equip-group-count">{projectTargets.length}</span>
					</div>
					<EquipPicker
						variant="inline"
						filterThreshold={FILTER_THRESHOLD}
						subject={{ kind: "skill", name: skillName }}
						targets={projectTargets}
						onToggle={onProjectToggle}
						listLabel="Projects"
						searchPlaceholder="Filter projects…"
						emptyLabel="No projects registered."
						lockedReason={lockedReason}
					/>
				</div>
			</SidePanelSection>

			<SidePanelSection
				id="subagents"
				title="Sub-agents"
				count={preloaders.length}
				summary={
					<span className="text-dim">
						{preloaders.length > 0 ? "preload" : "none"}
					</span>
				}
				storageKey={storageKey}
			>
				<SkillPreloadedBy skillName={skillName} bare />
			</SidePanelSection>
		</div>
	);
}
