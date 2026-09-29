import { Button } from "../Button";
import { Icon } from "../Icon";
import type { PermissionsDivergence } from "@/types/permissions";

/**
 * Registry-vs-native divergence banner (permissions-divergence-fixes):
 * - staleness: the scope's registry block changed after the last native write
 *   (block hash vs the v2 sidecar's `block_sha256`) — offer a sync;
 * - unmanaged: native rules hub does not manage (kept rules excluded) — offer
 *   the reconcile drawer.
 * Renders nothing when neither signal is present, so the screen stays quiet
 * in the healthy state.
 */
export function PermissionsDivergenceBanner({
	divergence,
	syncing,
	onSync,
	onReview,
}: {
	divergence: PermissionsDivergence | null;
	syncing: boolean;
	onSync: () => void;
	onReview: () => void;
}) {
	if (!divergence) return null;
	const stale = divergence.stale === true;
	const unmanaged = divergence.unmanaged_count;
	if (!stale && unmanaged === 0) return null;
	return (
		<div className="perm-divergence-banner" data-stale={stale || undefined}>
			<Icon name={stale ? "refresh" : "eye"} size={14} />
			<div className="perm-divergence-body">
				{stale && (
					<span className="perm-divergence-item">
						<strong>Registry changed since the last native write</strong>
						{divergence.last_written_at && (
							<span className="perm-divergence-detail">
								{" "}
								— files written {divergence.last_written_at}
							</span>
						)}
					</span>
				)}
				{stale && unmanaged > 0 && <span className="perm-risk-sep"> · </span>}
				{unmanaged > 0 && (
					<span className="perm-divergence-item">
						<strong>
							{unmanaged} unmanaged native rule{unmanaged === 1 ? "" : "s"}
						</strong>
						<span className="perm-divergence-detail">
							{" "}
							— in the harness files, outside hub
						</span>
					</span>
				)}
			</div>
			{unmanaged > 0 && (
				<button type="button" className="perm-risk-action" onClick={onReview}>
					Review →
				</button>
			)}
			{stale && (
				<Button size="sm" icon="refresh" busy={syncing} onClick={onSync}>
					{syncing ? "Syncing…" : "Sync now"}
				</Button>
			)}
		</div>
	);
}
