import { useQuery } from "@tanstack/react-query";
import { invoke } from "@/lib/ipc";
import type { CatalogConnector } from "@/types";

/** Live connector catalog from `hub remote connectors --json` (marshaled by the
 *  `remote_connectors` Tauri command). The add-remote wizard derives its cards +
 *  transport branching from this, falling back to the static `CONNECTOR_TYPES`
 *  list on error/degraded mode.
 *
 *  Pass `enabled = false` in degraded mode (Python missing) so we never fire an
 *  invocation that is guaranteed to reject — the wizard renders the static
 *  fallback in that case anyway. */
export function useConnectorCatalog(enabled = true) {
	return useQuery({
		queryKey: ["connector-catalog"],
		queryFn: () => invoke<CatalogConnector[]>("remote_connectors"),
		enabled,
		// A connector registry rarely changes within a session; avoid refetch
		// churn while the wizard is open.
		staleTime: 60_000,
		// One failed probe → fall back to the static list; don't retry-storm.
		retry: false,
	});
}
