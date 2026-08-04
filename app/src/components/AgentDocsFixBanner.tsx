import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { Button } from "./Button";
import { CodeAreaDiff } from "./CodeArea";
import { Icon } from "./Icon";
import { useToast } from "./Toast";
import {
	applyAgentDocsFix,
	fetchAgentDocsFixPlan,
	readAgentDoc,
	resolveAgentDocsRoot,
} from "@/hooks/useAgentDocs";
import type {
	AgentDocFixPlan,
	AgentDocInstructionSet,
	AgentDocPolicyInfo,
	AgentDocResolveOp,
} from "@/types/agentDocs";

interface Props {
	projectName: string;
	projectPath: string;
	policy: AgentDocPolicyInfo;
	/** Instruction sets that deviate from canonical (verdict or flags). */
	deviations: AgentDocInstructionSet[];
	/** True while any editor buffer has unsaved changes — blocks apply. */
	anyDirty: boolean;
	/** Called after any successful mutation so the view reloads from disk. */
	onMutated: () => void;
}

function rootDeviation(deviations: AgentDocInstructionSet[]) {
	return deviations.find((s) => s.relative_dir === "") ?? null;
}

function bannerCopy(
	deviations: AgentDocInstructionSet[],
	policy: AgentDocPolicyInfo,
): string {
	const root = rootDeviation(deviations);
	const others = deviations.filter((s) => s.relative_dir !== "").length;
	const suffix =
		others > 0
			? ` ${root ? "·" : ""} ${others} nested ${others === 1 ? "directory deviates" : "directories deviate"}.`
			: "";
	if (!root) {
		return `Root layout is canonical, but${suffix}`;
	}
	switch (root.verdict) {
		case "claude_only":
			return (
				`Your other agents read AGENTS.md, but this project's real root is CLAUDE.md — ` +
				`only Claude Code sees it.${suffix}`
			);
		case "agents_only":
			return `Claude Code reads CLAUDE.md, which is missing — derive it from AGENTS.md (${policy.strategy}).${suffix}`;
		case "derived_drift":
			return `CLAUDE.md is derived, but not the way the ${policy.strategy} strategy expects — re-derive it.${suffix}`;
		case "replaced_derived":
			return `CLAUDE.md duplicates AGENTS.md byte-for-byte — collapse it back to the derived form.${suffix}`;
		case "conflict":
			return `CLAUDE.md and AGENTS.md have diverged — compare them and pick which content wins.${suffix}`;
		case "pointer_plus_content":
			return `CLAUDE.md gained content after its @AGENTS.md pointer (e.g. a memory append) — move it into AGENTS.md.${suffix}`;
		case "empty":
			return root.flags.includes("broken_link")
				? `The root instruction file is missing and a broken derived link remains.${suffix}`
				: `No root instruction file exists yet for this project.${suffix}`;
		default:
			// canonical-with-flags (legacy / broken artifacts)
			return root.flags.includes("legacy")
				? `Stale AGENT.md files found — no configured agent reads that name.${suffix}`
				: `Instruction-file artifacts need attention.${suffix}`;
	}
}

/**
 * The single conditional banner below the Agent Docs status line. Renders only
 * when the project deviates from all-canonical; offers exactly one primary
 * action (`Fix layout…`, or `Compare…`/`Resolve…` for states the fix plan
 * cannot decide). All verdicts come from the scanner — nothing is re-derived
 * from raw file flags here.
 */
export function AgentDocsFixBanner({
	projectName,
	projectPath,
	policy,
	deviations,
	anyDirty,
	onMutated,
}: Props) {
	const toast = useToast();
	const queryClient = useQueryClient();
	const [plan, setPlan] = useState<AgentDocFixPlan | null>(null);
	const [planOpen, setPlanOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const [compareOpen, setCompareOpen] = useState(false);
	const [compare, setCompare] = useState<{
		agents: string;
		claude: string;
	} | null>(null);
	const [absorbOpen, setAbsorbOpen] = useState(false);
	const [commitOptIn, setCommitOptIn] = useState(false);

	if (deviations.length === 0) return null;

	const root = rootDeviation(deviations);
	const isConflict = root?.verdict === "conflict";
	const isPointerPlus = root?.verdict === "pointer_plus_content";

	async function invalidate() {
		await queryClient.invalidateQueries({
			queryKey: ["agent-docs", projectPath],
		});
		await queryClient.invalidateQueries({
			queryKey: ["agent-docs-root-status", projectPath],
		});
		onMutated();
	}

	async function openPlan() {
		setBusy(true);
		try {
			const p = await fetchAgentDocsFixPlan(projectPath);
			setPlan(p);
			setPlanOpen(true);
		} catch (err) {
			toast.error("Couldn't build the fix plan", String(err));
		} finally {
			setBusy(false);
		}
	}

	async function applyPlan() {
		if (!plan) return;
		setBusy(true);
		try {
			const res = await applyAgentDocsFix(projectPath, plan, commitOptIn);
			if (!res.applied) {
				if (res.error === "disk_changed") {
					toast.error(
						"Disk changed since preview",
						"Nothing was changed. Re-open Fix layout to preview the current state.",
					);
					setPlanOpen(false);
					setPlan(null);
					await invalidate();
					return;
				}
				toast.error("Couldn't apply the fix", res.error ?? "unknown error");
				return;
			}
			const n = res.executed.length;
			const commitNote = res.commit
				? res.commit.committed
					? ` Committed ${res.commit.sha ?? ""}.`
					: ` Commit skipped: ${res.commit.reason ?? "unknown"}.`
				: "";
			toast.push({
				kind: "success",
				title: `${projectName}: layout fixed`,
				body:
					(n === 0
						? "Already canonical — nothing to do."
						: `${n} step${n === 1 ? "" : "s"} applied · ${res.backups.length} backup${res.backups.length === 1 ? "" : "s"}.`) +
					commitNote,
			});
			setPlanOpen(false);
			setPlan(null);
			await invalidate();
		} catch (err) {
			toast.error("Couldn't apply the fix", String(err));
		} finally {
			setBusy(false);
		}
	}

	async function openCompare() {
		setBusy(true);
		try {
			const [agents, claude] = await Promise.all([
				readAgentDoc(projectPath, "AGENTS.md"),
				readAgentDoc(projectPath, "CLAUDE.md"),
			]);
			setCompare({ agents: agents.content, claude: claude.content });
			setCompareOpen(true);
		} catch (err) {
			toast.error("Couldn't load both root files", String(err));
		} finally {
			setBusy(false);
		}
	}

	async function resolve(op: AgentDocResolveOp) {
		setBusy(true);
		try {
			const res = await resolveAgentDocsRoot({ projectPath, op, commit: commitOptIn });
			if (!res.applied) {
				toast.error("Couldn't resolve", res.error ?? "unknown error");
				return;
			}
			toast.push({
				kind: "success",
				title: `${projectName}: ${op.replace(/_/g, " ")} applied`,
				body: `${res.backups?.length ?? 0} backup${(res.backups?.length ?? 0) === 1 ? "" : "s"} written.`,
			});
			setCompareOpen(false);
			setAbsorbOpen(false);
			await invalidate();
		} catch (err) {
			toast.error("Couldn't resolve", String(err));
		} finally {
			setBusy(false);
		}
	}

	const primaryAction = isConflict ? (
		<Button size="sm" variant="primary" disabled={busy} onClick={() => void openCompare()}>
			Compare…
		</Button>
	) : isPointerPlus ? (
		<Button
			size="sm"
			variant="primary"
			disabled={busy}
			onClick={() => setAbsorbOpen(true)}
		>
			Resolve…
		</Button>
	) : (
		<Button size="sm" variant="primary" disabled={busy} onClick={() => void openPlan()}>
			Fix layout…
		</Button>
	);

	return (
		<>
			<div
				className="agent-docs-strip ad-fix-banner"
				data-tone={isConflict ? "conflict" : "fix"}
				data-testid="agent-docs-fix-banner"
			>
				<Icon name="warning" size={12} />
				<span className="ad-fix-banner-copy">
					{bannerCopy(deviations, policy)}
				</span>
				<span className="harness-strip-stretch" />
				{primaryAction}
			</div>

			{planOpen && plan && (
				<div className="ad-modal-backdrop" onClick={() => setPlanOpen(false)}>
					<div
						className="ad-modal ad-fix-plan"
						data-accent="amber"
						onClick={(e) => e.stopPropagation()}
					>
						<div className="ad-modal-head">
							<Icon name="warning" size={14} />
							<span>Fix layout — {projectName}</span>
						</div>
						<div className="ad-modal-body">
							{plan.steps.length === 0 &&
								plan.attention.length === 0 &&
								plan.flagged.length === 0 && (
									<p>Already canonical — nothing to do.</p>
								)}
							{plan.steps.length > 0 && (
								<ul className="ad-fix-steps">
									{plan.steps.map((step) => (
										<li key={step.id} data-optional={step.optional || undefined}>
											{step.optional ? (
												<label className="ad-fix-step-optin">
													<input
														type="checkbox"
														checked={step.selected}
														onChange={(e) => {
															const selected = e.currentTarget.checked;
															setPlan((p) =>
																p
																	? {
																			...p,
																			steps: p.steps.map((s) =>
																				s.id === step.id
																					? { ...s, selected }
																					: s,
																			),
																		}
																	: p,
															);
														}}
													/>
													<span>
														<span className="text-mono">
															{step.dir || "root"}
														</span>{" "}
														— {step.details}{" "}
														<span className="ad-fix-optin-tag">opt-in</span>
													</span>
												</label>
											) : (
												<span>
													<span className="text-mono">{step.dir || "root"}</span>{" "}
													— {step.details}
												</span>
											)}
										</li>
									))}
								</ul>
							)}
							{plan.attention.length > 0 && (
								<div className="ad-fix-attention">
									{plan.attention.map((a) => (
										<p key={`${a.dir}:${a.verdict}`}>
											<Icon name="warning" size={11} />{" "}
											<span className="text-mono">{a.dir || "root"}</span> —{" "}
											{a.details}
										</p>
									))}
								</div>
							)}
							{plan.flagged.length > 0 && (
								<div className="ad-fix-flagged">
									{plan.flagged.map((f) => (
										<p key={f.path}>
											<Icon name="warning" size={11} />{" "}
											<span className="text-mono">{f.path}</span> — {f.reason}
										</p>
									))}
								</div>
							)}
							<label className="ad-commit-optin">
								<input
									type="checkbox"
									checked={commitOptIn}
									onChange={(e) => setCommitOptIn(e.currentTarget.checked)}
									data-testid="agent-docs-commit-optin"
								/>
								<span>
									Commit the changed files to git with a prepared message
									(only the touched files; never pushes)
								</span>
							</label>
							<p className="ad-fix-footnote">
								Backup-first. Disk is re-checked at apply time — if anything
								changed since this preview, nothing is executed.
							</p>
							{anyDirty && (
								<p className="ad-fix-dirty-warning">
									<Icon name="warning" size={11} /> Unsaved editor changes —
									save or discard them before applying.
								</p>
							)}
						</div>
						<div className="ad-modal-foot">
							<Button onClick={() => setPlanOpen(false)}>Cancel</Button>
							<Button
								variant="primary"
								busy={busy}
								disabled={
									anyDirty ||
									(plan.steps.filter((s) => !s.optional || s.selected).length ===
										0)
								}
								onClick={() => void applyPlan()}
								data-testid="agent-docs-fix-apply"
							>
								Apply
							</Button>
						</div>
					</div>
				</div>
			)}

			{compareOpen && compare && (
				<div className="ad-modal-backdrop" onClick={() => setCompareOpen(false)}>
					<div
						className="ad-modal ad-compare-modal"
						data-accent="red"
						onClick={(e) => e.stopPropagation()}
					>
						<div className="ad-modal-head">
							<Icon name="warning" size={14} />
							<span>Divergent root files — {projectName}</span>
						</div>
						<div className="ad-modal-body">
							<p>
								<span className="text-mono">AGENTS.md</span> (left baseline) vs{" "}
								<span className="text-mono">CLAUDE.md</span> (right). Pick which
								content becomes the canonical root — the other file is backed up
								and re-derived. No automatic merge.
							</p>
							<div className="ad-compare-diff">
								<CodeAreaDiff
									original={compare.agents}
									current={compare.claude}
								/>
							</div>
							<label className="ad-commit-optin">
								<input
									type="checkbox"
									checked={commitOptIn}
									onChange={(e) => setCommitOptIn(e.currentTarget.checked)}
									data-testid="agent-docs-commit-optin"
								/>
								<span>
									Commit the changed files to git with a prepared message
									(only the touched files; never pushes)
								</span>
							</label>

							{anyDirty && (
								<p className="ad-fix-dirty-warning">
									<Icon name="warning" size={11} /> Unsaved editor changes —
									save or discard them before resolving.
								</p>
							)}
						</div>
						<div className="ad-modal-foot">
							<Button onClick={() => setCompareOpen(false)}>Cancel</Button>
							<Button
								disabled={busy || anyDirty}
								onClick={() => void resolve("keep_agents")}
							>
								Keep AGENTS.md
							</Button>
							<Button
								disabled={busy || anyDirty}
								onClick={() => void resolve("keep_claude")}
							>
								Keep CLAUDE.md
							</Button>
						</div>
					</div>
				</div>
			)}

			{absorbOpen && root && (
				<div className="ad-modal-backdrop" onClick={() => setAbsorbOpen(false)}>
					<div
						className="ad-modal"
						data-accent="amber"
						onClick={(e) => e.stopPropagation()}
					>
						<div className="ad-modal-head">
							<Icon name="warning" size={14} />
							<span>Move appendix into AGENTS.md</span>
						</div>
						<div className="ad-modal-body">
							<p>
								<span className="text-mono">CLAUDE.md</span> contains content
								after its <span className="text-mono">@AGENTS.md</span> pointer.
								This moves it verbatim to the end of{" "}
								<span className="text-mono">AGENTS.md</span> and restores the
								pure pointer. Nothing is lost; both files are backed up.
							</p>
							<pre className="ad-absorb-preview">
								{root.appendix ?? "(appendix unavailable — re-run the scan)"}
							</pre>
							<label className="ad-commit-optin">
								<input
									type="checkbox"
									checked={commitOptIn}
									onChange={(e) => setCommitOptIn(e.currentTarget.checked)}
									data-testid="agent-docs-commit-optin"
								/>
								<span>
									Commit the changed files to git with a prepared message
									(only the touched files; never pushes)
								</span>
							</label>

							{anyDirty && (
								<p className="ad-fix-dirty-warning">
									<Icon name="warning" size={11} /> Unsaved editor changes —
									save or discard them before resolving.
								</p>
							)}
						</div>
						<div className="ad-modal-foot">
							<Button onClick={() => setAbsorbOpen(false)}>Cancel</Button>
							<Button
								variant="primary"
								disabled={busy || anyDirty}
								onClick={() => void resolve("absorb_appendix")}
							>
								Move appendix
							</Button>
						</div>
					</div>
				</div>
			)}
		</>
	);
}
