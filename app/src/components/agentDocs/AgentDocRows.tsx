import { memo, type CSSProperties } from "react";
import { Icon } from "@/components/Icon";
import { AGENT_DOC_BASENAMES } from "@/lib/agentDocMap";
import type { AgentDocFile, AgentDocInstructionSet } from "@/types/agentDocs";
import { fmtSize, relDirLabel, setBadges } from "./agentDocHelpers";

// ─── File row ───────────────────────────────────────────────────────────────

/** Legacy singular filename — never satisfied-by, matches the Rust
 *  `LEGACY_BASENAME` in `agent_docs.rs`. Collapsed rows in the default
 *  instruction map already flag this via the `legacy` set flag; the flat
 *  all-Markdown view has no such grouping, so the file row itself must
 *  carry the same signal or a legacy `AGENT.md` looks like an unexplained
 *  duplicate of `AGENTS.md`. */
export const LEGACY_BASENAME = "AGENT.md";

export function pillFor(
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

export const FileRow = memo(function FileRow({
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
	onSelect: (rel: string) => void;
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
	const isLegacy = file.name === LEGACY_BASENAME;
	const isAgentDoc = AGENT_DOC_BASENAMES.has(file.name);
	const importers = file.imported_by ?? [];
	const unresolved = file.unresolved_imports ?? [];
	return (
		<button
			type="button"
			className="ad-file"
			data-depth={depth}
			data-state={state}
			data-symlink={file.is_symlink || undefined}
			data-agent-doc={isAgentDoc || undefined}
			style={{ ["--ad-depth" as string]: depth } as CSSProperties}
			aria-current={selected ? "true" : undefined}
			onClick={() => onSelect(file.rel)}
			title={file.absolute_path}
		>
			<span className="ad-file-dot" />
			<Icon
				name={file.is_symlink ? "link" : "doc"}
				size={11}
				className="ad-file-icon"
			/>
			<span className="ad-file-name">{file.name}</span>
			{file.is_import && (
				<span
					className="ad-pill ad-pill-import"
					data-class={file.import_class ?? undefined}
					title={
						(importers.length
							? `Imported by ${importers.join(", ")}`
							: "Reached through the @ import graph") +
						(file.import_class === "beyond_depth"
							? " — past the four-hop import limit, so it is NOT loaded"
							: "") +
						(file.import_unreachable
							? " — @ imports are Claude Code's; this project's harnesses do not load it"
							: "")
					}
				>
					{file.import_class === "beyond_depth" ? "NOT LOADED" : "IMPORTED"}
				</span>
			)}
			{file.is_non_markdown && (
				<span className="ad-pill ad-pill-deviation" data-tone="info">
					READ-ONLY
				</span>
			)}
			{file.import_unreachable && file.is_import && (
				<Icon
					name="warning"
					size={9}
					tone="amber"
					title="This project's harnesses do not read @ imports"
					className="ad-file-warn"
				/>
			)}
			{unresolved.length > 0 && (
				<Icon
					name="warning"
					size={9}
					tone="amber"
					title={`Unresolved import${unresolved.length > 1 ? "s" : ""}: ${unresolved.join(", ")}`}
					className="ad-file-warn"
				/>
			)}
			{isLegacy ? (
				<span className="ad-pill ad-pill-deviation" data-tone="warn">
					LEGACY
				</span>
			) : (
				isAgentDoc && (
					<span className="ad-pill ad-pill-deviation" data-tone="info">
						AGENT DOC
					</span>
				)
			)}
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
			{/* Pending is NOT absent. A row that reported `absent` for a file
			    that exists would open the create-new draft over it. */}
			{file.exists && file.size == null ? (
				<span
					className="ad-file-size ad-file-size--pending"
					title="Size not resolved yet"
				>
					…
				</span>
			) : (
				<span className="ad-file-size">
					{file.exists ? fmtSize(file.size) : "absent"}
				</span>
			)}
		</button>
	);
});

export const UnifiedFileRow = memo(function UnifiedFileRow({
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
	onSelect: (rel: string) => void;
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
			onClick={() => onSelect(primary.rel)}
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
});

export const FolderRow = memo(function FolderRow({
	name,
	path,
	depth,
	expanded,
	onToggle,
	allMissing,
	isKnown,
	hasDescendantDirty,
	hasContentHint,
}: {
	name: string;
	path: string;
	depth: number;
	expanded: boolean;
	onToggle: (path: string, currentlyOpen: boolean) => void;
	allMissing: boolean;
	isKnown: boolean;
	hasDescendantDirty: boolean;
	/** Something below is worth expanding for IN THE MODE ON SCREEN — an
	 *  instruction set or imported doc by default, any listed markdown while
	 *  browsing. Wiring this to agent basenames in both modes is what made the
	 *  hint stay dark over a folder holding the file the user was looking for. */
	hasContentHint?: boolean;
}) {
	return (
		<button
			type="button"
			className="ad-folder"
			data-depth={depth}
			data-known={isKnown || undefined}
			data-empty={allMissing || undefined}
			style={{ ["--ad-depth" as string]: depth } as CSSProperties}
			onClick={() => onToggle(path, expanded)}
		>
			<Icon
				name={expanded ? "chevronDown" : "chevronRight"}
				size={10}
				className="ad-folder-chevron"
			/>
			<Icon name="folder" size={11} className="ad-folder-icon" />
			<span className="ad-folder-name">{name}/</span>
			{hasContentHint && !expanded && (
				<Icon
					name="doc"
					size={9}
					tone="blue"
					title="Contains files relevant to this view"
					className="ad-folder-agent-doc-hint"
				/>
			)}
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
});

export const InstructionSetRow = memo(function InstructionSetRow({
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
	onSelect: (set: AgentDocInstructionSet) => void;
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
			onClick={() => onSelect(set)}
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
});
