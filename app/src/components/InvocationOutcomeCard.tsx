import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon";
import { StatusBadge } from "./StatusBadge";
import { focusedTooltipPosition, tooltipPositionStyle, useTooltipPosition, type TooltipPosition } from "./tooltipPosition";
import type { invocationOutcomeLabel } from "@/lib/invocation";

/** A stable two-line summary with the full evidence available on hover or focus. */
export function InvocationOutcomeCard({ label, summary, details, meta, support, active, onActivate }: {
	label: string;
	summary: string;
	details: string[];
	meta: ReturnType<typeof invocationOutcomeLabel>;
	support?: string;
	active: boolean;
	onActivate: () => void;
}) {
	const id = useId();
	const [position, setPosition] = useState<TooltipPosition | null>(null);
	const anchor = useRef<HTMLButtonElement>(null);
	const openedRect = useRef<DOMRect | null>(null);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const hovered = useRef(false);
	const focused = useRef(false);
	const tooltip = useTooltipPosition(position, details.join("\n"));
	const clearTimer = useCallback(() => {
		if (timer.current !== null) clearTimeout(timer.current);
		timer.current = null;
	}, []);
	const hide = useCallback(() => { clearTimer(); setPosition(null); }, [clearTimer]);
	const show = () => {
		clearTimer();
		onActivate();
		if (anchor.current) {
			openedRect.current = anchor.current.getBoundingClientRect();
			setPosition(focusedTooltipPosition(anchor.current));
		}
	};
	const leave = () => {
		hovered.current = false;
		clearTimer();
		if (!focused.current) timer.current = setTimeout(hide, 150);
	};
	useEffect(() => {
		const dismiss = (event: KeyboardEvent) => {
			if (active && position && event.key === "Escape") { event.stopPropagation(); hide(); }
		};
		const onScroll = (event: Event) => {
			if (event.target instanceof Node && tooltip.current?.contains(event.target)) return;
			// Focusing a card can queue a menu scroll before the tooltip opens.
			// Dismiss only if a later scroll actually moves the anchor.
			const rect = anchor.current?.getBoundingClientRect();
			if (rect && rect.top === openedRect.current?.top && rect.left === openedRect.current?.left) return;
			hide();
		};
		document.addEventListener("keydown", dismiss, true);
		window.addEventListener("scroll", onScroll, true);
		window.addEventListener("resize", hide);
		return () => {
			document.removeEventListener("keydown", dismiss, true);
			window.removeEventListener("scroll", onScroll, true);
			window.removeEventListener("resize", hide);
			clearTimer();
		};
	}, [active, position, hide, clearTimer, tooltip]);
	return (
		<li className="invocation-outcome-row" data-support={support}>
			<button type="button" className="invocation-outcome-card" ref={anchor}
				aria-label={`${label}: ${meta.label}. ${summary}. Details`} aria-describedby={active && position ? id : undefined}
				onMouseEnter={() => { hovered.current = true; clearTimer(); timer.current = setTimeout(show, 250); }}
				onMouseLeave={leave}
				onFocus={() => { focused.current = true; show(); }}
				onBlur={() => { focused.current = false; if (!hovered.current) hide(); }}
				onClick={show}
			>
				<span className="invocation-outcome-title">
					<span className="invocation-outcome-harness">{label}</span>
					<StatusBadge channel={meta.channel} motion={meta.label === "Will apply on sync" ? "pulse" : "none"}>{meta.label}</StatusBadge>
				</span>
				<span className="invocation-outcome-body">
					<span className="invocation-outcome-copy">{summary}</span>
					<Icon name="info" size={12} />
				</span>
			</button>
			{active && position && createPortal(
				// Pointer listeners let the reader move onto the tooltip and keep it open.
				// eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
				<div id={id} role="tooltip" className="invocation-outcome-tooltip" ref={tooltip}
					style={tooltipPositionStyle(position)}
					onMouseEnter={() => { hovered.current = true; clearTimer(); }} onMouseLeave={leave}>
					<strong>{label} · {meta.label}</strong>
					{details.map((detail) => <p key={detail}>{detail}</p>)}
				</div>, document.body,
			)}
		</li>
	);
}
