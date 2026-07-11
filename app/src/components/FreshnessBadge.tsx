import type { CSSProperties } from "react";
import { freshnessLabel, type Freshness } from "@/lib/syncFreshness";

export interface FreshnessDotProps {
	state: Freshness;
	size?: number;
	className?: string;
}

/** The four-state freshness indicator (design D4). Color lives only at the
 *  endpoints (fresh→green, error→red); the transitional `stale` state is a
 *  neutral hollow ring + pulse, and `unknown` a dim hollow ring — no hue is
 *  stolen. `prefers-reduced-motion` drops the pulse (handled in App.css),
 *  keeping fill + shape so all four states stay legible. */
export function FreshnessDot({ state, size = 8, className }: FreshnessDotProps) {
	const style: CSSProperties = { width: size, height: size };
	return (
		<span
			className={`fresh-dot ${className ?? ""}`.trim()}
			data-state={state}
			style={style}
			aria-hidden="true"
		/>
	);
}

export interface FreshnessBadgeProps {
	state: Freshness;
	/** Custom label text, or `false` to render the dot alone. Defaults to the
	 *  canonical per-state copy. */
	label?: string | false;
	dotSize?: number;
	className?: string;
}

export function FreshnessBadge({
	state,
	label,
	dotSize,
	className,
}: FreshnessBadgeProps) {
	const showLabel = label !== false;
	const text = typeof label === "string" ? label : freshnessLabel(state);
	return (
		<span
			className={`fresh-badge ${className ?? ""}`.trim()}
			data-state={state}
			role="status"
		>
			<FreshnessDot state={state} size={dotSize} />
			{showLabel && <span className="fresh-label">{text}</span>}
		</span>
	);
}
