import { StatusBadge, type BadgeChannel } from "@/components/StatusBadge";
import type { SnippetStatus } from "@/types/snippets";

// Status vocabulary (design handoff §2): applied=green; outdated & modified are
// transitional drift-from-library — the FreshnessBadge-stale grammar (neutral
// fill + motion), differentiated by glyph + label, never amber (reserved for
// direct-equip provenance, §5.2); orphaned is muted (neutral). The damaged-
// marker warning is a file-level concern (red), rendered by the strip.
export const SNIP_STATUS: Record<
	SnippetStatus,
	{ label: string; icon: string }
> = {
	applied: { label: "applied", icon: "check" },
	outdated: { label: "outdated", icon: "state.update" },
	modified: { label: "modified", icon: "edit" },
	orphaned: { label: "orphaned", icon: "warning" },
};

// Domain status → StatusBadge channel (D10). Post-sweep: outdated/modified are
// transitional, so they carry the neutral channel + a hollow ring + pulse
// (FreshnessBadge stale treatment) rather than amber.
const SNIPPET_STATUS_CHANNEL: Record<SnippetStatus, BadgeChannel> = {
	applied: "ok",
	outdated: "neutral",
	modified: "neutral",
	orphaned: "neutral",
};

/** The channel/label/shape/motion a status maps to, for a caller that
 *  renders its own dot + word (a row too narrow for the pill preset below —
 *  a filename column needs the room instead). `modified` gets its own
 *  ornament, a hollow ring around its edit glyph — otherwise it and
 *  `outdated` would both be the identical neutral pulsing dot, and
 *  `modified` is exactly the state where Remove discards the user's own
 *  in-file edits (the one state that most needs to read at a glance,
 *  never just on hover). */
export function snipStatusMeta(status: SnippetStatus): {
	label: string;
	channel: BadgeChannel;
	shape: "dot" | "ring";
	icon: string;
	transitional: boolean;
} {
	const m = SNIP_STATUS[status] ?? SNIP_STATUS.applied;
	return {
		label: m.label,
		channel: SNIPPET_STATUS_CHANNEL[status] ?? "ok",
		shape: status === "modified" ? "ring" : "dot",
		icon: m.icon,
		transitional: status === "outdated" || status === "modified",
	};
}

/** Snippet-marker status pill — a thin preset of `StatusBadge` (D10). */
export function SnippetStatusBadge({ status }: { status: SnippetStatus }) {
	const m = SNIP_STATUS[status] ?? SNIP_STATUS.applied;
	const transitional = status === "outdated" || status === "modified";
	return (
		<StatusBadge
			channel={SNIPPET_STATUS_CHANNEL[status] ?? "ok"}
			shape={transitional ? "ring" : "pill"}
			motion={transitional ? "pulse" : "none"}
			icon={m.icon}
			title={m.label}
			className="snip-badge"
		>
			{m.label}
		</StatusBadge>
	);
}
