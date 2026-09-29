import { useFeedbackTab } from "@/hooks/useFeedbackTab";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { invoke } from "@/lib/ipc";
import { runHubCmd } from "@/lib/hubCmd";
import { invalidateRegistry } from "@/lib/invalidate";
import { errText } from "@/lib/hubWrite";
import { Button } from "@/components/Button";
import { BackButton } from "@/components/BackButton";
import { LoadingButton } from "@/components/loading";
import { Icon } from "@/components/Icon";
import { KindMark, ScopeBadge } from "@/components/Tag";
import { SourceChip } from "@/components/SourceChip";
import { SkillHeaderClasses } from "@/components/skillEditor/SkillHeaderClasses";
import { ScreenHeader } from "@/components/ScreenHeader";
import { RenamedPill } from "@/components/RenamedPill";
import { SkillNameTitle } from "@/components/skillEditor/SkillNameTitle";
import { StatePill } from "@/components/StatePill";
import { StatusBadge } from "@/components/StatusBadge";
import { EmptyState } from "@/components/EmptyState";
import { ConfirmDialog, Modal } from "@/components/Modal";
import { type CodeAreaHandle } from "@/components/CodeArea";
import {
	DocumentEditorShell,
	type DocMode,
} from "@/components/DocumentEditorShell";
import {
	SkillEditorSidePanel,
	SKILL_EDITOR_SECTIONS_KEY,
} from "@/components/skillEditor/SkillEditorSidePanel";
import { MarkdownToolbar } from "@/components/skillEditor/MarkdownToolbar";
import { EditorBarVerbs } from "@/components/skillEditor/EditorBarVerbs";
import { SkillFilesSection } from "@/components/skillFiles/SkillFilesSection";
import { buildSourceOverflowItems, buildSkillHeaderOverflow } from "@/components/skillEditor/sourceActions";
import { AddSkillFileSheet } from "@/components/skillFiles/AddSkillFileSheet";
import { useSkillFileBuffers } from "@/hooks/useSkillFileBuffers";
import { listSkillFiles } from "@/lib/skillFiles";
import { SKILL_MD, isMarkdownRel } from "@/lib/skillFileTree";
import { resolveSkillBodyOverride } from "@/components/skillEditor/SkillBodyOverride";
import { qk } from "@/lib/queryKeys";
import { useRegistry } from "@/hooks/useRegistry";
import { useHarnesses } from "@/hooks/useHarnesses";
import { useDroppedSkillActions } from "@/hooks/useDroppedSkillActions";
import { useSkillRefs } from "@/hooks/useSkillRefs";
import { useRenameCascade } from "@/hooks/useRenameCascade";
import { RenameRefsDialog } from "@/components/skillEditor/RenameRefsDialog";
import { useDefaultPreviewMode } from "@/hooks/useDefaultPreviewMode";
import { blastRadiusLines, removalConfirmBody, removalConfirmTitle, removalLoadingLabel } from "@/hooks/useSkillRemoval";
import { DROPPED_ACTION_ICON, DROPPED_ACTION_LABEL } from "@/lib/droppedSkillActions";
import { useToast } from "@/components/Toast";
import { queryClient } from "@/lib/queryClient";
import { trackProcess } from "@/lib/trackProcess";
import { sourceForSkill, isExternalManaged, isExternalSource } from "@/lib/skillSource";
import { formatTokens } from "@/lib/estimateTokens";
import { useSkillTokenEstimate } from "@/hooks/useSkillTokenEstimate";
import { useSkillInvocationUpdate } from "@/hooks/useSkillInvocationUpdate";
import { composeSkillDocument } from "@/lib/composeSkillDocument";
import { backReturnOptions, fromNav, skillBackTarget, useBackTarget } from "@/lib/backTarget";
import { useUnsavedGuard } from "@/lib/navGuard";
import { parseCliJson, type SkillPackExportResult } from "@/lib/skillPack";
import { McpPanel } from "@/components/mcp/McpPanel";
import { useMcpDraft } from "@/hooks/useMcpDraft";
import { useSyncReport } from "@/hooks/useSyncReport";
import { mcpDeliveryRowsFor, reportFreshness } from "@/lib/syncFreshness";
import type { SkillScope } from "@/types";
import { useSkillClassificationEditor } from "@/hooks/useSkillClassificationEditor";

interface SkillDocument {
	name: string;
	description: string;
	body: string;
}

const SLUG_RE = /^[a-z0-9-]+$/;

export function SkillEditor() {
	const { name: routeName } = useParams<{ name: string }>();
	const navigate = useNavigate();
	const toast = useToast();
	const { data: registry, error: registryError } = useRegistry();
	// A skill opens from the library, a project, a bundle, a source or a remote
	// — the arrow returns to whichever one it was, and the library is only the
	// fallback for deep links and palette jumps.
	const back = useBackTarget({
		label: "Library",
		path: "/",
		crumbs: ["library"],
	});
	const classificationEditor = useSkillClassificationEditor(routeName, registry, back, navigate);
	const { classificationContributions, classificationPanelProps, inspectClassification } = classificationEditor;
	const harnesses = useHarnesses();
	const installedHarnesses = useMemo(
		() => harnesses.filter((h) => h.installed).map((h) => h.id),
		[harnesses],
	);

	const skill = routeName ? registry?.skills[routeName] : undefined;
	// Dropped upstream: the source no longer carries this skill. Still
	// `isExternalManaged` (below), so the body was already read-only — this
	// only changes WHAT the header/panel offer instead of a normal edit. The
	// rest of the dropped-skill flow (useDroppedSkillActions) is wired up
	// below, once `leaveGuard` exists — see its call site for why.
	const dropped = !!skill?.source_missing;
	// A stable boolean (not the registry object itself) for the body/files
	// gates below: it flips false→true exactly once on first load and never
	// again, so depending on it re-runs those effects/queries when the
	// registry FIRST lands (the moment `dropped` becomes knowable) without
	// re-firing on every later, unrelated registry mutation.
	const registryLoaded = !!registry;

	// The MCP editor panel (D3): CONNECTION/CREDENTIALS/REACH/DELIVERY replace
	// the markdown buffer for an mcp-server (`mcpDraft` hydrates unconditionally
	// — cheap, and keeps hook order stable across a route change).
	const isMcp = skill?.type === "mcp-server";
	const mcpDraft = useMcpDraft(routeName ?? "", skill);
	const { data: mcpReportData } = useSyncReport();
	const mcpDeliveryRows = mcpDeliveryRowsFor(mcpReportData, routeName ?? ""),
		mcpFreshness = reportFreshness(mcpReportData);

	const [name, setName] = useState<string>(routeName ?? "");
	const [description, setDescription] = useState<string>("");
	const [scope, setScope] = useState<SkillScope>("global");
	const [version, setVersion] = useState<string>("");
	const [upstream, setUpstream] = useState<string>("");
	const [affinity, setAffinity] = useState<string[]>([]);
	const [content, setContent] = useState<string>("");
	const [mode, setMode] = useState<DocMode>("edit");
  useFeedbackTab("skill", mode);
	const [dirty, setDirty] = useState<boolean>(false);
	const [saving, setSaving] = useState<boolean>(false);
	const [exporting, setExporting] = useState<boolean>(false);
	const { optimisticMode, invocationBusy, invocationSettled, update: setInvocation } =
		useSkillInvocationUpdate(routeName, skill?.invocation, queryClient, toast);
	// ─── Multi-file editing ──────────────────────────────────────────────────
	// A third of the library is a DIRECTORY, not a document: SKILL.md is a
	// router that says "read references/planning.md before X". The active row
	// drives the body, the footer and the crumb; SKILL.md keeps its own buffer
	// here because it saves through `save_skill_full` (frontmatter + registry),
	// while every sibling lives in `useSkillFileBuffers`.
	const [activeRel, setActiveRel] = useState<string>(SKILL_MD);
	const [addFileOpen, setAddFileOpen] = useState<boolean>(false);

	const savedContentRef = useRef<string>("");
	// Saved metadata snapshot, so the frontmatter-aware diff shows metadata edits.
	const savedNameRef = useRef<string>("");
	const savedDescRef = useRef<string>("");
	const editorRef = useRef<CodeAreaHandle>(null);

	// Hydrate metadata from registry when skill loads/changes
	useEffect(() => {
		if (!skill || !routeName) return;
		setName(routeName);
		setDescription(skill.description ?? "");
		setScope((skill.scope as SkillScope) ?? "global");
		setVersion(skill.version ?? "");
		setUpstream(skill.upstream ?? "");
		setAffinity(skill.harnesses ?? []);
	}, [skill, routeName]);

	// Load the SKILL.md body. Skipped for a dropped skill — the checkout is
	// gone, so `read_skill_document` has nothing to read; its content comes
	// from `useDroppedSkill`'s pinned-ref `--content` read instead (below).
	// Also skipped until the REGISTRY has loaded: before that, `dropped` reads
	// as `false` for every route (no `skill` to check yet), so a cold deep
	// link to a dropped skill would otherwise fire this read a beat before the
	// registry lands and reveals it should never have run.
	useEffect(() => {
		if (!routeName || dropped || !registryLoaded) return;
		// Stale-response guard: a slow read for a previous skill must not
		// clobber the body/metadata after the route has moved on (which would
		// let ⌘S write the wrong skill's content). Ignore any resolution once
		// the effect has been cleaned up / re-run for a different skill.
		let ignore = false;
		invoke<SkillDocument>("read_skill_document", { name: routeName })
			.then((doc) => {
				if (ignore) return;
				setContent(doc.body);
				savedContentRef.current = doc.body;
				// Prefer the doc's name/description (canonical from file)
				setName(doc.name || routeName);
				setDescription(doc.description ?? "");
				savedNameRef.current = doc.name || routeName;
				savedDescRef.current = doc.description ?? "";
				setDirty(false);
			})
			.catch(() => {
				if (ignore) return;
				setContent("");
				savedContentRef.current = "";
				savedNameRef.current = routeName;
				savedDescRef.current = "";
			});
		return () => {
			ignore = true;
		};
	}, [routeName, dropped, registryLoaded]);

	const filesQuery = useQuery({
		queryKey: qk.skillFiles.forSkill(routeName ?? ""),
		queryFn: () => listSkillFiles(routeName ?? ""),
		// A dropped skill's checkout has nothing to list — don't even ask. Also
		// held until the registry has loaded (`dropped` isn't knowable before
		// then). (F2) An mcp-server issues the query too unless it plainly has
		// no `source` — Rust is the authority for the SKILL.md-only case.
		enabled: !!routeName && registryLoaded && (!isMcp || !!skill?.source) && !dropped,
	});
	const fileEntries = useMemo(
		() => filesQuery.data?.files ?? [],
		[filesQuery.data],
	);
	const fileBuffers = useSkillFileBuffers({
		skillName: routeName ?? "",
		activeRel,
		entries: fileEntries,
	});

	// Every skill opens on its own document. Without this, navigating from a
	// 16-file skill to a single-file one would leave the editor pointed at a
	// rel the new skill does not have.
	useEffect(() => {
		setActiveRel(SKILL_MD);
	}, [routeName]);

	useDefaultPreviewMode({ routeName, registryLoaded, activeRel, skill, dropped, setMode });
	const markDirty = useCallback(
		<T,>(setter: (v: T) => void) =>
			(v: T) => {
				setter(v);
				setDirty(true);
			},
		[],
	);

	// Every unwritten edit on this screen, from either owner: the SKILL.md body
	// + metadata (`dirty`) and any sibling-file buffer. It arms the leave guard
	// and, below, labels the discard prompt.
	const fileDirtyRels = fileBuffers.dirtyRels;
	const unsavedCount = fileDirtyRels.size + (dirty ? 1 : 0);
	const leaveGuard = useUnsavedGuard(unsavedCount > 0);

	// Writes SKILL.md + registry meta. `invokeName` is what Rust reads as the
	// CURRENT name — `routeName` on the plain-save path below, but the NEW
	// name on the rename-cascade confirm path (useRenameCascade), so Rust
	// sees `current_name === target_name` and skips its own rename (the
	// cascade already ran `hub rename`). `docName` is always the canonical
	// name being saved to.
	const writeSkill = useCallback(
		(invokeName: string, docName: string) =>
			invoke<string>("save_skill_full", {
				name: invokeName,
				document: { name: docName, description, body: content },
				meta: { version, description, scope, upstream, harnesses: affinity.join(",") },
			}),
		[description, content, version, scope, upstream, affinity],
	);

	// Bookkeeping for a write that already landed (either owner): saved-content
	// refs + `dirty`. Never navigates on its own — the rename-cascade result
	// state defers navigation to the user's own `Done` click.
	const onSkillWritten = useCallback(
		(updatedName: string) => {
			savedContentRef.current = content;
			savedNameRef.current = updatedName;
			savedDescRef.current = description;
			setDirty(false);
		},
		[content, description],
	);
	const leaveToSkill = useCallback(
		(updatedName: string) =>
			leaveGuard.bypass(() =>
				navigate(`/skill/${encodeURIComponent(updatedName)}`, { replace: true, ...fromNav(back) }),
			),
		[leaveGuard, navigate, back],
	);
	const rename = useRenameCascade({ writeSkill, onSaved: onSkillWritten, onLeave: leaveToSkill });

	/** @param stillDirty sibling buffers that will still be unwritten when this
	 *  save lands. Defaults to what the last render saw; `saveActive` passes the
	 *  post-write set, because React has not flushed it yet when it chains the
	 *  two writes in one keystroke. */
	const save = useCallback(async (stillDirty?: Set<string>) => {
		if (!routeName || saving || rename.phase !== "idle") return;
		const dirtySiblings = stillDirty ?? fileDirtyRels;
		const canonicalName = name.trim();
		if (!SLUG_RE.test(canonicalName)) {
			toast.error(
				"Skill name must use lowercase letters, numbers, and hyphens",
			);
			return;
		}
		// A rename moves the route, and the route owns the file buffers — every
		// unwritten sibling draft would be dropped on the way. Refuse the rename
		// instead of carrying buffers across an identity change (3c).
		if (canonicalName !== routeName && dirtySiblings.size > 0) {
			toast.error(
				"Save your open files first",
				`Renaming reopens the skill at its new name; ${dirtySiblings.size} unsaved file${
					dirtySiblings.size === 1 ? "" : "s"
				} would be lost.`,
			);
			return;
		}
		// A rename previews its blast radius first; `begin()` opens the review
		// dialog and owns the rest of the flow from there. `saving` stays false
		// while the user reads — this preflight/dialog window traces no busy
		// rune on Save (plans/3.md §Editor flow step 0/3).
		if (canonicalName !== routeName && !(await rename.begin(routeName, canonicalName))) {
			return;
		}
		setSaving(true);
		try {
			const updatedName = await trackProcess(
				{ title: `Saving ${canonicalName}`, body: "writing SKILL.md", kind: "fs" },
				() => writeSkill(routeName, canonicalName),
				{ successBody: `saved · ${canonicalName} v${version}`, retry: () => void save() },
			);

			await invalidateRegistry(queryClient);
			onSkillWritten(canonicalName);
			if (updatedName && updatedName !== routeName) leaveToSkill(updatedName);
		} catch {
			/* error surfaced on the process card */
		} finally {
			setSaving(false);
		}
	}, [
		routeName,
		saving,
		name,
		version,
		toast,
		fileDirtyRels,
		rename,
		writeSkill,
		onSkillWritten,
		leaveToSkill,
	]);

	const {
		droppedData,
		droppedPending,
		removal,
		pageBusy,
		doRemove,
		runDroppedAction,
		openPossibleSuccessor,
		droppedPrimary,
		droppedOverflow,
	} = useDroppedSkillActions({
		routeName,
		dropped,
		back,
		navigate,
		leaveGuard,
		setContent,
		savedContentRef,
		setDirty,
	});

	// Export the skill as a portable `.skillpack`. Available for read-only
	// (external-source) skills too — exporting reads, it never writes the library.
	const exportPack = useCallback(async () => {
		if (!routeName || exporting) return;
		setExporting(true);
		try {
			const out = await invoke<string | null>("save_file_dialog", {
				defaultName: `${routeName}.skillpack`,
			});
			// Cancelled sheet — a silent no-op, not an error.
			if (!out) return;
			const result = await runHubCmd([
				"skill",
				"export",
				routeName,
				"--out",
				out,
				"--json",
			]);
			let files: number | null = null;
			try {
				files = parseCliJson<SkillPackExportResult>(result.output).files;
			} catch {
				/* success without a JSON payload — still a successful write */
			}
			toast.success(
				`Exported "${routeName}"`,
				files != null ? `${files} files → ${out}` : out,
			);
		} catch (err) {
			toast.error("Export failed", errText(err));
		} finally {
			setExporting(false);
		}
	}, [routeName, exporting, toast]);

	const duplicateAsLocal = useCallback(async () => {
		if (!routeName) return;
		const newName = `${routeName}-local`;
		try {
			await runHubCmd(["source", "duplicate", routeName, "--as", newName, "--json"]);
			await invalidateRegistry(queryClient);
			toast.success(`Duplicated to "${newName}"`);
			navigate(`/skill/${encodeURIComponent(newName)}`, fromNav(back));
		} catch (err) {
			toast.error(`Duplicate failed: ${errText(err)}`);
		}
	}, [routeName, toast, navigate, back]);

	// ─── Markdown toolbar helpers — drive the CodeMirror editor ──────────────
	// Content/dirty flow through the editor's normal onChange.
	const wrap = useCallback((left: string, right: string) => {
		editorRef.current?.wrapSelection(left, right);
	}, []);

	const prefixLine = useCallback((prefix: string) => {
		editorRef.current?.prefixLines(prefix);
	}, []);

	// Live counters use the cheap byte estimate so a keystroke never pays for a
	// full BPE encode; the exact `encode()` runs only on a 300ms trailing
	// debounce (B3-03). The footer shows the approximation first, then the exact
	// count once the debounce settles.
	const { descTokens, bodyTokens, totalTokens } = useSkillTokenEstimate(
		name,
		description,
		content,
	);

	// Same formula as `activeContent` below, computed here (before the
	// loading/not-found guards) because `useSkillRefs` is a hook and must run
	// unconditionally on every render.
	const skillRefsContent =
		activeRel === SKILL_MD ? content : (fileBuffers.activeBuffer?.content ?? "");
	const refs = useSkillRefs({
		host: { self: routeName ?? "", back: skillBackTarget(routeName ?? "") },
		content: skillRefsContent,
		registry,
	});

	// C4 — the chrome is not part of the payload. Every pre-payload branch of
	// this editor keeps the identity column, the title and the way back, so a
	// slow registry read never paints a headerless frame that then jumps.
	const pendingChrome = (
		<ScreenHeader
			back={{ label: back.label, onClick: () => navigate(back.path, backReturnOptions(back)) }}
			nameMono={routeName ?? ""}
			crumbs={[...(back.crumbs ?? [back.label]), routeName ?? ""]}
		/>
	);

	if (registryError && !registry) {
		return (
			<>
				{pendingChrome}
				<div className="main-body">
					<EmptyState
						icon="warning"
						title="Library unavailable"
						description={String(registryError)}
						action={
							<BackButton onClick={() => navigate(back.path, backReturnOptions(back))}>
								Back to {back.label}
							</BackButton>
						}
					/>
				</div>
			</>
		);
	}

	if (!registry) {
		return (
			<>
				{pendingChrome}
				<div className="main-body">
					<EmptyState
						icon="search"
						title="Loading skill"
						description="Reading your registry…"
					/>
				</div>
			</>
		);
	}

	// Rendered from the not-found branch too: the registry re-keys mid-flow, so
	// this route stops resolving while the disclosure of a landed rename is open.
	const renameDialog = (
		<RenameRefsDialog
			cascade={rename}
			onOpenSnippet={(snippetName) =>
				leaveGuard.bypass(() => navigate(`/snippet/${encodeURIComponent(snippetName)}`))
			}
		/>
	);

	if (!skill) {
		return (
			<>
				{pendingChrome}
				<div className="main-body">
					<EmptyState
						icon="warning"
						title="Skill not found"
						description={`No skill named ${routeName}`}
						action={
							<BackButton onClick={() => navigate(back.path, backReturnOptions(back))}>
								Back to {back.label}
							</BackButton>
						}
					/>
				</div>
				{renameDialog}
			</>
		);
	}

	const copyPath = () => {
		if (skill.source) void navigator.clipboard.writeText(skill.source);
	};

	const readOnly = isExternalManaged(skill);
	const ownerSource = sourceForSkill(routeName ?? "", registry);

	// ─── The active file drives the body, the footer and the crumb ───────────
	const isSkillMd = activeRel === SKILL_MD;
	const activeEntry = fileEntries.find((e) => e.rel === activeRel);
	const skillRoot = filesQuery.data?.root ?? "";
	const activeMissing = fileBuffers.missingRels.has(activeRel);
	// A binary asset (or one past the editor's byte cap) is LISTED but never
	// opened: a garbled buffer plus a real hang risk on a multi-MB document.
	const activeUnopenable = !isSkillMd && !!activeEntry && !activeEntry.editable;
	const activeMarkdown = isSkillMd || isMarkdownRel(activeRel);
	const activeBuffer = fileBuffers.activeBuffer;
	const activeContent = isSkillMd ? content : (activeBuffer?.content ?? "");
	const activeDirty = isSkillMd ? dirty : fileBuffers.dirtyRels.has(activeRel);
	const dirtyRels = new Set(fileBuffers.dirtyRels);
	if (dirty) dirtyRels.add(SKILL_MD);

	const revealPath = (rel?: string) => {
		if (!skillRoot) return;
		void revealItemInDir(rel ? `${skillRoot}/${rel}` : skillRoot);
	};

	// ─── Saving ──────────────────────────────────────────────────────────────
	// One Save, both owners. The active row decides which BODY is written, but
	// the metadata fields belong to the screen no matter which row is open — so
	// ⌘S (and the button) writes the active sibling AND flushes any pending
	// SKILL.md/metadata edit through `save_skill_full`. Anything else strands
	// the metadata edit until the author happens to click back onto SKILL.md.
	const saveActive = async () => {
		const stillDirty = new Set(fileBuffers.dirtyRels);
		if (!isSkillMd) {
			try {
				// No-ops when the buffer is clean; `conflict:` opens the dialog and
				// reports `false`, leaving the buffer dirty.
				if (await fileBuffers.save()) stillDirty.delete(activeRel);
			} catch (err) {
				// A failed sibling write is otherwise completely silent: the pill
				// stays lit and nothing says why. The buffer keeps its edits.
				toast.error(`Could not save ${activeRel}`, errText(err));
				return;
			}
		}
		if (dirty) await save(stillDirty);
	};

	// The MCP panel's ⌘S: the `mcp:` block (`mcpDraft.save()`, §4.6) and any
	// metadata edit (still the plain `save()` — description/scope/etc. are
	// unchanged for an mcp-server), in parallel.
	const saveMcpActive = async () => {
		await Promise.all([mcpDraft.dirty ? mcpDraft.save() : undefined, dirty ? save() : undefined]);
	};

	// Every exit is guarded (rail, NavPanel, palette, chords, back arrow) by the
	// navigator wrapper, so the back arrow just navigates.
	const leave = () => navigate(back.path, backReturnOptions(back));

	// (F2) An mcp-server's FILES earns a section only once its folder holds
	// more than SKILL.md; a plain skill keeps showing FILES as always.
	const filesSection =
		isMcp && fileEntries.length <= 1 ? undefined : (
			<SkillFilesSection
				listing={filesQuery.data}
				loading={filesQuery.isPending}
				error={filesQuery.error}
				activeRel={activeRel}
				onSelect={setActiveRel}
				dirtyRels={dirtyRels}
				missingRels={fileBuffers.missingRels}
				readOnly={readOnly || pageBusy}
				onAddFile={() => setAddFileOpen(true)}
				storageKey={SKILL_EDITOR_SECTIONS_KEY}
				dropped={
					dropped
						? { refShort: droppedData?.ref_short ?? null, lastSeenAt: droppedData?.last_seen_at ?? null }
						: undefined
				}
			/>
		);

	const bodyOverride = isMcp ? (
		<McpPanel
			name={routeName ?? ""} draft={mcpDraft} readOnly={readOnly} affinity={affinity}
			installedHarnesses={installedHarnesses} deliveryRows={mcpDeliveryRows} freshness={mcpFreshness}
			onReveal={(absolutePath) => void revealItemInDir(absolutePath)}
		/>
	) : (
		resolveSkillBodyOverride({
			dropped,
			droppedPending,
			droppedData,
			isSkillMd,
			activeRel,
			activeEntry,
			activeUnopenable,
			activeMissing,
			activeBuffer,
			skillRoot,
			onReveal: revealPath,
			onRefetchFiles: () => void filesQuery.refetch(),
		})
	);

	// Shared by BOTH the dropped and the plain read-only overflow sets —
	// "where did this come from" never needs three copies of the same two items.
	const sourceOverflowItems = buildSourceOverflowItems({ upstream, ownerSource });

	return (
		// `display: contents` so this carries `aria-busy`/`data-busy` for the
		// whole screen (the page-lock contract) without becoming a new layout
		// box between `.app-main` and the header/shell it already expects as
		// direct children. `cursor` is inherited, so it still cascades to every
		// descendant even though this element generates no box of its own.
		<div
			style={{ display: "contents", cursor: pageBusy ? "progress" : undefined }}
			aria-busy={pageBusy || undefined}
			data-busy={pageBusy || undefined}
		>
			<ScreenHeader
				className="skill-editor-header"
				back={{ label: back.label, onClick: leave }}
				nameMono={
					readOnly || dropped ? (
						name
					) : (
						<SkillNameTitle
							name={name}
							savedName={routeName ?? ""}
							registry={registry}
							onChange={markDirty(setName)}
						/>
					)
				}
				meta={
					<>
						<ScopeBadge scope={scope} />
						<KindMark kind={skill.type} />
						{ownerSource && isExternalSource(ownerSource) && <SourceChip source={ownerSource} compact />}
						<SkillHeaderClasses items={classificationContributions.classes} onInspect={(value) => inspectClassification("classes", value)} />
						{skill.classification?.working_mode && <Icon name={`working-${skill.classification.working_mode}`} size={14} title={skill.classification.working_mode} />}
						{skill.classification?.maturity && <span className="classification-header-maturity">{skill.classification.maturity}</span>}
					</>
				}
				state={
					dropped ? (
						<StatusBadge channel="error" icon="warning" title="DROPPED UPSTREAM">
							DROPPED UPSTREAM
						</StatusBadge>
					) : readOnly ? (
						<StatePill state="readonly" icon="link">
							READ-ONLY
						</StatePill>
					) : name.trim() !== routeName ? (
						<RenamedPill />
					) : null
				}
				crumbs={[
					...(back.crumbs ?? [back.label]),
					scope,
					name,
					// The identity in `nameMono` never changes with the active file —
					// a title that mutates per file is the eye-jump the fixed header
					// exists to prevent. The rel path rides the crumb line instead,
					// which is already the first thing to drop at ≤360px.
					...(isSkillMd
						? []
						: [
								<span className="crumb-path" key="path">
									<span className="path">{activeRel}</span>
								</span>,
							]),
				]}
				primary={
					dropped ? (
						<LoadingButton
							variant="primary"
							icon={DROPPED_ACTION_ICON[droppedPrimary]}
							loading={pageBusy}
							loadingLabel={
								droppedPrimary === "forget" ? removalLoadingLabel("forget") : undefined
							}
							disabled={pageBusy}
							onClick={() => runDroppedAction(droppedPrimary)}
						>
							{DROPPED_ACTION_LABEL[droppedPrimary]}
						</LoadingButton>
					) : undefined
				}
				overflow={buildSkillHeaderOverflow({
					dropped,
					droppedOverflow,
					runDroppedAction,
					pageBusy,
					readOnly,
					skillRoot,
					revealPath,
					duplicateAsLocal,
					copyPath,
					doRemove,
					sourceOverflowItems,
				})}
			/>

			<DocumentEditorShell
				// Key by skill identity so navigating to another skill remounts a
				// fresh CodeMirror view — otherwise the reused editor keeps the prior
				// skill's undo history and ⌘Z bleeds its content in (B3-11).
				key={routeName}
				content={activeContent}
				extraExtensions={refs.extension}
				skillRefs={refs.render}
				onContentChange={
					readOnly || pageBusy
						? () => {}
						: isSkillMd
							? markDirty(setContent)
							: fileBuffers.edit
				}
				readOnly={readOnly || pageBusy}
				editorRef={editorRef}
				language={activeMarkdown ? "markdown" : "text"}
				editorKey={activeRel}
				bodyOverride={bodyOverride}
				mode={mode}
				onModeChange={setMode}
				// Rendering markdown-of-Python is a wrong answer presented
				// confidently; `lineDiff` is content-agnostic, so Diff survives.
				modes={
					activeMarkdown ? undefined : ["edit", "diff"]
				}
				// The frontmatter-aware diff belongs to SKILL.md alone — a sibling
				// file diffs as plain saved-vs-current text.
				diffOriginal={
					isSkillMd
						? composeSkillDocument(
								{
									name: savedNameRef.current,
									description: savedDescRef.current,
								},
								savedContentRef.current,
							)
						: (activeBuffer?.baseline ?? "")
				}
				diffCurrent={
					isSkillMd
						? composeSkillDocument({ name, description }, content)
						: activeContent
				}
				// Enabled when EITHER owner is dirty: the active row's body, or a
				// metadata edit made while a sibling row was open. An mcp-server has
				// no sibling-file buffers — its own draft's dirty flag stands in.
				dirty={isMcp ? mcpDraft.dirty || dirty : activeDirty || dirty}
				onSave={() => void (isMcp ? saveMcpActive() : saveActive())}
				saveDisabled={isMcp ? saving || mcpDraft.saveDisabled : saving || fileBuffers.saving}
				saving={isMcp ? saving || mcpDraft.saving : saving || fileBuffers.saving}
				splitStorageKey="st:layout:skill-editor"
				headerActions={
					<EditorBarVerbs
						readOnly={readOnly}
						dropped={dropped}
						exporting={exporting}
						onDuplicate={() => void duplicateAsLocal()}
						onExport={() => void exportPack()}
					/>
				}
				toolbar={
					activeMarkdown ? (
						<MarkdownToolbar onWrap={wrap} onPrefixLine={prefixLine} />
					) : undefined
				}
				footerExtras={
					<>
						{/* Which file am I in, answered from a place that never
						    collapses — the side panel (and with it FILES) folds away
						    below ~772px of editor width. */}
						<span className="editor-active-path" data-testid="editor-active-path">
							<Icon name="doc" size={10} />
							<span>{activeRel}</span>
						</span>
						{/* No line/char count for a bodyOverride row (binary, too-large,
						    or missing on disk) — that content was never read into a
						    buffer, so `activeContent` is just an empty string and the
						    count would lie ("1 lines · 0 chars"). */}
						{!bodyOverride && (
							<span>
								{activeContent.split("\n").length} lines ·{" "}
								{activeContent.length} chars
							</span>
						)}
						{dirtyRels.size > 0 && (
							<span className="sf-unsaved">{dirtyRels.size} unsaved</span>
						)}
						<span className="editor-foot-spacer" />
						<span
								className="editor-foot-stat"
								title="GPT-5 / o200k_base estimate. Claude/Gemini typically within ±10%."
							>
							desc ~{formatTokens(descTokens)} · body ~
							{formatTokens(bodyTokens)} · total ~
							{formatTokens(totalTokens)} tokens
						</span>
					</>
				}
				sidePanel={
					<SkillEditorSidePanel
						skillName={routeName ?? ""}
						skill={skill}
						registry={registry}
						ownerSource={ownerSource}
						installedHarnesses={installedHarnesses}
						readOnly={readOnly || pageBusy}
						classificationReadOnly={pageBusy}
						// ships_with (D5, wave E follow-up on reports/5-u7-decl.md): the
						// referrer names the project this editor was opened from, when
						// there is one — the only signal SHIPS WITH needs to turn on
						// per-item `provisioned` verdicts (A5).
						project={back.crumbs?.[0] === "project" ? back.crumbs[1] : undefined}
						busy={pageBusy}
						files={filesSection}
						content={activeContent}
						description={description}
						onDescriptionChange={markDirty(setDescription)}
						scope={scope}
						onScopeChange={markDirty(setScope)}
						version={version}
						onVersionChange={markDirty(setVersion)}
						upstream={upstream}
						onUpstreamChange={markDirty(setUpstream)}
						affinity={affinity}
						onAffinityChange={(next) => {
							setAffinity(next);
							setDirty(true);
						}}
						onInvocationPick={(mode) => void setInvocation(mode)}
						invocationBusy={invocationBusy}
						invocationMode={optimisticMode}
						invocationSettled={invocationSettled}
						dropped={dropped ? droppedData : undefined}
						onDroppedAction={runDroppedAction}
						onOpenPossibleSuccessor={openPossibleSuccessor}
						droppedBusy={pageBusy}
						{...classificationPanelProps}
					/>
				}
				dangerZone={
					<div className="danger-zone">
						<h4>Danger zone</h4>
						<div
							style={{
								fontSize: 11.5,
								color: "var(--fg-mute)",
								marginBottom: 10,
							}}
						>
							{dropped
								? "Forget this skill — removes the registry entry. Nothing on disk is left to move. Undo is in the toast for 7 s."
								: "Archive hides this skill from selection and removes it from all bundles. Sync will deactivate it everywhere."}
						</div>
						<div className="actions">
							<LoadingButton
								variant="danger"
								icon="archive"
								loading={pageBusy}
								loadingLabel={removalLoadingLabel(dropped ? "forget" : "archive")}
								disabled={pageBusy}
								onClick={() => void doRemove()}
							>
								{dropped ? "Forget this skill" : "Archive this skill"}
							</LoadingButton>
						</div>
					</div>
				}
			/>

			<AddSkillFileSheet
				open={addFileOpen}
				skillName={routeName ?? ""}
				onClose={() => setAddFileOpen(false)}
				onCreated={async (rel) => {
					// The buffer for a new row can only load once the listing knows
					// about it, so the refetch is awaited: a failed one would
					// otherwise strand the body on "Opening file" forever.
					try {
						await filesQuery.refetch({ throwOnError: true });
						setActiveRel(rel);
					} catch (err) {
						toast.error("Created, but the file list did not refresh", errText(err));
					}
				}}
			/>

			{/* A file rewritten under a dirty buffer never silently drops the
			    author's typing — the same two-branch grammar the Agent Docs
			    screen uses. */}
			<Modal
				open={!!fileBuffers.conflictRel}
				onClose={() => fileBuffers.dismissConflict()}
				title="This file changed on disk"
				width={440}
				footer={
					<>
						{/* Either branch can fail on the way to disk; a rejection here
						    would otherwise leave the modal open with no explanation. */}
						<Button
							onClick={() =>
								void fileBuffers
									.reloadFromDisk()
									.catch((err) => toast.error("Could not reload", errText(err)))
							}
						>
							Reload from disk
						</Button>
						<Button
							variant="primary"
							busy={fileBuffers.saving}
							onClick={() =>
								void fileBuffers
									.keepMyVersion()
									.catch((err) => toast.error("Could not save", errText(err)))
							}
						>
							Keep my version
						</Button>
					</>
				}
			>
				<p className="text-mute">
					<span className="text-mono">{fileBuffers.conflictRel ?? ""}</span> was
					rewritten while you were editing it. Reloading drops your edits;
					keeping yours overwrites what is on disk now.
				</p>
			</Modal>

			{/* Raised by the navigation guard for ANY in-app exit — the rail, a
			    NavPanel row, the palette, a `g …` chord, the back arrow. */}
			<ConfirmDialog
				open={leaveGuard.pending}
				onClose={leaveGuard.cancel}
				onConfirm={leaveGuard.confirm}
				title="Discard unsaved changes?"
				body={`${dirtyRels.size} file${dirtyRels.size === 1 ? "" : "s"} ${
					dirtyRels.size === 1 ? "has" : "have"
				} edits that were never written to disk.`}
				confirmLabel="Discard and leave"
				tone="danger"
			/>

			{renameDialog}

			{/* The one archive/forget confirm — shown only when the skill is
			    equipped somewhere (blast radius listed below). */}
			<ConfirmDialog
				open={!!removal.pending}
				onClose={removal.cancel}
				onConfirm={removal.confirm}
				tone="danger"
				busy={removal.busy}
				title={removal.pending ? removalConfirmTitle(removal.pending) : ""}
				body={removal.pending ? removalConfirmBody(removal.pending) : ""}
				confirmLabel={removal.pending?.verb === "forget" ? "Forget" : "Archive"}
				blastRadius={
					removal.pending && blastRadiusLines(removal.pending.refs).length > 0 ? (
						<ul>
							{blastRadiusLines(removal.pending.refs).map((line) => (
								<li key={line.label}>
									{line.label}: {line.items.join(", ")}
								</li>
							))}
						</ul>
					) : undefined
				}
			/>
		</div>
	);
}
