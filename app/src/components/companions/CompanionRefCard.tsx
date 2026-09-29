// D8 — the companion hover card: `SkillRefCard`'s shape (name, one-line
// description, an optional `onOpen` button) plus the per-harness glyph row.
// Reuses `SkillRefCard`'s own CSS classes (`.skill-ref-card*`, styles/skill-
// refs.css) so the two cards read as one family — this file only adds the
// kind label and the glyph row on top, in `companions.css`. One React host
// only (Approach 8): a companion name never appears in the editor buffer, so
// there is no CodeMirror-hover-tooltip twin the way `SkillRefCard` needs one.

import { Icon } from "@/components/Icon";
import {
	CompanionHarnessGlyphs,
	type CompanionHarnessState,
} from "./CompanionHarnessGlyphs";

export type { CompanionHarnessState };

const KIND_ICON: Record<"agent" | "hook" | "permission", string> = {
	agent: "agent",
	hook: "hook",
	permission: "permissions",
};

const KIND_LABEL: Record<"agent" | "hook" | "permission", string> = {
	agent: "AGENT",
	hook: "HOOK",
	permission: "RULE",
};

export interface CompanionRefCardInfo {
	kind: "agent" | "hook" | "permission";
	name: string;
	/** agent: frontmatter description · hook: "<event> · <command>" (a ref
	 *  resolves from the hooks library, resolved by the CALLER — this
	 *  component never queries anything) · rule: "<kind> · <pattern>". */
	description?: string;
	harnesses: CompanionHarnessState[];
	/** Edit-mode-only "⌘-click to open" hint, mirroring `SkillRefCard`. This
	 *  card is never mounted inside a CodeMirror buffer, so no call site sets
	 *  this today — kept for shape parity and future reuse. */
	showHint?: boolean;
}

const NO_DESCRIPTION = "No description.";

export function CompanionRefCard({
	kind,
	name,
	description,
	harnesses,
	showHint,
	onOpen,
}: CompanionRefCardInfo & { onOpen?: () => void }) {
	return (
		<span className="skill-ref-card companion-ref-card">
			<span className="companion-ref-card-kind text-dim">
				<Icon name={KIND_ICON[kind]} size={11} tone="dim" />
				{KIND_LABEL[kind]}
			</span>
			{onOpen ? (
				<button type="button" className="skill-ref-card-name" onClick={onOpen}>
					{name}
				</button>
			) : (
				<span className="skill-ref-card-name">{name}</span>
			)}
			<span className="skill-ref-card-desc">{description || NO_DESCRIPTION}</span>
			{harnesses.length > 0 && (
				<span className="companion-ref-card-glyphs">
					<CompanionHarnessGlyphs states={harnesses} size={12} />
				</span>
			)}
			{showHint && <span className="skill-ref-card-hint">⌘-click to open</span>}
		</span>
	);
}
