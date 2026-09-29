import { useState } from "react";

import { Icon } from "@/components/Icon";
import type { AgentDocPolicyInfo, AgentDocPublishInfo } from "@/types/agentDocs";
import { HarnessGlyph } from "./HarnessGlyph";
import { HarnessManagePopover } from "./HarnessManagePopover";
import { harnessTint, harnessFile } from "./harnessRegistry";

export interface HarnessAgentStripProps {
	projectName: string;
	projectPath: string;
	globalHarnesses: string[];
	projectHarnesses: string[];
	/** Effective (installed ∩ enabled) harnesses, already resolved by caller. */
	effectiveHarnesses: { id: string; label: string }[];
	/** Scanner-resolved canonical policy (from the Agent Docs listing). */
	policy: AgentDocPolicyInfo | null;
	/** True when every instruction set in the project is canonical with no
	 *  deviation flags — the strip then shows a quiet confirmation glyph. */
	allCanonical: boolean;
	publishInfo?: AgentDocPublishInfo | null;
}

/**
 * Agent Docs status line — one quiet row, no warning chrome:
 *   [AGENTS] <pills> | root: AGENTS.md · CLAUDE.md derived (symlink) ✓ ── [Manage]
 *
 * Deviations are reported by the fix banner below it, never here. The
 * derivation-strategy selector lives in the Manage dialog.
 */
export function HarnessAgentStrip({
	projectName,
	projectPath,
	globalHarnesses,
	projectHarnesses,
	effectiveHarnesses,
	policy,
	allCanonical,
	publishInfo,
}: HarnessAgentStripProps) {
	const [manageOpen, setManageOpen] = useState(false);

	const manageButton = (
		<span className="harness-strip-managewrap">
			<button
				type="button"
				className="harness-strip-manage"
				title="Manage agents and the root-derivation strategy"
				aria-expanded={manageOpen}
				aria-haspopup="dialog"
				onClick={() => setManageOpen((v) => !v)}
			>
				<Icon name="cog" size={10} />
				Manage
			</button>
			<HarnessManagePopover
				open={manageOpen}
				projectName={projectName}
				projectPath={projectPath}
				globalHarnesses={globalHarnesses}
				projectHarnesses={projectHarnesses}
				onClose={() => setManageOpen(false)}
			/>
		</span>
	);
	const hasHarnesses = effectiveHarnesses.length > 0;

	// Layout summary from the scanner policy — never re-derived from raw files.
	const rootSummary = !policy?.canonical
		? null
		: policy.derived
			? `root: ${policy.canonical} · ${policy.derived} derived (${policy.strategy})`
			: `root: ${policy.canonical}`;

	return (
		<div
			className="harness-strip"
			data-empty={!hasHarnesses || undefined}
			data-tone={hasHarnesses ? "ok" : undefined}
		>
			<span className="harness-strip-eyebrow">Agents</span>
			<span className="harness-strip-summary">
				{hasHarnesses ? (
					<>
						<span className="harness-strip-pills">
							{effectiveHarnesses.map((h) => (
								<span
									key={h.id}
									className="harness-inline-pill"
									style={{ ["--harness-accent" as string]: harnessTint(h.id) }}
									title={`${h.label} — reads ${harnessFile(h.id)}`}
								>
									<HarnessGlyph id={h.id} label={h.label} size={14} decorative />
									<span>{h.label}</span>
								</span>
							))}
						</span>
						{rootSummary && (
							<>
								<span className="harness-strip-divider" />
								<span
									className="harness-strip-root text-mono"
									title={
										policy?.derived
											? `${policy.canonical} is the real instruction file; ${policy.derived} is derived from it (${policy.strategy}).`
											: `${policy?.canonical} is the real instruction file for this project.`
									}
								>
									{rootSummary}
								</span>
								{allCanonical && (
									<span
										className="harness-strip-ok"
										title="All instruction sets match the canonical layout."
										data-testid="agent-docs-canonical-ok"
									>
										<Icon name="check" size={11} />
									</span>
								)}
							</>
						)}
					</>
				) : (
					<span className="harness-strip-none">none configured</span>
				)}
			</span>

			{publishInfo?.enabled && (
				<>
					<span className="harness-strip-divider" />
					<span
						className="harness-strip-publish text-mono"
						title="A save publishes only root AGENTS.md and CLAUDE.md after Git verifies origin/main."
					>
						publishes on save: {publishInfo.remote}/{publishInfo.branch}
					</span>
				</>
			)}

			<span className="harness-strip-stretch" />

			{manageButton}
		</div>
	);
}
