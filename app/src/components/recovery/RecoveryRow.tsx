import type { ReactNode } from "react";
import { StatusBadge, type BadgeChannel } from "@/components/StatusBadge";
import type { RecoveryRowStatus } from "@/lib/recoveryContract";

const STATUS_CHANNEL: Record<RecoveryRowStatus, BadgeChannel> = {
	ready: "ok",
	running: "info",
	pending: "neutral",
	skipped: "neutral",
	deferred: "neutral",
	failed: "error",
	interrupted: "warn",
};

const STATUS_LABEL: Record<RecoveryRowStatus, string> = {
	ready: "Ready",
	running: "Working…",
	pending: "Needs attention",
	skipped: "Skipped",
	deferred: "Deferred",
	failed: "Failed",
	interrupted: "Interrupted",
};

/** One status badge, consistently mapped for every recovery row kind (source,
 *  project, local-only source) — a project card and a source row must never
 *  disagree about what "interrupted" looks like. */
export function RecoveryStatusBadge({ status }: { status: RecoveryRowStatus }) {
	return (
		<StatusBadge
			channel={STATUS_CHANNEL[status]}
			shape="dot"
			motion={status === "running" ? "pulse" : "none"}
			ariaLabel={STATUS_LABEL[status]}
			title={STATUS_LABEL[status]}
		/>
	);
}

export function RecoveryRow({
	status,
	name,
	detail,
	path,
	actions,
	testId,
}: {
	status: RecoveryRowStatus;
	name: ReactNode;
	detail?: ReactNode;
	path?: string | null;
	actions: ReactNode;
	testId?: string;
}) {
	return (
		<div className="recovery-row" data-status={status} data-testid={testId}>
			<RecoveryStatusBadge status={status} />
			<div className="recovery-row-main">
				<div className="recovery-row-head">
					<span className="recovery-row-name">{name}</span>
				</div>
				{detail && <div className="recovery-row-detail">{detail}</div>}
				{path && (
					<div className="recovery-row-path" title={path}>
						{path}
					</div>
				)}
			</div>
			<div className="recovery-row-actions">{actions}</div>
		</div>
	);
}

export function RecoveryRowEmpty({ children }: { children: ReactNode }) {
	return <p className="recovery-row-empty">{children}</p>;
}
