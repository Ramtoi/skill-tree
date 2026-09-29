import { ChipRadios } from "@/components/ChipRadios";
import { Field, MetaGrid } from "@/components/Field";
import { Select } from "@/components/Select";
import { Tag } from "@/components/Tag";
import { ToolPicker } from "@/components/ToolPicker";
import { CANONICAL_EVENTS, EVENT_HINTS, type ToolGroup } from "@/lib/hookCatalog";
import type { AppliesMode } from "@/lib/hookForm";

const EVENT_OPTIONS = CANONICAL_EVENTS.map((ev) => ({
	value: ev,
	label: ev,
	hint: EVENT_HINTS[ev],
}));

const APPLIES_MODES: { id: AppliesMode; label: string }[] = [
	{ id: "all", label: "All tools" },
	{ id: "tools", label: "Specific tools" },
	{ id: "matcher", label: "Raw matcher" },
];

export interface HookDefinitionBlockProps {
	isNew: boolean;
	coreReadOnly: boolean;
	name: string;
	onNameChange: (v: string) => void;
	description: string;
	onDescriptionChange: (v: string) => void;
	event: string;
	onEventChange: (v: string) => void;
}

/**
 * The main-column Definition block (side-panels wave 4): name (create only) /
 * description / event. Extracted out of `HookEditor.tsx` alongside
 * `HookSidePanel` and `HookAppliesToBlock` to keep the screen under the
 * 1000-line component-size cap. Built-ins render every field as a read-only
 * SUMMARY row (D5) — no disabled inputs.
 */
export function HookDefinitionBlock({
	isNew,
	coreReadOnly,
	name,
	onNameChange,
	description,
	onDescriptionChange,
	event,
	onEventChange,
}: HookDefinitionBlockProps) {
	return (
		<div className="side-panel-block">
			<h4>Definition</h4>
			{coreReadOnly ? (
				<MetaGrid>
					<Field label="description" full>
						<div className="hook-ro-value">{description || "—"}</div>
					</Field>
					<Field label="event" full>
						<div className="hook-ro-value text-mono" aria-label="event">
							{event}
						</div>
					</Field>
				</MetaGrid>
			) : (
				<MetaGrid>
					{isNew && (
						<Field label="name" full hint="lowercase, numbers, hyphens">
							<input
								value={name}
								onChange={(e) => onNameChange(e.target.value)}
								placeholder="lint-after-edit"
								aria-label="hook name"
							/>
						</Field>
					)}
					<Field label="description" full>
						<input
							value={description}
							onChange={(e) => onDescriptionChange(e.target.value)}
							placeholder="Lint every file the agent edits"
							aria-label="description"
						/>
					</Field>
					<Field
						label="event"
						full
						hint="When this hook fires. The Harnesses panel shows which harnesses support it."
					>
						<Select
							value={event}
							label="event"
							options={EVENT_OPTIONS}
							onChange={onEventChange}
						/>
					</Field>
				</MetaGrid>
			)}
		</div>
	);
}

export interface HookAppliesToBlockProps {
	coreReadOnly: boolean;
	appliesMode: AppliesMode;
	onAppliesModeChange: (v: AppliesMode) => void;
	tools: string[];
	onToolsChange: (v: string[]) => void;
	matcher: string;
	onMatcherChange: (v: string) => void;
	toolGroups: ToolGroup[];
	legacyBoth: boolean;
}

/**
 * The main-column Applies-to block: all tools / specific tools / raw matcher,
 * a `ChipRadios` segmented mode (D2) DERIVED from the data rather than a wall
 * of checkboxes plus a rogue regex box.
 */
export function HookAppliesToBlock({
	coreReadOnly,
	appliesMode,
	onAppliesModeChange,
	tools,
	onToolsChange,
	matcher,
	onMatcherChange,
	toolGroups,
	legacyBoth,
}: HookAppliesToBlockProps) {
	return (
		<div className="side-panel-block">
			<h4>Applies to</h4>
			{coreReadOnly ? (
				<div className="hook-ro-applies">
					{matcher ? (
						<span className="text-mono">/{matcher}/</span>
					) : tools.length === 0 ? (
						<span className="text-dim">all tools</span>
					) : (
						tools.map((t) => (
							<Tag key={t} size="sm" className="hook-tool">
								<span className="text-mono">{t}</span>
							</Tag>
						))
					)}
				</div>
			) : (
				<>
					<div className="hook-applies-modes">
						<ChipRadios
							name="hook-applies-mode"
							label="Applies to"
							value={appliesMode}
							options={APPLIES_MODES.map((m) => ({ value: m.id, label: m.label }))}
							onChange={onAppliesModeChange}
						/>
					</div>

					{appliesMode === "all" && (
						<p className="conn-hint">
							Fires for every tool the event covers. Narrow it only when the hook
							is expensive or tool-specific.
						</p>
					)}

					{appliesMode === "tools" && (
						<ToolPicker value={tools} onChange={onToolsChange} groups={toolGroups} />
					)}

					{appliesMode === "matcher" && (
						<>
							<Field
								label="raw matcher"
								full
								hint="A regex over tool names — the escape hatch for anything the picker can't express."
							>
								<input
									className="text-mono"
									value={matcher}
									onChange={(e) => onMatcherChange(e.target.value)}
									placeholder="Notebook.*|mcp__.*"
									aria-label="raw matcher"
								/>
							</Field>
							{legacyBoth && (
								<p className="conn-hint">
									This hook also carries a tool list ({tools.join(", ")}), which is
									ignored while a matcher is set. Saving in this mode clears it.
								</p>
							)}
						</>
					)}
				</>
			)}
		</div>
	);
}
