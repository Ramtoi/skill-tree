import { Icon } from "@/components/Icon";
import type { SnippetStatus } from "@/types/snippets";

// Status vocabulary (design handoff §2): applied=green; outdated & modified are
// BOTH amber — "needs your attention" — differentiated by glyph + label, never
// by hue; orphaned is muted with a red-leaning tint. The damaged-marker warning
// is a file-level concern (red), rendered by the strip, not a block status.
export const SNIP_STATUS: Record<
	SnippetStatus,
	{ label: string; icon: string }
> = {
	applied: { label: "applied", icon: "check" },
	outdated: { label: "outdated", icon: "state.update" },
	modified: { label: "modified", icon: "edit" },
	orphaned: { label: "orphaned", icon: "warning" },
};

export function SnippetStatusBadge({ status }: { status: SnippetStatus }) {
	const m = SNIP_STATUS[status] ?? SNIP_STATUS.applied;
	return (
		<span className="snip-badge" data-status={status} title={m.label}>
			<Icon name={m.icon} size={9} />
			<span>{m.label}</span>
		</span>
	);
}
