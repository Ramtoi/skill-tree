// ─── .skillpack share format (v1) — frontend contract ────────────────────────
// A `.skillpack` is a single JSON envelope produced by `hub skill export` and
// consumed by `hub skill import`. The UI never parses the pack itself — it only
// speaks the two CLI verbs and renders their `--json` payloads.

/** One file inside a pack, as reported by an import dry-run preview. */
export interface SkillPackFile {
	path: string;
	bytes: number;
}

/** `hub skill import <file> --dry-run --json` payload. */
export interface SkillPackPreview {
	valid: boolean;
	errors: string[];
	name: string;
	version: string;
	description: string;
	type: string;
	scope: string;
	files: SkillPackFile[];
	/** True when `name` already exists in the registry → an override is required. */
	collision: boolean;
	existing: { version?: string; source?: string; scope?: string } | null;
}

/** `hub skill export <name> --out <path> --json` payload. */
export interface SkillPackExportResult {
	exported: string;
	out: string;
	files: number;
}

/** `hub skill import <file> --json` (apply) payload. */
export interface SkillPackImportResult {
	imported: string;
	files: number;
}

/** Slug rule shared with the CLI (`SLUG_RE` in hub.py) for name overrides. */
export const SKILL_SLUG_RE = /^[a-z0-9-]+$/;

/**
 * Pull the JSON document out of a `hub_cmd` stdout blob.
 *
 * `hub.py` may prepend advisory lines (deprecation warnings, sync chatter) to
 * stdout before the `--json` payload, so a bare `JSON.parse` is not safe. We
 * scan from the first `{` — every `--json` payload the share verbs emit is a
 * single top-level object. Throws with the raw text when nothing parses, so the
 * caller can surface the CLI's own message.
 */
export function parseCliJson<T>(output: string): T {
	const text = (output ?? "").trim();
	const start = text.indexOf("{");
	if (start >= 0) {
		try {
			return JSON.parse(text.slice(start)) as T;
		} catch {
			// Trailing noise after the payload — retry on the balanced prefix.
			const end = text.lastIndexOf("}");
			if (end > start) {
				try {
					return JSON.parse(text.slice(start, end + 1)) as T;
				} catch {
					/* fall through to the throw below */
				}
			}
		}
	}
	throw new Error(text || "empty response from hub");
}

/** An invalid preview carrying `messages` — the shape the dialog renders. */
export function invalidPreview(messages: string[]): SkillPackPreview {
	return {
		valid: false,
		errors: messages.filter(Boolean),
		name: "",
		version: "",
		description: "",
		type: "",
		scope: "",
		files: [],
		collision: false,
		existing: null,
	};
}

/**
 * Coerce a dry-run response into a `SkillPackPreview` the UI can always render.
 *
 * `hub skill import --dry-run --json` answers in TWO shapes: the full preview
 * for a pack it could read, and a bare `{"error": "..."}` for one it could not
 * (unreadable file, not JSON at all). Both mean "cannot import" to the user, so
 * they collapse to one invalid preview here rather than at every call site —
 * and a missing `errors`/`files` array can never reach the render path.
 */
export function normalizePreview(raw: unknown): SkillPackPreview {
	if (!raw || typeof raw !== "object") {
		return invalidPreview(["Unrecognized response from hub."]);
	}
	const obj = raw as Record<string, unknown>;
	if (typeof obj.valid !== "boolean") {
		return invalidPreview([
			typeof obj.error === "string" && obj.error
				? obj.error
				: "Unrecognized or corrupt skill pack.",
		]);
	}
	const files = Array.isArray(obj.files) ? (obj.files as SkillPackFile[]) : [];
	return {
		valid: obj.valid,
		errors: Array.isArray(obj.errors) ? (obj.errors as string[]) : [],
		name: typeof obj.name === "string" ? obj.name : "",
		version: typeof obj.version === "string" ? obj.version : "",
		description: typeof obj.description === "string" ? obj.description : "",
		type: typeof obj.type === "string" ? obj.type : "",
		scope: typeof obj.scope === "string" ? obj.scope : "",
		files,
		collision: !!obj.collision,
		existing:
			obj.existing && typeof obj.existing === "object"
				? (obj.existing as SkillPackPreview["existing"])
				: null,
	};
}
