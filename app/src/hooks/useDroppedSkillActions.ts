import { useEffect } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { NavigateFunction } from "react-router-dom";
import {
	useDroppedSkillFlow,
	type UseDroppedSkillFlow,
} from "@/hooks/useDroppedSkillFlow";
import { backReturnOptions, type BackTarget } from "@/lib/backTarget";
import type { UnsavedGuard } from "@/lib/navGuard";

/**
 * Everything a `source_missing` skill needs (confirm/busy/undo/keep-as-
 * local/open-successor), plus the pinned-ref body load that follows it —
 * pulled out of `SkillEditor.tsx` itself so that screen stays under the
 * component-size guard's line cap. `leaveGuard` has to exist first:
 * `onRemoved` is what lets a landed archive/forget bypass it.
 */
export function useDroppedSkillActions(params: {
	routeName: string | undefined;
	dropped: boolean;
	back: BackTarget;
	navigate: NavigateFunction;
	leaveGuard: UnsavedGuard;
	setContent: Dispatch<SetStateAction<string>>;
	savedContentRef: MutableRefObject<string>;
	setDirty: Dispatch<SetStateAction<boolean>>;
}): UseDroppedSkillFlow {
	const {
		routeName,
		dropped,
		back,
		navigate,
		leaveGuard,
		setContent,
		savedContentRef,
		setDirty,
	} = params;

	const flow = useDroppedSkillFlow({
		routeName,
		sourceMissing: dropped,
		back,
		navigate,
		onRemoved: () => leaveGuard.bypass(() => navigate(back.path, backReturnOptions(back))),
	});

	// The dropped-skill body: the pinned ref's SKILL.md when the checkout can
	// still produce one, else the editor stays empty and the EmptyState below
	// carries the explanation — never a blank editor pretending to be current.
	useEffect(() => {
		if (!dropped) return;
		const md = flow.droppedData?.skill_md ?? "";
		setContent(md);
		savedContentRef.current = md;
		setDirty(false);
	}, [dropped, flow.droppedData, setContent, savedContentRef, setDirty]);

	return flow;
}
