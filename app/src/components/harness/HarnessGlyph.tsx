import { type CSSProperties } from "react";
import {
	harnessBrand,
	harnessDisplayLabel,
	harnessIcon,
	harnessInitials,
} from "./harnessRegistry";

export interface HarnessGlyphProps {
	id: string;
	label?: string;
	size?: number;
	className?: string;
	decorative?: boolean;
}

/**
 * The visual identity of a harness — a small brand mark in the harness accent
 * color. Unknown harness ids fall back to the old monogram chip.
 * Reused across the Sync-card pills, the add menu, the Agent Docs
 * strip, and the global Harnesses cards.
 */
export function HarnessGlyph({
	id,
	label,
	size = 18,
	className,
	decorative = false,
}: HarnessGlyphProps) {
	// Identity = logo shape in its brand color, else neutral --fg-strong.
	// Never a semantic accent token — the quiet chip backing is the same for all.
	const glyphColor = harnessBrand(id) ?? "var(--fg-strong)";
	const resolvedLabel = label ?? harnessDisplayLabel(id);
	const icon = harnessIcon(id);
	const style: CSSProperties = {
		["--harness-accent" as string]: glyphColor,
		width: size,
		height: size,
		fontSize: Math.round(size * 0.5),
	};
	const iconStyle: CSSProperties | undefined = icon
		? { ["--harness-icon" as string]: `url("${icon}")` }
		: undefined;
	const cls = [
		"harness-glyph",
		icon ? "has-icon" : "has-monogram",
		className,
	]
		.filter(Boolean)
		.join(" ");

	return (
		<span
			className={cls}
			data-harness={id}
			style={style}
			title={resolvedLabel}
			role={decorative ? undefined : "img"}
			aria-label={decorative ? undefined : resolvedLabel}
			aria-hidden={decorative || undefined}
		>
			{icon ? (
				<span className="harness-glyph-mask" style={iconStyle} />
			) : (
				harnessInitials(resolvedLabel)
			)}
		</span>
	);
}

export interface HarnessIconGroupProps {
	ids: string[];
	labels?: Record<string, string>;
	size?: number;
	maxVisible?: number;
	className?: string;
}

export function HarnessIconGroup({
	ids,
	labels,
	size = 16,
	maxVisible = 4,
	className,
}: HarnessIconGroupProps) {
	const names = ids.map((id) => harnessDisplayLabel(id, labels));
	const visible = ids.slice(0, maxVisible);
	const overflow = ids.length - visible.length;
	if (ids.length === 0) return null;
	return (
		<span
			className={["harness-icon-group", className].filter(Boolean).join(" ")}
			title={names.join(", ")}
			aria-label={names.join(", ")}
		>
			{visible.map((id) => (
				<HarnessGlyph
					key={id}
					id={id}
					label={harnessDisplayLabel(id, labels)}
					size={size}
					decorative
				/>
			))}
			{overflow > 0 && <span className="harness-icon-more">+{overflow}</span>}
		</span>
	);
}
