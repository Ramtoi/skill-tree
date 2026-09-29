import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { SectionHeader } from "@/components/SectionHeader";
import { Button } from "@/components/Button";
import { hubCmd } from "@/lib/hubCmd";
import { parseCliJson } from "@/lib/skillPack";
import { qk } from "@/lib/queryKeys";
import { relTime } from "@/lib/syncFreshness";
import { capabilityCountsLine, catalogEmptyReason, type McpShowPayload } from "@/lib/mcpContract";
import { McpCapabilitySheet } from "./McpCapabilitySheet";

export interface McpCapabilitiesBlockProps {
	name: string;
}

/**
 * CAPABILITIES — what the server offers (plans/G.md §6.4), between DELIVERY
 * ("did it arrive?") and REACH ("which harnesses") in `McpPanel`.
 *
 * Grill F11 / design §6.4: this block does NOT reuse `McpDeliveryBlock`'s
 * armed probe — that would move the never-probe-on-mount invariant away from
 * the component that owns the Check button. Instead it runs its OWN
 * `useQuery` on the identical key `qk.mcpShow(name)`; react-query dedupes the
 * two, so this costs zero extra CLI calls and needs no arming of its own. A
 * fresh Check (`McpDeliveryBlock`'s armed probe) invalidates that same key,
 * which is what refreshes this block after a re-check.
 */
export function McpCapabilitiesBlock({ name }: McpCapabilitiesBlockProps) {
	const [sheetOpen, setSheetOpen] = useState(false);
	const showQuery = useQuery({
		queryKey: qk.mcpShow(name),
		queryFn: async () =>
			parseCliJson<McpShowPayload>((await hubCmd(["mcp", "show", name, "--json"])).output),
		staleTime: 30_000,
		refetchOnWindowFocus: false,
		refetchOnReconnect: false,
	});

	const probe = showQuery.data?.last_probe ?? null;
	const summary = probe?.catalog ?? null;
	// The glance block never fetches the full record itself (design §6.2), so
	// it always evaluates the precedence table without a `catalog` payload —
	// only the sheet, after its own fetch, can tell "file missing" apart.
	const emptyReason = catalogEmptyReason(probe);
	const identity = summary && [summary.server_name, summary.server_version].filter(Boolean).join(" ");

	return (
		<div className="mcp-block" data-block="capabilities" data-testid="mcp-capabilities-block">
			<div className="mcp-capabilities-head">
				<SectionHeader label="CAPABILITIES" />
				{probe && <span className="mcp-block-note">{`read ${relTime(probe.checked_at)}`}</span>}
			</div>

			{emptyReason ? (
				<div className="mcp-block-note">{emptyReason}</div>
			) : summary ? (
				<>
					<div className="mcp-capabilities-line">{capabilityCountsLine(summary)}</div>
					{identity && <div className="mcp-block-note">{identity}</div>}
					<div className="mcp-capabilities-actions">
						<Button
							variant="soft"
							size="sm"
							onClick={() => setSheetOpen(true)}
							data-testid="mcp-capabilities-browse"
						>
							Browse…
						</Button>
					</div>
					{summary.errors > 0 && (
						<div className="mcp-block-note" data-tone="warn">
							{summary.errors === 1
								? "1 part of this server's catalogue could not be read."
								: `${summary.errors} parts of this server's catalogue could not be read.`}
						</div>
					)}
				</>
			) : null}

			<McpCapabilitySheet name={name} open={sheetOpen} onClose={() => setSheetOpen(false)} />
		</div>
	);
}
