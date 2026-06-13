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

export interface PermissionRowProps {
	rule: Rule;
	installedHarnesses: string[];
	harnessLabels?: Record<string, string>;
	capabilities: Capabilities;
	/** Inline validation result, if any. */
	validation?: { ok: boolean; error: string | null };
	/** Live risk findings attached to this row. */
	risks?: RiskFinding[];
	/** Updates rule in staged payload. Called with the next Rule. */
	onChange?: (next: Rule) => void;
	onDelete?: () => void;
	/** Triggered when the user clicks `Promote to project` on an inherited row. */
	onPromote?: () => void;
	/** When true, inputs are disabled (e.g. inherited via global). */
	readOnly?: boolean;
}

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
	validation,
	risks,
	onChange,
	onDelete,
	onPromote,
	readOnly = false,
}: PermissionRowProps) {
	const prov = provenanceMeta(rule.origin);
	const invalid = validation?.ok === false;
	const feature = kindFeature(rule.kind);
	const inherited = rule.origin === "global";
	const lockEdit = readOnly || inherited;
	// Pattern-aware support: folds in Codex's Bash-only command-rule caveat (D6).
	const supportsHarness = (id: string) =>
		harnessSupportsRule(id, rule, capabilities);

	function updatePattern(value: string) {
		if (lockEdit) return;
		onChange?.({ ...rule, pattern: value });
	}

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
		>
			<span className="perm-row-kind">
				<Icon name={KIND_ICON[rule.kind]} size={11} />
				{rule.kind.toUpperCase()}
			</span>

			<div className="perm-row-pattern">
				<input
					type="text"
					className="permission-pattern"
					aria-label="Pattern"
					value={rule.pattern}
					disabled={lockEdit}
					onChange={(e) => updatePattern(e.target.value)}
					placeholder="Bash(npm:*)"
					spellCheck={false}
				/>
				{invalid && validation?.error && (
					<div role="alert" className="perm-row-error">
						{validation.error}
					</div>
				)}
			</div>

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

			<div className="perm-row-prov">
				<span title={prov.tooltip} style={{ display: "inline-flex" }}>
					<Tag color={prov.color} className="perm-row-prov-tag">
						{prov.label}
					</Tag>
				</span>
				{risks?.map((r) => (
					<RiskBadge
						key={`${r.code}:${r.detail}`}
						code={r.code}
						severity={r.severity}
						explanation={r.explanation}
						detail={r.detail}
					/>
				))}
			</div>

			<div className="perm-row-actions">
				{inherited && onPromote && (
					<Button
						size="sm"
						variant="ghost"
						icon="duplicate"
						title="Copy this global rule into the project. The global rule stays in effect for other projects; here, your copy wins."
						onClick={() => onPromote()}
					>
						Promote
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
