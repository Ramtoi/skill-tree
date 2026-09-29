import {
	useEffect,
	useRef,
	useState,
	type KeyboardEvent,
	type ReactNode,
} from "react";

export interface MultiSelectOption {
	/** Stable identity — passed back to `onToggle`. */
	id: string;
	/** Decorative leading glyph (a brand mark, an icon) — never the only
	 *  identity signal. */
	glyph?: ReactNode;
	label: ReactNode;
	/** Right-set meta — a `StatusBadge` dot+word, a count, anything read-only. */
	meta?: ReactNode;
	selected: boolean;
	/** Cannot be toggled (a lone remaining option, a read-only screen, …).
	 *  Still focusable — a disabled row explains itself via `title`, it
	 *  doesn't disappear. */
	disabled?: boolean;
	/** Hover text — the row's consequence (what selecting/deselecting it does,
	 *  or why it's disabled). */
	title?: string;
}

export interface MultiSelectListProps {
	/** Accessible name of the list — required so two lists on one screen never
	 *  share a name (`aria-label`). */
	label: string;
	options: MultiSelectOption[];
	onToggle: (id: string) => void;
	className?: string;
}

/**
 * A multiselect listbox whose selection is the LIT SLOT (side panel language
 * rule 5) — never a checkbox, never a stripe. Use it when the selection IS
 * the row's own state and there is no secondary per-row action (compare
 * `EquipPicker`'s `Toggle` checkbox rows, which carry a blast-radius `title`
 * on an action that is otherwise reversible only via undo — a lit slot fits a
 * value the row simply IS, like a hook's harness affinity).
 *
 * `role="listbox"` + `aria-multiselectable="true"`, one `role="option"` row
 * each holding `aria-selected`. Roving tabindex: ArrowUp/Down and Home/End
 * move focus, Space/Enter and a click toggle the focused/clicked row. A
 * `disabled` row stays focusable (so its `title` is reachable by keyboard)
 * but never toggles.
 */
export function MultiSelectList({
	label,
	options,
	onToggle,
	className,
}: MultiSelectListProps) {
	const count = options.length;
	const [activeIndex, setActiveIndex] = useState(0);
	const itemsRef = useRef<(HTMLElement | null)[]>([]);

	// The option list can change shape (a harness installed/removed) — clamp so
	// the roving tabindex never strands past the last row.
	useEffect(() => {
		setActiveIndex((i) => Math.max(0, Math.min(i, count - 1)));
	}, [count]);

	function focusIndex(i: number) {
		setActiveIndex(i);
		itemsRef.current[i]?.focus();
	}

	function activate(i: number) {
		const opt = options[i];
		if (opt && !opt.disabled) onToggle(opt.id);
	}

	function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
		if (count === 0) return;
		switch (e.key) {
			case "ArrowDown":
				e.preventDefault();
				focusIndex(Math.min(activeIndex + 1, count - 1));
				break;
			case "ArrowUp":
				e.preventDefault();
				focusIndex(Math.max(activeIndex - 1, 0));
				break;
			case "Home":
				e.preventDefault();
				focusIndex(0);
				break;
			case "End":
				e.preventDefault();
				focusIndex(count - 1);
				break;
			case " ":
			case "Enter":
				e.preventDefault();
				activate(activeIndex);
				break;
			default:
				break;
		}
	}

	return (
		<div
			className={`multiselect-list${className ? ` ${className}` : ""}`}
			role="listbox"
			aria-multiselectable="true"
			aria-label={label}
			// Programmatically focusable as a fallback (an empty list, or before
			// any row has been focused) but never a tab stop of its own — the
			// roving tabindex below is the real focus model.
			tabIndex={-1}
			onKeyDown={onKeyDown}
		>
			{options.map((opt, i) => (
				// eslint-disable-next-line jsx-a11y/click-events-have-key-events -- this row IS the roving tab stop (tabIndex below); its keydown is the root listbox's onKeyDown, reached by ordinary DOM bubbling from whichever row is focused.
				<div
					key={opt.id}
					ref={(el) => {
						itemsRef.current[i] = el;
					}}
					role="option"
					aria-selected={opt.selected}
					aria-disabled={opt.disabled || undefined}
					tabIndex={i === activeIndex ? 0 : -1}
					className="multiselect-row"
					data-active={opt.selected || undefined}
					data-disabled={opt.disabled || undefined}
					title={opt.title}
					onClick={() => {
						setActiveIndex(i);
						activate(i);
					}}
					onFocus={() => setActiveIndex(i)}
				>
					{opt.glyph && <span className="multiselect-glyph">{opt.glyph}</span>}
					<span className="multiselect-label">{opt.label}</span>
					{opt.meta && <span className="multiselect-meta">{opt.meta}</span>}
				</div>
			))}
		</div>
	);
}
