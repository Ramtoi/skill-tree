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

import { harnessLabel } from "@/components/harness/harnessRegistry";
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

/** Rows the HARNESSES panel shows: installed ∪ affinity (mirrors
 *  `HarnessReachPanel`'s own row set — a harness the hook targets but that
 *  isn't installed still counts). */
function reachRows(installed: string[], affinity: string[]): string[] {
	return Array.from(new Set([...installed, ...affinity]));
}

/**
 * The HARNESSES section's closed-state rollup (side-panels wave 4): how many
 * of the rows the panel shows will actually fire for the selected event.
 * Mirrors `HarnessReachPanel`'s own "will fire" predicate (targeted, reachable,
 * `supported`, not downgraded by the event) so the head summary and the body
 * can never disagree — INCLUDING the case where reach simply hasn't been
 * probed yet (AUDIT M3): `HarnessReachPanel.statusFor` branches on
 * `capsKnown` before any verdict and renders "reach unknown"; a rollup that
 * ignored that would assert the definite negative "fires on 0 of N" instead
 * of admitting ignorance, on every install that hasn't run `hub sync` since
 * hooks landed. `capsKnown` mirrors the project's fresh/stale/unknown
 * grammar (`lib/syncFreshness.ts`).
 */
export function reachRollup(
	installed: string[],
	affinity: string[],
	caps: HookCapabilitiesCache | null | undefined,
	event: string,
): { fires: number; total: number; capsKnown: boolean } {
	const rows = reachRows(installed, affinity);
	const capsKnown = !!caps?.harnesses;
	const unrestricted = affinity.length === 0;
	const badges = new Map(reachBadges(caps, event).map((b) => [b.harnessId, b]));
	let fires = 0;
	for (const id of rows) {
		const targeted = unrestricted || affinity.includes(id);
		const badge = badges.get(id);
		if (targeted && badge && !badge.eventUnsupported && badge.verdict === "supported") {
			fires++;
		}
	}
	return { fires, total: rows.length, capsKnown };
}

/** The three sentences describing a hook's current affinity — ONE shared
 *  source (AUDIT M4) for `HarnessReachPanel`'s own body paragraph (when
 *  `intro` is on) and `harnessReachHint` below (the section head's hover
 *  `title`), so "one source of truth" in the docs is actually true rather
 *  than two files independently typing the same three strings. */
export const REACH_AFFINITY_TEXT = {
	soleHarness: (label: string) => `Runs on ${label} — the only installed harness.`,
	unrestricted: "Runs on every effective harness. Turn one off to narrow it.",
	narrowed: "Narrowed — this hook is only written to the harnesses below.",
};

/** The HARNESSES panel's one-line explanation of the current affinity —
 *  surfaced as the section head's hover `title` (idle information rides in
 *  `title`, not a paragraph that is always on screen). */
export function harnessReachHint(installed: string[], affinity: string[]): string {
	const rows = reachRows(installed, affinity);
	const unrestricted = affinity.length === 0;
	const soleHarness = installed.length === 1 && rows.length === 1;
	if (soleHarness) {
		return REACH_AFFINITY_TEXT.soleHarness(harnessLabel(rows[0]));
	}
	if (unrestricted) {
		return REACH_AFFINITY_TEXT.unrestricted;
	}
	return REACH_AFFINITY_TEXT.narrowed;
}
