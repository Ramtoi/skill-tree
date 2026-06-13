import {
	useCallback,
	useEffect,
	useRef,
	useState,
	type CSSProperties,
	type PointerEvent as ReactPointerEvent,
	type ReactNode,
} from "react";

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
}: ResizableSplitProps) {
	const rightFixed = fixedPane === "right";
	const def = rightFixed ? defaultRightPx : defaultLeftPx;
	const min = rightFixed ? minRightPx : minLeftPx;
	const max = rightFixed ? maxRightPx : maxLeftPx;

	const containerRef = useRef<HTMLDivElement | null>(null);
	// `px` is always the width of the *fixed* pane.
	const [px, setPx] = useState<number>(() =>
		clamp(readStoredWidth(storageKey, def), min, max),
	);
	const [dragging, setDragging] = useState(false);

	// If clamp bounds change, keep persisted value in range.
	useEffect(() => {
		setPx((w) => clamp(w, min, max));
	}, [min, max]);

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

	const style: CSSProperties = {
		gridTemplateColumns: rightFixed
			? `1fr 6px ${px}px`
			: `${px}px 6px 1fr`,
	};

	return (
		<div
			ref={containerRef}
			className={`resizable-split${className ? ` ${className}` : ""}`}
			style={style}
		>
			<div className="resizable-split-pane">{left}</div>
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
			<div className="resizable-split-pane">{right}</div>
		</div>
	);
}
