import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	type CSSProperties,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Icon } from "./Icon";
import { Button } from "./Button";
import { Chip, Chips } from "./Chips";
import { CodeAreaEdit, CodeAreaPreview } from "./CodeArea";
import { AppliedSnippetsStrip } from "./snippets/AppliedSnippetsStrip";
import { AgentDocsFixBanner } from "./AgentDocsFixBanner";
import { ScreenHeader } from "./ScreenHeader";
import { StatePill } from "./StatePill";
import { SubheaderViewChips } from "./SubheaderViewChips";
import { PROJECT_VIEWS, type ProjectView } from "@/lib/projectViews";
import { useToast } from "./Toast";
import {
	readAgentDoc,
	useAgentDocsListing,
	writeAgentDoc,
} from "@/hooks/useAgentDocs";
import { useHarnesses } from "@/hooks/useHarnesses";
import type {
	AgentDocContent,
	AgentDocFile,
	AgentDocFolder,
	AgentDocErrorBody,
	AgentDocInstructionSet,
} from "@/types/agentDocs";
import { parseAgentDocError } from "@/types/agentDocs";
import {
	estimateTokens,
	estimateTokensFromBytes,
	formatTokens,
} from "@/lib/estimateTokens";
import {
	buildInstructionSetTree,
	type InstructionSetNode,
} from "@/lib/agentDocsTree";
import { ResizableSplit } from "./ResizableSplit";
import { HarnessAgentStrip } from "./harness/HarnessAgentStrip";
import { harnessFile, type RootFile } from "./harness/harnessRegistry";

// ─── Types ──────────────────────────────────────────────────────────────────

interface Buffer {
	content: string;
	baseline: string;
	loadedHash: string | null;
	loadedAtTs: number;
	isNew: boolean;
	/** True when the backend classified the loaded file as a hub-derived
	 *  `CLAUDE.md` (symlink to `AGENTS.md`, or a `@AGENTS.md` import pointer).
	 *  The editor renders a read-only stub for these and redirects edits to
	 *  the canonical source. */
	isDerivedPointer?: boolean;
}

type Conflict = {
	rel: string;
	currentHash: string;
};

type PendingDiscard = (() => void) | null;

interface Props {
	projectName: string;
	projectPath: string;
	view: ProjectView;
	onChangeView: (v: ProjectView) => void;
	/** Combined effective harness ids (global ∪ project). */
	projectHarnesses: string[];
	/** Harnesses enabled globally (for the strip's Manage popover). */
	globalHarnesses?: string[];
	/** Per-project harness list (for the strip's Manage popover). */
	ownHarnesses?: string[];
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function flattenFiles(node: AgentDocFolder): AgentDocFile[] {
	const out: AgentDocFile[] = [];
	for (const f of node.files) out.push(f);
	for (const d of node.dirs) out.push(...flattenFiles(d));
	return out;
}

function findFile(node: AgentDocFolder, rel: string): AgentDocFile | null {
	for (const f of node.files) if (f.rel === rel) return f;
	for (const d of node.dirs) {
		const hit = findFile(d, rel);
		if (hit) return hit;
	}
	return null;
}

function treeHasExistingFile(node: AgentDocFolder): boolean {
	if (node.files.some((f) => f.exists)) return true;
	for (const d of node.dirs) if (treeHasExistingFile(d)) return true;
	return false;
}

function treeHasDirty(
	node: AgentDocFolder,
	isDirtyOf: (rel: string) => boolean,
): boolean {
	if (node.files.some((f) => isDirtyOf(f.rel))) return true;
	for (const d of node.dirs) if (treeHasDirty(d, isDirtyOf)) return true;
	return false;
}

function fmtSize(n: number | null | undefined): string {
	if (n == null) return "—";
	if (n < 1024) return `${n} B`;
	return `${(n / 1024).toFixed(1)} KB`;
}

function fmtClockHM(secs: number | null | undefined): string {
	if (secs == null) return "—";
	const d = new Date(secs * 1000);
	return d.toLocaleTimeString([], {
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	});
}

const KNOWN_RELS = [
	"CLAUDE.md",
	"AGENTS.md",
	".claude/CLAUDE.md",
	".agents/AGENTS.md",
];

const FILE_ORDER = ["AGENTS.md", "CLAUDE.md"];

function sortedFiles(files: AgentDocFile[]): AgentDocFile[] {
	return [...files].sort((a, b) => {
		const ai = FILE_ORDER.indexOf(a.name);
		const bi = FILE_ORDER.indexOf(b.name);
		if (ai !== bi) {
			if (ai === -1) return 1;
			if (bi === -1) return -1;
			return ai - bi;
		}
		if (a.is_known !== b.is_known) return a.is_known ? -1 : 1;
		return a.name.localeCompare(b.name);
	});
}

/** Editing a unified set grounds in the canonical real file — AGENTS.md when
 *  it exists, else CLAUDE.md. */
function editableRelForSet(set: AgentDocInstructionSet): string {
	const agent = set.formats.AGENT.file;
	const claude = set.formats.CLAUDE.file;
	return agent?.rel ?? claude?.rel ?? set.formats.CLAUDE.rel;
}

/** Deviation badges only — canonical sets render silently (green = silence).
 *  Returns at most one layout badge plus flag badges. */
function setBadges(
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

function isDeviating(set: AgentDocInstructionSet): boolean {
	if (set.flags.includes("legacy") || set.flags.includes("broken_link"))
		return true;
	return set.verdict !== "canonical" && set.verdict !== "none";
}

function relDirLabel(relativeDir: string): string {
	return relativeDir || "root";
}

// ─── File row ───────────────────────────────────────────────────────────────

function pillFor(
	f: AgentDocFile,
	dirty: boolean,
	externallyChanged: boolean,
): { label: string; color: string } | null {
	if (dirty) return { label: "UNSAVED", color: "var(--amber)" };
	if (externallyChanged) return { label: "CHANGED", color: "var(--amber)" };
	if (f.error) return { label: "ERROR", color: "var(--red)" };
	if (!f.exists) return { label: "MISSING", color: "var(--fg-dim)" };
	return null;
}

function FileRow({
	file,
	depth,
	selected,
	dirty,
	externallyChanged,
	onSelect,
}: {
	file: AgentDocFile;
	depth: number;
	selected: boolean;
	dirty: boolean;
	externallyChanged: boolean;
	onSelect: () => void;
}) {
	const state = !file.exists
		? "missing"
		: externallyChanged
			? "changed"
			: dirty
				? "dirty"
				: file.error
					? "error"
					: "ok";
	const pill = pillFor(file, dirty, externallyChanged);
	return (
		<button
			type="button"
			className="ad-file"
			data-depth={depth}
			data-state={state}
			data-symlink={file.is_symlink || undefined}
			style={{ ["--ad-depth" as string]: depth } as CSSProperties}
			aria-current={selected ? "true" : undefined}
			onClick={onSelect}
			title={file.absolute_path}
		>
			<span className="ad-file-dot" />
			<Icon
				name={file.is_symlink ? "link" : "doc"}
				size={11}
				className="ad-file-icon"
			/>
			<span className="ad-file-name">{file.name}</span>
			{pill && (
				<span
					className="ad-pill"
					style={{
						color: pill.color,
						background: `color-mix(in oklab, ${pill.color} 14%, transparent)`,
						borderColor: `color-mix(in oklab, ${pill.color} 35%, transparent)`,
					}}
				>
					{pill.label}
				</span>
			)}
			<span className="ad-file-size">
				{file.exists ? fmtSize(file.size) : "absent"}
			</span>
		</button>
	);
}

function UnifiedFileRow({
	files,
	mode,
	primary,
	depth,
	selected,
	dirty,
	externallyChanged,
	onSelect,
}: {
	files: AgentDocFile[];
	mode: "symlink" | "import";
	primary: AgentDocFile;
	depth: number;
	selected: boolean;
	dirty: boolean;
	externallyChanged: boolean;
	onSelect: () => void;
}) {
	const state = externallyChanged ? "changed" : dirty ? "dirty" : "ok";
	return (
		<button
			type="button"
			className="ad-file ad-file-unified"
			data-depth={depth}
			data-state={state}
			data-mode={mode}
			style={{ ["--ad-depth" as string]: depth } as CSSProperties}
			aria-current={selected ? "true" : undefined}
			onClick={onSelect}
			title={primary.absolute_path}
		>
			<span className="ad-file-dot" />
			<Icon name="doc" size={11} className="ad-file-icon" />
			<span className="ad-file-name">
				<span>{files[0].name}</span>
				<span className="ad-unified-glyph">→</span>
				<span className="ad-unified-secondary">{files[1].name}</span>
			</span>
			<span className="ad-pill ad-pill-binding" data-mode={mode}>
				{mode === "import" ? "IMPORT" : "SYMLINK"}
			</span>
			<span className="ad-file-size">{fmtSize(primary.size)}</span>
		</button>
	);
}

function FolderRow({
	name,
	depth,
	expanded,
	onToggle,
	allMissing,
	isKnown,
	hasDescendantDirty,
}: {
	name: string;
	depth: number;
	expanded: boolean;
	onToggle: () => void;
	allMissing: boolean;
	isKnown: boolean;
	hasDescendantDirty: boolean;
}) {
	return (
		<button
			type="button"
			className="ad-folder"
			data-depth={depth}
			data-known={isKnown || undefined}
			data-empty={allMissing || undefined}
			style={{ ["--ad-depth" as string]: depth } as CSSProperties}
			onClick={onToggle}
		>
			<Icon
				name={expanded ? "chevronDown" : "chevronRight"}
				size={10}
				className="ad-folder-chevron"
			/>
			<Icon name="folder" size={11} className="ad-folder-icon" />
			<span className="ad-folder-name">{name}/</span>
			{allMissing && isKnown && (
				<span className="ad-pill ad-pill-missing">FOLDER MISSING</span>
			)}
			{hasDescendantDirty && !allMissing && (
				<span
					className="ad-pill"
					style={{
						color: "var(--amber)",
						background: "color-mix(in oklab, var(--amber) 14%, transparent)",
						borderColor: "color-mix(in oklab, var(--amber) 35%, transparent)",
					}}
				>
					EDITS
				</span>
			)}
		</button>
	);
}

function InstructionSetRow({
	set,
	selected,
	dirty,
	externallyChanged,
	onSelect,
	depth = 1,
	showPath = true,
}: {
	set: AgentDocInstructionSet;
	selected: boolean;
	dirty: boolean;
	externallyChanged: boolean;
	onSelect: () => void;
	depth?: number;
	showPath?: boolean;
}) {
	const badges = setBadges(set);
	const state = externallyChanged
		? "changed"
		: dirty
			? "dirty"
			: badges.some((b) => b.tone === "error")
				? "error"
				: badges.length > 0
					? "warn"
					: "ok";
	return (
		<button
			type="button"
			className="ad-file ad-instruction-set"
			data-depth={depth}
			data-state={state}
			data-verdict={set.verdict}
			style={{ ["--ad-depth" as string]: depth } as CSSProperties}
			aria-current={selected ? "true" : undefined}
			onClick={onSelect}
			title={set.full_path_title}
		>
			<span className="ad-file-dot" />
			<Icon name="doc" size={11} className="ad-file-icon" />
			<span className="ad-set-main">
				<span className="ad-set-label">{set.label}</span>
				{showPath && (
					<span className="ad-set-path">
						{set.display_path || relDirLabel(set.relative_dir)}
					</span>
				)}
			</span>
			{dirty && (
				<span className="ad-pill" style={{ color: "var(--amber)" }}>
					UNSAVED
				</span>
			)}
			{badges.map((b) => (
				<span
					key={b.label}
					className="ad-pill ad-pill-deviation"
					data-tone={b.tone}
				>
					{b.label}
				</span>
			))}
		</button>
	);
}

// ─── Recursive tree renderer ────────────────────────────────────────────────

function FileTree({
	node,
	depth,
	unifyRootMode,
	selected,
	isDirtyOf,
	externalEditTarget,
	onSelect,
	expanded,
	toggleExpanded,
}: {
	node: AgentDocFolder;
	depth: number;
	/** When set, the root AGENTS.md + CLAUDE.md pair renders as one unified
	 *  row in this mode. Derived from the scanner verdict, never from raw
	 *  file flags. */
	unifyRootMode: "symlink" | "import" | null;
	selected: string;
	isDirtyOf: (rel: string) => boolean;
	externalEditTarget: string | null;
	onSelect: (rel: string) => void;
	expanded: Record<string, boolean>;
	toggleExpanded: (path: string) => void;
}) {
	let files = sortedFiles(node.files);
	const dirs = [...node.dirs].sort((a, b) => a.name.localeCompare(b.name));

	let unifiedItem: {
		files: AgentDocFile[];
		primary: AgentDocFile;
		mode: "symlink" | "import";
	} | null = null;

	if (depth === 0 && unifyRootMode) {
		const claude = files.find((f) => f.rel === "CLAUDE.md");
		const agent = files.find((f) => f.rel === "AGENTS.md");
		if (claude?.exists && agent?.exists) {
			unifiedItem = {
				files: [agent, claude],
				primary: agent,
				mode: unifyRootMode,
			};
			files = files.filter(
				(f) => f.rel !== "CLAUDE.md" && f.rel !== "AGENTS.md",
			);
		}
	}

	return (
		<>
			{unifiedItem && (
				<UnifiedFileRow
					key={`u:${unifiedItem.primary.rel}`}
					files={unifiedItem.files}
					mode={unifiedItem.mode}
					primary={unifiedItem.primary}
					depth={depth + 1}
					selected={
						unifiedItem.primary.rel === selected ||
						unifiedItem.files.some((f) => f.rel === selected)
					}
					dirty={isDirtyOf(unifiedItem.primary.rel)}
					externallyChanged={
						externalEditTarget === unifiedItem.primary.rel &&
						unifiedItem.primary.exists
					}
					onSelect={() => onSelect(unifiedItem!.primary.rel)}
				/>
			)}
			{files.map((f) => (
				<FileRow
					key={`f:${f.rel}`}
					file={f}
					depth={depth + 1}
					selected={f.rel === selected}
					dirty={isDirtyOf(f.rel)}
					externallyChanged={externalEditTarget === f.rel && f.exists}
					onSelect={() => onSelect(f.rel)}
				/>
			))}
			{dirs.map((dir) => {
				const subPath = dir.path;
				const isOpen = expanded[subPath] !== false;
				const subAllMissing = !treeHasExistingFile(dir);
				const subIsKnown = KNOWN_RELS.some((k) => k.startsWith(`${subPath}/`));
				const hasDirty = treeHasDirty(dir, isDirtyOf);
				return (
					<div key={`d:${subPath}`}>
						<FolderRow
							name={dir.name}
							depth={depth + 1}
							expanded={isOpen}
							onToggle={() => toggleExpanded(subPath)}
							allMissing={subAllMissing}
							isKnown={subIsKnown}
							hasDescendantDirty={hasDirty}
						/>
						{isOpen && (
							<FileTree
								node={dir}
								depth={depth + 1}
								unifyRootMode={unifyRootMode}
								selected={selected}
								isDirtyOf={isDirtyOf}
								externalEditTarget={externalEditTarget}
								onSelect={onSelect}
								expanded={expanded}
								toggleExpanded={toggleExpanded}
							/>
						)}
					</div>
				);
			})}
		</>
	);
}

function instructionSetTreeHasDirty(
	node: InstructionSetNode,
	isDirtyOf: (rel: string) => boolean,
): boolean {
	for (const s of node.sets) {
		if (isDirtyOf(editableRelForSet(s))) return true;
	}
	for (const c of node.children) {
		if (instructionSetTreeHasDirty(c, isDirtyOf)) return true;
	}
	return false;
}

function InstructionSetTree({
	node,
	depth,
	selectedSetId,
	isDirtyOf,
	externalEditTarget,
	onSelect,
	expanded,
	toggleExpanded,
}: {
	node: InstructionSetNode;
	depth: number;
	selectedSetId: string | null;
	isDirtyOf: (rel: string) => boolean;
	externalEditTarget: string | null;
	onSelect: (set: AgentDocInstructionSet) => void;
	expanded: Record<string, boolean>;
	toggleExpanded: (path: string) => void;
}) {
	return (
		<>
			{node.sets.map((set) => {
				const editRel = editableRelForSet(set);
				return (
					<InstructionSetRow
						key={`s:${set.id}`}
						set={set}
						selected={selectedSetId === set.id}
						dirty={isDirtyOf(editRel)}
						externallyChanged={externalEditTarget === editRel}
						onSelect={() => onSelect(set)}
						depth={depth + 1}
						showPath={false}
					/>
				);
			})}
			{node.children.map((child) => {
				const key = `ist:${child.fullPath}`;
				const isOpen = expanded[key] !== false;
				const hasDirty = instructionSetTreeHasDirty(child, isDirtyOf);
				return (
					<div key={`d:${child.fullPath}`}>
						<FolderRow
							name={child.name}
							depth={depth + 1}
							expanded={isOpen}
							onToggle={() => toggleExpanded(key)}
							allMissing={false}
							isKnown={false}
							hasDescendantDirty={hasDirty}
						/>
						{isOpen && (
							<InstructionSetTree
								node={child}
								depth={depth + 1}
								selectedSetId={selectedSetId}
								isDirtyOf={isDirtyOf}
								externalEditTarget={externalEditTarget}
								onSelect={onSelect}
								expanded={expanded}
								toggleExpanded={toggleExpanded}
							/>
						)}
					</div>
				);
			})}
		</>
	);
}

// ─── Modal ──────────────────────────────────────────────────────────────────

function Modal({
	title,
	accent = "amber",
	onClose,
	actions,
	children,
}: {
	title: string;
	accent?: "amber" | "red";
	onClose: () => void;
	actions: React.ReactNode;
	children: React.ReactNode;
}) {
	return (
		<div className="ad-modal-backdrop" onClick={onClose}>
			<div
				className="ad-modal"
				data-accent={accent}
				onClick={(e) => e.stopPropagation()}
			>
				<div className="ad-modal-head">
					<Icon name="warning" size={14} />
					<span>{title}</span>
				</div>
				<div className="ad-modal-body">{children}</div>
				<div className="ad-modal-foot">{actions}</div>
			</div>
		</div>
	);
}

// ─── Main view ──────────────────────────────────────────────────────────────

export function AgentDocsView({
	projectName,
	projectPath,
	view,
	onChangeView,
	projectHarnesses,
	globalHarnesses = [],
	ownHarnesses = [],
}: Props) {
	const toast = useToast();
	const queryClient = useQueryClient();
	const allHarnesses = useHarnesses();
	const [showAllMarkdown, setShowAllMarkdown] = useState(false);
	const listing = useAgentDocsListing(projectPath, showAllMarkdown);

	const [selected, setSelected] = useState<string | null>(null);
	const [buffers, setBuffers] = useState<Record<string, Buffer>>({});
	const [loadingRel, setLoadingRel] = useState<string | null>(null);
	const [expanded, setExpanded] = useState<Record<string, boolean>>({});
	const [conflict, setConflict] = useState<Conflict | null>(null);
	const [pendingDiscard, setPendingDiscard] = useState<PendingDiscard>(null);
	const [externalEditTarget, setExternalEditTarget] = useState<string | null>(
		null,
	);
	const [editorMode, setEditorMode] = useState<"edit" | "preview">("edit");

	// Reset state when project changes.
	useEffect(() => {
		setSelected(null);
		setBuffers({});
		setLoadingRel(null);
		setExpanded({});
		setConflict(null);
		setPendingDiscard(null);
		setExternalEditTarget(null);
		setShowAllMarkdown(false);
	}, [projectPath]);

	const data = listing.data;

	// ── Default selection: first existing file, fallback CLAUDE.md ──
	useEffect(() => {
		if (!data) return;
		if (selected) return;
		const all = flattenFiles(data.root);
		const firstExisting = all.find((f) => f.exists && !f.error);
		const target = firstExisting?.rel ?? "CLAUDE.md";
		setSelected(target);
	}, [data, selected]);

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
	}, [data, selected, projectPath]);

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

	// ── Derived ──
	const allRels = data?.all_rels ?? [];
	const fileMap = useMemo(() => {
		if (!data) return new Map<string, AgentDocFile>();
		const m = new Map<string, AgentDocFile>();
		for (const f of flattenFiles(data.root)) m.set(f.rel, f);
		return m;
	}, [data]);

	const tokenSummary = useMemo(() => {
		const rootFiles = new Set(projectHarnesses.map((h) => harnessFile(h)));
		let upfront = 0;
		let discoverable = 0;
		for (const rel of allRels) {
			const file = fileMap.get(rel);
			if (!file?.exists) continue;
			const t = estimateTokensFromBytes(file.size ?? 0);
			if (rootFiles.has(rel as RootFile)) upfront += t;
			else discoverable += t;
		}
		return { upfront, discoverable };
	}, [allRels, fileMap, projectHarnesses]);

	// Pulse the upfront / discoverable cell when its value changes meaningfully
	// (≥50 tokens absolute or ≥10% relative). First-data-arrival is not a pulse.
	const tokenBaselineRef = useRef<{
		upfront: number;
		discoverable: number;
	} | null>(null);
	const [pulseUpfront, setPulseUpfront] = useState(false);
	const [pulseDisc, setPulseDisc] = useState(false);
	useEffect(() => {
		if (!data) return;
		const baseline = tokenBaselineRef.current;
		if (!baseline) {
			tokenBaselineRef.current = tokenSummary;
			return;
		}
		const isBig = (prev: number, curr: number) => {
			if (prev === curr) return false;
			const delta = Math.abs(curr - prev);
			if (delta >= 50) return true;
			const base = Math.max(prev, 1);
			return delta / base >= 0.1;
		};
		if (isBig(baseline.upfront, tokenSummary.upfront)) {
			setPulseUpfront(true);
			const t = setTimeout(() => setPulseUpfront(false), 1100);
			tokenBaselineRef.current = tokenSummary;
			return () => clearTimeout(t);
		}
		if (isBig(baseline.discoverable, tokenSummary.discoverable)) {
			setPulseDisc(true);
			const t = setTimeout(() => setPulseDisc(false), 1100);
			tokenBaselineRef.current = tokenSummary;
			return () => clearTimeout(t);
		}
		tokenBaselineRef.current = tokenSummary;
	}, [data, tokenSummary]);

	const isDirty = useCallback(
		(rel: string) => {
			const buf = buffers[rel];
			if (!buf) return false;
			return buf.content !== buf.baseline;
		},
		[buffers],
	);

	const anyDirty = useMemo(
		() => Object.values(buffers).some((b) => b.content !== b.baseline),
		[buffers],
	);

	// ── Layout verdicts — read straight from the scanner, never re-derived ──
	const policy = data?.policy ?? null;
	const instructionSets = showAllMarkdown ? [] : (data?.instruction_sets ?? []);
	const rootSet =
		instructionSets.find((s) => s.relative_dir === "") ?? null;
	const deviations = useMemo(
		() => instructionSets.filter(isDeviating),
		[instructionSets],
	);
	const allCanonical = instructionSets.length > 0 && deviations.length === 0;
	// The root pair folds into one unified row only when the scanner says the
	// layout is canonical (real AGENTS.md + derived CLAUDE.md).
	const unifyRootMode =
		!showAllMarkdown && policy?.derived && rootSet?.verdict === "canonical"
			? policy.strategy
			: null;

	// Per-harness display info
	const harnessRows = projectHarnesses
		.map((id) => {
			const meta = (allHarnesses ?? []).find((h) => h.id === id);
			return { id, label: meta?.label ?? id };
		})
		.filter((x) => x.id);

	const instructionSetTree = useMemo(
		() => buildInstructionSetTree(instructionSets),
		[instructionSets],
	);
	const selectedSet = selected
		? (instructionSets.find((set) =>
				(["CLAUDE", "AGENT"] as const).some(
					(format) => set.formats[format].file?.rel === selected,
				),
			) ?? null)
		: null;

	// Selected file derived state
	const selectedFile = selected ? (fileMap.get(selected) ?? null) : null;
	const selectedBuffer = selected ? buffers[selected] : undefined;
	const selectedTokenCount = useMemo(
		() => estimateTokens(selectedBuffer?.content ?? ""),
		[selectedBuffer?.content],
	);
	const selectedDirty = selected ? isDirty(selected) : false;
	const externallyChanged =
		externalEditTarget && externalEditTarget === selected ? true : false;

	const saveLabel = selectedBuffer?.isNew ? "Create" : "Save";
	const saveDisabled =
		!selectedBuffer || (!selectedDirty && !selectedBuffer.isNew);

	// ── Actions ──
	function selectFile(rel: string) {
		setSelected(rel);
	}

	function selectInstructionSet(set: AgentDocInstructionSet) {
		setSelected(editableRelForSet(set));
	}

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

	function toggleExpanded(path: string) {
		setExpanded((e) => ({ ...e, [path]: e[path] === false ? true : false }));
	}

	const doRefresh = useCallback(async () => {
		if (!selected) {
			await queryClient.invalidateQueries({
				queryKey: ["agent-docs", projectPath, showAllMarkdown],
			});
			toast.push({
				kind: "info",
				title: "Agent Docs refreshed from disk",
				body: projectPath,
			});
			return;
		}
		await queryClient.invalidateQueries({
			queryKey: ["agent-docs", projectPath, showAllMarkdown],
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
	}, [selected, projectPath, queryClient, toast, showAllMarkdown]);

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
			queryKey: ["agent-docs", projectPath, showAllMarkdown],
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
		} catch {
			// File may be momentarily unreadable (or replaced by a derived
			// pointer); drop the stale buffer so the next select reloads.
			setBuffers((b) => {
				const next = { ...b };
				delete next[selected];
				return next;
			});
		}
	}, [selected, projectPath, queryClient, showAllMarkdown]);

	async function performWrite(force: boolean) {
		if (!selected || !selectedBuffer) return;
		if (!selectedDirty && !selectedBuffer.isNew) return;
		try {
			const res = await writeAgentDoc({
				projectPath,
				relativePath: selected,
				content: selectedBuffer.content,
				expectedHash: selectedBuffer.loadedHash,
				overwrite: force,
			});
			const newBuffers = { ...buffers };
			for (const w of res.written) {
				if (w.is_symlink) continue; // derived pointer — no editable buffer
				newBuffers[w.rel] = {
					content: selectedBuffer.content,
					baseline: selectedBuffer.content,
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
			await queryClient.invalidateQueries({
				queryKey: ["agent-docs", projectPath, showAllMarkdown],
			});
			const names = res.written.map((w) => w.rel).join(" + ");
			toast.push({
				kind: "success",
				title: selectedBuffer.isNew ? `${names} created` : `${names} saved`,
				body: res.derived
					? `${primary?.rel} is the real root; CLAUDE.md follows it.`
					: `${projectPath}/${primary?.rel ?? selected}`,
			});
		} catch (err) {
			const body = parseAgentDocError(err);
			if (body?.kind === "conflict" && body.rel) {
				setConflict({
					rel: body.rel,
					currentHash: body.current_hash ?? "",
				});
				setExternalEditTarget(body.rel);
			} else {
				toastForError(body, String(err));
			}
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

	// ⌘S
	useEffect(() => {
		function onKey(e: KeyboardEvent) {
			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
				if (view !== "agent-docs") return;
				if (saveDisabled) {
					e.preventDefault();
					return;
				}
				e.preventDefault();
				save();
			}
		}
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [view, saveDisabled, selected, selectedBuffer?.content]);

	// ── Render ──
	const existingCount = allRels.filter((r) => fileMap.get(r)?.exists).length;
	const mapTitle = showAllMarkdown ? "Markdown files" : "Instruction map";
	const mapCount = showAllMarkdown
		? `${existingCount} files`
		: instructionSets.length > 0
			? `${instructionSets.length} sets`
			: `${existingCount}/${allRels.length}`;

	return (
		<>
			<ScreenHeader
				leading={<span className="project-dot" />}
				title={projectName}
				state={
					selectedDirty ? (
						<StatePill state="unsaved">UNSAVED</StatePill>
					) : null
				}
				crumbs={[
					<span className="crumb-path" key="path">
						<Icon name="folder" size={11} />
						<span className="path" title={projectPath}>
							{projectPath}
						</span>
					</span>,
				]}
				subline="Agent Docs · disk is source of truth"
				primary={
					<Button
						variant="primary"
						icon={selectedBuffer?.isNew ? "plus" : "check"}
						kbd="⌘S"
						disabled={saveDisabled}
						onClick={save}
						data-testid="agent-docs-save"
					>
						{saveLabel}
					</Button>
				}
				overflow={[
					{
						icon: "refresh",
						label: "Refresh from disk",
						onClick: refresh,
					},
					{
						icon: "folder",
						label: "Reveal in Finder",
						onClick: () => void revealItemInDir(projectPath),
					},
				]}
				subheader={{
					left: (
						<SubheaderViewChips<ProjectView>
							views={PROJECT_VIEWS}
							value={view}
							onChange={onChangeView}
						/>
					),
				}}
			/>

			{/* Status line — quiet when canonical */}
			<div className="agent-docs-strip">
				<HarnessAgentStrip
					projectName={projectName}
					globalHarnesses={globalHarnesses}
					projectHarnesses={ownHarnesses}
					effectiveHarnesses={harnessRows.map((h) => ({
						id: h.id,
						label: h.label,
					}))}
					policy={policy}
					allCanonical={allCanonical}
				/>
			</div>

			{/* The single conditional banner — renders only on deviation */}
			{policy && deviations.length > 0 && (
				<AgentDocsFixBanner
					projectName={projectName}
					projectPath={projectPath}
					policy={policy}
					deviations={deviations}
					anyDirty={anyDirty}
					onMutated={() => void reloadSelectedSilently()}
				/>
			)}

			{/* Body */}
			<ResizableSplit
				className="agent-docs-grid"
				storageKey="st:layout:agent-docs-map"
				defaultLeftPx={304}
				minLeftPx={220}
				maxLeftPx={600}
				handleAriaLabel="Resize Agent Docs map"
				paneLabel="Map"
				left={
				<aside className="agent-docs-map">
					<div className="agent-docs-map-head">
						<div className="agent-docs-eyebrow">
							<Icon name="doc" size={12} />
							<span>{mapTitle}</span>
							<span className="ad-count">{mapCount}</span>
						</div>
						<label className="agent-docs-md-toggle">
							<input
								type="checkbox"
								checked={showAllMarkdown}
								onChange={(e) => {
									setShowAllMarkdown(e.currentTarget.checked);
									setSelected(null);
									setExpanded({});
								}}
								data-testid="agent-docs-show-all-markdown"
							/>
							<span>Show all Markdown files</span>
						</label>
						<div className="agent-docs-tagline">
							{showAllMarkdown
								? "Browsing project-scoped .md files."
								: "Sync does not read or write these files."}
						</div>
						{data?.truncated && (
							<div
								className="agent-docs-tagline"
								style={{ color: "var(--amber)" }}
							>
								{data.warning ?? "Discovery truncated."}
							</div>
						)}
					</div>

					<div className="agent-docs-tree">
						<div className="ad-tree-root">
							<Icon name="folder" size={12} />
							<span className="ad-tree-projectname">{projectName}</span>
							<span className="ad-tree-slash">/</span>
						</div>

						{listing.isLoading && (
							<div
								className="agent-docs-tagline"
								style={{ padding: "10px 16px" }}
							>
								Loading…
							</div>
						)}
						{listing.error && (
							<div
								className="agent-docs-tagline"
								style={{
									padding: "10px 16px",
									color: "var(--red)",
								}}
							>
								Failed to load Agent Docs metadata.
							</div>
						)}
						{data && instructionSets.length > 0 ? (
							<div className="ad-instruction-set-list">
								<InstructionSetTree
									node={instructionSetTree}
									depth={0}
									selectedSetId={selectedSet?.id ?? null}
									isDirtyOf={isDirty}
									externalEditTarget={externalEditTarget}
									onSelect={selectInstructionSet}
									expanded={expanded}
									toggleExpanded={toggleExpanded}
								/>
							</div>
						) : data ? (
							<FileTree
								node={data.root}
								depth={0}
								unifyRootMode={unifyRootMode}
								selected={selected ?? ""}
								isDirtyOf={isDirty}
								externalEditTarget={externalEditTarget}
								onSelect={selectFile}
								expanded={expanded}
								toggleExpanded={toggleExpanded}
							/>
						) : null}
					</div>

					<div className="agent-docs-status">
						<div className="ad-status-title">STATUS</div>
						<div className="ad-status-row">
							<span>source</span>
							<span>disk</span>
						</div>
						<div className="ad-status-row">
							<span>last loaded</span>
							<span>
								{selectedBuffer
									? new Date(selectedBuffer.loadedAtTs).toLocaleTimeString([], {
											hour: "2-digit",
											minute: "2-digit",
											hour12: false,
										})
									: "—"}
							</span>
						</div>
						<div className="ad-status-row">
							<span>modified</span>
							<span>{fmtClockHM(selectedFile?.modified_at)}</span>
						</div>
						<div className="ad-status-row">
							<span>hash</span>
							<span>{selectedBuffer?.loadedHash ?? "—"}</span>
						</div>

						<div
							className="ad-status-sub"
							data-testid="agent-docs-token-summary"
							title={
								"Upfront = root CLAUDE.md / AGENTS.md loaded into every session.\n" +
								"Discoverable = nested docs the agent can read on demand.\n" +
								"Estimated from file size (~4 chars/token, ±10% across models)."
							}
						>
							context
						</div>
						<div className="ad-status-row ad-status-row--context">
							<span>upfront</span>
							<span
								className={
									"ad-ctx-val ad-ctx-val--upfront" +
									(pulseUpfront ? " is-pulsing" : "")
								}
							>
								{`~${formatTokens(tokenSummary.upfront)}`}
							</span>
						</div>
						<div className="ad-status-row ad-status-row--context">
							<span>discoverable</span>
							<span
								className={
									"ad-ctx-val ad-ctx-val--disc" +
									(pulseDisc ? " is-pulsing" : "")
								}
							>
								{`~${formatTokens(tokenSummary.discoverable)}`}
							</span>
						</div>
					</div>
				</aside>
				}
				right={
				<section className="agent-docs-editor">
					{selected && selectedBuffer && (
						<>
							<div className="agent-docs-doc-head">
								<div className="ad-doc-title">
									<Icon name="doc" size={14} />
									<span className="ad-doc-name">{selected}</span>
									{selectedDirty && (
										<span
											className="ad-pill"
											style={{
												color: "var(--amber)",
												background:
													"color-mix(in oklab, var(--amber) 14%, transparent)",
												borderColor:
													"color-mix(in oklab, var(--amber) 40%, transparent)",
											}}
										>
											UNSAVED
										</span>
									)}
									{selectedBuffer.isNew && !selectedDirty && (
										<span
											className="ad-pill"
											style={{
												color: "var(--fg-dim)",
												background: "transparent",
												borderColor: "var(--border-strong)",
											}}
										>
											NEW · NOT YET ON DISK
										</span>
									)}
									{externallyChanged && (
										<span
											className="ad-pill"
											style={{
												color: "var(--amber)",
												background:
													"color-mix(in oklab, var(--amber) 14%, transparent)",
												borderColor:
													"color-mix(in oklab, var(--amber) 40%, transparent)",
											}}
										>
											CHANGED ON DISK
										</span>
									)}
									<div className="ad-doc-mode">
										<Chips>
											<Chip
												icon="view.edit"
												pressed={editorMode === "edit"}
												onClick={() => setEditorMode("edit")}
											>
												Edit
											</Chip>
											<Chip
												icon="view.preview"
												pressed={editorMode === "preview"}
												onClick={() => setEditorMode("preview")}
											>
												Preview
											</Chip>
										</Chips>
									</div>
								</div>
								<div className="ad-doc-path">
									<Icon name="folder" size={11} />
									<span>
										{selectedFile?.absolute_path ??
											`${projectPath}/${selected}`}
									</span>
								</div>
							</div>

							{selectedSet && (
								<div className="agent-docs-banner ad-banner-instruction-set">
									<Icon name="info" size={12} />
									<span>
										<strong>{selectedSet.label}</strong>{" "}
										<span className="text-mono">
											{relDirLabel(selectedSet.relative_dir)}
										</span>
										{" · editing "}
										<span className="text-mono">{selected}</span>
										{selectedSet.verdict === "conflict" &&
											selectedSet.formats.CLAUDE.title &&
											selectedSet.formats.AGENT.title && (
												<>
													{" "}
													· independent titles:{" "}
													<span className="text-mono">CLAUDE</span> “
													{selectedSet.formats.CLAUDE.title}” /{" "}
													<span className="text-mono">AGENT</span> “
													{selectedSet.formats.AGENT.title}”
												</>
											)}
									</span>
								</div>
							)}

							{externallyChanged && (
								<div className="agent-docs-banner">
									<Icon name="warning" size={12} />
									<span>
										This file changed on disk after it was loaded. Refresh to
										pull the new content, or save to keep editing and resolve at
										write time.
									</span>
								</div>
							)}

							{selectedFile?.is_symlink &&
								selectedFile.symlink_target_in_project &&
								selected !== "CLAUDE.md" && (
									<div className="agent-docs-banner ad-banner-symlink">
										<Icon name="link" size={12} />
										<span>
											<strong>Symlink.</strong> {selectedFile.name} resolves to{" "}
											<span className="text-mono">
												{" "}
												{selectedFile.symlink_to ?? "unknown"}
											</span>
											. Editing happens on the source — open the target to make
											changes.
										</span>
										{selectedFile.symlink_to && (
											<Button
												size="sm"
												icon="arrow-right"
												onClick={() => {
													const target = selectedFile.symlink_to;
													if (!target) return;
													// Resolve in-project sibling: best effort
													const sibling = target.startsWith("/") ? null : target;
													if (sibling) selectFile(sibling);
												}}
											>
												Open source
											</Button>
										)}
									</div>
								)}

							<div className="agent-docs-editor-body">
								{loadingRel === selected ? (
									<div
										style={{
											flex: 1,
											padding: 24,
											color: "var(--fg-mute)",
											fontFamily: "var(--font-mono)",
											fontSize: 11.5,
										}}
									>
										Reading {selected} from disk…
									</div>
								) : selectedFile?.is_symlink &&
									!selectedFile.symlink_target_in_project ? (
									<div className="agent-docs-symlink-stub">
										<Icon name="link" size={28} />
										<h4>Symlink to {selectedFile.symlink_to ?? "unknown"}</h4>
										<p>
											This file is a symbolic link that points outside the
											project. Editing is disabled here.
										</p>
									</div>
								) : !showAllMarkdown &&
									selected === "CLAUDE.md" &&
									selectedBuffer.isDerivedPointer ? (
					<div className="agent-docs-symlink-stub ad-derived-stub">
										<Icon name="link" size={28} />
										<h4>
											Derived from <span className="text-mono">AGENTS.md</span>
										</h4>
										<p>
											This <span className="text-mono">CLAUDE.md</span> is a
											hub-derived{" "}
											{selectedFile?.is_symlink ? "symlink" : "@AGENTS.md pointer"}
											. Edit{" "}
											<span className="text-mono">AGENTS.md</span> — this file
											follows automatically.
										</p>
										<Button
											size="sm"
											icon="arrow-right"
											onClick={() => selectFile("AGENTS.md")}
										>
											Open AGENTS.md
										</Button>
									</div>
								) : selectedBuffer.isNew ? (
									<div className="agent-docs-empty-create">
										<div className="ad-empty-row">
											<span className="ad-empty-icon">
												<Icon name="doc" size={18} />
											</span>
											<div>
												<h4>{selected} doesn't exist yet</h4>
												<p>
													Start typing to draft this file.{" "}
													<strong>Create</strong> writes it to{" "}
													<span className="text-mono">
														{selectedFile?.absolute_path ??
															`${projectPath}/${selected}`}
													</span>
													{!showAllMarkdown &&
													policy?.derived &&
													(selected === "CLAUDE.md" ||
														selected === "AGENTS.md") ? (
														<>
															{" "}
															— as the canonical{" "}
															<span className="text-mono">AGENTS.md</span> with
															a derived{" "}
															<span className="text-mono">CLAUDE.md</span> (
															{policy.strategy}).
														</>
													) : (
														"."
													)}
												</p>
											</div>
										</div>
										{editorMode === "preview" ? (
											<CodeAreaPreview content={selectedBuffer.content} />
										) : (
											<CodeAreaEdit
												content={selectedBuffer.content}
												onChange={editBuf}
											/>
										)}
									</div>
								) : editorMode === "preview" ? (
									<CodeAreaPreview content={selectedBuffer.content} />
								) : (
									<CodeAreaEdit
										content={selectedBuffer.content}
										onChange={editBuf}
									/>
								)}
							</div>

							{/* Snippet blocks live at the end of the file, so the strip
							    sits below the freeform content it appends to. */}
							{selected &&
								!showAllMarkdown &&
				selectedFile?.exists &&
								!selectedFile.is_symlink &&
								!selectedBuffer.isDerivedPointer &&
								!selectedBuffer.isNew && (
									<AppliedSnippetsStrip
										projectName={projectName}
										rel={selected}
										dirty={selectedDirty}
										onMutate={() => void reloadSelectedSilently()}
									/>
								)}

							<div className="editor-foot">
								<span>
									<Icon name="doc" size={10} /> markdown
								</span>
								<span title="Estimate based on the GPT-5 / o200k_base tokenizer. Claude/Gemini typically within ±10%.">
									{selectedBuffer.content.split("\n").length} lines ·{" "}
									{selectedBuffer.content.length} chars · ~
									{formatTokens(selectedTokenCount)} tokens
								</span>
								<span className="editor-foot-spacer" />
								<span>UTF-8 · LF</span>
								<span>
									{selectedBuffer.isNew
										? "unsaved draft"
										: selectedDirty
											? "in-memory buffer differs from disk"
											: "matches disk"}
								</span>
							</div>
						</>
					)}
				</section>
				}
			/>

			{pendingDiscard && (
				<Modal
					title="Discard unsaved edits?"
					accent="amber"
					onClose={() => setPendingDiscard(null)}
					actions={
						<>
							<Button onClick={() => setPendingDiscard(null)}>Cancel</Button>
							<Button
								variant="primary"
								onClick={() => {
									const fn = pendingDiscard;
									setPendingDiscard(null);
									fn?.();
								}}
							>
								Discard & reload
							</Button>
						</>
					}
				>
					<p>
						<span className="text-mono">{selected}</span> has unsaved changes in
						the editor buffer. Reloading from disk will overwrite the buffer
						with the on-disk version.
					</p>
				</Modal>
			)}

			{conflict && (
				<Modal
					title={`${conflict.rel} changed on disk`}
					accent="red"
					onClose={() => setConflict(null)}
					actions={
						<>
							<Button onClick={() => setConflict(null)}>Cancel</Button>
							<Button onClick={reloadAfterConflict}>Reload from disk</Button>
							<Button variant="primary" onClick={overwriteAfterConflict}>
								Overwrite with my edits
							</Button>
						</>
					}
				>
					<p>
						This file was modified outside Skill Tree since you loaded it.
						Saving now would overwrite those changes.
					</p>
					<div className="agent-docs-conflict-grid">
						<div>
							<div className="ad-c-label">YOUR BUFFER</div>
							<div className="ad-c-meta">
								loaded{" "}
								{selectedBuffer
									? new Date(selectedBuffer.loadedAtTs).toLocaleTimeString([], {
											hour: "2-digit",
											minute: "2-digit",
											hour12: false,
										})
									: "—"}{" "}
								· hash {selectedBuffer?.loadedHash ?? "—"}
							</div>
						</div>
						<div>
							<div className="ad-c-label">DISK NOW</div>
							<div className="ad-c-meta">
								modified just now · hash {conflict.currentHash.slice(0, 8)}
							</div>
						</div>
					</div>
				</Modal>
			)}
		</>
	);
}
