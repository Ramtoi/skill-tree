import { useRef, useState } from "react";
import { Button } from "@/components/Button";
import { LoadingButton } from "@/components/loading";
import { Sheet } from "@/components/Modal";
import { Field } from "@/components/Field";
import { useToast } from "@/components/Toast";
import { useSaveSubagent } from "@/hooks/useSubagents";
import type {
	SubagentHarness,
	SubagentSafe,
	SubagentScope,
} from "@/lib/subagents";

// Codex names allow underscores (`pr_explorer` style); Claude is hyphen-only.
const CLAUDE_SLUG_RE = /^[a-z0-9-]+$/;
const CODEX_SLUG_RE = /^[a-z0-9_-]+$/;

type Preset = "blank" | "reviewer" | "general";

const PRESETS: Record<
	Preset,
	{ label: string; hint: string; safe: Partial<SubagentSafe>; body: string }
> = {
	blank: {
		label: "Blank",
		hint: "Empty system prompt, all tools inherited.",
		safe: { model: "", tools_mode: "all", tools: [] },
		body: "",
	},
	reviewer: {
		label: "Read-only reviewer",
		hint: "Read, Glob, Grep only — safe for analysis.",
		safe: { model: "", tools_mode: "allowlist", tools: ["Read", "Glob", "Grep"] },
		body: "You are a careful read-only reviewer. Inspect the code and report findings; never modify files.",
	},
	general: {
		label: "General agent",
		hint: "All tools, with a starter instruction.",
		safe: { model: "", tools_mode: "all", tools: [] },
		body: "You are a focused agent. Follow the user's task precisely and report what you did.",
	},
};

// Codex has no per-tool allowlist, so the read-only preset (Claude-tools-specific)
// is hidden; and `developer_instructions` is required, so "Blank" carries a minimal
// starter body the user then fleshes out in the editor.
const CODEX_PRESETS: Record<
	Exclude<Preset, "reviewer">,
	{ label: string; hint: string; body: string }
> = {
	blank: {
		label: "Blank",
		hint: "Minimal starter prompt — inherit the session's sandbox & model.",
		body: "Describe how this agent should behave.",
	},
	general: {
		label: "General agent",
		hint: "A starter instruction; inherit the session's sandbox & model.",
		body: "You are a focused agent. Follow the user's task precisely and report what you did.",
	},
};

export interface NewSubagentSheetProps {
	/** Harness the new agent is created for (default claude-code). */
	harness?: SubagentHarness;
	scope: SubagentScope;
	project: string | null;
	/** Available projects for the scope picker (when creating in project scope). */
	projects: string[];
	onClose: () => void;
	/** Called after the file is created, with the resolved scope/project/name so
	 *  the parent can open the editor. */
	onCreated: (scope: SubagentScope, project: string | null, name: string) => void;
}

export function NewSubagentSheet({
	harness = "claude-code",
	scope: initialScope,
	project: initialProject,
	projects,
	onClose,
	onCreated,
}: NewSubagentSheetProps) {
	const toast = useToast();
	const saveMut = useSaveSubagent();
	const isCodex = harness === "codex";

	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [scope, setScope] = useState<SubagentScope>(initialScope);
	const [project, setProject] = useState<string | null>(
		initialProject ?? projects[0] ?? null,
	);
	const [preset, setPreset] = useState<Preset>("blank");
	const [error, setError] = useState<string | null>(null);
	// Deterministic initial focus: the Modal's focus-trap would otherwise grab the
	// close-x on open (a rAF that can race a fast typist / test) — point it here.
	const nameRef = useRef<HTMLInputElement>(null);

	const slugRe = isCodex ? CODEX_SLUG_RE : CLAUDE_SLUG_RE;
	const presetKeys: Preset[] = isCodex
		? ["blank", "general"]
		: (Object.keys(PRESETS) as Preset[]);
	const presetMeta = (p: Preset) =>
		isCodex && p !== "reviewer"
			? CODEX_PRESETS[p as Exclude<Preset, "reviewer">]
			: PRESETS[p];
	const nameValid = slugRe.test(name.trim());
	const canCreate =
		nameValid &&
		description.trim().length > 0 &&
		(scope === "user" || !!project);

	async function create() {
		setError(null);
		if (!canCreate) {
			setError(
				!nameValid
					? isCodex
						? "Name must use lowercase letters, numbers, hyphens, and underscores."
						: "Name must use lowercase letters, numbers, and hyphens."
					: !description.trim()
						? "Description is required."
						: "Pick a project.",
			);
			return;
		}
		// Codex overlays no per-tool rules; its safe carries the sandbox/effort keys.
		const claudePreset = PRESETS[preset];
		const body = isCodex ? presetMeta(preset).body : claudePreset.body;
		const safe: SubagentSafe = {
			name: name.trim(),
			description: description.trim(),
			model: "",
			tools_mode: isCodex ? "all" : claudePreset.safe.tools_mode ?? "all",
			tools: isCodex ? [] : claudePreset.safe.tools ?? [],
			disallowed_tools: [],
			allow_skill_discovery: isCodex
				? true
				: (claudePreset.safe.tools_mode ?? "all") === "all",
			skills: [],
			color: "",
			...(isCodex
				? {
						sandbox_mode: "",
						model_reasoning_effort: "",
						nickname_candidates: [],
					}
				: {}),
		};
		try {
			const res = await saveMut.mutateAsync({
				...(isCodex ? { harness } : {}),
				scope,
				project: scope === "project" ? project : null,
				original_name: null,
				safe,
				advanced_yaml: "",
				body,
			});
			if (!res.ok) {
				setError(res.errors?.[0]?.message ?? "Could not create the agent.");
				return;
			}
			toast.success(`Created ${res.name}`);
			onCreated(scope, scope === "project" ? project : null, res.name ?? name.trim());
		} catch (e) {
			setError(String(e));
		}
	}

	return (
		<Sheet
			open
			side="right"
			onClose={onClose}
			title="New sub-agent"
			aria-label="New sub-agent"
			initialFocus={nameRef}
			footer={
				<>
					<Button onClick={onClose}>Cancel</Button>
					<LoadingButton
						variant="primary"
						icon="plus"
						loading={saveMut.isPending}
						loadingLabel="Creating…"
						disabled={!canCreate}
						onClick={() => void create()}
					>
						Create
					</LoadingButton>
				</>
			}
		>
			<div className="modal-form">
				<Field label="name">
					<input
						ref={nameRef}
						value={name}
						onChange={(e) => setName(e.target.value)}
						placeholder="code-reviewer"
						data-invalid={(name && !nameValid) || undefined}
					/>
				</Field>
				<Field label="description">
					<textarea
						rows={3}
						value={description}
						onChange={(e) => setDescription(e.target.value)}
						placeholder="When this agent should be used…"
					/>
				</Field>
				<Field label="scope">
					<select
						value={scope}
						disabled={isCodex}
						onChange={(e) => setScope(e.target.value as SubagentScope)}
					>
						<option value="user">User (all projects)</option>
						<option value="project" disabled={isCodex || projects.length === 0}>
							Project
						</option>
					</select>
					{isCodex && (
						<span className="text-dim" style={{ fontSize: 11, marginTop: 4 }}>
							Codex project agents ship later (requires project trust).
						</span>
					)}
				</Field>
				{scope === "project" && (
					<Field label="project">
						<select
							value={project ?? ""}
							onChange={(e) => setProject(e.target.value || null)}
						>
							{projects.map((p) => (
								<option key={p} value={p}>
									{p}
								</option>
							))}
						</select>
					</Field>
				)}
				<Field label="starter preset">
					<div
						style={{ display: "flex", flexDirection: "column", gap: 6 }}
						role="radiogroup"
					>
						{presetKeys.map((p) => (
							<label key={p} className="subagent-radio">
								<input
									type="radio"
									name="preset"
									checked={preset === p}
									onChange={() => setPreset(p)}
								/>
								<span>
									{presetMeta(p).label}
									<span className="text-dim" style={{ marginLeft: 6, fontSize: 11 }}>
										{presetMeta(p).hint}
									</span>
								</span>
							</label>
						))}
					</div>
				</Field>
				{error && (
					<span className="field-error" role="alert">
						{error}
					</span>
				)}
			</div>
		</Sheet>
	);
}
