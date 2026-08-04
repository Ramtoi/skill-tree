import { useEffect, useRef, useState } from "react";

import { Icon } from "@/components/Icon";
import type { AgentDocPolicyInfo } from "@/types/agentDocs";
import { HarnessGlyph } from "./HarnessGlyph";
import { HarnessManagePopover } from "./HarnessManagePopover";
import { harnessTint, harnessFile } from "./harnessRegistry";

export interface HarnessAgentStripProps {
	projectName: string;
	globalHarnesses: string[];
	projectHarnesses: string[];
	/** Effective (installed ∩ enabled) harnesses, already resolved by caller. */
	effectiveHarnesses: { id: string; label: string }[];
	/** Scanner-resolved canonical policy (from the Agent Docs listing). */
	policy: AgentDocPolicyInfo | null;
	/** True when every instruction set in the project is canonical with no
	 *  deviation flags — the strip then shows a quiet confirmation glyph. */
	allCanonical: boolean;
}

/**
 * Agent Docs status line — one quiet row, no warning chrome:
 *   [AGENTS] <pills> | root: AGENTS.md · CLAUDE.md derived (symlink) ✓ ── [Manage]
 *
 * Deviations are reported by the fix banner below it, never here. The
 * derivation-strategy selector lives in the Manage popover.
 */
export function HarnessAgentStrip({
	projectName,
	globalHarnesses,
	projectHarnesses,
	effectiveHarnesses,
	policy,
	allCanonical,
}: HarnessAgentStripProps) {
	const [manageOpen, setManageOpen] = useState(false);
	const manageWrapRef = useRef<HTMLSpanElement>(null);

	useEffect(() => {
		if (!manageOpen) return;
		function onDown(e: MouseEvent) {
			if (!manageWrapRef.current?.contains(e.target as Node))
				setManageOpen(false);
		}
		function onKey(e: KeyboardEvent) {
			if (e.key === "Escape") setManageOpen(false);
		}
		document.addEventListener("mousedown", onDown);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("mousedown", onDown);
			document.removeEventListener("keydown", onKey);
		};
	}, [manageOpen]);

	const manageButton = (
		<span className="harness-strip-managewrap" ref={manageWrapRef}>
			<button
				type="button"
				className="harness-strip-manage"
				title="Manage agents and the root-derivation strategy"
				aria-expanded={manageOpen}
				onClick={() => setManageOpen((v) => !v)}
			>
				<Icon name="cog" size={10} />
				Manage
			</button>
			{manageOpen && (
				<HarnessManagePopover
					projectName={projectName}
					globalHarnesses={globalHarnesses}
					projectHarnesses={projectHarnesses}
					onClose={() => setManageOpen(false)}
				/>
			)}
		</span>
	);

	if (effectiveHarnesses.length === 0) {
		return (
			<div className="harness-strip" data-empty>
				<span className="harness-strip-eyebrow">Agents</span>
				<span className="harness-strip-none">none configured</span>
				<span className="harness-strip-stretch" />
				{manageButton}
			</div>
		);
	}

	// Layout summary from the scanner policy — never re-derived from raw files.
	const rootSummary = !policy?.canonical
		? null
		: policy.derived
			? `root: ${policy.canonical} · ${policy.derived} derived (${policy.strategy})`
			: `root: ${policy.canonical}`;

	return (
		<div className="harness-strip" data-tone="ok">
			<span className="harness-strip-eyebrow">Agents</span>
			<div className="harness-strip-pills">
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
			</div>

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

			<span className="harness-strip-stretch" />

			{manageButton}
		</div>
	);
}
