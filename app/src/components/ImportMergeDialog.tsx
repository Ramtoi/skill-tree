import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { invoke } from "@/lib/ipc";
import { Button } from "./Button";
import { Icon } from "./Icon";
import { Modal } from "./Modal";
import { SectionHeader } from "./SectionHeader";
import { Tag } from "./Tag";
import { ChipRadios, type ChipRadioOption } from "./ChipRadios";
import { HarnessGlyph, HarnessIconGroup } from "./harness/HarnessGlyph";
import { harnessDisplayLabel } from "./harness/harnessRegistry";
import { PatternText } from "./permissions/PatternText";
import { KIND_META } from "./permissions/PermissionsPanels";
import {
	importCandidateTriage,
	partitionImportCandidates,
} from "@/lib/permissionImportTriage";
import type {
	ImportApplyResult,
	ImportCandidateSet,
	ImportDecision,
	ImportMergedCandidate,
	RuleKind,
	Scope,
} from "@/types/permissions";

export interface ImportMergeDialogProps {
	open: boolean;
	scope: Scope;
	onClose: () => void;
	onApplied: () => void;
	harnessLabels?: Record<string, string>;
}

type MergedChoice = "import" | "later" | "keep" | "drop";
// Conflict choice: a specific kind, "both" (keep each with affinity), keep, or drop.
type ConflictChoice = RuleKind | "both" | "later" | "keep" | "drop";

function basename(p: string): string {
	const i = p.lastIndexOf("/");
	return i === -1 ? p : p.slice(i + 1);
}

// A pattern alone isn't a stable identity: the same pattern can appear twice
// with two different kinds (a genuine, if rare, backend shape). Keying choice
// state and React `key`s off pattern+kind keeps those rows — and their bulk
// actions — from bleeding into each other.
function mergedKey(m: ImportMergedCandidate): string {
	return `${m.pattern} ${m.kind}`;
}

interface MergedGroup {
	key: string;
	harnessIds: string[];
	label: string;
	files: string[];
	rows: ImportMergedCandidate[];
}

/** Group importable rows by the set of harnesses that reported them: single-
 *  harness groups first (alphabetical by label), then multi-harness groups. */
function groupMerged(
	rows: ImportMergedCandidate[],
	harnessLabels?: Record<string, string>,
): MergedGroup[] {
	const map = new Map<
		string,
		{ harnessIds: string[]; files: Set<string>; rows: ImportMergedCandidate[] }
	>();
	for (const m of rows) {
		const ids = Array.from(new Set(m.sources.map((s) => s.harness))).sort();
		const key = ids.join("+");
		let g = map.get(key);
		if (!g) {
			g = { harnessIds: ids, files: new Set(), rows: [] };
			map.set(key, g);
		}
		for (const s of m.sources) g.files.add(s.source);
		g.rows.push(m);
	}
	const groups: MergedGroup[] = Array.from(map.entries()).map(([key, g]) => ({
		key,
		harnessIds: g.harnessIds,
		label: g.harnessIds
			.map((id) => harnessDisplayLabel(id, harnessLabels))
			.join(" + "),
		files: Array.from(g.files),
		rows: g.rows,
	}));
	groups.sort((a, b) => {
		if (a.harnessIds.length !== b.harnessIds.length) {
			return a.harnessIds.length - b.harnessIds.length;
		}
		return a.label.localeCompare(b.label);
	});
	return groups;
}

const MERGED_OPTIONS: ChipRadioOption<MergedChoice>[] = [
	{
		value: "import",
		label: "Import",
		title: "Manage this rule in the registry and remove it from the native file",
	},
	{
		value: "later",
		label: "Later",
		title: "Do not change this rule now",
	},
	{
		value: "keep",
		label: "Keep",
		title: "Leave it in the native file and hide it from future reviews",
	},
	{
		value: "drop",
		label: "Drop",
		title: "Remove it from the native file; a backup is written first",
	},
];

interface MergedGroupListProps {
	sectionPrefix: "general" | "specific";
	groups: MergedGroup[];
	choices: Record<string, MergedChoice>;
	onBulkSet: (group: MergedGroup, action: MergedChoice) => void;
	onChoice: (key: string, choice: MergedChoice) => void;
	showTriageReason?: boolean;
}

function MergedGroupList({
	sectionPrefix,
	groups,
	choices,
	onBulkSet,
	onChoice,
	showTriageReason = false,
}: MergedGroupListProps) {
	return groups.map((group) => (
		<div key={group.key} className="reconcile-group">
			<div className="reconcile-group-head">
				<HarnessIconGroup ids={group.harnessIds} size={14} />
				<span className="reconcile-group-name">{group.label}</span>
				<span className="reconcile-group-files">
					{group.files.join(" · ")}
				</span>
				<div
					className="reconcile-bulk"
					role="group"
					aria-label={`All ${group.label} rules`}
				>
					<Button
						variant="soft"
						size="sm"
						aria-label={`Import all ${group.label} rules`}
						onClick={() => onBulkSet(group, "import")}
					>
						Import all
					</Button>
					<Button
						variant="ghost"
						size="sm"
						aria-label={`Leave all ${group.label} rules for later`}
						onClick={() => onBulkSet(group, "later")}
					>
						Later
					</Button>
				</div>
			</div>
			<div className="reconcile-rows">
				{group.rows.map((candidate, index) => {
					const key = mergedKey(candidate);
					const choice = choices[key];
					const kindStyle = {
						"--kind-accent": KIND_META[candidate.kind].accent,
					} as CSSProperties;
					const triage = showTriageReason
						? importCandidateTriage(candidate)
						: null;
					return (
						<div
							key={key}
							className="reconcile-row"
							data-testid="import-merged-row"
							data-choice={choice ?? "later"}
						>
							<span
								className="reconcile-kind"
								data-kind={candidate.kind}
								style={kindStyle}
							>
								{candidate.kind}
							</span>
							<div className="reconcile-rule-copy">
								<PatternText pattern={candidate.pattern} />
								{candidate.sources.some((source) =>
									source.file?.endsWith("settings.local.json"),
								) && (
									<Tag color="var(--fg-dim)" size="sm">
										session-accepted
									</Tag>
								)}
								{triage?.reason && (
									<span className="reconcile-triage-reason">
										{triage.reason}
									</span>
								)}
							</div>
							<ChipRadios
								name={`merged-${sectionPrefix}-${group.key}-${index}`}
								label={`Decision for ${candidate.pattern}`}
								value={choice ?? null}
								options={MERGED_OPTIONS}
								onChange={(value) => onChoice(key, value)}
								className="reconcile-choice"
							/>
						</div>
					);
				})}
			</div>
		</div>
	));
}

/**
 * Cross-harness reconcile dialog (D3 / permissions-divergence-fixes). Lists
 * discovered candidates grouped by source-harness set with per-group bulk
 * actions and per-row import/later/keep/drop. General rules stay visible;
 * likely one-off approvals collapse with guidance. No action has a default,
 * so Apply sends only the choices made in this review. Conflicts stay at the
 * top, previously-kept rules collapse with an un-keep affordance, and
 * un-importable Codex shapes stay read-only. Import/drop MOVE a rule out of
 * the native files (backup-first). Backed by the transactional
 * `permissions_reconcile_candidates` / `permissions_reconcile_apply` commands.
 */
export function ImportMergeDialog({
	open,
	scope,
	onClose,
	onApplied,
	harnessLabels,
}: ImportMergeDialogProps) {
	const [data, setData] = useState<ImportCandidateSet | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [mergedChoice, setMergedChoice] = useState<Record<string, MergedChoice>>(
		{},
	);
	const [conflictChoice, setConflictChoice] = useState<
		Record<string, ConflictChoice | undefined>
	>({});
	const [unkeep, setUnkeep] = useState<Record<string, boolean>>({});
	const [showSpecific, setShowSpecific] = useState(false);
	const [showKept, setShowKept] = useState(false);

	useEffect(() => {
		if (!open) return;
		setLoading(true);
		setError(null);
		// Clear stale data up front: a REJECTED refetch on reopen must not leave
		// last time's rows (and a now-stale Apply gate) sitting on screen.
		setData(null);
		invoke<ImportCandidateSet>("permissions_reconcile_candidates", { scope })
			.then((d) => {
				setData(d);
				// No rule gets a default action. The user can apply a small set and
				// leave every untouched rule in its native file for another review.
				setMergedChoice({});
				setConflictChoice({});
				setUnkeep({});
				setShowSpecific(false);
				setShowKept(false);
			})
			.catch((e) => setError(String(e)))
			.finally(() => setLoading(false));
	}, [open, scope]);

	const activeMerged = (data?.merged ?? []).filter((m) => !m.kept);
	const keptMerged = (data?.merged ?? []).filter((m) => m.kept);
	const conflicts = data?.conflicts ?? [];

	const triaged = useMemo(
		() => partitionImportCandidates(activeMerged),
		// `activeMerged` follows the fetched payload. `data` is its stable source.
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[data],
	);
	const generalGroups = useMemo(
		() => groupMerged(triaged.general, harnessLabels),
		[triaged.general, harnessLabels],
	);
	const specificGroups = useMemo(
		() => groupMerged(triaged.specific, harnessLabels),
		[triaged.specific, harnessLabels],
	);

	const buildDecisions = (): ImportDecision[] => {
		if (!data) return [];
		const out: ImportDecision[] = [];
		for (const m of activeMerged) {
			const action = mergedChoice[mergedKey(m)];
			if (action === undefined || action === "later") continue;
			out.push({ pattern: m.pattern, action, kind: m.kind });
		}
		for (const m of keptMerged) {
			if (unkeep[mergedKey(m)])
				out.push({ pattern: m.pattern, action: "unkeep", kind: m.kind });
		}
		for (const c of data.conflicts) {
			const choice = conflictChoice[c.pattern];
			if (choice === undefined || choice === "later") continue;
			if (choice === "both") {
				for (const [kind, harns] of Object.entries(c.options)) {
					out.push({
						pattern: c.pattern,
						action: "import",
						kind: kind as RuleKind,
						harnesses: harns,
					});
				}
			} else if (choice === "keep") {
				out.push({ pattern: c.pattern, action: "keep" });
			} else if (choice === "drop") {
				out.push({ pattern: c.pattern, action: "drop" });
			} else {
				out.push({
					pattern: c.pattern,
					action: "import",
					kind: choice as RuleKind,
				});
			}
		}
		return out;
	};

	async function apply() {
		setBusy(true);
		setError(null);
		try {
			await invoke<ImportApplyResult>("permissions_reconcile_apply", {
				scope,
				decisions: buildDecisions(),
			});
			onApplied();
			onClose();
		} catch (e) {
			setError(String(e));
		} finally {
			setBusy(false);
		}
	}

	if (!open) return null;

	const nothing =
		!!data &&
		data.merged.length === 0 &&
		data.conflicts.length === 0 &&
		data.un_importable.length === 0;

	// Footer summary: count only staged actions. Untouched rows and explicit
	// "Later" choices remain native and return on the next review.
	let importCount = 0;
	let keepCount = 0;
	let dropCount = 0;
	for (const m of activeMerged) {
		const choice = mergedChoice[mergedKey(m)];
		if (choice === "import") importCount++;
		else if (choice === "keep") keepCount++;
		else if (choice === "drop") dropCount++;
	}
	for (const c of conflicts) {
		const choice = conflictChoice[c.pattern];
		if (choice === "keep") keepCount++;
		else if (choice === "drop") dropCount++;
		else if (choice !== undefined && choice !== "later") importCount++;
	}
	const reSurfaceCount = Object.values(unkeep).filter(Boolean).length;
	const stagedCount = importCount + keepCount + dropCount + reSurfaceCount;
	const laterCount =
		activeMerged.length + conflicts.length - importCount - keepCount - dropCount;

	function bulkSet(group: MergedGroup, action: MergedChoice) {
		setMergedChoice((cur) => {
			const next = { ...cur };
			for (const m of group.rows) next[mergedKey(m)] = action;
			return next;
		});
	}

	return (
		<Modal
			open={open}
			onClose={onClose}
			title="Review native rules"
			width={860}
			className="reconcile-dialog"
			dismissable={!busy}
			footer={
				<>
					<span className="reconcile-summary">
						{importCount} import · {keepCount} keep · {dropCount} drop
						{reSurfaceCount > 0 && ` · ${reSurfaceCount} revisit`}
						{" · "}
						<span>{laterCount} later</span>
					</span>
					<Button variant="ghost" onClick={onClose} disabled={busy}>
						Close
					</Button>
					<Button
						variant="primary"
						busy={busy}
						disabled={busy || loading || nothing || stagedCount === 0}
						title={
							stagedCount === 0
								? "Choose one or more rules. Unselected rules stay native for later."
								: undefined
						}
						onClick={() => void apply()}
					>
						Apply selected
					</Button>
				</>
			}
		>
			<p className="reconcile-intro">
				Choose only the rules that you want to change. Unselected rules stay in
				their native files for the next review.
			</p>
			<p className="reconcile-intro-note">
				Import and Drop remove a rule from its native file. Skill Tree writes a
				backup first.
			</p>

			{loading && (
				<div className="reconcile-status" role="status">
					Discovering…
				</div>
			)}
			{!loading && nothing && (
				<div className="reconcile-status">
					Nothing to review. Native files match the registry.
				</div>
			)}
			{error && (
				<div className="reconcile-error" role="alert">
					{error}
				</div>
			)}

			{conflicts.length > 0 && (
				<section className="reconcile-section" data-section="conflicts">
					<SectionHeader
						label="Conflicts"
						count={conflicts.length}
						level={2}
						detail="choose any now · leave the rest for later"
					/>
					<div className="reconcile-rows">
						{conflicts.map((c, i) => {
							const choice = conflictChoice[c.pattern];
							const options: ChipRadioOption<ConflictChoice>[] = [
								...Object.keys(c.options).map((k) => ({
									value: k as ConflictChoice,
									label: k,
									title: `Import as ${k} for every harness`,
								})),
								{
									value: "both" as ConflictChoice,
									label: "both",
									title:
										"Import each decision pinned to the harness that made it",
								},
								{
									value: "later" as ConflictChoice,
									label: "later",
									title: "Do not change this rule now",
								},
								{
									value: "keep" as ConflictChoice,
									label: "keep",
									title: "Leave in the native files",
								},
								{
									value: "drop" as ConflictChoice,
									label: "drop",
									title:
										"Remove from the native files; a backup is written first",
								},
							];
							return (
								<div
									key={c.pattern}
									className="reconcile-row reconcile-conflict"
									data-testid="import-conflict-row"
									data-unresolved={choice === undefined || undefined}
								>
									<span className="reconcile-dot" aria-hidden="true" />
									<div>
										<PatternText pattern={c.pattern} />
										<div className="reconcile-votes">
											{Object.entries(c.options).map(([kind, harns], idx) => (
												<span key={kind}>
													{idx > 0 && <span className="sep"> · </span>}
													<HarnessIconGroup ids={harns} size={14} />{" "}
													<span>
														{harns
															.map((h) => harnessDisplayLabel(h, harnessLabels))
															.join(", ")}
													</span>{" "}
													→ <span data-kind={kind}>{kind}</span>
												</span>
											))}
										</div>
									</div>
									<ChipRadios
										name={`conflict-${i}`}
										label={`Decision for ${c.pattern}`}
										value={choice ?? null}
										options={options}
										onChange={(v) =>
											setConflictChoice((cur) => ({
												...cur,
												[c.pattern]: v,
											}))
										}
										className="reconcile-choice"
									/>
								</div>
							);
						})}
					</div>
				</section>
			)}

			{triaged.general.length > 0 && (
				<section className="reconcile-section" data-section="general">
					<SectionHeader
						label="General rules"
						count={triaged.general.length}
						level={2}
						detail="good candidates for reuse"
					/>
					<MergedGroupList
						sectionPrefix="general"
						groups={generalGroups}
						choices={mergedChoice}
						onBulkSet={bulkSet}
						onChoice={(key, choice) =>
							setMergedChoice((current) => ({ ...current, [key]: choice }))
						}
					/>
				</section>
			)}

			{triaged.specific.length > 0 && (
				<section className="reconcile-section" data-section="specific">
					<button
						type="button"
						className="reconcile-disclosure"
						data-testid="import-specific-toggle"
						aria-expanded={showSpecific}
						onClick={() => setShowSpecific((value) => !value)}
					>
						<Icon name="chevron-right" size={11} />
						<span className="reconcile-disclosure-label">
							Specific approvals
						</span>
						<span className="reconcile-disclosure-count">
							{triaged.specific.length}
						</span>
						<span className="reconcile-disclosure-detail">
							likely tied to one task or project
						</span>
					</button>
					<p className="reconcile-guidance">
						These rules look specific to one approval, task, path, or machine.
						Import a rule only if you want to reuse it.
					</p>
					{showSpecific && (
						<MergedGroupList
							sectionPrefix="specific"
							groups={specificGroups}
							choices={mergedChoice}
							onBulkSet={bulkSet}
							onChoice={(key, choice) =>
								setMergedChoice((current) => ({
									...current,
									[key]: choice,
								}))
							}
							showTriageReason
						/>
					)}
				</section>
			)}

			{keptMerged.length > 0 && (
				<section className="reconcile-section" data-section="kept">
					<button
						type="button"
						className="reconcile-kept-toggle"
						data-testid="import-kept-toggle"
						aria-expanded={showKept}
						onClick={() => setShowKept((v) => !v)}
					>
						<Icon name="chevron-right" size={11} />
						Previously kept ({keptMerged.length})
					</button>
					{showKept && (
						<div className="reconcile-rows">
							{keptMerged.map((m) => {
								const key = mergedKey(m);
								const kindStyle = {
									"--kind-accent": KIND_META[m.kind].accent,
								} as CSSProperties;
								return (
									<div
										key={key}
										className="reconcile-row"
										data-testid="import-kept-row"
										data-unkeep={unkeep[key] || undefined}
									>
										<span
											className="reconcile-kind"
											data-kind={m.kind}
											style={kindStyle}
										>
											{m.kind}
										</span>
										<PatternText pattern={m.pattern} />
										<Button
											variant="ghost"
											size="sm"
											aria-pressed={!!unkeep[key]}
											onClick={() =>
												setUnkeep((u) => ({
													...u,
													[key]: !u[key],
												}))
											}
										>
											{unkeep[key] ? "will re-surface" : "un-keep"}
										</Button>
									</div>
								);
							})}
						</div>
					)}
				</section>
			)}

			{data && data.un_importable.length > 0 && (
				<section className="reconcile-section" data-section="unimportable">
					<SectionHeader
						label="Not importable"
						count={data.un_importable.length}
						level={2}
						detail="left user-owned"
					/>
					<div className="reconcile-rows">
						{data.un_importable.map((u, i) => (
							<div
								key={i}
								className="reconcile-row"
								data-testid="import-unimportable-row"
							>
								<HarnessGlyph id={u.harness ?? "?"} size={14} />
								<span>
									<span className="reconcile-reason">
										{u.reason ?? "unsupported shape"}
									</span>
									{u.file && (
										<span className="reconcile-file">{basename(u.file)}</span>
									)}
								</span>
								<span className="reconcile-readonly">read-only</span>
							</div>
						))}
					</div>
				</section>
			)}
		</Modal>
	);
}
