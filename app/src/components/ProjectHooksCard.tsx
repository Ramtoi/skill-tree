import { useId, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Chip } from "@/components/Chips";
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

/** Project-attached hooks at a glance, with an inline attachment editor. */
export function ProjectHooksCard({ projectName }: { projectName: string }) {
	const navigate = useNavigate();
	const editorId = useId();
	const [editingProject, setEditingProject] = useState<string | null>(null);
	const expanded = editingProject === projectName;
	const toast = useToast();
	const runUndoable = useUndoableAction();
	const { data } = useHookList();
	const attachMut = useHookAttach();
	const detachMut = useHookDetach();
	const hooks = data?.hooks ?? [];

	// Nothing to switch when the library is empty — discovery/creation is on
	// `/hooks`, so don't clutter the loadout with an empty card here.
	if (hooks.length === 0) return null;

	const attachedHooks = hooks.filter((h) =>
		h.attached_projects.includes(projectName),
	);

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
			<div className="project-hooks-head">
				<h3>
					<Icon name="hook" size={14} />
					Hooks
					<span className="count">{attachedHooks.length}</span>
				</h3>
				<div className="project-hooks-summary" aria-label="Equipped project hooks" aria-live="polite">
					{attachedHooks.length ? attachedHooks.map((h) => (
						<Chip key={h.name} icon="check" title={h.name}>{h.name}</Chip>
					)) : <span className="project-hooks-empty">No hooks equipped on this project</span>}
				</div>
				<Button
					variant="ghost"
					size="sm"
					className="project-hooks-disclosure"
					aria-expanded={expanded}
					aria-controls={editorId}
					onClick={() => setEditingProject(expanded ? null : projectName)}
				>
					{expanded ? "Done" : "Edit hooks"}
					<Icon name={expanded ? "chevron-up" : "chevron-down"} size={12} />
				</Button>
			</div>
			<div id={editorId} hidden={!expanded} className="project-hooks-editor">
				{expanded && <>
					<div className="project-hooks-editor-head">
						<span>Equipped on this project</span>
						<Button variant="ghost" size="sm" icon="arrow-right" onClick={() => navigate("/hooks")}>
							Manage hooks
						</Button>
					</div>
					<div className="project-hooks-list" role="group" aria-label="Project hooks">
						{hooks.map((h) => {
							const attached = h.attached_projects.includes(projectName);
							return (
								<div key={h.name} className="project-hook-row" data-attached={attached || undefined}>
									<Toggle
										checked={attached}
										onChange={() => void toggle(h)}
										ariaLabel={`${attached ? "Detach" : "Attach"} ${h.name}`}
										label={<span className="text-mono">{h.name}</span>}
									/>
									<div className="project-hook-meta">
										<Tag size="sm" kind="outline"><span className="text-mono">{h.event}</span></Tag>
										{h.attached_global && <Tag size="sm">global</Tag>}
									</div>
								</div>
							);
						})}
					</div>
				</>}
			</div>
		</div>
	);
}
