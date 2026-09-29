import { useNavigate } from "react-router-dom";
import { Icon } from "@/components/Icon";
import { BundleChip, type BundleChipAddOption, BundleChipAdd } from "@/components/BundleChip";
import { bundleColor } from "@/components/bundleColors";
import { fromNav, projectBackTarget } from "@/lib/backTarget";
import type { Registry, Project, Bundle } from "@/types";

export function ProjectOverviewBand({
	projectName,
	proj,
	registry,
	globalBundles,
	availableBundles,
	onApplyBundle,
	onRemoveBundle,
	removingBundles = [],
	open,
}: {
	projectName: string;
	proj: Project;
	registry: Registry;
	globalBundles: [string, Bundle][];
	availableBundles: BundleChipAddOption[];
	onApplyBundle: (bundleName: string) => void;
	onRemoveBundle: (bundleName: string) => void;
	removingBundles?: string[];
	open?: (path: string) => void;
}) {
	const navigate = useNavigate();
	const openBundle = (name: string) => open ? open(`/bundle/${encodeURIComponent(name)}`) : navigate(`/bundle/${encodeURIComponent(name)}`, fromNav(projectBackTarget(projectName)));

	return (
		<section className="ws-band ws-band-overview">
			{/* Active bundles */}
			<div className="loadout-section">
				<h3>
					<Icon name="bundle" size={14} />
					<span style={{ whiteSpace: "nowrap" }}>Active bundles</span>
					<span className="count">{new Set([...proj.bundles.filter((name) => registry.bundles[name]), ...globalBundles.map(([name]) => name)]).size}</span>
					<span className="stretch" />
					<span
						style={{
							color: "var(--fg-dim)",
							fontSize: 11,
							fontFamily: "var(--font-mono)",
						}}
					>
						bundle membership stays unchanged
					</span>
				</h3>
				<div>
					{proj.bundles.filter((bn) => registry.bundles[bn]?.scope !== "global").map((bn) => {
						const b = registry.bundles[bn];
						if (!b) return null;
						return (
							<BundleChip
								key={bn}
								name={bn}
								icon={b.icon}
								count={b.skills?.length ?? 0}
								color={bundleColor(bn)}
								onClick={() =>
									openBundle(bn)
								}
								onRemove={() => onRemoveBundle(bn)}
								removeBusy={removingBundles.includes(bn)}
							/>
						);
					})}
					<BundleChipAdd
						available={availableBundles}
						onPick={(name) => onApplyBundle(name)}
					/>
				</div>
				{globalBundles.length > 0 && (
					<div className="global-bundle-cluster">
						<span className="global-bundle-label">
							<Icon name="globe" size={11} />
							Global · auto-applied
						</span>
						<div className="global-bundle-chips">
							{globalBundles.map(([bn, b]) => (
								<BundleChip
									key={bn}
									name={bn}
									icon={b.icon}
									count={b.skills?.length ?? 0}
									color={bundleColor(bn)}
                  onRemove={proj.bundles.includes(bn) ? () => onRemoveBundle(bn) : undefined}
                  removeBusy={removingBundles.includes(bn)}
                  removeTitle={`Remove project attachment of ${bn}; remains globally applied`}
									onClick={() =>
										openBundle(bn)
									}
								/>
							))}
						</div>
					</div>
				)}
			</div>

		</section>
	);
}
