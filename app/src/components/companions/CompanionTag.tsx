// The `via <skill>` / `shipped by <skill>` provenance word (D5, plan 2 wave D).
// Reuses `Tag` (COMPONENTS.md §Tags) — no `color` prop, so it renders in the
// default neutral `--fg-mute` register: amber stays reserved for direct-equip
// provenance, this is never that. A long skill name would clip beside
// `HookAttachChip`/`HookHealthBadge` at 520px (S3), so the name is truncated
// and the full sentence always lives in `title`.

import { Tag } from "@/components/Tag";

/** Which lookup produced this row: the mirror (`shippedBy`, project-
 *  independent) or the ledger (`via`, one project). Never swapped by a caller
 *  — see `test/companionProvenance.test.tsx`. */
export type CompanionWord = "via" | "shipped by";

export interface CompanionTagProps {
	word: CompanionWord;
	skill: string;
	className?: string;
	/** Wave 4c unit 4 (plans/3.md §2.3/§5) — the reverse direction: when passed,
	 *  the tag renders as a `<button>` instead of a read-only `<span>`, and
	 *  clicking it is the row's whole "Ship with…" affordance (opening
	 *  `useShipWith()`'s flow already seeded with this row's item, straight to
	 *  the named skill's sheet — no picker). Omit to keep today's read-only
	 *  tag verbatim. */
	onClick?: () => void;
	/** Appended to the title/accessible name when `onClick` is set — lets a
	 *  caller name the action ("Ship with…") instead of the generic default. */
	actionLabel?: string;
}

/** S3: truncate at 15 characters so `orchestrate-advanced` reads
 *  `orchestrate-adv…` — the exact truncation the design doc pins. */
const MAX_SKILL_CHARS = 15;

const DEFAULT_ACTION_LABEL = "edit what it ships";

function truncateSkillName(name: string): string {
	return name.length > MAX_SKILL_CHARS ? `${name.slice(0, MAX_SKILL_CHARS)}…` : name;
}

export function CompanionTag({ word, skill, className, onClick, actionLabel }: CompanionTagProps) {
	const short = truncateSkillName(skill);
	const cls = className ? `companion-tag ${className}` : "companion-tag";
	const body = (
		<Tag size="sm">
			{word} <span className="text-mono">{short}</span>
		</Tag>
	);

	if (!onClick) {
		return (
			<span
				className={cls}
				data-testid="companion-tag"
				data-word={word}
				data-skill={skill}
				title={`${word} ${skill}`}
			>
				{body}
			</span>
		);
	}

	// Interactive mode (the literal reverse of the read-only tag above): a
	// bare pressable, same visual register as `Tag` itself — no new chrome.
	// The accessible name/title carry the UNTRUNCATED skill name (T16) even
	// though the visible label is truncated (S3).
	const fullLabel = `${word} ${skill} — ${actionLabel ?? DEFAULT_ACTION_LABEL}`;
	return (
		<button
			type="button"
			className={cls}
			data-testid="companion-tag"
			data-word={word}
			data-skill={skill}
			data-interactive="true"
			title={fullLabel}
			aria-label={fullLabel}
			onClick={(e) => {
				// The tag lives inside rows/cards that are themselves clickable
				// (Hooks row → editor, sub-agent card → editor) — this click means
				// "ship with", never "open the thing the row is about".
				e.stopPropagation();
				onClick();
			}}
		>
			{body}
		</button>
	);
}
