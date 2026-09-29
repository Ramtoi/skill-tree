import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { BackButton } from "@/components/BackButton";
import { Button } from "@/components/Button";
import { DocumentEditorShell, type DocMode } from "@/components/DocumentEditorShell";
import type { CodeAreaHandle } from "@/components/CodeArea";
import { EmptyState } from "@/components/EmptyState";
import { Field } from "@/components/Field";
import { ConfirmDialog } from "@/components/Modal";
import { Select } from "@/components/Select";
import { SidePanelSection } from "@/components/SidePanelSection";
import { ScreenHeader } from "@/components/ScreenHeader";
import { StatePill } from "@/components/StatePill";
import { Tag } from "@/components/Tag";
import { MarkdownToolbar } from "@/components/skillEditor/MarkdownToolbar";
import { SubagentModelPicker } from "@/components/subagents/SubagentModelPicker";
import { useToast } from "@/components/Toast";
import { CODEX_REASONING_EFFORTS } from "@/lib/subagents";
import { hubCmd } from "@/lib/hubCmd";
import { invalidateRegistry } from "@/lib/invalidate";
import { parseCliJson } from "@/lib/skillPack";
import { backReturnOptions, skillBackTarget, useBackTarget } from "@/lib/backTarget";
import { attemptNavigation, useUnsavedGuard } from "@/lib/navGuard";
import { qk } from "@/lib/queryKeys";

export interface SkillAgentHarnessConfig {
	model: string;
	model_reasoning_effort?: string;
}

export interface SkillAgentDocument {
	ok: boolean;
	skill: string;
	name: string;
	description: string;
	body: string;
	tier: string;
	hash: string;
	editable: boolean;
	harnesses: {
		"claude-code"?: SkillAgentHarnessConfig;
		codex?: SkillAgentHarnessConfig;
	};
	error?: string;
}

interface SkillAgentSaveResult extends SkillAgentDocument {
	reconcile?: unknown;
	conflict?: boolean;
}

interface SkillAgentDraft {
	description: string;
	body: string;
	claudeModel: string;
	codexModel: string;
	reasoningEffort: string;
}

interface SkillAgentSaveRequest {
	skill: string;
	agent: string;
	expectedHash: string;
	draft: SkillAgentDraft;
}

function draftFromDocument(doc: SkillAgentDocument): SkillAgentDraft {
	return {
		description: doc.description ?? "",
		body: doc.body ?? "",
		claudeModel: doc.harnesses?.["claude-code"]?.model ?? "",
		codexModel: doc.harnesses?.codex?.model ?? "",
		reasoningEffort: doc.harnesses?.codex?.model_reasoning_effort ?? "",
	};
}

function sourceArgs(skill: string, agent: string): string[] {
	return ["skill", "companions", "agent", skill, "--agent", agent, "--json"];
}

async function readSourceAgent(skill: string, agent: string): Promise<SkillAgentDocument> {
	const result = await hubCmd(sourceArgs(skill, agent));
	if (!result.success) throw new Error(result.output || "Could not read the source agent");
	const payload = parseCliJson<SkillAgentDocument>(result.output);
	if (!payload.ok) throw new Error(payload.error || "Could not read the source agent");
	return payload;
}

function reconcileMessage(value: unknown): string | null {
	if (!value || typeof value !== "object") return null;
	const record = value as Record<string, unknown>;
	const parts: string[] = [];
	for (const key of ["drift", "pending", "errors", "error", "conflicts"]) {
		const item = record[key];
		if (Array.isArray(item) && item.length) parts.push(`${item.length} ${key}`);
		else if (typeof item === "string" && item) parts.push(item);
		else if (item === true) parts.push(key);
	}
	return parts.length ? `Source saved; reconciliation reports ${parts.join(", ")}.` : null;
}

export function SkillAgentEditor() {
	const { name: skillParam, agent: agentParam } = useParams<{ name: string; agent: string }>();
	const skill = skillParam ?? "";
	const agent = agentParam ?? "";
	const routeIdentity = useRef({ skill, agent });
	routeIdentity.current = { skill, agent };
	const navigate = useNavigate();
	const toast = useToast();
	const queryClient = useQueryClient();
	const back = useBackTarget(skillBackTarget(skill));
	const query = useQuery({
		queryKey: qk.skillAgent(skill, agent),
		queryFn: () => readSourceAgent(skill, agent),
		enabled: !!skill && !!agent,
	});

	const [description, setDescription] = useState("");
	const [body, setBody] = useState("");
	const [claudeModel, setClaudeModel] = useState("");
	const [codexModel, setCodexModel] = useState("");
	const [reasoningEffort, setReasoningEffort] = useState("");
	const [baseline, setBaseline] = useState({ description: "", body: "", claudeModel: "", codexModel: "", reasoningEffort: "" });
	const [mode, setMode] = useState<DocMode>("edit");
	const editorRef = useRef<CodeAreaHandle>(null);
	const hydratedRef = useRef<{ identity: string; hash: string } | null>(null);
	const dirty =
		description !== baseline.description || body !== baseline.body ||
		claudeModel !== baseline.claudeModel || codexModel !== baseline.codexModel ||
		reasoningEffort !== baseline.reasoningEffort;

	useEffect(() => {
		const doc = query.data;
		if (!doc) return;
		const identity = `${skill}/${agent}`;
		if (hydratedRef.current?.identity === identity) {
			if (hydratedRef.current.hash === doc.hash || dirty) return;
		}
		const next = draftFromDocument(doc);
		setDescription(next.description);
		setBody(next.body);
		setClaudeModel(next.claudeModel);
		setCodexModel(next.codexModel);
		setReasoningEffort(next.reasoningEffort);
		setBaseline(next);
		hydratedRef.current = { identity, hash: doc.hash };
	}, [agent, dirty, query.data, skill]);

	const guard = useUnsavedGuard(dirty);
	const readOnly = query.data?.editable === false;

	const save = useMutation({
		mutationFn: async (request: SkillAgentSaveRequest) => {
			const payload = {
				expected_hash: request.expectedHash,
				description: request.draft.description,
				body: request.draft.body,
				harnesses: {
					"claude-code": { model: request.draft.claudeModel },
					codex: { model: request.draft.codexModel, model_reasoning_effort: request.draft.reasoningEffort },
				},
			};
			const result = await hubCmd([
				"skill", "companions", "save-agent", request.skill, "--agent", request.agent,
				"--json-body", JSON.stringify(payload),
				"--json",
			]);
			let response: SkillAgentSaveResult;
			try {
				response = parseCliJson<SkillAgentSaveResult>(result.output);
			} catch {
				throw new Error(result.output || "Could not save the source agent");
			}
			if (!result.success || !response.ok) {
				throw new Error(response.error || result.output || "Could not save the source agent");
			}
			return { response, request };
		},
		onSuccess: async ({ response, request }) => {
			const saved = draftFromDocument(response);
			queryClient.setQueryData(qk.skillAgent(request.skill, request.agent), response);
			const currentRoute = routeIdentity.current.skill === request.skill
				&& routeIdentity.current.agent === request.agent;
			if (currentRoute) {
				setDescription(saved.description);
				setBody(saved.body);
				setClaudeModel(saved.claudeModel);
				setCodexModel(saved.codexModel);
				setReasoningEffort(saved.reasoningEffort);
				setBaseline(saved);
				hydratedRef.current = { identity: `${request.skill}/${request.agent}`, hash: response.hash };
			}
			// The saved response is authoritative for this editor. Refresh native
			// list/show caches in the background without replacing that response.
			await Promise.allSettled([
				...(["claude-code", "codex"] as const).flatMap((harness) => [
					qk.subagents.list("user", null, harness),
					qk.subagents.one("user", null, request.agent, harness),
					qk.subagents.attachable("user", null, harness),
				]).map((queryKey) => queryClient.invalidateQueries({ queryKey })),
				queryClient.invalidateQueries({ queryKey: qk.subagents.skillUsage() }),
				queryClient.invalidateQueries({ queryKey: qk.subagents.linkStatus("user") }),
				invalidateRegistry(queryClient),
			]);
			const warning = reconcileMessage(response.reconcile);
			if (warning) toast.info(`Saved ${request.agent}`, warning);
			else toast.success(`Saved ${request.agent}`);
		},
		onError: (error) => toast.error("Couldn't save source agent", error instanceof Error ? error.message : String(error)),
	});
	const controlsReadOnly = readOnly || save.isPending;

	const leave = useCallback(() => {
		attemptNavigation(() => navigate(back.path, backReturnOptions(back)));
	}, [back, navigate]);
	const config = useMemo(() => (
		<div className="skill-agent-editor-side">
			<div className="side-panel-block side-identity" data-block="identity">
				<Field label="Description" full htmlFor="skill-agent-description">
					<textarea id="skill-agent-description" value={description} readOnly={controlsReadOnly} onChange={(e) => setDescription(e.target.value)} />
				</Field>
			</div>
			<SidePanelSection id="claude-code" title="Claude Code configuration" defaultOpen>
				<div className="skill-agent-config-control">
					<span className="skill-agent-config-label">Model</span>
					{controlsReadOnly ? <span className="skill-agent-readonly-value" aria-label="Claude Code model">{claudeModel || "inherit"}</span> : <SubagentModelPicker harness="claude-code" label="Claude Code model" value={claudeModel} onChange={setClaudeModel} />}
				</div>
			</SidePanelSection>
			<SidePanelSection id="codex" title="Codex configuration" defaultOpen>
				<div className="skill-agent-config-control">
					<span className="skill-agent-config-label">Model</span>
					{controlsReadOnly ? <span className="skill-agent-readonly-value" aria-label="Codex model">{codexModel || "inherit"}</span> : <SubagentModelPicker harness="codex" label="Codex model" value={codexModel} onChange={setCodexModel} />}
					<span className="skill-agent-config-label">Reasoning effort</span>
					{controlsReadOnly ? <span className="skill-agent-readonly-value" aria-label="Codex reasoning effort">{reasoningEffort || "inherit"}</span> : <Select
						value={reasoningEffort}
						label="Codex reasoning effort"
						options={CODEX_REASONING_EFFORTS.map((value) => ({ value, label: value || "inherit" }))}
						onChange={setReasoningEffort}
					/>}
				</div>
			</SidePanelSection>
		</div>
	), [claudeModel, codexModel, controlsReadOnly, description, reasoningEffort]);

	const chrome = (
		<ScreenHeader
			back={{ label: back.label, onClick: leave }}
			nameMono={agent}
			meta={<Tag size="sm">Skill agent</Tag>}
			state={query.data?.editable === false ? <StatePill state="readonly">READ-ONLY</StatePill> : undefined}
			crumbs={["skill", skill, "agent", agent]}
		/>
	);

	if (query.isLoading) return <>{chrome}<EmptyState icon="search" title="Loading source agent" description="Reading the shared agent file…" /></>;
	if (!query.data) {
		return <>{chrome}<EmptyState icon="warning" title="Source agent unavailable" description={query.error instanceof Error ? query.error.message : "The shared source could not be read."} action={<><Button variant="soft" onClick={() => void query.refetch()}>Retry</Button><BackButton onClick={leave}>Back to {back.label}</BackButton></>} /></>;
	}

	return (
		<div className="skill-agent-editor">
			{chrome}
			<DocumentEditorShell
				content={body}
				onContentChange={setBody}
				editorRef={editorRef}
				readOnly={controlsReadOnly}
				toolbar={!controlsReadOnly ? <MarkdownToolbar onWrap={(left, right) => editorRef.current?.wrapSelection(left, right)} onPrefixLine={(prefix) => editorRef.current?.prefixLines(prefix)} /> : undefined}
				editorKey={`${skill}/${agent}`}
				mode={mode}
				onModeChange={setMode}
				dirty={dirty}
				onSave={() => {
					const identity = `${skill}/${agent}`;
					const expectedHash = hydratedRef.current?.identity === identity
						? hydratedRef.current.hash
						: query.data?.hash ?? "";
					save.mutate({
						skill,
						agent,
						expectedHash,
						draft: { description, body, claudeModel, codexModel, reasoningEffort },
					});
				}}
				saving={save.isPending}
				saveDisabled={readOnly}
				sidePanel={config}
					diffOriginal={query.data.body}
					splitStorageKey="skill-agent-editor-split"
				/>
			{guard.pending && <ConfirmDialog open title="Discard unsaved changes?" body="Your source agent draft has not been saved." confirmLabel="Discard changes" cancelLabel="Keep editing" onConfirm={guard.confirm} onClose={guard.cancel} />}
		</div>
	);
}
