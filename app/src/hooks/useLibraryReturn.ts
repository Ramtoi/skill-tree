// R2/R3/H1-H6: opens a Library result while remembering where the user was,
// and restores that attention when the Library is shown again — via a real
// browser Back OR an explicit back arrow (SkillEditor, whose `back.restore`
// carries the same payload, H1) — including the Library's own bundle mode,
// whose referrer is the bundle itself (`bundleBack` above).

import { useEffect, useRef, type MutableRefObject, type RefObject } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { fromNav, type BackTarget } from "@/lib/backTarget";
import { libraryBackTarget, readLibReturn, type ReturnFocus } from "@/lib/libraryReturn";
import { takePaletteLibrarySearchFocus } from "@/lib/librarySearchHandoff";
import type { SearchKind } from "@/lib/unifiedSearch";

export interface UseLibraryReturnArgs {
	/** flatItems' `${kind}:${id}` key → index, so a restored cursor can find
	 *  its row again across a re-render (H4: the effect retries as this
	 *  updates, e.g. while the search corpus is still loading). */
	rowIndex: Map<string, number>;
	setActiveIndex: (i: number) => void;
	rowEls: MutableRefObject<(HTMLElement | null)[]>;
	inputRef: RefObject<HTMLInputElement | null>;
	/** True once every query the restore might be waiting on has resolved —
	 *  only then does a still-unmatched key give up (cursor stays 0) instead
	 *  of retrying forever for a truly stale/removed key. */
	settled: boolean;
	/** Bundle mode (Library bundle-mode composition): when set, a result
	 *  opened from the list hands back a referrer to THIS bundle (its own
	 *  `label`/`path`/`crumbs`, e.g. `bundleBackTarget(name)`) instead of the
	 *  plain library's `libraryBackTarget` — still stamped with the SAME
	 *  cursor/focus restore payload, so the bundle's own list re-opens with
	 *  its cursor intact, and the URL keeps the live query string exactly as
	 *  `libraryBackTarget` does for `/`. */
	bundleBack?: BackTarget;
}

export interface UseLibraryReturn {
	/** R2: stamps the CURRENT Library entry with a restore payload (so a real
	 *  browser Back finds it), then navigates to `route` with a referrer that
	 *  carries the SAME payload (H1 — an explicit back arrow reads it without
	 *  relying on history). `search` is the LIVE list-state query string
	 *  (`LibraryListState.search`) — NEVER `location.search`, which can lag
	 *  the URL-mirror effect's own write by a render, AND (finding 8) is
	 *  list-only: it never carries a one-shot `new`/`addBundle`/`addProject`
	 *  param that happens to also be in the current URL. */
	openWithReturn: (
		kind: SearchKind,
		cursorKey: string,
		focus: ReturnFocus,
		route: string,
		search: string,
	) => void;
}

function stripLibReturn(state: unknown): Record<string, unknown> | undefined {
	if (!state || typeof state !== "object") return undefined;
	const rest = { ...(state as Record<string, unknown>) };
	delete rest.libReturn;
	// A bare `{ libReturn }` payload (the common case) strips down to nothing
	// left to carry — `undefined` (not `{}`), so `navigate`'s `state` reads as
	// "none" the same way a fresh entry with no state at all does.
	return Object.keys(rest).length === 0 ? undefined : rest;
}

function isModalOpen(): boolean {
	return !!document.querySelector('[aria-modal="true"]');
}

export function useLibraryReturn(args: UseLibraryReturnArgs): UseLibraryReturn {
	const location = useLocation();
	const navigate = useNavigate();

	// The palette supplies a list-state URL and a one-shot focus marker. Consume
	// the marker so a later remount leaves normal Library return behavior alone.
	useEffect(() => {
		const remainingState = takePaletteLibrarySearchFocus(location.state);
		if (!remainingState) return;
		args.inputRef.current?.focus();
		navigate(
			{ pathname: location.pathname, search: location.search, hash: location.hash },
			{ replace: true, state: Object.keys(remainingState).length ? remainingState : undefined },
		);
	}, [args.inputRef, location, navigate]);

	function openWithReturn(
		kind: SearchKind,
		cursorKey: string,
		focus: ReturnFocus,
		route: string,
		search: string,
	) {
		const restore = { cursorKey, focus };
		// R2 step 1: stamp the entry we're LEAVING (a real history pop lands
		// here) — H2: this REPLACEs `location.state`, so nothing else may write
		// list state in the same commit as this call. Also doubles as the flush
		// of the live `search` string onto the actual URL (H9): whatever the
		// debounced `q` write does later is then a harmless no-op re-write.
		navigate(
			{ search },
			{
				replace: true,
				state: { ...(location.state as Record<string, unknown> | null), libReturn: restore },
			},
		);
		// R2 step 2: push the detail route with a referrer carrying the SAME
		// payload — H1's explicit-back-arrow path. Bundle mode substitutes its
		// own referrer (the bundle, not the plain library) but keeps `restore`
		// so the cursor row is found again on return either way.
		const target = args.bundleBack
			? { ...args.bundleBack, path: `${args.bundleBack.path}${search}`, restore }
			: libraryBackTarget(kind, search, restore);
		navigate(route, fromNav(target));
	}

	// ── Restore-on-return (R3/H4) ──────────────────────────────────────────
	// Captured once per history entry into a REF, not state — applying it
	// must never itself trigger the render this effect reacts to (H2).
	// Finding 7: the capture itself runs in an EFFECT, not the render body —
	// a render body runs (and, pre-fix, mutated `pendingRef` as a side
	// effect) even for a pass React later discards (an interrupted
	// `startTransition`, StrictMode's double-invoke). An effect only ever
	// fires for a render that actually commits, so a discarded render can no
	// longer latch a payload the commit that follows never intended. It's
	// declared before the restore effect below so both run, in order, in the
	// same post-commit flush for a given `location`.
	const capturedForKeyRef = useRef<string | null>(null);
	const pendingRef = useRef<{ cursorKey: string; focus: ReturnFocus } | null>(null);
	useEffect(() => {
		if (capturedForKeyRef.current === location.key) return;
		capturedForKeyRef.current = location.key;
		pendingRef.current = readLibReturn(location.state);
	}, [location.key, location.state]);

	useEffect(() => {
		const pending = pendingRef.current;
		if (!pending) return;
		const idx = args.rowIndex.get(pending.cursorKey);
		// H4: keep retrying (do nothing, wait for the next `rowIndex`) until
		// either the key is found or every query it could come from settles.
		if (idx === undefined && !args.settled) return;

		// Nit: cancel a still-pending scroll if this effect re-runs (a new
		// `rowIndex`, an unmount) before the frame fires — its `idx`/`rowEls`
		// snapshot would otherwise scroll a row that's no longer the target,
		// or run against refs from an unmounted screen.
		let rafId: number | null = null;

		if (idx !== undefined) {
			args.setActiveIndex(idx);
			if (!isModalOpen()) {
				if (pending.focus === "bar") {
					const el = args.inputRef.current;
					el?.focus();
					if (el) {
						const len = el.value.length;
						el.setSelectionRange(len, len);
					}
				} else if (pending.focus === "row") {
					args.rowEls.current[idx]?.focus();
				}
			}
			// H5: scroll AFTER focus — focusing the bar mounts the kind stack and
			// grows the dock, so the row's true clearance is only known next frame.
			rafId = requestAnimationFrame(() => {
				args.rowEls.current[idx]?.scrollIntoView({ block: "nearest" });
			});
		}

		pendingRef.current = null;
		navigate(
			{ pathname: location.pathname, search: location.search },
			{ replace: true, state: stripLibReturn(location.state) },
		);
		// `location`/`navigate` are read fresh every run (H2's "at run time"),
		// and re-running once more after the clearing `replace` above is a
		// harmless no-op (pendingRef is already null by then).

		return () => {
			if (rafId !== null) cancelAnimationFrame(rafId);
		};
	}, [args.rowIndex, args.settled, args.setActiveIndex, args.inputRef, args.rowEls, location, navigate]);

	return { openWithReturn };
}
