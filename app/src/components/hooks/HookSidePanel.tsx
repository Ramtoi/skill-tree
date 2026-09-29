import { useMemo } from "react";
import { Button } from "@/components/Button";
import { HarnessReachPanel } from "@/components/HarnessReachPanel";
import { SidePanelSection } from "@/components/SidePanelSection";
import { StatePill } from "@/components/StatePill";
import { HookSettingsSection } from "@/components/hooks/HookSettingsSection";
import type { HookCapabilitiesCache, HookShow } from "@/hooks/useHooks";
import { harnessReachHint, reachRollup } from "@/lib/hookReach";

const SECTIONS_KEY = "st:hook-editor:sections";

export interface HookSidePanelProps {
	hook: HookShow | undefined;
	isNew: boolean;
	isBuiltin: boolean;
	coreReadOnly: boolean;

	installedHarnesses: string[];
	affinity: string[];
	onAffinityChange: (next: string[]) => void;
	capabilities: HookCapabilitiesCache | null | undefined;
	event: string;

	timeout: string;
	onTimeoutChange: (v: string) => void;

	projects: string[];
	onSettingsSave: (scope: string, settings: Record<string, unknown>) => Promise<unknown>;

	onDeleteClick: () => void;
}

/**
 * The right column (side-panels wave 4): HARNESSES → (built-ins: SETTINGS then
 * ADVANCED; everyone else: ADVANCED then SETTINGS) → danger zone. Extracted
 * out of `HookEditor.tsx` to keep the screen under the 1000-line component-size
 * cap. `.hook-editor-side` keeps the panel's INNER grammar only (scoped block
 * in `side-panel.css`) — it is NOT `.editor-side`, so `.hook-editor` stays the
 * screen's one scroller (GRILL B3).
 */
export function HookSidePanel({
	hook,
	isNew,
	isBuiltin,
	coreReadOnly,
	installedHarnesses,
	affinity,
	onAffinityChange,
	capabilities,
	event,
	timeout,
	onTimeoutChange,
	projects,
	onSettingsSave,
	onDeleteClick,
}: HookSidePanelProps) {
	const { fires, total, capsKnown } = useMemo(
		() => reachRollup(installedHarnesses, affinity, capabilities, event),
		[installedHarnesses, affinity, capabilities, event],
	);
	// AUDIT M3: an un-probed install must admit ignorance, not assert "fires on
	// 0 of N" — the body's own `HarnessReachPanel` renders "reach unknown" in
	// exactly this case, and the head must never disagree with it.
	const harnessSummary =
		total === 0
			? "no harnesses installed"
			: !capsKnown
				? "reach unknown"
				: `fires on ${fires} of ${total}`;
	const harnessHint = harnessReachHint(installedHarnesses, affinity);

	// The single field this section holds is one of the 16 core-draft fields, so
	// its own "did the user touch it" check is a plain comparison against the
	// server's last-known value — not the whole-form `dirty` flag, which cannot
	// say WHICH field changed. In create mode there is no server value yet, so
	// the baseline is the empty string (AUDIT m1) — otherwise a user who opens
	// ADVANCED, types a timeout, and collapses it again stages the value inside
	// a closed section with no signal anywhere that it is there.
	const timeoutDirty =
		timeout !== (hook?.timeout != null ? String(hook.timeout) : "");
	const timeoutSummary = timeout.trim() ? `${timeout}s` : "harness default";

	const settingsBlock =
		!isNew && hook ? (
			<HookSettingsSection
				hook={hook}
				projects={projects}
				primary={isBuiltin}
				onSave={onSettingsSave}
			/>
		) : null;

	const advancedBlock = (
		<SidePanelSection
			id="advanced"
			title="Advanced"
			defaultOpen={false}
			storageKey={SECTIONS_KEY}
			forceOpen={timeoutDirty}
			summary={
				<>
					<span className="text-dim">{timeoutSummary}</span>
					{timeoutDirty && <StatePill state="unsaved">unsaved</StatePill>}
				</>
			}
		>
			<dl className="kv">
				<div className="kv-row">
					<dt>timeout</dt>
					<dd>
						{coreReadOnly ? (
							<span className="kv-static" data-empty={!timeout || undefined}>
								{timeout || "harness default"}
							</span>
						) : (
							<input
								type="number"
								value={timeout}
								onChange={(e) => onTimeoutChange(e.target.value)}
								placeholder="harness default"
								title="Seconds before the harness kills the hook; blank uses the harness default"
								aria-label="timeout"
							/>
						)}
					</dd>
				</div>
			</dl>
		</SidePanelSection>
	);

	return (
		<div className="hook-editor-side">
			<SidePanelSection
				id="harnesses"
				title="Harnesses"
				defaultOpen
				storageKey={SECTIONS_KEY}
				headTitle={harnessHint}
				summary={<span className="text-dim">{harnessSummary}</span>}
			>
				<HarnessReachPanel
					installed={installedHarnesses}
					affinity={affinity}
					onChange={onAffinityChange}
					capabilities={capabilities}
					event={event}
					readOnly={coreReadOnly}
					intro={false}
				/>
			</SidePanelSection>

			{/* Built-ins: settings are the ONLY editable surface, so they sit
			    directly under Harnesses instead of below the advanced knobs. */}
			{isBuiltin ? (
				<>
					{settingsBlock}
					{advancedBlock}
				</>
			) : (
				<>
					{advancedBlock}
					{settingsBlock}
				</>
			)}

			{!isNew && hook && !isBuiltin && (
				<div className="danger-zone">
					<h4>Danger zone</h4>
					<div className="danger-note text-dim">
						Deleting removes the definition and detaches it from every scope it
						is attached to.
					</div>
					<div className="actions">
						<Button variant="danger" icon="trash" onClick={onDeleteClick}>
							Delete this hook
						</Button>
					</div>
				</div>
			)}
			{/* Built-ins have no danger zone at all — they can't be deleted, and a
			    danger-zone-styled block offering no action at all wears a
			    destructive register for nothing (GRILL/ASSESSMENT #5). The one fact
			    it carried now lives in `.hook-builtin-note`, above the columns. */}
		</div>
	);
}
