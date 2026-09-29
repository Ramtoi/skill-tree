// ─── Durable focus across a query-param strip ────────────────────────────────
// A navigator deep-link (Sources' `?focus=<id>`, Snippets' `?snippet=<name>`)
// is consumed by the destination screen in a mount effect that immediately
// strips the param (`setSearchParams(next, { replace: true })`) — an unknown
// id is dropped silently, same contract either screen uses. One tick later
// the navigator re-renders from the now-param-less location and the "you are
// here" match it did on the query string goes false, so a T3x detail block
// built on top of it unmounts (M-3).
//
// The fix: the screen carries the id forward in history `state` when it
// strips the param, and the navigator reads THAT instead of the query string
// once the query string is gone. `withQueryFocus` merges onto whatever state
// the route already carried (a `fromNav` referrer, say) rather than replacing
// it outright.

import type { NavigateOptions } from "react-router-dom";

/** `setSearchParams(next, withQueryFocus(id, location.state))` — call this in
 *  place of a bare `{ replace: true }` when stripping the param. */
export function withQueryFocus(id: string, priorState: unknown): NavigateOptions {
	const base =
		priorState && typeof priorState === "object"
			? (priorState as Record<string, unknown>)
			: {};
	return { replace: true, state: { ...base, queryFocus: id } };
}

/** The id carried by `withQueryFocus`, or `null` when history state carries
 *  none (a fresh navigation still has the live query param instead). */
export function readQueryFocus(state: unknown): string | null {
	if (!state || typeof state !== "object") return null;
	const v = (state as { queryFocus?: unknown }).queryFocus;
	return typeof v === "string" ? v : null;
}
