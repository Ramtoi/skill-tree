import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { fromNav, type BackTarget } from "@/lib/backTarget";
import { runHubCmd } from "@/lib/hubCmd";
import { errText } from "@/lib/hubWrite";
import { trackProcess } from "@/lib/trackProcess";
import { useToast } from "@/components/Toast";
import { queryClient } from "@/lib/queryClient";
import { qk } from "@/lib/queryKeys";
import { invalidateRegistry } from "@/lib/invalidate";
import { useDroppedSkills } from "@/hooks/useDroppedSkills";
import { useSkillRemoval, type UseSkillRemoval } from "@/hooks/useSkillRemoval";
import type { DroppedAction } from "@/lib/droppedSkillActions";
import type { DroppedSkill } from "@/types";

export interface UseSourceDroppedSkills {
	/** Every `source_missing` skill, grouped by its owning source id — feeds
	 *  each `SourceCard`'s "Dropped upstream" block directly. */
	droppedBySource: Record<string, DroppedSkill[]>;
	removal: UseSkillRemoval;
	/** Names currently mid-"Keep as local" — that row shows a spinner. */
	keepingLocalNames: Set<string>;
	onDroppedAction: (action: DroppedAction, row: DroppedSkill) => void;
	onOpenPossibleSuccessor: (registeredAs: string) => void;
	onForgetAllDropped: (rows: DroppedSkill[]) => void;
}

/**
 * The Sources screen's half of the dropped-upstream batch resolution (spec
 * decision 2: no new screen — this lives on the Sources card). Pulled into
 * its own hook so `Sources()` itself stays under the component-size guard's
 * `useState` cap; `Sources.tsx` just renders `<ConfirmDialog {...removal...}>`
 * and passes the row callbacks down to each `SourceCard`.
 */
export function useSourceDroppedSkills(back: BackTarget): UseSourceDroppedSkills {
	const navigate = useNavigate();
	const toast = useToast();
	const droppedQuery = useDroppedSkills();
	const removal = useSkillRemoval();
	const [keepingLocalNames, setKeepingLocalNames] = useState<Set<string>>(() => new Set());

	const droppedBySource = useMemo(() => {
		const map: Record<string, DroppedSkill[]> = {};
		for (const row of droppedQuery.data ?? []) {
			(map[row.source] ??= []).push(row);
		}
		return map;
	}, [droppedQuery.data]);

	const openSkill = useCallback(
		(name: string) => navigate(`/skill/${encodeURIComponent(name)}`, fromNav(back)),
		[navigate, back],
	);

	const keepAsLocal = useCallback(
		async (row: DroppedSkill) => {
			setKeepingLocalNames((prev) => new Set(prev).add(row.name));
			try {
				await trackProcess({ title: `Keeping ${row.name} as local`, kind: "fs" }, () =>
					runHubCmd(["source", "recover", row.name, "--json"]),
				);
				await invalidateRegistry(queryClient);
				await queryClient.invalidateQueries({ queryKey: qk.sources() });
				await queryClient.invalidateQueries({ queryKey: qk.droppedSkills() });
				toast.push({
					kind: "success",
					title: `Kept ${row.name} as local`,
					action: { label: "Open", onClick: () => openSkill(row.name) },
				});
			} catch (err) {
				toast.error("Couldn't keep as local", errText(err));
			} finally {
				setKeepingLocalNames((prev) => {
					const next = new Set(prev);
					next.delete(row.name);
					return next;
				});
			}
		},
		[toast, openSkill],
	);

	const onDroppedAction = useCallback(
		(action: DroppedAction, row: DroppedSkill) => {
			if (action === "open-successor") {
				const target = row.successor?.registered_as;
				if (target) openSkill(target);
				return;
			}
			if (action === "keep-local") {
				void keepAsLocal(row);
				return;
			}
			void removal.archive([row.name], { verb: "forget" });
		},
		[openSkill, keepAsLocal, removal],
	);

	const onForgetAllDropped = useCallback(
		(rows: DroppedSkill[]) => {
			void removal.archive(
				rows.map((r) => r.name),
				{ verb: "forget", alwaysConfirm: true },
			);
		},
		[removal],
	);

	return {
		droppedBySource,
		removal,
		keepingLocalNames,
		onDroppedAction,
		onOpenPossibleSuccessor: openSkill,
		onForgetAllDropped,
	};
}
