import { useEffect, useMemo, useState } from "react";
import { SubagentModelPicker } from "./SubagentModelPicker";
import { Icon } from "@/components/Icon";
import { LoadingButton } from "@/components/loading";
import { Plaque } from "@/components/Plaque";
import { Select, type SelectOption } from "@/components/Select";
import { ChipRadios, type ChipRadioOption } from "@/components/ChipRadios";
import { HarnessGlyph } from "@/components/harness/HarnessGlyph";
import { harnessLabel } from "@/components/harness/harnessRegistry";
import {
	CODEX_REASONING_EFFORTS,
	CODEX_SANDBOX_MODES,
	type CodexSandboxMode,
	type SubagentDriftField,
	type SubagentHarness,
	type SubagentWarning,
} from "@/lib/subagents";

// ─── Codex Behavior section ───────────────────────────────────────────────────
// Codex scopes an agent's capability via `sandbox_mode` (no per-tool rules) and
// tunes it via a free-text model id + reasoning effort. Empty = inherit.

export const SANDBOX_LABELS: Record<CodexSandboxMode, string> = {
	"": "Inherit",
	"read-only": "Read-only",
	"workspace-write": "Workspace",
	"danger-full-access": "Full access",
};

/** One consequence line per sandbox mode — shown for the CHOSEN value below
 *  the chips, and as every option's hover `title` (rule 7/9). */
const SANDBOX_CONSEQUENCE: Record<CodexSandboxMode, string> = {
	"": "Inherits the session's tools.",
	"read-only": "Can read the workspace but not write to it.",
	"workspace-write": "Can read and write inside the workspace.",
	"danger-full-access": "No sandbox — the agent can touch anything you can.",
};

export function CodexBehavior({
	model,
	onModel,
	reasoningEffort,
	onReasoningEffort,
	sandboxMode,
	onSandboxMode,
	errorFor,
}: {
	model: string;
	onModel: (v: string) => void;
	reasoningEffort: string;
	onReasoningEffort: (v: string) => void;
	sandboxMode: CodexSandboxMode;
	onSandboxMode: (v: CodexSandboxMode) => void;
	errorFor: (field: string) => SubagentWarning | undefined;
}) {
	// A hand-authored effort value outside the known set still round-trips: keep
	// it selectable so hydration doesn't silently coerce it.
	const effortValues = CODEX_REASONING_EFFORTS.includes(reasoningEffort as never)
		? [...CODEX_REASONING_EFFORTS]
		: [...CODEX_REASONING_EFFORTS, reasoningEffort];
	const effortOptions: SelectOption<string>[] = effortValues.map((v) => ({
		value: v,
		label: v === "" ? "inherit" : v,
	}));
	const sandboxOptions: ChipRadioOption<CodexSandboxMode>[] = CODEX_SANDBOX_MODES.map(
		(m) => ({
			value: m,
			label:
				m === "danger-full-access" ? (
					<span className="subagent-sandbox-danger">{SANDBOX_LABELS[m]}</span>
				) : (
					SANDBOX_LABELS[m]
				),
			title: SANDBOX_CONSEQUENCE[m],
		}),
	);
	return (
		<>
			<dl className="kv">
				<div className="kv-row">
					<dt>model</dt>
					<dd>
						<SubagentModelPicker harness="codex" value={model} onChange={onModel} />
					</dd>
				</div>
				<div className="kv-row">
					<dt>effort</dt>
					<dd>
						<Select
							value={reasoningEffort}
							options={effortOptions}
							label="Reasoning effort"
							onChange={onReasoningEffort}
						/>
					</dd>
				</div>
			</dl>
			{errorFor("model") && (
				<span className="field-error" role="alert">
					{errorFor("model")?.message}
				</span>
			)}
			{errorFor("model_reasoning_effort") && (
				<span className="field-error" role="alert">
					{errorFor("model_reasoning_effort")?.message}
				</span>
			)}

			<div className="subagent-field-label">Capability (sandbox mode)</div>
			<ChipRadios
				name="sandbox-mode"
				label="Capability (sandbox mode)"
				className="subagent-chip-wrap"
				title="Codex scopes capability via sandbox_mode, not per-tool rules."
				value={sandboxMode}
				options={sandboxOptions}
				onChange={onSandboxMode}
			/>
			<p className="subagent-chip-consequence">{SANDBOX_CONSEQUENCE[sandboxMode]}</p>
			{errorFor("sandbox_mode") && (
				<span className="field-error" role="alert">
					{errorFor("sandbox_mode")?.message}
				</span>
			)}
		</>
	);
}

// ─── Drift banner (D3) ────────────────────────────────────────────────────────
// Calm-but-prominent: lists each drifted shared-core field with a per-field
// winner choice and a preview of the value that choice would keep. Nothing is
// written until Apply — a preview beats a warning, and the drifted fields stay
// frozen server-side.

const DRIFT_FIELD_LABEL: Record<string, string> = {
	description: "description",
	instructions: "system prompt",
	skills: "attached skills",
};

/** Max characters of a drifted instructions value shown in the banner preview. */
const DRIFT_PREVIEW_MAX_CHARS = 90;

/** Compact preview of a field value for the drift banner. */
export function previewValue(field: string, v: unknown): string {
	if (Array.isArray(v)) return v.length ? v.join(", ") : "(none)";
	const s = String(v ?? "");
	if (field === "instructions") {
		const t = s.replace(/\s+/g, " ").trim();
		return t.length > DRIFT_PREVIEW_MAX_CHARS
			? `${t.slice(0, DRIFT_PREVIEW_MAX_CHARS)}…`
			: t || "(empty)";
	}
	return s || "(empty)";
}

export function DriftLockHint() {
	return (
		<span className="subagent-drift-lockhint">
			<Icon name="warning" size={10} /> Drifted — resolve above to edit.
		</span>
	);
}

export function DriftBanner({
	drift,
	harness,
	onApply,
	pending,
}: {
	drift: SubagentDriftField[];
	harness: SubagentHarness;
	onApply: (decisions: Record<string, SubagentHarness>) => void;
	pending: boolean;
}) {
	// Winner harness ids present in the drift payload.
	const hids = useMemo(() => {
		const s = new Set<string>();
		for (const d of drift) for (const h of Object.keys(d.values)) s.add(h);
		return Array.from(s).sort();
	}, [drift]);

	// Default each field's winner to the harness the editor is showing.
	const [decisions, setDecisions] = useState<Record<string, string>>(() =>
		Object.fromEntries(drift.map((d) => [d.field, harness])),
	);
	useEffect(() => {
		setDecisions(Object.fromEntries(drift.map((d) => [d.field, harness])));
	}, [drift, harness]);

	return (
		<Plaque
			accent="amber"
			className="subagent-drift-banner"
			role="alert"
			eyebrow="Linked files have drifted"
			actions={
				<LoadingButton
					variant="primary"
					icon="check"
					loading={pending}
					loadingLabel="Applying…"
					onClick={() => onApply(decisions as Record<string, SubagentHarness>)}
				>
					Apply resolution
				</LoadingButton>
			}
		>
			<p className="subagent-drift-sub">
				These fields differ between the linked files. Choose which side wins
				for each, then apply. Neither file is overwritten until you do.
			</p>
			<div className="subagent-drift-fields">
				{drift.map((d) => {
					const label = DRIFT_FIELD_LABEL[d.field] ?? d.field;
					const options: ChipRadioOption<string>[] = hids.map((h) => ({
						value: h,
						label: (
							<>
								<span className="subagent-drift-choice-h">
									<HarnessGlyph id={h} size={12} decorative />
									{harnessLabel(h)}
								</span>
								<span className="subagent-drift-choice-v">
									{previewValue(d.field, d.values[h])}
								</span>
							</>
						),
					}));
					return (
						<div key={d.field} className="subagent-drift-field">
							<div className="subagent-drift-field-name text-mono">{label}</div>
							<div className="subagent-drift-choices">
								<ChipRadios
									name={`drift-${d.field}`}
									label={`Winner for ${label}`}
									value={decisions[d.field] ?? harness}
									options={options}
									onChange={(h) =>
										setDecisions((prev) => ({ ...prev, [d.field]: h }))
									}
								/>
							</div>
						</div>
					);
				})}
			</div>
		</Plaque>
	);
}
