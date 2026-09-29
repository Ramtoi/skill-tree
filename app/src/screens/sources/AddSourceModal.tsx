import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Button } from "@/components/Button";
import { BackButton } from "@/components/BackButton";
import { Chip, Chips } from "@/components/Chips";
import { EmptyState } from "@/components/EmptyState";
import { ErrorCard } from "@/components/ErrorCard";
import { Icon } from "@/components/Icon";
import { Modal } from "@/components/Modal";
import { SectionHeader } from "@/components/SectionHeader";
import { Tag } from "@/components/Tag";
import { Toggle } from "@/components/Toggle";
import { useToast } from "@/components/Toast";
import { useRegistry } from "@/hooks/useRegistry";
import {
	applySourceWithDecisions,
	type ConflictDecision,
} from "@/hooks/useSources";
import { hubCmd } from "@/lib/hubCmd";
import { trackProcess } from "@/lib/trackProcess";
import { LoadingButton } from "@/components/loading";

/** Process-card target id for the add-source clone + register. */
const SOURCE_ADD_TARGET = "source:add";
import { invalidateRegistry } from "@/lib/invalidate";
import { queryClient } from "@/lib/queryClient";
import { qk } from "@/lib/queryKeys";
import { parseCliJson } from "@/lib/skillPack";
import {
	deriveSourceIdFromUrl,
	parseGitSourceUrl,
	sourceIdError,
	suggestFreeSourceId,
	suggestSourceIdForUrl,
	takenSourceIds,
} from "@/lib/skillSource";
import { plural } from "@/screens/sources/sourceFormat";

interface AddSourceModalProps {
	onClose: () => void;
	registry: ReturnType<typeof useRegistry>["data"];
}

/** The `--dry-run --json` payload of `hub source add git`. `ok:false` carries a
 *  legible failure (today: `path_not_found`) instead of four honest-looking
 *  zeros — a silent empty preview reads as "this repo has no skills". */
interface SourcePreviewPayload {
	ok: boolean;
	counts?: { new: number; conflicts: number; imported: number; invalid: number };
	candidates?: Array<{ name: string; category: string; origin_path: string }>;
	/** Effective repo-relative path the backend actually scanned. */
	scanned_path?: string;
	error?: string;
	message?: string;
	/** A path that DOES exist and probably is what the user meant. */
	hint_path?: string;
}

export function AddSourceModal({ onClose, registry }: AddSourceModalProps) {
	const toast = useToast();
	const [url, setUrl] = useState("");
	const [id, setId] = useState("");
	const [idTouched, setIdTouched] = useState(false);
	const [branch, setBranch] = useState("");
	const [branchTouched, setBranchTouched] = useState(false);
	const [path, setPath] = useState("");
	const [pathTouched, setPathTouched] = useState(false);
	const [busy, setBusy] = useState(false);

	// What the pasted URL actually names. A GitHub tree/blob deep link carries a
	// branch and a directory — honoring them is the whole point of the wizard.
	const parsedUrl = useMemo(() => parseGitSourceUrl(url), [url]);
	// Source ids already in use — reserved built-ins ∪ configured git sources.
	const taken = useMemo(() => takenSourceIds(registry), [registry]);
	// The id we'd register with: the URL-derived slug (the deep-linked directory
	// when there is one), bumped past any collision so the pre-filled default
	// always applies cleanly.
	const suggestedId = useMemo(
		() => suggestFreeSourceId(suggestSourceIdForUrl(url), taken),
		[url, taken],
	);
	// Keep the (untouched) id field mirroring the suggestion as the URL changes.
	useEffect(() => {
		if (!idTouched) setId(suggestedId);
	}, [suggestedId, idTouched]);
	// Same mirror for branch + path: what you pasted shows up in the fields you
	// can still edit, so the scope is visible and correctable before any clone.
	useEffect(() => {
		if (!branchTouched) setBranch(parsedUrl.branch ?? "");
	}, [parsedUrl.branch, branchTouched]);
	useEffect(() => {
		if (!pathTouched) setPath(parsedUrl.subpath ?? "");
	}, [parsedUrl.subpath, pathTouched]);
	const idErr = useMemo(() => sourceIdError(id, taken), [id, taken]);
	const [decisions, setDecisions] = useState<Record<string, ConflictDecision>>({});
	const [resolved, setResolved] = useState<
		Array<{ name: string; action: string; final_name: string }> | null
	>(null);
	const [preview, setPreview] = useState<{
		counts: { new: number; conflicts: number; imported: number; invalid: number };
		candidates: Array<{ name: string; category: string; origin_path: string }>;
		scanned_path?: string;
	} | null>(null);
	/** A scan base that doesn't exist upstream — recoverable, so it stays on the
	 *  entry step next to the field that caused it (with a one-click fix). */
	const [pathError, setPathError] = useState<{
		message: string;
		hint?: string;
	} | null>(null);
	/** NEW candidates the user wants. Seeded to ALL on every fresh preview so the
	 *  common "take everything" path costs zero clicks. */
	const [selectedNew, setSelectedNew] = useState<Set<string>>(() => new Set());

	const conflicts = useMemo(
		() =>
			(preview?.candidates ?? []).filter(
				(c) => c.category.toUpperCase() === "CONFLICT",
			),
		[preview],
	);
	const newCandidates = useMemo(
		() =>
			(preview?.candidates ?? []).filter((c) => c.category.toUpperCase() === "NEW"),
		[preview],
	);
	const selectedNewNames = useMemo(
		() => newCandidates.filter((c) => selectedNew.has(c.name)).map((c) => c.name),
		[newCandidates, selectedNew],
	);
	/** A strict subset — the only case that needs `selected_new` on the wire (and
	 *  the only case the backend persists as a source-level `include:` filter). */
	const isSubset =
		newCandidates.length > 0 && selectedNewNames.length < newCandidates.length;

	function decisionFor(name: string): ConflictDecision {
		return decisions[name] ?? "skip";
	}

	function toggleAllNew() {
		setSelectedNew((prev) => {
			const all = newCandidates.every((c) => prev.has(c.name));
			return all ? new Set() : new Set(newCandidates.map((c) => c.name));
		});
	}

	async function runPreview(override?: { path?: string }) {
		if (!url.trim()) {
			toast.error("Repository URL is required");
			return;
		}
		if (idErr) {
			toast.error(`Source id ${id} can't be used — pick another`);
			return;
		}
		const effectivePath = override?.path ?? path;
		setBusy(true);
		try {
			const args = ["source", "add", "git", url, "--dry-run", "--json"];
			if (id) args.push("--id", id);
			if (branch) args.push("--branch", branch);
			if (effectivePath) args.push("--path", effectivePath);
			// A dry-run still clones the repo into the source cache, so it is a
			// live network process and reports through the shared banner.
			const res = await trackProcess(
				{
					title: "Scanning repository",
					body: `git clone ${url}`,
					kind: "remote",
					target: SOURCE_ADD_TARGET,
				},
				() => hubCmd(args),
				{ successBody: "scan complete" },
			);
			let payload: SourcePreviewPayload;
			try {
				payload = parseCliJson<SourcePreviewPayload>(res.output);
			} catch {
				throw new Error(res.output || "preview failed");
			}
			if (!payload.ok) {
				if (payload.error === "path_not_found") {
					// Not a toast: the fix lives in a field on this very step.
					setPreview(null);
					setPathError({
						message:
							payload.message ??
							`No such directory in the repository: ${effectivePath}`,
						hint: payload.hint_path,
					});
					return;
				}
				throw new Error(payload.message || payload.error || "preview failed");
			}
			setPathError(null);
			setDecisions({});
			setResolved(null);
			const candidates = payload.candidates ?? [];
			setSelectedNew(
				new Set(
					candidates
						.filter((c) => c.category.toUpperCase() === "NEW")
						.map((c) => c.name),
				),
			);
			setPreview({
				counts: payload.counts ?? { new: 0, conflicts: 0, imported: 0, invalid: 0 },
				candidates,
				scanned_path: payload.scanned_path,
			});
		} catch (err) {
			toast.error("Couldn't preview source", String(err));
		} finally {
			setBusy(false);
		}
	}

	function onPreview(e: FormEvent) {
		e.preventDefault();
		void runPreview();
	}

	/** One click from "wrong path" to "previewing the right one". */
	function applyHintPath(hint: string) {
		setPath(hint);
		setPathTouched(true);
		setPathError(null);
		void runPreview({ path: hint });
	}

	async function onApply() {
		setBusy(true);
		try {
			const args = ["source", "add", "git", url];
			if (id) args.push("--id", id);
			if (branch) args.push("--branch", branch);
			if (path) args.push("--path", path);
			const payload = await trackProcess(
				{
					title: "Adding source",
					body: "registering skills",
					kind: "remote",
					target: SOURCE_ADD_TARGET,
				},
				() =>
					applySourceWithDecisions(
						args,
						decisions,
						// Omitted when everything is selected: that keeps the source
						// following upstream fully instead of freezing today's list.
						isSubset ? selectedNewNames : undefined,
					),
				{
					successBody: (p) =>
						`${p.registered.length} skill${p.registered.length === 1 ? "" : "s"} registered`,
				},
			);
			await invalidateRegistry(queryClient);
			await queryClient.invalidateQueries({ queryKey: qk.sources() });
			await queryClient.invalidateQueries({ queryKey: qk.localCandidates() });
			const resolvedRows = payload.resolved ?? [];
			setResolved(resolvedRows);
			const replaced = resolvedRows.filter((r) => r.action === "replace").length;
			const suffixed = resolvedRows.filter((r) => r.action === "suffix").length;
			const extra =
				replaced || suffixed
					? ` · ${replaced} replaced, ${suffixed} renamed`
					: "";
			toast.success(
				`Added source with ${payload.registered.length} skill(s)${extra}`,
			);
		} catch (err) {
			toast.error("Couldn't add source", String(err));
		} finally {
			setBusy(false);
		}
	}

	const hasConflictWork = conflicts.some((c) => decisionFor(c.name) !== "skip");
	const canApply =
		!!preview &&
		!busy &&
		!idErr &&
		(selectedNewNames.length > 0 || hasConflictWork);
	const applyDisabledReason =
		preview && !canApply && !busy
			? idErr
				? "Fix the source id before applying."
				: newCandidates.length === 0
					? "Choose a conflict resolution or import at least one new skill."
					: "Select at least one skill to import."
			: undefined;
	// Naming the count is the guard rail: importing 3 of 72 must never look the
	// same as importing all 72.
	const applyLabel = isSubset
		? `Import ${selectedNewNames.length} of ${newCandidates.length}`
		: "Apply";

	return (
		<Modal open onClose={onClose} title="Add Git source" width={680} dismissable={!busy}>
			{!preview && !resolved && (
				<>
				<p className="im-add-source-modal-1">
					Discovery scans the configured subdirectory, its immediate children, and conventional{" "}
					<code>skills/</code> / <code>mcp-servers/</code> folders. SSH or HTTPS uses your system Git
					auth — credentials are never stored in <code>registry.yaml</code>.
				</p>
				<p
					className="im-add-source-modal-2"
				>
					LiteLLM Skills Gateway — coming soon. Will let you connect an organizational Skill
					Hub from a LiteLLM proxy.
				</p>
				<form onSubmit={onPreview} className="im-add-source-modal-3">
					<label className="im-add-source-modal-4">
						<span className="im-add-source-modal-5">Repository URL</span>
						<input
							value={url}
							onChange={(e) => setUrl(e.target.value)}
							placeholder="git@github.com:org/skills.git"
							autoFocus
							className="im-add-source-modal-6"
						/>
					</label>
					<label className="im-add-source-modal-7">
						<span className="im-add-source-modal-8">Source id (optional)</span>
						<input
							value={id}
							onChange={(e) => {
								const v = e.target.value;
								// Empty field re-arms auto-derivation from the URL.
								setIdTouched(v.trim() !== "");
								setId(v);
							}}
							placeholder="derived from URL"
							aria-invalid={idErr ? true : undefined}
							style={{
								padding: "6px 8px",
								borderColor: idErr ? "var(--red)" : undefined,
							}}
						/>
						{idErr && (
							<span
								data-testid="source-id-error"
								className="im-add-source-modal-9"
							>
								{idErr === "taken"
									? `“${id}” is already a source — try ${suggestFreeSourceId(id, taken)}`
									: idErr === "reserved"
										? `“${id}” is reserved for the built-in ${id} source`
										: "Use lowercase letters, numbers, and hyphens only"}
							</span>
						)}
						{!idErr && id && (
							<span
								data-testid="source-id-hint"
								className="im-add-source-modal-10"
							>
								registers as <span className="text-mono">{id}</span>
							</span>
						)}
					</label>
					<label className="im-add-source-modal-11">
						<span className="im-add-source-modal-12">Branch (optional)</span>
						<input
							value={branch}
							onChange={(e) => {
								// Empty re-arms derivation from the URL (same rule as the id).
								setBranchTouched(e.target.value.trim() !== "");
								setBranch(e.target.value);
							}}
							placeholder="auto-detect"
							className="im-add-source-modal-13"
						/>
					</label>
					<label className="im-add-source-modal-14">
						<span className="im-add-source-modal-15">
							Subdirectory (optional, repo-relative)
						</span>
						<input
							value={path}
							onChange={(e) => {
								setPathTouched(e.target.value.trim() !== "");
								setPath(e.target.value);
							}}
							placeholder="skills"
							data-testid="source-path-input"
							className="im-add-source-modal-16"
						/>
						{parsedUrl.subpath && !pathTouched && (
							<span
								data-testid="source-path-hint"
								className="im-add-source-modal-17"
							>
								from the pasted link — scans{" "}
								<span className="text-mono">/{parsedUrl.subpath}</span> only
							</span>
						)}
					</label>
					<div className="im-add-source-modal-18">
						<Button variant="ghost" onClick={onClose} type="button">
							Cancel
						</Button>
						<Button variant="primary" type="submit" disabled={busy || !!idErr}>
							{busy ? "Previewing…" : "Preview"}
						</Button>
					</div>
				</form>
				{pathError && (
					<div className="source-add-error" data-testid="source-path-error">
						<ErrorCard
							title="That path isn't in the repository"
							description={pathError.message}
							fix={
								pathError.hint
									? [
											<>
												Scan{" "}
												<span className="text-mono">{pathError.hint}</span>{" "}
												instead — the path is relative to the repository root,
												not to the link you pasted.
											</>,
										]
									: [
											<>
												Check the subdirectory against the repository — the path
												is relative to the repository root.
											</>,
										]
							}
							actions={
								pathError.hint ? (
									<Button
										variant="primary"
										size="sm"
										disabled={busy}
										data-testid="use-hint-path"
										onClick={() => applyHintPath(pathError.hint as string)}
									>
										Use {pathError.hint}
									</Button>
								) : undefined
							}
						/>
					</div>
				)}
				</>
			)}

			{preview && !resolved && (
					<div className="im-add-source-modal-19">
						<div className="source-add-summary">
							<div>
								<span>Repository</span>
								<strong className="text-mono">{url}</strong>
							</div>
							<div>
								<span>Registers as</span>
								<strong className="text-mono">{id || deriveSourceIdFromUrl(url)}</strong>
							</div>
							{/* Always shown: the path the backend REALLY scanned, not the
							    field we echoed back. That gap is exactly what let an
							    unscoped 72-skill import look correct. */}
							<div>
								<span>Scanned path</span>
								<strong className="text-mono" data-testid="scanned-path">
									{preview.scanned_path
										? `/${preview.scanned_path}`
										: "repository root"}
								</strong>
							</div>
						</div>
						<SectionHeader
							label="Preview"
							right={
								newCandidates.length > 1 ? (
									<Button
										variant="ghost"
										size="sm"
										data-testid="select-all-new"
										onClick={toggleAllNew}
									>
										{selectedNewNames.length === newCandidates.length
											? "Select none"
											: "Select all"}
									</Button>
								) : undefined
							}
						/>
						<div className="im-add-source-modal-20">
							<Tag color="var(--green)">{preview.counts.new} new</Tag>
							<Tag
								color={
									preview.counts.conflicts > 0 ? "var(--amber)" : "var(--fg-mute)"
								}
							>
								{plural(preview.counts.conflicts, "conflict")}
							</Tag>
							<Tag color="var(--fg-mute)">{preview.counts.imported} already imported</Tag>
							<Tag
								color={
									preview.counts.invalid > 0 ? "var(--red)" : "var(--fg-mute)"
								}
							>
								{preview.counts.invalid} invalid
							</Tag>
						</div>
						{preview.candidates.length === 0 ? (
							<EmptyState
								icon="search"
								title={
									<>
										No skills found at{" "}
										<span className="text-mono">
											{preview.scanned_path
												? `/${preview.scanned_path}`
												: "the repository root"}
										</span>
									</>
								}
								description="The path exists but holds no SKILL.md. Point at the folder that contains the skill, or at a folder of skills."
							/>
						) : (
							<div className="im-add-source-modal-21">
								{preview.candidates.map((c) => {
									const isNew = c.category.toUpperCase() === "NEW";
									return (
										<div
											key={c.name}
											data-testid={`candidate-${c.name}`}
											className="im-add-source-modal-22"
										>
											{/* Only NEW rows are selectable — a conflict is decided
											    by its own three-way chip row below. */}
											<span className="im-add-source-modal-23">
												{isNew && (
													<Toggle
														size="sm"
														checked={selectedNew.has(c.name)}
														ariaLabel={`Import ${c.name}`}
														onChange={(on) =>
															setSelectedNew((prev) => {
																const next = new Set(prev);
																if (on) next.add(c.name);
																else next.delete(c.name);
																return next;
															})
														}
													/>
												)}
											</span>
											<span className="im-add-source-modal-24">{c.category}</span>
											<span>{c.name}</span>
											<span className="im-add-source-modal-25">{c.origin_path}</span>
										</div>
									);
								})}
							</div>
						)}
						{isSubset && (
							<p
								data-testid="subset-note"
								className="im-add-source-modal-26"
							>
								Importing {selectedNewNames.length} of {newCandidates.length}.
								The new skills you unchecked stay out — later syncs won't add
								them back. Conflicts are unaffected: they keep coming back for a
								decision.
							</p>
						)}

						{conflicts.length > 0 && (
							<div className="source-conflict-resolver">
								<SectionHeader
									label="Resolve conflicts"
									count={conflicts.length}
								/>
								<p className="im-add-source-modal-27">
									These names already exist. Choose per skill — default keeps
									yours.
								</p>
								{conflicts.map((c) => (
									<div
										key={c.name}
										className="conflict-row"
										data-testid={`conflict-${c.name}`}
									>
										<span className="conflict-name text-mono">{c.name}</span>
										<Chips role="tablist">
											<Chip
												pressed={decisionFor(c.name) === "skip"}
												onClick={() =>
													setDecisions((d) => ({ ...d, [c.name]: "skip" }))
												}
												title="Keep the existing skill; do not import"
											>
												Keep mine
											</Chip>
											<Chip
												pressed={decisionFor(c.name) === "replace"}
												onClick={() =>
													setDecisions((d) => ({ ...d, [c.name]: "replace" }))
												}
												title="Overwrite the existing skill from this source"
											>
												Take theirs
											</Chip>
											<Chip
												pressed={decisionFor(c.name) === "suffix"}
												onClick={() =>
													setDecisions((d) => ({ ...d, [c.name]: "suffix" }))
												}
												title="Import under a renamed skill (name-2)"
											>
												Import renamed
											</Chip>
										</Chips>
									</div>
								))}
							</div>
						)}

						<div className="im-add-source-modal-28">
							<BackButton title="Back to source details" onClick={() => setPreview(null)}>
								Back
							</BackButton>
							<LoadingButton
								variant="primary"
								data-testid="source-apply"
								loading={busy}
								loadingLabel="Applying…"
								onClick={() => void onApply()}
								disabled={!canApply}
								disabledReason={applyDisabledReason}
							>
								{applyLabel}
							</LoadingButton>
						</div>
					</div>
				)}

			{resolved && (
					<div className="im-add-source-modal-29">
						<SectionHeader label="Applied" count={resolved.length} />
						{resolved.length === 0 ? (
							<span className="text-dim text-mono im-add-source-modal-30">
								No conflicts required resolution.
							</span>
						) : (
							<div className="im-add-source-modal-31">
								{resolved.map((r) => (
									<div
										key={r.name}
										className="resolved-row text-mono im-add-source-modal-32"
										data-testid={`resolved-${r.name}`}

									>
										<span className="im-add-source-modal-33">
											{r.action}
										</span>
										<span>{r.name}</span>
										<Icon name="arrowRight" size={10} />
										<span className="im-add-source-modal-34">{r.final_name}</span>
									</div>
								))}
							</div>
						)}
						<div className="im-add-source-modal-35">
							<Button variant="primary" onClick={onClose}>
								Done
							</Button>
						</div>
					</div>
				)}
		</Modal>
	);
}
