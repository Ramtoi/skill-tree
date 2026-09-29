import { StatusBadge } from "@/components/StatusBadge";
import { cloudStatusMeta, type CloudSkillStatus } from "@/lib/cloud";

/**
 * Export-drift pill — a thin `StatusBadge` preset (the same shape `DriftBadge`
 * takes for remotes). The label states what hub KNOWS ("up to date" = matches
 * the last export), never "synced": nothing here is a live connection.
 *
 * `count` renders the cluster form used on the target cards ("2 changed").
 */
export function CloudStatusBadge({
	status,
	count,
}: {
	status: CloudSkillStatus;
	count?: number;
}) {
	const m = cloudStatusMeta(status);
	return (
		<StatusBadge
			channel={m.channel}
			shape="pill"
			motion={m.motion ?? "none"}
			title={m.hint}
			className="cloud-status-badge"
		>
			{count === undefined ? m.label : `${count} ${m.label}`}
		</StatusBadge>
	);
}
