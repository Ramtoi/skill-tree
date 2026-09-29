import { invoke } from "@/lib/ipc";
import { queryClient } from "@/lib/queryClient";
import { qk } from "@/lib/queryKeys";
import { invalidateRegistry } from "@/lib/invalidate";
import { runHubCmd } from "@/lib/hubCmd";
import { errorDetail } from "@/lib/cliOutput";
import { useToast } from "@/components/Toast";
import { UNDO_TOAST_DURATION_MS } from "@/hooks/useUndoableAction";
import { candidateIsRenamed, placeLabel } from "@/lib/mcpContract";
import type { McpApplySummary, McpCandidate, McpCandidateOption, McpFailure } from "@/lib/mcpContract";

interface McpDecision {
	name: string;
	action: "import" | "keep";
	harness?: string;
	scope?: string;
	/** W2: the CLI's own tiebreaker when two options share `(harness, scope)`
	 *  (INTERFACES §3: "`file` breaks a tie") — without it, such a pair fails
	 *  closed with an "ambiguous option" error from a surface whose entire
	 *  purpose is picking between them. */
	file?: string;
	/** Overrides the slugified `import_name` (E3 rev 2 §2.2) — sent only when
	 *  the candidate's own resolved import name differs from its `name` (the
	 *  compare sheet's rename affordance; today's callers never diverge, see
	 *  `adoptMcp` below, but the wire contract carries it regardless). */
	as?: string;
	allow_literal?: boolean;
	replace_with_ref?: boolean;
}

/**
 * The Library's "Detected MCP servers" band actions (design D5/M9) — one
 * decision per action, all piped through the same `mcp_reconcile_apply`
 * Tauri command. Split out of `SkillLibrary.tsx` (already in
 * `componentSizeGuard`'s `LEGACY_FILES` — a plan risk explicitly says not to
 * grow it further) rather than inlined, mirroring `useMcpCandidates.ts`'s
 * home for this wave's other new MCP plumbing.
 */
export function useMcpDecisions() {
	const toast = useToast();

	/** `hub mcp reconcile --apply --json` under the new Rust rule (E3 rev 2
	 *  §2.5) resolves even on a fail-closed exit — it never throws on a
	 *  structured `{"ok": false, ...}` object, so this is the ONE place that
	 *  turns `payload.ok === false` back into a thrown error, keeping every
	 *  caller's existing catch block (`${errorDetail(err).headline} Nothing
	 *  was changed.`) the single error path for both a hard IPC failure and a
	 *  structured refusal. */
	async function applyMcpDecision(decision: McpDecision): Promise<McpApplySummary> {
		const payload = await invoke<McpApplySummary | McpFailure>("mcp_reconcile_apply", {
			args: ["mcp", "reconcile", "--global", "--apply", "--decisions-stdin", "--json"],
			decisions: { decisions: [decision] },
		});
		if (payload.ok === false) {
			throw new Error(payload.error);
		}
		await invalidateRegistry(queryClient);
		await queryClient.invalidateQueries({ queryKey: qk.mcpCandidates("global") });
		return payload;
	}

	async function adoptMcp(
		cand: McpCandidate,
		opts: { allowLiteral?: boolean; replaceWithRef?: boolean; option?: McpCandidateOption } = {},
	) {
		try {
			const payload = await applyMcpDecision({
				name: cand.name,
				action: "import",
				harness: opts.option?.harness,
				scope: opts.option?.scope ?? undefined,
				file: opts.option?.file ?? undefined,
				// `cand.name` is already the RESOLVED slug — `as` overrides it
				// against the RAW native key(s) in `sources[]`, which is exactly
				// what `renamed_from:*` already says happened (E3 rev 2 §2.2:
				// "the resolved import name is what suggest_ref derives the
				// ${VAR} from"). Sent whenever a rename is in play so the CLI's
				// own `resolved_import_name` is never left to a coincidence.
				as: candidateIsRenamed(cand) ? (cand.import_name ?? cand.name) : undefined,
				allow_literal: opts.allowLiteral,
				replace_with_ref: opts.replaceWithRef,
			});
			// (W1) The apply is transactional, but a per-file failure during
			// the sync half (a harness file the adapter could not write) still
			// lands the registry import and exits zero, with the problem only
			// in `errors[]` — a bare success toast would hide that from the
			// one surface that could tell the user. `synced: false` means the
			// batch changed nothing that needed a sync (W9), which after an
			// error is worth saying too.
			if (payload.errors.length > 0) {
				const count = payload.errors.length;
				const syncNote = payload.synced
					? ""
					: " The change has not synced to your native config files yet.";
				toast.error(
					`Adopted ${cand.name} with ${count} problem${count === 1 ? "" : "s"}`,
					`${payload.errors[0]}${syncNote}`,
				);
				return;
			}
			// (W7) `Adopt as ${VAR}` names the variable the import actually
			// chose, so the user knows what to export.
			const suggested = payload.suggested_refs.find((r) => r.name === cand.name);
			// W1: an older `hub` may not emit these three fields yet — degrade
			// to the plain "Adopted <name>." title rather than throwing.
			const renamed = payload.renamed?.[0];
			const title = renamed ? `Adopted ${renamed.from} as ${renamed.to}.` : `Adopted ${cand.name}.`;
			const bodyParts: string[] = [];
			for (const r of payload.removed_native ?? []) {
				bodyParts.push(`Removed the ${placeLabel(r.harness, r.scope)} copy.`);
			}
			for (const c of payload.claimed ?? []) {
				bodyParts.push(`${placeLabel(c.harness, c.scope)} will be updated on the next sync.`);
			}
			if (suggested) {
				bodyParts.push(`Set ${suggested.var} in your shell; ${cand.name} reads it as \${${suggested.var}}.`);
			}
			toast.push({
				kind: "success",
				title,
				body: bodyParts.length > 0 ? bodyParts.join(" ") : undefined,
				duration: UNDO_TOAST_DURATION_MS,
				action: {
					label: "Undo",
					onClick: () => {
						void (async () => {
							try {
								// Undo archives the RESOLVED import name — `renamed[0].to`,
								// else `import_name`, else `name` (E3 rev 2 §2.6). A
								// removed native entry is not restored; the success
								// toast above already said so.
								const archiveName = renamed?.to ?? cand.import_name ?? cand.name;
								await runHubCmd(["archive", archiveName]);
								await invalidateRegistry(queryClient);
								await queryClient.invalidateQueries({ queryKey: qk.mcpCandidates("global") });
							} catch (err) {
								toast.error("Couldn't undo", errorDetail(err).headline);
							}
						})();
					},
				},
			});
		} catch (err) {
			// (W1) The apply is transactional on a hard failure — the registry
			// rolled back, so this really is nothing changing.
			toast.error(`Couldn't adopt ${cand.name}`, `${errorDetail(err).headline} Nothing was changed.`);
			throw err;
		}
	}

	async function keepMcp(cand: McpCandidate) {
		try {
			const payload = await applyMcpDecision({ name: cand.name, action: "keep" });
			if (payload.errors.length > 0) {
				toast.error(`Couldn't fully keep ${cand.name} native`, payload.errors[0]);
			}
		} catch (err) {
			toast.error(
				`Couldn't keep ${cand.name} native`,
				`${errorDetail(err).headline} Nothing was changed.`,
			);
			throw err;
		}
	}

	async function compareAdoptMcp(
		cand: McpCandidate,
		option: McpCandidateOption,
		opts: { allowLiteral?: boolean; replaceWithRef?: boolean } = {},
	) {
		await adoptMcp(cand, { option, ...opts });
	}

	return { adoptMcp, keepMcp, compareAdoptMcp };
}
