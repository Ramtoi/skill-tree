import { useMemo } from "react";
import { useRegistry } from "@/hooks/useRegistry";
import {
	BUILTIN_PRESETS,
	BUILTIN_PRESET_IDS,
	type PermissionPreset,
	type PresetCategory,
	type PresetRule,
} from "@/lib/permissionPresets";
import type { RuleKind } from "@/types/permissions";

function normaliseCategory(value: unknown): PresetCategory {
	if (value === "vcs" || value === "build") return value;
	return "custom";
}

function normaliseRule(raw: {
	pattern: string;
	kind?: string;
	description?: string;
	enabled_by_default?: boolean;
}): PresetRule {
	const kind: RuleKind =
		raw.kind === "deny" || raw.kind === "ask" ? raw.kind : "allow";
	return {
		pattern: raw.pattern,
		kind,
		description: raw.description ?? "",
		enabledByDefault: raw.enabled_by_default ?? true,
	};
}

/** Returns built-in presets followed by user-defined presets from the registry.
 *  User entries colliding with a built-in id are dropped (built-ins win). */
export function usePermissionPresets(): {
	presets: PermissionPreset[];
	isLoading: boolean;
} {
	const { data: registry, isLoading } = useRegistry();

	const presets = useMemo<PermissionPreset[]>(() => {
		const out: PermissionPreset[] = [...BUILTIN_PRESETS];
		const userBlock = registry?.permission_presets;
		if (!userBlock) return out;
		const userPresets: PermissionPreset[] = [];
		for (const [id, entry] of Object.entries(userBlock)) {
			if (BUILTIN_PRESET_IDS.has(id)) continue;
			userPresets.push({
				id,
				name: entry.name ?? id,
				description: entry.description ?? "",
				icon: entry.icon ?? "📦",
				category: normaliseCategory(entry.category),
				builtin: false,
				rules: (entry.rules ?? []).map(normaliseRule),
			});
		}
		userPresets.sort((a, b) => a.name.localeCompare(b.name));
		out.push(...userPresets);
		return out;
	}, [registry]);

	return { presets, isLoading };
}
