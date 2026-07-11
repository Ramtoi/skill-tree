import {
	useEffect,
	useRef,
	useState,
	type ReactNode,
	type Ref,
} from "react";
import { Button } from "./Button";
import { StatePill } from "./StatePill";
import { SubheaderViewChips } from "./SubheaderViewChips";
import { Toggle } from "./Toggle";
import { ResizableSplit } from "./ResizableSplit";
import {
	CodeAreaDiff,
	CodeAreaEdit,
	CodeAreaPreview,
	type CodeAreaHandle,
} from "./CodeArea";

export type DocMode = "edit" | "preview" | "diff" | "split";

/** Severity of an attention state living inside the Details side panel. */
export type DetailsAttentionLevel = "error" | "warning";

/**
 * Attention signal for the Details side panel. When the panel is collapsed to
 * its vertical reopen tab at narrow widths, a blocking/attention state it holds
 * (validation error, drift banner, provision prompt) would otherwise be hidden.
 * Passing this renders a red/amber dot on the collapsed tab (mirroring the
 * always-visible UNSAVED pill) so the state stays discoverable.
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

	// ── save affordance ──
	dirty: boolean;
	onSave: () => void;
	saveDisabled?: boolean;
	/** While true the Save button shows a leading spinner + "Saving…" and the
	 *  `⌘S` shortcut is inert (the write is already in flight). */
	saving?: boolean;
	/** Label for the save button in its idle (non-dirty) state. Default "Saved". */
	savedLabel?: string;

	// ── slots (each screen's uniqueness) ──
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
 * The shared editor shell (D5). Owns the mode chips, `UNSAVED` pill, `⌘S` Save
 * affordance, the editor|side-panel resizable split, the soft-wrap footer, and
 * the split-mode width gate. Each screen threads its uniqueness through slots —
 * the shell never sees guided/raw or master-detail state.
 */
export function DocumentEditorShell({
	content,
	onContentChange,
	readOnly,
	editorRef,
	mode,
	onModeChange,
	modes = ["edit", "preview", "diff", "split"],
	previewSource,
	diffOriginal,
	diffCurrent,
	onOpenLink,
	dirty,
	onSave,
	saveDisabled,
	saving,
	savedLabel = "Saved",
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

	// Fall back to edit when split is active but the pane narrowed below --bp-nav.
	useEffect(() => {
		if (mode === "split" && !splitAvailable) onModeChange("edit");
	}, [mode, splitAvailable, onModeChange]);

	// Own the ⌘S listener so consumers stop hand-rolling it.
	useEffect(() => {
		function onKey(e: KeyboardEvent) {
			if ((e.metaKey || e.ctrlKey) && e.key === "s") {
				e.preventDefault();
				if (dirty && !saveDisabled && !saving) onSave();
			}
		}
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [dirty, saveDisabled, saving, onSave]);

	const chipViews = modes
		.filter((m) => m !== "split" || splitAvailable)
		.map((m) => ({ id: m, label: MODE_CHIPS[m].label, icon: MODE_CHIPS[m].icon }));

	const editPane = (
		<CodeAreaEdit
			ref={editorRef}
			content={content}
			onChange={onContentChange}
			readOnly={readOnly}
			softWrap={softWrap}
		/>
	);
	const previewPane = (
		<CodeAreaPreview content={previewSource ?? content} onOpenLink={onOpenLink} />
	);
	const diffPane = (
		<CodeAreaDiff original={diffOriginal} current={diffCurrent ?? content} />
	);

	// The toolbar rides above the editor in edit/split modes only.
	const showToolbar = !!toolbar && !readOnly && (mode === "edit" || mode === "split");
	// Soft-wrap only affects the CodeMirror editor → offer it in edit/split.
	const showWrapToggle = mode === "edit" || mode === "split";

	let body: ReactNode;
	if (mode === "preview") body = previewPane;
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
			<div className="doc-editor-bar">
				<div className="doc-editor-bar-left">
					<SubheaderViewChips<DocMode>
						views={chipViews}
						value={mode}
						onChange={onModeChange}
					/>
					{headerExtras}
				</div>
				<div className="doc-editor-bar-right">
					{dirty && <StatePill state="unsaved">UNSAVED</StatePill>}
					{!readOnly && (
						<Button
							variant="primary"
							icon="save"
							kbd="⌘S"
							busy={saving}
							disabled={!dirty || saveDisabled}
							onClick={onSave}
						>
							{saving ? "Saving…" : dirty ? "Save" : savedLabel}
						</Button>
					)}
				</div>
			</div>

			<ResizableSplit
				className="editor-grid"
				fixedPane="right"
				storageKey={splitStorageKey}
				defaultRightPx={332}
				minRightPx={280}
				maxRightPx={560}
				paneLabel="Details"
				handleAriaLabel="Resize side panel"
				left={
					<div className="editor-main" ref={paneRef}>
						{showToolbar && toolbar}
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
