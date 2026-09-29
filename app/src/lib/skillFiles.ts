// ─── Skill files bridge ──────────────────────────────────────────────────────
// Typed wrappers over the four `skill_file*` Tauri commands
// (`src-tauri/src/commands/skill_files.rs`): list, read, write and create the
// files that live inside one skill's directory.
//
// The backend owns path confinement — callers name a skill by its registry key
// and a POSIX rel path, never an absolute path, and a rel that would leave the
// skill dir is refused server-side. Nothing here re-implements that check; the
// wrappers only give the frontend types and one place to parse the errors.

import { invoke } from "@/lib/ipc";

/** Coarse file family, used for the navigator's glyph and for deciding whether
 *  the editor can open a row at all. Mirrors `FileKind` in `skill_files.rs`. */
export type SkillFileKind =
  | "markdown"
  | "script"
  | "text"
  | "data"
  | "binary"
  | "other";

/** Why a row cannot be edited. `symlink_outside` means the link resolves out of
 *  the skill dir — it is listed so the author can see it, but it is not
 *  readable or writable, and a `.skillpack`/cloud ZIP will not ship it. */
export type SkillFileUneditableReason =
  | "binary"
  | "too_large"
  | "symlink_outside";

export interface SkillFileEntry {
  /** POSIX path relative to the skill root — never absolute, never `..`-bearing. */
  rel: string;
  size: number;
  kind: SkillFileKind;
  editable: boolean;
  reason: SkillFileUneditableReason | null;
}

export interface SkillFileList {
  /** Canonical absolute path of the skill directory (display / reveal only). */
  root: string;
  /** Sorted by rel, with `SKILL.md` first. */
  files: SkillFileEntry[];
  /** True when the walk hit its entry cap and stopped early. */
  truncated: boolean;
}

export interface SkillFileContent {
  rel: string;
  content: string;
  /** Optimistic-concurrency fingerprint — pass it back as `expectedHash`. */
  hash: string;
  size: number;
}

export interface SkillFileWriteResult {
  hash: string;
}

// ─── Error grammar ───────────────────────────────────────────────────────────
// Every command rejects with a plain string carrying a stable prefix. Anything
// unprefixed is an unexpected IO/registry failure and should surface verbatim.

export const SKILL_FILE_ERROR_KINDS = [
  "outside",
  "not_found",
  "binary",
  "too_large",
  "exists",
  "read_only",
  "conflict",
] as const;

export type SkillFileErrorKind = (typeof SKILL_FILE_ERROR_KINDS)[number];

/** The prefix of a `skill_file*` rejection, or `null` for an unclassified one. */
export function skillFileErrorKind(err: unknown): SkillFileErrorKind | null {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return (
    SKILL_FILE_ERROR_KINDS.find((kind) => msg.startsWith(`${kind}:`)) ?? null
  );
}

// ─── Commands ────────────────────────────────────────────────────────────────

/** Every file inside the skill's directory. Rejects for an unknown skill, an
 *  `mcp-server` entry (no editable files), or a `source` that is not a readable
 *  absolute directory. */
export async function listSkillFiles(name: string): Promise<SkillFileList> {
  return invoke<SkillFileList>("skill_files_list", { name });
}

/** UTF-8 contents of one file. Rejects with `binary:`/`too_large:` for rows the
 *  listing already marked `editable: false`. */
export async function readSkillFile(
  name: string,
  rel: string,
): Promise<SkillFileContent> {
  return invoke<SkillFileContent>("skill_file_read", { name, rel });
}

/** Replace an EXISTING file's bytes (a missing file rejects with `not_found:` —
 *  use `createSkillFile` first). Pass the `hash` from the last read as
 *  `expectedHash` to get a `conflict:` rejection instead of clobbering an edit
 *  made elsewhere; omit it to force the write.
 *
 *  `SKILL.md` goes through here as raw bytes. The skill editor's own metadata
 *  save still uses `save_skill_full`, which round-trips frontmatter and updates
 *  the registry — this path does neither. */
export async function writeSkillFile(
  name: string,
  rel: string,
  content: string,
  expectedHash?: string | null,
): Promise<SkillFileWriteResult> {
  return invoke<SkillFileWriteResult>("skill_file_write", {
    name,
    rel,
    content,
    expectedHash: expectedHash ?? null,
  });
}

/** Create an empty file, building any missing parent dirs inside the skill.
 *  Rejects with `exists:` when the path is taken (by a file OR a directory) and
 *  `read_only:` for a source-managed skill. */
export async function createSkillFile(
  name: string,
  rel: string,
): Promise<SkillFileWriteResult> {
  return invoke<SkillFileWriteResult>("skill_file_create", { name, rel });
}
