import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/Button";
import { Icon } from "@/components/Icon";
import { useAgentDocsListing } from "@/hooks/useAgentDocs";
import { useRegistry } from "@/hooks/useRegistry";
import type { AgentDocFile, AgentDocFolder, AgentDocsListing } from "@/types/agentDocs";
import type { SnippetLocation } from "@/types/snippets";

const KNOWN_ROOTS = ["AGENTS.md", "CLAUDE.md"];
const AGENT_DOC_BASENAMES = new Set(["CLAUDE.md", "AGENTS.md", "AGENT.md"]);

interface TargetOption {
	rel: string;
	exists: boolean;
	isSymlink: boolean;
	symlinkTo: string | null;
	derived: boolean;
	already: boolean;
	valid: boolean;
}

function flattenFiles(folder: AgentDocFolder, base = ""): AgentDocFile[] {
	const here = base ? `${base}/` : "";
	const files = folder.files.map((f) => ({ ...f, rel: f.rel || `${here}${f.name}` }));
	return [
		...files,
		...folder.dirs.flatMap((d) => flattenFiles(d, `${here}${d.name}`)),
	];
}

function buildTargets(
	listing: AgentDocsListing | undefined,
	appliedRels: Set<string>,
): TargetOption[] {
	const byRel = new Map<string, AgentDocFile>();
	if (listing) {
		for (const f of flattenFiles(listing.root)) {
			if (AGENT_DOC_BASENAMES.has(f.name)) byRel.set(f.rel, f);
		}
	}
	// Root CLAUDE.md derived from AGENTS.md (symlink or @AGENTS.md import) —
	// the canonical-root model says: apply to AGENTS.md instead. Read straight
	// from the scanner verdict; never re-derived from raw file flags.
	const rootSet = listing?.instruction_sets.find((s) => s.relative_dir === "");
	const claudeDerived =
		listing?.policy.derived === "CLAUDE.md" &&
		!!rootSet &&
		["canonical", "derived_drift", "pointer_plus_content"].includes(
			rootSet.verdict,
		);

	const rels = [
		...KNOWN_ROOTS,
		...[...byRel.keys()].filter((r) => !KNOWN_ROOTS.includes(r)).sort(),
	];
	return rels.map((rel) => {
		const f = byRel.get(rel);
		const exists = !!f?.exists;
		const isSymlink = !!f?.is_symlink;
		const derived = rel === "CLAUDE.md" && (isSymlink || claudeDerived);
		const already = appliedRels.has(rel);
		return {
			rel,
			exists,
			isSymlink,
			symlinkTo: f?.symlink_to ?? null,
			derived,
			already,
			valid: !isSymlink && !derived && !already,
		};
	});
}

function canonicalRel(targets: TargetOption[]): string {
	const agents = targets.find((t) => t.rel === "AGENTS.md");
	const claude = targets.find((t) => t.rel === "CLAUDE.md");
	if (agents?.exists && agents.valid) return "AGENTS.md";
	if (claude?.exists && claude.valid) return "CLAUDE.md";
	return "AGENTS.md";
}

export interface ApplyToDialogProps {
	snippetName: string;
	/** Locations the snippet is already applied to (scan-derived). */
	locations: SnippetLocation[];
	onClose: () => void;
	onApply: (project: string, rel: string) => void;
}

/** Pick a registered project, then one of its agent doc files. Invalid targets
 *  (symlinks, derived CLAUDE.md, already-applied files) are disabled with a
 *  hint — never hidden. The canonical root is preselected. */
export function ApplyToDialog({
	snippetName,
	locations,
	onClose,
	onApply,
}: ApplyToDialogProps) {
	const { data: registry } = useRegistry();
	const projects = useMemo(
		() => Object.entries(registry?.projects ?? {}).sort(([a], [b]) => a.localeCompare(b)),
		[registry],
	);
	const [project, setProject] = useState<string | null>(projects[0]?.[0] ?? null);
	useEffect(() => {
		if (!project && projects.length) setProject(projects[0][0]);
	}, [projects, project]);

	const projectPath = project ? registry?.projects[project]?.path : undefined;
	const { data: listing } = useAgentDocsListing(projectPath);

	const appliedRels = useMemo(
		() =>
			new Set(
				locations.filter((l) => l.project === project).map((l) => l.rel),
			),
		[locations, project],
	);
	const targets = useMemo(
		() => buildTargets(listing, appliedRels),
		[listing, appliedRels],
	);

	const [rel, setRel] = useState<string | null>(null);
	useEffect(() => {
		setRel(canonicalRel(targets));
		// re-preselect when the project (and thus target list) changes
	}, [project, listing]); // eslint-disable-line react-hooks/exhaustive-deps

	const canonical = useMemo(() => canonicalRel(targets), [targets]);
	const chosen = targets.find((t) => t.rel === rel);
	const canApply = !!project && !!chosen && chosen.valid;

	return (
		<div className="ad-modal-backdrop" onClick={onClose}>
			<div
				className="ad-modal snip-apply"
				onClick={(e) => e.stopPropagation()}
				style={{ width: "min(620px, calc(100vw - 64px))" }}
			>
				<div className="ad-modal-head">
					<Icon name="plus" size={13} /> Apply
					<span className="text-mono" style={{ color: "var(--violet-2)" }}>
						&nbsp;{snippetName}
					</span>
				</div>
				<div className="ad-modal-body" style={{ padding: 0 }}>
					<div className="snip-apply-grid">
						<div className="snip-apply-col">
							<div className="snip-apply-label">Project</div>
							<div className="snip-apply-projects">
								{projects.length === 0 && (
									<div className="snip-picker-empty">No registered projects.</div>
								)}
								{projects.map(([name, cfg]) => (
									<button
										key={name}
										type="button"
										className="snip-apply-proj"
										aria-pressed={project === name}
										onClick={() => setProject(name)}
									>
										<Icon name="project" size={12} />
										<span className="snip-apply-proj-name">{name}</span>
										<span className="snip-apply-proj-path">{cfg.path}</span>
									</button>
								))}
							</div>
						</div>
						<div className="snip-apply-col snip-apply-files">
							<div className="snip-apply-label">
								Target file <span className="text-dim">· appended to the end</span>
							</div>
							<div className="snip-apply-filelist">
								{targets.map((t) => {
									const disabled = !t.valid;
									return (
										<label
											key={t.rel}
											className="snip-apply-file"
											data-disabled={disabled || undefined}
											aria-pressed={rel === t.rel}
										>
											<input
												type="radio"
												name="apply-target"
												disabled={disabled}
												checked={rel === t.rel}
												onChange={() => setRel(t.rel)}
											/>
											<span className="snip-apply-file-main">
												<span className="snip-apply-file-rel">{t.rel}</span>
												<span className="snip-apply-file-hint">
													{t.isSymlink ? (
														<>symlink → {t.symlinkTo ?? "…"} · apply to the source</>
													) : t.derived ? (
														<>derived pointer · apply to AGENTS.md</>
													) : t.already ? (
														"already applied here"
													) : !t.exists ? (
														"will be created"
													) : t.rel === canonical ? (
														"canonical root"
													) : (
														"on disk"
													)}
												</span>
											</span>
											{t.isSymlink && (
												<Icon name="link" size={11} className="snip-apply-file-icon" />
											)}
										</label>
									);
								})}
							</div>
						</div>
					</div>
				</div>
				<div className="ad-modal-foot">
					<Button variant="ghost" onClick={onClose}>
						Cancel
					</Button>
					<Button
						variant="primary"
						icon="plus"
						disabled={!canApply}
						onClick={() => {
							if (project && rel && canApply) onApply(project, rel);
						}}
					>
						Apply to {rel ?? "…"}
					</Button>
				</div>
			</div>
		</div>
	);
}
