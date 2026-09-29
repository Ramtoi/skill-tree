import type { CSSProperties, ReactNode } from "react";

export type PlaqueAccent = "anchor" | "amber" | "red";

export interface PlaqueProps {
	/** Mono uppercase head — the plaque's register in words (e.g. "External
	 *  source", "Not created yet"). */
	eyebrow: ReactNode;
	/** Sets `--banner-accent`. The corner ticks and a chip's status dot read
	 *  it — never a tinted skin, the plaque itself stays flat. */
	accent: PlaqueAccent;
	/** Everything between the chip and the actions row, in the caller's own
	 *  order (a meta line, the copy paragraph, an optional hedge — rendered
	 *  as-is, not re-wrapped). */
	children: ReactNode;
	/** An identity chip under the head (e.g. `SourceChip`). */
	chip?: ReactNode;
	/** The action row. Always last. */
	actions?: ReactNode;
	className?: string;
	"data-testid"?: string;
	role?: string;
	"aria-live"?: "polite" | "assertive" | "off";
	/** Accessible name override — a blocking prompt (`role="alertdialog"`) needs
	 *  one distinct from its eyebrow text. */
	"aria-label"?: string;
	/** Arbitrary data-* pass-through for a caller's own instrumentation
	 *  (e.g. `data-source`, `data-reason`) — Plaque itself never reads these. */
	[dataAttr: `data-${string}`]: string | undefined;
}

/**
 * The generic plaque at the top of an editor side panel: a Guild container —
 * flat `--surface-panel`, one neutral hairline, `--engrave`, `--radius-frame`,
 * inset from the panel edges. Its register rides on its corner ticks
 * (`--banner-accent`, always lit) and a chip's status dot — never a tinted
 * skin. Composes the historically-named `.source-banner*` classes (see
 * COMPONENTS.md §Plaque) — `ExternalSourceBanner` and `DroppedUpstreamBanner`
 * are its two callers, and any panel outside the skill editor reaches for
 * this directly.
 */
export function Plaque({
	eyebrow,
	accent,
	children,
	chip,
	actions,
	className,
	...rest
}: PlaqueProps) {
	return (
		<div
			className={className ? `source-banner ${className}` : "source-banner"}
			style={{ "--banner-accent": `var(--${accent})` } as CSSProperties}
			{...rest}
		>
			<div className="source-banner-head">
				<span className="source-banner-title">{eyebrow}</span>
			</div>
			{chip && <div className="source-banner-chip">{chip}</div>}
			{children}
			{actions && <div className="source-banner-actions">{actions}</div>}
		</div>
	);
}
