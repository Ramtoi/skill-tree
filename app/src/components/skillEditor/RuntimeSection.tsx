import { useState } from "react";
import { SidePanelSection } from "@/components/SidePanelSection";
import { TriggeringPicker } from "@/components/TriggeringPicker";
import { HarnessAffinityChips } from "@/components/HarnessAffinityChips";
import { harnessLabel } from "@/components/harness/harnessRegistry";
import {
	INVOCATION_EXTERNAL_REASON,
	INVOCATION_LABEL,
	INVOCATION_MCP_REASON,
	effectiveLibraryMode,
	type InvocationMode,
	type InvocationSettled,
} from "@/lib/invocation";
import type { Skill } from "@/types";
import type { ClassificationContribution, ClassificationUpdateState } from "@/lib/skillClassification";
import { SkillClassificationSection } from "@/components/skillEditor/SkillClassificationSection";
import { InvocationOutcomes } from "@/components/InvocationOutcomes";
import { useInvocationStatus } from "@/hooks/useInvocationStatus";

export interface RuntimeSectionProps {
	skillName?: string;
	skill: Skill;
	installedHarnesses: string[];
	/** Editor-managed affinity ([] = all effective harnesses). */
	affinity: string[];
	onAffinityChange: (next: string[]) => void;
	onInvocationPick: (mode: InvocationMode) => void;
	invocationBusy: false | InvocationMode;
	invocationMode?: InvocationMode | "conflicted";
	invocationSettled?: InvocationSettled;
	readOnly: boolean;
	classificationReadOnly?: boolean;
	storageKey: string;
	classification?: ClassificationUpdateState;
	classificationClasses?: ClassificationContribution[];
	classificationOutputs?: ClassificationContribution[];
	graphPending?: boolean;
	graphError?: unknown;
	onRetryGraph?: () => void;
	graphCached?: boolean;
	onInspectClassification?: (field: "classes" | "outputs", value: string) => void;
	inspection?: { field: "classes" | "outputs"; value: string; contributors: string[]; paths: string[][]; hasMore: boolean } | null;
	onCloseInspection?: () => void;
	onOpenContributor?: (name: string) => void;
	onLoadMorePaths?: () => void;
	classSuggestions?: string[];
	outputSuggestions?: string[];
}

/**
 * RUNTIME — how the skill runs: which harnesses receive it and who may
 * trigger it, one disclosure whose head states both (`Auto · all harnesses`).
 * The harness row is the permissions rows' icon-only affinity chips
 * (`HarnessAffinityChips`), so a narrowed harness reads the same here as on
 * a rule; the trigger row is the chip picker with the consequence of the
 * chosen mode.
 */
export function RuntimeSection({
	skillName,
	skill,
	installedHarnesses,
	affinity,
	onAffinityChange,
	onInvocationPick,
	invocationBusy,
	invocationMode,
	invocationSettled,
	readOnly,
	classificationReadOnly,
	storageKey,
	classification,
	classificationClasses,
	classificationOutputs,
	graphPending,
	graphError,
	onRetryGraph,
	graphCached,
	onInspectClassification,
	inspection,
	onCloseInspection,
	onOpenContributor,
	onLoadMorePaths,
	classSuggestions,
	outputSuggestions,
}: RuntimeSectionProps) {
	const [previewMode, setPreviewMode] = useState<InvocationMode | null>(null);
	const invocationStatus = useInvocationStatus(
		skillName ?? "",
		undefined,
		!!skillName && skill.type !== "mcp-server",
	);
	const allMode = affinity.length === 0;
	const targeted = new Set(allMode ? installedHarnesses : affinity);
	const currentMode = invocationMode ?? effectiveLibraryMode(skill.invocation);
	const conflicted = currentMode === "conflicted";
	const mode = conflicted
		? "conflicted"
		: INVOCATION_LABEL[currentMode as InvocationMode];
	const harnessSummary = allMode
		? "all harnesses"
		: `${affinity.length} of ${installedHarnesses.length}`;
	const externallyLocked =
		skill.managed === "external" || skill.managed === "starter" || skill.source_missing === true;
	const invocationLockReason =
		skill.type === "mcp-server"
			? INVOCATION_MCP_REASON
			: externallyLocked
				? INVOCATION_EXTERNAL_REASON
				: undefined;

	function toggleHarness(id: string) {
		if (readOnly) return;
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
		<SidePanelSection
			id="runtime"
			title="Runtime"
			storageKey={storageKey}
			summary={
				<span className="text-dim">
					{mode}
					{readOnly ? " · locked" : ""} · {harnessSummary}
				</span>
			}
		>
			<div className="invocation-heading">
				<h4 title={skill.type === "mcp-server" ? "Harnesses" : `Who can trigger /${skillName ?? "skill"}`}>
					{skill.type === "mcp-server" ? "Harnesses" : <>Who can trigger <span className="invocation-heading-skill">/{skillName ?? "skill"}</span></>}
				</h4>
				{installedHarnesses.length === 0 ? (
					<span className="text-dim">none installed</span>
				) : (
					<HarnessAffinityChips
						installedHarnesses={installedHarnesses}
						labels={Object.fromEntries(
							installedHarnesses.map((id) => [id, harnessLabel(id)]),
						)}
						capabilities={{}}
						supports={() => true}
						affinity={allMode ? null : affinity}
						collapsedWhenAll={false}
						onToggle={readOnly ? undefined : (id) => toggleHarness(id)}
					/>
				)}
			</div>
			<TriggeringPicker
				invocation={currentMode}
				onPick={onInvocationPick}
				onPreview={setPreviewMode}
				disabled={readOnly || skill.type === "mcp-server"}
				disabledReason={invocationLockReason}
				busy={invocationBusy}
				settled={invocationSettled}
			/>
			{skill.type !== "mcp-server" && (
				<InvocationOutcomes
					status={invocationStatus.data}
					mode={previewMode ?? currentMode}
					installedHarnesses={installedHarnesses}
					affinity={affinity}
					isLoading={invocationStatus.isLoading}
					hasError={invocationStatus.isError}
				/>
			)}
			<SkillClassificationSection
				key={skillName ?? "unknown-skill"}
				classification={skill.classification}
				classes={classificationClasses}
				outputs={classificationOutputs}
				readOnly={classificationReadOnly ?? false}
				storageKey={storageKey}
				update={classification?.update}
				graphPending={graphPending}
				graphError={graphError}
				graphCached={graphCached}
				onRetryGraph={onRetryGraph}
				onInspect={onInspectClassification}
				inspection={inspection}
				onCloseInspection={onCloseInspection}
				onOpenContributor={onOpenContributor}
				onLoadMorePaths={onLoadMorePaths}
				classSuggestions={classSuggestions}
				outputSuggestions={outputSuggestions}
				embedded
			/>
		</SidePanelSection>
	);
}
