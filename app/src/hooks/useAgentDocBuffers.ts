import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	type Dispatch,
	type SetStateAction,
} from "react";
import type { QueryClient } from "@tanstack/react-query";
import { qk } from "@/lib/queryKeys";
import { invalidateUsageComposition } from "@/lib/invalidate";
import { readAgentDoc, writeAgentDoc } from "@/hooks/useAgentDocs";
import type { useToast } from "@/components/Toast";
import type {
	AgentDocContent,
	AgentDocErrorBody,
	AgentDocFile,
	AgentDocMarkerIssue,
	AgentDocsListing,
} from "@/types/agentDocs";
import { parseAgentDocError } from "@/types/agentDocs";
import { snippetMarkerSaveMessage } from "@/lib/snippetDiagnostics";
import { findFile, flattenFiles } from "@/components/agentDocs/agentDocHelpers";
import { ancestorDirs } from "@/lib/agentDocMap";
import type { Buffer, Conflict, PendingDiscard } from "@/components/AgentDocsView";

export interface AgentDocBuffers {
	// ── Raw state consumed outside the hook ──
	loadingRel: string | null;
	saving: boolean;
	conflict: Conflict | null;
	setConflict: (c: Conflict | null) => void;
	pendingDiscard: PendingDiscard;
	setPendingDiscard: (v: PendingDiscard) => void;
	externalEditTarget: string | null;
	markerIssue: AgentDocMarkerIssue | null;
	editorMode: "edit" | "preview";
	setEditorMode: (m: "edit" | "preview") => void;
	resolvedMeta: Map<string, AgentDocFile>;
	setResolvedMeta: Dispatch<SetStateAction<Map<string, AgentDocFile>>>;
	selected: string | null;
	setSelected: (rel: string | null) => void;

	// ── Derived, purely from the state above ──
	selectedBuffer: Buffer | undefined;
	selectedDirty: boolean;
	dirtyRels: Set<string>;
	dirtyDirs: Set<string>;
	anyDirty: boolean;
	externallyChanged: boolean;

	// ── Actions ──
	editBuf: (text: string) => void;
	doRefresh: () => Promise<void>;
	refresh: () => void;
	reloadSelectedSilently: () => Promise<void>;
	save: () => void;
	reloadAfterConflict: () => Promise<void>;
	overwriteAfterConflict: () => void;
}

/** Owns every editor buffer for the Agent Docs screen — the in-memory drafts,
 *  the selected file, and the load/refresh/save/conflict-resolution flow that
 *  keeps them honest against a disk that agents rewrite constantly. Extracted
 *  verbatim from AgentDocsView; the interlocking effects (reset-on-project,
 *  default-selection, buffer-ref sync, lazy-load) keep their exact relative
 *  order — this is the highest-risk extraction in the S6 decomposition. */
export function useAgentDocBuffers({
	projectPath,
	data,
	toast,
	queryClient,
	initialSelected = null,
	publishOnSave = false,
}: {
	projectPath: string;
	data: AgentDocsListing | undefined;
	toast: ReturnType<typeof useToast>;
	queryClient: QueryClient;
	/** Preferred first selection, from the referrer's `restore.adSelected`.
	 *  Honoured ONLY while `selected` is still null and the rel exists in the
	 *  loaded tree; otherwise the existing default-target seed wins. Never
	 *  re-applied after the first seed. */
	initialSelected?: string | null;
	/** When enabled, a root save also attempts a guarded publish to main. */
	publishOnSave?: boolean;
}): AgentDocBuffers {
	const [selected, setSelected] = useState<string | null>(null);
	const [buffers, setBuffers] = useState<Record<string, Buffer>>({});
	const [loadingRel, setLoadingRel] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [conflict, setConflict] = useState<Conflict | null>(null);
	const [pendingDiscard, setPendingDiscard] = useState<PendingDiscard>(null);
	const [externalEditTarget, setExternalEditTarget] = useState<string | null>(
		null,
	);
	const [markerIssue, setMarkerIssue] = useState<AgentDocMarkerIssue | null>(
		null,
	);
	const [editorMode, setEditorMode] = useState<"edit" | "preview">("edit");
	/** Size/mtime filled in for directories the user has actually opened. */
	const [resolvedMeta, setResolvedMeta] = useState<Map<string, AgentDocFile>>(
		() => new Map(),
	);

	// Reset this hook's own slice of state when the project changes. The
	// component resets its own slice (expanded/filter/includeIgnored/
	// showAllMarkdown) in a sibling effect — splitting one effect into two
	// independently-owned ones is behaviour-identical here since neither slice
	// reads the other's state.
	useEffect(() => {
		setSelected(null);
		setBuffers({});
		setLoadingRel(null);
		setConflict(null);
		setPendingDiscard(null);
		setExternalEditTarget(null);
		setMarkerIssue(null);
		setResolvedMeta(new Map());
	}, [projectPath]);

	// ── Default selection: initialSelected (once) → first existing file →
	// fallback CLAUDE.md ──
	const initialSelectedConsumed = useRef(false);
	useEffect(() => {
		if (!data) return;
		if (selected) return;
		const all = flattenFiles(data.root);
		if (!initialSelectedConsumed.current && initialSelected) {
			initialSelectedConsumed.current = true;
			if (all.some((f) => f.rel === initialSelected)) {
				setSelected(initialSelected);
				return;
			}
		}
		const firstExisting = all.find((f) => f.exists && !f.error);
		const target = firstExisting?.rel ?? "CLAUDE.md";
		setSelected(target);
	}, [data, selected, initialSelected]);

	function toastForError(body: AgentDocErrorBody | null, raw: string) {
		if (!body) {
			toast.error("Agent Docs error", raw);
			return;
		}
		switch (body.kind) {
			case "oversized":
				toast.error(
					`${body.rel} too large to edit`,
					`${body.size} B exceeds ${body.limit} B`,
				);
				break;
			case "not_utf8":
				toast.error(`${body.rel} is not valid UTF-8`);
				break;
			case "external_symlink":
				toast.error(
					`${body.rel} points outside the project`,
					body.target ?? undefined,
				);
				break;
			case "outside_project":
				toast.error(`${body.rel} resolves outside the project`);
				break;
			case "not_allowed_basename":
				toast.error(`${body.rel} is not an allowed Agent Doc file`);
				break;
			case "derived_pointer":
				toast.error(
					`${body.rel} is derived from ${body.canonical_rel ?? "AGENTS.md"}`,
					"Edit the canonical file instead.",
				);
				break;
			case "invalid_path":
				toast.error("Invalid path", body.message);
				break;
			default:
				toast.error("Agent Docs error", raw);
		}
	}

	// ── Lazy load buffer for selected ──
	const buffersRef = useRef(buffers);
	useEffect(() => {
		buffersRef.current = buffers;
	}, [buffers]);
	useEffect(() => {
		if (!data) return;
		if (!selected) return;
		if (buffersRef.current[selected]) return;
		const file = findFile(data.root, selected);
		if (!file) {
			setBuffers((b) => ({
				...b,
				[selected]: {
					content: "",
					baseline: "",
					loadedHash: null,
					loadedAtTs: Date.now(),
					isNew: true,
				},
			}));
			return;
		}
		if (!file.exists) {
			setBuffers((b) => ({
				...b,
				[selected]: {
					content: "",
					baseline: "",
					loadedHash: null,
					loadedAtTs: Date.now(),
					isNew: true,
				},
			}));
			return;
		}
		if (file.is_symlink && !file.symlink_target_in_project) {
			setBuffers((b) => ({
				...b,
				[selected]: {
					content: "",
					baseline: "",
					loadedHash: file.hash,
					loadedAtTs: Date.now(),
					isNew: false,
				},
			}));
			return;
		}
		setLoadingRel(selected);
		let cancelled = false;
		readAgentDoc(projectPath, selected)
			.then((res: AgentDocContent) => {
				if (cancelled) return;
				setBuffers((b) => ({
					...b,
					[res.rel]: {
						content: res.content,
						baseline: res.content,
						loadedHash: res.hash,
						loadedAtTs: Date.now(),
						isNew: false,
						isDerivedPointer: res.is_derived_pointer,
					},
				}));
			})
			.catch((err) => {
				if (cancelled) return;
				const body = parseAgentDocError(err);
				toastForError(body, String(err));
			})
			.finally(() => {
				if (!cancelled) setLoadingRel(null);
			});
		return () => {
			cancelled = true;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [data, selected, projectPath]);

	const selectedBuffer = selected ? buffers[selected] : undefined;

	const dirtyRels = useMemo(() => {
		const out = new Set<string>();
		for (const [rel, buf] of Object.entries(buffers)) {
			if (buf.content !== buf.baseline) out.add(rel);
		}
		return out;
	}, [buffers]);
	const dirtyDirs = useMemo(() => ancestorDirs(dirtyRels), [dirtyRels]);

	const anyDirty = useMemo(
		() => Object.values(buffers).some((b) => b.content !== b.baseline),
		[buffers],
	);

	const selectedDirty = selected ? dirtyRels.has(selected) : false;
	const externallyChanged =
		externalEditTarget && externalEditTarget === selected ? true : false;

	function editBuf(text: string) {
		if (!selected) return;
		setBuffers((b) => ({
			...b,
			[selected]: {
				content: text,
				baseline: b[selected]?.baseline ?? "",
				loadedHash: b[selected]?.loadedHash ?? null,
				loadedAtTs: b[selected]?.loadedAtTs ?? Date.now(),
				isNew: b[selected]?.isNew ?? false,
			},
		}));
	}

	const doRefresh = useCallback(async () => {
		if (!selected) {
			await queryClient.invalidateQueries({
				queryKey: qk.agentDocs.forProject(projectPath),
			});
			toast.push({
				kind: "info",
				title: "Agent Docs refreshed from disk",
				body: projectPath,
			});
			return;
		}
		await queryClient.invalidateQueries({
			queryKey: qk.agentDocs.forProject(projectPath),
		});
		try {
			const res = await readAgentDoc(projectPath, selected);
			setBuffers((b) => ({
				...b,
				[res.rel]: {
					content: res.content,
					baseline: res.content,
					loadedHash: res.hash,
					loadedAtTs: Date.now(),
					isNew: false,
					isDerivedPointer: res.is_derived_pointer,
				},
			}));
			setExternalEditTarget((t) => (t === res.rel ? null : t));
			setMarkerIssue((issue) => (issue?.rel === res.rel ? null : issue));
			toast.push({
				kind: "info",
				title: "Agent Docs refreshed from disk",
				body: projectPath,
			});
		} catch (err) {
			const body = parseAgentDocError(err);
			if (body?.kind === "io_error") {
				setBuffers((b) => ({
					...b,
					[selected]: {
						content: "",
						baseline: "",
						loadedHash: null,
						loadedAtTs: Date.now(),
						isNew: true,
					},
				}));
				toast.push({
					kind: "info",
					title: `${selected} is gone from disk`,
					body: "Marked as new draft.",
				});
			} else {
				toastForError(body, String(err));
			}
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [selected, projectPath, queryClient, toast]);

	function refresh() {
		if (selectedDirty) {
			setPendingDiscard(() => doRefresh);
			return;
		}
		void doRefresh();
	}

	// Silent buffer reload after a mutation rewrote files on disk — no toast,
	// no dirty guard (mutations are blocked while dirty).
	const reloadSelectedSilently = useCallback(async () => {
		await queryClient.invalidateQueries({
			queryKey: qk.agentDocs.forProject(projectPath),
		});
		if (!selected) return;
		try {
			const res = await readAgentDoc(projectPath, selected);
			setBuffers((b) => ({
				...b,
				[res.rel]: {
					content: res.content,
					baseline: res.content,
					loadedHash: res.hash,
					loadedAtTs: Date.now(),
					isNew: false,
					isDerivedPointer: res.is_derived_pointer,
				},
			}));
			setMarkerIssue((issue) => (issue?.rel === res.rel ? null : issue));
		} catch {
			// File may be momentarily unreadable (or replaced by a derived
			// pointer); drop the stale buffer so the next select reloads.
			setBuffers((b) => {
				const next = { ...b };
				delete next[selected];
				return next;
			});
		}
	}, [selected, projectPath, queryClient]);

	async function performWrite(force: boolean) {
		if (!selected || !selectedBuffer) return;
		if (!selectedDirty && !selectedBuffer.isNew) return;
		if (saving) return;
		setSaving(true);
		try {
			const res = await writeAgentDoc({
				projectPath,
				relativePath: selected,
				content: selectedBuffer.content,
				expectedHash: selectedBuffer.loadedHash,
				overwrite: force,
				publishOnSave,
			});
			const newBuffers = { ...buffers };
			const persistedContent = res.content ?? selectedBuffer.content;
			for (const w of res.written) {
				if (w.is_symlink) continue; // derived pointer — no editable buffer
				newBuffers[w.rel] = {
					content: persistedContent,
					baseline: persistedContent,
					loadedHash: w.hash ?? null,
					loadedAtTs: Date.now(),
					isNew: false,
				};
			}
			// A canonicalizing write may have written a different rel than the
			// one drafted (CLAUDE.md draft → AGENTS.md). Follow the real file.
			const primary = res.written[0];
			if (primary && primary.rel !== selected) {
				delete newBuffers[selected];
				setSelected(primary.rel);
			}
			setBuffers(newBuffers);
			setExternalEditTarget(null);
			setConflict(null);
			setMarkerIssue(null);
			await queryClient.invalidateQueries({
				queryKey: qk.agentDocs.forProject(projectPath),
			});
			await invalidateUsageComposition(queryClient);
			const names = res.written.map((w) => w.rel).join(" + ");
			if (res.publish?.published) {
				toast.push({
					kind: "success",
					title: `${names} saved and published`,
					body: `${res.publish.remote}/${res.publish.branch}${res.publish.sha ? ` · ${res.publish.sha}` : ""}`,
				});
			} else if (res.publish?.attempted) {
				toast.push({
					kind: "info",
					title: `${names} saved locally`,
					body: res.publish.message,
				});
			} else {
				toast.push({
					kind: "success",
					title: selectedBuffer.isNew ? `${names} created` : `${names} saved`,
					body: res.derived
						? `${primary?.rel} is the real root; CLAUDE.md follows it.`
						: `${projectPath}/${primary?.rel ?? selected}`,
				});
			}
		} catch (err) {
			const body = parseAgentDocError(err);
			if (body?.kind === "conflict" && body.rel) {
				setConflict({
					rel: body.rel,
					currentHash: body.current_hash ?? "",
				});
				setExternalEditTarget(body.rel);
				setMarkerIssue(null);
			} else if (body?.kind === "snippet_markers") {
				const rel = body.rel ?? selected;
				const diagnostics = body.diagnostics ?? [];
				setMarkerIssue({ rel, diagnostics });
				setEditorMode("edit");
				toast.error(
					`Cannot save ${rel}`,
					snippetMarkerSaveMessage(diagnostics),
				);
			} else {
				toastForError(body, String(err));
			}
		} finally {
			setSaving(false);
		}
	}

	function save() {
		void performWrite(false);
	}

	async function reloadAfterConflict() {
		if (!conflict) return;
		try {
			const res = await readAgentDoc(projectPath, conflict.rel);
			setBuffers((b) => ({
				...b,
				[res.rel]: {
					content: res.content,
					baseline: res.content,
					loadedHash: res.hash,
					loadedAtTs: Date.now(),
					isNew: false,
					isDerivedPointer: res.is_derived_pointer,
				},
			}));
			if (conflict.rel !== selected) setSelected(conflict.rel);
			setExternalEditTarget(null);
			setConflict(null);
			setMarkerIssue(null);
			toast.push({
				kind: "info",
				title: `Reloaded ${conflict.rel}`,
				body: "local edits discarded",
			});
		} catch (err) {
			toastForError(parseAgentDocError(err), String(err));
		}
	}

	function overwriteAfterConflict() {
		void performWrite(true);
	}

	return {
		loadingRel,
		saving,
		conflict,
		setConflict,
		pendingDiscard,
		setPendingDiscard,
		externalEditTarget,
		markerIssue,
		editorMode,
		setEditorMode,
		resolvedMeta,
		setResolvedMeta,
		selected,
		setSelected,
		selectedBuffer,
		selectedDirty,
		dirtyRels,
		dirtyDirs,
		anyDirty,
		externallyChanged,
		editBuf,
		doRefresh,
		refresh,
		reloadSelectedSilently,
		save,
		reloadAfterConflict,
		overwriteAfterConflict,
	};
}
