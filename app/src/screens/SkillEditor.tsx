import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useNavigate, useParams } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "@/components/Button";
import { LoadingButton } from "@/components/loading";
import { Icon } from "@/components/Icon";
import { Kbd } from "@/components/Kbd";
import { KindTag, SCOPE_META, scopeKey } from "@/components/Tag";
import { SourceChip } from "@/components/SourceChip";
import { ScreenHeader } from "@/components/ScreenHeader";
import { StatePill } from "@/components/StatePill";
import { SubheaderViewChips } from "@/components/SubheaderViewChips";
import { Field, MetaGrid } from "@/components/Field";
import { BundleChip } from "@/components/BundleChip";
import { EmptyState } from "@/components/EmptyState";
import {
	CodeAreaDiff,
	CodeAreaEdit,
	CodeAreaPreview,
} from "@/components/CodeArea";
import { bundleColor } from "@/components/bundleColors";
import { ResizableSplit } from "@/components/ResizableSplit";
import { useRegistry } from "@/hooks/useRegistry";
import { useToast } from "@/components/Toast";
import { queryClient } from "@/lib/queryClient";
import { trackProcess } from "@/lib/trackProcess";
import { resolveActiveSkills } from "@/lib/resolveActiveSkills";
import { ExternalSourceBanner } from "@/components/ExternalSourceBanner";
import { sourceForSkill, isExternalManaged } from "@/lib/skillSource";
import { estimateTokens, formatTokens } from "@/lib/estimateTokens";
import type { SkillScope } from "@/types";

type EditorMode = "edit" | "preview" | "diff";

interface SkillDocument {
	name: string;
	description: string;
	body: string;
}

const SLUG_RE = /^[a-z0-9-]+$/;

function getTextarea(): HTMLTextAreaElement | null {
	return document.querySelector(
		".code-area textarea",
	) as HTMLTextAreaElement | null;
}

export function SkillEditor() {
	const { name: routeName } = useParams<{ name: string }>();
	const navigate = useNavigate();
	const toast = useToast();
	const { data: registry } = useRegistry();

	const skill = routeName ? registry?.skills[routeName] : undefined;

	const [name, setName] = useState<string>(routeName ?? "");
	const [description, setDescription] = useState<string>("");
	const [scope, setScope] = useState<SkillScope>("global");
	const [version, setVersion] = useState<string>("");
	const [upstream, setUpstream] = useState<string>("");
	const [content, setContent] = useState<string>("");
	const [mode, setMode] = useState<EditorMode>("edit");
	const [dirty, setDirty] = useState<boolean>(false);
	const [saving, setSaving] = useState<boolean>(false);
	const [loading, setLoading] = useState<boolean>(true);

	const savedContentRef = useRef<string>("");

	// Hydrate metadata from registry when skill loads/changes
	useEffect(() => {
		if (!skill || !routeName) return;
		setName(routeName);
		setDescription(skill.description ?? "");
		setScope((skill.scope as SkillScope) ?? "global");
		setVersion(skill.version ?? "");
		setUpstream(skill.upstream ?? "");
	}, [skill, routeName]);

	// Load the SKILL.md body
	useEffect(() => {
		if (!routeName) return;
		setLoading(true);
		invoke<SkillDocument>("read_skill_document", { name: routeName })
			.then((doc) => {
				setContent(doc.body);
				savedContentRef.current = doc.body;
				// Prefer the doc's name/description (canonical from file)
				setName(doc.name || routeName);
				setDescription(doc.description ?? "");
				setDirty(false);
				setLoading(false);
			})
			.catch(() => {
				setContent("");
				savedContentRef.current = "";
				setLoading(false);
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
						},
					}),
				{
					successBody: `saved · ${canonicalName} v${version}`,
					retry: () => void save(),
				},
			);

			await queryClient.invalidateQueries({ queryKey: ["registry"] });
			savedContentRef.current = content;
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
		toast,
		navigate,
	]);

	// ⌘S to save
	useEffect(() => {
		function onKey(e: KeyboardEvent) {
			if ((e.metaKey || e.ctrlKey) && e.key === "s") {
				e.preventDefault();
				if (dirty) void save();
			}
		}
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [dirty, save]);

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

	// ─── Markdown toolbar helpers — operate on textarea selection ────────────
	const replaceSelection = useCallback(
		(transform: (selected: string) => {
			insert: string;
			selStart?: number;
			selEnd?: number;
		}) => {
			const ta = getTextarea();
			if (!ta) return;
			const from = ta.selectionStart;
			const to = ta.selectionEnd;
			const selected = content.slice(from, to);
			const { insert, selStart, selEnd } = transform(selected);
			const next = content.slice(0, from) + insert + content.slice(to);
			setContent(next);
			setDirty(true);
			requestAnimationFrame(() => {
				const t = getTextarea();
				if (!t) return;
				const a = selStart !== undefined ? from + selStart : from + insert.length;
				const b = selEnd !== undefined ? from + selEnd : a;
				t.focus();
				t.setSelectionRange(a, b);
			});
		},
		[content],
	);

	const wrap = useCallback(
		(left: string, right: string) => {
			replaceSelection((sel) => {
				const inner = sel || "";
				return {
					insert: `${left}${inner}${right}`,
					selStart: left.length,
					selEnd: left.length + inner.length,
				};
			});
		},
		[replaceSelection],
	);

	const prefixLine = useCallback(
		(prefix: string) => {
			replaceSelection((sel) => {
				if (!sel) {
					return {
						insert: prefix,
						selStart: prefix.length,
						selEnd: prefix.length,
					};
				}
				const out = sel
					.split("\n")
					.map((line) => `${prefix}${line}`)
					.join("\n");
				return { insert: out, selStart: 0, selEnd: out.length };
			});
		},
		[replaceSelection],
	);

	const bundlesForSkill = useMemo(() => {
		if (!registry || !routeName) return [] as string[];
		return Object.entries(registry.bundles)
			.filter(([, b]) => b.skills.includes(routeName))
			.map(([n]) => n);
	}, [registry, routeName]);

	const equipped = useMemo(() => {
		if (!registry || !routeName) {
			return { rows: [] as Array<{
				project: string;
				state: "true" | "bundle" | "false";
				label: string;
			}>, equippedCount: 0, total: 0 };
		}
		const projects = Object.entries(registry.projects);
		const rows = projects.map(([projName, proj]) => {
			const directOn = (proj.enabled ?? []).includes(routeName);
			const viaBundle =
				!directOn &&
				resolveActiveSkills(proj, registry).includes(routeName);
			const state: "true" | "bundle" | "false" = directOn
				? "true"
				: viaBundle
					? "bundle"
					: "false";
			const label =
				state === "true" ? "EQUIPPED" : state === "bundle" ? "VIA BUNDLE" : "OFF";
			return { project: projName, state, label };
		});
		const equippedCount = rows.filter((r) => r.state !== "false").length;
		return { rows, equippedCount, total: projects.length };
	}, [registry, routeName]);

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
					dirty ? (
						<StatePill state="unsaved">UNSAVED</StatePill>
					) : readOnly ? (
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
					) : (
						<LoadingButton
							variant="primary"
							icon="save"
							kbd="⌘S"
							onClick={() => void save()}
							disabled={!dirty}
							loading={saving}
							loadingLabel="Saving…"
						>
							{dirty ? "Save" : "Saved"}
						</LoadingButton>
					)
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
				subheader={{
					left: (
						<SubheaderViewChips<EditorMode>
							views={[
								{ id: "edit", label: "Edit", icon: "view.edit" },
								{ id: "preview", label: "Preview", icon: "view.preview" },
								{ id: "diff", label: "Diff", icon: "view.diff" },
							]}
							value={mode}
							onChange={setMode}
						/>
					),
					right: (
						<>
							<span className="text-mono text-dim">
								{content.split("\n").length} lines · {content.length} chars
							</span>
							<Kbd>⌘P</Kbd>
						</>
					),
				}}
			/>

			<ResizableSplit
				className="editor-grid"
				fixedPane="right"
				storageKey="st:layout:skill-editor"
				defaultRightPx={360}
				minRightPx={280}
				maxRightPx={560}
				handleAriaLabel="Resize side panel"
				left={
				<div className="editor-main">
					{readOnly && routeName && (
						<ExternalSourceBanner
							skillName={routeName}
							skill={skill}
							source={ownerSource}
							onDuplicated={(newName) => navigate(`/skill/${encodeURIComponent(newName)}`)}
						/>
					)}
					<MetaGrid>
						<Field label="name">
							<input
								value={name}
								onChange={(e) => markDirty(setName)(e.target.value)}
								readOnly={readOnly}
							/>
						</Field>
						<Field label="scope">
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
						<Field label="version">
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
								onChange={(e) =>
									markDirty(setDescription)(e.target.value)
								}
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
						<span className="stretch" />
						<span className="right">
							<Kbd>⌘P</Kbd>
						</span>
					</div>

					{loading ? (
						<div
							className="code-area"
							style={{
								display: "flex",
								alignItems: "center",
								justifyContent: "center",
								color: "var(--fg-mute)",
								fontSize: 13,
								minHeight: 240,
							}}
						>
							Loading SKILL.md…
						</div>
					) : (
						<>
							{mode === "edit" && (
								<CodeAreaEdit
									content={content}
									onChange={readOnly ? () => {} : markDirty(setContent)}
									readOnly={readOnly}
								/>
							)}
							{mode === "preview" && <CodeAreaPreview content={content} />}
							{mode === "diff" && (
								<CodeAreaDiff
									original={savedContentRef.current}
									current={content}
								/>
							)}
						</>
					)}

					<div className="editor-foot">
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
					</div>
				</div>
				}
				right={
				<div className="editor-side">
					<div className="side-panel-block">
						<h4>Status</h4>
						<div className="kv-list">
							<div className="kv-row">
								<span className="k">scope</span>
								<span className="v" style={{ color: "var(--cyan)" }}>
									{scope}
								</span>
							</div>
							<div className="kv-row">
								<span className="k">version</span>
								<span className="v">{version || "—"}</span>
							</div>
							<div className="kv-row">
								<span className="k">upstream</span>
								<span className="v text-dim">{upstream || "none"}</span>
							</div>
							<div className="kv-row">
								<span className="k">touched</span>
								<span className="v text-dim">—</span>
							</div>
							<div className="kv-row">
								<span className="k">created</span>
								<span className="v text-dim">—</span>
							</div>
						</div>
					</div>

					<div className="side-panel-block">
						<h4>
							In bundles{" "}
							<span style={{ color: "var(--fg-dim)" }}>
								· {bundlesForSkill.length}
							</span>
						</h4>
						<div
							style={{ display: "flex", flexWrap: "wrap", gap: 6 }}
						>
							{bundlesForSkill.length === 0 ? (
								<span
									className="text-dim text-mono"
									style={{ fontSize: 11 }}
								>
									not in any bundle
								</span>
							) : (
								bundlesForSkill.map((bn) => {
									const b = registry.bundles[bn];
									return (
										<BundleChip
											key={bn}
											name={bn}
											icon={b?.icon ?? "📦"}
											color={bundleColor(bn)}
											style={{ margin: 0 }}
											onClick={() =>
												navigate(
													`/bundle/${encodeURIComponent(bn)}`,
												)
											}
										/>
									);
								})
							)}
						</div>
					</div>

					<div className="side-panel-block">
						<h4>
							Equipped on{" "}
							<span style={{ color: "var(--fg-dim)" }}>
								· {equipped.equippedCount} / {equipped.total}
							</span>
						</h4>
						<div
							style={{
								display: "flex",
								flexDirection: "column",
								gap: 2,
							}}
						>
							{equipped.rows.length === 0 ? (
								<span
									className="text-dim text-mono"
									style={{ fontSize: 11 }}
								>
									no projects
								</span>
							) : (
								equipped.rows.map((r) => (
									<div key={r.project} className="equip-row">
										<span className="name">{r.project}</span>
										<span className="state" data-on={r.state}>
											{r.label}
										</span>
									</div>
								))
							)}
						</div>
					</div>

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
				</div>
				}
			/>
		</>
	);
}
