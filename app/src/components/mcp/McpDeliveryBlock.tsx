import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { SectionHeader } from "@/components/SectionHeader";
import { StatusBadge } from "@/components/StatusBadge";
import { FreshnessBadge } from "@/components/FreshnessBadge";
import { LoadingButton } from "@/components/loading/LoadingButton";
import { Button } from "@/components/Button";
import { EmptyState } from "@/components/EmptyState";
import { PathText } from "@/components/PathText";
import { HarnessGlyph } from "@/components/harness/HarnessGlyph";
import { harnessDisplayLabel } from "@/components/harness/harnessRegistry";
import { hubCmd } from "@/lib/hubCmd";
import { parseCliJson } from "@/lib/skillPack";
import { qk } from "@/lib/queryKeys";
import { relTime, type Freshness } from "@/lib/syncFreshness";
import { useMcpProbe } from "@/hooks/useMcpProbe";
import { useRunSync, useSyncing } from "@/hooks/useRunSync";
import {
	deliveryReasonLine,
	probeStateLine,
	type McpDeliveryRow,
	type McpDeliveryState,
	type McpProbe,
	type McpShowPayload,
} from "@/lib/mcpContract";

export interface McpDeliveryBlockProps {
	name: string;
	rows: McpDeliveryRow[];
	/** From `useSyncReport` — the block header's own honesty badge (risk 5:
	 *  never claim delivered truth off a stale report). */
	freshness: Freshness;
	/** Reveals an ABSOLUTE path (the delivery row's own `target_file` — not
	 *  skill-relative, unlike the FILES navigator's reveal). */
	onReveal: (absolutePath: string) => void;
}

const STATE_BADGE: Record<McpDeliveryState, { channel: "ok" | "info" | "warn" | "error" | "neutral"; label: string }> = {
	written: { channel: "ok", label: "Delivered" },
	unchanged: { channel: "ok", label: "Delivered" },
	skipped: { channel: "neutral", label: "Skipped" },
	blocked: { channel: "error", label: "Blocked" },
};

function DeliveryRow({ row, onReveal }: { row: McpDeliveryRow; onReveal: (p: string) => void }) {
	// W1: `row.state` is CLI JSON, not a compiler-checked union at runtime — an
	// unrecognized state (a differently-versioned `hub`) degrades to a neutral
	// badge naming itself instead of throwing on the property access.
	const badge = STATE_BADGE[row.state] ?? { channel: "neutral" as const, label: row.state };
	const scopeLabel = row.scope === "global" ? "Global" : row.scope.replace(/^project:/, "");
	return (
		<div className="mcp-delivery-row" data-testid="mcp-delivery-row">
			<div className="mcp-delivery-harness">
				<HarnessGlyph id={row.harness} label={harnessDisplayLabel(row.harness)} size={16} decorative />
				<span>{harnessDisplayLabel(row.harness)}</span>
			</div>
			<span className="mcp-delivery-scope">{scopeLabel}</span>
			<StatusBadge channel={badge.channel} shape="pill">
				{badge.label}
			</StatusBadge>
			<div className="mcp-delivery-target">
				<button
					type="button"
					disabled={!row.target_file}
					title={row.target_file || undefined}
					onClick={() => row.target_file && onReveal(row.target_file)}
				>
					<PathText path={row.target_file || "—"} />
				</button>
			</div>
			{row.reason && (
				<div className="mcp-delivery-reason">{deliveryReasonLine(row.reason, row.detail)}</div>
			)}
		</div>
	);
}

function checkLabel(fetching: boolean, everChecked: boolean): string {
	if (fetching) return "Checking…";
	return everChecked ? "Check again" : "Check";
}

/** DELIVERY — per (harness, scope) row + the Check control (design §4.5). The
 *  `RemoteCard` liveness pattern: never probes on mount, only on the button's
 *  own click. */
export function McpDeliveryBlock({ name, rows, freshness, onReveal }: McpDeliveryBlockProps) {
	const [armed, setArmed] = useState(false);
	const probeQuery = useMcpProbe(name, armed);
	const qc = useQueryClient();
	// G.md §6.4: a fresh Check re-fetches `hub mcp check`, which also refreshes
	// the on-disk catalogue summary — invalidate the READ-only `mcp show`
	// cache line (react-query v5 dropped `useQuery`'s own `onSuccess`) so
	// `McpCapabilitiesBlock`'s deduped query on that same key re-fetches too,
	// instead of going stale until some unrelated event happens to refetch it.
	useEffect(() => {
		if (probeQuery.data) {
			void qc.invalidateQueries({ queryKey: qk.mcpShow(name) });
		}
	}, [probeQuery.data, qc, name]);
	// A cheap, non-probing READ of the persisted cache (`state/mcp/probes.json`
	// via `hub mcp show`'s `last_probe`) — safe to run on mount because it
	// never talks to the server itself; only the armed query above does that
	// (INTERFACES §3: E1 is a named consumer of `hub mcp show --json`).
	const showQuery = useQuery({
		queryKey: qk.mcpShow(name),
		queryFn: async () =>
			parseCliJson<McpShowPayload>((await hubCmd(["mcp", "show", name, "--json"])).output),
		staleTime: 30_000,
		// S2: same reasoning as the armed probe query below — a read is
		// harmless, but there is no reason to re-spawn `hub mcp show` on every
		// window refocus once 30s has lapsed.
		refetchOnWindowFocus: false,
		refetchOnReconnect: false,
	});
	const runSync = useRunSync();
	const syncing = useSyncing();

	const cachedProbe: McpProbe | null = showQuery.data?.last_probe ?? null;
	const liveProbe: McpProbe | null = probeQuery.data ?? null;
	const effectiveProbe = liveProbe ?? cachedProbe;
	const everChecked = !!effectiveProbe;

	function handleCheckClick() {
		if (!armed) {
			setArmed(true);
			return;
		}
		void probeQuery.refetch();
	}

	return (
		<div className="mcp-block" data-block="delivery">
			<div className="mcp-delivery-head">
				<div className="mcp-delivery-head-left">
					<SectionHeader label="DELIVERY" />
					<FreshnessBadge state={freshness} />
				</div>
				<div className="mcp-check-cluster">
					<LoadingButton
						variant="soft"
						icon="sync"
						loading={probeQuery.isFetching}
						loadingLabel="Checking…"
						onClick={handleCheckClick}
						data-testid="mcp-check-button"
					>
						{checkLabel(probeQuery.isFetching, everChecked)}
					</LoadingButton>
					{probeQuery.isFetching ? (
						<span className="mcp-block-note">Talking to the server…</span>
					) : effectiveProbe ? (
						<CheckResultLine probe={effectiveProbe} />
					) : (
						<span className="mcp-block-note">Never checked.</span>
					)}
				</div>
			</div>

			{rows.length === 0 ? (
				<EmptyState
					icon="sync"
					title="Not synced yet"
					description="Run a sync to see where this server landed."
					action={
						<Button variant="soft" size="sm" busy={syncing} onClick={() => void runSync()}>
							Sync now
						</Button>
					}
				/>
			) : (
				<div className="mcp-delivery-table">
					{rows.map((row, i) => (
						<DeliveryRow key={`${row.harness}-${row.scope}-${i}`} row={row} onReveal={onReveal} />
					))}
				</div>
			)}
		</div>
	);
}

function CheckResultLine({ probe }: { probe: McpProbe }) {
	const { text, tone, detail } = probeStateLine(probe);
	// The count leads on its own line; the latency and the freshness sit under
	// it as context. Only `ok` gets the larger type — every other state's
	// `text` is a full sentence (see `probeStateLine`).
	const contextLine = [detail, `checked ${relTime(probe.checked_at)}`]
		.filter(Boolean)
		.join(" · ");
	return (
		<div className="mcp-check-result">
			<div
				className="mcp-probe-line"
				data-tone={tone}
				data-emphasis={probe.state === "ok" ? "count" : undefined}
			>
				{text}
			</div>
			<div className="mcp-probe-detail">{contextLine}</div>
			{probe.state === "unresolved_ref" && probe.env_from_shell === false && (
				<div className="mcp-probe-detail">
					Skill Tree could not read your login shell, so it only sees variables exported to GUI
					apps.
				</div>
			)}
			{probe.state === "unreachable" && probe.error && (
				<div className="mcp-probe-detail">{probe.error}</div>
			)}
		</div>
	);
}
