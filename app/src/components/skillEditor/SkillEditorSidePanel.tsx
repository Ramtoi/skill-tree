import { useRef, type ReactNode } from "react";
import { Field } from "@/components/Field";
import {
	DescriptionMeter,
	descriptionFieldClass,
} from "@/components/DescriptionMeter";
import { InlineName } from "@/components/InlineName";
import { ConnectionsPanel } from "@/components/ConnectionsPanel";
import { ExternalSourceBanner } from "@/components/ExternalSourceBanner";
import { DroppedUpstreamBanner } from "@/components/DroppedUpstreamBanner";
import { RuntimeSection } from "@/components/skillEditor/RuntimeSection";
import { ShipsWithSection } from "@/components/skillEditor/ShipsWithSection";
import { SkillRefsSection } from "@/components/skillEditor/SkillRefsSection";
import { skillBackTarget } from "@/lib/backTarget";
import { Select } from "@/components/Select";
import { SCOPE_REACH, scopeKey, scopeReachTooltip } from "@/components/Tag";
import { useAutoGrow } from "@/hooks/useAutoGrow";
import type { InvocationMode, InvocationSettled } from "@/lib/invocation";
import type { ClassificationContribution, ClassificationUpdateState } from "@/lib/skillClassification";
import type { DroppedAction } from "@/lib/droppedSkillActions";
import type { DroppedSkill, Registry, Skill, SourceView, SkillScope } from "@/types";

/** localStorage key of the `{ [sectionId]: boolean }` disclosure map shared by
 *  every collapsible block in this panel. */
export const SKILL_EDITOR_SECTIONS_KEY = "st:skill-editor:sections";

export interface SkillEditorSidePanelProps {
	skillName: string;
	skill: Skill;
	registry: Registry;
	ownerSource: SourceView;
	installedHarnesses: string[];
	readOnly: boolean;
	classificationReadOnly?: boolean;
	/** The project this editor is being viewed in the context of, when the
	 *  screen arrived via a project's loadout (`back.crumbs?.[0] ===
	 *  "project"`) — threaded straight through to `ShipsWithSection` so its
	 *  live `hub skill companions` read can report `provisioned` per item
	 *  (A5). Absent on a deep link or a palette jump. */
	project?: string | null;
	/** The archive/forget page lock — gates USED BY's writes. `readOnly` alone
	 *  never does: a source-managed (read-only) skill can still be equipped to
	 *  a bundle or project, the same as any other skill. */
	busy: boolean;

	/** The FILES navigator — rendered under the identity block. It brings its
	 *  own `SidePanelSection` because only it knows its count and unsaved
	 *  summary. Absent (F2) for an `mcp-server` whose folder holds nothing
	 *  beyond `SKILL.md` — the block is skipped entirely rather than shown
	 *  empty. */
	files?: ReactNode;

	/** The live editor buffer — threaded into `SkillRefsSection` so MENTIONS
	 *  counts move as the author types (`""` when there is nothing to read). */
	content: string;

	description: string;
	onDescriptionChange: (v: string) => void;
	scope: SkillScope;
	onScopeChange: (v: SkillScope) => void;
	version: string;
	onVersionChange: (v: string) => void;
	upstream: string;
	onUpstreamChange: (v: string) => void;
	affinity: string[];
	onAffinityChange: (next: string[]) => void;

	onInvocationPick: (mode: InvocationMode) => void;
	invocationBusy: false | InvocationMode;
	invocationMode?: InvocationMode | "conflicted";
	invocationSettled?: InvocationSettled;

	/** Present + non-null when `skill.source_missing` — replaces
	 *  `ExternalSourceBanner` with `DroppedUpstreamBanner` for the duration. */
	dropped?: DroppedSkill | null;
	onDroppedAction: (action: DroppedAction) => void;
	onOpenPossibleSuccessor: (registeredAs: string) => void;
	droppedBusy: boolean;
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

/** The scope menu: registry vocabulary as the label, its reach as the hint. */
const SCOPE_OPTIONS: { value: SkillScope; label: string; hint: string }[] = (
	["global", "portable", "project-specific"] as SkillScope[]
).map((value) => ({ value, label: value, hint: SCOPE_REACH[scopeKey(value)] }));

/** A read-only value as text, never as an input that refuses typing. */
function StaticValue({ value, empty = "—" }: { value: string; empty?: string }) {
	return (
		<span className="kv-static" data-empty={!value || undefined} title={value || undefined}>
			{value || empty}
		</span>
	);
}

/**
 * The skill editor's side panel, tiered by how often the reader needs each
 * thing. It never restates the screen header (kind, source chip, READ-ONLY,
 * the primary verb).
 *
 * - **Durable, on top**: the source strip (source-owned skills only), the
 *   IDENTITY block — the metered description in a well that grows with the
 *   text, and scope · version · upstream as key/value rows that edit in
 *   place (the name edits in the screen header, like a project's) — then
 *   FILES, then USED BY open (projects and bundles in one well).
 * - **Behind a head that states its value**: SUB-AGENTS (count) and RUNTIME
 *   (`Auto · all harnesses`: harness affinity chips + the trigger picker).
 * - **On scroll only**: the danger zone, which the shell renders under this.
 */
export function SkillEditorSidePanel({
	skillName,
	skill,
	registry,
	ownerSource,
	installedHarnesses,
	readOnly,
	classificationReadOnly,
	project,
	busy,
	files,
	content,
	description,
	onDescriptionChange,
	scope,
	onScopeChange,
	version,
	onVersionChange,
	upstream,
	onUpstreamChange,
	affinity,
	onAffinityChange,
	onInvocationPick,
	invocationBusy,
	invocationMode,
	invocationSettled,
	dropped,
	onDroppedAction,
	onOpenPossibleSuccessor,
	droppedBusy,
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
}: SkillEditorSidePanelProps) {
	// The description wraps in a well that grows with the text and scrolls
	// past the stylesheet's cap (`.side-identity textarea`).
	const descRef = useRef<HTMLTextAreaElement>(null);
	useAutoGrow(descRef, readOnly ? "" : description);
	return (
		<>
			{dropped ? (
				<DroppedUpstreamBanner
					dropped={dropped}
					onAction={onDroppedAction}
					onOpenPossibleSuccessor={onOpenPossibleSuccessor}
					busy={droppedBusy}
				/>
			) : (
				readOnly && (
					<ExternalSourceBanner
						skill={skill}
						source={ownerSource}
					/>
				)
			)}

			{/* Identity is durable: the description is the one field authors
			    iterate on with the body, and the three facts under it are text
			    until clicked. The name is the header's (`InlineName` there). */}
			<div className="side-panel-block side-identity" data-block="identity">
				<Field
					label="description"
					full
					className={readOnly ? "" : descriptionFieldClass(description)}
					hint={<DescriptionMeter value={description} muted={readOnly} />}
				>
					{readOnly ? (
						<div className="field-static" data-empty={!description || undefined}>
							{description || "No description."}
						</div>
					) : (
						<textarea
							ref={descRef}
							rows={4}
							value={description}
							onChange={(e) => onDescriptionChange(e.target.value)}
						/>
					)}
				</Field>
				<dl className="kv">
					<div className="kv-row">
						<dt>scope</dt>
						<dd>
							{readOnly ? (
								<StaticValue value={scope} />
							) : (
								<Select
									value={scope}
									label="Scope"
									title={scopeReachTooltip(scope)}
									options={SCOPE_OPTIONS}
									onChange={onScopeChange}
								/>
							)}
						</dd>
					</div>
					<div className="kv-row">
						<dt>version</dt>
						<dd>
							{readOnly ? (
								<StaticValue value={version} />
							) : (
								<InlineName
									value={version}
									label="Version"
									placeholder="none"
									commitOnBlur
									onSave={(next) => onVersionChange(next)}
								/>
							)}
						</dd>
					</div>
					<div className="kv-row">
						<dt>upstream</dt>
						<dd>
							{readOnly ? (
								<StaticValue value={upstream} />
							) : (
								<InlineName
									value={upstream}
									label="Upstream"
									placeholder="none"
									commitOnBlur
									onSave={(next) => onUpstreamChange(next)}
								/>
							)}
						</dd>
					</div>
				</dl>
			</div>

			{files}

			<ConnectionsPanel
				skillName={skillName}
				registry={registry}
				disabled={busy}
				storageKey={SKILL_EDITOR_SECTIONS_KEY}
			/>

			<SkillRefsSection
				host={{ self: skillName, back: skillBackTarget(skillName) }}
				content={content}
				registry={registry}
				storageKey={SKILL_EDITOR_SECTIONS_KEY}
			/>

			<RuntimeSection
				skillName={skillName}
				skill={skill}
				installedHarnesses={installedHarnesses}
				affinity={affinity}
				onAffinityChange={onAffinityChange}
				onInvocationPick={onInvocationPick}
				invocationBusy={invocationBusy}
				invocationMode={invocationMode}
				invocationSettled={invocationSettled}
				readOnly={readOnly}
				classificationReadOnly={classificationReadOnly}
				storageKey={SKILL_EDITOR_SECTIONS_KEY}
				classification={classification}
				classificationClasses={classificationClasses}
				classificationOutputs={classificationOutputs}
				graphPending={graphPending}
				graphError={graphError}
				graphCached={graphCached}
				onRetryGraph={onRetryGraph}
				onInspectClassification={onInspectClassification}
				inspection={inspection}
				onCloseInspection={onCloseInspection}
				onOpenContributor={onOpenContributor}
				onLoadMorePaths={onLoadMorePaths}
				classSuggestions={classSuggestions}
				outputSuggestions={outputSuggestions}
			/>


			{/* D5: absent entirely when `skill.ships_with` is empty — the section
			    itself carries that guard (see `ShipsWithSection`). `project` comes
			    from the screen's own referrer (`useBackTarget`/`back.crumbs`) —
			    present only when this editor was opened from a project's loadout,
			    absent on a deep link or a palette jump. */}
			<ShipsWithSection
				skillName={skillName}
				skill={skill}
				project={project}
				storageKey={SKILL_EDITOR_SECTIONS_KEY}
			/>
		</>
	);
}
