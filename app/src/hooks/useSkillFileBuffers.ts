import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { qk } from "@/lib/queryKeys";
import {
	readSkillFile,
	writeSkillFile,
	skillFileErrorKind,
	type SkillFileEntry,
} from "@/lib/skillFiles";
import { SKILL_MD } from "@/lib/skillFileTree";

export interface SkillFileBuffer {
	content: string;
	/** Last known on-disk text — the diff base and the dirty comparison. */
	baseline: string;
	/** Optimistic-concurrency fingerprint from the last read/write. */
	hash: string | null;
}

export interface SkillFileBuffers {
	buffers: Record<string, SkillFileBuffer>;
	activeBuffer: SkillFileBuffer | undefined;
	/** rel currently being read from disk (the active one, if any). */
	loadingRel: string | null;
	/** Load error for the ACTIVE rel, already classified. */
	loadError: string | null;
	/** rels a read/write reported as gone from disk. */
	missingRels: Set<string>;
	dirtyRels: Set<string>;
	saving: boolean;
	/** Set when a save lost the optimistic-concurrency check. */
	conflictRel: string | null;
	edit: (text: string) => void;
	/** Write the ACTIVE buffer, if it is dirty. Resolves `true` once the buffer
	 *  matches disk (written, or clean to begin with) and `false` when a
	 *  `conflict:` left it unwritten — the caller cannot read that off the state,
	 *  which has not flushed yet. Every other failure REJECTS, and the buffer
	 *  stays dirty; surfacing it belongs to the caller. */
	save: () => Promise<boolean>;
	reloadFromDisk: () => Promise<void>;
	keepMyVersion: () => Promise<void>;
	dismissConflict: () => void;
}

/**
 * Per-file in-memory buffers for every skill file EXCEPT `SKILL.md`, which the
 * editor keeps owning (it saves through `save_skill_full`, which round-trips
 * frontmatter and the registry, and diffs against a composed document).
 *
 * Modelled on `useAgentDocBuffers`: switching files never prompts and never
 * auto-saves — a prompt taxes the frequent action (switching, many times a
 * sitting) to guard a rare one, and an auto-save silently writes a file the
 * author may only have been poking at. The draft simply survives in memory and
 * the row says so.
 *
 * Effect ordering is deliberate and copied rather than re-derived: the load
 * effect owns a stale guard keyed on (skill, rel) so a slow read for a file the
 * user has already navigated away from can never clobber the newer buffer.
 */
export function useSkillFileBuffers({
	skillName,
	activeRel,
	entries,
}: {
	skillName: string;
	activeRel: string;
	entries: SkillFileEntry[];
}): SkillFileBuffers {
	const queryClient = useQueryClient();
	const [buffers, setBuffers] = useState<Record<string, SkillFileBuffer>>({});
	const [loadingRel, setLoadingRel] = useState<string | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [missingRels, setMissingRels] = useState<Set<string>>(new Set());
	const [saving, setSaving] = useState(false);
	const [conflictRel, setConflictRel] = useState<string | null>(null);

	// Buffers belong to one skill. Navigating to another must not carry drafts
	// across — the rels collide (`SKILL.md`, `references/…`) and the editor would
	// show the previous skill's text under the new skill's name.
	const skillRef = useRef(skillName);
	useEffect(() => {
		if (skillRef.current === skillName) return;
		skillRef.current = skillName;
		setBuffers({});
		setMissingRels(new Set());
		setConflictRel(null);
		setLoadError(null);
	}, [skillName]);

	const entry = useMemo(
		() => entries.find((e) => e.rel === activeRel),
		[entries, activeRel],
	);

	const hasBuffer = buffers[activeRel] !== undefined;
	const needsLoad =
		!!skillName &&
		activeRel !== SKILL_MD &&
		!hasBuffer &&
		!!entry &&
		entry.editable;

	useEffect(() => {
		if (!needsLoad) {
			setLoadError(null);
			return;
		}
		let ignore = false;
		setLoadingRel(activeRel);
		setLoadError(null);
		readSkillFile(skillName, activeRel)
			.then((doc) => {
				if (ignore) return;
				setBuffers((prev) => ({
					...prev,
					[activeRel]: {
						content: doc.content,
						baseline: doc.content,
						hash: doc.hash,
					},
				}));
				setMissingRels((prev) => {
					if (!prev.has(activeRel)) return prev;
					const next = new Set(prev);
					next.delete(activeRel);
					return next;
				});
			})
			.catch((err: unknown) => {
				if (ignore) return;
				const kind = skillFileErrorKind(err);
				if (kind === "not_found") {
					setMissingRels((prev) => new Set(prev).add(activeRel));
				}
				setLoadError(
					kind === "not_found"
						? "File not found on disk"
						: String(err instanceof Error ? err.message : err),
				);
			})
			.finally(() => {
				if (!ignore) setLoadingRel(null);
			});
		return () => {
			ignore = true;
		};
	}, [needsLoad, skillName, activeRel]);

	const edit = useCallback(
		(text: string) => {
			setBuffers((prev) => {
				const existing = prev[activeRel];
				if (!existing) return prev;
				return { ...prev, [activeRel]: { ...existing, content: text } };
			});
		},
		[activeRel],
	);

	const dirtyRels = useMemo(() => {
		const out = new Set<string>();
		for (const [rel, buf] of Object.entries(buffers)) {
			if (buf.content !== buf.baseline) out.add(rel);
		}
		return out;
	}, [buffers]);

	const commit = useCallback(
		async (rel: string, expectedHash: string | null) => {
			const buf = buffers[rel];
			if (!buf) return;
			setSaving(true);
			try {
				const res = await writeSkillFile(
					skillName,
					rel,
					buf.content,
					expectedHash,
				);
				setBuffers((prev) => {
					const current = prev[rel];
					if (!current) return prev;
					return {
						...prev,
						// Baseline is the text we WROTE, not the (possibly newer) buffer —
						// keystrokes landing mid-write stay dirty instead of being lost.
						[rel]: { ...current, baseline: buf.content, hash: res.hash },
					};
				});
				setConflictRel(null);
				// Size + drift live in the listing; a write invalidates it.
				await queryClient.invalidateQueries({
					queryKey: qk.skillFiles.forSkill(skillName),
				});
			} finally {
				setSaving(false);
			}
		},
		[buffers, skillName, queryClient],
	);

	const save = useCallback(async (): Promise<boolean> => {
		const buf = buffers[activeRel];
		if (!buf || activeRel === SKILL_MD) return true;
		// A clean buffer has nothing to write. Committing it anyway would push
		// its unchanged bytes back to disk (and invalidate the listing) purely
		// because the row happened to be active while a metadata edit was
		// pending — a write the author never asked for.
		if (buf.content === buf.baseline) return true;
		try {
			await commit(activeRel, buf.hash);
			return true;
		} catch (err: unknown) {
			const kind = skillFileErrorKind(err);
			if (kind === "conflict") {
				setConflictRel(activeRel);
				return false;
			}
			if (kind === "not_found") {
				setMissingRels((prev) => new Set(prev).add(activeRel));
			}
			throw err;
		}
	}, [activeRel, buffers, commit]);

	const reloadFromDisk = useCallback(async () => {
		const rel = conflictRel;
		if (!rel) return;
		const doc = await readSkillFile(skillName, rel);
		setBuffers((prev) => ({
			...prev,
			[rel]: { content: doc.content, baseline: doc.content, hash: doc.hash },
		}));
		setConflictRel(null);
	}, [conflictRel, skillName]);

	const keepMyVersion = useCallback(async () => {
		const rel = conflictRel;
		if (!rel) return;
		// No expected hash → deliberate overwrite of what is on disk now.
		await commit(rel, null);
	}, [conflictRel, commit]);

	const dismissConflict = useCallback(() => setConflictRel(null), []);

	return {
		buffers,
		activeBuffer: buffers[activeRel],
		loadingRel,
		loadError,
		missingRels,
		dirtyRels,
		saving,
		conflictRel,
		edit,
		save,
		reloadFromDisk,
		keepMyVersion,
		dismissConflict,
	};
}
