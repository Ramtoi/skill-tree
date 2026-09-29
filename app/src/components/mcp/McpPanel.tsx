import { SectionHeader } from "@/components/SectionHeader";
import { Button } from "@/components/Button";
import { HarnessAffinityChips } from "@/components/HarnessAffinityChips";
import { openSidePanelSection } from "@/components/SidePanelSection";
import type { UseMcpDraft } from "@/hooks/useMcpDraft";
import type { McpDeliveryRow } from "@/lib/mcpContract";
import type { Freshness } from "@/lib/syncFreshness";
import { McpIdentityBlock } from "./McpIdentityBlock";
import { McpKeyValueRows } from "./McpKeyValueRows";
import { McpDeliveryBlock } from "./McpDeliveryBlock";
import { McpCapabilitiesBlock } from "./McpCapabilitiesBlock";
import { McpPermissionsBlock } from "./McpPermissionsBlock";

export interface McpPanelProps {
	name: string;
	draft: UseMcpDraft;
	readOnly: boolean;
	/** The editor's own RUNTIME affinity state — REACH is a read-only mirror
	 *  of it, never a second place to edit (design §4.4). `[]` = all effective
	 *  harnesses. */
	affinity: string[];
	installedHarnesses: string[];
	deliveryRows: McpDeliveryRow[];
	freshness: Freshness;
	/** Reveals an ABSOLUTE path in Finder — a delivery row's `target_file`,
	 *  not a skill-relative rel (N3). */
	onReveal: (absolutePath: string) => void;
}

/**
 * The MCP editor panel (design §4.1) — replaces the markdown buffer for
 * `type: mcp-server` in the document column. Composes the three sub-blocks;
 * holds no CLI call of its own (CONNECTION/CREDENTIALS mutate through
 * `draft`, DELIVERY reads/probes through its own hooks). `tabIndex={-1}` so a
 * future create flow (E2) can move focus here (m7).
 */
export function McpPanel({
	name,
	draft,
	readOnly,
	affinity,
	installedHarnesses,
	deliveryRows,
	freshness,
	onReveal,
}: McpPanelProps) {
	const transport = draft.spec.transport ?? "stdio";
	const isRemote = transport === "http" || transport === "sse";
	const allMode = affinity.length === 0;

	return (
		// NOT `.screen-pad` (that class is reserved for content sitting flush
		// under the header BAND itself — ProjectWorkspace's `.workspace-main`);
		// this panel lives inside `.doc-editor-body`, below the editor's own
		// `.doc-editor-bar` row, same as every other document-editor body. It
		// borrows `--pad-screen-y`/`--pad-screen-x` as its OWN padding values
		// (mcp-panel.css) without the class, so the screen-geometry sweep's
		// content-flush check keeps reading this route the same way it reads
		// every other skill-editor scene.
		<div className="mcp-panel" data-testid="mcp-panel" tabIndex={-1}>
			<McpIdentityBlock draft={draft} readOnly={readOnly} />
			<McpKeyValueRows draft={draft} readOnly={readOnly} kind={isRemote ? "headers" : "env"} />

			{/* S1: DELIVERY answers J3 ("did this server actually arrive?") — the
			    frequent job — and moved above REACH (the rare "which harnesses"
			    question) so it reads before the fold, amending §4.1's original
			    CONNECTION/CREDENTIALS/REACH/DELIVERY order. */}
			<McpDeliveryBlock name={name} rows={deliveryRows} freshness={freshness} onReveal={onReveal} />

			{/* G.md §6.4: DELIVERY answers "did it arrive?", CAPABILITIES answers
			    "what can it do?", REACH stays the rare question at the foot. */}
			<McpCapabilitiesBlock name={name} />
			<McpPermissionsBlock key={name} name={name} sourceReadOnly={readOnly} />

			<div className="mcp-block" data-block="reach">
				<SectionHeader label="REACH" />
				<div className="mcp-reach-row">
					{installedHarnesses.length === 0 ? (
						<span className="mcp-block-note">No harnesses installed.</span>
					) : (
						<HarnessAffinityChips
							installedHarnesses={installedHarnesses}
							capabilities={{}}
							supports={() => true}
							affinity={allMode ? null : affinity}
							collapsedWhenAll={false}
							readOnly
						/>
					)}
					<Button variant="ghost" size="sm" onClick={() => openSidePanelSection("runtime")}>
						Change reach
					</Button>
				</div>
				<div className="mcp-block-note">
					{allMode ? "All effective harnesses." : `Only ${affinity.join(", ")}.`}
				</div>
			</div>
		</div>
	);
}
