import { runHubCmd } from "@/lib/hubCmd";
import { invalidateRegistry } from "@/lib/invalidate";
import type { OverflowMenuItem } from "@/components/OverflowMenu";
import { DROPPED_ACTION_ICON, DROPPED_ACTION_LABEL, type DroppedAction } from "@/lib/droppedSkillActions";
import type { SourceView } from "@/types";

/**
 * The overflow rows shared by BOTH the dropped and the plain read-only
 * overflow sets — "where did this come from" never needs three copies of the
 * same two items. Lifted verbatim out of `SkillEditor.tsx` (plans/E1.md §3,
 * task 3 — the line-budget extraction) so the screen stays under the
 * `componentSizeGuard` line cap.
 */
export function buildSourceOverflowItems({
	upstream,
	ownerSource,
	onInvalidate = invalidateRegistry,
}: {
	upstream: string;
	ownerSource: SourceView | null | undefined;
	/** Defaults to `invalidateRegistry()` on the app's shared query client;
	 *  overridable so a test can spy without a real react-query client. */
	onInvalidate?: () => Promise<void>;
}): OverflowMenuItem[] {
	return [
		{
			icon: "link",
			label: "Copy upstream URL",
			disabled: !upstream,
			onClick: () => {
				if (upstream) void navigator.clipboard.writeText(upstream);
			},
		},
		{
			icon: "refresh",
			label: "Check source for updates",
			disabled: !ownerSource || ownerSource.type !== "git",
			onClick: () => {
				if (ownerSource)
					void runHubCmd(["source", "check", ownerSource.id, "--json"]).then(() => onInvalidate());
			},
		},
	];
}

/**
 * The screen header's overflow menu, one of three shapes (dropped / read-only
 * / normal) — extracted alongside `buildSourceOverflowItems` (E1's line-budget
 * extraction, task 3 crossing MAX_LINES again once the MCP panel wiring
 * landed; §7 names "one more block" as the fallback rather than appending).
 */
export function buildSkillHeaderOverflow(params: {
	dropped: boolean;
	droppedOverflow: DroppedAction[];
	runDroppedAction: (action: DroppedAction) => void;
	pageBusy: boolean;
	readOnly: boolean;
	skillRoot: string;
	revealPath: (rel?: string) => void;
	duplicateAsLocal: () => void;
	copyPath: () => void;
	doRemove: () => void;
	sourceOverflowItems: OverflowMenuItem[];
}): OverflowMenuItem[] {
	const {
		dropped,
		droppedOverflow,
		runDroppedAction,
		pageBusy,
		readOnly,
		skillRoot,
		revealPath,
		duplicateAsLocal,
		copyPath,
		doRemove,
		sourceOverflowItems,
	} = params;

	if (dropped) {
		return [
			...droppedOverflow.map((a) => ({
				icon: DROPPED_ACTION_ICON[a],
				label: DROPPED_ACTION_LABEL[a],
				danger: a === "forget",
				disabled: pageBusy,
				onClick: () => runDroppedAction(a),
			})),
			...sourceOverflowItems,
		];
	}
	if (readOnly) {
		return [
			{ icon: "folder", label: "Reveal skill folder", disabled: !skillRoot, onClick: () => revealPath() },
			...sourceOverflowItems,
		];
	}
	return [
		{ icon: "copy", label: "Duplicate", onClick: () => void duplicateAsLocal() },
		{ icon: "folder", label: "Reveal skill folder", disabled: !skillRoot, onClick: () => revealPath() },
		{ icon: "link", label: "Copy path", onClick: copyPath },
		{ divider: true },
		{
			icon: "archive",
			label: "Archive",
			danger: true,
			disabled: pageBusy,
			busy: pageBusy,
			onClick: () => void doRemove(),
		},
	];
}
