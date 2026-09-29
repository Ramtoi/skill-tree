import type { ReactNode } from "react";
import { Button } from "../Button";
import { ChipRadios, type ChipRadioOption } from "../ChipRadios";
import { Icon } from "../Icon";
import { Select, type SelectOption } from "../Select";
import { HarnessIconGroup } from "../harness/HarnessGlyph";
import { FEATURE_KEY } from "@/lib/permissionSettingSupport";
import {
	scopeKey,
	type NormalizedPermissions,
	type PermissionFeature,
	type Scope,
} from "@/types/permissions";

const SANDBOX_OPTIONS: SelectOption<string>[] = [
	{
		value: "",
		label: "inherit",
		hint: "Unset here — the global or harness default applies",
	},
	{
		value: "read-only",
		label: "read-only",
		hint: "The agent may read but not write",
	},
	{
		value: "workspace-write",
		label: "workspace-write",
		hint: "Writes inside the workspace only",
	},
	{ value: "danger-full-access", label: "danger-full-access", hint: "No sandbox" },
];

const APPROVAL_OPTIONS: SelectOption<string>[] = [
	{
		value: "",
		label: "inherit",
		hint: "Unset here — the global or harness default applies",
	},
	{ value: "never", label: "never", hint: "Never asks before running a tool" },
	{
		value: "on-failure",
		label: "on-failure",
		hint: "Asks only after a tool call fails",
	},
	{
		value: "unless-trusted",
		label: "unless-trusted",
		hint: "Asks unless the project is trusted",
	},
	{
		value: "on-request",
		label: "on-request",
		hint: "Asks when the agent requests escalation",
	},
];

const TRUST_OPTIONS: ChipRadioOption<"inherit" | "trusted" | "untrusted">[] = [
	{ value: "inherit", label: "inherit" },
	{ value: "trusted", label: "trusted" },
	{ value: "untrusted", label: "untrusted" },
];

export interface PermissionSettingRowProps {
	feature: PermissionFeature;
	draft: NormalizedPermissions;
	onChange: (next: NormalizedPermissions) => void;
	scope: Scope;
	globalDraft: NormalizedPermissions | null;
	/** Harnesses honoring this setting shown as a glyph group on the key line.
	 *  Empty renders no group at all. */
	glyphIds: string[];
	glyphTitle?: string;
	labels: Record<string, string>;
	/** Set-but-unsupported: no installed harness honors this value. Renders a
	 *  `data-orphan` marker + a clear-it hint (the All view's edge case). */
	orphan?: boolean;
}

const FEATURE_DRAFT_FIELD: Record<
	PermissionFeature,
	keyof NormalizedPermissions | null
> = {
	tool_allowlist: null,
	tool_denylist: null,
	tool_ask: null,
	hooks: null,
	sandbox_mode: "sandbox_mode",
	approval_policy: "approval_policy",
	project_trust: "project_trust",
	additional_directories: "additional_dirs",
};

/** `.perm-setting`'s recurring "inherits `<value>`" note (project scope,
 *  draft field unset here, global carries a value). Unchanged rules. */
function InheritNote({
	feature,
	scope,
	draft,
	globalDraft,
}: {
	feature: PermissionFeature;
	scope: Scope;
	draft: NormalizedPermissions;
	globalDraft: NormalizedPermissions | null;
}) {
	if (scope.kind !== "project" || !globalDraft) return null;
	const field = FEATURE_DRAFT_FIELD[feature];
	if (!field) return null;
	const draftVal = draft[field] as string | boolean | null | undefined;
	if (draftVal !== null && draftVal !== undefined) return null;
	const globalVal = globalDraft[field] as string | boolean | null | undefined;
	if (globalVal === null || globalVal === undefined) return null;
	return (
		<span className="perm-inherit-note">
			inherits <code>{String(globalVal)}</code>
		</span>
	);
}

/**
 * One harness-level setting row: `sandbox_mode`, `approval_policy`,
 * `project_trust`, or `additional_dirs`. The control matches how often the
 * value changes (side-panel rule 7) — `Select` for the two longer
 * vocabularies, `ChipRadios` for the three-way trust toggle, a well-per-row
 * list for directories.
 */
export function PermissionSettingRow({
	feature,
	draft,
	onChange,
	scope,
	globalDraft,
	glyphIds,
	glyphTitle,
	labels,
	orphan,
}: PermissionSettingRowProps) {
	let control: ReactNode = null;
	let meta: ReactNode = null;

	switch (feature) {
		case "sandbox_mode":
			control = (
				<Select
					label="sandbox_mode"
					value={draft.sandbox_mode ?? ""}
					options={SANDBOX_OPTIONS}
					onChange={(v) => onChange({ ...draft, sandbox_mode: v || null })}
				/>
			);
			break;
		case "approval_policy":
			control = (
				<Select
					label="approval_policy"
					value={draft.approval_policy ?? ""}
					options={APPROVAL_OPTIONS}
					onChange={(v) => onChange({ ...draft, approval_policy: v || null })}
				/>
			);
			break;
		case "project_trust":
			control = (
				<ChipRadios
					name={`project_trust-${scopeKey(scope)}`}
					label="project_trust"
					value={
						draft.project_trust === null
							? "inherit"
							: draft.project_trust
								? "trusted"
								: "untrusted"
					}
					options={TRUST_OPTIONS}
					onChange={(v) =>
						onChange({
							...draft,
							project_trust: v === "inherit" ? null : v === "trusted",
						})
					}
					title="Codex project trust. Trusted activates the project's committed .codex config and hooks."
				/>
			);
			break;
		case "additional_directories":
			meta = (
				<span className="perm-setting-meta">
					{draft.additional_dirs.length}
				</span>
			);
			control = (
				<>
					{draft.additional_dirs.length > 0 && (
						<div className="perm-dirs">
							{draft.additional_dirs.map((d, i) => (
								<div className="perm-dir-row" key={i}>
									<Icon name="folder" size={11} />
									<input
										aria-label={`Additional directory ${i + 1}`}
										value={d}
										placeholder="/abs/path"
										onChange={(e) => {
											const next = [...draft.additional_dirs];
											next[i] = e.target.value;
											onChange({ ...draft, additional_dirs: next });
										}}
									/>
									<button
										type="button"
										className="perm-icon-btn"
										aria-label="Remove directory"
										onClick={() =>
											onChange({
												...draft,
												additional_dirs: draft.additional_dirs.filter(
													(_, j) => j !== i,
												),
											})
										}
									>
										<Icon name="x" size={11} />
									</button>
								</div>
							))}
						</div>
					)}
					<Button
						variant="ghost"
						size="sm"
						icon="plus"
						onClick={() =>
							onChange({
								...draft,
								additional_dirs: [...draft.additional_dirs, ""],
							})
						}
					>
						Add directory
					</Button>
				</>
			);
			break;
	}

	return (
		<div
			className="perm-setting"
			data-feature={feature}
			data-orphan={orphan || undefined}
		>
			<div className="perm-setting-key">
				<span className="k">{FEATURE_KEY[feature]}</span>
				{meta}
				{glyphIds.length > 0 && (
					<span title={glyphTitle}>
						<HarnessIconGroup ids={glyphIds} labels={labels} size={14} />
					</span>
				)}
				<InheritNote
					feature={feature}
					scope={scope}
					draft={draft}
					globalDraft={globalDraft}
				/>
			</div>
			{control}
			{orphan && (
				<div className="perm-side-hint">No installed harness honors this.</div>
			)}
		</div>
	);
}
