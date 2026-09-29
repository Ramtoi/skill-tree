import { type CSSProperties } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/Button";
import { SearchInput } from "@/components/SearchInput";
import { Toggle } from "@/components/Toggle";
import type { AgentDocFile, AgentDocInstructionSet } from "@/types/agentDocs";
import type { AgentDocMapNode } from "@/lib/agentDocMap";
import type { useAgentDocsListing } from "@/hooks/useAgentDocs";
import { formatTokens } from "@/lib/estimateTokens";
import { fmtClockHM } from "./agentDocHelpers";
import { MapTree } from "./MapTree";
import type { Buffer } from "@/components/AgentDocsView";

export interface AgentDocsMapPaneProps {
	mapTitle: string;
	mapCount: string;
	filter: string;
	onSetFilter: (v: string) => void;
	showAllMarkdown: boolean;
	onChangeBrowseMode: (next: boolean) => void;
	data: ReturnType<typeof useAgentDocsListing>["data"];
	onSetIncludeIgnored: (v: boolean) => void;
	includeIgnored: boolean;
	projectName: string;
	listing: ReturnType<typeof useAgentDocsListing>;
	instructionSets: AgentDocInstructionSet[];
	mapTree: AgentDocMapNode;
	unifyRootMode: "symlink" | "import" | null;
	selected: string | null;
	selectedSet: AgentDocInstructionSet | null;
	dirtyRels: Set<string>;
	dirtyDirs: Set<string>;
	externalEditTarget: string | null;
	onSelectFile: (rel: string) => void;
	onSelectSet: (set: AgentDocInstructionSet) => void;
	toggleExpanded: (path: string, currentlyOpen: boolean) => void;
	isNodeOpen: (path: string) => boolean;
	match: { rels: Set<string>; dirs: Set<string> } | null;
	visibleExternalImports: AgentDocFile[];
	query: string;
	hiddenMatchCount: number;
	otherListing: ReturnType<typeof useAgentDocsListing>;
	hasVisibleMatch: boolean;
	selectedBuffer: Buffer | undefined;
	selectedFile: AgentDocFile | null;
	pulseUpfront: boolean;
	tokenSummary: { upfront: number; discoverable: number } | null;
	tokenUnavailable: boolean;
	pulseDisc: boolean;
}

/** The Agent Docs screen's left (map) pane: the header eyebrow + filter +
 *  browse-mode toggle, the file tree, the external-imports group and the
 *  filter-empty notes, and the STATUS card. Extracted verbatim from
 *  AgentDocsView's `left=` ResizableSplit prop. */
export function AgentDocsMapPane({
	mapTitle,
	mapCount,
	filter,
	onSetFilter,
	showAllMarkdown,
	onChangeBrowseMode,
	data,
	onSetIncludeIgnored,
	includeIgnored,
	projectName,
	listing,
	instructionSets,
	mapTree,
	unifyRootMode,
	selected,
	selectedSet,
	dirtyRels,
	dirtyDirs,
	externalEditTarget,
	onSelectFile,
	onSelectSet,
	toggleExpanded,
	isNodeOpen,
	match,
	visibleExternalImports,
	query,
	hiddenMatchCount,
	otherListing,
	hasVisibleMatch,
	selectedBuffer,
	selectedFile,
	pulseUpfront,
	tokenSummary,
	tokenUnavailable,
	pulseDisc,
}: AgentDocsMapPaneProps) {
	return (
		<aside className="agent-docs-map">
			<div className="agent-docs-map-head">
				<div className="agent-docs-eyebrow">
					<Icon name="doc" size={12} />
					<span>{mapTitle}</span>
					<span className="ad-count">{mapCount}</span>
				</div>
				<SearchInput
					className="agent-docs-filter"
					value={filter}
					onChange={onSetFilter}
					placeholder="Filter by path…"
					screenSearch
					leadingIconSize={12}
				/>
				<div className="agent-docs-md-toggle">
					<Toggle
						size="sm"
						checked={showAllMarkdown}
						onChange={onChangeBrowseMode}
						label="Show all Markdown files"
						dataTestid="agent-docs-show-all-markdown"
					/>
				</div>
				<div className="agent-docs-tagline">
					{showAllMarkdown
						? "Browsing project-scoped .md files."
						: "Sync does not read or write these files."}
				</div>
				{showAllMarkdown && (data?.ignored_count ?? 0) > 0 && (
					<div
						className="agent-docs-tagline agent-docs-withheld"
						data-testid="agent-docs-withheld"
					>
						<span>
							{data?.ignored_count} hidden by this project&rsquo;s ignore
							rules.
						</span>
						<Button
							variant="ghost"
							onClick={() => onSetIncludeIgnored(true)}
							data-testid="agent-docs-include-ignored"
						>
							Include them
						</Button>
					</div>
				)}
				{showAllMarkdown && includeIgnored && (
					<div
						className="agent-docs-tagline agent-docs-withheld"
						data-testid="agent-docs-ignored-included"
					>
						<span>Including ignored files.</span>
						<Button
							variant="ghost"
							onClick={() => onSetIncludeIgnored(false)}
						>
							Respect ignore rules
						</Button>
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
				{data && (
					<div
						className={
							instructionSets.length > 0
								? "ad-instruction-set-list"
								: undefined
						}
					>
						<MapTree
							node={mapTree}
							depth={0}
							unifyRootMode={unifyRootMode}
							selected={selected ?? ""}
							selectedSetId={selectedSet?.id ?? null}
							dirtyRels={dirtyRels}
							dirtyDirs={dirtyDirs}
							externalEditTarget={externalEditTarget}
							onSelectFile={onSelectFile}
							onSelectSet={onSelectSet}
							toggleExpanded={toggleExpanded}
							isNodeOpen={isNodeOpen}
							match={match}
						/>
					</div>
				)}
				{data && visibleExternalImports.length > 0 && !showAllMarkdown && (
					<div
						className="agent-docs-external-imports"
						data-testid="agent-docs-external-imports"
					>
						<div className="ad-external-head">
							Imported from outside the project
						</div>
						{visibleExternalImports.map((f) => (
							<button
								key={`x:${f.absolute_path}`}
								type="button"
								className="ad-file ad-file-external"
								data-depth={1}
								style={{ ["--ad-depth" as string]: 1 } as CSSProperties}
								title={`${f.absolute_path}\nImported by ${(f.imported_by ?? []).join(", ")}\nOutside the project — revealed in Finder, never edited here.`}
								onClick={() => void revealItemInDir(f.absolute_path)}
							>
								<span className="ad-file-dot" />
								<Icon name="link" size={11} className="ad-file-icon" />
								<span className="ad-file-name">{f.name}</span>
								<span className="ad-pill ad-pill-import" data-class="external">
									EXTERNAL
								</span>
								<span className="ad-file-size">reveal</span>
							</button>
						))}
					</div>
				)}
				{data && query && hiddenMatchCount > 0 && (
					<div
						className="agent-docs-filter-note"
						data-testid="agent-docs-hidden-matches"
					>
						<span>
							{hiddenMatchCount}{" "}
							{hiddenMatchCount === 1 ? "match" : "matches"} in{" "}
							{showAllMarkdown
								? "the instruction map"
								: "all Markdown files"}
							.
						</span>
						<Button
							variant="ghost"
							onClick={() => onChangeBrowseMode(!showAllMarkdown)}
							data-testid="agent-docs-show-hidden-matches"
						>
							{showAllMarkdown ? "Show instruction map" : "Show them"}
						</Button>
					</div>
				)}
				{data &&
					query &&
					!hasVisibleMatch &&
					hiddenMatchCount === 0 &&
					(otherListing.isLoading || otherListing.isFetching ? (
						<div className="agent-docs-filter-note">
							<span>Searching the other view…</span>
						</div>
					) : (
						<div
							className="agent-docs-filter-note"
							data-testid="agent-docs-filter-empty"
						>
							<span>No file matches “{filter.trim()}”.</span>
						</div>
					))}
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
						{tokenUnavailable ? "token count unavailable" : tokenSummary ? `~${formatTokens(tokenSummary.upfront)}` : "…"}
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
						{tokenUnavailable ? "token count unavailable" : tokenSummary ? `~${formatTokens(tokenSummary.discoverable)}` : "…"}
					</span>
				</div>
			</div>
		</aside>
	);
}
