import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	type MutableRefObject,
} from "react";
import {
	CLAUDE_AGENT_NAME_RE,
	CODEX_AGENT_NAME_RE,
	KNOWN_TOOLS,
	MODEL_ALIASES,
	READ_ONLY_TOOLS,
	toolAccessChoice,
	type AgentColor,
	type CodexSandboxMode,
	type NeedsProvisioning,
	type SubagentHarness,
	type SubagentSafe,
	type SubagentSavePayload,
	type SubagentSaveResult,
	type SubagentScope,
	type SubagentShow,
	type SubagentWarning,
	type ToolAccessChoice,
} from "@/lib/subagents";

export interface SubagentDraft {
	agentName: string;
	setAgentName: (v: string) => void;
	description: string;
	setDescription: (v: string) => void;
	model: string;
	setModel: (v: string) => void;
	customModel: string;
	setCustomModel: (v: string) => void;
	toolChoice: ToolAccessChoice;
	setToolChoice: (v: ToolAccessChoice) => void;
	customTools: string[];
	setCustomTools: (v: string[]) => void;
	disallowedTools: string[];
	setDisallowedTools: (v: string[]) => void;
	allowDiscovery: boolean;
	setAllowDiscovery: (v: boolean) => void;
	skills: string[];
	setSkills: (v: string[]) => void;
	color: AgentColor;
	setColor: (v: AgentColor) => void;
	codexModel: string;
	setCodexModel: (v: string) => void;
	sandboxMode: CodexSandboxMode;
	setSandboxMode: (v: CodexSandboxMode) => void;
	reasoningEffort: string;
	setReasoningEffort: (v: string) => void;
	advancedYaml: string;
	setAdvancedYaml: (v: string) => void;
	body: string;
	setBody: (v: string) => void;
	dirty: boolean;
	setDirty: (v: boolean) => void;
	errors: SubagentWarning[];
	setErrors: (v: SubagentWarning[]) => void;
	savedBodyRef: MutableRefObject<string>;
	markDirty: <T>(setter: (v: T) => void) => (v: T) => void;
	toolOptions: string[];
	nameValid: boolean;
	buildSafe: () => SubagentSafe;
	buildPayload: () => SubagentSavePayload;
	errorFor: (field: string) => SubagentWarning | undefined;
	/** Folds a successful save into the draft: freezes the saved body (and the
	 *  raw-escape-hatch text) as the new diff/dirty baseline. Errors are handled
	 *  separately via `setErrors`. */
	applySaveSuccess: (body: string, savedAdvancedYaml: string) => void;
	/** True while `advancedYaml` differs from what was last loaded/saved — the
	 *  Advanced section force-opens while this holds (rule 11). */
	advancedDirty: boolean;
}

/** Owns every form field for the sub-agent editor (D2 guided controls +
 *  advanced escape hatch), hydrated from `subagent_show`, plus the derived
 *  save-payload builders. Extracted verbatim from SubagentEditor so the
 *  component keeps zero behaviour change. */
export function useSubagentDraft({
	show,
	name,
	isCodex,
	harness,
	scope,
	project,
}: {
	show: SubagentShow | undefined;
	name: string;
	isCodex: boolean;
	harness: SubagentHarness;
	scope: SubagentScope;
	project: string | null;
}): SubagentDraft {
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
	const [body, setBody] = useState("");
	const [dirty, setDirty] = useState(false);
	const [errors, setErrors] = useState<SubagentWarning[]>([]);

	const savedBodyRef = useRef("");
	const savedAdvancedYamlRef = useRef("");

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
		savedAdvancedYamlRef.current = show.advanced_yaml ?? "";
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

	const nameValid = (isCodex ? CODEX_AGENT_NAME_RE : CLAUDE_AGENT_NAME_RE).test(
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

	const errorFor = (field: string) =>
		errors.find((e) => e.field === field && e.level === "error");

	const applySaveSuccess = useCallback(
		(savedBody: string, savedAdvancedYaml: string) => {
			savedBodyRef.current = savedBody;
			savedAdvancedYamlRef.current = savedAdvancedYaml;
			setDirty(false);
		},
		[],
	);
	const advancedDirty = advancedYaml !== savedAdvancedYamlRef.current;

	return {
		agentName,
		setAgentName,
		description,
		setDescription,
		model,
		setModel,
		customModel,
		setCustomModel,
		toolChoice,
		setToolChoice,
		customTools,
		setCustomTools,
		disallowedTools,
		setDisallowedTools,
		allowDiscovery,
		setAllowDiscovery,
		skills,
		setSkills,
		color,
		setColor,
		codexModel,
		setCodexModel,
		sandboxMode,
		setSandboxMode,
		reasoningEffort,
		setReasoningEffort,
		advancedYaml,
		setAdvancedYaml,
		body,
		setBody,
		dirty,
		setDirty,
		errors,
		setErrors,
		savedBodyRef,
		markDirty,
		toolOptions,
		nameValid,
		buildSafe,
		buildPayload,
		errorFor,
		applySaveSuccess,
		advancedDirty,
	};
}

// ─── Attach-skill provisioning flow (D5) ───────────────────────────────────────
// When a save is blocked purely by unresolved, newly-attached registry skills,
// each blocking error carries `needs_provisioning`. We surface a consequence
// prompt; on confirm we provision each skill then re-save the captured payload.

export interface ProvisionFlow {
	provision: { items: NeedsProvisioning[]; payload: SubagentSavePayload } | null;
	provisionBusy: boolean;
	provisionError: string | null;
	affinityWiden: { skill: string; affinity: string[] } | null;
	/** Raises the consequence prompt for a blocked save. */
	raise: (items: NeedsProvisioning[], payload: SubagentSavePayload) => void;
	/** Clears the prompt + any in-flight provisioning error/widen state. */
	clear: () => void;
	confirmProvision: (widenSkill?: string) => Promise<void>;
	cancelProvision: () => void;
}

interface ProvisionMutLike {
	mutateAsync: (args: {
		skill: string;
		global: boolean;
		project?: string | null;
		harnessId?: SubagentHarness;
		widenAffinity?: boolean;
	}) => Promise<{
		ok: boolean;
		error?: string;
		affinity?: string[];
		widen_available?: boolean;
	}>;
}

interface SaveMutLike {
	mutateAsync: (payload: SubagentSavePayload) => Promise<SubagentSaveResult>;
}

/** Owns the attach-skill provisioning consequence prompt: state + the confirm/
 *  cancel flow. `onSaveResult` is `handleSaveResult`, which stays in the
 *  component (it also folds the result into the draft) — a ref indirection
 *  lets this hook call the latest closure without a definition-order cycle. */
export function useProvisionFlow({
	provisionMut,
	saveMut,
	project,
	harness,
	onSaveResult,
}: {
	provisionMut: ProvisionMutLike;
	saveMut: SaveMutLike;
	project: string | null;
	harness: SubagentHarness;
	onSaveResult: (res: SubagentSaveResult, payload: SubagentSavePayload) => boolean;
}): ProvisionFlow {
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

	const onSaveResultRef = useRef(onSaveResult);
	onSaveResultRef.current = onSaveResult;

	const raise = useCallback(
		(items: NeedsProvisioning[], payload: SubagentSavePayload) => {
			setProvisionError(null);
			setAffinityWiden(null);
			setProvision({ items, payload });
		},
		[],
	);

	const clear = useCallback(() => {
		setProvision(null);
		setProvisionError(null);
		setAffinityWiden(null);
	}, []);

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
				onSaveResultRef.current(res, provision.payload);
			} catch (e) {
				setProvisionError(String(e));
			} finally {
				setProvisionBusy(false);
			}
		},
		[provision, provisionBusy, provisionMut, project, harness, saveMut],
	);

	const cancelProvision = useCallback(() => {
		// Field errors stay set inline; the save remains blocked as usual.
		clear();
	}, [clear]);

	return {
		provision,
		provisionBusy,
		provisionError,
		affinityWiden,
		raise,
		clear,
		confirmProvision,
		cancelProvision,
	};
}
