import { useState } from "react";
import { InvocationOutcomeCard } from "./InvocationOutcomeCard";
import { harnessLabel } from "@/components/harness/harnessRegistry";
import {
	INVOCATION_CONFLICTED_TOOLTIP,
	INVOCATION_LABEL,
	invocationConsequence,
	invocationOutcomeLabel,
	invocationSummary,
	type InvocationMode,
	type InvocationOutcome,
	type InvocationStatus,
} from "@/lib/invocation";

export interface InvocationOutcomesProps {
	status?: InvocationStatus;
	mode: InvocationMode | "conflicted";
	installedHarnesses?: string[];
	affinity?: string[];
	isLoading?: boolean;
	hasError?: boolean;
}

function targetSet(installedHarnesses?: string[], affinity?: string[]) {
	if (!installedHarnesses) return null;
	if (!affinity || affinity.length === 0) return new Set(installedHarnesses);
	return new Set(installedHarnesses.filter((id) => affinity.includes(id)));
}

function previewRow(row: InvocationOutcome): InvocationOutcome {
	return { ...row, delivery: "applied" };
}

/** Shared outcome rows for the editor and project override popover. */
export function InvocationOutcomes({
	status,
	mode,
	installedHarnesses,
	affinity,
	isLoading,
	hasError,
}: InvocationOutcomesProps) {
	const [activeHint, setActiveHint] = useState<string | null>(null);
	const effectiveMode: InvocationMode = mode === "conflicted" ? "auto" : mode;
	// The caller supplies the effective requested mode. A conflicted library can
	// still have a valid project override, whose outcomes should remain visible.
	const isConflict = mode === "conflicted";
	const targets = targetSet(installedHarnesses, affinity);
	const persisted = !!status && status.effective === effectiveMode && !isConflict;
	const sourceRows = persisted
		? status?.outcomes ?? []
		: status?.previews?.[effectiveMode] ?? [];
	const rows = sourceRows;
	const targetIds = targets
		? [...new Set(installedHarnesses ?? status?.targets ?? [])]
		: status?.targets ?? rows.map((row) => row.harness);
	const byHarness = new Map(rows.map((row) => [row.harness, row]));

	if (isConflict) {
		return (
			<div className="invocation-outcomes" data-state="conflicted">
				<p className="invocation-outcomes-conflict" role="status">
					{INVOCATION_CONFLICTED_TOOLTIP}
				</p>
			</div>
		);
	}

	if (isLoading && !status) {
		return <p className="invocation-outcomes-empty">Checking invocation outcomes…</p>;
	}

	if (hasError && !status) {
		return (
			<p className="invocation-outcomes-empty" role="status">
				Invocation support could not be verified for this build.
			</p>
		);
	}

	if (targetIds.length === 0) {
		return <p className="invocation-outcomes-empty">No harness receives this skill here.</p>;
	}

	return (
		<div className="invocation-outcomes" aria-label="Invocation outcomes">
			<div className="invocation-outcomes-head">
				<span>Target behavior</span>
				{!persisted && <span className="invocation-outcomes-preview">Preview</span>}
			</div>
			{!status?.project && (status?.overridden_projects?.length ?? 0) > 0 && (
				<p className="invocation-outcomes-note" role="note">
					Some projects override this library mode.
				</p>
			)}
			<ul className="invocation-outcomes-list">
				{targetIds.map((harness) => {
					const selected = !targets || targets.has(harness);
					const sourceRow = byHarness.get(harness);
					const row = !selected && sourceRow ? { ...sourceRow, delivery: "not-targeted" as const } : sourceRow;
					if (!row) {
						return <InvocationOutcomeCard key={harness} label={harnessLabel(harness)}
							active={activeHint === harness} onActivate={() => setActiveHint(harness)}
							meta={{ channel: "neutral", label: selected ? "Not verified" : "Not sent" }}
							summary={selected ? "Behavior not verified" : "Excluded by target selection"}
							details={[selected ? "Invocation support has not been checked for this target." : "This target is excluded by the skill's harness selection."]} />;
					}
					const preview = !persisted;
					const meta = invocationOutcomeLabel(row, preview && selected);
					const explanationInput = row.delivery === "not-targeted" ? row : preview ? previewRow(row) : row;
					const explanation = row.delivery === "not-targeted"
						? "This target is excluded by the skill's harness selection."
						: invocationConsequence(explanationInput, effectiveMode);
					const summary = invocationSummary(row, effectiveMode);
					const details = [...new Set([
						explanation,
						row.reason,
						row.delivery === "failed" && row.applied_mode
							? `Last applied mode: ${INVOCATION_LABEL[row.applied_mode as InvocationMode] ?? row.applied_mode}.` : undefined,
						...(row.limitations ?? []),
					].filter((detail): detail is string => !!detail))];
					return <InvocationOutcomeCard key={harness} label={harnessLabel(harness)}
							active={activeHint === harness} onActivate={() => setActiveHint(harness)}
						meta={meta} summary={summary} details={details} support={row.support} />;
				})}
			</ul>
		</div>
	);
}
