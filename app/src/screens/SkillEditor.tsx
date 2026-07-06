import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useNavigate, useParams } from "react-router-dom";
import { invoke } from "@/lib/ipc";
import { Button } from "@/components/Button";
import { Icon } from "@/components/Icon";
import {
	KindTag,
	SCOPE_META,
	SCOPE_INTENT_NOTE,
	SCOPE_REACH,
	scopeKey,
} from "@/components/Tag";
import { SourceChip } from "@/components/SourceChip";
import { ScreenHeader } from "@/components/ScreenHeader";
import { StatePill } from "@/components/StatePill";
import { Field, MetaGrid } from "@/components/Field";
import { EmptyState } from "@/components/EmptyState";
import { type CodeAreaHandle } from "@/components/CodeArea";
import {
	DocumentEditorShell,
	type DocMode,
} from "@/components/DocumentEditorShell";
import { ConnectionsPanel } from "@/components/ConnectionsPanel";
import { TriggeringPicker } from "@/components/TriggeringPicker";
import {
	INVOCATION_EXTERNAL_REASON,
	INVOCATION_MCP_REASON,
	type InvocationMode,
} from "@/lib/invocation";
import { useRegistry } from "@/hooks/useRegistry";
import { useHarnesses } from "@/hooks/useHarnesses";
import { useToast } from "@/components/Toast";
import { queryClient } from "@/lib/queryClient";
import { trackProcess } from "@/lib/trackProcess";
import { ExternalSourceBanner } from "@/components/ExternalSourceBanner";
import { sourceForSkill, isExternalManaged } from "@/lib/skillSource";
import { estimateTokens, formatTokens } from "@/lib/estimateTokens";
import { composeSkillDocument } from "@/lib/composeSkillDocument";
import type { SkillScope } from "@/types";

interface SkillDocument {
	name: string;
	description: string;
	body: string;
}

const SLUG_RE = /^[a-z0-9-]+$/;

export function SkillEditor() {
	const { name: routeName } = useParams<{ name: string }>();
	const navigate = useNavigate();
	const toast = useToast();
	const { data: registry } = useRegistry();
	const harnesses = useHarnesses();
	const installedHarnesses = useMemo(
		() => harnesses.filter((h) => h.installed).map((h) => h.id),
		[harnesses],
	);

	const skill = routeName ? registry?.skills[routeName] : undefined;

	const [name, setName] = useState<string>(routeName ?? "");
	const [description, setDescription] = useState<string>("");
	const [scope, setScope] = useState<SkillScope>("global");
	const [version, setVersion] = useState<string>("");
	const [upstream, setUpstream] = useState<string>("");
	const [affinity, setAffinity] = useState<string[]>([]);
	const [content, setContent] = useState<string>("");
	const [mode, setMode] = useState<DocMode>("edit");
	const [dirty, setDirty] = useState<boolean>(false);
	const [saving, setSaving] = useState<boolean>(false);
	const [invocationBusy, setInvocationBusy] = useState<boolean>(false);

	const savedContentRef = useRef<string>("");
	// Saved metadata snapshot, so the frontmatter-aware diff shows metadata edits.
	const savedNameRef = useRef<string>("");
	const savedDescRef = useRef<string>("");
	const editorRef = useRef<CodeAreaHandle>(null);

	// Hydrate metadata from registry when skill loads/changes
	useEffect(() => {
		if (!skill || !routeName) return;
		setName(routeName);
		setDescription(skill.description ?? "");
		setScope((skill.scope as SkillScope) ?? "global");
		setVersion(skill.version ?? "");
		setUpstream(skill.upstream ?? "");
		setAffinity(skill.harnesses ?? []);
	}, [skill, routeName]);

	// Load the SKILL.md body
	useEffect(() => {
		if (!routeName) return;
		invoke<SkillDocument>("read_skill_document", { name: routeName })
			.then((doc) => {
				setContent(doc.body);
				savedContentRef.current = doc.body;
				// Prefer the doc's name/description (canonical from file)
				setName(doc.name || routeName);
				setDescription(doc.description ?? "");
				savedNameRef.current = doc.name || routeName;
				savedDescRef.current = doc.description ?? "";
				setDirty(false);
			})
			.catch(() => {
				setContent("");
				savedContentRef.current = "";
				savedNameRef.current = routeName;
				savedDescRef.current = "";
			});
	}, [routeName]);

	const markDirty = useCallback(
		<T,>(setter: (v: T) => void) =>
			(v: T) => {
				setter(v);
				setDirty(true);
			},
		[],
	);

	const save = useCallback(async () => {
		if (!routeName || saving) return;
		const canonicalName = name.trim();
		if (!SLUG_RE.test(canonicalName)) {
			toast.error(
				"Skill name must use lowercase letters, numbers, and hyphens",
			);
			return;
		}
		setSaving(true);
		try {
			const updatedName = await trackProcess(
				{
					title: `Saving ${canonicalName}`,
					body: "writing SKILL.md",
					kind: "fs",
				},
				() =>
					invoke<string>("save_skill_full", {
						name: routeName,
						document: {
							name: canonicalName,
							description,
							body: content,
						},
						meta: {
							version,
							description,
							scope,
							upstream,
							harnesses: affinity.join(","),
						},
					}),
				{
					successBody: `saved · ${canonicalName} v${version}`,
					retry: () => void save(),
				},
			);

			await queryClient.invalidateQueries({ queryKey: ["registry"] });
			savedContentRef.current = content;
			savedNameRef.current = canonicalName;
			savedDescRef.current = description;
			setDirty(false);
			if (updatedName && updatedName !== routeName) {
				navigate(`/skill/${encodeURIComponent(updatedName)}`, {
					replace: true,
				});
			}
		} catch {
			/* error surfaced on the process card */
		} finally {
			setSaving(false);
		}
	}, [
		routeName,
		saving,
		name,
		description,
		content,
		version,
		scope,
		upstream,
		affinity,
		toast,
		navigate,
	]);

	const archive = useCallback(async () => {
		if (!routeName) return;
		try {
			const result = await invoke<{ success: boolean; output: string }>(
				"hub_cmd",
				{ args: ["archive", routeName] },
			);
			if (!result.success) throw new Error(result.output);
			await queryClient.invalidateQueries({ queryKey: ["registry"] });
			toast.success(`Archived "${routeName}"`);
			navigate("/");
		} catch (err) {
			toast.error(String(err));
		}
	}, [routeName, toast, navigate]);

	const duplicateAsLocal = useCallback(async () => {
		if (!routeName) return;
		const newName = `${routeName}-local`;
		try {
			const result = await invoke<{ success: boolean; output: string }>(
				"hub_cmd",
				{ args: ["source", "duplicate", routeName, "--as", newName, "--json"] },
			);
			if (!result.success) throw new Error(result.output);
			await queryClient.invalidateQueries({ queryKey: ["registry"] });
			toast.success(`Duplicated to "${newName}"`);
			navigate(`/skill/${encodeURIComponent(newName)}`);
		} catch (err) {
			toast.error(`Duplicate failed: ${String(err)}`);
		}
	}, [routeName, toast, navigate]);

	const setInvocation = useCallback(
		async (mode: InvocationMode) => {
			if (!routeName || invocationBusy) return;
			setInvocationBusy(true);
			try {
				const result = await invoke<{ success: boolean; output: string }>(
					"hub_cmd",
					{ args: ["set-meta", routeName, "--invocation", mode] },
				);
				if (!result.success) throw new Error(result.output);
				await queryClient.invalidateQueries({ queryKey: ["registry"] });
			} catch (err) {
				toast.error("Failed to set triggering", String(err));
			} finally {
				setInvocationBusy(false);
			}
		},
		[routeName, invocationBusy, toast],
	);

	// ─── Markdown toolbar helpers — drive the CodeMirror editor ──────────────
	// Content/dirty flow through the editor's normal onChange.
	const wrap = useCallback((left: string, right: string) => {
		editorRef.current?.wrapSelection(left, right);
	}, []);

	const prefixLine = useCallback((prefix: string) => {
		editorRef.current?.prefixLines(prefix);
	}, []);

	const descTokens = useMemo(
		() => estimateTokens(description),
		[description],
	);
	const bodyTokens = useMemo(() => estimateTokens(content), [content]);
	const totalTokens = useMemo(() => {
		// Mirror what build_skill_document writes to disk (registry.rs):
		//   ---\nname: <name>\ndescription: |\n  <indented>\n---\n\n<body>\n
		const indented = description.trim()
			? description
					.trimEnd()
					.split("\n")
					.map((line) => (line === "" ? "  " : `  ${line}`))
					.join("\n")
			: "  ";
		const fm = `---\nname: ${name.trim()}\ndescription: |\n${indented}\n---\n\n`;
		return estimateTokens(fm + content.trimEnd() + "\n");
	}, [name, description, content]);

	if (!registry) {
		return (
			<div
				style={{
					display: "flex",
					alignItems: "center",
					justifyContent: "center",
					height: "100%",
					color: "var(--fg-mute)",
					fontSize: 13,
				}}
			>
				Loading…
			</div>
		);
	}

	if (!skill) {
		return (
			<EmptyState
				icon="warning"
				title="Skill not found"
				description={`No skill named ${routeName}`}
				action={
					<Button onClick={() => navigate("/")}>Back to library</Button>
				}
			/>
		);
	}

	const copyPath = () => {
		if (skill.source) void navigator.clipboard.writeText(skill.source);
	};

	const readOnly = isExternalManaged(skill);
	const ownerSource = sourceForSkill(routeName ?? "", registry);

	return (
		<>
			<ScreenHeader
				back={{ label: "Library", onClick: () => navigate("/") }}
				nameMono={name}
				meta={
					<>
						<span className="scope-glyph" data-scope={scopeKey(scope)}>
							{SCOPE_META[scopeKey(scope)].short}
						</span>
						<KindTag kind={skill.type} />
						{ownerSource && <SourceChip source={ownerSource} compact />}
					</>
				}
				state={
					readOnly ? (
						<StatePill state="readonly" icon="link">
							READ-ONLY
						</StatePill>
					) : null
				}
				crumbs={["library", scope, name]}
				primary={
					readOnly ? (
						<Button
							variant="primary"
							icon="copy"
							onClick={() => void duplicateAsLocal()}
						>
							Duplicate as local
						</Button>
					) : undefined
				}
				overflow={
					readOnly
						? [
								{
									icon: "link",
									label: "Copy upstream URL",
									disabled: !upstream,
									onClick: () => {
										if (upstream) void navigator.clipboard.writeText(upstream);
									},
								},
								{
									icon: "refresh",
									label: "Check source for updates",
									disabled: !ownerSource || ownerSource.type !== "git",
									onClick: () => {
										if (ownerSource)
											void invoke("hub_cmd", {
												args: ["source", "check", ownerSource.id, "--json"],
											}).then(() =>
												queryClient.invalidateQueries({
													queryKey: ["registry"],
												}),
											);
									},
								},
							]
						: [
								{ icon: "copy", label: "Duplicate", onClick: () => void duplicateAsLocal() },
								{ icon: "link", label: "Copy path", onClick: copyPath },
								{ divider: true },
								{
									icon: "archive",
									label: "Archive",
									danger: true,
									onClick: () => void archive(),
								},
							]
				}
			/>

			<DocumentEditorShell
				content={content}
				onContentChange={readOnly ? () => {} : markDirty(setContent)}
				readOnly={readOnly}
				editorRef={editorRef}
				mode={mode}
				onModeChange={setMode}
				diffOriginal={composeSkillDocument(
					{ name: savedNameRef.current, description: savedDescRef.current },
					savedContentRef.current,
				)}
				diffCurrent={composeSkillDocument({ name, description }, content)}
				dirty={dirty}
				onSave={() => void save()}
				saveDisabled={saving}
				saving={saving}
				splitStorageKey="st:layout:skill-editor"
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
								title="Heading 1"
								onMouseDown={(e) => e.preventDefault()}
								onClick={() => prefixLine("# ")}
							>
								<Icon name="md.h1" size={12} />
							</button>
							<button
								type="button"
								className="btn btn-sm"
								title="Heading 2"
								onMouseDown={(e) => e.preventDefault()}
								onClick={() => prefixLine("## ")}
							>
								<Icon name="md.h2" size={12} />
							</button>
							<button
								type="button"
								className="btn btn-sm"
								title="Bullet list"
								onMouseDown={(e) => e.preventDefault()}
								onClick={() => prefixLine("- ")}
							>
								<Icon name="md.list" size={12} />
							</button>
							<button
								type="button"
								className="btn btn-sm"
								title="Numbered list"
								onMouseDown={(e) => e.preventDefault()}
								onClick={() => prefixLine("1. ")}
							>
								1.
							</button>
							<button
								type="button"
								className="btn btn-sm"
								title="Quote"
								onMouseDown={(e) => e.preventDefault()}
								onClick={() => prefixLine("> ")}
							>
								<Icon name="md.quote" size={12} />
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
							<button
								type="button"
								className="btn btn-sm"
								title="Link"
								onMouseDown={(e) => e.preventDefault()}
								onClick={() => wrap("[", "](url)")}
							>
								<Icon name="link" size={11} />
							</button>
						</div>
					</div>
				}
				footerExtras={
					<>
						<span>
							<Icon name="doc" size={10} /> SKILL.md
						</span>
						<span>
							{content.split("\n").length} lines · {content.length} chars
						</span>
						<span className="editor-foot-spacer" />
						<span title="GPT-5 / o200k_base estimate. Claude/Gemini typically within ±10%.">
							desc ~{formatTokens(descTokens)} · body ~
							{formatTokens(bodyTokens)} · total ~
							{formatTokens(totalTokens)} tokens
						</span>
					</>
				}
				sidePanel={
					<>
						{readOnly && routeName && (
							<ExternalSourceBanner
								skillName={routeName}
								skill={skill}
								source={ownerSource}
								onDuplicated={(newName) =>
									navigate(`/skill/${encodeURIComponent(newName)}`)
								}
							/>
						)}
						<div className="side-panel-block">
							<h4>Metadata</h4>
							<MetaGrid>
								<Field label="name" full>
									<input
										value={name}
										onChange={(e) => markDirty(setName)(e.target.value)}
										readOnly={readOnly}
									/>
								</Field>
								<Field
									label="scope"
									full
									hint={
										<>
											{SCOPE_REACH[scopeKey(scope)]}
											{scopeKey(scope) !== "global" &&
												` · ${SCOPE_INTENT_NOTE}`}
										</>
									}
								>
									<select
										value={scope}
										onChange={(e) =>
											markDirty(setScope)(e.target.value as SkillScope)
										}
										disabled={readOnly}
									>
										<option value="global">global</option>
										<option value="portable">portable</option>
										<option value="project-specific">project-specific</option>
									</select>
								</Field>
								<Field label="version" full>
									<input
										value={version}
										onChange={(e) => markDirty(setVersion)(e.target.value)}
										readOnly={readOnly}
									/>
								</Field>
								<Field label="description" full>
									<textarea
										rows={3}
										value={description}
										onChange={(e) => markDirty(setDescription)(e.target.value)}
										readOnly={readOnly}
									/>
								</Field>
								<Field label="upstream" full>
									<input
										value={upstream}
										onChange={(e) => markDirty(setUpstream)(e.target.value)}
										placeholder="https://github.com/org/repo/blob/main/skills/..."
										readOnly={readOnly}
									/>
								</Field>
							</MetaGrid>
						</div>

						<TriggeringPicker
							invocation={skill.invocation}
							onPick={(mode) => void setInvocation(mode)}
							disabled={readOnly || skill.type === "mcp-server"}
							disabledReason={
								skill.type === "mcp-server"
									? INVOCATION_MCP_REASON
									: INVOCATION_EXTERNAL_REASON
							}
							busy={invocationBusy}
						/>

						{routeName && (
							<ConnectionsPanel
								skillName={routeName}
								registry={registry}
								ownerSource={ownerSource}
								installedHarnesses={installedHarnesses}
								affinity={affinity}
								onAffinityChange={(next) => {
									setAffinity(next);
									setDirty(true);
								}}
							/>
						)}
					</>
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
							Archive hides this skill from selection and removes it from all
							bundles. Sync will deactivate it everywhere.
						</div>
						<div className="actions">
							<Button
								variant="danger"
								icon="archive"
								onClick={() => void archive()}
							>
								Archive this skill
							</Button>
						</div>
					</div>
				}
			/>
		</>
	);
}
