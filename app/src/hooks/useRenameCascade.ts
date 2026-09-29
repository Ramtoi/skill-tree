import { useCallback, useRef, useState } from "react";
import { hubCmd, hubStreams, HubCommandError, type HubResult } from "@/lib/hubCmd";
import { parseCliJson } from "@/lib/skillPack";
import { invalidateRegistry } from "@/lib/invalidate";
import { queryClient } from "@/lib/queryClient";
import { trackProcess } from "@/lib/trackProcess";
import { errorDetail } from "@/lib/cliOutput";
import { plural } from "@/lib/plural";
import { useToast } from "@/components/Toast";
import {
	RENAME_STEPS,
	type RenameCascadePhase,
	type RenamePlan,
	type RenameResult,
} from "@/types/renameRefs";

function renameSuccessBody(result: RenameResult): string {
	const refs = result.rewritten.reduce((n, r) => n + r.count, 0);
	const files = result.rewritten.length;
	return `renamed · ${refs} ${plural(refs, "reference")} in ${files} ${plural(files, "file")} rewritten`;
}

function renameFailedHeadline(result: RenameResult): string {
	const total = result.rewritten.length + result.errors.length;
	return `${result.errors.length} of ${total} ${plural(total, "file")} could not be rewritten`;
}

export interface UseRenameCascadeOptions {
	/** Writes SKILL.md + registry meta (the existing `save_skill_full`
	 *  invoke). `invokeName` is what Rust sees as the CURRENT name — the
	 *  route name on the plain-save path, the NEW name on the confirm path
	 *  (so Rust sees `current_name === target_name` and skips its own
	 *  rename); `docName` is always the canonical name being saved to. */
	writeSkill: (invokeName: string, docName: string) => Promise<string>;
	/** Bookkeeping once a write has landed: saved-content refs, `dirty`.
	 *  Never navigates — `onLeave` below owns that, separately, because a
	 *  disclosure result defers navigation to the user's own `Done` click. */
	onSaved: (updatedName: string) => void;
	/** Navigate to the renamed skill, bypassing the unsaved-changes guard. */
	onLeave: (updatedName: string) => void;
}

export interface UseRenameCascade {
	phase: RenameCascadePhase;
	plan: RenamePlan | null;
	result: RenameResult | null;
	error: string | null;
	saveError: string | null;
	agentDocs: boolean;
	setAgentDocs: (v: boolean) => void;
	/** Two-row `data-state` driver for the `running` phase — `RENAME_STEPS[0]`
	 *  is busy while `step === 1`, done once `step === 2`. */
	step: 1 | 2;
	/** The names `begin()` was last called with — what the dialog titles and
	 *  the post-rename navigation are built from. */
	old: string;
	next: string;
	/** Plan → maybe review. Returns `true` when the caller should proceed with
	 *  its OWN normal write (nothing to disclose, or the preflight itself
	 *  failed); `false` once the dialog owns the flow. */
	begin: (old: string, next: string) => Promise<boolean>;
	confirm: () => void;
	cancel: () => void;
	dismiss: () => void;
	stay: () => void;
}

/**
 * Owns the rename-cascade flow end to end: the `--dry-run` preflight, the
 * review dialog's state, the confirmed rewrite, and the disclosure result —
 * so `SkillEditor.save()` only ever gains one branch (plans/3.md §Editor
 * flow "Where the state lives").
 */
export function useRenameCascade(opts: UseRenameCascadeOptions): UseRenameCascade {
	const { writeSkill, onSaved, onLeave } = opts;
	const toast = useToast();
	const [phase, setPhase] = useState<RenameCascadePhase>("idle");
	const [names, setNames] = useState<{ old: string; next: string }>({ old: "", next: "" });
	const [plan, setPlan] = useState<RenamePlan | null>(null);
	const [result, setResult] = useState<RenameResult | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [saveError, setSaveError] = useState<string | null>(null);
	const parsedResult = useRef<RenameResult | null>(null);
	const [agentDocs, setAgentDocs] = useState(false);
	const [step, setStep] = useState<1 | 2>(1);

	const begin = useCallback(
		async (old: string, next: string): Promise<boolean> => {
			setAgentDocs(false);
			setResult(null);
			setError(null);
			setSaveError(null);
			parsedResult.current = null;
			setNames({ old, next });
			let res: HubResult | null = null;
			try {
				res = await hubCmd(["rename", old, next, "--dry-run", "--json"]);
			} catch {
				/* falls through to the fallback toast below */
			}
			let dryPlan: RenamePlan | null = null;
			if (res) {
				try {
					dryPlan = parseCliJson<RenamePlan>(hubStreams(res).stdout);
				} catch {
					/* unparseable — falls through too */
				}
			}
			if (!res || !res.success || !dryPlan) {
				toast.error(
					"Could not check for references",
					`Renaming anyway. Other files may still name ${old}.`,
				);
				return true;
			}
			if (dryPlan.totals.refs === 0 && dryPlan.skipped.length === 0) return true;
			setPlan(dryPlan);
			setPhase("review");
			return false;
		},
		[toast],
	);

	const confirm = useCallback(async () => {
		if (phase !== "review" || !plan) return;
		const { old, next } = names;
		const n = plan.totals.library_refs + (agentDocs ? plan.totals.agent_doc_refs : 0);
		const args = [
			"rename",
			old,
			next,
			"--rewrite-refs",
			...(agentDocs ? ["--rewrite-agent-docs"] : []),
			"--json",
		];
		parsedResult.current = null;
		setStep(1);
		setPhase("running");
		try {
			const outcome = await trackProcess(
				{ title: `Renaming ${old}`, body: RENAME_STEPS[0].label(n), kind: "fs", steps: 2 },
				async (ctl) => {
					const res = await hubCmd(args);
					let payload: RenameResult;
					try {
						payload = parseCliJson<RenameResult>(hubStreams(res).stdout);
					} catch {
						throw new HubCommandError(res, args);
					}
					parsedResult.current = payload;
					setStep(2);
					ctl.update({ step: 2, body: RENAME_STEPS[1].label() });
					const updatedName = await writeSkill(next, next);
					await invalidateRegistry(queryClient);
					return { payload, updatedName };
				},
				{
					successBody: ({ payload }) => renameSuccessBody(payload),
					failWhen: ({ payload }) =>
						payload.errors.length > 0 ? renameFailedHeadline(payload) : null,
				},
			);
			setResult(outcome.payload);
			onSaved(outcome.updatedName);
			if (outcome.payload.errors.length === 0 && outcome.payload.skipped.length === 0) {
				setPhase("idle");
				setPlan(null);
				onLeave(outcome.updatedName);
			} else {
				setPhase("result");
			}
			} catch (err) {
				const detail = errorDetail(err).headline;
				if (parsedResult.current) {
					setResult(parsedResult.current);
					setSaveError(detail);
					setPhase("result");
				} else {
					setError(detail);
					setPhase("failed");
				}
			}
		}, [phase, plan, names, agentDocs, writeSkill, onSaved, onLeave]);

	const cancel = useCallback(() => {
		setPhase("idle");
		setPlan(null);
		setSaveError(null);
	}, []);

	const dismiss = useCallback(() => {
		const hadResult = phase === "result";
		setPhase("idle");
		setPlan(null);
		setResult(null);
		setError(null);
		setSaveError(null);
		if (hadResult) onLeave(names.next);
		// A subprocess crash leaves the truth unknown from here — re-read the
		// registry rather than guess (§Editor flow "Failure of the whole
		// subprocess").
		else void invalidateRegistry(queryClient);
	}, [phase, names, onLeave]);

	const stay = useCallback(() => {
		setPhase("idle");
		setPlan(null);
		setResult(null);
		setError(null);
		setSaveError(null);
	}, []);

	return {
		phase,
		plan,
		result,
		error,
		saveError,
		agentDocs,
		setAgentDocs,
		step,
		old: names.old,
		next: names.next,
		begin,
		confirm,
		cancel,
		dismiss,
		stay,
	};
}
