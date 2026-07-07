import claudeCodeIcon from "@/assets/harnesses/claude-code.svg";
import codexIcon from "@/assets/harnesses/codex.svg";
import opencodeIcon from "@/assets/harnesses/opencode.svg";
import piIcon from "@/assets/harnesses/pi.svg";

// Static identity metadata for known harnesses — the official mark, brand color,
// and the root file each one reads. Installed/version/used-by data is dynamic and
// comes from `harness_list` (see `useHarnesses`); this file only carries the visual
// identity the dynamic list doesn't.
//
// Identity is NEVER a semantic accent token (--violet/--green/…): color in this app
// carries meaning, so harness identity is carried by the logo SHAPE plus an optional
// literal `brand` color. Harnesses without a recognizable brand color render neutral.
//
// Keep the id set in sync with the Python harness registry + the Rust
// `binary_names` map.

export type RootFile = "CLAUDE.md" | "AGENTS.md";

export interface HarnessIdentity {
	label: string;
	file: RootFile;
	/** Literal brand color (e.g. Claude terracotta). Absent → render neutral. */
	brand?: string;
	icon: string;
	shortCode: string;
}

export const HARNESS_IDENTITY: Record<string, HarnessIdentity> = {
	"claude-code": {
		label: "Claude Code",
		file: "CLAUDE.md",
		brand: "#D97757",
		icon: claudeCodeIcon,
		shortCode: "CC",
	},
	codex: {
		label: "Codex",
		file: "AGENTS.md",
		icon: codexIcon,
		shortCode: "CX",
	},
	pi: {
		label: "Pi",
		file: "AGENTS.md",
		icon: piIcon,
		shortCode: "PI",
	},
	opencode: {
		label: "opencode",
		file: "AGENTS.md",
		icon: opencodeIcon,
		shortCode: "OC",
	},
	copilot: {
		label: "Copilot",
		file: "AGENTS.md",
		icon: "",
		shortCode: "CP",
	},
};

export function harnessFile(id: string): RootFile {
	return HARNESS_IDENTITY[id]?.file ?? "CLAUDE.md";
}

/** Literal brand color for a harness, or undefined when it renders neutral. */
export function harnessBrand(id: string): string | undefined {
	return HARNESS_IDENTITY[id]?.brand;
}

/**
 * Identity tint for harness chrome (chip rings, glyph). The brand color when one
 * exists, otherwise a neutral foreground tone — never a semantic accent token.
 */
export function harnessTint(id: string): string {
	return HARNESS_IDENTITY[id]?.brand ?? "var(--fg-mid)";
}

export function harnessIcon(id: string): string | undefined {
	return HARNESS_IDENTITY[id]?.icon || undefined;
}

export function harnessLabel(id: string): string {
	return HARNESS_IDENTITY[id]?.label ?? id;
}

export function harnessDisplayLabel(
	id: string,
	labels?: Record<string, string>,
): string {
	return labels?.[id] ?? harnessLabel(id);
}

export function harnessShortCode(id: string, label?: string): string {
	return HARNESS_IDENTITY[id]?.shortCode ?? harnessInitials(label ?? id);
}

/**
 * Monogram initials for a harness label.
 *  - multiple words (split on space/dash) → first letter of each
 *  - single word → first two letters
 * Sliced to 2, uppercased. e.g. "Claude Code" → "CC", "Codex" → "CO".
 */
export function harnessInitials(label: string): string {
	const words = label.split(/[\s-]+/).filter(Boolean);
	const raw =
		words.length > 1
			? words.map((w) => w[0]).join("")
			: (words[0] ?? "").slice(0, 2);
	return raw.slice(0, 2).toUpperCase();
}
