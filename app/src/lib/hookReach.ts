// ─── Reach-badge derivation (hooks-surface D7) ────────────────────────────────
// Turns the probe capability cache into per-harness reach badges for the library
// rows and the editor's event picker. Pure + testable; the component just paints.
//
// Colour discipline (CLAUDE.md "one job per channel"): only two tones —
//   * ok      → green: the hook WILL fire on this harness (verdict "supported").
//   * neutral → muted: the hook will NOT fire here (feature_off / unsupported /
//               event-unsupported). Amber is reserved for provenance+severity, so
//               a transient "written but disabled in codex" is NEVER amber; red is
//               reserved for errors, and a capability limit is not an error. The
//               tooltip's reason string distinguishes the neutral sub-states.
// `not_installed` harnesses are omitted entirely (showing them is noise).

import type {
	HookCapabilitiesCache,
	HookVerdict,
} from "@/hooks/useHooks";
import { eventSupported } from "@/lib/hookCatalog";

export type ReachTone = "ok" | "neutral";

export interface ReachBadge {
	harnessId: string;
	verdict: HookVerdict;
	tone: ReachTone;
	/** True when the reason is the SELECTED event being unsupported (editor). */
	eventUnsupported: boolean;
	reason: string;
}

/** Stable display order — the two hook-capable harnesses first. */
const HARNESS_ORDER = ["claude-code", "codex", "opencode", "pi"];

function orderIndex(id: string): number {
	const i = HARNESS_ORDER.indexOf(id);
	return i === -1 ? HARNESS_ORDER.length : i;
}

/**
 * Derive reach badges from the capability cache. When `event` is provided (the
 * editor's per-event reach), a harness that is otherwise reachable but does not
 * understand the selected event is downgraded to a neutral "event unsupported"
 * badge — so selecting an event supported by claude-code but not codex visibly
 * marks codex as not reached.
 */
export function reachBadges(
	caps: HookCapabilitiesCache | null | undefined,
	event?: string,
): ReachBadge[] {
	if (!caps?.harnesses) return [];
	const out: ReachBadge[] = [];
	for (const [harnessId, entry] of Object.entries(caps.harnesses)) {
		if (!entry || entry.verdict === "not_installed") continue;
		const reachable =
			entry.verdict === "supported" || entry.verdict === "feature_off";
		// Per-event downgrade only applies to an otherwise-reachable harness.
		if (event && reachable && !eventSupported(event, harnessId)) {
			out.push({
				harnessId,
				verdict: entry.verdict,
				tone: "neutral",
				eventUnsupported: true,
				reason: `${harnessId} does not support the ${event} event.`,
			});
			continue;
		}
		out.push({
			harnessId,
			verdict: entry.verdict,
			tone: entry.verdict === "supported" ? "ok" : "neutral",
			eventUnsupported: false,
			reason: entry.reason || "",
		});
	}
	out.sort((a, b) => {
		const d = orderIndex(a.harnessId) - orderIndex(b.harnessId);
		return d !== 0 ? d : a.harnessId.localeCompare(b.harnessId);
	});
	return out;
}
