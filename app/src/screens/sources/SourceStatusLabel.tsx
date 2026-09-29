import type { SourceStatus } from "@/types";

const STATUS_META: Record<string, { color: string; label: string }> = {
	"up-to-date": { color: "var(--green)", label: "up to date" },
	"update-available": { color: "var(--blue)", label: "update available" },
	syncing: { color: "var(--anchor-2)", label: "syncing…" },
	error: { color: "var(--red)", label: "auth error" },
	unknown: { color: "var(--fg-dim)", label: "unknown" },
	local: { color: "var(--fg-mute)", label: "local" },
	bundled: { color: "var(--cyan)", label: "bundled" },
};

export function SourceStatusLabel({ status }: { status: SourceStatus | undefined }) {
	const meta = STATUS_META[status ?? "unknown"] ?? {
		color: "var(--fg-dim)",
		label: status ?? "unknown",
	};
	return (
		<span className="source-status">
			<span className="status-dot" style={{ background: meta.color }} />
			<span className="status-label">{meta.label}</span>
		</span>
	);
}
