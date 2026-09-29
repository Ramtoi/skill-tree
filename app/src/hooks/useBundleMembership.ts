import { useCallback, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { qk } from "@/lib/queryKeys";
import { useToast } from "@/components/Toast";
import { invalidateRegistry } from "@/lib/invalidate";
import { plural } from "@/lib/plural";
import {
	bundleWriteLanded,
	errText,
	runRegistryWrite,
	showBundleWarnings,
	type BundleCmdPayload,
} from "@/lib/hubWrite";
import type { EquipTarget } from "@/components/EquipPicker";
import type { Registry } from "@/types";

/**
 * One membership change, applied to the LATEST `registry.bundles[name].skills`
 * at the moment it is dequeued — never a snapshot csv captured at request
 * time. `insert` is undo's own verb (re-insert at the original index,
 * clamped), never a replay of some earlier full csv (G4): replaying an old
 * csv would silently erase every edit made while the undo toast was up.
 */
export type MembershipOp =
	| { kind: "add"; skill: string }
	| { kind: "remove"; skill: string }
	| { kind: "insert"; skill: string; index: number }
	/** Drop every member the registry no longer knows about — the header's
	 *  "Remove missing skills" action. */
	| { kind: "removeMissing" };

function applyOp(
	current: string[],
	knownNames: Set<string>,
	op: MembershipOp,
): string[] {
	// G3: the real CLI refuses any `--skills` csv naming an unknown skill, so
	// every csv this hook emits is filtered to registry-known names FIRST —
	// add, remove, insert (undo) and removeMissing alike.
	const known = current.filter((s) => knownNames.has(s));
	switch (op.kind) {
		case "add":
			return known.includes(op.skill) ? known : [...known, op.skill];
		case "remove":
			return known.filter((s) => s !== op.skill);
		case "insert": {
			if (!knownNames.has(op.skill) || known.includes(op.skill)) return known;
			const index = Math.max(0, Math.min(op.index, known.length));
			const next = known.slice();
			next.splice(index, 0, op.skill);
			return next;
		}
		case "removeMissing":
			return known;
	}
}

/**
 * Owns EVERY membership write for one bundle (G4): the band's Add-skills
 * picker, a row's remove action, keyboard Backspace, "Remove missing
 * skills", and undo all enqueue through here. Requests are applied in order
 * over one promise chain — each is computed from the LATEST query-cache
 * bundle at the moment it runs, so N rapid toggles produce N ordered writes
 * that each build on the previous one's result rather than racing a stale
 * snapshot.
 */
export function useBundleMembership(bundleName: string) {
	const toast = useToast();
	// Context-resolved, NOT the module-level singleton (`@/lib/queryClient`):
	// production wraps `<App>` with that same singleton so the two agree, but
	// tests mount their own isolated `QueryClient` per render — reading the
	// singleton there would see a registry nobody ever primed.
	const queryClient = useQueryClient();
	const chainRef = useRef<Promise<void>>(Promise.resolve());

	/**
	 * The per-bundle write QUEUE (G4): any async write for this bundle — a
	 * membership csv below, or a scalar field write from `useBundleLens`
	 * (`commitDescription`/`changeIcon`/`detachSource`) — enqueues through
	 * here so two writes for the same bundle can never reach the data-home
	 * `.lock` out of order. A failed write never stalls the ones queued
	 * behind it (`.then(fn, fn)` runs `fn` either way).
	 */
	const enqueue = useCallback((fn: () => Promise<void>): Promise<void> => {
		const settled = chainRef.current.then(fn, fn);
		chainRef.current = settled.catch(() => {});
		return settled;
	}, []);

	const enqueueOp = useCallback(
		(op: MembershipOp): Promise<void> =>
			enqueue(async () => {
				const prev = queryClient.getQueryData<Registry>(qk.registry());
				try {
					const bundle = prev?.bundles[bundleName];
					if (!prev || !bundle) throw new Error(`unknown bundle ${bundleName}`);
					const knownNames = new Set(Object.keys(prev.skills ?? {}));
					const raw = bundle.skills ?? [];
					const next = applyOp(raw, knownNames, op);
					// G3's filter above drops every registry-unknown name from EVERY
					// op — but only "Remove missing skills" was actually asked to
					// drop them. Any other op silently losing a member is a decision
					// the user never made; surface it.
					const droppedByFilter =
						op.kind === "removeMissing" ? [] : raw.filter((s) => !knownNames.has(s));
					// A registry refetch started before this write (e.g. `NewSkillSheet`'s
					// own awaited `invalidateQueries` right after `hub new`, still
					// settling) would otherwise resolve AFTER the optimistic write below
					// with a pre-write snapshot and clobber it — cancelled first so
					// react-query discards that in-flight result instead of applying it.
					// The other caller awaiting that same refetch is not left hanging:
					// react-query resolves ITS promise too, with whatever data is
					// current at cancel time, and then this op's own `invalidateRegistry`
					// below refreshes everything for real once the write lands.
					await queryClient.cancelQueries({ queryKey: qk.registry() });
					// Optimistic: the picker's own row checkbox (or the row's removal)
					// is the feedback — no success toast for a plain toggle.
					queryClient.setQueryData<Registry>(qk.registry(), {
						...prev,
						bundles: { ...prev.bundles, [bundleName]: { ...bundle, skills: next } },
					});
					const { payload, warning } = await runRegistryWrite<BundleCmdPayload>(
						["bundle", "update", bundleName, "--skills", next.join(","), "--json"],
						bundleWriteLanded,
					);
					await invalidateRegistry(queryClient);
					if (droppedByFilter.length > 0) {
						toast.info(
							`Also dropped ${droppedByFilter.length} ${plural(droppedByFilter.length, "member")} no longer in the library`,
							droppedByFilter.join(", "),
						);
					}
					showBundleWarnings(toast, payload);
					if (warning) toast.info("Sync reported findings", warning);
				} catch (err) {
					// Roll back only THIS bundle's slice, from whatever the cache
					// holds now — not the whole registry snapshot, which would also
					// erase any unrelated optimistic edit (a project toggle, another
					// bundle's write) that landed while this one was in flight.
					const prevBundle = prev?.bundles[bundleName];
					if (prev && prevBundle) {
						queryClient.setQueryData<Registry>(qk.registry(), (cur) =>
							cur
								? { ...cur, bundles: { ...cur.bundles, [bundleName]: prevBundle } }
								: cur,
						);
					}
					toast.error("Couldn't update bundle", errText(err));
					throw err;
				}
			}),
		[bundleName, toast, queryClient, enqueue],
	);

	return {
		add: (skill: string) => enqueueOp({ kind: "add", skill }),
		remove: (skill: string) => enqueueOp({ kind: "remove", skill }),
		insert: (skill: string, index: number) => enqueueOp({ kind: "insert", skill, index }),
		removeMissing: () => enqueueOp({ kind: "removeMissing" }),
		/** `EquipPicker.onToggle` shape, for the Add-skills band picker. */
		toggle: (target: EquipTarget, next: "on" | "off") =>
			next === "on"
				? enqueueOp({ kind: "add", skill: target.id })
				: enqueueOp({ kind: "remove", skill: target.id }),
		/** The generic write queue itself, for `useBundleLens`'s scalar-field
		 *  writes (description/icon/detach-source) to serialise against every
		 *  membership write above. */
		enqueue,
	};
}
