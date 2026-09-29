import {
	useCallback,
	useEffect,
	useRef,
	useState,
	type CSSProperties,
	type PointerEvent as ReactPointerEvent,
	type ReactNode,
} from "react";
import { Icon } from "./Icon";

export interface ResizableSplitProps {
	storageKey: string;
	/** Which pane keeps a fixed px width; the other takes `1fr`. Default "left". */
	fixedPane?: "left" | "right";
	/** Used when fixedPane === "left". */
	defaultLeftPx?: number;
	minLeftPx?: number;
	maxLeftPx?: number;
	/** Used when fixedPane === "right". */
	defaultRightPx?: number;
	minRightPx?: number;
	maxRightPx?: number;
	left: ReactNode;
	right: ReactNode;
	className?: string;
	handleAriaLabel?: string;
	/** Whether the fixed pane can be collapsed / auto-collapses. Default true. */
	collapsible?: boolean;
	/**
	 * Minimum width the FLEXIBLE (non-fixed) pane needs. When the container can't
	 * fit `fixedPx + minMainPx`, the fixed pane auto-collapses (overlay mode).
	 * Default 440.
	 */
	minMainPx?: number;
	/** Aria-label for the collapse / reopen toggle. */
	collapseAriaLabel?: string;
	/** Short label shown on the reopen tab (e.g. "Details" / "Map"). Default "Panel". */
	paneLabel?: string;
}

function readStoredWidth(key: string, fallback: number): number {
	if (typeof window === "undefined") return fallback;
	try {
		const raw = window.localStorage.getItem(key);
		if (!raw) return fallback;
		const parsed = Number.parseFloat(raw);
		if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
		return parsed;
	} catch {
		return fallback;
	}
}

function readStoredCollapsed(key: string): boolean | undefined {
	if (typeof window === "undefined") return undefined;
	try {
		const raw = window.localStorage.getItem(key);
		if (raw === "1") return true;
		if (raw === "0") return false;
		return undefined;
	} catch {
		return undefined;
	}
}

function clamp(value: number, min: number, max: number): number {
	if (value < min) return min;
	if (value > max) return max;
	return value;
}

export function ResizableSplit({
	storageKey,
	fixedPane = "left",
	defaultLeftPx = 304,
	minLeftPx = 220,
	maxLeftPx = 600,
	defaultRightPx = 360,
	minRightPx = 280,
	maxRightPx = 560,
	left,
	right,
	className,
	handleAriaLabel = "Resize columns",
	collapsible = true,
	minMainPx = 440,
	collapseAriaLabel,
	paneLabel = "Panel",
}: ResizableSplitProps) {
	const rightFixed = fixedPane === "right";
	const def = rightFixed ? defaultRightPx : defaultLeftPx;
	const min = rightFixed ? minRightPx : minLeftPx;
	const max = rightFixed ? maxRightPx : maxLeftPx;
	const collapsedKey = `${storageKey}:collapsed`;

	const containerRef = useRef<HTMLDivElement | null>(null);
	// `px` is always the width of the *fixed* pane.
	const [px, setPx] = useState<number>(() =>
		clamp(readStoredWidth(storageKey, def), min, max),
	);
	const [dragging, setDragging] = useState(false);

	// Persisted explicit user choice. undefined = no explicit choice (default open).
	const [userCollapsed, setUserCollapsed] = useState<boolean | undefined>(() =>
		readStoredCollapsed(collapsedKey),
	);
	// Driven by ResizeObserver: container too narrow to dock the fixed pane.
	const [tooNarrow, setTooNarrow] = useState(false);
	// Container width (px) — used to clamp the overlay width.
	const [containerWidth, setContainerWidth] = useState(0);
	// When tooNarrow, the pane is presented as an overlay; this tracks open state.
	const [overlayOpen, setOverlayOpen] = useState(false);

	// If clamp bounds change, keep persisted value in range.
	useEffect(() => {
		setPx((w) => clamp(w, min, max));
	}, [min, max]);

	// Observe container width → derive tooNarrow.
	useEffect(() => {
		const el = containerRef.current;
		if (!el || typeof ResizeObserver === "undefined") return;
		const measure = (width: number) => {
			setContainerWidth(width);
			if (!collapsible) {
				setTooNarrow(false);
				return;
			}
			setTooNarrow(width > 0 && width < px + minMainPx);
		};
		const ro = new ResizeObserver((entries) => {
			for (const entry of entries) {
				measure(entry.contentRect.width);
			}
		});
		ro.observe(el);
		// Prime synchronously so the first paint is correct.
		measure(el.getBoundingClientRect().width);
		return () => ro.disconnect();
	}, [collapsible, minMainPx, px]);

	// Reset the overlay-open state whenever the docking mode flips.
	useEffect(() => {
		setOverlayOpen(false);
	}, [tooNarrow]);

	const persist = useCallback(
		(value: number) => {
			try {
				window.localStorage.setItem(storageKey, String(Math.round(value)));
			} catch {
				/* ignore */
			}
		},
		[storageKey],
	);

	const persistCollapsed = useCallback(
		(value: boolean) => {
			try {
				window.localStorage.setItem(collapsedKey, value ? "1" : "0");
			} catch {
				/* ignore */
			}
		},
		[collapsedKey],
	);

	const onPointerDown = useCallback(
		(e: ReactPointerEvent<HTMLDivElement>) => {
			if (e.button !== 0) return;
			e.preventDefault();
			const container = containerRef.current;
			if (!container) return;
			setDragging(true);
			const startRect = container.getBoundingClientRect();
			const target = e.currentTarget;
			try {
				target.setPointerCapture(e.pointerId);
			} catch {
				/* ignore — capture is best-effort */
			}

			let latest = px;
			const onMove = (ev: PointerEvent) => {
				// Left-fixed: pane width = pointer distance from left edge.
				// Right-fixed: pane width = distance from the right edge (rightward
				// drag shrinks the right pane).
				const raw = rightFixed
					? startRect.right - ev.clientX
					: ev.clientX - startRect.left;
				const next = clamp(raw, min, max);
				latest = next;
				setPx(next);
			};
			const onUp = (ev: PointerEvent) => {
				setDragging(false);
				persist(latest);
				try {
					target.releasePointerCapture(ev.pointerId);
				} catch {
					/* ignore */
				}
				window.removeEventListener("pointermove", onMove);
				window.removeEventListener("pointerup", onUp);
				window.removeEventListener("pointercancel", onUp);
			};
			window.addEventListener("pointermove", onMove);
			window.addEventListener("pointerup", onUp);
			window.addEventListener("pointercancel", onUp);
		},
		[px, min, max, persist, rightFixed],
	);

	const onKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLDivElement>) => {
			const step = e.shiftKey ? 32 : 8;
			let next: number | null = null;
			// The splitter moves consistently with the key direction:
			// Left arrow moves the divider left, Right arrow moves it right.
			// Left-fixed: divider-left → smaller left pane.
			// Right-fixed: divider-left → larger right pane.
			if (e.key === "ArrowLeft") next = rightFixed ? px + step : px - step;
			else if (e.key === "ArrowRight") next = rightFixed ? px - step : px + step;
			else if (e.key === "Home") next = min;
			else if (e.key === "End") next = max;
			if (next == null) return;
			e.preventDefault();
			const clamped = clamp(next, min, max);
			setPx(clamped);
			persist(clamped);
		},
		[px, min, max, persist, rightFixed],
	);

	// ── Derived view state ────────────────────────────────────────────────
	const docked = !tooNarrow;
	// Inline-visible (docked) open state.
	const dockedOpen = docked && userCollapsed !== true;
	// Whether the fixed pane is shown at all (docked inline OR overlay).
	const open = docked ? userCollapsed !== true : overlayOpen;

	const fixedSide = rightFixed ? "right" : "left";

	// Collapse the docked pane.
	const collapse = useCallback(() => {
		setUserCollapsed(true);
		persistCollapsed(true);
	}, [persistCollapsed]);

	// Reopen / toggle. Docked: flips userCollapsed. tooNarrow: toggles overlay.
	const reopen = useCallback(() => {
		if (docked) {
			setUserCollapsed(false);
			persistCollapsed(false);
		} else {
			setOverlayOpen(true);
		}
	}, [docked, persistCollapsed]);

	const closeOverlay = useCallback(() => setOverlayOpen(false), []);

	// Escape closes the overlay.
	useEffect(() => {
		if (!(tooNarrow && overlayOpen)) return;
		const onEsc = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				setOverlayOpen(false);
			}
		};
		window.addEventListener("keydown", onEsc);
		return () => window.removeEventListener("keydown", onEsc);
	}, [tooNarrow, overlayOpen]);

	const reopenLabel = collapseAriaLabel ?? `Open ${paneLabel}`;
	const collapseLabel = collapseAriaLabel ?? `Collapse ${paneLabel}`;

	const fixedNode = rightFixed ? right : left;
	const flexNode = rightFixed ? left : right;

	// Grid template: single column for main when the fixed pane is not docked-open.
	const style: CSSProperties = dockedOpen
		? {
				gridTemplateColumns: rightFixed
					? `1fr 6px ${px}px`
					: `${px}px 6px 1fr`,
			}
		: { gridTemplateColumns: "1fr" };

	// Overlay width: clamp(stored px, min, min(max, containerWidth - 48)).
	const overlayMax =
		containerWidth > 0 ? Math.min(max, containerWidth - 48) : max;
	const overlayWidth = clamp(px, min, Math.max(min, overlayMax));

	// Chevron direction is set in CSS via the rs-left / rs-right side class
	// (only chevron-right exists in the icon set; left variants rotate 180°).

	// Build the docked-open content (handle + collapse affordance).
	const handle = (
		<div
			role="separator"
			aria-orientation="vertical"
			aria-label={handleAriaLabel}
			aria-valuemin={min}
			aria-valuemax={max}
			aria-valuenow={Math.round(px)}
			tabIndex={0}
			className={`resizable-split-handle${dragging ? " is-dragging" : ""}`}
			onPointerDown={onPointerDown}
			onKeyDown={onKeyDown}
		/>
	);

	const collapseBtn = collapsible ? (
		<button
			type="button"
			className={`resizable-split-collapse rs-${fixedSide}`}
			aria-label={collapseLabel}
			title={collapseLabel}
			onClick={collapse}
		>
			<Icon name="chevron-right" size={12} />
		</button>
	) : null;

	const reopenTab =
		collapsible && !open ? (
			<button
				type="button"
				className={`resizable-split-reopen rs-${fixedSide}`}
				aria-label={reopenLabel}
				title={reopenLabel}
				onClick={reopen}
			>
				<Icon name="chevron-right" size={12} />
				<span className="resizable-split-reopen-label">{paneLabel}</span>
			</button>
		) : null;

	if (dockedOpen) {
		// Standard resizable two-pane grid.
		return (
			<div
				ref={containerRef}
				className={`resizable-split is-docked${className ? ` ${className}` : ""}`}
				style={style}
			>
				{rightFixed ? (
					<>
						<div className="resizable-split-pane">{flexNode}</div>
						{handle}
						<div className="resizable-split-pane resizable-split-fixed">
							{collapseBtn}
							{fixedNode}
						</div>
					</>
				) : (
					<>
						<div className="resizable-split-pane resizable-split-fixed">
							{collapseBtn}
							{fixedNode}
						</div>
						{handle}
						<div className="resizable-split-pane">{flexNode}</div>
					</>
				)}
			</div>
		);
	}

	// Collapsed (docked + userCollapsed) OR tooNarrow (overlay) — main is full width.
	return (
		<div
			ref={containerRef}
			className={`resizable-split is-collapsed${className ? ` ${className}` : ""}`}
			style={style}
		>
			<div className="resizable-split-pane">{flexNode}</div>
			{reopenTab}
			{tooNarrow && overlayOpen ? (
				<>
					<div
						className="resizable-split-scrim"
						onClick={closeOverlay}
						aria-hidden="true"
					/>
					<div
						className={`resizable-split-pane resizable-split-overlay rs-${fixedSide}`}
						style={{ width: `${Math.round(overlayWidth)}px` }}
					>
						<button
							type="button"
							className="resizable-split-overlay-close"
							aria-label={`Close ${paneLabel}`}
							title={`Close ${paneLabel}`}
							onClick={closeOverlay}
						>
							<Icon name="x" size={12} />
						</button>
						{fixedNode}
					</div>
				</>
			) : null}
		</div>
	);
}
