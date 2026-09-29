import { useCallback, useRef, useState } from "react";
import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { hubCmd } from "@/lib/hubCmd";
import { parseCliJson } from "@/lib/skillPack";
import { qk } from "@/lib/queryKeys";
import type { ClassificationField, SkillClassification, SkillRefsGraph } from "@/types";
import { invalidateRegistry } from "@/lib/invalidate";
import type { ClassificationUpdateState } from "@/lib/skillClassification";

export function useSkillRefsGraph(): UseQueryResult<SkillRefsGraph> {
	return useQuery({
		queryKey: qk.skillRefsGraph(),
		queryFn: async () => {
			const result = await hubCmd(["skill", "refs", "--json"]);
			if (!result.success) throw new Error(result.output || "Could not read skill references");
			return parseCliJson<SkillRefsGraph>(result.output);
		},
	});
}

export function useSkillClassificationUpdate(skillName: string): ClassificationUpdateState {
	const queue = useRef(Promise.resolve());
	const queryClient = useQueryClient();
	const [pendingField, setPendingField] = useState<ClassificationField | null>(null);
	const [settled, setSettled] = useState<ClassificationUpdateState["settled"]>(null);
	const update = useCallback(<K extends ClassificationField>(field: K, value: SkillClassification[K]) => {
		const task = async () => {
			setPendingField(field); setSettled(null);
			try {
				const flag = field === "classes" || field === "outputs" ? `--${field.replace("_", "-")}-json` : `--${field.replace("_", "-")}`;
				const encoded = field === "classes" || field === "outputs" ? JSON.stringify(value ?? []) : String(value ?? "");
				const result = await hubCmd(["set-meta", skillName, flag, encoded]);
				if (!result.success) throw new Error(result.output || "Classification update failed");
				await invalidateRegistry(queryClient);
				setSettled({ field, ok: true });
			} catch (error) {
				await invalidateRegistry(queryClient);
				setSettled({ field, ok: false }); throw error;
			} finally { setPendingField(null); }
		};
		const result = queue.current.then(task, task);
		queue.current = result.catch(() => {});
		return result;
	}, [queryClient, skillName]);
	return { update, pendingField, settled };
}
