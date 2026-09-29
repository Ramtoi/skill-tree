import type { ReactNode } from "react";
import { Modal } from "@/components/Modal";
import { Button } from "@/components/Button";
import { Icon } from "@/components/Icon";
import { Toggle } from "@/components/Toggle";
import { PathText } from "@/components/PathText";
import { plural } from "@/lib/plural";
import type { UseRenameCascade } from "@/hooks/useRenameCascade";
import { RENAME_STEPS, type RenamePlan, type RenameRefKind, type RenameSkipReason } from "@/types/renameRefs";

export interface RenameRefsDialogProps {
	cascade: UseRenameCascade;
	/** A `snippets_outdated` name was clicked — navigate there, bypassing the
	 *  unsaved-changes guard (it's a navigation the user just consented to,
	 *  not a second write consent). */
	onOpenSnippet: (name: string) => void;
}

/** One skip reason → the sentence §Dialog states pins, for one skip item.
 *  Every `plan.skipped` / `result.skipped` row already carries its own
 *  `count`, so this never aggregates across rows — each renders its own
 *  line/row. */
function skipSentence(kind: RenameRefKind, name: string, reason: RenameSkipReason, count: number): string {
	// `count` is mentions, never files: a skipped skill with two hits is one
	// row that reads "2 mentions". Rows whose scan never got to counting
	// (unparseable, unreadable) carry 0 and name the file instead.
	const mentions = `${count} mention${count === 1 ? "" : "s"}`;
	switch (reason) {
		case "source-managed":
			return `Skipped ${mentions} in a source-managed skill (${name}) — hub never rewrites a source checkout.`;
		case "snippet-owned":
			return `Skipped ${mentions} inside a snippet block (${name}) — update the snippet instead.`;
		case "unparseable-frontmatter":
			return `Skipped ${name} — its frontmatter fence never closes.`;
		case "project-quarantined":
			return `Skipped ${mentions} in a quarantined project (${name}) — fix its path first.`;
		default:
			return `Skipped ${name} — ${kind === "agent_doc" ? "the file" : "it"} could not be read.`;
	}
}

function reviewBody(plan: RenamePlan): string {
	const { refs, files } = plan.totals;
	if (refs === 0) return "Nothing can be rewritten automatically.";
	return `${refs} ${plural(refs, "reference")} in ${files} ${plural(files, "file")} name this skill.`;
}

function GroupHead({ testid, children }: { testid: string; children: ReactNode }) {
	return (
		<div className="rename-refs-group-head" data-testid={testid}>
			{children}
		</div>
	);
}

function Row({ kind, mono, count }: { kind: RenameRefKind; mono: string; count: number }) {
	return (
		<li className="rename-refs-row" data-testid="rename-refs-row" data-kind={kind}>
			<span className="text-mono rename-refs-row-name">{mono}</span>
			<span className="rename-refs-count">{count}×</span>
		</li>
	);
}

/** The plan's grouped, sorted referrer list — the review AND running phases
 *  share this exact markup (running only adds `data-dimmed`). */
function ReferrerList({ plan, dimmed }: { plan: RenamePlan; dimmed: boolean }) {
	const { skills, snippets, agent_docs: agentDocRows } = plan.referrers;
	return (
		<ul className="rename-refs-list" data-dimmed={dimmed || undefined}>
			{skills.length > 0 && (
				<li className="rename-refs-group">
					<GroupHead testid="rename-refs-group-skills">SKILLS · {skills.length}</GroupHead>
					<ul>
						{skills.map((s) => (
							<Row key={s.name} kind="skill" mono={s.name} count={s.count} />
						))}
					</ul>
				</li>
			)}
			{snippets.length > 0 && (
				<li className="rename-refs-group">
					<GroupHead testid="rename-refs-group-snippets">SNIPPETS · {snippets.length}</GroupHead>
					<ul>
						{snippets.map((s) => (
							<Row key={s.name} kind="snippet" mono={s.name} count={s.count} />
						))}
					</ul>
					<p className="rename-refs-snippet-note" data-testid="rename-refs-snippet-note">
						Applied copies in your projects will read outdated until you update them.
					</p>
				</li>
			)}
			{agentDocRows.length > 0 && (
				<li className="rename-refs-group">
					<GroupHead testid="rename-refs-group-agent-docs">
						{`AGENT DOCS · ${plan.totals.agent_docs} ${plural(plan.totals.agent_docs, "file")} in ${plan.totals.projects} ${plural(plan.totals.projects, "project")}`}
					</GroupHead>
					<ul>
						{agentDocRows.map((a) => (
							<li
								key={`${a.project}/${a.rel}`}
								className="rename-refs-row"
								data-testid="rename-refs-row"
								data-kind="agent_doc"
							>
								<PathText path={`${a.project}/${a.rel}`} className="text-mono rename-refs-row-name" />
								<span className="rename-refs-count">{a.count}×</span>
							</li>
						))}
					</ul>
				</li>
			)}
		</ul>
	);
}

function StepRow({ label, state }: { label: string; state: "pending" | "busy" | "done" }) {
	return (
		<li className="rename-refs-step" data-testid="rename-refs-step" data-state={state}>
			{state === "done" ? (
				<Icon name="check" size={12} tone="green" />
			) : state === "busy" ? (
				<span className="btn-spinner" aria-hidden="true" />
			) : (
				<span className="rename-refs-step-dot" aria-hidden="true" />
			)}
			<span>{label}</span>
		</li>
	);
}

/** The disclosure result: one row per rewritten/skipped/error outcome,
 *  reusing `rename-refs-row`. */
function ResultRows({ cascade, onOpenSnippet }: RenameRefsDialogProps & { cascade: UseRenameCascade }) {
	const result = cascade.result;
	if (!result) return null;
	const backupDir = result.rewritten.find((r) => r.backup)?.backup?.replace(/\/[^/]+$/, "");
	return (
		<>
			<ul className="rename-refs-list">
				{result.rewritten.map((r) => (
					<li key={`${r.kind}-${r.name}`} className="rename-refs-row" data-testid="rename-refs-row" data-kind={r.kind}>
						<Icon name="check" size={12} tone="green" />
						<span className="text-mono rename-refs-row-name">{r.name}</span>
						<span className="rename-refs-count">{r.count}×</span>
					</li>
				))}
				{result.skipped.map((s) => (
					<li
						key={`${s.kind}-${s.name}`}
						className="rename-refs-row text-mute"
						data-testid="rename-refs-row"
						data-kind={s.kind}
					>
						<span aria-hidden="true">–</span>
						<span>{skipSentence(s.kind, s.name, s.reason, s.count)}</span>
					</li>
				))}
			</ul>
			{result.errors.length > 0 && (
				<div className="rename-refs-errors" data-testid="rename-refs-errors">
					{result.errors.map((e) => (
						<div key={`${e.kind}-${e.name}`} className="rename-refs-error-row">
							<Icon name="x" size={12} tone="red" />
							<PathText path={e.path ?? e.name} className="text-mono" />
							<span>{e.error}</span>
							{e.hint && <span className="text-mute">{e.hint}</span>}
						</div>
					))}
					<p className="rename-refs-errors-note">
						These files still name {cascade.old}. Edit them by hand
						{backupDir ? (
							<>
								, or restore from <PathText path={backupDir} /> and try again.
							</>
						) : (
							"."
						)}
					</p>
				</div>
			)}
			{result.snippets_outdated.length > 0 &&
				result.snippets_outdated.map((name) => (
					<p key={name} className="rename-refs-snippet-note">
						<button
							type="button"
							className="rename-refs-snippet-link"
							data-testid="rename-refs-snippet-link"
							onClick={() => onOpenSnippet(name)}
						>
							{name}
						</button>{" "}
						now reads outdated where it is applied.
					</p>
				))}
		</>
	);
}

/**
 * The rename-cascade confirmation/progress/disclosure dialog (plans/3.md
 * §Editor flow "Dialog states"). A `Modal`, not `ConfirmDialog`: the footer
 * carries two actions plus an agent-docs toggle, which `ConfirmDialog`'s
 * one-confirm preset has no slot for. Reuses `className="confirm-dialog"` so
 * `.confirm-body` / `.confirm-blast` styling still applies.
 */
export function RenameRefsDialog({ cascade, onOpenSnippet }: RenameRefsDialogProps) {
	const { phase, plan, agentDocs, setAgentDocs, step, old, next } = cascade;
	if (phase === "idle") return null;

	const running = phase === "running";
	const disclosed = phase === "result";
	const failed = phase === "failed";
	const saveFailed = disclosed && cascade.saveError !== null;

	const title = failed ? (
		cascade.error ?? "Rename failed"
	) : disclosed && saveFailed ? (
		<>
			Renamed to <span className="text-mono">{next}</span>, but saving the document failed
		</>
	) : disclosed ? (
		<>
			Renamed to <span className="text-mono">{next}</span>
		</>
	) : (
		<>
			Rename <span className="text-mono">{old}</span> to <span className="text-mono">{next}</span>?
		</>
	);

	const confirmCount = plan ? plan.totals.library_refs + (agentDocs ? plan.totals.agent_doc_refs : 0) : 0;

	const footer = failed ? (
		<Button variant="primary" onClick={cascade.dismiss} data-testid="rename-refs-close">
			Close
		</Button>
	) : disclosed ? (
		saveFailed ? (
			<>
				<Button variant="ghost" onClick={cascade.stay} data-testid="rename-refs-stay">
					Stay here
				</Button>
				<Button variant="primary" onClick={cascade.dismiss} data-testid="rename-refs-open-renamed">
					Open {next}
				</Button>
			</>
		) : (
			<Button variant="primary" onClick={cascade.dismiss} data-testid="rename-refs-done">
				Done
			</Button>
		)
	) : (
		<>
			<Button
				variant="ghost"
				onClick={cascade.cancel}
				disabled={running}
				disabledReason={running ? "The rewrite is running" : undefined}
				data-testid="rename-refs-cancel"
			>
				Cancel
			</Button>
			<Button
				variant="primary"
				busy={running}
				disabled={running}
				disabledReason={running ? "The rewrite is running" : undefined}
				onClick={() => void cascade.confirm()}
				data-testid="rename-refs-rewrite"
			>
				{confirmCount === 0 ? "Rename" : `Rename and rewrite ${confirmCount}`}
			</Button>
		</>
	);

	return (
		<Modal
			open
			onClose={disclosed || failed ? cascade.dismiss : cascade.cancel}
			dismissable={!running}
			title={title}
			aria-label={failed ? undefined : disclosed ? `Renamed to ${next}` : `Rename ${old} to ${next}?`}
			width={520}
			className="confirm-dialog"
			footer={footer}
		>
			<div data-testid="rename-refs-dialog">
				{!failed && plan && !disclosed && (
					<>
						<p className="confirm-body">{reviewBody(plan)}</p>
						{plan.totals.refs > 0 && <ReferrerList plan={plan} dimmed={running} />}
						{running && (
							<ul className="rename-refs-step-list">
								<StepRow label={RENAME_STEPS[0].label(confirmCount)} state={step > 1 ? "done" : "busy"} />
								<StepRow label={RENAME_STEPS[1].label()} state={step >= 2 ? "busy" : "pending"} />
							</ul>
						)}
						<div className="confirm-blast">
							<div className="rename-refs-agent-docs">
								<Toggle
									checked={agentDocs}
									onChange={setAgentDocs}
									disabled={running || plan.totals.agent_doc_refs === 0}
									dataTestid="rename-refs-agent-docs"
									label="Also rewrite project agent docs"
								/>
								<p className="text-dim rename-refs-toggle-hint">
									{plan.totals.agent_doc_refs === 0
										? "No agent doc names this skill."
										: "Writes AGENTS.md and CLAUDE.md inside your repos. Hub backs up every file first."}
								</p>
							</div>
							{plan.skipped.length > 0 && (
								<ul className="rename-refs-skipped" data-testid="rename-refs-skipped">
									{plan.skipped.map((s) => (
										<li key={`${s.kind}-${s.name}`}>{skipSentence(s.kind, s.name, s.reason, s.count)}</li>
									))}
								</ul>
							)}
						</div>
					</>
				)}
				{disclosed && (
					<>
						<ResultRows cascade={cascade} onOpenSnippet={onOpenSnippet} />
						{saveFailed && (
							<div className="rename-refs-errors" data-testid="rename-refs-save-error">
								{cascade.saveError}. Your edits are still in this editor. Leaving without saving loses them.
							</div>
						)}
					</>
				)}
			</div>
		</Modal>
	);
}
