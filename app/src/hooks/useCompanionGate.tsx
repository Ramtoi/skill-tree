import { create } from "zustand";
import { runHubCmd } from "@/lib/hubCmd";
import { errorDetail } from "@/lib/cliOutput";
import { runWithGate } from "@/lib/hubWrite";
import type { NeedsCompanions } from "@/lib/companions";
import { CompanionConsequenceDialog } from "@/components/companions/CompanionConsequenceDialog";

/**
 * The exit-2 companion gate (I1/A4/D2), plan 2 §Approach "The exit-2 seam" +
 * "Six call sites, one gate". `equipWithGate` is the ONE place `hub enable
 * <skill> --project <p>` runs on a call site that must honor the gate — every
 * consumer (component hooks via `useCompanionGate()`, and the two module-scope
 * callers, `paletteVerbs.ts`'s `equip-skill` verb and `ProjectWorkspace`'s
 * disable-undo replay) imports this same function, so there is exactly one
 * place a `needs_provisioning` payload turns into a dialog.
 *
 * State lives in a tiny module-level Zustand store rather than React Context:
 * `paletteVerbs.ts` runs its verbs OUTSIDE any component (mirroring
 * `pushToastDirect`'s `useAppStore.getState()` pattern in that same file), so
 * a Context provider's value would be unreachable there. `CompanionGateProvider`
 * subscribes to the store and portals the dialog; `useCompanionGate()` is a
 * thin hook wrapper for component call sites, returning the SAME stable
 * `equip` function reference every render (safe in a `useCallback`/`useEffect`
 * dependency array).
 */

interface GateStore {
	open: boolean;
	payload: NeedsCompanions | null;
	busy: boolean;
	/** Resolves the pending `equip()` promise with the user's choice — `true`
	 *  for "Equip with companions", `false` for "Equip skill only" / Esc /
	 *  backdrop (I1 + A4: the registry equip already landed at exit 2 either
	 *  way, so both are an acknowledgement, never a cancel). */
	settle: ((confirmed: boolean) => void) | null;
}

const useGateStore = create<GateStore>(() => ({
	open: false,
	payload: null,
	busy: false,
	settle: null,
}));

/** Test-only escape hatch onto the module-level store — `useGateStore` is a
 *  real Zustand store (has `.getState()`/`.setState()`), so a test resets it
 *  between cases (a leftover `open: true` would otherwise leak into the next
 *  test in the same file). Not read by any production code path. */
export const useGateStoreForTests = useGateStore;

/** Skips the dialog and replays a choice the caller already knows — the
 *  disable undo (C8): `"with"` re-runs `--with-companions`, `"only"` runs
 *  `--skill-only`. Never guess between them; the caller derives it from
 *  `hub disable`'s own `removed_companions` payload. */
export interface CompanionGateOpts {
	force?: "with" | "only";
}

/** Thrown by `equipWithGate` when the user confirmed the consequence dialog
 *  and the `--with-companions` call failed: the skill IS equipped (call 1
 *  saved the registry before exiting 2), its companions are not. */
export class CompanionProvisionError extends Error {
	readonly cause: unknown;
	constructor(cause: unknown) {
		super(errorDetail(cause).headline);
		this.name = "CompanionProvisionError";
		this.cause = cause;
	}
}

/** Toast title + body for a failed equip. Distinguishes "nothing landed"
 *  from "equipped, companions didn't" — the second must not read as a
 *  failed equip while the row stays checked. */
export function equipErrorToast(err: unknown): { title: string; body: string } {
	if (err instanceof CompanionProvisionError) {
		return {
			title: "Equipped, but couldn't provision companions",
			body: `${err.message.replace(/\.$/, "")}. Retry with Provision on the project loadout.`,
		};
	}
	return { title: "Couldn't equip skill", body: errorDetail(err).headline };
}

/**
 * Equip a skill on a project through the consequence gate.
 *
 * No flags: runs `hub enable <skill> --project <p> --json`. A plain skill (no
 * `ships_with`, or nothing to ask about) lands with no payload and resolves at
 * once. A skill that ships companions exits 2 with the I2 `needs_provisioning`
 * payload (A4) — the registry equip has ALREADY landed, so this opens the
 * dialog and resolves once the user has chosen, never rejecting on that
 * choice alone. `opts.force` bypasses the gate entirely by passing the known
 * flag on the FIRST call; a real failure at any point rejects, matching
 * `runHubCmd`'s throw-on-non-zero contract every other call site already
 * relies on.
 */
export async function equipWithGate(
	skill: string,
	project: string,
	opts?: CompanionGateOpts,
): Promise<void> {
	if (opts?.force) {
		const flag = opts.force === "with" ? "--with-companions" : "--skill-only";
		await runHubCmd(["enable", skill, "--project", project, "--json", flag]);
		return;
	}

	const { gated } = await runWithGate<{ needs_provisioning?: NeedsCompanions }>([
		"enable",
		skill,
		"--project",
		project,
		"--json",
	]);
	const needs = gated?.needs_provisioning;
	if (!needs) return; // landed, nothing to ask about

	if (useGateStore.getState().open) {
		// Only one consequence dialog can be answered at a time — surfacing this
		// as a rejection is honest (the equip already landed; the PROVISIONING
		// question could not be asked) rather than silently clobbering the
		// dialog already open for a different equip.
		throw new Error("Another equip consequence dialog is already open.");
	}

	const confirmed = await new Promise<boolean>((resolve) => {
		useGateStore.setState({ open: true, payload: needs, busy: false, settle: resolve });
	});

	if (confirmed) {
		useGateStore.setState((s) => ({ ...s, busy: true }));
		try {
			await runHubCmd(["enable", skill, "--project", project, "--json", "--with-companions"]);
		} catch (err) {
			// The equip (call 1) has already landed; only the PROVISIONING
			// failed. A caller that reports this as "Couldn't equip skill" lies
			// about the row it just checked — the typed error lets it say what
			// actually happened and where to retry (the loadout's Provision).
			throw new CompanionProvisionError(err);
		} finally {
			useGateStore.setState({ open: false, payload: null, busy: false, settle: null });
		}
		return;
	}

	useGateStore.setState({ open: false, payload: null, busy: false, settle: null });
}

/** Component call sites' handle onto the gate. `equip` is a stable reference
 *  (the module-level `equipWithGate`), so it is safe in a dependency array. */
export function useCompanionGate(): { equip: typeof equipWithGate } {
	return { equip: equipWithGate };
}

/** Mounted once in `App.tsx`, inside the toast provider. Portals the
 *  consequence dialog whenever `equipWithGate` opens it — no call site owns
 *  an overlay of its own. */
export function CompanionGateProvider() {
	const { open, payload, busy, settle } = useGateStore();
	return (
		<CompanionConsequenceDialog
			open={open}
			payload={payload}
			busy={busy}
			onConfirm={() => settle?.(true)}
			onClose={() => settle?.(false)}
		/>
	);
}
