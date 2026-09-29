import { useRef, type ReactNode } from "react";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/Button";
import { Chip, Chips } from "@/components/Chips";
import {
	CodeAreaEdit,
	CodeAreaPreview,
	type CodeAreaHandle,
} from "@/components/CodeArea";
import { AppliedSnippetsStrip } from "@/components/snippets/AppliedSnippetsStrip";
import type { SkillRefsView } from "@/hooks/useSkillRefs";
import { formatTokens } from "@/lib/estimateTokens";
import type {
	AgentDocFile,
	AgentDocInstructionSet,
	AgentDocMarkerIssue,
	AgentDocPolicyInfo,
} from "@/types/agentDocs";
import { relDirLabel } from "./agentDocHelpers";
import type { Buffer } from "@/components/AgentDocsView";
import { snippetMarkerLine } from "@/lib/snippetDiagnostics";

export interface AgentDocsEditorPaneProps {
	selected: string | null;
	selectedBuffer: Buffer | undefined;
	selectedDirty: boolean;
	externallyChanged: boolean;
	markerIssue: AgentDocMarkerIssue | null;
	editorMode: "edit" | "preview";
	onSetEditorMode: (mode: "edit" | "preview") => void;
	selectedFile: AgentDocFile | null;
	projectPath: string;
	selectedSet: AgentDocInstructionSet | null;
	onSelectFile: (rel: string) => void;
	loadingRel: string | null;
	showAllMarkdown: boolean;
	policy: AgentDocPolicyInfo | null;
	onEditBuf: (text: string) => void;
	projectName: string;
	onReloadSelectedSilently: () => void;
	selectedTokenCount: number;
	/** Skill cross-references for the live buffer — the CodeMirror decoration
	 *  extension and the Preview link renderer, threaded into every Edit and
	 *  Preview call site (the create-draft branch included). */
	refs: SkillRefsView;
	/** The `<SkillRefsSection layout="strip">` element for this buffer, built
	 *  by the caller (which also owns the registry). `null`/absent renders
	 *  nothing — the section itself decides that at zero mentions. */
	refsStrip: ReactNode;
}

/** The Agent Docs screen's right (editor) pane: the doc-head title + pills +
 *  Edit/Preview chip toggle, the instruction-set/external-change/symlink
 *  banners, the editor body (loading / symlink stub / derived-pointer stub /
 *  create-draft / edit / preview), the applied-snippets strip, and the
 *  footer status line. Extracted verbatim from AgentDocsView's `right=`
 *  ResizableSplit prop. */
export function AgentDocsEditorPane({
	selected,
	selectedBuffer,
	selectedDirty,
	externallyChanged,
	markerIssue,
	editorMode,
	onSetEditorMode,
	selectedFile,
	projectPath,
	selectedSet,
	onSelectFile,
	loadingRel,
	showAllMarkdown,
	policy,
	onEditBuf,
	projectName,
	onReloadSelectedSilently,
	selectedTokenCount,
	refs,
	refsStrip,
}: AgentDocsEditorPaneProps) {
	const editorRef = useRef<CodeAreaHandle>(null);
	const selectedMarkerIssue =
		markerIssue?.rel === selected ? markerIssue : null;
	const firstMarkerDiagnostic = selectedMarkerIssue?.diagnostics[0];

	function focusMarkerLine(line: number) {
		onSetEditorMode("edit");
		// eslint-disable-next-line no-restricted-syntax -- called from a click handler: React flushes the `onSetEditorMode` update synchronously before yielding, and a browser rAF always runs after that commit and before the next paint, so `editorRef` (mounted by this same state change when switching from preview) is already set by the time this runs.
		requestAnimationFrame(() => editorRef.current?.focusLine(line));
	}

	// Whether the body below actually renders a CodeAreaEdit/CodeAreaPreview
	// (as opposed to the loading message or one of the read-only stubs) — the
	// References strip shows whenever the buffer is editable/previewable, even
	// for a file (e.g. a fresh create-draft) that has no applied snippets yet.
	const showsEditor =
		loadingRel !== selected &&
		!(selectedFile?.is_symlink && !selectedFile.symlink_target_in_project) &&
		!(selected === "CLAUDE.md" && selectedBuffer?.isDerivedPointer);
	return (
		<section className="agent-docs-editor">
			{selected && selectedBuffer && (
				<>
					<div className="agent-docs-doc-head">
						<div className="ad-doc-title">
							<Icon name="doc" size={14} />
							<span className="ad-doc-name">{selected}</span>
							{selectedDirty && (
								<span
									className="ad-pill"
									style={{
										color: "var(--amber)",
										background:
											"color-mix(in oklab, var(--amber) 14%, transparent)",
										borderColor:
											"color-mix(in oklab, var(--amber) 40%, transparent)",
									}}
								>
									UNSAVED
								</span>
							)}
							{selectedBuffer.isNew && !selectedDirty && (
								<span
									className="ad-pill"
									style={{
										color: "var(--fg-dim)",
										background: "transparent",
										borderColor: "var(--border-strong)",
									}}
								>
									NEW · NOT YET ON DISK
								</span>
							)}
							{externallyChanged && (
								<span
									className="ad-pill"
									style={{
										color: "var(--amber)",
										background:
											"color-mix(in oklab, var(--amber) 14%, transparent)",
										borderColor:
											"color-mix(in oklab, var(--amber) 40%, transparent)",
									}}
								>
									CHANGED ON DISK
								</span>
							)}
							<div className="ad-doc-mode">
								<Chips>
									<Chip
										icon="view.edit"
										pressed={editorMode === "edit"}
										onClick={() => onSetEditorMode("edit")}
									>
										Edit
									</Chip>
									<Chip
										icon="view.preview"
										pressed={editorMode === "preview"}
										onClick={() => onSetEditorMode("preview")}
									>
										Preview
									</Chip>
								</Chips>
							</div>
						</div>
						<div className="ad-doc-path">
							<Icon name="folder" size={11} />
							<span>
								{selectedFile?.absolute_path ??
									`${projectPath}/${selected}`}
							</span>
						</div>
					</div>

					{selectedSet && (
						<div className="agent-docs-banner ad-banner-instruction-set">
							<Icon name="info" size={12} />
							<span>
								<strong>{selectedSet.label}</strong>{" "}
								<span className="text-mono">
									{relDirLabel(selectedSet.relative_dir)}
								</span>
								{" · editing "}
								<span className="text-mono">{selected}</span>
								{selectedSet.verdict === "conflict" &&
									selectedSet.formats.CLAUDE.title &&
									selectedSet.formats.AGENT.title && (
										<>
											{" "}
											· independent titles:{" "}
											<span className="text-mono">CLAUDE</span> “
											{selectedSet.formats.CLAUDE.title}” /{" "}
											<span className="text-mono">AGENT</span> “
											{selectedSet.formats.AGENT.title}”
										</>
									)}
							</span>
						</div>
					)}

					{externallyChanged && (
						<div className="agent-docs-banner">
							<Icon name="warning" size={12} />
							<span>
								This file changed on disk after it was loaded. Refresh to
								pull the new content, or save to keep editing and resolve at
								write time.
							</span>
						</div>
					)}

					{selectedMarkerIssue && (
						<div className="agent-docs-banner ad-banner-error">
							<Icon name="state.error" size={12} />
							<div className="ad-banner-copy">
								<strong>Cannot save this file.</strong>
								<span>
									{firstMarkerDiagnostic
										? `${snippetMarkerLine(firstMarkerDiagnostic)}. Repair this marker. Then save again.`
										: "Repair the damaged snippet marker. Then save again."}
									{selectedMarkerIssue.diagnostics.length > 1 &&
										` ${selectedMarkerIssue.diagnostics.length - 1} more marker problems remain.`}
									{" The draft is still in this editor."}
								</span>
							</div>
							{firstMarkerDiagnostic && (
								<Button
									size="sm"
									icon="arrow-right"
									onClick={() => focusMarkerLine(firstMarkerDiagnostic.line)}
								>
									Go to line {firstMarkerDiagnostic.line}
								</Button>
							)}
						</div>
					)}

					{selectedFile?.is_symlink &&
						selectedFile.symlink_target_in_project &&
						selected !== "CLAUDE.md" && (
							<div className="agent-docs-banner ad-banner-symlink">
								<Icon name="link" size={12} />
								<span>
									<strong>Symlink.</strong> {selectedFile.name} resolves to{" "}
									<span className="text-mono">
										{" "}
										{selectedFile.symlink_to ?? "unknown"}
									</span>
									. Editing happens on the source — open the target to make
									changes.
								</span>
								{selectedFile.symlink_to && (
									<Button
										size="sm"
										icon="arrow-right"
										onClick={() => {
											const target = selectedFile.symlink_to;
											if (!target) return;
											// Resolve in-project sibling: best effort
											const sibling = target.startsWith("/") ? null : target;
											if (sibling) onSelectFile(sibling);
										}}
									>
										Open source
									</Button>
								)}
							</div>
						)}

					<div className="agent-docs-editor-body">
						{loadingRel === selected ? (
							<div
								style={{
									flex: 1,
									padding: 24,
									color: "var(--fg-mute)",
									fontFamily: "var(--font-mono)",
									fontSize: 11.5,
								}}
							>
								Reading {selected} from disk…
							</div>
						) : selectedFile?.is_symlink &&
							!selectedFile.symlink_target_in_project ? (
							<div className="agent-docs-symlink-stub">
								<Icon name="link" size={28} />
								<h4>Symlink to {selectedFile.symlink_to ?? "unknown"}</h4>
								<p>
									This file is a symbolic link that points outside the
									project. Editing is disabled here.
								</p>
							</div>
						) : selected === "CLAUDE.md" &&
							selectedBuffer.isDerivedPointer ? (
							<div className="agent-docs-symlink-stub ad-derived-stub">
								<Icon name="link" size={28} />
								<h4>
									Derived from <span className="text-mono">AGENTS.md</span>
								</h4>
								<p>
									This <span className="text-mono">CLAUDE.md</span> is a
									hub-derived{" "}
									{selectedFile?.is_symlink ? "symlink" : "@AGENTS.md pointer"}
									. Edit{" "}
									<span className="text-mono">AGENTS.md</span> — this file
									follows automatically.
								</p>
								<Button
									size="sm"
									icon="arrow-right"
									onClick={() => onSelectFile("AGENTS.md")}
								>
									Open AGENTS.md
								</Button>
							</div>
						) : selectedBuffer.isNew ? (
							<div className="agent-docs-empty-create">
								<div className="ad-empty-row">
									<span className="ad-empty-icon">
										<Icon name="doc" size={18} />
									</span>
									<div>
										<h4>{selected} doesn't exist yet</h4>
										<p>
											Start typing to draft this file.{" "}
											<strong>Create</strong> writes it to{" "}
											<span className="text-mono">
												{selectedFile?.absolute_path ??
													`${projectPath}/${selected}`}
											</span>
											{!showAllMarkdown &&
											policy?.derived &&
											(selected === "CLAUDE.md" ||
												selected === "AGENTS.md") ? (
												<>
													{" "}
													— as the canonical{" "}
													<span className="text-mono">AGENTS.md</span> with
													a derived{" "}
													<span className="text-mono">CLAUDE.md</span> (
													{policy.strategy}).
												</>
											) : (
												"."
											)}
										</p>
									</div>
								</div>
								{editorMode === "preview" ? (
									<CodeAreaPreview
										content={selectedBuffer.content}
										skillRefs={refs.render}
									/>
								) : (
									<CodeAreaEdit
										ref={editorRef}
										content={selectedBuffer.content}
										onChange={onEditBuf}
										extraExtensions={refs.extension}
									/>
								)}
							</div>
						) : editorMode === "preview" ? (
							<CodeAreaPreview
								content={selectedBuffer.content}
								skillRefs={refs.render}
							/>
						) : (
							<CodeAreaEdit
								ref={editorRef}
								content={selectedBuffer.content}
								onChange={onEditBuf}
								extraExtensions={refs.extension}
							/>
						)}
					</div>

					{/* References sits directly above the applied-snippets strip —
					    the same strip grammar, but visible whenever the buffer is
					    editable/previewable (not gated on an existing, non-draft
					    file the way the snippets strip below is). */}
					{showsEditor && refsStrip}

					{/* Snippet blocks live at the end of the file, so the strip
					    sits below the freeform content it appends to. */}
					{selected &&
						!showAllMarkdown &&
						selectedFile?.exists &&
						!selectedFile.is_symlink &&
						!selectedBuffer.isDerivedPointer &&
						!selectedBuffer.isNew && (
							<AppliedSnippetsStrip
								projectName={projectName}
								rel={selected}
								dirty={selectedDirty}
								onMutate={onReloadSelectedSilently}
								onOpenLine={focusMarkerLine}
							/>
						)}

					<div className="editor-foot">
						<span>
							<Icon name="doc" size={10} /> markdown
						</span>
						<span title="Estimate based on the GPT-5 / o200k_base tokenizer. Claude/Gemini typically within ±10%.">
							{selectedBuffer.content.split("\n").length} lines ·{" "}
							{selectedBuffer.content.length} chars · ~
							{formatTokens(selectedTokenCount)} tokens
						</span>
						<span className="editor-foot-spacer" />
						<span>UTF-8 · LF</span>
						<span>
							{selectedBuffer.isNew
								? "unsaved draft"
								: selectedDirty
									? "in-memory buffer differs from disk"
									: "matches disk"}
						</span>
					</div>
				</>
			)}
		</section>
	);
}
