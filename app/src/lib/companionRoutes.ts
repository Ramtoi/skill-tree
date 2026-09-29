// D8 — every companion row's link derivation, in one place (Changes table:
// `companionRoute(row, item, ctx)`). A rule's `route` is AUTHORITATIVE from
// I5 (A21) — this module never recomputes it, only reads it verbatim. Hook
// rows carry no route on the wire, so this module derives their library route.
// Skill-owned agent rows point at their canonical source editor; native
// standalone routes remain owned by the harness manager.
//
// Every returned navigation carries `fromNav(skillBackTarget(ctx.skill))`
// (D8) so the destination's back arrow returns to the skill that shipped
// this companion — including a rule row, whose path is otherwise opaque
// about where it came from.
//
// D12 (milestone 6 review, revised by ships-with wave 3 F2/F13): the
// link rule is PER KIND, not one shared gate —
//   - agent: always links to the declared source, including before provision;
//     the source editor reports a missing source as a recoverable error.
//   - hook: `/hook/:name` resolves from the hooks LIBRARY
//     (`hooks_model.all_definitions()`), never from attachment — a
//     project-less read can never report a hook `present`, so gating on
//     "lit" would wrongly kill a working link to a `{ref}` or any
//     pre-attach library hook (F2). It gates on library presence instead
//     (`hookNames`, below) and on the row carrying no `missing` item.
//   - permission: unchanged — the route is authoritative from the CLI.

import type { NavigateOptions } from "react-router-dom";
import { fromNav, skillBackTarget } from "@/lib/backTarget";
import type { CompanionItem, DeclRow } from "@/lib/companions";

export interface CompanionRouteContext {
	/** The skill whose SHIPS WITH section this row belongs to — carried as
	 *  the back target on every navigation this module builds. */
	skill: string;
	/** F2: names the hooks LIBRARY resolves (`hook_list`). A hook row links
	 *  iff this set is present and contains the row name — attachment is
	 *  irrelevant; `/hook/:name` reads the library, not the attach lists.
	 *  `undefined` (unresolved — still pending) ⇒ no link. S4: `null` is a
	 *  DIFFERENT state — the read came back but FAILED — meaning "unknown,
	 *  trust the CLI's own route" rather than "inert": with no way to verify
	 *  library presence client-side, silently killing every hook row's link
	 *  on a transient `hook_list` error is worse than trusting the row's own
	 *  `route` field the way a permission row already does. */
	hookNames?: Set<string> | null;
}

export interface CompanionNav {
	path: string;
	options: NavigateOptions;
}

/**
 * Builds the in-app path + `fromNav` options for one companion row's link.
 * `items` is the row's live `CompanionItem`(s) — a row can carry several, one
 * per harness. Accepts either the full list or a single already-picked item
 * (whichever the caller has to hand) — `null`/`[]` when the row has no live
 * item yet (a project-less read of an agent/hook, or a permission row whose
 * read never came back). Returns `null` when there is nothing sensible to
 * navigate to: a permission row with no `route` (A21 pins the CLI to always
 * emit one on a real read, so this is a defensive fallback, not an expected
 * case).
 */
export function companionRoute(
	row: DeclRow,
	items: CompanionItem | CompanionItem[] | null,
	ctx: CompanionRouteContext,
): CompanionNav | null {
	const list = items === null ? [] : Array.isArray(items) ? items : [items];
	const options = fromNav(skillBackTarget(ctx.skill));
	switch (row.kind) {
		case "permission": {
			// A21: authoritative from the CLI — never recomputed here. Every
			// harness's item for a rule row carries the identical route (it
			// depends on project+pattern+kind, never the harness), so the
			// first item is as good as any.
			const route = list[0]?.route;
			return route ? { path: route, options } : null;
		}
		case "agent": {
			// Skill ownership is authoritative. The source editor reads the
			// declared canonical file even when no native copy is provisioned.
			return {
				path: `/skill/${encodeURIComponent(ctx.skill)}/agent/${encodeURIComponent(row.name)}`,
				options,
			};
		}
		case "hook": {
			// Hooks are a harness-independent library entry (`/hook/:name`
			// already exists, D8) — a ref hook routes exactly the same way as
			// an inline one, both keyed on `name` (A18). F2: gated on the
			// hooks LIBRARY (`hookNames`), never on live state — a
			// project-less read can never report a hook `present`, and the
			// library is what `/hook/:name` actually resolves against. A
			// `missing` item (a `{ref}` whose library entry vanished) is
			// never routable regardless of `hookNames`; an unresolved (still
			// pending) `hookNames` is the same "no link we can vouch for" case.
			if (list.some((i) => i.state === "missing")) return null;
			if (ctx.hookNames === null) {
				// S4: the library read came back FAILED (not merely pending) —
				// fall back to the CLI's own route rather than inerting every
				// hook row on a transient error.
				const route = list[0]?.route;
				return route ? { path: route, options } : null;
			}
			if (!ctx.hookNames || !ctx.hookNames.has(row.name)) return null;
			return { path: `/hook/${encodeURIComponent(row.name)}`, options };
		}
		default:
			return null;
	}
}
