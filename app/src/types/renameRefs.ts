// ─── Rename cascade — types mirroring `hub rename ... --json` payloads ───────
// Pinned by the Python twin (`rename_cascade.py`, `hub_cli/skill.py`) and
// landed exactly per reports/11-P.md — one addition over plans/3.md:
// `rewritten[].backup` is optional (present unless the source file was
// missing pre-write, an edge case).

export type RenameRefKind = "skill" | "snippet" | "agent_doc" | "cascade";
export type RenameSkipReason =
	| "source-managed"
	| "snippet-owned"
	| "unreadable"
	| "unparseable-frontmatter"
	| "project-quarantined";

export interface RenamePlan {
	dry_run: true;
	old: string;
	new: string;
	referrers: {
		skills: { name: string; count: number }[];
		snippets: { name: string; count: number }[];
		agent_docs: { project: string; rel: string; path: string; count: number }[];
	};
	skipped: { kind: RenameRefKind; name: string; reason: RenameSkipReason; count: number }[];
	totals: {
		skills: number;
		snippets: number;
		agent_docs: number;
		projects: number;
		library_refs: number;
		agent_doc_refs: number;
		refs: number;
		skipped: number;
		files: number;
	};
}

export interface RenameResult {
	renamed: boolean;
	old: string;
	new: string;
	rewritten: {
		kind: RenameRefKind;
		name: string;
		path?: string;
		count: number;
		version?: number;
		backup?: string;
	}[];
	skipped: { kind: RenameRefKind; name: string; reason: RenameSkipReason; count: number }[];
	errors: { kind: RenameRefKind; name: string; path?: string; error: string; hint?: string }[];
	snippets_outdated: string[];
	agent_docs_requested: boolean;
}

export type RenameCascadePhase = "idle" | "review" | "running" | "result" | "failed";

/** The one shared step list — the dialog's `rename-refs-step` rows and the
 *  `trackProcess` card read the SAME labels, so they can never disagree. */
export const RENAME_STEPS = [
	{
		key: "rewrite",
		label: (n: number) => `Renaming and rewriting ${n} reference${n === 1 ? "" : "s"}`,
	},
	{ key: "reload", label: () => "Reloading" },
] as const;
