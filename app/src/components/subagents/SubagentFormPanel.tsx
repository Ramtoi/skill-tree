import { useRef, useState } from "react";
import { Button } from "@/components/Button";
import { Icon } from "@/components/Icon";
import { Toggle } from "@/components/Toggle";
import { Field } from "@/components/Field";
import { StatePill } from "@/components/StatePill";
import { SearchInput } from "@/components/SearchInput";
import { SubagentModelPicker } from "./SubagentModelPicker";
import { ChipRadios, type ChipRadioOption } from "@/components/ChipRadios";
import { SidePanelSection } from "@/components/SidePanelSection";
import { HarnessGlyph } from "@/components/harness/HarnessGlyph";
import { harnessLabel } from "@/components/harness/harnessRegistry";
import { ProvisionPanel } from "@/components/subagents/ProvisionPanel";
import {
	CodexBehavior,
	DriftBanner,
	DriftLockHint,
	SANDBOX_LABELS,
} from "@/components/subagents/DriftResolution";
import { useAutoGrow } from "@/hooks/useAutoGrow";
import { FILTER_THRESHOLD } from "@/lib/navRules";
import type { SubagentDraft, ProvisionFlow } from "@/hooks/useSubagentDraft";
import type {
	useLinkSubagent,
	useResolveDrift,
	useUnlinkSubagent,
} from "@/hooks/useSubagents";
import { PathText } from "@/components/PathText";
import { StatusBadge } from "@/components/StatusBadge";
import {
	AGENT_COLORS,
	MODEL_ALIASES,
	READ_ONLY_TOOLS,
	type AttachableSkill,
	type ForeignSkillEntry,
	type SubagentDriftField,
	type SubagentHarness,
	type SubagentLink,
	type SubagentScope,
	type SubagentShow,
	type ToolAccessChoice,
} from "@/lib/subagents";

/** localStorage key of the `{ [sectionId]: boolean }` disclosure map shared by
 *  every collapsible block in this panel. */
export const SUBAGENT_EDITOR_SECTIONS_KEY = "st:subagent-editor:sections";

export interface SubagentFormPanelProps {
	draft: SubagentDraft;
	provision: ProvisionFlow;
	drift: SubagentDriftField[];
	link: SubagentLink | null;
	linkedOthers: string[];
	otherTargets: SubagentHarness[];
	scope: SubagentScope;
	harness: SubagentHarness;
	isCodex: boolean;
	show: SubagentShow | undefined;
	attachable: AttachableSkill[] | undefined;
	foreignEntries: ForeignSkillEntry[];
	advancedFormat: "yaml" | "toml";
	descLocked: boolean;
	skillsLocked: boolean;
	linkMut: ReturnType<typeof useLinkSubagent>;
	unlinkMut: ReturnType<typeof useUnlinkSubagent>;
	resolveMut: ReturnType<typeof useResolveDrift>;
	onLink: (copyFrom?: SubagentHarness) => void;
	onUnlink: () => void;
	onApplyDrift: (decisions: Record<string, SubagentHarness>) => void;
}

/** One short summary word per tool-access mode, for the Behavior section head
 *  — a direct read off `draft.toolChoice`, not a re-derivation through
 *  `buildSafe()`'s `tools_mode`/`tools` triple (m11). */
function toolAccessSummaryWord(
	choice: ToolAccessChoice,
	customTools: string[],
	disallowedTools: string[],
): string {
	if (choice === "all") return "All tools";
	if (choice === "denylist") {
		const n = disallowedTools.length;
		return `All except ${n} tool${n === 1 ? "" : "s"}`;
	}
	if (choice === "readonly") return "Read-only";
	const n = customTools.length;
	return `${n} tool${n === 1 ? "" : "s"}`;
}

/** One consequence line per tool-access mode — shown for the CHOSEN value
 *  below the chips, and as every option's hover `title`. */
function toolAccessConsequence(choice: ToolAccessChoice, customTools: string[]): string {
	if (choice === "all") return "Inherits every tool this harness offers.";
	if (choice === "readonly") return READ_ONLY_TOOLS.join(", ");
	return customTools.length ? customTools.join(", ") : "Pick individual tools below.";
}

const FOREIGN_SKILLS_NOTE =
	"Hand-authored or disabled entries are preserved on save but not editable here.";

const TOOL_ACCESS_OPTIONS: ChipRadioOption<ToolAccessChoice>[] = [
	{ value: "all", label: "All", title: "Inherits every tool this harness offers." },
	{ value: "readonly", label: "Read-only", title: READ_ONLY_TOOLS.join(", ") },
	{ value: "custom", label: "Custom", title: "Pick individual tools below." },
];

/** The sub-agent editor's side panel: the provisioning/drift plaques, the
 *  description well, then five tiered sections — Attached skills, Behavior,
 *  Linked twin, Appearance, Advanced. Never restates the header (name, scope,
 *  DISABLED — see `SubagentEditor`'s `ScreenHeader`). */
export function SubagentFormPanel({
	draft,
	provision,
	drift,
	link,
	linkedOthers,
	otherTargets,
	scope,
	harness,
	isCodex,
	show,
	attachable,
	foreignEntries,
	advancedFormat,
	descLocked,
	skillsLocked,
	linkMut,
	unlinkMut,
	resolveMut,
	onLink,
	onUnlink,
	onApplyDrift,
}: SubagentFormPanelProps) {
	const discoveryDisabled = draft.toolChoice === "all";
	const descRef = useRef<HTMLTextAreaElement>(null);
	useAutoGrow(descRef, draft.description);
	const [toolQuery, setToolQuery] = useState("");
	const [skillQuery, setSkillQuery] = useState("");
	const skillList = attachable ?? [];
	const filteredSkills = skillQuery.trim()
		? skillList.filter((sk) =>
				sk.name.toLowerCase().includes(skillQuery.trim().toLowerCase()),
			)
		: skillList;

	// m11: a plain read off `draft.toolChoice` — no `buildSafe()` allocation
	// (arrays included) just to render one summary word.
	const toolWord = toolAccessSummaryWord(
		draft.toolChoice,
		draft.customTools,
		draft.disallowedTools,
	);
	// m3: share `SANDBOX_LABELS` with the control it summarises — a bare
	// `.replace("-", " ")` mangles "danger-full-access" (only the first `-`).
	const behaviorSummary = isCodex
		? `${draft.codexModel.trim() || "inherit"} · ${SANDBOX_LABELS[draft.sandboxMode].toLowerCase()}`
		: `${draft.model === "custom" ? draft.customModel.trim() || "custom" : draft.model} · ${toolWord.toLowerCase()}`;

	const linkSummary = link?.linked
		? `Linked with ${linkedOthers.map(harnessLabel).join(", ") || "twin"}`
		: "not linked";

	const hasCustomKeys = !!draft.advancedYaml.trim();
	const advancedTitle =
		advancedFormat === "toml" ? "Advanced (raw TOML)" : "Advanced (raw YAML)";

	return (
		<div className="subagent-editor-form">
			{/* ── Attach-skill provisioning consequence prompt (D5) ── */}
			{provision.provision && (
				<ProvisionPanel
					items={provision.provision.items}
					harness={harness}
					busy={provision.provisionBusy}
					error={provision.provisionError}
					widen={provision.affinityWiden}
					onConfirm={provision.confirmProvision}
					onCancel={provision.cancelProvision}
				/>
			)}

			{/* ── Drift banner (linked twins diverged) ── */}
			{drift.length > 0 && (
				<DriftBanner
					drift={drift}
					harness={harness}
					pending={resolveMut.isPending}
					onApply={onApplyDrift}
				/>
			)}

			{/* ── Description — durable, on top; the name lives in the header ── */}
			<div className="side-panel-block side-identity" data-block="identity">
				<Field label="description" full error={draft.errorFor("description")?.message}>
					<textarea
						ref={descRef}
						value={draft.description}
						readOnly={descLocked}
						data-locked={descLocked || undefined}
						onChange={(e) => draft.markDirty(draft.setDescription)(e.target.value)}
					/>
				</Field>
				{descLocked && <DriftLockHint />}
			</div>

			{/* ── Attached skills ── */}
			<SidePanelSection
				id="skills"
				title="Attached skills"
				count={draft.skills.length}
				defaultOpen
				storageKey={SUBAGENT_EDITOR_SECTIONS_KEY}
			>
				<div className="equip-stack">
					{skillList.length > FILTER_THRESHOLD && (
						<SearchInput
							value={skillQuery}
							onChange={setSkillQuery}
							placeholder="Filter skills…"
						/>
					)}
					<div className="subagent-skill-picker">
						{skillList.length === 0 ? (
							<span className="text-dim text-mono equip-picker-empty">
								no resolvable skills in scope
							</span>
						) : filteredSkills.length === 0 ? (
							<span className="text-dim text-mono equip-picker-empty">
								no matching skills
							</span>
						) : (
							filteredSkills.map((sk) => {
								const checked = draft.skills.includes(sk.name);
								const blocked = !sk.invocable; // disable-model-invocation
								return (
									<label
										key={sk.name}
										className="subagent-skill-row"
										data-blocked={blocked || undefined}
										data-unresolved={!sk.resolved || undefined}
										title={sk.reason || sk.description}
									>
										<Icon name="skill" size={13} className="subagent-skill-glyph" />
										<span className="text-mono subagent-skill-name">{sk.name}</span>
										<span className="subagent-skill-meta text-dim text-mono">
											{blocked ? (
												<span className="subagent-skill-meta-item">
													<StatusBadge
														channel="error"
														shape="dot"
														ariaLabel="not invocable"
													/>
													not invocable
												</span>
											) : (
												!sk.resolved && (
													<span className="subagent-skill-meta-item">
														<StatusBadge
															channel="warn"
															shape="dot"
															ariaLabel="unresolved"
														/>
														unresolved
													</span>
												)
											)}
											{sk.project_only && (
												<span className="subagent-skill-meta-item">project-only</span>
											)}
										</span>
										<Toggle
											size="sm"
											ariaLabel={`Attach ${sk.name}`}
											checked={checked}
											disabled={skillsLocked || (blocked && !checked)}
											onChange={(c) =>
												draft.markDirty(draft.setSkills)(
													c
														? [...draft.skills, sk.name]
														: draft.skills.filter((x) => x !== sk.name),
												)
											}
										/>
									</label>
								);
							})
						)}
					</div>

					{/* Codex `skills.config` entries hub does not manage (foreign path or
					    enabled=false) — preserved verbatim, a second read-only group in
					    the same well. */}
					{isCodex && foreignEntries.length > 0 && (
						<>
							<div
								className="equip-group"
								title={FOREIGN_SKILLS_NOTE}
							>
								<span className="equip-group-name">Other skill entries</span>
								<span className="equip-group-count">{foreignEntries.length}</span>
							</div>
							<div className="subagent-foreign-skills">
								{foreignEntries.map((f) => (
									<div
										key={f.path}
										className="subagent-skill-row"
										data-blocked
										title={FOREIGN_SKILLS_NOTE}
									>
										<Icon name="skill" size={13} className="subagent-skill-glyph" />
										<PathText path={f.path} className="subagent-skill-path" />
										<span className="subagent-skill-meta text-dim text-mono">
											{f.enabled ? "enabled" : "disabled"}
										</span>
									</div>
								))}
							</div>
						</>
					)}
				</div>
				{/* m7: a fact about the GROUP (why these rows have no checkbox), not
				    hover-only — a `title` on a non-focusable row reaches nobody on
				    keyboard or touch. */}
				{isCodex && foreignEntries.length > 0 && (
					<p className="subagent-note">{FOREIGN_SKILLS_NOTE}</p>
				)}
				{skillsLocked && <DriftLockHint />}
				{draft.errorFor("skills") && (
					<span className="field-error" role="alert">
						{draft.errorFor("skills")?.message}
					</span>
				)}
			</SidePanelSection>

			{/* ── Behavior ── */}
			<SidePanelSection
				id="behavior"
				title="Behavior"
				summary={behaviorSummary}
				defaultOpen
				storageKey={SUBAGENT_EDITOR_SECTIONS_KEY}
			>
				{isCodex ? (
					<CodexBehavior
						model={draft.codexModel}
						onModel={draft.markDirty(draft.setCodexModel)}
						reasoningEffort={draft.reasoningEffort}
						onReasoningEffort={draft.markDirty(draft.setReasoningEffort)}
						sandboxMode={draft.sandboxMode}
						onSandboxMode={draft.markDirty(draft.setSandboxMode)}
						errorFor={draft.errorFor}
					/>
				) : (
					<>
						<dl className="kv">
							<div className="kv-row">
								<dt>model</dt>
								<dd>
									<SubagentModelPicker
										harness={harness}
										value={draft.model === "custom" ? draft.customModel : draft.model === "inherit" ? "" : draft.model}
										onChange={(value) => {
											const alias = value === "" ? "inherit" : value;
											if (MODEL_ALIASES.some((model) => model === alias)) {
												draft.markDirty(draft.setModel)(alias);
											} else {
												draft.markDirty(draft.setModel)("custom");
												draft.setCustomModel(value);
											}
										}}
									/>
								</dd>
							</div>
						</dl>
						{draft.errorFor("model") && (
							<span className="field-error" role="alert">
								{draft.errorFor("model")?.message}
							</span>
						)}

						<div className="subagent-field-label">Tool access</div>
						<ChipRadios
							name="tool-access"
							label="Tool access"
							className="subagent-chip-wrap"
							value={draft.toolChoice === "denylist" ? null : draft.toolChoice}
							options={TOOL_ACCESS_OPTIONS}
							onChange={draft.markDirty(draft.setToolChoice)}
						/>
						{draft.toolChoice !== "denylist" && (
							<p className="subagent-chip-consequence">
								{toolAccessConsequence(draft.toolChoice, draft.customTools)}
							</p>
						)}
						{draft.toolChoice === "denylist" && (
							<div
								className="subagent-note"
								title="Preserved on save; pick another mode above to discard it."
							>
								<Icon name="warning" size={11} /> Custom (deny-list) —{" "}
								{draft.disallowedTools.join(", ") || "none"}
							</div>
						)}

						{draft.toolChoice === "custom" && (
							<div className="equip-stack subagent-tool-well">
								{draft.toolOptions.length > FILTER_THRESHOLD && (
									<SearchInput
										value={toolQuery}
										onChange={setToolQuery}
										placeholder="Filter tools…"
									/>
								)}
								<div className="subagent-tool-grid">
									{draft.toolOptions
										.filter(
											(t) =>
												!toolQuery.trim() ||
												t.toLowerCase().includes(toolQuery.trim().toLowerCase()),
										)
										.map((t) => (
											<Toggle
												key={t}
												className="subagent-tool-check"
												size="sm"
												checked={draft.customTools.includes(t)}
												label={<span className="text-mono">{t}</span>}
												onChange={(checked) =>
													draft.markDirty(draft.setCustomTools)(
														checked
															? [...draft.customTools, t]
															: draft.customTools.filter((x) => x !== t),
													)
												}
											/>
										))}
								</div>
							</div>
						)}

						<Toggle
							className="subagent-toggle"
							variant="switch"
							checked={discoveryDisabled ? true : draft.allowDiscovery}
							disabled={discoveryDisabled}
							ariaLabel="Can use other skills on demand"
							onChange={(checked) => draft.markDirty(draft.setAllowDiscovery)(checked)}
							label={
								<span className="subagent-toggle-copy">
									<span className="toggle-title">
										Can use other skills on demand
									</span>
									<span className="toggle-sub">
										{discoveryDisabled
											? "Always on while all tools are inherited."
											: "Adds the Skill tool so the agent can invoke any skill, not just the preloaded ones."}
									</span>
								</span>
							}
						/>
					</>
				)}
			</SidePanelSection>

			{/* ── Linked twin (D3, user scope only) ── */}
			{scope === "user" && (link || otherTargets.length > 0) && show?.exists && (
				<SidePanelSection
					id="link"
					title="Linked twin"
					summary={linkSummary}
					defaultOpen={false}
					storageKey={SUBAGENT_EDITOR_SECTIONS_KEY}
				>
					{link?.linked ? (
						<div className="subagent-link-panel">
							<div className="subagent-link-status">
								<span className="subagent-link-chip" data-tone="linked">
									<Icon name="link" size={11} />
									<span>Linked with</span>
									{linkedOthers.map((h) => (
										<span key={h} className="subagent-link-harness">
											<HarnessGlyph id={h} size={12} decorative />
											{harnessLabel(h)}
										</span>
									))}
								</span>
								{link.twin_lost && (
									<span
										className="subagent-link-chip"
										data-tone="warn"
										title="A linked twin file is missing — renamed or deleted outside Skill Tree."
									>
										<Icon name="warning" size={11} /> twin file missing
									</span>
								)}
							</div>
							<Button
								size="sm"
								icon="link"
								onClick={onUnlink}
								disabled={unlinkMut.isPending}
								title="Stops co-writing the shared core; both files stay on disk."
							>
								Unlink
							</Button>
						</div>
					) : link?.suggested ? (
						<div className="subagent-link-panel">
							<Button
								size="sm"
								icon="link"
								onClick={() => onLink()}
								disabled={linkMut.isPending}
								title="A same-named agent already exists there. Linking co-writes the shared core (name, description, prompt, skills) to both."
							>
								Link with {linkedOthers.map(harnessLabel).join(", ")}
							</Button>
						</div>
					) : (
						<div className="subagent-link-panel">
							{otherTargets.map((t) => (
								<Button
									key={t}
									size="sm"
									icon="link"
									onClick={() => onLink(harness)}
									disabled={linkMut.isPending}
									title="Creates a twin from the shared core and links them. The model resets to inherit in the new file (namespaces differ)."
								>
									Copy to {harnessLabel(t)}…
								</Button>
							))}
						</div>
					)}
				</SidePanelSection>
			)}

			{/* ── Appearance (Claude-only — Codex has no agent color) ── */}
			{!isCodex && (
				<SidePanelSection
					id="appearance"
					title="Appearance"
					summary={
						<span
							className="subagent-swatch-dot"
							style={draft.color ? { ["--swatch" as string]: draft.color } : undefined}
							data-empty={!draft.color || undefined}
						/>
					}
					defaultOpen={false}
					storageKey={SUBAGENT_EDITOR_SECTIONS_KEY}
				>
					<div className="subagent-swatches">
						<button
							type="button"
							className="subagent-swatch"
							data-active={draft.color === "" || undefined}
							title="No color"
							onClick={() => draft.markDirty(draft.setColor)("")}
						>
							<Icon name="x" size={11} />
						</button>
						{AGENT_COLORS.map((c) => (
							<button
								key={c}
								type="button"
								className="subagent-swatch"
								data-active={draft.color === c || undefined}
								style={{ ["--swatch" as string]: c }}
								title={c}
								onClick={() => draft.markDirty(draft.setColor)(c)}
							/>
						))}
					</div>
					{draft.errorFor("color") && (
						<span className="field-error" role="alert">
							{draft.errorFor("color")?.message}
						</span>
					)}
				</SidePanelSection>
			)}

			{/* ── Advanced ── */}
			<SidePanelSection
				id="advanced"
				title={advancedTitle}
				summary={
					<>
						{hasCustomKeys ? "custom keys" : "none"}
						{draft.advancedDirty && (
							<StatePill state="unsaved" icon="edit">
								UNSAVED
							</StatePill>
						)}
					</>
				}
				defaultOpen={false}
				forceOpen={draft.advancedDirty}
				storageKey={SUBAGENT_EDITOR_SECTIONS_KEY}
			>
				<textarea
					className="subagent-advanced-yaml text-mono"
					rows={6}
					placeholder={advancedFormat === "toml" ? "# custom keys, TOML" : "# custom keys, YAML"}
					title={
						advancedFormat === "toml"
							? "Risky fields ([mcp_servers.*] and unknown keys) live here. Must parse as TOML."
							: "Risky fields (hooks, mcpServers, permissionMode) live here. Must parse as a YAML mapping."
					}
					value={draft.advancedYaml}
					onChange={(e) => draft.markDirty(draft.setAdvancedYaml)(e.target.value)}
					data-invalid={!!draft.errorFor("advanced_yaml") || undefined}
				/>
				{draft.errorFor("advanced_yaml") && (
					<span className="field-error" role="alert">
						{draft.errorFor("advanced_yaml")?.message}
					</span>
				)}
			</SidePanelSection>
		</div>
	);
}
