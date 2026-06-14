import { useState } from "react";
import { Icon } from "@/components/Icon";

export interface TagInputProps {
	tags: string[];
	onChange: (tags: string[]) => void;
	/** Existing tags offered as one-click additions. */
	suggestions?: string[];
}

/** Chip input for snippet tags: Enter/comma adds, Backspace pops, suggestions
 *  add on click. Tags are normalized to lowercase kebab characters. */
export function TagInput({ tags, onChange, suggestions = [] }: TagInputProps) {
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
	const avail = suggestions.filter((s) => !tags.includes(s));

	return (
		<div className="snip-tag-editor">
			<div className="snip-tag-row">
				{tags.map((t) => (
					<span key={t} className="snip-tag">
						<span>{t}</span>
						<button type="button" onClick={() => remove(t)} title="Remove tag">
							<Icon name="x" size={9} />
						</button>
					</span>
				))}
				<input
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" || e.key === ",") {
							e.preventDefault();
							add(draft);
						} else if (e.key === "Backspace" && !draft && tags.length) {
							remove(tags[tags.length - 1]);
						}
					}}
					placeholder={tags.length ? "add tag…" : "add tags…"}
				/>
			</div>
			{avail.length > 0 && (
				<div className="snip-tag-suggest">
					{avail.slice(0, 8).map((s) => (
						<button
							key={s}
							type="button"
							className="snip-tag-sugg"
							onClick={() => add(s)}
						>
							+ {s}
						</button>
					))}
				</div>
			)}
		</div>
	);
}
