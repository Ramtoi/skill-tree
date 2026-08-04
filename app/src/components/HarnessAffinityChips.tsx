import type { Capabilities, PermissionFeature } from "@/types/permissions";
import { HarnessGlyph } from "./harness/HarnessGlyph";
import {
	harnessTint,
	harnessDisplayLabel,
	harnessShortCode,
} from "./harness/harnessRegistry";

export type ChipState = "applied" | "unsupported" | "excluded";

export interface HarnessAffinityChipsProps {
	/** Installed harness ids. Order is preserved in the rendered chip strip. */
	installedHarnesses: string[];
	/** Per-harness label map. Defaults to id if missing. */
	labels?: Record<string, string>;
	/** Capability map from `permissions_capabilities`. */
	capabilities: Capabilities;
	/** The feature this rule belongs to (e.g. `tool_allowlist`). */
	feature: PermissionFeature;
	/** Current affinity. `null`/undefined ⇒ applies to every capable harness. */
	affinity: string[] | null | undefined;
	/** Toggle handler (only `applied ↔ excluded`; unsupported is read-only). */
	onToggle?: (harnessId: string, nextState: ChipState) => void;
	/** When true, render the collapsed "all" pill when affinity is null and
	 *  every chip would be `applied`. */
	collapsedWhenAll?: boolean;
	/** Optional per-harness support override. When provided, replaces the coarse
	 *  `capabilities[id].includes(feature)` check — lets callers fold in
	 *  per-rule caveats (e.g. Codex's Bash-only command rules). */
	supports?: (harnessId: string) => boolean;
}

function chipTooltip(
	state: ChipState,
	label: string,
	feature: PermissionFeature,
): string {
	if (state === "applied") return `${label}: applied`;
	if (state === "unsupported")
		return `${label} does not support ${humanFeature(feature)}`;
	return `${label}: excluded by user — click to re-include`;
}

function humanFeature(feature: PermissionFeature): string {
	switch (feature) {
		case "tool_allowlist":
			return "fine-grained tool allowlists";
		case "tool_denylist":
			return "fine-grained tool denylists";
		case "tool_ask":
			return "ask-before-use prompts";
		case "hooks":
			return "hooks";
		case "sandbox_mode":
			return "sandbox mode";
		case "approval_policy":
			return "approval policy";
		case "project_trust":
			return "project trust";
		case "additional_directories":
			return "additional directories";
	}
}

export function HarnessAffinityChips({
	installedHarnesses,
	labels,
	capabilities,
	feature,
	affinity,
	onToggle,
	collapsedWhenAll = true,
	supports,
}: HarnessAffinityChipsProps) {
	const states: { id: string; label: string; state: ChipState }[] =
		installedHarnesses.map((id) => {
			const isSupported = supports
				? supports(id)
				: (capabilities[id] ?? []).includes(feature);
			const explicit = affinity ?? null;
			const excluded = explicit !== null && !explicit.includes(id);
			let state: ChipState;
			if (!isSupported) state = "unsupported";
			else if (excluded) state = "excluded";
			else state = "applied";
			return { id, label: harnessDisplayLabel(id, labels), state };
		});

	const everyApplied = states.every((s) => s.state === "applied");
	const allowCollapse =
		collapsedWhenAll &&
		(affinity === null || affinity === undefined) &&
		everyApplied;

	if (allowCollapse) {
		return (
			<div
				className="harness-affinity-chips"
				data-mode="collapsed"
				style={{ minWidth: 0 }}
			>
				<button
					type="button"
					className="affinity-chip affinity-chip-all"
					style={{
						display: "inline-flex",
						alignItems: "center",
						gap: 4,
						padding: "2px 8px",
						borderRadius: 999,
						background: "color-mix(in oklab, var(--green) 14%, transparent)",
						color: "var(--green)",
						border: "0",
						fontFamily: "var(--font-mono)",
						fontSize: 10.5,
						letterSpacing: "0.04em",
					}}
					title="Applies to every capable harness — click any individual chip to narrow."
					aria-label="Applies to every capable harness"
				>
					<span
						style={{
							width: 6,
							height: 6,
							borderRadius: 999,
							background: "var(--green)",
						}}
					/>
					all
				</button>
			</div>
		);
	}

	return (
		<div
			className="perm-affinity harness-affinity-chips"
			data-mode="expanded"
			role="group"
			aria-label="Harness affinity"
		>
			{states.map(({ id, label, state }) => {
				const readonly = state === "unsupported";
				return (
					<button
						key={id}
						type="button"
						className="affinity-chip"
						data-state={state}
						data-harness={id}
						aria-pressed={state === "applied"}
						aria-label={`${harnessShortCode(id, label)} ${chipTooltip(
							state,
							label,
							feature,
						)}`}
						disabled={readonly || !onToggle}
						title={chipTooltip(state, label, feature)}
						style={{ ["--harness-accent" as string]: harnessTint(id) }}
						onClick={() => {
							if (readonly || !onToggle) return;
							onToggle(id, state === "applied" ? "excluded" : "applied");
						}}
					>
						<HarnessGlyph id={id} label={label} size={16} decorative />
					</button>
				);
			})}
		</div>
	);
}
