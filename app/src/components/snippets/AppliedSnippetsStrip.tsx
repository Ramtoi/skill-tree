import { useMemo, useState } from "react";
import { Button } from "@/components/Button";
import { Icon } from "@/components/Icon";
import { useToast } from "@/components/Toast";
import { useUndoableAction } from "@/hooks/useUndoableAction";
import {
	applySnippet,
	removeSnippet,
	updateSnippet,
	useInvalidateSnippets,
	useSnippetScan,
	useSnippets,
} from "@/hooks/useSnippets";
import { AddSnippetPopover } from "./AddSnippetPopover";
import { ConfirmDialog } from "@/components/Modal";
import { SnippetStatusBadge } from "./SnippetStatusBadge";

export interface AppliedSnippetsStripProps {
	/** Registered project name (snippet targets are project-scoped). */
	projectName: string;
	/** Project-relative path of the file open in the editor. */
	rel: string;
	/** Editor buffer differs from disk — all snippet actions are blocked. */
	dirty: boolean;
	/** Called after a disk write so the editor reloads its buffer. */
	onMutate: () => void;
}

/** Per-file "applied snippets" section, subordinate to the Agent Docs editor.
 *  Lists the marker blocks the scan finds in the selected file plus damaged
 *  (unpaired) markers, with Remove/Update per block and an Add-snippet picker.
 *  Mutations rewrite the file on disk, so the strip is blocked while the
 *  editor buffer is dirty. */
export function AppliedSnippetsStrip({
	projectName,
	rel,
	dirty,
	onMutate,
}: AppliedSnippetsStripProps) {
	const [collapsed, setCollapsed] = useState(false);
	const [pickerOpen, setPickerOpen] = useState(false);
	const [confirm, setConfirm] = useState<{
		kind: "remove" | "update";
		name: string;
	} | null>(null);

	const toast = useToast();
	const runUndoable = useUndoableAction();
	const invalidate = useInvalidateSnippets();
	const { data: scan } = useSnippetScan({ project: projectName });
	const { data: lib = [] } = useSnippets();

	const blocks = useMemo(
		() => (scan?.locations ?? []).filter((l) => l.rel === rel),
		[scan, rel],
	);
	const damaged = useMemo(
		() => (scan?.damaged ?? []).filter((d) => d.rel === rel),
		[scan, rel],
	);
	const presentNames = blocks.map((b) => b.snippet);
	const total = blocks.length + damaged.length;

	function afterMutate() {
		invalidate();
		onMutate();
	}

	async function applyPick(name: string) {
		setPickerOpen(false);
		try {
			await applySnippet({ name, project: projectName, relativePath: rel });
			toast.success(`Applied ${name}`, `${rel} · appended`);
			afterMutate();
		} catch (err) {
			toast.error(`Apply failed`, String(err));
		}
	}
	async function doRemove(name: string, force = false) {
		// A modified block's remove is destructive (discards in-file edits) — it
		// keeps its ConfirmDialog and is NOT undoable (re-apply would restore the
		// library version, not the hand-edited content). A plain remove is a
		// reversible edge: undo re-applies the block (D4/D5).
		if (force) {
			try {
				await removeSnippet({ name, project: projectName, relativePath: rel, force });
				toast.info(`Removed ${name}`, `${rel} · block excised`);
				afterMutate();
			} catch (err) {
				toast.error(`Remove failed`, String(err));
			}
			return;
		}
		try {
			await runUndoable({
				do: async () => {
					await removeSnippet({ name, project: projectName, relativePath: rel });
					afterMutate();
				},
				undo: async () => {
					await applySnippet({ name, project: projectName, relativePath: rel });
					afterMutate();
				},
				label: `Removed ${name}`,
				invalidate: [["registry"], ["snippets"]],
			});
		} catch (err) {
			toast.error(`Remove failed`, String(err));
		}
	}
	async function doUpdate(name: string, force = false) {
		const v = lib.find((s) => s.name === name)?.version;
		try {
			await updateSnippet({ name, project: projectName, relativePath: rel, force });
			toast.success(`Updated ${name}`, `${rel} · now v${v ?? "?"}`);
			afterMutate();
		} catch (err) {
			toast.error(`Update failed`, String(err));
		}
	}

	return (
		<div
			className="snip-strip"
			data-blocked={dirty || undefined}
			data-collapsed={collapsed || undefined}
		>
			<div className="snip-strip-head">
				<button
					type="button"
					className="snip-strip-toggle"
					onClick={() => setCollapsed((c) => !c)}
				>
					<Icon name={collapsed ? "chevronRight" : "chevronDown"} size={11} />
					<Icon name="snippet" size={12} />
					<span className="snip-strip-title">Applied snippets</span>
					<span className="snip-strip-count">{blocks.length}</span>
					{damaged.length > 0 && (
						<span className="snip-strip-damaged-count" title="damaged marker">
							<Icon name="warning" size={10} /> {damaged.length}
						</span>
					)}
				</button>
				<div className="snip-strip-head-right">
					{dirty ? (
						<span className="snip-strip-blocked-pill">
							<Icon name="warning" size={10} /> save to manage
						</span>
					) : (
						<div className="snip-strip-add-wrap">
							<Button size="sm" icon="plus" onClick={() => setPickerOpen((o) => !o)}>
								Add snippet
							</Button>
							{pickerOpen && (
								<AddSnippetPopover
									excludeNames={presentNames}
									onPick={applyPick}
									onClose={() => setPickerOpen(false)}
									anchorClass="snip-picker-strip"
								/>
							)}
						</div>
					)}
				</div>
			</div>

			{!collapsed && (
				<div className="snip-strip-body">
					{dirty && (
						<div className="snip-strip-blocked">
							<Icon name="warning" size={12} />
							<span>
								This file has unsaved edits. <strong>Save or discard</strong> them
								before adding, updating, or removing snippets — those actions
								rewrite the file.
							</span>
						</div>
					)}

					{total === 0 && !dirty && (
						<div className="snip-strip-empty">
							No snippets in this file yet.{" "}
							<button
								type="button"
								className="link-btn"
								onClick={() => setPickerOpen(true)}
							>
								Add one
							</button>{" "}
							to append a reusable instruction block.
						</div>
					)}

					{(blocks.length > 0 || damaged.length > 0) && (
						<div className="snip-strip-list">
							{blocks.map((b, i) => (
								<div
									key={b.snippet + i}
									className="snip-strip-row"
									data-status={b.status}
								>
									<span className="snip-strip-row-name">{b.snippet}</span>
									<SnippetStatusBadge status={b.status} />
									<span className="snip-strip-row-spacer" />
									<div className="snip-strip-row-actions">
										{(b.status === "outdated" || b.status === "modified") && (
											<Button
												size="sm"
												icon="state.update"
												disabled={dirty}
												title={
													b.status === "outdated"
														? "Refresh to current version"
														: "Overwrite in-file edits with current version"
												}
												onClick={() =>
													b.status === "modified"
														? setConfirm({ kind: "update", name: b.snippet })
														: doUpdate(b.snippet)
												}
											>
												Update
											</Button>
										)}
										<Button
											size="sm"
											icon="trash"
											disabled={dirty}
											title="Remove block from file"
											onClick={() =>
												b.status === "modified"
													? setConfirm({ kind: "remove", name: b.snippet })
													: doRemove(b.snippet)
											}
										/>
									</div>
								</div>
							))}

							{damaged.map((d, i) => (
								<div
									key={`dmg${i}`}
									className="snip-strip-row snip-strip-damaged"
								>
									<Icon
										name="warning"
										size={12}
										className="snip-strip-damaged-icon"
									/>
									<span className="snip-strip-row-name">{d.name}</span>
									<span className="snip-strip-damaged-label">
										{d.kind === "unpaired-start"
											? "unclosed marker"
											: "orphan end marker"}{" "}
										· line {d.line}
									</span>
									<span className="snip-strip-row-spacer" />
									<span className="snip-strip-damaged-hint">
										clean up by hand in the editor above
									</span>
								</div>
							))}
						</div>
					)}
				</div>
			)}

			{confirm && (
				<ConfirmDialog
				open
				title={
					confirm.kind === "remove"
					? "Remove a modified block?"
					: "Update a modified block?"
				}
				confirmLabel={
					confirm.kind === "remove" ? "Remove anyway" : "Overwrite edits"
				}
				tone={confirm.kind === "remove" ? "danger" : "default"}
				confirmIcon={confirm.kind === "remove" ? "trash" : "state.update"}
				onClose={() => setConfirm(null)}
				onConfirm={() => {
						const c = confirm;
						setConfirm(null);
						if (c.kind === "remove") doRemove(c.name, true);
						else doUpdate(c.name, true);
					}}
				body={
					<>
						<p>
							<span className="text-mono">{confirm.name}</span> was edited by hand
							inside its markers in this file.
							{confirm.kind === "remove"
								? " Removing it discards those in-file edits — they aren’t stored anywhere else."
								: " Updating overwrites those in-file edits with the current library version."}
						</p>

						</>
						}
					/>
			)}
		</div>
	);
}
