// ─── Unsaved-work navigation guard ───────────────────────────────────────────
// One place that can stop an in-app route change while a screen holds unwritten
// edits — the rail, a NavPanel row, the command palette, a `g …` chord, a
// header back arrow and a `<Link>` all end up calling the router's `navigator`,
// so wrapping THAT is the only way to cover every exit without asking eight
// call sites to remember.
//
// Why not `useBlocker`: it needs a data router (`createHashRouter` +
// `RouterProvider`), and this app mounts a plain `<HashRouter>`. Bouncing back
// after the fact is not an option either — the screen unmounts on the way out,
// so its buffers are gone before any "discard?" prompt could be answered. The
// navigation has to be refused BEFORE it happens.
//
// Not covered: the browser's own history (`go`/`popstate`, ⌘[ and the swipe
// gesture) — the router applies those through its listener, not through the
// navigator, so they cannot be refused from here. Window close is covered
// separately, by `beforeunload`.

import {
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
	type ReactNode,
} from "react";
import { UNSAFE_NavigationContext, type Navigator } from "react-router-dom";

/** Replays the navigation that was refused. */
export type NavResume = () => void;

/** Returns `true` to let the navigation through, `false` to refuse it. A
 *  refusing guard is expected to surface a prompt and keep `resume`. */
export type NavGuardFn = (resume: NavResume) => boolean;

// One guard at a time: only one editor screen is ever mounted, and a stack
// would just hide the bug where a screen forgot to clear its own.
let activeGuard: NavGuardFn | null = null;

export function setNavigationGuard(guard: NavGuardFn | null): void {
	activeGuard = guard;
}

/** Run `perform` unless the active guard refuses it. */
export function attemptNavigation(perform: NavResume): void {
	if (activeGuard && !activeGuard(perform)) return;
	perform();
}

/**
 * Wraps the router's navigator so every programmatic navigation below it goes
 * through {@link attemptNavigation}. Mount it directly inside the router.
 */
export function NavigationGuard({ children }: { children: ReactNode }) {
	const ctx = useContext(UNSAFE_NavigationContext);
	const value = useMemo(() => {
		const base = ctx.navigator;
		const guarded: Navigator = {
			createHref: (to) => base.createHref(to),
			encodeLocation: base.encodeLocation
				? (to) => base.encodeLocation!(to)
				: undefined,
			// Browser history is not routed through the navigator's push/replace,
			// so `go` is deliberately a pass-through (see the module header).
			go: (delta) => base.go(delta),
			push: (to, state, opts) =>
				attemptNavigation(() => base.push(to, state, opts)),
			replace: (to, state, opts) =>
				attemptNavigation(() => base.replace(to, state, opts)),
		};
		return { ...ctx, navigator: guarded };
	}, [ctx]);
	return (
		<UNSAFE_NavigationContext.Provider value={value}>
			{children}
		</UNSAFE_NavigationContext.Provider>
	);
}

export interface UnsavedGuard {
	/** True while a navigation is held, waiting on the screen's confirm. */
	pending: boolean;
	/** Discard and go: replays the navigation that was refused. */
	confirm: () => void;
	/** Stay put and drop the held navigation. */
	cancel: () => void;
	/** Run one navigation the guard must NOT question. `run` has to navigate
	 *  synchronously — the bypass lasts exactly as long as the call. */
	bypass: (run: () => void) => void;
}

/**
 * Arm the guard for as long as `when` is true, and mirror it onto
 * `beforeunload` so closing the window asks too.
 *
 * The screen renders its own confirm dialog off `pending` — the copy belongs to
 * the screen, which is the only thing that knows what is unsaved.
 */
export function useUnsavedGuard(when: boolean): UnsavedGuard {
	const [pending, setPending] = useState<{ resume: NavResume } | null>(null);
	const bypassing = useRef(false);

	useEffect(() => {
		if (!when) return;
		setNavigationGuard((resume) => {
			if (bypassing.current) return true;
			setPending({ resume });
			return false;
		});
		return () => setNavigationGuard(null);
	}, [when]);

	useEffect(() => {
		if (!when) return;
		const onBeforeUnload = (e: BeforeUnloadEvent) => {
			// The modern pair: `preventDefault` is what current browsers honor,
			// `returnValue` keeps older ones asking too.
			e.preventDefault();
			e.returnValue = "";
		};
		window.addEventListener("beforeunload", onBeforeUnload);
		return () => window.removeEventListener("beforeunload", onBeforeUnload);
	}, [when]);

	const bypass = useCallback((run: () => void) => {
		bypassing.current = true;
		try {
			run();
		} finally {
			bypassing.current = false;
		}
	}, []);

	const confirm = useCallback(() => {
		const held = pending;
		setPending(null);
		// Replay through the bypass rather than by clearing the guard: the screen
		// may survive the navigation (a route-param change), and a cleared guard
		// would stay cleared until `when` next flips.
		if (held) bypass(held.resume);
	}, [pending, bypass]);

	const cancel = useCallback(() => setPending(null), []);

	// Stable identity while nothing is held, so screens can list the guard in a
	// `useCallback` dependency array without re-creating every handler.
	return useMemo(
		() => ({ pending: pending !== null, confirm, cancel, bypass }),
		[pending, confirm, cancel, bypass],
	);
}
