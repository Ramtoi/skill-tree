import { useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { runHubCmd } from "@/lib/hubCmd";
import { qk } from "@/lib/queryKeys";
import { invalidateRegistry } from "@/lib/invalidate";
import { parseHubJson, type CloudStatus, type CloudTarget } from "@/lib/cloud";

/** Run a `hub cloud …` verb through the generic bridge and parse its `--json`
 *  payload. A non-zero exit surfaces the CLI's own message as the error. */
export async function runCloudJson<T>(args: string[]): Promise<T> {
	const res = await runHubCmd(args);
	return parseHubJson<T>(res.output);
}

/** The catalog + per-target equipped count and drift rollup. Read-only; the
 *  backend fingerprints the equipped skills' content, so it does real work —
 *  hence a staleTime rather than a refetch on every mount. */
export function useCloudTargets() {
	return useQuery({
		queryKey: qk.cloud.targets(),
		queryFn: () => runCloudJson<CloudTarget[]>(["cloud", "targets", "--json"]),
		staleTime: 15_000,
	});
}

/** One target's per-skill status rows + lints + orphans (`hub cloud status`). */
export function useCloudStatus(id: string | undefined) {
	return useQuery({
		queryKey: qk.cloud.status(id ?? ""),
		queryFn: () =>
			runCloudJson<CloudStatus>(["cloud", "status", id as string, "--json"]),
		enabled: !!id,
		staleTime: 15_000,
	});
}

/** Invalidate everything a cloud mutation (equip / export) can move: the target
 *  rollup, that target's status rows, and the registry (equip rewrites
 *  `cloud:`). */
export async function invalidateCloud(id?: string) {
	await queryClient.invalidateQueries({ queryKey: qk.cloud.targets() });
	await invalidateRegistry(queryClient);
	if (id) await queryClient.invalidateQueries({ queryKey: qk.cloud.status(id) });
	else await queryClient.invalidateQueries({ queryKey: qk.cloud.statusAll() });
}

/** One row of `hub harness list --json` (only the fields the cloud UI reads). */
interface HarnessRow {
	id: string;
	label: string;
	installed: boolean;
	/** Other products this harness's writes already reach, e.g. the ChatGPT
	 *  desktop app reading `~/.agents/skills`. Absent on most rows. */
	also_serves?: string[];
}

/**
 * Whether some installed harness already serves the ChatGPT DESKTOP app.
 *
 * Read from `hub harness list --json` rather than the Rust `harness_list`
 * command: the Rust side re-implements detection from an embedded schema and
 * knows nothing about `also_serves`, and teaching it would put product logic in
 * a layer that is meant to stay marshal-only. This is one CLI call, lazily made
 * by the cloud section only.
 *
 * `installed` is part of the filter, not a detail: an uninstalled harness writes
 * nothing, so "already handled for you" would be false — the second belt to the
 * backend's own `"codex" in installed` gate, since this row shape is shared and
 * a future annotation could arrive without one.
 */
export function useAlsoServed(product: string) {
	return useQuery({
		queryKey: qk.harnessAlsoServes(),
		queryFn: () => runCloudJson<HarnessRow[]>(["harness", "list", "--json"]),
		staleTime: 5 * 60_000,
		retry: false,
		select: (rows) =>
			rows.filter((h) => h.installed && (h.also_serves ?? []).includes(product)),
	});
}

/** The product name the codex harness annotates itself with. */
export const CHATGPT_DESKTOP = "ChatGPT desktop app";
