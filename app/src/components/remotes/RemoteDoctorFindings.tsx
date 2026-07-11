import { Icon } from "@/components/Icon";
import { RiskBadge } from "@/components/RiskBadge";
import type { RemoteDoctorFinding } from "@/hooks/useRemotes";

/** Human explanation per doctor `code`. The CLI only ships `code` + `detail`
 *  (the raw sentence); this gives each risk a short, plain headline the way the
 *  permissions doctor does, with the mono `detail` underneath. Unknown codes
 *  fall back to the code itself so a new backend check still renders. */
const CODE_EXPLANATIONS: Record<string, string> = {
	"host-key-mismatch":
		"Host key changed — possible machine-in-the-middle; sync will hard-fail",
	"host-key-unpinned": "Host key not pinned (TOFU not completed)",
	"host-key-unreadable": "Couldn't read the live host key to verify the pin",
	unreachable: "Sync is enabled but the box is unreachable",
	"unresolved-drift": "Artifacts drifted or conflicting — sync silently skips them",
	"stale-sidecar": "Stale ownership entry (nothing left to clean)",
	"signing-unpinned": "Hub-managed skills but no signing key pinned",
	"health-error": "Health check errored",
	"plan-error": "Couldn't compute the drift plan",
	"unknown-connector": "Unknown connector",
};

export function explainRemoteFinding(code: string): string {
	return CODE_EXPLANATIONS[code] ?? code;
}

/** List-level danger banner: shown only when the aggregate doctor rollup has ≥1
 *  `danger` finding (e.g. a host-key mismatch = MITM). Reuses the existing
 *  `.remote-health-banner` error styling so it reads like the per-remote banner.
 *  A pure signal — the detail surfaces the per-remote breakdown. */
export function RemoteDoctorBanner({
	findings,
	onOpenRemote,
}: {
	findings: RemoteDoctorFinding[];
	onOpenRemote?: (id: string) => void;
}) {
	const danger = findings.filter((f) => f.severity === "danger");
	if (danger.length === 0) return null;
	const remotes = Array.from(new Set(danger.map((f) => f.remote)));
	return (
		<div
			className="remote-health-banner"
			data-tone="error"
			role="alert"
			data-testid="remote-doctor-banner"
		>
			<Icon name="warning" size={13} />
			<div className="remote-health-banner-body">
				<span>
					<strong>
						{danger.length} remote risk{danger.length === 1 ? "" : "s"} need
						{danger.length === 1 ? "s" : ""} attention.
					</strong>{" "}
					{danger.length === 1
						? explainRemoteFinding(danger[0].code)
						: "Open the affected remotes to review each finding."}
				</span>
				<div className="remote-doctor-banner-remotes">
					{remotes.map((rid) => (
						<button
							key={rid}
							type="button"
							className="remote-doctor-banner-link text-mono"
							onClick={() => onOpenRemote?.(rid)}
						>
							{rid}
						</button>
					))}
				</div>
			</div>
		</div>
	);
}

/** Detail-level findings section: every doctor finding for one remote, ordered
 *  danger-first, mirroring the permissions doctor's RiskBadge + explanation +
 *  mono-detail grammar. Renders nothing when the remote is clean. */
export function RemoteDoctorFindingsList({
	findings,
}: {
	findings: RemoteDoctorFinding[];
}) {
	if (findings.length === 0) {
		return (
			<div className="remote-doctor-clean" role="status">
				<Icon name="state.ok" size={13} />
				<span>No risks detected for this remote.</span>
			</div>
		);
	}
	const ordered = [...findings].sort((a, b) =>
		a.severity === b.severity ? 0 : a.severity === "danger" ? -1 : 1,
	);
	return (
		<div className="remote-doctor-list">
			{ordered.map((f, i) => (
				<div
					className="remote-doctor-finding"
					key={`${f.code}:${i}`}
					data-severity={f.severity}
				>
					<RiskBadge
						code={f.code}
						severity={f.severity}
						explanation={explainRemoteFinding(f.code)}
						detail={f.detail}
					/>
					<div className="remote-doctor-finding-body">
						<div className="remote-doctor-finding-head">
							{explainRemoteFinding(f.code)}
						</div>
						<div className="remote-doctor-finding-detail text-mono text-dim">
							{f.detail}
						</div>
					</div>
				</div>
			))}
		</div>
	);
}
