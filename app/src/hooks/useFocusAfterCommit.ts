import { useLayoutEffect, useReducer, useRef } from "react";

type Resolver = () => HTMLElement | null | undefined;

/**
 * Focus a not-yet-available element the instant it becomes focusable,
 * without racing React's own commit. A `setTimeout(0)` (or a bare
 * `requestAnimationFrame`) queued right after a state update can run BEFORE
 * React actually applies that update to the DOM, so `element.focus()` silently
 * no-ops on a still-disabled or still-unmounted node and is never retried
 * (`SkillClassificationSection`'s Behavior radios, finding A).
 *
 * `useFocusAfterCommit` instead keeps the request as a resolver in a ref and
 * re-renders (via a no-op reducer bump) so a `useLayoutEffect` with no
 * dependency array runs after EVERY commit — including the one the caller's
 * own state update produces. Each run re-resolves the target: once it exists,
 * is connected to the document, and does not match `:disabled` (which also
 * covers an element disabled via an ancestor `<fieldset disabled>`), it is
 * focused once and the request clears. Otherwise the request stays pending
 * for the next commit. A new request replaces whatever was pending; the
 * request is dropped (never focused) once this component unmounts.
 */
export function useFocusAfterCommit(): (resolve: Resolver, opts?: FocusOptions) => void {
	const pendingRef = useRef<{ resolve: Resolver; opts?: FocusOptions } | null>(null);
	const mountedRef = useRef(true);
	const [, bump] = useReducer((n: number) => n + 1, 0);

	useLayoutEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
			pendingRef.current = null;
		};
	}, []);

	// No dependency array: this must run after every commit, not just the
	// one that follows `requestFocus` itself, since the target may need
	// several commits (mount, then enable) before it is focusable.
	useLayoutEffect(() => {
		const pending = pendingRef.current;
		if (!pending) return;
		const el = pending.resolve();
		if (!el || !el.isConnected || el.matches(":disabled")) return;
		pendingRef.current = null;
		el.focus(pending.opts);
	});

	return (resolve: Resolver, opts?: FocusOptions) => {
		if (!mountedRef.current) return;
		pendingRef.current = { resolve, opts };
		bump();
	};
}
