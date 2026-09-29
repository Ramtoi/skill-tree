import { useMemo, useState, type ReactNode } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Icon } from "@/components/Icon";
import { SearchInput } from "@/components/SearchInput";
import { OverflowMenu } from "@/components/OverflowMenu";
import { SidePanelSection } from "@/components/SidePanelSection";
import { useListNav } from "@/hooks/useListNav";
import { fmtSize } from "@/components/agentDocs/agentDocHelpers";
import { fmtTimestamp } from "@/screens/sources/sourceFormat";
import {
	FILTER_THRESHOLD,
	SKILL_MD,
	buildSkillFileTree,
	skillFileIcon,
	skillFileKindAttr,
	type SkillFileNode,
} from "@/lib/skillFileTree";
import type { SkillFileList } from "@/lib/skillFiles";

export interface SkillFilesSectionProps {
	listing: SkillFileList | undefined;
	loading: boolean;
	error: unknown;
	activeRel: string;
	onSelect: (rel: string) => void;
	dirtyRels: Set<string>;
	missingRels: Set<string>;
	/** Source-managed skills list in full and open read-only; they just have no
	 *  write affordances (the banner and the READ-ONLY pill already say why). */
	readOnly: boolean;
	onAddFile: () => void;
	storageKey: string;
	/** Set for a dropped-upstream skill: the checkout no longer has anything to
	 *  list, so this section skips the listing entirely and shows one honest
	 *  line instead of the generic "could not list" error. */
	dropped?: { refShort: string | null; lastSeenAt: string | null };
}

function rowState(
	rel: string,
	dirtyRels: Set<string>,
	missingRels: Set<string>,
	node: SkillFileNode,
): string {
	if (missingRels.has(rel)) return "missing";
	if (dirtyRels.has(rel)) return "dirty";
	if (node.entry.reason === "symlink_outside") return "error";
	return "ok";
}

/**
 * The FILES navigator — first section of the skill editor's side panel, because
 * reaching a sibling file is the highest-frequency navigation job in the editor
 * and had no interface at all before this.
 *
 * Flat list with one folder-grouping level (the live corpus is 71 root files,
 * 55 at depth 1 and zero deeper — a recursive tree is unearned), `SKILL.md`
 * pinned first and never filtered out, and a filter that appears past 8 rows,
 * matching the navigator's rule.
 */
export function SkillFilesSection({
	listing,
	loading,
	error,
	activeRel,
	onSelect,
	dirtyRels,
	missingRels,
	readOnly,
	onAddFile,
	storageKey,
	dropped,
}: SkillFilesSectionProps) {
	const [filter, setFilter] = useState("");
	const entries = useMemo(() => listing?.files ?? [], [listing]);
	const tree = useMemo(
		() => buildSkillFileTree(entries, filter),
		[entries, filter],
	);
	const root = listing?.root ?? "";

	const unsaved = dirtyRels.size;
	const showFilter = entries.length > FILTER_THRESHOLD;

	const nav = useListNav({
		count: tree.order.length,
		onOpen: (i) => {
			const node = tree.order[i];
			if (node) onSelect(node.rel);
		},
	});

	function renderRow(node: SkillFileNode, index: number) {
		const { rel, entry } = node;
		const active = rel === activeRel;
		const state = rowState(rel, dirtyRels, missingRels, node);
		const missing = state === "missing";
		return (
			// `presentation`: the wrapper only exists to hang the hover menu off
			// the row — the listbox owns the OPTION inside it, not this div.
			<div className="sf-file-wrap" role="presentation" key={rel}>
				<button
					type="button"
					// The row is an option of the `.sf-list` listbox below
					// (`aria-selected` + the roving tabindex arrive with
					// `nav.itemProps`); `aria-current` marks the file the editor is
					// actually showing, which is not the same thing as the row the
					// keyboard is on.
					role="option"
					className="sf-file"
					data-testid="skill-file-row"
					data-rel={rel}
					data-state={state}
					data-kind={skillFileKindAttr(entry.kind, entry.reason)}
					aria-current={active ? "true" : undefined}
					title={root ? `${rel}\n${root}/${rel}` : rel}
					onClick={() => {
						nav.setActiveIndex(index);
						onSelect(rel);
					}}
					{...nav.itemProps(index)}
					// Same value `itemProps` spreads in, stated literally: `option`
					// requires `aria-selected`, and a lint (or a reader) cannot see
					// it through a spread.
					aria-selected={index === nav.activeIndex}
				>
					<span className="sf-file-dot" aria-hidden="true" />
					<Icon
						name={skillFileIcon(entry.kind, entry.reason)}
						size={11}
						className="sf-file-icon"
					/>
					<span className="sf-file-name">
						{node.dimPrefix && (
							<span className="sf-file-dim">{node.dimPrefix}</span>
						)}
						{node.label}
					</span>
					{dirtyRels.has(rel) && <span className="sf-file-flag">UNSAVED</span>}
					<span className="sf-file-size">
						{missing ? "—" : fmtSize(entry.size)}
					</span>
				</button>
				{/* Sibling of the option, never a child of it: a button inside a
				    button is invalid, and the roving-tabindex model has no seat
				    for a second stop inside a row. */}
				<span className="sf-file-more" role="presentation">
					<OverflowMenu
						label={`Actions for ${rel}`}
						items={[
							{
								icon: "folder",
								label: "Reveal in Finder",
								disabled: !root,
								onClick: () => {
									if (root) void revealItemInDir(`${root}/${rel}`);
								},
							},
						]}
					/>
				</span>
			</div>
		);
	}

	let body: ReactNode;
	if (dropped) {
		// The checkout never had anything to list for this ref — a generic
		// "could not list" error would read as a bug rather than the honest
		// state it is.
		body = (
			<p className="sf-note" data-testid="skill-files-dropped">
				<Icon name="warning" size={11} />
				<span>
					Files were dropped upstream at{" "}
					<span className="text-mono">{dropped.refShort ?? "—"}</span>
					{dropped.lastSeenAt ? ` · ${fmtTimestamp(dropped.lastSeenAt)}` : ""}
				</span>
			</p>
		);
	} else if (error) {
		body = (
			<p className="sf-note" role="alert">
				<Icon name="warning" size={11} />
				<span>Could not list this skill's files.</span>
			</p>
		);
	} else if (loading && entries.length === 0) {
		body = <p className="sf-note">Reading the skill folder…</p>;
	} else {
		let index = -1;
		body = (
			<>
				{showFilter && (
					<SearchInput
						className="sf-filter"
						value={filter}
						onChange={setFilter}
						placeholder="filter files"
						inputTestId="skill-files-filter"
						onKeyDown={(e) => {
							if (e.key === "Escape") {
								e.preventDefault();
								setFilter("");
							}
						}}
					/>
				)}
				<div className="sf-list" aria-label="Skill files" {...nav.containerProps}>
					{tree.pinned && renderRow(tree.pinned, ++index)}
					{tree.root.map((node) => renderRow(node, ++index))}
					{tree.groups.map((group) => (
						// `group` is the one non-option element a listbox may own; the
						// visible heading is its label, so it is hidden from AT rather
						// than announced twice.
						<div
							className="sf-group-block"
							role="group"
							aria-label={group.dir}
							key={group.dir}
						>
							<div className="sf-group" aria-hidden="true">
								<Icon name="folder" size={11} />
								<span className="sf-group-name">{group.dir}</span>
							</div>
							{group.files.map((node) => renderRow(node, ++index))}
						</div>
					))}
				</div>
				{listing?.truncated && (
					<p className="sf-note">
						<Icon name="warning" size={11} />
						<span>Listing stopped at the file cap — some files are hidden.</span>
					</p>
				)}
				{!readOnly && (
					<button
						type="button"
						className="sf-add"
						data-testid="skill-files-add"
						onClick={onAddFile}
					>
						<Icon name="plus" size={11} />
						<span>Add file</span>
					</button>
				)}
			</>
		);
	}

	return (
		<SidePanelSection
			id="files"
			title="Files"
			count={entries.length || undefined}
			defaultOpen
			storageKey={storageKey}
			summary={
				unsaved > 0 ? (
					<span className="sf-unsaved">{unsaved} unsaved</span>
				) : undefined
			}
		>
			<div data-testid="skill-files" data-active-rel={activeRel || SKILL_MD}>
				{body}
			</div>
		</SidePanelSection>
	);
}
