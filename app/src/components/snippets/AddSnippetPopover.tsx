import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { useSnippets } from "@/hooks/useSnippets";

export interface AddSnippetPopoverProps {
	/** Snippet names already present in the target file (excluded). */
	excludeNames?: string[];
	onPick: (name: string) => void;
	onClose: () => void;
	anchorClass?: string;
}

/** Compact popover: search + tag chips over the library. Shared by the
 *  Snippets screen apply flow and the Agent Docs strip "Add snippet". */
export function AddSnippetPopover({
	excludeNames = [],
	onPick,
	onClose,
	anchorClass = "",
}: AddSnippetPopoverProps) {
	const [q, setQ] = useState("");
	const [tag, setTag] = useState<string | null>(null);
	const ref = useRef<HTMLDivElement>(null);
	const { data: lib = [] } = useSnippets();

	useEffect(() => {
		const onDown = (e: MouseEvent) => {
			if (ref.current && !ref.current.contains(e.target as Node)) onClose();
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		document.addEventListener("mousedown", onDown);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("mousedown", onDown);
			document.removeEventListener("keydown", onKey);
		};
	}, [onClose]);

	const allTags = useMemo(
		() => [...new Set(lib.flatMap((s) => s.tags))].sort(),
		[lib],
	);
	const excluded = new Set(excludeNames);
	const lq = q.trim().toLowerCase();
	const rows = lib.filter((s) => {
		if (excluded.has(s.name)) return false;
		if (tag && !s.tags.includes(tag)) return false;
		if (!lq) return true;
		return (
			s.name.includes(lq) ||
			s.description.toLowerCase().includes(lq) ||
			(s.body ?? "").toLowerCase().includes(lq)
		);
	});

	return (
		<div className={`snip-picker ${anchorClass}`} ref={ref} role="dialog">
			<div className="snip-picker-head">
				<div className="search-input snip-picker-search">
					<Icon name="search" />
					<input
						autoFocus
						placeholder="Search snippets…"
						value={q}
						onChange={(e) => setQ(e.target.value)}
					/>
				</div>
			</div>
			{allTags.length > 0 && (
				<div className="snip-picker-tags">
					{allTags.map((t) => (
						<button
							key={t}
							type="button"
							className="chip"
							aria-pressed={tag === t}
							onClick={() => setTag(tag === t ? null : t)}
						>
							{t}
						</button>
					))}
				</div>
			)}
			<div className="snip-picker-list">
				{rows.length === 0 ? (
					<div className="snip-picker-empty">
						{excludeNames.length && lib.length
							? "Every snippet is already in this file."
							: "No snippets match."}
					</div>
				) : (
					rows.map((s) => (
						<button
							key={s.name}
							type="button"
							className="snip-picker-row"
							onClick={() => onPick(s.name)}
						>
							<span className="snip-picker-name">{s.name}</span>
							<span className="snip-picker-desc">{s.description}</span>
							<span className="snip-picker-add">
								<Icon name="plus" size={12} />
							</span>
						</button>
					))
				)}
			</div>
		</div>
	);
}
