import { Tag } from "./Tag";
import { Button } from "./Button";
import { Icon } from "./Icon";
import { RiskBadge } from "./RiskBadge";
import { HarnessAffinityChips, type ChipState } from "./HarnessAffinityChips";
import type {
	Capabilities,
	RiskFinding,
	Rule,
	RuleKind,
} from "@/types/permissions";
import { kindFeature, harnessSupportsRule } from "@/types/permissions";
import { useAutocomplete } from "@/lib/useAutocomplete";
import { SuggestionDropdown } from "./SuggestionDropdown";

export interface PermissionRowProps {
	rule: Rule;
	installedHarnesses: string[];
	harnessLabels?: Record<string, string>;
	capabilities: Capabilities;
	/** Active scope the row is being edited under. Drives inheritance: a
	 *  `origin: "global"` rule is only read-only when viewed from a *project*. */
	scopeKind: "global" | "project";
	/** Inline validation result, if any. */
	validation?: { ok: boolean; error: string | null };
	/** Live risk findings attached to this row. */
	risks?: RiskFinding[];
	/** Updates rule in staged payload. Called with the next Rule. */
	onChange?: (next: Rule) => void;
	/** Change this rule's kind (allow ↔ ask ↔ deny), moving it between the
	 *  draft's per-kind lists while preserving pattern + affinity + origin. */
	onChangeKind?: (next: RuleKind) => void;
	onDelete?: () => void;
	/** Triggered when the user clicks `Copy to project` on an inherited row.
	 *  Project view only. */
	onPromote?: () => void;
	/** Triggered when the user moves a project-owned rule up to the global scope.
	 *  Project view only; the action writes immediately (cross-scope). */
	onDemote?: () => void;
	/** When true, inputs are disabled (e.g. inherited via global). */
	readOnly?: boolean;
	/** Existing patterns (other rules + preset catalog) offered as type-to-filter
	 *  completions in the pattern field. Excludes this row's own pattern upstream
	 *  is unnecessary — the hook drops the exact-match candidate itself. */
	patternSuggestions?: string[];
	/** Project scope: this `allow` rule is dead because an inherited global
	 *  `deny` shares its pattern (deny wins). Rendered struck-through + a hint. */
	shadowedByGlobalDeny?: boolean;
}

const KIND_SWITCH: { kind: RuleKind; label: string; accent: string }[] = [
	{ kind: "allow", label: "ALLOW", accent: "var(--green)" },
	{ kind: "ask", label: "ASK", accent: "var(--amber)" },
	{ kind: "deny", label: "DENY", accent: "var(--red)" },
];

const KIND_ICON: Record<RuleKind, "check" | "x" | "eye"> = {
	allow: "check",
	deny: "x",
	ask: "eye",
};

function provenanceMeta(origin: "global" | "project" | undefined) {
	if (origin === "global")
		return {
			label: "via global",
			color: "var(--violet)",
			tooltip:
				"This rule is inherited from the global scope. Promote it to override here.",
		};
	return {
		label: "project",
		color: "var(--amber)",
		tooltip: "This rule is defined directly on the project.",
	};
}

export function PermissionRow({
	rule,
	installedHarnesses,
	harnessLabels,
	capabilities,
	scopeKind,
	validation,
	risks,
	onChange,
	onChangeKind,
	onDelete,
	onPromote,
	onDemote,
	readOnly = false,
	patternSuggestions = [],
	shadowedByGlobalDeny = false,
}: PermissionRowProps) {
	const prov = provenanceMeta(rule.origin);
	const invalid = validation?.ok === false;
	const feature = kindFeature(rule.kind);
	// A global-origin rule is only "inherited" (read-only) when viewed FROM a
	// project. In the global view the global rule IS the source — fully editable.
	const inherited = rule.origin === "global" && scopeKind === "project";
	const lockEdit = readOnly || inherited;
	// Provenance / promote / demote affordances are only meaningful in a project
	// view, where rules can come from two scopes. Hide them in the global view.
	const showProvenance = scopeKind === "project";
	// Pattern-aware support: folds in Codex's Bash-only command-rule caveat (D6).
	const supportsHarness = (id: string) =>
		harnessSupportsRule(id, rule, capabilities);

	// Author-time capability warning: installed harnesses that can't express this
	// rule AND aren't explicitly excluded by the rule's affinity. These are the
	// harnesses you actually use where the rule will silently no-op at sync, so we
	// surface it now (quietly, in amber) rather than only at sync time.
	const explicitAffinity = rule.harnesses ?? null;
	const wontApplyOn = installedHarnesses.filter(
		(id) =>
			!supportsHarness(id) &&
			(explicitAffinity === null || explicitAffinity.includes(id)),
	);
	const wontApplyLabels = wontApplyOn.map(
		(id) => harnessLabels?.[id] ?? id,
	);

	function updatePattern(value: string) {
		if (lockEdit) return;
		onChange?.({ ...rule, pattern: value });
	}

	// Type-to-filter over existing patterns (other rules + the preset catalog) so
	// a Bash prefix is discoverable and consistent instead of retyped by hand.
	const patternAc = useAutocomplete({
		query: rule.pattern,
		items: patternSuggestions,
		onPick: updatePattern,
	});

	function toggleAffinity(harnessId: string, nextState: ChipState) {
		if (lockEdit) return;
		const current =
			rule.harnesses ?? installedHarnesses.filter(supportsHarness);
		let next: string[];
		if (nextState === "applied") {
			if (current.includes(harnessId)) return;
			next = [...current, harnessId];
		} else {
			next = current.filter((id) => id !== harnessId);
		}
		const capableSet = installedHarnesses.filter(supportsHarness);
		const isFullSet =
			next.length === capableSet.length &&
			next.every((id) => capableSet.includes(id));
		onChange?.({
			...rule,
			harnesses: isFullSet ? null : next.sort(),
		});
	}

	return (
		<div
			className="perm-row permission-row"
			data-kind={rule.kind}
			data-origin={rule.origin ?? "project"}
			data-invalid={invalid ? "true" : undefined}
			data-shadowed={shadowedByGlobalDeny ? "true" : undefined}
		>
			{lockEdit || !onChangeKind ? (
				<span className="perm-row-kind">
					<Icon name={KIND_ICON[rule.kind]} size={11} />
					{rule.kind.toUpperCase()}
				</span>
			) : (
				<div
					className="perm-row-kind-switch"
					role="group"
					aria-label="Rule kind"
				>
					{KIND_SWITCH.map((k) => (
						<button
							key={k.kind}
							type="button"
							className="perm-kind-btn"
							data-kind={k.kind}
							aria-pressed={rule.kind === k.kind}
							aria-label={`Set kind ${k.label}`}
							title={`Change to ${k.label.toLowerCase()}`}
							style={{ ["--accent" as string]: k.accent }}
							onClick={() => {
								if (k.kind !== rule.kind) onChangeKind(k.kind);
							}}
						>
							<Icon name={KIND_ICON[k.kind]} size={10} />
							{k.label}
						</button>
					))}
				</div>
			)}

			<div className="perm-row-pattern autocomplete-wrap">
				<input
					type="text"
					className="permission-pattern"
					aria-label="Pattern"
					value={rule.pattern}
					disabled={lockEdit}
					onChange={(e) => updatePattern(e.target.value)}
					onFocus={() => !lockEdit && patternAc.show()}
					onBlur={() => patternAc.hide()}
					onKeyDown={(e) => {
						if (!lockEdit) patternAc.handleKeyDown(e);
					}}
					placeholder="Bash(npm:*)"
					spellCheck={false}
				/>
				{!lockEdit && (
					<SuggestionDropdown ac={patternAc} label="Existing patterns" />
				)}
				{invalid && validation?.error && (
					<div role="alert" className="perm-row-error">
						{validation.error}
					</div>
				)}
				{shadowedByGlobalDeny && (
					<div className="perm-row-shadow-hint" role="status">
						shadowed by global deny
					</div>
				)}
			</div>

			{/* At narrow width the 4-glyph affinity row is collapsed behind a
			    disclosure (F5) so a single rule no longer fills the viewport; on
			    desktop the summary is hidden and the chips render inline. */}
			<details className="perm-row-affinity">
				<summary className="perm-row-affinity-summary">affinity</summary>
				<HarnessAffinityChips
					installedHarnesses={installedHarnesses}
					labels={harnessLabels}
					capabilities={capabilities}
					feature={feature}
					affinity={rule.harnesses}
					onToggle={lockEdit ? undefined : toggleAffinity}
					collapsedWhenAll={false}
					supports={supportsHarness}
				/>
			</details>

			<div className="perm-row-prov">
				{showProvenance && (
					<span title={prov.tooltip} style={{ display: "inline-flex" }}>
						<Tag color={prov.color} className="perm-row-prov-tag">
							{prov.label}
						</Tag>
					</span>
				)}
				{risks?.map((r) => (
					<RiskBadge
						key={`${r.code}:${r.detail}`}
						code={r.code}
						severity={r.severity}
						explanation={r.explanation}
						detail={r.detail}
					/>
				))}
				{wontApplyOn.length > 0 && (
					<span
						className="perm-wont-apply"
						role="status"
						title={`This rule can't be expressed on ${wontApplyLabels.join(
							", ",
						)}. It will be skipped there at sync — narrow the harness chips or use a shape that harness supports.`}
						aria-label={`Will not apply on ${wontApplyLabels.join(", ")}`}
					>
						<Icon name="warning" size={10} />
						won't apply on {wontApplyLabels.join(", ")}
					</span>
				)}
			</div>

			<div className="perm-row-actions">
				{showProvenance && inherited && onPromote && (
					<Button
						size="sm"
						variant="ghost"
						icon="duplicate"
						title="Copy this global rule down into the project. The global rule stays in effect for other projects; here, your project copy wins."
						onClick={() => onPromote()}
					>
						Copy to project
					</Button>
				)}
				{showProvenance && !inherited && rule.origin === "project" && onDemote && (
					<Button
						size="sm"
						variant="ghost"
						icon="chevronUp"
						title="Move this rule up to the global scope so it applies to every project. Saves immediately."
						onClick={() => onDemote()}
					>
						Move to global
					</Button>
				)}
				{!lockEdit && onDelete && (
					<button
						type="button"
						className="perm-icon-btn permission-row-delete"
						aria-label="Delete rule"
						title="Delete rule"
						onClick={() => onDelete()}
					>
						<Icon name="trash" size={13} />
					</button>
				)}
			</div>
		</div>
	);
}
