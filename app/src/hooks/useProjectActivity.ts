import { useEffect, useMemo } from "react";
import { useLocalAgentUsage } from "@/features/usage/useLocalAgentUsage";
import { normalizeCcusageScan } from "@/features/usage/normalizeUsage";
import { useRegistry } from "@/hooks/useRegistry";
import {
	deriveProjectActivity,
	mergeActivity,
	readStoredActivity,
	storeActivity,
	type ProjectActivity,
} from "@/lib/projectActivity";

/**
 * Per-project session recency, keyed by registry project name — feeds the
 * Harnesses screen's USED BY chip ordering.
 *
 * `useLocalAgentUsage()` is the cache-only query the Agents group already
 * holds; reading it here adds no new IPC. Its on-disk cache is
 * path-redacted, so this re-normalizes the held raw scan with
 * `includeFullPaths: true` — a redacted cache scan simply yields sessions
 * with no `project.fullPath` and matches nothing, which is the correct,
 * silent fallback. Whatever recency IS derived this way is merged into
 * `localStorage` so ordering survives past the live scan that produced it.
 */
export function useProjectActivity(): ProjectActivity {
	const { cachedScan } = useLocalAgentUsage();
	const { data: registry } = useRegistry();

	const derived = useMemo(() => {
		if (!cachedScan) return {};
		const snapshot = normalizeCcusageScan(cachedScan, { includeFullPaths: true });
		return deriveProjectActivity(snapshot, registry?.projects ?? {});
	}, [cachedScan, registry]);

	useEffect(() => {
		if (Object.keys(derived).length === 0) return;
		storeActivity(mergeActivity(readStoredActivity(), derived));
	}, [derived]);

	return useMemo(() => mergeActivity(readStoredActivity(), derived), [derived]);
}
