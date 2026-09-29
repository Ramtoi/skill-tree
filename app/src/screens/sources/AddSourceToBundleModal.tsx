import { useMemo, useState } from "react";
import { Button } from "@/components/Button";
import { EmptyState } from "@/components/EmptyState";
import { Modal } from "@/components/Modal";
import { useToast } from "@/components/Toast";
import { useRegistry } from "@/hooks/useRegistry";
import { queryClient } from "@/lib/queryClient";
import { invalidateRegistry } from "@/lib/invalidate";
import { trackProcess } from "@/lib/trackProcess";
import {
	bundleWriteLanded,
	errText,
	runRegistryWrite,
	showBundleWarnings,
	type BundleCmdPayload,
} from "@/lib/hubWrite";
import { skillNamesForSource } from "@/lib/skillSource";
import type { SourceView } from "@/types";
import { plural } from "@/screens/sources/sourceFormat";

interface AddSourceToBundleModalProps {
	source: SourceView;
	registry: ReturnType<typeof useRegistry>["data"];
	onClose: () => void;
	/** Hand off to the create-bundle-from-source flow. The zero-bundle state
	 *  told the user to "create a bundle from this source instead" and then gave
	 *  them nothing to click — the instruction and the affordance now match. */
	onCreateBundle: () => void;
}

export function AddSourceToBundleModal({
	source,
	registry,
	onClose,
	onCreateBundle,
}: AddSourceToBundleModalProps) {
	const toast = useToast();
	const [busy, setBusy] = useState(false);
	const skills = useMemo(
		() => skillNamesForSource(registry, source.id),
		[registry, source.id],
	);
	const bundles = useMemo(
		() => Object.entries(registry?.bundles ?? {}),
		[registry],
	);

	async function addTo(bundleName: string, current: string[]) {
		// Union preserving the bundle's existing order, then the new arrivals —
		// bundle order is meaningful (it drives the Bundle editor card order).
		const union = [...current];
		for (const s of skills) if (!union.includes(s)) union.push(s);
		const added = union.length - current.length;
		if (added === 0) {
			toast.info(`${bundleName} already has every skill from ${source.name}`);
			onClose();
			return;
		}
		setBusy(true);
		try {
			// The write and its auto-sync run in one process, so the modal stays
			// open for the whole call — trackProcess reports the wait through the
			// status bar and process tray while it does.
			const { payload, warning } = await trackProcess(
				{
					title: `Adding ${source.name} to ${bundleName}`,
					body: "writing bundle · syncing projects",
					kind: "local",
					// Distinct verb, not `bundle-add:<bundle>:<skill>` with a literal
					// `source` object — a skill literally named "source" could
					// otherwise collide with this modal's own write target.
					target: `bundle-add-source:${bundleName}`,
				},
				() =>
					runRegistryWrite<BundleCmdPayload>(
						["bundle", "update", bundleName, "--skills", union.join(","), "--json"],
						bundleWriteLanded,
					),
				{ successBody: `${plural(added, "skill")} added to ${bundleName}` },
			);
			await invalidateRegistry(queryClient);
			toast.success(`Added ${plural(added, "skill")} to "${bundleName}"`);
			showBundleWarnings(toast, payload);
			if (warning) toast.info("Sync reported findings", warning);
			onClose();
		} catch (err) {
			toast.error("Couldn't update bundle", errText(err));
		} finally {
			setBusy(false);
		}
	}

	return (
		<Modal
			open
			onClose={onClose}
			title={`Add ${source.name} skills to a bundle`}
			width={480}
			dismissable={!busy}
		>
			{bundles.length === 0 ? (
				<EmptyState
					icon="bundle"
					title="No bundles yet"
					description={`A bundle groups skills so a project can equip them in one move. Start one from ${source.name}'s skills.`}
					action={
						<Button
							variant="primary"
							icon="plus"
							data-testid="add-to-bundle-create"
							onClick={onCreateBundle}
						>
							Create a bundle from this source
						</Button>
					}
				/>
			) : (
				<div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
					{bundles.map(([bn, b]) => {
						const current = b.skills ?? [];
						const missing = skills.filter((s) => !current.includes(s));
						// A linked bundle's membership is the source's to decide —
						// hub refuses `--skills` on it, so don't offer the button.
						const linkedTo = b.source;
						return (
							<div
								key={bn}
								className="conflict-row"
								data-testid={`add-to-bundle-${bn}`}
								data-linked={linkedTo ? "true" : undefined}
							>
								<span className="conflict-name text-mono">
									{b.icon} {bn}
								</span>
								<span style={{ fontSize: 11, color: "var(--fg-mute)" }}>
									{linkedTo
										? `follows ${linkedTo} — managed automatically`
										: missing.length === 0
											? "already complete"
											: `+${plural(missing.length, "skill")}`}
								</span>
								<Button
									size="sm"
									variant={missing.length === 0 || linkedTo ? "ghost" : "primary"}
									disabled={busy || missing.length === 0 || !!linkedTo}
									disabledReason={
										linkedTo
											? `${bn} follows ${linkedTo}; its skills are managed by that source.`
											: undefined
									}
									onClick={() => void addTo(bn, current)}
								>
									Add
								</Button>
							</div>
						);
					})}
				</div>
			)}
		</Modal>
	);
}
