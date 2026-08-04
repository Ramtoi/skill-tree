// Mirror of the Python BUILTIN_PRESETS in permission_presets.py. The Python
// definitions are the source of truth; this file is duplicated for the UI so
// the sheet can render offline without a Python round-trip.
//
// Keep BUILTIN_PRESETS in sync with permission_presets.BUILTIN_PRESETS.

import type { Rule, RuleKind } from "@/types/permissions";

export type PresetCategory = "vcs" | "build" | "custom";

export interface PresetRule {
	pattern: string;
	kind: RuleKind;
	description: string;
	enabledByDefault: boolean;
}

export interface PermissionPreset {
	id: string;
	name: string;
	description: string;
	icon: string;
	category: PresetCategory;
	builtin: boolean;
	rules: PresetRule[];
}

function rule(
	pattern: string,
	description: string,
	enabledByDefault = true,
): PresetRule {
	return { pattern, kind: "allow", description, enabledByDefault };
}

const GIT_SAFE_RULES: PresetRule[] = [
	rule("Bash(git status*)", "Working tree status"),
	rule("Bash(git log*)", "Commit history"),
	rule("Bash(git diff*)", "Diff working tree / commits"),
	rule("Bash(git show*)", "Show objects / commits"),
	rule("Bash(git branch*)", "List / inspect branches"),
	rule("Bash(git remote*)", "List / inspect remotes"),
	rule("Bash(git stash list*)", "List stash entries"),
	rule("Bash(git stash show*)", "Show stash diff"),
	rule("Bash(git tag*)", "List tags"),
	rule("Bash(git ls-files*)", "List tracked files"),
	rule("Bash(git blame*)", "Line-by-line attribution"),
	rule("Bash(git shortlog*)", "Summarise commit authors"),
	rule(
		"Bash(git fetch*)",
		"Fetch from remote (network, no local writes)",
		false,
	),
	rule("Bash(git describe*)", "Describe refs"),
	rule("Bash(git rev-parse*)", "Parse git refs / hashes"),
	rule("Bash(git cat-file*)", "Read git objects"),
];

const ANDROID_GRADLE_RULES: PresetRule[] = [
	rule("Bash(./gradlew tasks*)", "List available tasks"),
	rule("Bash(./gradlew dependencies*)", "Dependency tree"),
	rule("Bash(./gradlew projects*)", "List sub-projects"),
	rule("Bash(./gradlew properties*)", "Project properties"),
	rule("Bash(./gradlew clean*)", "Clean build outputs"),
	rule("Bash(./gradlew build*)", "Full build"),
	rule("Bash(./gradlew assembleDebug*)", "Assemble debug APK"),
	rule("Bash(./gradlew assembleRelease*)", "Assemble release APK"),
	rule("Bash(./gradlew bundleDebug*)", "Build debug AAB"),
	rule("Bash(./gradlew bundleRelease*)", "Build release AAB"),
	rule("Bash(./gradlew test*)", "Run unit tests"),
	rule("Bash(./gradlew connectedAndroidTest*)", "Run instrumented tests"),
	rule("Bash(./gradlew lint*)", "Run Android lint"),
	rule("Bash(./gradlew ktlintCheck*)", "ktlint static analysis"),
	rule("Bash(./gradlew detekt*)", "Detekt static analysis"),
	rule("Bash(./gradlew generateDebugSources*)", "Generate debug sources (KSP/KAPT)"),
	rule("Bash(./gradlew kspDebug*)", "KSP debug code gen"),
	rule("Bash(./gradlew kspRelease*)", "KSP release code gen"),
	rule("Bash(gradlew*)", "Windows wrapper (gradlew without ./)"),
];

export const BUILTIN_PRESETS: PermissionPreset[] = [
	{
		id: "git-safe",
		name: "Git (safe)",
		description:
			"Non-destructive git inspection commands. Safe to apply on any project.",
		icon: "🌿",
		category: "vcs",
		builtin: true,
		rules: GIT_SAFE_RULES,
	},
	{
		id: "android-gradle",
		name: "Android Gradle",
		description:
			"Standard Gradle build, test, and static-analysis tasks for Android projects.",
		icon: "🤖",
		category: "build",
		builtin: true,
		rules: ANDROID_GRADLE_RULES,
	},
];

export const BUILTIN_PRESET_IDS: ReadonlySet<string> = new Set(
	BUILTIN_PRESETS.map((p) => p.id),
);

/** Convert a subset of a preset's rules (named by pattern) into the `Rule[]`
 *  shape used by `PermissionsEditor`'s draft. */
export function getPresetRulesAsRules(
	preset: PermissionPreset,
	enabledPatterns: Iterable<string>,
): Rule[] {
	const set = new Set(enabledPatterns);
	return preset.rules
		.filter((r) => set.has(r.pattern))
		.map((r) => ({ pattern: r.pattern, kind: r.kind }));
}

/** Default-enabled subset (used when the user hits Apply without toggling). */
export function defaultEnabledPatterns(preset: PermissionPreset): string[] {
	return preset.rules.filter((r) => r.enabledByDefault).map((r) => r.pattern);
}
