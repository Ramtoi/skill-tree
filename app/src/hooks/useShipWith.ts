import { createElement, type ReactNode } from "react";
import { create } from "zustand";
import { ShipWithFlow, type ShipWithStage } from "@/components/companions/ShipWithFlow";
import { useAppStore } from "@/store";
import type { ShipWithTarget } from "@/lib/shipWith";

/**
 * Wave 4c unit 3 (plans/3.md §3.4) — the shared "Ship this with a skill…"
 * host, mirroring `useCompanionGate.tsx`'s module-level-store shape: state
 * lives in a tiny Zustand store (not React Context) so every screen's own
 * `useShipWith()` call reads the SAME flow — one at a time, app-wide — and
 * `shipWith.element` can be rendered from wherever the row action lives
 * without a provider mounted anywhere (unlike the companion gate's dialog,
 * this host needs no App.tsx wiring at all: `ShipWithFlow` portals its own
 * overlay via `Modal`/`Sheet`).
 *
 * A hook/agent seed's target is resolved by the CALLER (the screen already
 * ran `companionsIndex(registry).shippedBy` to decide whether to render an
 * interactive `CompanionTag` or a bare "Ship with…" button) and handed in as
 * `open`'s second argument; `open(target)` with no skill stages the picker
 * instead. Nothing here reads the registry itself — that stays inside
 * `ShipWithFlow`/`SkillPickerModal`, which already need it for their own
 * rendering.
 */

interface ShipWithStore {
	stage: ShipWithStage;
	target: ShipWithTarget | null;
	skill: string | null;
}

const CLOSED: ShipWithStore = { stage: "closed", target: null, skill: null };

const useShipWithStore = create<ShipWithStore>(() => ({ ...CLOSED }));

/** Test-only escape hatch onto the module-level store, mirroring
 *  `useGateStoreForTests` — a real Zustand store a test resets between cases
 *  so a leftover open flow never leaks into the next test in the same file.
 *  Not read by any production code path. */
export const useShipWithStoreForTests = useShipWithStore;

/**
 * Opens a flow for `target`. With `skill` given, the flow goes straight to
 * the seeded sheet (no picker in the DOM) — the literal reverse of today's
 * read-only `CompanionTag`. Without one, the picker stage runs first.
 *
 * One flow at a time, app-wide (R5): a call while a flow is already open is
 * refused HONESTLY — the flow already showing stays exactly as it was
 * (never retargeted, never stacked under a second overlay), and (suggestion
 * 11, opus review 6-review-4c.md) a toast says so, rather than leaving the
 * second click looking like a dead button.
 */
function open(target: ShipWithTarget, skill?: string | null): void {
	if (useShipWithStore.getState().stage !== "closed") {
		useAppStore.getState().pushToast({
			kind: "info",
			title: "Finish the open “Ship with…” flow first.",
		});
		return;
	}
	useShipWithStore.setState({ stage: skill ? "sheet" : "picker", target, skill: skill ?? null });
}

function close(): void {
	useShipWithStore.setState({ ...CLOSED });
}

/** The picker's own `onPick` — advances picker → sheet with the chosen
 *  skill, staying inert if called while no picker is open. */
function pick(skill: string): void {
	useShipWithStore.setState((s) => (s.stage === "picker" ? { ...s, stage: "sheet", skill } : s));
}

export interface ShipWithController {
	open(target: ShipWithTarget, skill?: string | null): void;
	close(): void;
	element: ReactNode;
}

/** Component call sites' handle onto the host (plans/3.md §3.4):
 *  `const shipWith = useShipWith();` then `{shipWith.element}` rendered
 *  once, anywhere in the caller's tree. */
export function useShipWith(): ShipWithController {
	const { stage, target, skill } = useShipWithStore();
	return {
		open,
		close,
		// `.ts`, not `.tsx` (this wave's Allowed-files list) — JSX syntax is not
		// parseable here, so the element is built with `createElement` directly.
		element: createElement(ShipWithFlow, { stage, target, skill, onPick: pick, onClose: close }),
	};
}
