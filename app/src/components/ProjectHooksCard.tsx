import { useNavigate } from "react-router-dom";
import { Button } from "@/components/Button";
import { Icon } from "@/components/Icon";
import { Tag } from "@/components/Tag";
import { Toggle } from "@/components/Toggle";
import { useToast } from "@/components/Toast";
import { useUndoableAction } from "@/hooks/useUndoableAction";
import {
	useHookList,
	useHookAttach,
	useHookDetach,
	type HookRow,
} from "@/hooks/useHooks";
import type { HubResult } from "@/types";

/** Invalidate everything an attach/detach touches (mirrors useHooks + equip). */
const HOOK_INVALIDATE = [["hooks"], ["registry"], ["syncReport"]];

/**
 * Project workspace Hooks card (hooks-surface D7). Lists the hooks in the
 * library with a quick per-hook toggle reflecting whether the hook is attached
 * to THIS project; toggling attaches/detaches through the useHooks mutation
 * layer (→ lib/ipc) and surfaces an undo toast (reversible edge, D4). Hook
 * authoring itself lives on `/hooks`; this card is the project-scoped switch.
 */
export function ProjectHooksCard({ projectName }: { projectName: string }) {
	const navigate = useNavigate();
	const toast = useToast();
	const runUndoable = useUndoableAction();
	const { data } = useHookList();
	const attachMut = useHookAttach();
	const detachMut = useHookDetach();
	const hooks = data?.hooks ?? [];

	// Nothing to switch when the library is empty — discovery/creation is on
	// `/hooks`, so don't clutter the loadout with an empty card here.
	if (hooks.length === 0) return null;

	const attachedCount = hooks.filter((h) =>
		h.attached_projects.includes(projectName),
	).length;

	async function throwIfFailed(p: Promise<HubResult>) {
		const r = await p;
		if (!r.success) throw new Error(r.output);
	}

	async function toggle(h: HookRow) {
		const attached = h.attached_projects.includes(projectName);
		const attach = () =>
			throwIfFailed(attachMut.mutateAsync({ name: h.name, project: projectName }));
		const detach = () =>
			throwIfFailed(detachMut.mutateAsync({ name: h.name, project: projectName }));
		try {
			await runUndoable({
				do: attached ? detach : attach,
				undo: attached ? attach : detach,
				label: attached
					? `Detached ${h.name} from ${projectName}`
					: `Attached ${h.name} to ${projectName}`,
				invalidate: HOOK_INVALIDATE,
			});
		} catch (err) {
			toast.error(
				attached ? "Couldn't detach hook" : "Couldn't attach hook",
				String(err),
			);
		}
	}

	return (
		<div className="loadout-section project-hooks-card">
			<h3>
				<Icon name="bolt" size={14} />
				<span style={{ whiteSpace: "nowrap" }}>Hooks</span>
				<span className="count">{attachedCount}</span>
				<span className="stretch" />
				<Button
					variant="ghost"
					size="sm"
					icon="arrow-right"
					onClick={() => navigate("/hooks")}
				>
					Manage hooks
				</Button>
			</h3>
			<div className="project-hooks-list" role="group" aria-label="Project hooks">
				{hooks.map((h) => {
					const attached = h.attached_projects.includes(projectName);
					return (
						<div
							key={h.name}
							className="project-hook-row"
							data-attached={attached || undefined}
						>
							<Toggle
								checked={attached}
								onChange={() => void toggle(h)}
								ariaLabel={`${attached ? "Detach" : "Attach"} ${h.name}`}
								label={<span className="text-mono">{h.name}</span>}
							/>
							<Tag size="sm" kind="outline">
								<span className="text-mono">{h.event}</span>
							</Tag>
							{h.attached_global && <Tag size="sm">global</Tag>}
						</div>
					);
				})}
			</div>
		</div>
	);
}
