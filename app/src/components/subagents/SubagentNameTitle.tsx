import { InlineName } from "@/components/InlineName";
import {
	CLAUDE_AGENT_NAME_RE,
	CODEX_AGENT_NAME_RE,
	type SubagentWarning,
} from "@/lib/subagents";

export interface SubagentNameTitleProps {
	/** The draft name (staged, written by ⌘S). */
	name: string;
	isCodex: boolean;
	/** The last save's `name`-field error, when the server rejected a rename
	 *  (`draft.errorFor("name")`) — carries the rejected value in `.value`
	 *  (`subagents.py`'s collision response), so `validate` can flag a retyped
	 *  match without a round trip. */
	nameError: SubagentWarning | undefined;
	onChange: (next: string) => void;
	/** Mirrors the live client-validation message while the field is open, so
	 *  the caller can paint it as a VISIBLE line (M2) instead of leaving it
	 *  on hover-only `title`/`aria-invalid`. */
	onValidityChange?: (error: string | null) => void;
}

/**
 * The sub-agent editor's title: the name edits where it is read, in the
 * header, as a skill's or a project's does. `onSave` only STAGES the value
 * (⌘S writes it) — the header's `state` slot wears `RenamedPill` until then.
 * Validation is per-harness (Codex allows underscores, Claude does not) and
 * also catches a resubmission of the exact name the server just rejected.
 */
export function SubagentNameTitle({
	name,
	isCodex,
	nameError,
	onChange,
	onValidityChange,
}: SubagentNameTitleProps) {
	const rejectedName =
		typeof nameError?.value === "string" ? nameError.value : null;
	return (
		<InlineName
			value={name}
			label="Agent name"
			commitOnBlur
			onSave={onChange}
			onValidityChange={onValidityChange}
			validate={(next) => {
				if (rejectedName && next === rejectedName) {
					return nameError?.message ?? "That name is taken.";
				}
				const re = isCodex ? CODEX_AGENT_NAME_RE : CLAUDE_AGENT_NAME_RE;
				if (!re.test(next)) {
					return isCodex
						? "Lowercase letters, numbers, hyphens, and underscores only."
						: "Lowercase letters, numbers, and hyphens only.";
				}
				return null;
			}}
		/>
	);
}
