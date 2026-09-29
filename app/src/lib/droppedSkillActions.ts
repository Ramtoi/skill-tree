// ─── Dropped-upstream action model ───────────────────────────────────────────
// One pure computation of "what can be done about this dropped skill, and
// which of those is the primary one" — shared by the skill editor's header,
// its side-panel banner, and each row on the Sources card's "Dropped
// upstream" block, so the three surfaces can never disagree about which
// button is primary (user decision 3: renamed → Open successor, deleted →
// Forget; Keep as local is always secondary).

import type { DroppedSkill } from "@/types";

export type DroppedAction = "open-successor" | "keep-local" | "forget";

export const DROPPED_ACTION_LABEL: Record<DroppedAction, string> = {
	"open-successor": "Open successor",
	"keep-local": "Keep as local",
	forget: "Forget",
};

export const DROPPED_ACTION_ICON: Record<DroppedAction, string> = {
	"open-successor": "arrowRight",
	"keep-local": "duplicate",
	forget: "archive",
};

type DroppedLike = Pick<DroppedSkill, "reason" | "successor" | "recoverable">;

/** A renamed skill whose successor is already a registered skill — the only
 *  case "Open successor" can actually navigate somewhere. */
export function canOpenSuccessor(d: Pick<DroppedSkill, "reason" | "successor">): boolean {
	return d.reason === "renamed" && !!d.successor?.registered_as;
}

export function droppedPrimaryAction(d: DroppedLike): DroppedAction {
	return canOpenSuccessor(d) ? "open-successor" : "forget";
}

/** Every applicable action, natural reading order: Open successor (if any) →
 *  Keep as local (if recoverable) → Forget (always last, always present). */
export function droppedActionList(d: DroppedLike): DroppedAction[] {
	const list: DroppedAction[] = [];
	if (canOpenSuccessor(d)) list.push("open-successor");
	if (d.recoverable) list.push("keep-local");
	list.push("forget");
	return list;
}

/** The other applicable actions — everything `droppedActionList` returns minus
 *  the primary — for a header/banner overflow set. */
export function droppedOverflowActions(d: DroppedLike): DroppedAction[] {
	const primary = droppedPrimaryAction(d);
	return droppedActionList(d).filter((a) => a !== primary);
}

/** "Renamed upstream to X (in your library)" when the registry already
 *  points at that same name — spelling out "registered as X" when X IS X is
 *  redundant. Only diverges to the two-part form when the registered key
 *  differs from the upstream name (a rename-with-suffix collision, say). */
export function droppedReasonText(
	d: Pick<DroppedSkill, "reason" | "successor">,
): string {
	if (d.reason === "renamed") {
		const name = d.successor?.name;
		if (!name) return "Renamed upstream";
		const registeredAs = d.successor?.registered_as;
		if (!registeredAs) return `Renamed upstream to ${name}`;
		return registeredAs === name
			? `Renamed upstream to ${name} (in your library)`
			: `Renamed upstream to ${name} · registered as ${registeredAs}`;
	}
	if (d.reason === "deleted") return "Deleted upstream";
	return "Upstream status unknown";
}

export interface DroppedHedge {
	text: string;
	/** Set when the candidate is already a registered skill — the ONLY case
	 *  the hedge's plain "Open" link does anything. Never a primary action
	 *  and never part of `droppedActionList`: it names a GUESS, not a
	 *  confirmed rename. */
	registeredAs: string | null;
}

/** "Possibly renamed to X (62% similar)" — a below-confidence-gate rename
 *  guess. Only ever present on a `reason: "deleted"` row (a real rename
 *  already reports `reason: "renamed"` via `successor`, never this field). */
export function droppedHedge(
	d: Pick<DroppedSkill, "reason" | "possible_successor">,
): DroppedHedge | null {
	const candidate = d.possible_successor;
	if (d.reason !== "deleted" || !candidate) return null;
	return {
		text: `Possibly renamed to ${candidate.name} (${candidate.similarity}% similar)`,
		registeredAs: candidate.registered_as,
	};
}
