import {
	forwardRef,
	useEffect,
	useImperativeHandle,
	useMemo,
	useRef,
} from "react";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { EditorState, Compartment } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { search, searchKeymap } from "@codemirror/search";
import { markdown } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { renderMarkdown } from "@/lib/renderMarkdown";
import { lineDiff, isUnchanged } from "@/lib/lineDiff";

// ─── Edit mode: a CodeMirror 6 editor (caret + gutter + text in one layer) ──
export interface CodeAreaEditProps {
	content: string;
	onChange: (value: string) => void;
	/** When true the editor is locked; used for externally-managed skills. */
	readOnly?: boolean;
	/** Soft-wrap long lines (line wrapping). Default true. Reconfigured live. */
	softWrap?: boolean;
}

/** Imperative handle used by the markdown toolbar to mutate the selection. */
export interface CodeAreaHandle {
	/** Wrap each selection range; empty selection inserts `left right` with the
      caret between the two markers (matches old wrap() behavior). */
	wrapSelection(left: string, right: string): void;
	/** Prefix every line touched by the selection (headings/lists/quotes). */
	prefixLines(prefix: string): void;
	focus(): void;
}

// Match the existing design tokens so the editor looks identical to before.
const editorTheme = EditorView.theme(
	{
		"&": {
			background: "transparent",
			color: "var(--fg)",
			fontFamily: "var(--font-mono)",
			fontSize: "12.5px",
			height: "100%",
		},
		".cm-scroller": {
			fontFamily: "var(--font-mono)",
			lineHeight: "1.55",
			overflow: "auto",
		},
		".cm-content": {
			padding: "18px 0 24px",
			caretColor: "var(--violet-2)",
		},
		".cm-line": {
			padding: "0 var(--pad-screen-x) 0 6px",
		},
		"&.cm-focused": { outline: "none" },
		".cm-cursor, .cm-dropCursor": {
			borderLeftColor: "var(--violet-2)",
			borderLeftWidth: "2px",
		},
		".cm-selectionBackground": {
			background: "color-mix(in oklab, var(--violet) 22%, transparent)",
		},
		"&.cm-focused .cm-selectionBackground, ::selection": {
			background: "color-mix(in oklab, var(--violet) 30%, transparent)",
		},
		".cm-gutters": {
			background: "transparent",
			color: "var(--fg-dim)",
			border: "none",
			paddingLeft: "var(--pad-screen-x)",
		},
		".cm-lineNumbers .cm-gutterElement": {
			minWidth: "28px",
			padding: "0 14px 0 0",
			textAlign: "right",
		},
		".cm-activeLineGutter": {
			background: "transparent",
			color: "var(--fg-mute)",
		},
		".cm-activeLine": { background: "transparent" },
		// ── Search panel (⌘F) — themed with the editor tokens ──
		".cm-panels": {
			background: "var(--bg-1)",
			color: "var(--fg)",
			borderTop: "1px solid var(--border)",
		},
		".cm-panel.cm-search": {
			padding: "6px 8px",
			fontFamily: "var(--font-sans)",
			fontSize: "12px",
		},
		".cm-panel.cm-search input, .cm-panel.cm-search button": {
			background: "var(--bg-2)",
			color: "var(--fg)",
			border: "1px solid var(--border)",
			borderRadius: "var(--radius-sm)",
			fontFamily: "var(--font-mono)",
		},
		".cm-panel.cm-search label": { color: "var(--fg-mid)" },
		".cm-searchMatch": {
			background: "color-mix(in oklab, var(--amber) 24%, transparent)",
		},
		".cm-searchMatch-selected": {
			background: "color-mix(in oklab, var(--violet) 34%, transparent)",
		},
	},
	{ dark: true },
);

// Map the markdown syntax tags to the OLD palette so the look is preserved.
const editorHighlight = HighlightStyle.define([
	{ tag: tags.heading1, color: "var(--red)", fontWeight: "600" },
	{ tag: tags.heading2, color: "var(--green)", fontWeight: "600" },
	{ tag: tags.heading3, color: "var(--green)", fontWeight: "600" },
	{ tag: tags.heading4, color: "var(--green)", fontWeight: "600" },
	{ tag: tags.heading5, color: "var(--green)", fontWeight: "600" },
	{ tag: tags.heading6, color: "var(--green)", fontWeight: "600" },
	{ tag: tags.strong, color: "var(--amber)", fontWeight: "600" },
	{ tag: tags.monospace, color: "var(--cyan)" },
	{ tag: tags.contentSeparator, color: "var(--cyan)" },
	{ tag: [tags.list, tags.processingInstruction], color: "var(--violet-2)" },
]);

export const CodeAreaEdit = forwardRef<CodeAreaHandle, CodeAreaEditProps>(
	function CodeAreaEdit({ content, onChange, readOnly, softWrap = true }, ref) {
		const hostRef = useRef<HTMLDivElement | null>(null);
		const viewRef = useRef<EditorView | null>(null);
		// Stable ref so the mount-once effect always sees the latest onChange.
		const onChangeRef = useRef(onChange);
		onChangeRef.current = onChange;
		const readOnlyComp = useRef(new Compartment());
		const wrapComp = useRef(new Compartment());

		// Mount the EditorView once.
		useEffect(() => {
			if (!hostRef.current) return;
			const view = new EditorView({
				parent: hostRef.current,
				state: EditorState.create({
					doc: content,
					extensions: [
						lineNumbers(),
						history(),
						search({ top: true }),
						keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
						markdown(),
						wrapComp.current.of(softWrap ? EditorView.lineWrapping : []),
						editorTheme,
						syntaxHighlighting(editorHighlight),
						readOnlyComp.current.of([
							EditorState.readOnly.of(!!readOnly),
							EditorView.editable.of(!readOnly),
						]),
						EditorView.updateListener.of((update) => {
							if (update.docChanged) {
								onChangeRef.current(update.state.doc.toString());
							}
						}),
					],
				}),
			});
			viewRef.current = view;
			return () => {
				view.destroy();
				viewRef.current = null;
			};
			// eslint-disable-next-line react-hooks/exhaustive-deps
		}, []);

		// Controlled-input reconciliation: when the prop diverges from the doc
		// (external change, not local typing), replace the doc. Typing already
		// leaves the doc matching the prop, so this is a no-op on that path.
		useEffect(() => {
			const view = viewRef.current;
			if (!view) return;
			const current = view.state.doc.toString();
			if (content !== current) {
				view.dispatch({
					changes: { from: 0, to: current.length, insert: content },
				});
			}
		}, [content]);

		// Reconfigure read-only without recreating the view.
		useEffect(() => {
			const view = viewRef.current;
			if (!view) return;
			view.dispatch({
				effects: readOnlyComp.current.reconfigure([
					EditorState.readOnly.of(!!readOnly),
					EditorView.editable.of(!readOnly),
				]),
			});
		}, [readOnly]);

		// Reconfigure soft-wrap without recreating the view (preserves doc,
		// selection, and undo history).
		useEffect(() => {
			const view = viewRef.current;
			if (!view) return;
			view.dispatch({
				effects: wrapComp.current.reconfigure(
					softWrap ? EditorView.lineWrapping : [],
				),
			});
		}, [softWrap]);

		useImperativeHandle(
			ref,
			(): CodeAreaHandle => ({
				wrapSelection(left, right) {
					const view = viewRef.current;
					if (!view) return;
					const ranges = view.state.selection.ranges;
					let cursorPos: number | null = null;
					const changes = ranges.flatMap((r) => {
						if (r.empty) {
							cursorPos = r.from + left.length;
							return [{ from: r.from, insert: left + right }];
						}
						return [
							{ from: r.from, insert: left },
							{ from: r.to, insert: right },
						];
					});
					view.dispatch({
						changes,
						selection: cursorPos !== null ? { anchor: cursorPos } : undefined,
					});
					view.focus();
				},
				prefixLines(prefix) {
					const view = viewRef.current;
					if (!view) return;
					const seen = new Set<number>();
					const changes: Array<{ from: number; insert: string }> = [];
					for (const r of view.state.selection.ranges) {
						const startLine = view.state.doc.lineAt(r.from).number;
						const endLine = view.state.doc.lineAt(r.to).number;
						for (let n = startLine; n <= endLine; n++) {
							if (seen.has(n)) continue;
							seen.add(n);
							changes.push({
								from: view.state.doc.line(n).from,
								insert: prefix,
							});
						}
					}
					if (changes.length) view.dispatch({ changes });
					view.focus();
				},
				focus() {
					viewRef.current?.focus();
				},
			}),
			[],
		);

		return <div ref={hostRef} className="code-area code-area--edit" />;
	},
);

// ─── Preview mode: pure token-driven markdown renderer (D1) ───────────────────
export interface CodeAreaPreviewProps {
	content: string;
	/** How a rendered link is activated. Default: openUrl via plugin-opener. */
	onOpenLink?: (href: string) => void;
}

export function CodeAreaPreview({ content, onOpenLink }: CodeAreaPreviewProps) {
	const rendered = useMemo(
		() => renderMarkdown(content, { onOpenLink }),
		[content, onOpenLink],
	);
	return <div className="code-area code-area--preview">{rendered}</div>;
}

// ─── Diff mode: real aligned line diff (D2) ───────────────────────────────────
export interface CodeAreaDiffProps {
	original: string;
	current: string;
}

export function CodeAreaDiff({ original, current }: CodeAreaDiffProps) {
	const hunks = useMemo(() => lineDiff(original, current), [original, current]);

	if (isUnchanged(hunks)) {
		return (
			<div className="code-area code-area--diff">
				<div className="diff-empty">No changes since last save</div>
			</div>
		);
	}

	return (
		<div className="code-area code-area--diff">
			<div className="diff-body">
				{hunks.map((h, hi) => (
					<div key={hi} className="diff-hunk">
						<div className="diff-hunk-header">{h.header}</div>
						{h.ops.map((op, oi) => (
							<div key={oi} className="diff-line" data-kind={op.kind}>
								<span className="diff-gutter diff-gutter-a">
									{op.aLine ?? ""}
								</span>
								<span className="diff-gutter diff-gutter-b">
									{op.bLine ?? ""}
								</span>
								<span className="diff-sign">{op.kind}</span>
								<span className="diff-text">{op.text || " "}</span>
							</div>
						))}
					</div>
				))}
			</div>
		</div>
	);
}
