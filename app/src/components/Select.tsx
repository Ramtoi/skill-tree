import {
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
	type KeyboardEvent,
	type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon";

export interface SelectOption<V extends string> {
	value: V;
	/** Rendered in mono — the values a Select carries are identifiers. */
	label: string;
	/** One sans line under the label: what picking this means. */
	hint?: string;
	/** A CSS color for a leading status dot — the same `.dot` markup `Chip`
	 *  uses, so the size matches. Renders before the label in the option row,
	 *  and (for the selected option only) on the closed trigger. Omit for an
	 *  option with nothing to signal (e.g. a plain "All"). */
	dot?: string;
	/** A leading icon/glyph (e.g. a `HarnessGlyph`) — its own grid cell before
	 *  the label in the option row, and, for the selected option only, before
	 *  the value on the closed trigger. Omit for an option with no icon; a
	 *  mix of options with and without one is fine (the cell is simply
	 *  empty for those). Always DECORATIVE: `Select` wraps it in an
	 *  `aria-hidden` cell, so an option's accessible name stays its `label`
	 *  whatever the caller passes. */
	leading?: ReactNode;
}

export interface SelectProps<V extends string> {
	value: V;
	options: readonly SelectOption<V>[];
	onChange: (value: V) => void;
	/** Accessible name of the control ("Scope"). */
	label: string;
	/** Hover text on the closed control — the current value's consequence. */
	title?: string;
	disabled?: boolean;
	className?: string;
	/** Style the menu itself, including when it is portalled outside its trigger. */
	menuClassName?: string;
	/** Escape a clipping/scrolling ancestor by portalling the open menu to
	 *  `document.body` and positioning it `fixed`, measured from the trigger
	 *  (the same mechanics `Popover`/`OverflowMenu` already use) instead of
	 *  the default `position: absolute` anchored to `.select` itself. Needed
	 *  because `overflow-x: auto` paired with `overflow-y: visible` on an
	 *  ancestor computes BOTH axes to `auto` per the CSS Overflow spec — a
	 *  horizontal-scroll-fade strip (`.main-subheader-left`) silently clips
	 *  and scroll-traps any descendant's vertical dropdown, which a plain
	 *  `position: absolute` menu can never escape. Defaults to the existing
	 *  anchored behavior (incl. the `.kv-row .select` override) everywhere
	 *  else — opt in only where a Select sits inside such an ancestor. */
	menuPortal?: boolean;
}

/**
 * A themed replacement for `<select>`: a Guild well as the closed control,
 * a menu in the overflow menu's box (`--bg-2`, `--radius`, `--shadow-menu`)
 * with the chosen option marked by a check. The WAI-ARIA select-only
 * combobox: the trigger is the `combobox`, it keeps focus while the list is
 * open and steers the cursor with `aria-activedescendant`, so Tab and blur
 * behave like a native select. Keys: ArrowUp/Down open and move, Home/
 * End jump, Enter/Space pick, Escape closes, a letter jumps to the next
 * option starting with it.
 */
export function Select<V extends string>({
	value,
	options,
	onChange,
	label,
	title,
	disabled,
	className,
	menuClassName,
	menuPortal,
}: SelectProps<V>) {
	const id = useId();
	const [open, setOpen] = useState(false);
	const rawIndex = options.findIndex((o) => o.value === value);
	// AUDIT M8: a value outside `options` (a hand-edited registry field, or a
	// backend vocabulary this frontend's hand-maintained mirror hasn't caught
	// up with — `CANONICAL_EVENTS`, `LSP_MODE_OPTIONS`) used to `Math.max(0,
	// -1) === 0` its way into showing `options[0]`'s label: a WRONG value on
	// screen while the form state still holds the real one. The old native
	// `<select>` rendered blank in this case — wrong, but at least visibly so.
	const missing = rawIndex === -1;
	const selectedIndex = Math.max(0, rawIndex);
	const [active, setActive] = useState(selectedIndex);
	// `options` may shrink while the menu is open; the cursor never points
	// past the last row.
	const activeIdx = Math.min(active, Math.max(0, options.length - 1));
	const wrapRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const menuRef = useRef<HTMLUListElement>(null);

	const openMenu = () => {
		if (disabled) return;
		setActive(selectedIndex);
		setOpen(true);
		// WKWebView does not focus a clicked button; the whole keyboard model
		// (and the blur-to-close) lives on the trigger, so put focus there.
		triggerRef.current?.focus();
	};
	const close = () => setOpen(false);
	const pick = (index: number) => {
		const opt = options[index];
		close();
		if (opt && opt.value !== value) onChange(opt.value);
	};

	// Keep the cursor's row in view in a long list.
	useEffect(() => {
		if (!open) return;
		document.getElementById(`${id}-opt-${activeIdx}`)?.scrollIntoView?.({ block: "nearest" });
	}, [open, activeIdx, id]);

	useEffect(() => {
		if (!open) return;
		const onDown = (e: MouseEvent) => {
			const target = e.target as Node;
			// `wrapRef` (the `.select` div) covers the non-portalled case; a
			// portalled menu lives outside it in the DOM, so a click on one of
			// its options would otherwise read as "outside" and close before the
			// option's own onClick ever lands.
			if (wrapRef.current?.contains(target)) return;
			if (menuPortal && menuRef.current?.contains(target)) return;
			close();
		};
		document.addEventListener("mousedown", onDown);
		return () => document.removeEventListener("mousedown", onDown);
	}, [open, menuPortal]);

	// Default (non-`menuPortal`) case: `.select-menu` is `position: absolute`
	// under the trigger. Near the bottom of a scrolling screen that overflows
	// past the status bar, leaving only the first option on screen. Measure
	// on every open and flip above the trigger when there's more room there.
	const [placement, setPlacement] = useState<"top" | "bottom">("bottom");
	useLayoutEffect(() => {
		if (menuPortal) return; // the portal case flips itself via `fixedPos`
		if (!open) return;
		const trigger = triggerRef.current;
		const menu = menuRef.current;
		if (!trigger || !menu) return;
		const t = trigger.getBoundingClientRect();
		const m = menu.getBoundingClientRect();
		// jsdom (and a not-yet-laid-out menu) reports an all-zero rect — never
		// read that as "overflowing", or every test render would flip.
		if (m.width === 0 && m.height === 0) {
			setPlacement("bottom");
			return;
		}
		const statusBarClearance = 36; // 28px status bar + a little breathing room
		const usableBottom = window.innerHeight - statusBarClearance;
		const menuBottom = t.bottom + 4 + m.height;
		const spaceAbove = t.top;
		const spaceBelow = usableBottom - t.bottom;
		setPlacement(menuBottom > usableBottom && spaceAbove > spaceBelow ? "top" : "bottom");
	}, [open, menuPortal]);

	// `menuPortal` only: measured `position: fixed` coordinates from the
	// trigger's own rect, flipping above when there's no room below —
	// same mechanics as `Popover`. `null` = not positioned yet (rendered
	// invisible for exactly one layout pass, never a visible jump).
	const [fixedPos, setFixedPos] = useState<{ top: number; left: number; width: number } | null>(
		null,
	);
	useLayoutEffect(() => {
		if (!menuPortal) return;
		if (!open) {
			setFixedPos(null);
			return;
		}
		const trigger = triggerRef.current;
		const menu = menuRef.current;
		if (!trigger || !menu) return;
		const t = trigger.getBoundingClientRect();
		const m = menu.getBoundingClientRect();
		const vw = document.documentElement.clientWidth;
		const vh = document.documentElement.clientHeight;
		const gap = 4;
		const edge = 4;
		const spaceBelow = vh - t.bottom;
		const flipUp = spaceBelow < m.height + gap && t.top > m.height + gap;
		const top = flipUp ? t.top - m.height - gap : t.bottom + gap;
		const left = Math.max(edge, Math.min(t.left, vw - m.width - edge));
		setFixedPos({ top, left, width: t.width });
	}, [menuPortal, open]);

	// A scroll on any ancestor (not the menu's own content — scrolling a long
	// option list fires a capture-phase scroll event right here) or a window
	// resize invalidates the measured `fixed` position; closing is simpler
	// than chasing a moving target.
	useEffect(() => {
		if (!menuPortal || !open) return;
		const onScroll = (e: Event) => {
			if (e.target instanceof Node && menuRef.current?.contains(e.target)) return;
			close();
		};
		const onResize = () => close();
		window.addEventListener("scroll", onScroll, true);
		window.addEventListener("resize", onResize);
		return () => {
			window.removeEventListener("scroll", onScroll, true);
			window.removeEventListener("resize", onResize);
		};
	}, [menuPortal, open]);

	const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
		if (disabled) return;
		const count = options.length;
		// While the list is open it owns the keyboard: a typeahead letter must
		// not arm a `g …` chord or the `/` search hotkey on the window.
		if (open) e.stopPropagation();
		if (!open) {
			if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
				e.preventDefault();
				openMenu();
			}
			return;
		}
		switch (e.key) {
			case "ArrowDown":
				e.preventDefault();
				setActive((i) => (i + 1) % count);
				break;
			case "ArrowUp":
				e.preventDefault();
				setActive((i) => (i - 1 + count) % count);
				break;
			case "Home":
				e.preventDefault();
				setActive(0);
				break;
			case "End":
				e.preventDefault();
				setActive(count - 1);
				break;
			case "Enter":
			case " ":
				e.preventDefault();
				pick(activeIdx);
				break;
			case "Escape":
				e.preventDefault();
				e.stopPropagation();
				close();
				break;
			case "Tab":
				close();
				break;
			default: {
				if (e.key.length !== 1 || e.metaKey || e.ctrlKey || e.altKey) return;
				const ch = e.key.toLowerCase();
				for (let step = 1; step <= count; step++) {
					const i = (activeIdx + step) % count;
					if (options[i].label.toLowerCase().startsWith(ch)) {
						setActive(i);
						break;
					}
				}
			}
		}
	};

	const current = options[selectedIndex];
	const optionId = (i: number) => `${id}-opt-${i}`;

	const menu = (
		<ul
			id={`${id}-list`}
			ref={menuRef}
			className={`select-menu${menuClassName ? ` ${menuClassName}` : ""}`}
			role="listbox"
			aria-label={label}
			data-placement={menuPortal ? undefined : placement}
			// The trigger keeps focus; a press on an option must not blur it
			// (which would close the menu before the click lands).
			onMouseDown={(e) => e.preventDefault()}
			style={
				menuPortal
					? {
							position: "fixed",
							top: fixedPos?.top ?? 0,
							left: fixedPos?.left ?? 0,
							minWidth: fixedPos?.width,
							visibility: fixedPos ? "visible" : "hidden",
						}
					: undefined
			}
		>
			{options.map((opt, i) => (
				// eslint-disable-next-line jsx-a11y/click-events-have-key-events -- keys are handled on the combobox trigger, which keeps focus (the ARIA select-only pattern)
				<li
					key={opt.value}
					id={optionId(i)}
					role="option"
					aria-selected={opt.value === value}
					className="select-option"
					data-active={i === activeIdx || undefined}
					data-leading={opt.leading ? "" : undefined}
					onMouseEnter={() => setActive(i)}
					onClick={() => pick(i)}
				>
					<Icon name="check" size={12} className="select-option-check" />
					{/* A leading icon is its OWN grid cell (only when `data-leading` is
					    set — see `.select-option[data-leading]`), between the check and
					    the label; a `dot` still rides INSIDE the label cell as one flex
					    row rather than becoming a grid item of its own. */}
					{/* `aria-hidden`: the icon is identity, the label is the name.
					    Enforced HERE rather than trusted to the caller, so an
					    option can never announce as "Codex Codex". */}
					{opt.leading && (
						<span className="select-option-leading" aria-hidden="true">
							{opt.leading}
						</span>
					)}
					<span className="select-option-main">
						{opt.dot && <span className="dot" style={{ background: opt.dot }} />}
						<span className="select-option-label">{opt.label}</span>
					</span>
					{opt.hint && <span className="select-option-hint">{opt.hint}</span>}
				</li>
			))}
		</ul>
	);

	return (
		<div
			className={`select${open ? " is-open" : ""}${className ? ` ${className}` : ""}`}
			ref={wrapRef}
		>
			{/* The WAI-ARIA select-only combobox: the trigger is the combobox, the
			    list is its popup, and the keyboard lives on the trigger. */}
			<button
				ref={triggerRef}
				type="button"
				role="combobox"
				className="select-trigger"
				aria-label={label}
				aria-haspopup="listbox"
				aria-expanded={open}
				aria-controls={open ? `${id}-list` : undefined}
				aria-activedescendant={open ? optionId(activeIdx) : undefined}
				title={title}
				disabled={disabled}
				data-unknown={missing || undefined}
				onClick={() => (open ? close() : openMenu())}
				onKeyDown={onKeyDown}
				onBlur={close}
			>
				{!missing && current?.leading && (
					<span className="select-trigger-leading" aria-hidden="true">
						{current.leading}
					</span>
				)}
				<span className="select-value" data-unknown={missing || undefined}>
					{!missing && current?.dot && (
						<span className="dot" style={{ background: current.dot }} />
					)}
					{missing ? value : (current?.label ?? value)}
				</span>
				<Icon name="chevron-down" size={11} className="select-chevron" />
			</button>
			{open && (menuPortal ? createPortal(menu, document.body) : menu)}
		</div>
	);
}
