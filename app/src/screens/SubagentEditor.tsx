import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/Button";
import { LoadingButton } from "@/components/loading";
import { Icon } from "@/components/Icon";
import { Toggle } from "@/components/Toggle";
import { ScreenHeader } from "@/components/ScreenHeader";
import { StatePill } from "@/components/StatePill";
import { Field, MetaGrid } from "@/components/Field";
import { EmptyState } from "@/components/EmptyState";
import { type CodeAreaHandle } from "@/components/CodeArea";
import {
	DocumentEditorShell,
	type DocMode,
} from "@/components/DocumentEditorShell";
import { useToast } from "@/components/Toast";
import {
	useAttachableSkills,
	useDeleteSubagent,
	useLinkSubagent,
	useProvisionSkill,
	useResolveDrift,
	useSaveSubagent,
	useSetSubagentDisabled,
	useSubagent,
	useUnlinkSubagent,
} from "@/hooks/useSubagents";
import { useHarnesses } from "@/hooks/useHarnesses";
import {
	AGENT_COLORS,
	CODEX_REASONING_EFFORTS,
	CODEX_SANDBOX_MODES,
	KNOWN_TOOLS,
	MODEL_ALIASES,
	READ_ONLY_TOOLS,
	toolAccessChoice,
	type AgentColor,
	type CodexSandboxMode,
	type NeedsProvisioning,
	type SubagentDriftField,
	type SubagentHarness,
	type SubagentSafe,
	type SubagentSavePayload,
	type SubagentSaveResult,
	type SubagentScope,
	type SubagentWarning,
	type ToolAccessChoice,
} from "@/lib/subagents";
import { HarnessGlyph } from "@/components/harness/HarnessGlyph";
import { harnessLabel } from "@/components/harness/harnessRegistry";
import { ProvisionPanel } from "@/components/subagents/ProvisionPanel";

const CLAUDE_SLUG_RE = /^[a-z0-9-]+$/;
const CODEX_SLUG_RE = /^[a-z0-9_-]+$/;

export interface SubagentEditorProps {
	/** Harness whose native file this edits (default claude-code). */
	harness?: SubagentHarness;
	scope: SubagentScope;
	project: string | null;
	/** The agent name to load; undefined never happens (new agents are created
	 *  via the sheet which then routes here). */
	name: string;
	onBack: () => void;
	/** Called after a rename so the parent can re-point its selection. */
	onRenamed?: (newName: string) => void;
	/** Called after a delete so the parent can clear its selection. */
	onDeleted?: () => void;
}

export function SubagentEditor({
	harness = "claude-code",
	scope,
	project,
	name,
	onBack,
	onRenamed,
	onDeleted,
}: SubagentEditorProps) {
	const toast = useToast();
	const isCodex = harness === "codex";
	const { data: show, isLoading } = useSubagent(scope, project, name, harness);
	const { data: attachable } = useAttachableSkills(scope, project, true, harness);
	const saveMut = useSaveSubagent();
	const deleteMut = useDeleteSubagent(scope, project, harness);
	const disableMut = useSetSubagentDisabled(scope, project, harness);
	const linkMut = useLinkSubagent(scope, project);
	const unlinkMut = useUnlinkSubagent(scope, project);
	const resolveMut = useResolveDrift(scope, project);
	const provisionMut = useProvisionSkill(scope, project, harness);
	const harnessesList = useHarnesses();

	// ─── Linked-twin state (D3, user scope only) ────────────────────────────────
	const link = show?.link ?? null;
	const drift = useMemo<SubagentDriftField[]>(() => show?.drift ?? [], [show]);
	const driftedFields = useMemo(
		() => new Set(drift.map((d) => d.field)),
		[drift],
	);
	const descLocked = driftedFields.has("description");
	const skillsLocked = driftedFields.has("skills");
	const instructionsLocked = driftedFields.has("instructions");
	// Other agent-capable, installed harnesses — the copy/link targets.
	const otherTargets = harnessesList
		.filter((h) => h.id !== harness && h.agents?.supported && h.installed)
		.map((h) => h.id as SubagentHarness);
	const linkedOthers = (link?.harnesses ?? []).filter((h) => h !== harness);
	const [deleteBoth, setDeleteBoth] = useState(false);

	// ─── Form state ─────────────────────────────────────────────────────────────
	const [agentName, setAgentName] = useState("");
	const [description, setDescription] = useState("");
	const [model, setModel] = useState("inherit");
	const [customModel, setCustomModel] = useState("");
	const [toolChoice, setToolChoice] = useState<ToolAccessChoice>("all");
	const [customTools, setCustomTools] = useState<string[]>([]);
	const [disallowedTools, setDisallowedTools] = useState<string[]>([]);
	const [allowDiscovery, setAllowDiscovery] = useState(true);
	const [skills, setSkills] = useState<string[]>([]);
	const [color, setColor] = useState<AgentColor>("");
	// ── Codex-only form state ──
	const [codexModel, setCodexModel] = useState("");
	const [sandboxMode, setSandboxMode] = useState<CodexSandboxMode>("");
	const [reasoningEffort, setReasoningEffort] = useState("");
	// Preserved on round-trip, not surfaced as an editable control.
	const [nicknameCandidates, setNicknameCandidates] = useState<string[]>([]);
	const [advancedYaml, setAdvancedYaml] = useState("");
	const [advancedOpen, setAdvancedOpen] = useState(false);
	const [body, setBody] = useState("");
	const [mode, setMode] = useState<DocMode>("edit");
	const [dirty, setDirty] = useState(false);
	const [confirmingDelete, setConfirmingDelete] = useState(false);
	const [errors, setErrors] = useState<SubagentWarning[]>([]);
	// ─── Attach-skill provisioning (D5) ─────────────────────────────────────────
	// When a save is blocked purely by unresolved, newly-attached registry skills,
	// each blocking error carries `needs_provisioning`. We surface a consequence
	// prompt; on confirm we provision each skill then re-save the same payload.
	const [provision, setProvision] = useState<{
		items: NeedsProvisioning[];
		payload: SubagentSavePayload;
	} | null>(null);
	const [provisionBusy, setProvisionBusy] = useState(false);
	const [provisionError, setProvisionError] = useState<string | null>(null);
	const [affinityWiden, setAffinityWiden] = useState<{
		skill: string;
		affinity: string[];
	} | null>(null);

	const savedBodyRef = useRef("");
	const editorRef = useRef<CodeAreaHandle>(null);
	const disabled = show?.disabled ?? false;

	// Hydrate from `subagent_show` once it loads.
	useEffect(() => {
		if (!show || !show.exists) return;
		const s = show.safe;
		setAgentName(s.name || name);
		setDescription(s.description ?? "");
		if (isCodex) {
			// Codex model is a free-text id (gpt-* namespace); no alias select.
			setCodexModel(s.model ?? "");
			setSandboxMode((s.sandbox_mode as CodexSandboxMode) ?? "");
			setReasoningEffort(s.model_reasoning_effort ?? "");
			setNicknameCandidates(s.nickname_candidates ?? []);
		} else {
			const m = s.model || "inherit";
			if (m && !MODEL_ALIASES.includes(m as never)) {
				setModel("custom");
				setCustomModel(m);
			} else {
				setModel(m);
				setCustomModel("");
			}
			const choice = toolAccessChoice(s);
			setToolChoice(choice);
			// Custom-mode tool checkboxes: the allowlist minus Skill (discovery is its
			// own toggle). Merge in unknown tokens so a disk value is never dropped.
			setCustomTools(s.tools.filter((t) => t !== "Skill"));
			setDisallowedTools(s.disallowed_tools);
			setAllowDiscovery(s.allow_skill_discovery);
			setColor(s.color);
		}
		setSkills(s.skills);
		setAdvancedYaml(show.advanced_yaml ?? "");
		setAdvancedOpen(!!(show.advanced_yaml ?? "").trim());
		setBody(show.body ?? "");
		savedBodyRef.current = show.body ?? "";
		setDirty(false);
		setErrors([]);
	}, [show, name, isCodex]);

	const markDirty = useCallback(
		<T,>(setter: (v: T) => void) =>
			(v: T) => {
				setter(v);
				setDirty(true);
			},
		[],
	);

	const nameValid = (isCodex ? CODEX_SLUG_RE : CLAUDE_SLUG_RE).test(
		agentName.trim(),
	);

	// All non-Skill tools the checkbox grid should show: the known surface plus
	// any unknown tokens loaded from disk (so they round-trip).
	const toolOptions = useMemo(() => {
		const set = new Set<string>(KNOWN_TOOLS.filter((t) => t !== "Skill"));
		for (const t of customTools) set.add(t);
		return Array.from(set);
	}, [customTools]);

	// Assemble the `safe` block from the guided controls (D2 mapping).
	const buildSafe = useCallback((): SubagentSafe => {
		if (isCodex) {
			// Codex has no per-tool overlay; capability is scoped by sandbox_mode.
			// The Claude-only fields carry inert defaults (the backend ignores them).
			return {
				name: agentName.trim(),
				description,
				model: codexModel.trim(),
				tools_mode: "all",
				tools: [],
				disallowed_tools: [],
				allow_skill_discovery: true,
				skills,
				color: "",
				sandbox_mode: sandboxMode,
				model_reasoning_effort: reasoningEffort,
				nickname_candidates: nicknameCandidates,
			};
		}
		const effectiveModel = model === "custom" ? customModel.trim() : model;
		let tools_mode: SubagentSafe["tools_mode"] = "all";
		let tools: string[] = [];
		let disallowed: string[] = [];
		if (toolChoice === "all") {
			tools_mode = "all";
		} else if (toolChoice === "readonly") {
			tools_mode = "allowlist";
			tools = [...READ_ONLY_TOOLS];
			if (allowDiscovery) tools.push("Skill");
		} else if (toolChoice === "custom") {
			tools_mode = "allowlist";
			tools = [...customTools.filter((t) => t !== "Skill")];
			if (allowDiscovery) tools.push("Skill");
		} else {
			// denylist — round-trip without re-mapping.
			tools_mode = "denylist";
			disallowed = [...disallowedTools];
		}
		return {
			name: agentName.trim(),
			description,
			model: effectiveModel === "inherit" ? "" : effectiveModel,
			tools_mode,
			tools,
			disallowed_tools: disallowed,
			// In "all" mode discovery is inherently on; the toggle is shown on+disabled.
			allow_skill_discovery: tools_mode === "all" ? true : allowDiscovery,
			skills,
			color,
		};
	}, [
		isCodex,
		agentName,
		description,
		model,
		customModel,
		codexModel,
		sandboxMode,
		reasoningEffort,
		nicknameCandidates,
		toolChoice,
		customTools,
		disallowedTools,
		allowDiscovery,
		skills,
		color,
	]);

	// The one place the save payload is assembled — shared by the direct save and
	// the D5 provision → re-save flow (so both write byte-identical requests).
	const buildPayload = useCallback(
		(): SubagentSavePayload => ({
			...(isCodex ? { harness } : {}),
			scope,
			project,
			original_name: name,
			safe: buildSafe(),
			advanced_yaml: advancedYaml,
			body,
		}),
		[isCodex, harness, scope, project, name, buildSafe, advancedYaml, body],
	);

	// Fold a save result into UI state. On a block whose ONLY errors carry
	// `needs_provisioning` we raise the consequence prompt instead of a bare
	// "fix errors" toast (field errors still render inline). Returns save success.
	const handleSaveResult = useCallback(
		(res: SubagentSaveResult, payload: SubagentSavePayload): boolean => {
			if (!res.ok) {
				const errs = res.errors ?? [];
				setErrors(errs);
				const items: NeedsProvisioning[] = [];
				const seen = new Set<string>();
				for (const e of errs) {
					const np = e.needs_provisioning;
					if (np && !seen.has(np.skill)) {
						seen.add(np.skill);
						items.push(np);
					}
				}
				if (items.length) {
					setProvisionError(null);
					setAffinityWiden(null);
					setProvision({ items, payload });
				} else {
					setProvision(null);
					toast.error("Save blocked", "Fix the validation errors and retry.");
				}
				return false;
			}
			savedBodyRef.current = payload.body;
			setDirty(false);
			setProvision(null);
			setProvisionError(null);
			setAffinityWiden(null);
			const twinNote = res.cowrote_twin
				? `Also updated ${harnessLabel(res.twin_harness ?? "")}.`
				: undefined;
			if (res.warnings?.length) {
				toast.push({
					kind: "info",
					title: `Saved ${res.name}`,
					body: `${res.warnings.length} warning${res.warnings.length === 1 ? "" : "s"} — review the form.${twinNote ? ` ${twinNote}` : ""}`,
				});
				setErrors(res.warnings);
			} else {
				toast.success(`Saved ${res.name}`, twinNote);
			}
			if (res.renamed_from && res.name && res.name !== name) {
				onRenamed?.(res.name);
			}
			return true;
		},
		[toast, name, onRenamed],
	);

	const save = useCallback(async () => {
		if (saveMut.isPending) return;
		setErrors([]);
		if (!nameValid) {
			setErrors([
				{
					field: "name",
					level: "error",
					message: isCodex
						? "Name must use lowercase letters, numbers, hyphens, and underscores only."
						: "Name must use lowercase letters, numbers, and hyphens only.",
				},
			]);
			return;
		}
		const payload = buildPayload();
		try {
			const res = await saveMut.mutateAsync(payload);
			handleSaveResult(res, payload);
		} catch (e) {
			toast.error("Save failed", String(e));
		}
	}, [saveMut, nameValid, isCodex, buildPayload, handleSaveResult, toast]);

	// Confirm the consequence prompt: provision each skill (agent's harness;
	// --global vs --project per scope_fix), then re-save the captured payload.
	// A refusal stops the flow verbatim: an affinity refusal (widen_available)
	// swaps in a distinct "Widen affinity" confirm; any other refusal (e.g. a
	// remote-quarantined skill) is a dead-stop explanation with no retry.
	const confirmProvision = useCallback(
		async (widenSkill?: string) => {
			if (!provision || provisionBusy) return;
			setProvisionBusy(true);
			setProvisionError(null);
			try {
				for (const item of provision.items) {
					const isGlobal = item.scope_fix === "make-global";
					const res = await provisionMut.mutateAsync({
						skill: item.skill,
						global: isGlobal,
						project: isGlobal ? null : project,
						harnessId: harness,
						widenAffinity: widenSkill === item.skill,
					});
					if (!res.ok) {
						if (res.widen_available) {
							setAffinityWiden({
								skill: item.skill,
								affinity: res.affinity ?? [],
							});
						} else {
							setProvisionError(res.error ?? "Provisioning failed.");
						}
						return;
					}
				}
				setAffinityWiden(null);
				const res = await saveMut.mutateAsync(provision.payload);
				handleSaveResult(res, provision.payload);
			} catch (e) {
				setProvisionError(String(e));
			} finally {
				setProvisionBusy(false);
			}
		},
		[
			provision,
			provisionBusy,
			provisionMut,
			project,
			harness,
			saveMut,
			handleSaveResult,
		],
	);

	const cancelProvision = useCallback(() => {
		setProvision(null);
		setProvisionError(null);
		setAffinityWiden(null);
		// Field errors stay set inline; the save remains blocked as usual.
	}, []);

	async function toggleDisabled() {
		try {
			await disableMut.mutateAsync({ name, disabled: !disabled });
		} catch (e) {
			toast.error("Toggle failed", String(e));
		}
	}

	async function doDelete() {
		try {
			const linkAction =
				link?.linked ? (deleteBoth ? "both" : "this") : undefined;
			const res = await deleteMut.mutateAsync({ name, linkAction });
			if (!res.ok) {
				const msg = res.errors?.map((e) => e.message).join("; ") || "could not delete";
				toast.error("Delete failed", msg);
				return;
			}
			toast.success(
				`Deleted ${name}`,
				link?.linked
					? deleteBoth
						? "Both linked files removed."
						: "This harness's file removed; the twin was unlinked."
					: undefined,
			);
			onDeleted?.();
		} catch (e) {
			toast.error("Delete failed", String(e));
		}
	}

	// ─── Linked-twin actions (D3) ───────────────────────────────────────────────

	async function doLink(copyFrom?: SubagentHarness) {
		try {
			const res = await linkMut.mutateAsync({ name, copyFrom });
			if (!res.ok) {
				toast.error("Link failed", res.error ?? "could not link");
				return;
			}
			toast.success(
				copyFrom ? `Copied ${name} to the linked harness` : `Linked ${name}`,
				copyFrom ? "The model reset to inherit in the new file." : undefined,
			);
		} catch (e) {
			toast.error("Link failed", String(e));
		}
	}

	async function doUnlink() {
		try {
			await unlinkMut.mutateAsync(name);
			toast.success(`Unlinked ${name}`, "Both files remain; edits no longer co-write.");
		} catch (e) {
			toast.error("Unlink failed", String(e));
		}
	}

	async function applyDrift(decisions: Record<string, SubagentHarness>) {
		try {
			const res = await resolveMut.mutateAsync({ name, decisions });
			if (!res.ok) {
				toast.error("Resolve failed", res.error ?? "could not resolve drift");
				return;
			}
			const remaining = res.drift?.length ?? 0;
			toast.success(
				remaining
					? `Applied — ${remaining} field${remaining === 1 ? "" : "s"} still differ`
					: `Drift resolved for ${name}`,
			);
		} catch (e) {
			toast.error("Resolve failed", String(e));
		}
	}

	const wrap = useCallback((left: string, right: string) => {
		editorRef.current?.wrapSelection(left, right);
	}, []);

	const errorFor = (field: string) =>
		errors.find((e) => e.field === field && e.level === "error");

	// Raw-escape-hatch format comes from `show` (yaml|toml); the harness is the
	// fallback for payloads that predate `advanced_format`.
	const advancedFormat =
		show?.advanced_format ?? (isCodex ? "toml" : "yaml");
	const foreignEntries = show?.foreign_skill_entries ?? [];

	if (!isLoading && (!show || !show.exists)) {
		return (
			<EmptyState
				icon="warning"
				title="Sub-agent not found"
				description={`No agent named ${name} in ${scope} scope`}
				action={<Button onClick={onBack}>Back</Button>}
			/>
		);
	}

	const discoveryDisabled = toolChoice === "all";

	return (
		<>
			<ScreenHeader
				back={{ label: "Sub-agents", onClick: onBack }}
				nameMono={agentName || name}
				meta={
					<>
						<span className="text-mono text-dim" style={{ fontSize: 11 }}>
							{scope === "project" ? `project · ${project}` : "user"}
						</span>
						{disabled && (
							<StatePill state="info" icon="power">
								DISABLED
							</StatePill>
						)}
					</>
				}
				crumbs={["harnesses", harness, "sub-agents", agentName || name]}
				overflow={[
					{
						icon: "power",
						label: disabled ? "Enable agent" : "Disable agent",
						onClick: () => void toggleDisabled(),
					},
					{ divider: true },
					{
						icon: "trash",
						label: "Delete agent",
						danger: true,
						onClick: () => setConfirmingDelete(true),
					},
				]}
			/>

			<div className="subagent-editor">
				<DocumentEditorShell
					content={body}
					onContentChange={(v) => {
						setBody(v);
						// CodeMirror emits the initial content on mount; only a real
						// divergence from the saved body counts as unsaved.
						if (v !== savedBodyRef.current) setDirty(true);
					}}
					editorRef={editorRef}
					mode={instructionsLocked ? "preview" : mode}
					onModeChange={setMode}
					modes={instructionsLocked ? ["preview"] : undefined}
					previewSource={body}
					diffOriginal={savedBodyRef.current}
					diffCurrent={body}
					dirty={dirty}
					onSave={() => void save()}
					saveDisabled={saveMut.isPending}
					splitStorageKey="st:layout:subagent-editor"
					headerExtras={
						instructionsLocked ? (
							<span
								className="subagent-drift-lockhint"
								role="alert"
								title="The system prompt has drifted between the linked files — resolve it in the form to edit."
							>
								<Icon name="warning" size={11} /> prompt drifted — resolve to edit
							</span>
						) : null
					}
					footerExtras={
						<span
							className="text-dim"
							style={{
								fontSize: 11,
								display: "inline-flex",
								gap: 4,
								alignItems: "center",
							}}
							title={`${harnessLabel(harness)} reads agent files at session start.`}
						>
							<Icon name="warning" size={11} />{" "}
							{isCodex
								? "Codex picks up agent file changes on the next session."
								: "Restart the Claude Code session to load disk edits"}
						</span>
					}
					toolbar={
						<div className="md-toolbar">
							<div className="seg">
								<button
									type="button"
									className="btn btn-sm"
									title="Bold"
									onMouseDown={(e) => e.preventDefault()}
									onClick={() => wrap("**", "**")}
								>
									<Icon name="md.bold" size={12} />
								</button>
								<button
									type="button"
									className="btn btn-sm"
									title="Italic"
									onMouseDown={(e) => e.preventDefault()}
									onClick={() => wrap("*", "*")}
								>
									<Icon name="md.italic" size={12} />
								</button>
								<button
									type="button"
									className="btn btn-sm"
									title="Heading"
									onMouseDown={(e) => e.preventDefault()}
									onClick={() => editorRef.current?.prefixLines("## ")}
								>
									<Icon name="md.h2" size={12} />
								</button>
								<button
									type="button"
									className="btn btn-sm"
									title="Bullet list"
									onMouseDown={(e) => e.preventDefault()}
									onClick={() => editorRef.current?.prefixLines("- ")}
								>
									<Icon name="md.list" size={12} />
								</button>
								<button
									type="button"
									className="btn btn-sm"
									title="Code"
									onMouseDown={(e) => e.preventDefault()}
									onClick={() => wrap("`", "`")}
								>
									<Icon name="md.code" size={12} />
								</button>
							</div>
							<span className="stretch" />
							<span
								className="right text-mono text-dim"
								style={{ fontSize: 11 }}
							>
								system prompt
							</span>
						</div>
					}
					dangerZone={
						<div className="danger-zone">
							<h4>Danger zone</h4>
							<div
								style={{
									fontSize: 11.5,
									color: "var(--fg-mute)",
									marginBottom: 10,
								}}
							>
								Deleting removes the agent file (a backup is kept) and any
								disable rule. To turn it off reversibly, use Disable instead.
							</div>
							<div className="actions" style={{ display: "flex", gap: 8 }}>
								<Button icon="power" onClick={() => void toggleDisabled()}>
									{disabled ? "Enable" : "Disable"}
								</Button>
								{confirmingDelete ? (
									<>
										<Button
											variant="danger"
											icon="trash"
											onClick={() => void doDelete()}
										>
											Confirm delete
										</Button>
										<Button onClick={() => setConfirmingDelete(false)}>
											Cancel
										</Button>
									</>
								) : (
									<Button
										variant="danger"
										icon="trash"
										onClick={() => setConfirmingDelete(true)}
									>
										Delete this agent
									</Button>
								)}
							</div>
							{confirmingDelete && link?.linked && (
								<div
									className="subagent-delete-choice"
									role="radiogroup"
									aria-label="Linked delete scope"
								>
									<label className="subagent-radio">
										<input
											type="radio"
											name="delete-link-action"
											checked={!deleteBoth}
											onChange={() => setDeleteBoth(false)}
										/>
										<span>
											Delete only this harness's file{" "}
											<span className="text-dim">(unlinks the twin)</span>
										</span>
									</label>
									<label className="subagent-radio">
										<input
											type="radio"
											name="delete-link-action"
											checked={deleteBoth}
											onChange={() => setDeleteBoth(true)}
										/>
										<span>
											Delete both linked files{" "}
											<span className="text-dim">
												({linkedOthers.map(harnessLabel).join(", ") || "twin"}{" "}
												too)
											</span>
										</span>
									</label>
								</div>
							)}
						</div>
					}
					sidePanel={
					<div className="subagent-editor-form">
					{/* ── Attach-skill provisioning consequence prompt (D5) ── */}
					{provision && (
						<ProvisionPanel
							items={provision.items}
							harness={harness}
							busy={provisionBusy}
							error={provisionError}
							widen={affinityWiden}
							onConfirm={confirmProvision}
							onCancel={cancelProvision}
						/>
					)}

					{/* ── Drift banner (linked twins diverged) ── */}
					{drift.length > 0 && (
						<DriftBanner
							drift={drift}
							harness={harness}
							pending={resolveMut.isPending}
							onApply={(d) => void applyDrift(d)}
						/>
					)}

					{/* ── Identity ── */}
					<section className="side-panel-block">
						<h4>Identity</h4>
						<MetaGrid>
							<Field label="name" full>
								<input
									value={agentName}
									onChange={(e) => markDirty(setAgentName)(e.target.value)}
									data-invalid={
										(agentName && !nameValid) || !!errorFor("name") || undefined
									}
									aria-invalid={!!errorFor("name")}
								/>
								{(errorFor("name") || (agentName && !nameValid)) && (
									<span className="field-error" role="alert">
										{errorFor("name")?.message ??
											(isCodex
												? "Lowercase letters, numbers, hyphens, and underscores only."
												: "Lowercase letters, numbers, and hyphens only.")}
									</span>
								)}
							</Field>
							<Field label="description" full>
								<textarea
									rows={3}
									value={description}
									readOnly={descLocked}
									data-locked={descLocked || undefined}
									onChange={(e) => markDirty(setDescription)(e.target.value)}
								/>
								{descLocked && <DriftLockHint />}
								{errorFor("description") && (
									<span className="field-error" role="alert">
										{errorFor("description")?.message}
									</span>
								)}
							</Field>
						</MetaGrid>
					</section>

					{/* ── Linked twin (D3, user scope only) ── */}
					{scope === "user" &&
						(link || otherTargets.length > 0) &&
						show?.exists && (
							<section className="side-panel-block">
								<h4>Linked twin</h4>
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
											onClick={() => void doUnlink()}
											disabled={unlinkMut.isPending}
										>
											Unlink
										</Button>
										<div className="subagent-note">
											Stops co-writing the shared core; both files stay on disk.
										</div>
									</div>
								) : link?.suggested ? (
									<div className="subagent-link-panel">
										<Button
											size="sm"
											icon="link"
											onClick={() => void doLink()}
											disabled={linkMut.isPending}
										>
											Link with {linkedOthers.map(harnessLabel).join(", ")}
										</Button>
										<div className="subagent-note">
											A same-named agent already exists there. Linking co-writes
											the shared core (name, description, prompt, skills) to both.
										</div>
									</div>
								) : (
									<div className="subagent-link-panel">
										{otherTargets.map((t) => (
											<Button
												key={t}
												size="sm"
												icon="link"
												onClick={() => void doLink(harness)}
												disabled={linkMut.isPending}
											>
												Copy to {harnessLabel(t)}…
											</Button>
										))}
										<div className="subagent-note">
											Creates a twin from the shared core and links them. The
											model resets to inherit in the new file (namespaces differ).
										</div>
									</div>
								)}
							</section>
						)}

					{/* ── Behavior ── */}
					<section className="side-panel-block">
						<h4>Behavior</h4>
						{isCodex ? (
							<CodexBehavior
								model={codexModel}
								onModel={markDirty(setCodexModel)}
								reasoningEffort={reasoningEffort}
								onReasoningEffort={markDirty(setReasoningEffort)}
								sandboxMode={sandboxMode}
								onSandboxMode={markDirty(setSandboxMode)}
								errorFor={errorFor}
							/>
						) : (
							<>
						<MetaGrid>
							<Field label="model" full>
								<select
									value={model}
									onChange={(e) => markDirty(setModel)(e.target.value)}
								>
									{MODEL_ALIASES.map((m) => (
										<option key={m} value={m}>
											{m}
										</option>
									))}
									<option value="custom">custom id…</option>
								</select>
								{model === "custom" && (
									<input
										style={{ marginTop: 6 }}
										placeholder="claude-…"
										value={customModel}
										onChange={(e) => markDirty(setCustomModel)(e.target.value)}
									/>
								)}
								{errorFor("model") && (
									<span className="field-error" role="alert">
										{errorFor("model")?.message}
									</span>
								)}
							</Field>
						</MetaGrid>

						<div className="subagent-field-label">Tool access</div>
						<div className="subagent-radio-group" role="radiogroup">
							{(
								[
									["all", "All tools (inherit)"],
									["readonly", "Read-only (Read, Glob, Grep)"],
									["custom", "Custom…"],
								] as Array<[ToolAccessChoice, string]>
							).map(([id, label]) => (
								<label key={id} className="subagent-radio">
									<input
										type="radio"
										name="tool-access"
										checked={toolChoice === id}
										onChange={() => markDirty(setToolChoice)(id)}
									/>
									<span>{label}</span>
								</label>
							))}
							{toolChoice === "denylist" && (
								<label className="subagent-radio">
									<input
										type="radio"
										name="tool-access"
										checked
										readOnly
									/>
									<span>
										Custom (deny-list) —{" "}
										<span className="text-dim">
											edit in Advanced to change
										</span>
									</span>
								</label>
							)}
						</div>

						{toolChoice === "custom" && (
							<div className="subagent-tool-grid">
								{toolOptions.map((t) => (
									<Toggle
										key={t}
										className="subagent-tool-check"
										size="sm"
										checked={customTools.includes(t)}
										label={<span className="text-mono">{t}</span>}
										onChange={(checked) =>
											markDirty(setCustomTools)(
												checked
													? [...customTools, t]
													: customTools.filter((x) => x !== t),
											)
										}
									/>
								))}
							</div>
						)}

						{toolChoice === "denylist" && (
							<div className="subagent-note">
								<Icon name="warning" size={11} /> This agent uses a deny-list
								({disallowedTools.join(", ") || "none"}). It is preserved on
								save; switch modes above only if you want to discard it.
							</div>
						)}

						<Toggle
							className="subagent-toggle"
							variant="switch"
							checked={discoveryDisabled ? true : allowDiscovery}
							disabled={discoveryDisabled}
							ariaLabel="Can use other skills on demand"
							onChange={(checked) => markDirty(setAllowDiscovery)(checked)}
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
					</section>

					{/* ── Skills ── */}
					<section className="side-panel-block">
						<h4>
							Attached skills{" "}
							<span style={{ color: "var(--fg-dim)" }}>· {skills.length}</span>
						</h4>
						<div className="subagent-skill-picker">
							{(attachable ?? []).length === 0 ? (
								<span className="text-dim text-mono" style={{ fontSize: 11 }}>
									no resolvable skills in scope
								</span>
							) : (
								(attachable ?? []).map((sk) => {
									const checked = skills.includes(sk.name);
									const blocked = !sk.invocable; // disable-model-invocation
									return (
										<label
											key={sk.name}
											className="subagent-skill-row"
											data-blocked={blocked || undefined}
											data-unresolved={!sk.resolved || undefined}
											title={sk.reason || sk.description}
										>
											<Toggle
												size="sm"
												ariaLabel={`Attach ${sk.name}`}
												checked={checked}
												disabled={skillsLocked || (blocked && !checked)}
												onChange={(c) =>
													markDirty(setSkills)(
														c
															? [...skills, sk.name]
															: skills.filter((x) => x !== sk.name),
													)
												}
											/>
											<span className="text-mono subagent-skill-name">
												{sk.name}
											</span>
											{blocked && (
												<span className="subagent-skill-tag" data-tone="error">
													not invocable
												</span>
											)}
											{!blocked && !sk.resolved && (
												<span className="subagent-skill-tag" data-tone="warn">
													unresolved
												</span>
											)}
											{sk.project_only && (
												<span className="subagent-skill-tag" data-tone="warn">
													project-only
												</span>
											)}
										</label>
									);
								})
							)}
						</div>
						{skillsLocked && <DriftLockHint />}
						{errorFor("skills") && (
							<span className="field-error" role="alert">
								{errorFor("skills")?.message}
							</span>
						)}

						{/* Codex `skills.config` entries hub does not manage (foreign
						    path or enabled=false) — preserved verbatim, shown read-only. */}
						{isCodex && foreignEntries.length > 0 && (
							<div className="subagent-foreign-skills">
								<div className="subagent-field-label">Other skill entries</div>
								<div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
									{foreignEntries.map((f) => (
										<div
											key={f.path}
											className="subagent-skill-row"
											data-blocked
											title={f.path}
										>
											<span className="text-mono subagent-skill-name">
												{f.path}
											</span>
											<span
												className="subagent-skill-tag"
												data-tone={f.enabled ? "ok" : "warn"}
											>
												{f.enabled ? "enabled" : "disabled"}
											</span>
										</div>
									))}
								</div>
								<div className="subagent-note">
									Hand-authored or disabled entries are preserved on save but
									not editable here.
								</div>
							</div>
						)}
					</section>

					{/* ── Appearance (Claude-only — Codex has no agent color) ── */}
					{!isCodex && (
					<section className="side-panel-block">
						<h4>Appearance</h4>
						<div className="subagent-swatches">
							<button
								type="button"
								className="subagent-swatch"
								data-active={color === "" || undefined}
								title="No color"
								onClick={() => markDirty(setColor)("")}
							>
								<Icon name="x" size={11} />
							</button>
							{AGENT_COLORS.map((c) => (
								<button
									key={c}
									type="button"
									className="subagent-swatch"
									data-active={color === c || undefined}
									style={{ ["--swatch" as string]: c }}
									title={c}
									onClick={() => markDirty(setColor)(c)}
								/>
							))}
						</div>
						{errorFor("color") && (
							<span className="field-error" role="alert">
								{errorFor("color")?.message}
							</span>
						)}
					</section>
					)}

					{/* ── Advanced ── */}
					<section className="side-panel-block">
						<button
							type="button"
							className="subagent-advanced-toggle"
							onClick={() => setAdvancedOpen((v) => !v)}
							aria-expanded={advancedOpen}
						>
							<Icon
								name={advancedOpen ? "chevron-down" : "chevron-right"}
								size={12}
							/>
							{advancedFormat === "toml"
								? "Advanced (raw TOML)"
								: "Advanced (raw YAML)"}
						</button>
						{advancedOpen && (
							<>
								<textarea
									className="subagent-advanced-yaml text-mono"
									rows={6}
									placeholder={
										advancedFormat === "toml"
											? "[mcp_servers.name]\ncommand = …"
											: "hooks: …\nmcpServers: …\npermissionMode: …"
									}
									value={advancedYaml}
									onChange={(e) => markDirty(setAdvancedYaml)(e.target.value)}
									data-invalid={!!errorFor("advanced_yaml") || undefined}
								/>
								{errorFor("advanced_yaml") && (
									<span className="field-error" role="alert">
										{errorFor("advanced_yaml")?.message}
									</span>
								)}
								<div className="subagent-note">
									{advancedFormat === "toml"
										? "Risky fields ([mcp_servers.*] and unknown keys) live here. Must parse as TOML."
										: "Risky fields (hooks, mcpServers, permissionMode) live here. Must parse as a YAML mapping."}
								</div>
							</>
						)}
					</section>

					</div>
					}
				/>
			</div>
		</>
	);
}

// ─── Codex Behavior section ───────────────────────────────────────────────────
// Codex scopes an agent's capability via `sandbox_mode` (no per-tool rules) and
// tunes it via a free-text model id + reasoning effort. Empty = inherit.

const SANDBOX_LABELS: Record<CodexSandboxMode, string> = {
	"": "Inherit (session sandbox)",
	"read-only": "Read-only",
	"workspace-write": "Workspace write",
	"danger-full-access": "Full access (danger)",
};

function CodexBehavior({
	model,
	onModel,
	reasoningEffort,
	onReasoningEffort,
	sandboxMode,
	onSandboxMode,
	errorFor,
}: {
	model: string;
	onModel: (v: string) => void;
	reasoningEffort: string;
	onReasoningEffort: (v: string) => void;
	sandboxMode: CodexSandboxMode;
	onSandboxMode: (v: CodexSandboxMode) => void;
	errorFor: (field: string) => SubagentWarning | undefined;
}) {
	// A hand-authored effort value outside the known set still round-trips: keep
	// it selectable so hydration doesn't silently coerce it.
	const effortOptions = CODEX_REASONING_EFFORTS.includes(
		reasoningEffort as never,
	)
		? [...CODEX_REASONING_EFFORTS]
		: [...CODEX_REASONING_EFFORTS, reasoningEffort];
	return (
		<>
			<MetaGrid>
				<Field label="model" full>
					<input
						placeholder="inherit from session (e.g. gpt-5.3-codex)"
						value={model}
						onChange={(e) => onModel(e.target.value)}
					/>
					{errorFor("model") && (
						<span className="field-error" role="alert">
							{errorFor("model")?.message}
						</span>
					)}
				</Field>
				<Field label="reasoning effort" full>
					<select
						value={reasoningEffort}
						onChange={(e) => onReasoningEffort(e.target.value)}
					>
						{effortOptions.map((v) => (
							<option key={v} value={v}>
								{v === "" ? "inherit" : v}
							</option>
						))}
					</select>
					{errorFor("model_reasoning_effort") && (
						<span className="field-error" role="alert">
							{errorFor("model_reasoning_effort")?.message}
						</span>
					)}
				</Field>
			</MetaGrid>

			<div className="subagent-field-label">Capability (sandbox mode)</div>
			<div className="subagent-radio-group" role="radiogroup">
				{CODEX_SANDBOX_MODES.map((m) => (
					<label
						key={m || "inherit"}
						className="subagent-radio"
						data-danger={m === "danger-full-access" || undefined}
					>
						<input
							type="radio"
							name="sandbox-mode"
							checked={sandboxMode === m}
							onChange={() => onSandboxMode(m)}
						/>
						<span
							style={
								m === "danger-full-access"
									? { color: "var(--red)", fontWeight: 600 }
									: undefined
							}
						>
							{SANDBOX_LABELS[m]}
							{m === "danger-full-access" && (
								<span
									className="text-dim"
									style={{ marginLeft: 6, fontSize: 11, fontWeight: 400 }}
								>
									no sandbox — the agent can touch anything you can
								</span>
							)}
						</span>
					</label>
				))}
			</div>
			{errorFor("sandbox_mode") && (
				<span className="field-error" role="alert">
					{errorFor("sandbox_mode")?.message}
				</span>
			)}
			<div className="subagent-note">
				Codex scopes capability via sandbox_mode, not per-tool rules.
			</div>
		</>
	);
}

// ─── Drift banner (D3) ────────────────────────────────────────────────────────
// Calm-but-prominent: lists each drifted shared-core field with BOTH sides'
// values and a per-field winner choice. Nothing is written until Apply — a
// preview beats a warning, and the drifted fields stay frozen server-side.

const DRIFT_FIELD_LABEL: Record<string, string> = {
	description: "description",
	instructions: "system prompt",
	skills: "attached skills",
};

/** Max characters of a drifted instructions value shown in the banner preview. */
const DRIFT_PREVIEW_MAX_CHARS = 90;

/** Compact preview of a field value for the drift banner. */
function previewValue(field: string, v: unknown): string {
	if (Array.isArray(v)) return v.length ? v.join(", ") : "(none)";
	const s = String(v ?? "");
	if (field === "instructions") {
		const t = s.replace(/\s+/g, " ").trim();
		return t.length > DRIFT_PREVIEW_MAX_CHARS
			? `${t.slice(0, DRIFT_PREVIEW_MAX_CHARS)}…`
			: t || "(empty)";
	}
	return s || "(empty)";
}

function DriftLockHint() {
	return (
		<span className="subagent-drift-lockhint">
			<Icon name="warning" size={10} /> Drifted — resolve above to edit.
		</span>
	);
}

function DriftBanner({
	drift,
	harness,
	onApply,
	pending,
}: {
	drift: SubagentDriftField[];
	harness: SubagentHarness;
	onApply: (decisions: Record<string, SubagentHarness>) => void;
	pending: boolean;
}) {
	// Winner harness ids present in the drift payload.
	const hids = useMemo(() => {
		const s = new Set<string>();
		for (const d of drift) for (const h of Object.keys(d.values)) s.add(h);
		return Array.from(s).sort();
	}, [drift]);

	// Default each field's winner to the harness the editor is showing.
	const [decisions, setDecisions] = useState<Record<string, string>>(() =>
		Object.fromEntries(drift.map((d) => [d.field, harness])),
	);
	useEffect(() => {
		setDecisions(Object.fromEntries(drift.map((d) => [d.field, harness])));
	}, [drift, harness]);

	return (
		<div className="subagent-drift-banner" role="alert">
			<div className="subagent-drift-head">
				<Icon name="warning" size={14} />
				<div>
					<div className="subagent-drift-title">Linked files have drifted</div>
					<div className="subagent-drift-sub">
						These fields differ between the linked files. Choose which side wins
						for each, then apply. Neither file is overwritten until you do.
					</div>
				</div>
			</div>
			<div className="subagent-drift-fields">
				{drift.map((d) => (
					<div key={d.field} className="subagent-drift-field">
						<div className="subagent-drift-field-name text-mono">
							{DRIFT_FIELD_LABEL[d.field] ?? d.field}
						</div>
						<div className="subagent-drift-choices">
							{hids.map((h) => (
								<label
									key={h}
									className="subagent-drift-choice"
									data-active={decisions[d.field] === h || undefined}
								>
									<input
										type="radio"
										name={`drift-${d.field}`}
										checked={decisions[d.field] === h}
										onChange={() =>
											setDecisions((prev) => ({ ...prev, [d.field]: h }))
										}
									/>
									<span className="subagent-drift-choice-h">
										<HarnessGlyph id={h} size={12} decorative />
										{harnessLabel(h)}
									</span>
									<span className="subagent-drift-choice-v">
										{previewValue(d.field, d.values[h])}
									</span>
								</label>
							))}
						</div>
					</div>
				))}
			</div>
			<div className="subagent-drift-actions">
				<LoadingButton
					variant="primary"
					icon="check"
					loading={pending}
					loadingLabel="Applying…"
					onClick={() => onApply(decisions as Record<string, SubagentHarness>)}
				>
					Apply resolution
				</LoadingButton>
			</div>
		</div>
	);
}
