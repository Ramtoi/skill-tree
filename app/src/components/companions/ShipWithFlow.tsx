// Wave 4c unit 3 (plans/3.md §3.4) — the shared "Ship this with a skill…"
// host's overlay router. Renders EITHER the skill picker `Modal` OR the
// seeded `CompanionsEditSheet` — never both, so there is never a stacked-
// overlay z-fight. Deliberately dumb (props only, no store subscription of
// its own): `useShipWith` owns the module-level state and hands this
// component exactly what it needs to render, the same split
// `CompanionGateProvider`/`CompanionConsequenceDialog` already use.

import { useEffect } from "react";
import { useRegistry } from "@/hooks/useRegistry";
import { alreadyShips, isShippableTarget, type ShipWithTarget } from "@/lib/shipWith";
import { SkillPickerModal } from "@/components/companions/SkillPickerModal";
import { CompanionsEditSheet } from "@/components/companions/CompanionsEditSheet";
import { useToast } from "@/components/Toast";

export type ShipWithStage = "closed" | "picker" | "sheet";

export interface ShipWithFlowProps {
	stage: ShipWithStage;
	target: ShipWithTarget | null;
	/** The resolved skill — set once the caller already knew it (a click on
	 *  an existing `CompanionTag`) or once the picker stage resolves one. */
	skill: string | null;
	onPick: (skill: string) => void;
	onClose: () => void;
}

/** Mounted once per `useShipWith()` caller (`{shipWith.element}`); reads the
 *  shared module-level stage/target/skill as props rather than subscribing
 *  to the store itself, so it can be exercised in isolation with plain
 *  props in tests. */
export function ShipWithFlow({ stage, target, skill, onPick, onClose }: ShipWithFlowProps) {
	const { data: registry } = useRegistry();
	const toast = useToast();

	const declared = skill ? (registry?.skills?.[skill]?.ships_with ?? {}) : undefined;
	// R1(b) belt-and-braces: `SubagentList`'s own gate keeps a project-scope
	// agent's "Ship with…" from ever opening this flow as a NEW seed, but
	// this host is shared — refuse honestly here too rather than trust every
	// future caller to remember. A target already declared (the `CompanionTag`
	// click on an already-shipped card) is a no-op seed regardless of scope,
	// so it is never refused.
	const shippable = target ? isShippableTarget(target) : { ok: true as const };
	const blockedAsNewSeed =
		stage === "sheet" && !!target && !shippable.ok && !alreadyShips(declared, target);

	useEffect(() => {
		if (blockedAsNewSeed && !shippable.ok) {
			toast.error("Can't ship this here", shippable.reason);
			onClose();
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [blockedAsNewSeed]);

	if (stage === "closed" || !target || blockedAsNewSeed) return null;

	if (stage === "picker") {
		return <SkillPickerModal open target={target} onPick={onPick} onClose={onClose} />;
	}

	// stage === "sheet"
	if (!skill) return null; // defensive — the controller never reaches here without one
	return (
		<CompanionsEditSheet
			open
			onClose={onClose}
			skillName={skill}
			declared={declared ?? {}}
			seed={target}
		/>
	);
}
