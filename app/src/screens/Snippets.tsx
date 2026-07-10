import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/Button";
import { CodeAreaEdit, CodeAreaPreview } from "@/components/CodeArea";
import {
	DocumentEditorShell,
	type DocMode,
} from "@/components/DocumentEditorShell";
import { EmptyState } from "@/components/EmptyState";
import { Icon } from "@/components/Icon";
import { Spinner } from "@/components/loading";
import { ResizableSplit } from "@/components/ResizableSplit";
import { ScreenHeader } from "@/components/ScreenHeader";
import { SubheaderGroup } from "@/components/SubheaderGroup";
import { Tag } from "@/components/Tag";
import { useToast } from "@/components/Toast";
import { ApplyToDialog } from "@/components/snippets/ApplyToDialog";
import { ConfirmDialog } from "@/components/Modal";
import { SnippetStatusBadge } from "@/components/snippets/SnippetStatusBadge";
import { TagInput } from "@/components/snippets/TagInput";
import { useRegistry } from "@/hooks/useRegistry";
import {
	applySnippet,
	createSnippet,
	deleteSnippet,
	editSnippet,
	removeSnippet,
	updateSnippet,
	updateSnippetEverywhere,
	useInvalidateSnippets,
	useSnippet,
	useSnippets,
} from "@/hooks/useSnippets";
import type {
	SnippetInfo,
	SnippetLocation,
	SnippetUsage,
} from "@/types/snippets";

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function normalizeBody(s: string): string {
	return s.replace(/\r\n/g, "\n").replace(/\s+$/g, "");
}

// ─── Library row ─────────────────────────────────────────────────────────────
function SnippetRow({
	snippet,
	selected,
	onClick,
}: {
	snippet: SnippetInfo;
	selected: boolean;
	onClick: () => void;
}) {
	const usage: SnippetUsage = snippet.usage ?? {
		count: 0,
		summary: "none",
		outdated_count: 0,
	};
	// Amber is reserved for direct-equip provenance (§5.2). Applied is green;
	// outdated/modified are transitional (neutral); orphaned is a dim red-tinted
	// distinct treatment.
	const summaryColor =
		usage.summary === "applied"
			? "var(--green)"
			: usage.summary === "orphaned"
				? "color-mix(in oklab, var(--red) 55%, var(--fg-dim))"
				: usage.summary === "modified" || usage.summary === "outdated"
					? "var(--fg-dim)"
					: "var(--fg-dim)";
	return (
		<div
			className="snip-row"
			data-selected={selected}
			data-summary={usage.summary}
			onClick={onClick}
			style={{ "--snip-stripe": summaryColor } as React.CSSProperties}
		>
			<div className="snip-row-top">
				<span className="snip-row-name">{snippet.name}</span>
				<span className="snip-row-ver">v{snippet.version}</span>
				{usage.summary === "orphaned" && (
					<span
						className="snip-row-orphan-label"
						title="Library snippet is gone — this block is orphaned"
					>
						orphaned
					</span>
				)}
				<div
					className="snip-row-applied"
					data-active={usage.count > 0}
					data-attn={usage.outdated_count > 0 || usage.summary === "modified"}
				>
					{usage.count > 0 ? (
						<>
							<Icon name="doc" size={11} />
							<span>{usage.count}</span>
							{usage.outdated_count > 0 && (
								<span
									className="snip-row-attn"
									title={`${usage.outdated_count} outdated`}
								>
									{usage.outdated_count}↑
								</span>
							)}
						</>
					) : (
						<span className="snip-row-unused">unused</span>
					)}
				</div>
			</div>
			<div className="snip-row-sub">
				<span className="snip-row-desc">{snippet.description}</span>
				<span className="snip-row-tags">
					{snippet.tags.slice(0, 2).map((t) => (
						<span key={t} className="snip-row-tag">
							{t}
						</span>
					))}
				</span>
			</div>
		</div>
	);
}

// ─── Applied-locations panel (detail side) ──────────────────────────────────
function AppliedLocationsPanel({
	name,
	version,
	locations,
	onApplyOpen,
	onMutated,
}: {
	name: string;
	version: number;
	locations: SnippetLocation[];
	onApplyOpen: () => void;
	onMutated: () => void;
}) {
	const toast = useToast();
	const [removeTarget, setRemoveTarget] = useState<SnippetLocation | null>(null);
	// Per-location in-flight set (key = project:rel) + the "update everywhere"
	// flag. Only the acted-on control disables; siblings stay interactive.
	const [pending, setPending] = useState<Set<string>>(() => new Set());
	const [updatingAll, setUpdatingAll] = useState(false);
	const locKey = (loc: SnippetLocation) => `${loc.project}:${loc.rel}`;
	const withPending = async (key: string, fn: () => Promise<void>) => {
		setPending((p) => new Set(p).add(key));
		try {
			await fn();
		} finally {
			setPending((p) => {
				const n = new Set(p);
				n.delete(key);
				return n;
			});
		}
	};
	const outdatedCount = locations.filter((l) => l.status === "outdated").length;

	async function doRemove(loc: SnippetLocation, force = false) {
		await withPending(locKey(loc), async () => {
			try {
				await removeSnippet({
					name,
					project: loc.project,
					relativePath: loc.rel,
					force,
				});
				toast.info(`Removed from ${loc.rel}`, `${loc.project} · block excised`);
				onMutated();
			} catch (err) {
				toast.error("Couldn't remove snippet", String(err));
			}
		});
	}
	async function doUpdate(loc: SnippetLocation) {
		await withPending(locKey(loc), async () => {
			try {
				await updateSnippet({ name, project: loc.project, relativePath: loc.rel });
				toast.success(`Updated in ${loc.rel}`, `${loc.project} · now v${version}`);
				onMutated();
			} catch (err) {
				toast.error("Couldn't update snippet", String(err));
			}
		});
	}
	async function updateEverywhere() {
		setUpdatingAll(true);
		try {
			const res = await updateSnippetEverywhere({ name });
			const n = res.refreshed.length;
			toast[n ? "success" : "info"](
				`Updated ${n} ${n === 1 ? "location" : "locations"}`,
				res.skipped.length
					? `${res.skipped.length} modified ${res.skipped.length === 1 ? "block" : "blocks"} skipped — update those by hand`
					: "all outdated blocks refreshed",
			);
			onMutated();
		} catch (err) {
			toast.error("Couldn't update everywhere", String(err));
		} finally {
			setUpdatingAll(false);
		}
	}

	return (
		<div className="side-panel-block snip-applied">
			<h4>
				<span className="snip-applied-label">
					Applied to{" "}
					<span style={{ color: "var(--fg-dim)" }}>
						· {locations.length} {locations.length === 1 ? "file" : "files"}
					</span>
				</span>
				{outdatedCount > 0 && (
					<button
						type="button"
						className="snip-update-all"
						onClick={updateEverywhere}
						disabled={updatingAll}
						aria-busy={updatingAll || undefined}
						title="Refresh every outdated location"
					>
						{updatingAll ? (
							<Spinner size={11} color="currentColor" />
						) : (
							<Icon name="state.update" size={11} />
						)}{" "}
						Update everywhere · {outdatedCount}
					</button>
				)}
			</h4>

			{locations.length === 0 ? (
				<div className="snip-applied-empty">
					<p>Not applied to any file yet.</p>
					<Button size="sm" icon="plus" onClick={onApplyOpen}>
						Apply to…
					</Button>
				</div>
			) : (
				<>
					<div className="snip-loc-list">
						{locations.map((loc, i) => (
							<div
								key={loc.project + loc.rel + i}
								className="snip-loc"
								data-status={loc.status}
							>
								<div className="snip-loc-main">
									<div className="snip-loc-top">
										<span className="snip-loc-proj">{loc.project}</span>
										<SnippetStatusBadge status={loc.status} />
									</div>
									<div className="snip-loc-path">{loc.rel}</div>
								</div>
								<div className="snip-loc-actions">
									{loc.status === "outdated" && (
										<Button
											size="sm"
											icon="state.update"
											busy={pending.has(locKey(loc))}
											onClick={() => doUpdate(loc)}
											title="Refresh to current version"
										>
											Update
										</Button>
									)}
									<Button
										size="sm"
										icon="trash"
										busy={pending.has(locKey(loc))}
										title="Remove block from file"
										onClick={() =>
											loc.status === "modified"
												? setRemoveTarget(loc)
												: doRemove(loc)
										}
									/>
								</div>
							</div>
						))}
					</div>
					<div className="snip-applied-foot">
						<Button size="sm" variant="ghost" icon="plus" onClick={onApplyOpen}>
							Apply to another file…
						</Button>
					</div>
				</>
			)}

			{removeTarget && (
				<ConfirmDialog
				open
				title="Remove a modified block?"
				confirmLabel="Remove anyway"
				tone="danger"
				confirmIcon="trash"
				onClose={() => setRemoveTarget(null)}
				onConfirm={() => {
						const l = removeTarget;
						setRemoveTarget(null);
						doRemove(l, true);
					}}
				body={
					<>
						<p>
							This block was edited by hand in{" "}
							<span className="text-mono">{removeTarget.rel}</span> (
								{removeTarget.project}). Removing it will{" "}
							<strong>discard those in-file edits</strong> — they aren&rsquo;t
							stored anywhere else.
						</p>

						</>
						}
					/>
			)}
		</div>
	);
}

// ─── Detail (edit an existing snippet) ──────────────────────────────────────
function SnippetDetail({
	name,
	onDeleted,
}: {
	name: string;
	onDeleted: () => void;
}) {
	const toast = useToast();
	const invalidate = useInvalidateSnippets();
	const { data: snippet } = useSnippet(name);

	const [desc, setDesc] = useState("");
	const [tags, setTags] = useState<string[]>([]);
	const [body, setBody] = useState("");
	const [loadedFor, setLoadedFor] = useState<string | null>(null);
	const [mode, setMode] = useState<DocMode>("edit");
	const [applyOpen, setApplyOpen] = useState(false);
	const [deleteOpen, setDeleteOpen] = useState(false);

	// Initialize buffers when the snippet (or a fresh copy of it) loads.
	useEffect(() => {
		if (!snippet) return;
		const stamp = `${snippet.name}@v${snippet.version}:${snippet.hash}`;
		if (loadedFor === stamp) return;
		setLoadedFor(stamp);
		setDesc(snippet.description);
		setTags(snippet.tags);
		setBody(snippet.body ?? "");
		setMode("edit");
	}, [snippet, loadedFor]);

	const locations = snippet?.usage?.locations ?? [];
	const allSnippets = useSnippets().data ?? [];
	const allTags = useMemo(
		() => [...new Set(allSnippets.flatMap((s) => s.tags))].sort(),
		[allSnippets],
	);

	if (!snippet) return null;

	const dirty =
		body !== (snippet.body ?? "") ||
		desc !== snippet.description ||
		tags.join(",") !== snippet.tags.join(",");
	const bodyChanged = normalizeBody(body) !== normalizeBody(snippet.body ?? "");

	async function save() {
		if (!dirty || !snippet) return;
		try {
			const res = await editSnippet({ name: snippet.name, description: desc, tags, body });
			toast.success(
				`Saved ${snippet.name}`,
				res.body_changed
					? res.outdated_locations
						? `v${res.version} · ${res.outdated_locations} applied ${res.outdated_locations === 1 ? "location is" : "locations are"} now outdated`
						: `bumped to v${res.version}`
					: "metadata updated",
			);
			invalidate();
		} catch (err) {
			toast.error("Couldn't save snippet", String(err));
		}
	}

	async function confirmDelete() {
		if (!snippet) return;
		try {
			await deleteSnippet({ name: snippet.name, force: locations.length > 0 });
			toast.error(
				`Deleted ${snippet.name}`,
				locations.length
					? `${locations.length} in-file ${locations.length === 1 ? "block remains" : "blocks remain"} — now orphaned`
					: "removed from library",
			);
			setDeleteOpen(false);
			invalidate();
			onDeleted();
		} catch (err) {
			toast.error("Couldn't delete snippet", String(err));
		}
	}

	async function applyTo(project: string, rel: string) {
		if (!snippet) return;
		setApplyOpen(false);
		try {
			const res = await applySnippet({
				name: snippet.name,
				project,
				relativePath: rel,
			});
			toast.success(
				`Applied ${snippet.name}`,
				res.mirrored?.length
					? `${project} · ${rel} + ${res.mirrored.map((m) => m.rel).join(", ")} (mirrored)`
					: `${project} · ${rel}`,
			);
			invalidate();
		} catch (err) {
			toast.error("Couldn't apply snippet", String(err));
		}
	}

	return (
		<>
		<DocumentEditorShell
			content={body}
			onContentChange={setBody}
			mode={mode}
			onModeChange={setMode}
			diffOriginal={snippet.body ?? ""}
			dirty={dirty}
			onSave={save}
			splitStorageKey="st:layout:snippets"
			headerExtras={
				<span className="snip-detail-title">
					<Icon name="snippet" size={14} />
					<span className="snip-detail-name">{snippet.name}</span>
					<span className="snip-detail-ver">v{snippet.version}</span>
				</span>
			}
			footerExtras={
				<>
					<span>
						<Icon name="doc" size={10} /> markdown snippet
					</span>
					<span>
						{body.split("\n").length} lines · {body.length} chars
					</span>
					<span className="editor-foot-spacer" />
					<span>updated {snippet.updated || "—"}</span>
				</>
			}
			sidePanel={
				<>
					<div className="side-panel-block">
						<div className="meta-grid snip-meta">
							<div className="field field-full">
								<label>description</label>
								<input
									value={desc}
									onChange={(e) => setDesc(e.target.value)}
									placeholder="One line — what this snippet instructs"
								/>
							</div>
							<div className="field field-full">
								<label>tags</label>
								<TagInput tags={tags} onChange={setTags} suggestions={allTags} />
							</div>
						</div>
						{bodyChanged && locations.length > 0 && (
							<div className="agent-docs-banner snip-banner-warn">
								<Icon name="warning" size={12} />
								<span>
									Editing the body bumps the version. {locations.length} applied{" "}
									{locations.length === 1 ? "location" : "locations"} will read as
									<strong> outdated</strong> until you Update{" "}
									{locations.length === 1 ? "it" : "them"}.
								</span>
							</div>
						)}
					</div>

					<AppliedLocationsPanel
						name={snippet.name}
						version={snippet.version}
						locations={locations}
						onApplyOpen={() => setApplyOpen(true)}
						onMutated={invalidate}
					/>

					<div className="side-panel-block">
						<h4>Marker format</h4>
						<div className="snip-marker-hint">
							Applying wraps the body in hub-owned comments. Never hand-author
							these.
							<pre className="snip-marker-pre">
								<code>{`<!-- skill-tree:snippet\n  id=${snippet.name} v=${snippet.version} sha=${snippet.hash} -->\n…body…\n<!-- skill-tree:snippet:end\n  id=${snippet.name} -->`}</code>
							</pre>
						</div>
					</div>
				</>
			}
			dangerZone={
				<div className="danger-zone">
					<h4>Danger zone</h4>
					<div
						style={{ fontSize: 11.5, color: "var(--fg-mute)", marginBottom: 10 }}
					>
						{locations.length
							? `Deleting removes it from the library only. ${locations.length} applied ${locations.length === 1 ? "block stays" : "blocks stay"} in place and will read as orphaned.`
							: "Deleting removes this snippet from the library. It isn’t applied anywhere, so nothing else changes."}
					</div>
					<div className="actions">
						<Button variant="danger" icon="trash" onClick={() => setDeleteOpen(true)}>
							Delete snippet
						</Button>
					</div>
				</div>
			}
		/>

			{applyOpen && (
				<ApplyToDialog
					snippetName={snippet.name}
					locations={locations}
					onClose={() => setApplyOpen(false)}
					onApply={applyTo}
				/>
			)}

			{deleteOpen && (
				<ConfirmDialog
				open
				title={`Delete ${snippet.name}?`}
				confirmLabel={
					locations.length
					? `Delete · leave ${locations.length} orphaned`
					: "Delete snippet"
				}
				tone="danger"
				confirmIcon="trash"
				onClose={() => setDeleteOpen(false)}
				onConfirm={confirmDelete}
				body={
					<>
						{locations.length ? (
								<>
									<p>
										<span className="text-mono">{snippet.name}</span> is still applied
										to {locations.length}{" "}
										{locations.length === 1 ? "file" : "files"}. Deleting leaves those
										blocks in place — they&rsquo;ll read as <strong>orphaned</strong>{" "}
										(removable, no update).
									</p>
										<div className="snip-delete-files">
											{locations.map((l, i) => (
														<div key={i} className="snip-delete-file">
															<span>{l.project}</span>
															<span className="text-mono text-dim">{l.rel}</span>
														</div>
														))}
											</div>
											</>
											) : (
												<p>
													This removes <span className="text-mono">{snippet.name}</span> from
													the library. It isn&rsquo;t applied anywhere.
												</p>
												)}

										</>
										}
									/>
			)}
		</>
	);
}

// ─── Create (inline new-snippet form) ───────────────────────────────────────
function SnippetCreate({
	existingNames,
	allTags,
	onCreated,
	onCancel,
}: {
	existingNames: Set<string>;
	allTags: string[];
	onCreated: (name: string) => void;
	onCancel: () => void;
}) {
	const toast = useToast();
	const invalidate = useInvalidateSnippets();
	const [name, setName] = useState("");
	const [desc, setDesc] = useState("");
	const [tags, setTags] = useState<string[]>([]);
	const [body, setBody] = useState("## \n\n");

	const nameErr = !name
		? null
		: !NAME_RE.test(name)
			? "Use lowercase kebab-case (letters, digits, single hyphens)."
			: existingNames.has(name)
				? `A snippet named "${name}" already exists.`
				: null;
	const canCreate = !nameErr && !!name && !!body.trim();

	async function create() {
		if (!canCreate) return;
		try {
			await createSnippet({ name, description: desc, tags, body });
			toast.success(`Created ${name}`, "added to the library");
			invalidate();
			onCreated(name);
		} catch (err) {
			toast.error("Couldn't create snippet", String(err));
		}
	}

	return (
		<ResizableSplit
			className="editor-grid snip-detail-grid"
			fixedPane="right"
			storageKey="st:layout:snippets"
			defaultRightPx={332}
			minRightPx={280}
			maxRightPx={520}
			paneLabel="Details"
			handleAriaLabel="Resize details panel"
			left={
			<div className="editor-main">
				<div className="snip-detail-head">
					<div className="snip-detail-title">
						<Icon name="snippet" size={14} />
						<span className="snip-detail-name snip-detail-name-new">
							new snippet
						</span>
					</div>
					<div className="snip-detail-actions">
						<Button variant="ghost" onClick={onCancel}>
							Cancel
						</Button>
						<Button
							variant="primary"
							icon="plus"
							onClick={create}
							disabled={!canCreate}
						>
							Create snippet
						</Button>
					</div>
				</div>

				<div className="meta-grid snip-meta">
					<div className="field field-full">
						<label>
							name <span className="text-dim">· lowercase kebab-case</span>
						</label>
						<input
							value={name}
							autoFocus
							onChange={(e) => setName(e.target.value.toLowerCase())}
							placeholder="e.g. validation-procedure"
							spellCheck={false}
						/>
						<div
							className="field-hint"
							style={{ color: nameErr ? "var(--red)" : "var(--fg-dim)" }}
						>
							{nameErr ? (
								<>
									<Icon name="warning" size={11} /> {nameErr}
								</>
							) : (
								<>used as the marker id in every file it&rsquo;s applied to</>
							)}
						</div>
					</div>
					<div className="field field-full">
						<label>description</label>
						<input
							value={desc}
							onChange={(e) => setDesc(e.target.value)}
							placeholder="One line — what this snippet instructs"
						/>
					</div>
					<div className="field field-full">
						<label>tags</label>
						<TagInput tags={tags} onChange={setTags} suggestions={allTags} />
					</div>
				</div>

				<div className="snip-code">
					<CodeAreaEdit content={body} onChange={setBody} />
				</div>

				<div className="editor-foot">
					<span>
						<Icon name="doc" size={10} /> markdown snippet
					</span>
					<span>
						{body.split("\n").length} lines · {body.length} chars
					</span>
					<span className="editor-foot-spacer" />
					<span>{canCreate ? "ready to create" : "name + body required"}</span>
				</div>
			</div>
			}
			right={
			<div className="editor-side">
				<div className="side-panel-block">
					<h4>About snippets</h4>
					<div className="snip-marker-hint">
						A snippet is a reusable markdown instruction block. Once created you
						can
						<strong> apply</strong> it to any project&rsquo;s agent doc file —
						it&rsquo;s appended at the end, wrapped in hub-owned markers, and
						tracked by scanning the file.
					</div>
				</div>
				<div className="side-panel-block">
					<h4>Preview</h4>
					<div className="snip-create-preview">
						<CodeAreaPreview content={body} />
					</div>
				</div>
			</div>
			}
			/>
	);
}

// ─── Screen ───────────────────────────────────────────────────────────────
export function Snippets() {
	const [q, setQ] = useState("");
	const [tagFilter, setTagFilter] = useState<string | null>(null);
	const [selected, setSelected] = useState<string | null>(null);
	const [creating, setCreating] = useState(false);

	const { data: lib = [] } = useSnippets();
	const { data: registry } = useRegistry();
	const projectCount = Object.keys(registry?.projects ?? {}).length;

	const allTags = useMemo(
		() => [...new Set(lib.flatMap((s) => s.tags))].sort(),
		[lib],
	);

	const filtered = useMemo(() => {
		const lq = q.trim().toLowerCase();
		return lib.filter((s) => {
			if (tagFilter && !s.tags.includes(tagFilter)) return false;
			if (!lq) return true;
			return (
				s.name.includes(lq) ||
				s.description.toLowerCase().includes(lq) ||
				(s.body ?? "").toLowerCase().includes(lq)
			);
		});
	}, [lib, q, tagFilter]);

	// Keep selection valid when snippets disappear.
	useEffect(() => {
		if (selected && !lib.some((s) => s.name === selected)) setSelected(null);
	}, [lib, selected]);

	const totalApplied = useMemo(
		() => lib.reduce((n, s) => n + (s.usage?.count ?? 0), 0),
		[lib],
	);

	function startCreate() {
		setCreating(true);
		setSelected(null);
	}
	function selectSnippet(name: string) {
		setCreating(false);
		setSelected(name);
	}

	return (
		<>
			<ScreenHeader
				leading={
					<span style={{ color: "var(--violet-2)", display: "inline-flex" }}>
						<Icon name="snippet" size={14} />
					</span>
				}
				title="Snippets"
				meta={
					<Tag color="var(--fg-mute)" style={{ textTransform: "none" }}>
						{filtered.length} of {lib.length}
					</Tag>
				}
				crumbs={[
					"skill-tree",
					"snippets",
					...(tagFilter
						? [
								<span key="tag" style={{ color: "var(--violet-2)" }}>
									#{tagFilter}
								</span>,
							]
						: []),
				]}
				subline={`${totalApplied} applied across ${projectCount} ${projectCount === 1 ? "project" : "projects"}`}
				primary={
					<Button variant="primary" icon="plus" onClick={startCreate}>
						New snippet
					</Button>
				}
				subheader={{
					left: (
						<>
							<div className="search-input">
								<Icon name="search" />
								<input
									placeholder="Search names, descriptions, body…"
									value={q}
									onChange={(e) => setQ(e.target.value)}
								/>
								<span className="slash">/</span>
							</div>
							{allTags.length > 0 && (
								<SubheaderGroup label="TAG">
									<div className="chips">
										{allTags.map((t) => (
											<button
												key={t}
												type="button"
												className="chip"
												aria-pressed={tagFilter === t}
												onClick={() =>
													setTagFilter(tagFilter === t ? null : t)
												}
											>
												<span className="chip-label">{t}</span>
											</button>
										))}
									</div>
								</SubheaderGroup>
							)}
						</>
					),
				}}
			/>

			<div
				className="main-body snip-screen"
				data-view={selected || creating ? "detail" : "list"}
			>
				{/* ── Library list ── */}
				<aside className="snip-list">
					{lib.length === 0 ? (
						<div className="snip-list-empty">
							<EmptyState
								icon="snippet"
								title="No snippets yet"
								description="Snippets are reusable instruction blocks you compose into agent doc files."
								action={
									<Button variant="primary" icon="plus" onClick={startCreate}>
										New snippet
									</Button>
								}
							/>
						</div>
					) : filtered.length === 0 ? (
						<div className="snip-list-empty">
							<EmptyState
								icon="search"
								title="No matches"
								description={`Clear the search or tag filter to see all ${lib.length} snippets.`}
							/>
						</div>
					) : (
						<div className="snip-list-scroll">
							{filtered.map((s) => (
								<SnippetRow
									key={s.name}
									snippet={s}
									selected={selected === s.name}
									onClick={() => selectSnippet(s.name)}
								/>
							))}
							<div style={{ height: 40 }} />
						</div>
					)}
				</aside>

				{/* ── Detail / create / empty ── */}
				<section className="snip-detail">
					{/* Narrow-width back affordance: at ≤600px the list column collapses
					    (CSS) and the detail goes full-width like SkillEditor/SubagentEditor;
					    this returns to the list. Hidden at wider widths. */}
					{(selected || creating) && (
						<button
							type="button"
							className="snip-detail-back"
							onClick={() => {
								setSelected(null);
								setCreating(false);
							}}
						>
							<Icon name="chevron-left" size={13} />
							Snippets
						</button>
					)}
					{creating ? (
						<SnippetCreate
							existingNames={new Set(lib.map((s) => s.name))}
							allTags={allTags}
							onCreated={(name) => {
								setCreating(false);
								setSelected(name);
							}}
							onCancel={() => setCreating(false)}
						/>
					) : selected ? (
						<SnippetDetail
							key={selected}
							name={selected}
							onDeleted={() => setSelected(null)}
						/>
					) : (
						<div className="snip-detail-empty empty-state">
							<Icon name="snippet" size={30} />
							<h3>Select a snippet</h3>
							<p>
								Pick one from the list to edit its body, manage where it&rsquo;s
								applied, or update outdated copies. Or create a new one.
							</p>
							<Button variant="primary" icon="plus" onClick={startCreate}>
								New snippet
							</Button>
						</div>
					)}
				</section>
			</div>
		</>
	);
}
