import { Icon } from "@/components/Icon";

export interface MarkdownToolbarProps {
	/** Wrap the current selection (bold / italic / code / link). */
	onWrap: (left: string, right: string) => void;
	/** Prefix every line the selection touches (headings / lists / quote). */
	onPrefixLine: (prefix: string) => void;
}

interface ToolButtonProps {
	title: string;
	onClick: () => void;
	children: React.ReactNode;
}

/** `onMouseDown` is swallowed so the button never steals the caret — the
 *  mutators act on whatever the editor's selection was a moment ago. */
function ToolButton({ title, onClick, children }: ToolButtonProps) {
	return (
		<button
			type="button"
			className="btn btn-sm"
			title={title}
			onMouseDown={(e) => e.preventDefault()}
			onClick={onClick}
		>
			{children}
		</button>
	);
}

/**
 * The markdown mutator group shared by the skill and sub-agent editors. It is
 * passed to `DocumentEditorShell`'s `toolbar` slot, which places it on the
 * editor bar right after the mode chips (one band, not a second strip). The
 * skill editor mounts it only for a Markdown document, so a `.py` or `.json`
 * file gets the editor without the markdown verbs.
 */
export function MarkdownToolbar({ onWrap, onPrefixLine }: MarkdownToolbarProps) {
	return (
		// `role="group"`, not `role="toolbar"`: a toolbar promises arrow-key
		// navigation with one tab stop, and these are plain tab-stop buttons.
		<div className="md-toolbar" role="group" aria-label="Markdown formatting">
			<ToolButton title="Bold" onClick={() => onWrap("**", "**")}>
				<Icon name="md.bold" size={12} />
			</ToolButton>
			<ToolButton title="Italic" onClick={() => onWrap("*", "*")}>
				<Icon name="md.italic" size={12} />
			</ToolButton>
			<ToolButton title="Heading 1" onClick={() => onPrefixLine("# ")}>
				<Icon name="md.h1" size={12} />
			</ToolButton>
			<ToolButton title="Heading 2" onClick={() => onPrefixLine("## ")}>
				<Icon name="md.h2" size={12} />
			</ToolButton>
			<ToolButton title="Bullet list" onClick={() => onPrefixLine("- ")}>
				<Icon name="md.list" size={12} />
			</ToolButton>
			<ToolButton title="Numbered list" onClick={() => onPrefixLine("1. ")}>
				1.
			</ToolButton>
			<ToolButton title="Quote" onClick={() => onPrefixLine("> ")}>
				<Icon name="md.quote" size={12} />
			</ToolButton>
			<ToolButton title="Code" onClick={() => onWrap("`", "`")}>
				<Icon name="md.code" size={12} />
			</ToolButton>
			<ToolButton title="Link" onClick={() => onWrap("[", "](url)")}>
				<Icon name="link" size={11} />
				</ToolButton>
		</div>
	);
}
