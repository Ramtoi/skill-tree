// Pure derivation behind the permissions side panel's harness-level SETTINGS
// sections (SPEC A). Drives which of the four scalar/array settings render as
// SHARED (≥2 installed harnesses honor it) vs a single harness's EXCLUSIVE
// settings — the same capability data the affinity chips and the harness
// filter tabs read, never a second hardcoded matrix.

import type {
	Capabilities,
	NormalizedPermissions,
	PermissionFeature,
} from "@/types/permissions";

/** The four harness-level settings the side panel surfaces (as opposed to the
 *  three tool_* rule-list capabilities and `hooks`, which render elsewhere). */
export const SETTING_FEATURES: PermissionFeature[] = [
	"sandbox_mode",
	"approval_policy",
	"project_trust",
	"additional_directories",
];

/** Registry key + draft field a setting feature maps to. `null` for the
 *  three rule-kind capabilities and `hooks`, which this module never touches. */
const FEATURE_FIELD: Record<
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

/** The registry key rendered on a setting row's key line (`additional_dirs`,
 *  not `additional_directories` — the capability id and the draft field
 *  disagree on this one). */
export const FEATURE_KEY: Record<PermissionFeature, string> = {
	tool_allowlist: "tool_allowlist",
	tool_denylist: "tool_denylist",
	tool_ask: "tool_ask",
	hooks: "hooks",
	sandbox_mode: "sandbox_mode",
	approval_policy: "approval_policy",
	project_trust: "project_trust",
	additional_directories: "additional_dirs",
};

/** Installed harnesses whose capability set includes `feature`, in `installed`
 *  order (already sorted by the caller). */
export function supportingHarnesses(
	feature: PermissionFeature,
	installed: string[],
	capabilities: Capabilities,
): string[] {
	return installed.filter((id) => (capabilities[id] ?? []).includes(feature));
}

export interface SettingPartition {
	/** Supported by ≥ 2 installed harnesses (or, with exactly one installed
	 *  harness, everything it supports — there is no "only" distinction to
	 *  draw against zero other harnesses). */
	shared: PermissionFeature[];
	/** harness id → its exclusive settings (supported by it and no other
	 *  installed harness). Empty with 0 or 1 installed harnesses. */
	exclusive: Record<string, PermissionFeature[]>;
}

/** Partition the four settings into "shared" vs "exclusive to one harness",
 *  given which harnesses are installed. A setting no installed harness
 *  supports is in neither bucket — see `orphanSettings` for that case.
 *  Zero installed harnesses is not "nothing supports anything": there is no
 *  harness to gate on, so every setting stays live and editable under All
 *  (never hidden, never flagged as an orphan) — the value simply takes
 *  effect once some harness that honors it is installed. */
export function partitionSettings(
	installed: string[],
	capabilities: Capabilities,
): SettingPartition {
	if (installed.length === 0) {
		return { shared: [...SETTING_FEATURES], exclusive: {} };
	}
	const shared: PermissionFeature[] = [];
	const exclusive: Record<string, PermissionFeature[]> = {};
	for (const feature of SETTING_FEATURES) {
		const supporters = supportingHarnesses(feature, installed, capabilities);
		if (supporters.length === 0) continue;
		if (installed.length <= 1 || supporters.length >= 2) {
			shared.push(feature);
		} else {
			const id = supporters[0];
			(exclusive[id] ??= []).push(feature);
		}
	}
	return { shared, exclusive };
}

/** Whether the draft carries a non-default value for `feature` — non-null for
 *  a scalar, non-empty for `additional_dirs`. */
function featureIsSet(
	draft: NormalizedPermissions,
	feature: PermissionFeature,
): boolean {
	if (feature === "additional_directories")
		return draft.additional_dirs.length > 0;
	const field = FEATURE_FIELD[feature];
	if (!field) return false;
	const value = draft[field];
	return value !== null && value !== undefined && value !== "";
}

/** Settings the draft has SET but no installed harness can honor — the "you
 *  should clear this" edge case in the All view's Shared settings section.
 *  Zero installed harnesses is never an orphan case — see `partitionSettings`. */
export function orphanSettings(
	draft: NormalizedPermissions,
	installed: string[],
	capabilities: Capabilities,
): PermissionFeature[] {
	if (installed.length === 0) return [];
	return SETTING_FEATURES.filter((feature) => {
		if (supportingHarnesses(feature, installed, capabilities).length > 0)
			return false;
		return featureIsSet(draft, feature);
	});
}

type SettingsSlice = Pick<
	NormalizedPermissions,
	"sandbox_mode" | "approval_policy" | "project_trust" | "additional_dirs"
>;

/** `null`/`undefined`/`""` all read as "unset" — the same normalization
 *  `PermissionSettingRow`'s controls already apply on save. */
function normSettingValue(
	v: string | boolean | null | undefined,
): string | boolean | null {
	return v === undefined || v === null || v === "" ? null : v;
}

/** Whether the four harness-level settings differ between two permission
 *  blocks (e.g. the live draft vs. the last-loaded server payload) — the
 *  narrow "is a SETTING dirty" check behind rule 11's force-open, distinct
 *  from the whole-draft `dirty` flag (which also covers rules/hooks). */
export function settingsDiffer(a: SettingsSlice, b: SettingsSlice): boolean {
	if (normSettingValue(a.sandbox_mode) !== normSettingValue(b.sandbox_mode))
		return true;
	if (
		normSettingValue(a.approval_policy) !== normSettingValue(b.approval_policy)
	)
		return true;
	if (normSettingValue(a.project_trust) !== normSettingValue(b.project_trust))
		return true;
	const ad = a.additional_dirs;
	const bd = b.additional_dirs;
	if (ad.length !== bd.length) return true;
	return ad.some((v, i) => v !== bd[i]);
}

/** Short display labels for whatever the draft has SET, in `sandbox_mode →
 *  approval_policy → project_trust → additional_dirs` order — a section
 *  head's "closed is not hidden" summary (side-panel rule 1). Empty when
 *  nothing is set. */
export function settingValueLabels(draft: SettingsSlice): string[] {
	const labels: string[] = [];
	if (draft.sandbox_mode) labels.push(draft.sandbox_mode);
	if (draft.approval_policy) labels.push(draft.approval_policy);
	if (draft.project_trust !== null && draft.project_trust !== undefined) {
		labels.push(draft.project_trust ? "trusted" : "untrusted");
	}
	if (draft.additional_dirs.length > 0) {
		labels.push(
			`${draft.additional_dirs.length} dir${draft.additional_dirs.length === 1 ? "" : "s"}`,
		);
	}
	return labels;
}
