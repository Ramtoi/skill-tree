import { useState, type ReactNode } from "react";
import { SubagentList } from "@/components/subagents/SubagentList";
import { SubagentEditor } from "@/screens/SubagentEditor";
import type { SubagentHarness, SubagentScope } from "@/lib/subagents";

interface SelectedAgent {
	scope: SubagentScope;
	project: string | null;
	name: string;
}

export interface SubagentManagerProps {
	/** Harness whose agents this manager reads/writes (default claude-code). */
	harness?: SubagentHarness;
	/** Starting scope for the list view. */
	initialScope: SubagentScope;
	/** Starting project for the list view (when scope=project). */
	initialProject: string | null;
	/** Disable the Project scope pill with this hint (Codex is user-scope only in
	 *  this wave — project agents are trust-gated and ship later). */
	projectScopeDisabledHint?: string;
	/** Lock the list to `initialScope`/`initialProject` (no scope switcher).
	 *  Used by the project Sub-Agents tab where the scope is implied by the
	 *  project. The switcher still appears in the harness-config entry. */
	lockScope?: boolean;
	/** Chrome rendered above the list (header, eyebrow). Shown ONLY in list
	 *  mode — the editor brings its own ScreenHeader, so we never stack two. */
	listHeader?: ReactNode;
	/** Class applied to the list-mode wrapper only (e.g. the padded
	 *  `.harness-config-screen` scroll container). The editor renders at the top
	 *  level so its own full-height layout is preserved. */
	listClassName?: string;
	/** Content rendered inside the padded list body, above the list itself (e.g.
	 *  a section eyebrow). Shown only in list mode. */
	listLead?: ReactNode;
}

/**
 * Reusable list ↔ editor wrapper for the sub-agents surface. Owns the list
 * scope/project state and the in-component editor selection. Used by both the
 * harness-config screen (`/harness/claude-code`) and the project Sub-Agents tab,
 * so the Wave 3 list + editor are shared, never duplicated.
 */
export function SubagentManager({
	harness = "claude-code",
	initialScope,
	initialProject,
	projectScopeDisabledHint,
	lockScope = false,
	listHeader,
	listClassName,
	listLead,
}: SubagentManagerProps) {
	const [scope, setScope] = useState<SubagentScope>(initialScope);
	const [project, setProject] = useState<string | null>(initialProject);
	const [selected, setSelected] = useState<SelectedAgent | null>(null);

	function openAgent(s: SubagentScope, p: string | null, name: string) {
		setSelected({ scope: s, project: p, name });
	}

	function closeAgent() {
		setSelected(null);
	}

	if (selected) {
		return (
			<SubagentEditor
				harness={harness}
				scope={selected.scope}
				project={selected.project}
				name={selected.name}
				onBack={closeAgent}
				onRenamed={(newName) =>
					setSelected((prev) => (prev ? { ...prev, name: newName } : prev))
				}
				onDeleted={closeAgent}
			/>
		);
	}

	const listBody = (
		<>
			{listLead}
			<SubagentList
				harness={harness}
				scope={scope}
				project={project}
				hideScopeSwitcher={lockScope}
				projectScopeDisabledHint={projectScopeDisabledHint}
				onScopeChange={
					lockScope
						? () => {}
						: (s, p) => {
								setScope(s);
								setProject(p);
							}
				}
				onOpen={openAgent}
			/>
		</>
	);

	// The header (ScreenHeader) renders full-width at the top level, mirroring the
	// other project/harness sub-views; only the list body gets the padded scroll
	// container so the chrome is never double-padded.
	return (
		<>
			{listHeader}
			{listClassName ? (
				<div className={listClassName}>{listBody}</div>
			) : (
				listBody
			)}
		</>
	);
}
