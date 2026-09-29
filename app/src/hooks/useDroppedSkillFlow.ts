import { useCallback, useState } from "react";
import type { NavigateFunction } from "react-router-dom";
import { useDroppedSkill } from "@/hooks/useDroppedSkills";
import { useSkillRemoval, type UseSkillRemoval } from "@/hooks/useSkillRemoval";
import {
	droppedOverflowActions,
	droppedPrimaryAction,
	type DroppedAction,
} from "@/lib/droppedSkillActions";
import { runHubCmd } from "@/lib/hubCmd";
import { invalidateRegistry } from "@/lib/invalidate";
import { errText } from "@/lib/hubWrite";
import { trackProcess } from "@/lib/trackProcess";
import { useToast } from "@/components/Toast";
import { queryClient } from "@/lib/queryClient";
import { qk } from "@/lib/queryKeys";
import { fromNav, type BackTarget } from "@/lib/backTarget";
import type { DroppedSkill } from "@/types";

export interface UseDroppedSkillFlow {
	/** `skill.source_missing` — echoed back for the caller's own convenience. */
	dropped: boolean;
	droppedData: DroppedSkill | null;
	droppedPending: boolean;
	removal: UseSkillRemoval;
	/** True from confirm-accept (or a Keep-as-local in flight) until settled —
	 *  the page-lock signal the screen reads for `readOnly`/`aria-busy`. */
	pageBusy: boolean;
	doRemove: () => Promise<void>;
	doKeepAsLocal: () => Promise<void>;
	runDroppedAction: (action: DroppedAction) => void;
	openPossibleSuccessor: (registeredAs: string) => void;
	droppedPrimary: DroppedAction;
	droppedOverflow: DroppedAction[];
}

/** The HashRouter's current path (`#/skill/x?y` → `/skill/x`), read straight
 *  from the browser rather than a React ref. A ref updated by the unmounting
 *  screen's OWN effect can never observe its OWN navigation-away — by the
 *  time React Router swaps in a different route's element, the old
 *  component is gone without a final re-render to write the new value. The
 *  undo toast survives the unmount (it lives in the global toast store), so
 *  reading the live URL at undo-time is the only source that is still
 *  accurate then. */
function currentHashPath(): string {
	if (typeof window === "undefined") return "/";
	const hash = window.location.hash;
	const path = hash.startsWith("#") ? hash.slice(1) : hash;
	return path.split("?")[0] || "/";
}

/**
 * Everything the skill editor's header, body and side panel need for a
 * `source_missing` skill — pulled out of `SkillEditor.tsx` itself so that
 * screen stays under the component-size guard's line cap. Mirrors the
 * Sources card's own `useSourceDroppedSkills`, but scoped to ONE skill and
 * wired to `useSkillRemoval` directly (rather than through a row callback)
 * because the screen already knows which skill it is.
 */
export function useDroppedSkillFlow(params: {
	routeName: string | undefined;
	sourceMissing: boolean;
	back: BackTarget;
	navigate: NavigateFunction;
	/** Runs once the archive/forget actually lands, so the caller can bypass
	 *  its own leave-guard and navigate away. */
	onRemoved: () => void;
}): UseDroppedSkillFlow {
	const { routeName, sourceMissing: dropped, back, navigate, onRemoved } = params;
	const droppedQuery = useDroppedSkill(routeName, dropped);
	const droppedData = droppedQuery.data ?? null;
	const removal = useSkillRemoval();
	const toast = useToast();
	const [keepingLocal, setKeepingLocal] = useState(false);

	const doRemove = useCallback(async () => {
		if (!routeName) return;
		const verb = dropped ? "forget" : "archive";
		const ok = await removal.archive([routeName], {
			verb,
			onUndone: () => {
				// Only follow the user back if they are still where the archive
				// left them — an undo minutes later must not yank them off
				// whatever they navigated to since. `back.path` may now carry a
				// query string (a Library referrer's `/?q=…`, wave 2) —
				// `currentHashPath()` always strips one, so `back.path` must be
				// compared the same way or a query-string referrer never matches.
				if (currentHashPath() === back.path.split("?")[0]) {
					navigate(`/skill/${encodeURIComponent(routeName)}`, fromNav(back));
				}
			},
		});
		if (ok) onRemoved();
	}, [routeName, dropped, removal, navigate, back, onRemoved]);

	const doKeepAsLocal = useCallback(async () => {
		if (!routeName || keepingLocal) return;
		setKeepingLocal(true);
		try {
			await trackProcess({ title: `Keeping ${routeName} as local`, kind: "fs" }, () =>
				runHubCmd(["source", "recover", routeName, "--json"]),
			);
			await invalidateRegistry(queryClient);
			await queryClient.invalidateQueries({ queryKey: qk.sources() });
			await queryClient.invalidateQueries({ queryKey: qk.droppedSkills() });
			toast.success(`Kept ${routeName} as local`);
		} catch (err) {
			toast.error("Couldn't keep as local", errText(err));
		} finally {
			setKeepingLocal(false);
		}
	}, [routeName, keepingLocal, toast]);

	const runDroppedAction = useCallback(
		(action: DroppedAction) => {
			if (action === "open-successor") {
				const target = droppedData?.successor?.registered_as;
				if (target) navigate(`/skill/${encodeURIComponent(target)}`, fromNav(back));
				return;
			}
			if (action === "keep-local") {
				void doKeepAsLocal();
				return;
			}
			void doRemove();
		},
		[droppedData, navigate, back, doKeepAsLocal, doRemove],
	);

	const openPossibleSuccessor = useCallback(
		(registeredAs: string) => {
			navigate(`/skill/${encodeURIComponent(registeredAs)}`, fromNav(back));
		},
		[navigate, back],
	);

	return {
		dropped,
		droppedData,
		droppedPending: droppedQuery.isPending,
		removal,
		pageBusy: removal.busy || keepingLocal,
		doRemove,
		doKeepAsLocal,
		runDroppedAction,
		openPossibleSuccessor,
		droppedPrimary: droppedData ? droppedPrimaryAction(droppedData) : "forget",
		droppedOverflow: droppedData ? droppedOverflowActions(droppedData) : [],
	};
}
