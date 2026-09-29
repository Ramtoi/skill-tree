import type {
	AgentDocFile,
	AgentDocFolder,
	AgentDocInstructionSet,
} from "@/types/agentDocs";

// ─── Helpers ────────────────────────────────────────────────────────────────

export function flattenFiles(node: AgentDocFolder): AgentDocFile[] {
	const out: AgentDocFile[] = [];
	for (const f of node.files) out.push(f);
	for (const d of node.dirs) out.push(...flattenFiles(d));
	return out;
}

export function findFile(node: AgentDocFolder, rel: string): AgentDocFile | null {
	for (const f of node.files) if (f.rel === rel) return f;
	for (const d of node.dirs) {
		const hit = findFile(d, rel);
		if (hit) return hit;
	}
	return null;
}

export function fmtSize(n: number | null | undefined): string {
	if (n == null) return "—";
	if (n < 1024) return `${n} B`;
	return `${(n / 1024).toFixed(1)} KB`;
}

export function fmtClockHM(secs: number | null | undefined): string {
	if (secs == null) return "—";
	const d = new Date(secs * 1000);
	return d.toLocaleTimeString([], {
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	});
}

export const KNOWN_RELS = [
	"CLAUDE.md",
	"AGENTS.md",
	".claude/CLAUDE.md",
	".agents/AGENTS.md",
];

/** Editing a unified set grounds in the canonical real file — AGENTS.md when
 *  it exists, else CLAUDE.md. */
export function editableRelForSet(set: AgentDocInstructionSet): string {
	const agent = set.formats.AGENT.file;
	const claude = set.formats.CLAUDE.file;
	return agent?.rel ?? claude?.rel ?? set.formats.CLAUDE.rel;
}

/** Deviation badges only — canonical sets render silently (green = silence).
 *  Returns at most one layout badge plus flag badges. */
export function setBadges(
	set: AgentDocInstructionSet,
): Array<{ label: string; tone: "error" | "warn" | "info" }> {
	const out: Array<{ label: string; tone: "error" | "warn" | "info" }> = [];
	if (set.verdict === "conflict") out.push({ label: "CONFLICT", tone: "error" });
	if (set.verdict === "pointer_plus_content")
		out.push({ label: "APPENDED", tone: "warn" });
	if (
		set.verdict === "claude_only" ||
		set.verdict === "agents_only" ||
		set.verdict === "derived_drift" ||
		set.verdict === "replaced_derived"
	)
		out.push({ label: "FIX", tone: "warn" });
	if (set.flags.includes("legacy")) out.push({ label: "LEGACY", tone: "warn" });
	if (set.flags.includes("broken_link"))
		out.push({ label: "BROKEN LINK", tone: "error" });
	if (set.flags.includes("external_link"))
		out.push({ label: "EXTERNAL", tone: "info" });
	return out;
}

export function isDeviating(set: AgentDocInstructionSet): boolean {
	if (set.flags.includes("legacy") || set.flags.includes("broken_link"))
		return true;
	return set.verdict !== "canonical" && set.verdict !== "none";
}

export const EMPTY_FOLDER: AgentDocFolder = {
	name: "",
	path: "",
	dirs: [],
	files: [],
};

export function relDirLabel(relativeDir: string): string {
	return relativeDir || "root";
}

/** Per-project browse-mode persistence. Keyed by PATH, not name: a project can
 *  be renamed. This is the first unbounded `st:` key family — `hub project
 *  remove` and `edit-path` leave an orphan behind, which is acceptable for a
 *  boolean and noted so nobody assumes it is pruned. */
export function browseModeKey(projectPath: string): string {
	return `st:agentdocs:allmd:${projectPath}`;
}

export function readBrowseMode(projectPath: string): boolean {
	try {
		return localStorage.getItem(browseModeKey(projectPath)) === "1";
	} catch {
		return false;
	}
}

export function writeBrowseMode(projectPath: string, on: boolean) {
	try {
		localStorage.setItem(browseModeKey(projectPath), on ? "1" : "0");
	} catch {
		/* private mode / quota — the toggle still works for this session */
	}
}
