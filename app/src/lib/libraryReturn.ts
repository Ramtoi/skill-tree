// ─── Library "go somewhere and come back" payload ────────────────────────────
// Wave 2 (PLAN-2-return.md). R1 puts the Library's list state (query, kind,
// facets) in the URL, so the history entry itself restores that half. This
// module covers the OTHER half — where the user's attention was (the arrow
// cursor's row, whether the bar had focus) — which rides history `state` on
// the Library's own entry (R2/R3) and, via `BackTarget.restore` (H1), on an
// explicit back arrow's referrer too.

import type { BackTarget } from "./backTarget";
import type { SearchKind } from "./unifiedSearch";

/** H6: focus on return is a tri-state, not a bool — "bar" (Enter fired from
 *  the input), "row" (Enter fired while a result row had DOM focus), or
 *  "none" (a mouse click opened the result — the row keeps its roving tab
 *  stop, nothing steals focus). */
export type ReturnFocus = "bar" | "row" | "none";

export interface LibReturn {
	/** `${kind}:${id}` — the flat-item key of the row that was opened. */
	cursorKey: string;
	focus: ReturnFocus;
}

function isLibReturn(value: unknown): value is LibReturn {
	if (!value || typeof value !== "object") return false;
	const { cursorKey, focus } = value as Record<string, unknown>;
	return (
		typeof cursorKey === "string" &&
		!!cursorKey &&
		(focus === "bar" || focus === "row" || focus === "none")
	);
}

/** The pending restore payload on a history entry, or null when there is
 *  none (a deep link, a fresh `/`, or an entry that already consumed one). */
export function readLibReturn(state: unknown): LibReturn | null {
	if (!state || typeof state !== "object") return null;
	const value = (state as { libReturn?: unknown }).libReturn;
	return isLibReturn(value) ? value : null;
}

/** H8: crumbs mirror what each destination screen's OWN fallback back target
 *  already uses (SkillEditor: `["library"]`; BundleManager: `["library",
 *  "bundles"]`) — so the crumb text a user sees never changes with this
 *  feature. SnippetEditor has no referrer-aware back arrow at all, so its
 *  crumb choice here is moot (only reachable via a real history pop). */
function crumbsFor(kind: SearchKind): string[] {
	return kind === "bundle" ? ["library", "bundles"] : ["library"];
}

/** R2: the referrer a Library-opened result carries forward. `search`
 *  carries the FULL query string (R1 already put `q`/`kind`/`source`/
 *  `trigger` there), so both a real history pop and an explicit back arrow
 *  (H1, via `restore`) land back on the exact same list. `restore` is
 *  wrapped as `{ libReturn }` (finding 9) — `BackTarget.restore` is opaque
 *  history STATE, so it must already be shaped the way the Library reads it
 *  back (`readLibReturn(location.state)`), not the bare `LibReturn` payload. */
export function libraryBackTarget(
	kind: SearchKind,
	search: string,
	restore: LibReturn,
): BackTarget {
	return {
		label: "Library",
		path: `/${search}`,
		crumbs: crumbsFor(kind),
		restore: { libReturn: restore },
	};
}
