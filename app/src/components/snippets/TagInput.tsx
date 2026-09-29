import { useState } from "react";
import { Icon } from "@/components/Icon";
import { useAutocomplete } from "@/lib/useAutocomplete";
import { SuggestionDropdown } from "@/components/SuggestionDropdown";

export interface TagInputProps {
	tags: string[];
	onChange: (tags: string[]) => void;
	/** Existing tags across the library, offered as type-to-filter completions. */
	suggestions?: string[];
	/** Tighter chip/well sizing for a `.kv-row` value column (the snippet
	 *  editor's identity tier) — the create-mode default is untouched. */
	compact?: boolean;
}

/** Chip input for snippet tags: Enter/comma adds, Backspace pops. Typing filters
 *  the existing-tag vocabulary in a dropdown (↑/↓ to move, Enter to accept the
 *  highlighted tag) so tags stay consistent instead of drifting into near-dupes.
 *  Tags are normalized to lowercase kebab characters. */
export function TagInput({ tags, onChange, suggestions = [], compact = false }: TagInputProps) {
	const [draft, setDraft] = useState("");

	const add = (raw: string) => {
		const t = raw
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9-]/g, "");
		if (!t || tags.includes(t)) {
			setDraft("");
			return;
		}
		onChange([...tags, t]);
		setDraft("");
	};
	const remove = (t: string) => onChange(tags.filter((x) => x !== t));
	// Only offer tags not already applied to this snippet.
	const avail = suggestions.filter((s) => !tags.includes(s));
	const ac = useAutocomplete({ query: draft, items: avail, onPick: add });

	return (
		<div className={compact ? "snip-tag-editor snip-tag-editor-compact" : "snip-tag-editor"}>
			<div className="snip-tag-row autocomplete-wrap">
				{tags.map((t) => (
					<span key={t} className="snip-tag">
						<span>{t}</span>
						<button type="button" onClick={() => remove(t)} title="Remove tag">
							<Icon name="x" size={compact ? 10 : 9} />
						</button>
					</span>
				))}
				<input
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					onFocus={() => ac.show()}
					onBlur={() => ac.hide()}
					onKeyDown={(e) => {
						// Let the dropdown claim arrows / Enter-on-highlight / Esc first.
						if (ac.handleKeyDown(e)) return;
						if (e.key === "Enter" || e.key === ",") {
							e.preventDefault();
							add(draft);
						} else if (e.key === "Backspace" && !draft && tags.length) {
							remove(tags[tags.length - 1]);
						}
					}}
					placeholder={compact ? "+" : tags.length ? "add tag…" : "add tags…"}
					aria-label={compact ? "Add tag" : undefined}
					title={compact ? "Add tag" : undefined}
				/>
				<SuggestionDropdown ac={ac} label="Existing tags" />
			</div>
		</div>
	);
}
