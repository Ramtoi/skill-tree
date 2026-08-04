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
