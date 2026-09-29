import {
	useEffect,
	useRef,
	useState,
	type ReactNode,
	type Ref,
} from "react";
import type { Extension } from "@codemirror/state";
import { useSaveShortcut } from "@/hooks/useSaveShortcut";
import { Button } from "./Button";
import { SubheaderViewChips } from "./SubheaderViewChips";
import { Toggle } from "./Toggle";
import { ResizableSplit } from "./ResizableSplit";
import {
	CodeAreaDiff,
	CodeAreaEdit,
	CodeAreaPreview,
	type CodeAreaHandle,
	type CodeLanguage,
} from "./CodeArea";
import type { SkillRefRenderOptions } from "@/lib/skillRefs";

export type DocMode = "edit" | "preview" | "diff" | "split";

/** Severity of an attention state living inside the Details side panel. */
export type DetailsAttentionLevel = "error" | "warning";

/**
 * Attention signal for the Details side panel. When the panel is collapsed to
 * its vertical reopen tab at narrow widths, a blocking/attention state it holds
 * (validation error, drift banner, provision prompt) would otherwise be hidden.
 * Passing this renders a red/amber dot on the collapsed tab (mirroring the
 * always-visible unsaved dot on Save) so the state stays discoverable.
 */
export interface DetailsAttention {
	level: DetailsAttentionLevel;
	/** Optional count of attention items (announced to assistive tech). */
	count?: number;
	/** Optional accessible label; a generic one is used when omitted. */
	label?: string;
}

/** Split is offered only when the editor pane is at least this wide (--bp-nav). */
const BP_NAV = 680;

const MODE_CHIPS: Record<DocMode, { label: string; icon: string }> = {
	edit: { label: "Edit", icon: "view.edit" },
	preview: { label: "Preview", icon: "view.preview" },
	diff: { label: "Diff", icon: "view.diff" },
	split: { label: "Split", icon: "view.split" },
};

export interface DocumentEditorShellProps {
	// ── document (the editable text) ──
	content: string;
	onContentChange: (v: string) => void;
	readOnly?: boolean;
	editorRef?: Ref<CodeAreaHandle>;
	/** Grammar for the open document (default "markdown"). */
	language?: CodeLanguage;
	/** Identity of the open document. Changing it REMOUNTS the CodeMirror view,
	 *  so undo history never carries across documents (B3-11: ⌘Z used to bleed
	 *  the previous skill's body in; a multi-file editor has the same exposure
	 *  per sibling file). The caret resets — that is the accepted trade. */
	editorKey?: string;
	/** Replaces the editable body entirely — for a row that has no document to
	 *  edit (a binary asset, a file that vanished on disk). While set, the mode
	 *  chips, the markdown toolbar and the wrap toggle are all suppressed and no
	 *  CodeMirror instance is mounted. */
	bodyOverride?: ReactNode;
	/** Extra CodeMirror extensions forwarded to the Edit-mode `CodeAreaEdit`
	 *  (e.g. the skill-reference decoration bundle). Optional, default `[]` —
	 *  every consumer but the skill editor is unaffected. */
	extraExtensions?: Extension;

	// ── mode ──
	mode: DocMode;
	onModeChange: (m: DocMode) => void;
	/** Modes to offer; default ["edit","preview","diff","split"].
      "split" is auto-suppressed below --bp-nav regardless. */
	modes?: DocMode[];

	// ── preview / diff sources (default to `content`) ──
	previewSource?: string;
	diffOriginal: string;
	diffCurrent?: string;
	/** How a rendered preview link opens; default openUrl via plugin-opener. */
	onOpenLink?: (href: string) => void;
	/** Turns a resolvable skill-name mention into a clickable Preview link
	 *  with a hover card. Optional, absent by default. */
	skillRefs?: SkillRefRenderOptions;

	// ── save affordance ──
	dirty: boolean;
	onSave: () => void;
	saveDisabled?: boolean;
	/** While true the Save button shows a leading spinner + "Saving…" and the
	 *  `⌘S` shortcut is inert (the write is already in flight). */
	saving?: boolean;
	/** Label for the save button in its idle (non-dirty) state. Default "Saved". */
	savedLabel?: string;
	/** Label for the save button in its dirty (unsaved) state. Default "Save". */
	saveLabel?: string;
	/** Label for the save button while `saving`. Default "Saving…". */
	savingLabel?: string;

	// ── slots (each screen's uniqueness) ──
	/** Actions rendered in the bar's right cluster, BEFORE the Save button —
	 *  document-level verbs that belong next to Save (e.g. Export). */
	headerActions?: ReactNode;
	/** Formatting verbs (e.g. `MarkdownToolbar`). Rendered INLINE at the head of
	 *  the bar's left cluster — not as a strip above the body — and only while
	 *  the mode is edit/split and the document is editable. The mode chips sit
	 *  in the right cluster, ahead of `headerActions` and Save. */
	toolbar?: ReactNode;
	sidePanel?: ReactNode;
	dangerZone?: ReactNode;
	headerExtras?: ReactNode;
	footerExtras?: ReactNode;
	/** Attention state inside the Details panel; renders a dot on the collapsed
	 *  reopen tab so blocking states aren't hidden when the panel is collapsed. */
	detailsAttention?: DetailsAttention | null;

	/** ResizableSplit storageKey for the editor|side-panel split. */
	splitStorageKey: string;
	softWrapDefault?: boolean;
}

/**
 * The shared editor shell (D5). Owns the mode chips, the `⌘S` Save affordance
 * (which carries the unsaved state as a dot on the button itself), the
 * editor|side-panel resizable split, the soft-wrap footer, and the split-mode
 * width gate. Each screen threads its uniqueness through slots —
 * the shell never sees guided/raw or master-detail state.
 */
export function DocumentEditorShell({
	content,
	onContentChange,
	readOnly,
	editorRef,
	language,
	editorKey,
	bodyOverride,
	extraExtensions,
	mode,
	onModeChange,
	modes = ["edit", "preview", "diff", "split"],
	previewSource,
	diffOriginal,
	diffCurrent,
	onOpenLink,
	skillRefs,
	dirty,
	onSave,
	saveDisabled,
	saving,
	savedLabel = "Saved",
	saveLabel = "Save",
	savingLabel = "Saving…",
	headerActions,
	toolbar,
	sidePanel,
	dangerZone,
	headerExtras,
	footerExtras,
	detailsAttention,
	splitStorageKey,
	softWrapDefault = true,
}: DocumentEditorShellProps) {
	const [softWrap, setSoftWrap] = useState(softWrapDefault);

	// Measure the editor pane width to gate `split` (≥ --bp-nav).
	const paneRef = useRef<HTMLDivElement | null>(null);
	const [wide, setWide] = useState(false);
	useEffect(() => {
		const el = paneRef.current;
		if (!el || typeof ResizeObserver === "undefined") return;
		const measure = (w: number) => setWide(w >= BP_NAV);
		const ro = new ResizeObserver((entries) => {
			for (const e of entries) measure(e.contentRect.width);
		});
		ro.observe(el);
		measure(el.getBoundingClientRect().width);
		return () => ro.disconnect();
	}, []);

	const splitAvailable = wide && modes.includes("split");

	// Fall back to edit whenever the current mode isn't one the caller is
	// offering — a narrowed pane dropping `split`, or a non-markdown file
	// (`SkillEditor.tsx`'s scripts/binary branch) dropping `preview` out from
	// under a mode `useDefaultPreviewMode` had already set. `modeKey`, not
	// `modes`, is the dep: the caller passes a fresh array literal every
	// render, which would fire this on every render otherwise.
	const modeKey = modes.join("|");
	useEffect(() => {
		if (!modes.includes(mode) || (mode === "split" && !splitAvailable)) {
			onModeChange("edit");
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps -- `modeKey` stands in for `modes` (see comment above).
	}, [mode, modeKey, splitAvailable, onModeChange]);

	// Own the ⌘S listener so consumers stop hand-rolling it — `useSaveShortcut`
	// is the one shared contract; this shell is its only consumer today.
	useSaveShortcut(onSave, dirty, saving, saveDisabled);

	const chipViews = bodyOverride
		? []
		: modes
				.filter((m) => m !== "split" || splitAvailable)
				.map((m) => ({
					id: m,
					label: MODE_CHIPS[m].label,
					icon: MODE_CHIPS[m].icon,
				}));

	const editPane = (
		<CodeAreaEdit
			key={editorKey}
			ref={editorRef}
			content={content}
			onChange={onContentChange}
			readOnly={readOnly}
			softWrap={softWrap}
			language={language}
			extraExtensions={extraExtensions}
		/>
	);
	const previewPane = (
		<CodeAreaPreview
			content={previewSource ?? content}
			onOpenLink={onOpenLink}
			skillRefs={skillRefs}
		/>
	);
	const diffPane = (
		<CodeAreaDiff original={diffOriginal} current={diffCurrent ?? content} />
	);

	// The toolbar leads the bar's left cluster, in edit/split modes only.
	const showToolbar =
		!!toolbar && !readOnly && !bodyOverride && (mode === "edit" || mode === "split");
	// Soft-wrap only affects the CodeMirror editor → offer it in edit/split.
	const showWrapToggle = !bodyOverride && (mode === "edit" || mode === "split");

	let body: ReactNode;
	if (bodyOverride) body = bodyOverride;
	else if (mode === "preview") body = previewPane;
	else if (mode === "diff") body = diffPane;
	else if (mode === "split")
		body = (
			<ResizableSplit
				className="doc-editor-split"
				fixedPane="left"
				storageKey="editor-split"
				defaultLeftPx={480}
				minLeftPx={320}
				maxLeftPx={1000}
				collapsible={false}
				handleAriaLabel="Resize editor / preview"
				left={editPane}
				right={previewPane}
			/>
		);
	else body = editPane;

	return (
		<div
			className="doc-editor-shell"
			data-details-attention={detailsAttention?.level}
		>
			{detailsAttention && (
				<span className="sr-only" role="status" aria-live="polite">
					{detailsAttention.label ??
						`Details panel needs attention${
							detailsAttention.count ? ` (${detailsAttention.count})` : ""
						}`}
				</span>
			)}
			<ResizableSplit
				className="editor-grid"
				fixedPane="right"
				storageKey={splitStorageKey}
				defaultRightPx={332}
				minRightPx={280}
				maxRightPx={560}
				paneLabel="Details"
				handleAriaLabel="Resize side panel"
				// The editor column: bar + body + foot. The side panel is the split's
				// OTHER pane, so it runs from the header down and the bar spans only
				// the text it acts on. `.doc-editor-pane` is an inline-size container:
				// below ~880px the unselected mode chips drop their labels (editor.css).
				left={
					<div className="doc-editor-pane">
					<div className="doc-editor-bar">
						{/* Left cluster, anchored at the gutter: the formatting verbs (edit/
						    split only — they act on the caret; the band keeps its height
						    either way so switching to Preview does not jump the body), then
						    the document identity / status that `headerExtras` carries. */}
						<div className="doc-editor-bar-left">
							{showToolbar && toolbar}
							{headerExtras}
						</div>
						{/* Right cluster: the mode chips beside the document verbs and Save.
						    `bodyOverride` (binary/missing file) has no modes to switch between
						    — an empty `.chips` strip still renders its own padding + border
						    with nothing inside, showing as a stray dot. Omit it entirely. */}
						<div className="doc-editor-bar-right">
							{chipViews.length > 0 && (
								<SubheaderViewChips<DocMode>
									views={chipViews}
									value={mode}
									onChange={onModeChange}
								/>
							)}
							{headerActions}
							{(!readOnly || saving) && (
								<Button
									variant="primary"
									icon="save"
									kbd="⌘S"
									busy={saving}
									// The unsaved state rides ON the Save button (macOS dot) instead
									// of a separate UNSAVED pill — one affordance, one place to look,
									// and the freed slot goes to headerActions.
									signal={dirty && !saving ? "dot" : undefined}
									title={dirty && !saving ? "Unsaved changes" : undefined}
									disabled={!dirty || saveDisabled}
									onClick={onSave}
								>
									{saving ? savingLabel : dirty ? saveLabel : savedLabel}
								</Button>
							)}
						</div>
					</div>
						<div className="editor-main" ref={paneRef}>
								<div className="doc-editor-body">{body}</div>
								{(showWrapToggle || footerExtras) && (
									<div className="editor-foot doc-editor-foot">
										{showWrapToggle && (
											<Toggle
												variant="switch"
												size="sm"
												checked={softWrap}
												onChange={setSoftWrap}
												label={<span className="doc-editor-wrap-label">Wrap</span>}
												ariaLabel="Soft-wrap long lines"
											/>
										)}
										{footerExtras}
									</div>
								)}
						</div>
					</div>
				}
				right={
					<div className="editor-side">
						{sidePanel}
						{dangerZone}
					</div>
				}
			/>
		</div>
	);
}
