import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/components/Toast";
import { qk } from "@/lib/queryKeys";
import { invalidateRegistry } from "@/lib/invalidate";
import {
	bundleWriteLanded, errText, runRegistryWrite, showBundleWarnings,
	type BundleCmdPayload,
} from "@/lib/hubWrite";
import type { Registry } from "@/types";

/** Saves only scope, in the same queue as the bundle's other edits. */
export function useBundleScope(
	bundleName: string | undefined,
	enqueue: (write: () => Promise<void>) => Promise<void>,
	isBlocked: () => boolean,
) {
	const queryClient = useQueryClient();
	const toast = useToast();
	const busyRef = useRef(false);
	const [scopeRequest, setScopeRequest] = useState<{ name: string; target: boolean } | null>(null);
	const target = scopeRequest && scopeRequest.name === bundleName ? scopeRequest.target : null;

	const toggle = (next: boolean) => {
		if (!bundleName || busyRef.current || isBlocked()) return;
		busyRef.current = true;
		setScopeRequest({ name: bundleName, target: next });
		void enqueue(async () => {
			let landed = false;
			try {
				const { payload, warning } = await runRegistryWrite<BundleCmdPayload>(
					["bundle", "update", bundleName, "--scope", next ? "global" : "project-specific", "--json"],
					bundleWriteLanded,
				);
				landed = true;
				// The command has saved. Keep that fact if the refresh fails.
				queryClient.setQueryData<Registry>(qk.registry(), (current) => {
					const saved = current?.bundles[bundleName];
					if (!current || !saved) return current;
					return {
						...current,
						bundles: {
							...current.bundles,
							[bundleName]: { ...saved, scope: next ? "global" : "project-specific" },
						},
					};
				});
				await invalidateRegistry(queryClient);
				toast.success(next ? "Bundle is global" : "Bundle is project-specific");
				showBundleWarnings(toast, payload);
				if (warning) toast.info("Sync reported findings", warning);
			} catch (err) {
				if (landed) toast.info("Bundle scope saved; refresh failed", errText(err));
				else toast.error("Couldn't change bundle scope", errText(err));
			} finally {
				busyRef.current = false;
				setScopeRequest(null);
			}
		});
	};

	return { toggle, target, pending: target !== null, busy: scopeRequest !== null, busyRef };
}
