// Agent Docs Snippets — types mirroring `hub snippet ... --json` payloads.
// Status is always DERIVED from file content (marker scan); there is no
// tracking store anywhere.

export type SnippetStatus = "applied" | "modified" | "outdated" | "orphaned";
export type SnippetPlacement = "canonical" | "misplaced" | "blocked" | "none";

export interface SnippetUsage {
	count: number;
	summary: SnippetStatus | "none";
	outdated_count: number;
	locations?: SnippetLocation[];
}

export interface SnippetInfo {
	name: string;
	description: string;
	tags: string[];
	version: number;
	created: string;
	updated: string;
	hash: string;
	body?: string;
	usage?: SnippetUsage;
}

/** One marker block found in a registered project's agent doc file. */
export interface SnippetLocation {
	project: string;
	rel: string;
	path: string;
	snippet: string;
	version: string;
	applied_sha: string;
	status: SnippetStatus;
	placement?: SnippetPlacement;
}

/** One marker problem. The Python scanner is the only source of this verdict. */
export interface SnippetMarkerDiagnostic {
	kind: string;
	name: string | null;
	line: number;
}

/** A marker problem found in one registered project's Agent Doc file. */
export interface SnippetDamagedMarker extends SnippetMarkerDiagnostic {
	project: string;
	rel: string;
}

export interface SnippetScanResult {
	locations: SnippetLocation[];
	damaged: SnippetDamagedMarker[];
}

export interface SnippetMirrored {
	rel: string;
	backup: string | null;
}

export interface SnippetMutationResult {
	action: "apply" | "remove" | "update";
	snippet: string;
	project: string;
	rel: string;
	path: string;
	created?: boolean;
	status_before?: SnippetStatus;
	version?: number;
	backup: string | null;
	mirrored: SnippetMirrored[];
}

export interface SnippetUpdateEverywhereResult {
	action: "update-everywhere";
	snippet: string;
	refreshed: SnippetMutationResult[];
	skipped: SnippetLocation[];
}

export interface SnippetEditResult extends SnippetInfo {
	body_changed: boolean;
	outdated_locations: number;
}

export interface SnippetDeleteResult {
	deleted: string;
	orphaned_blocks: { project: string; rel: string }[];
}
