import { useEffect, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { SubagentList } from "@/components/subagents/SubagentList";
import { SubagentEditor } from "@/screens/SubagentEditor";
import { useSubagentList } from "@/hooks/useSubagents";
import type { SubagentHarness, SubagentScope } from "@/lib/subagents";
import { backReturnOptions, readBackTarget, type BackTarget } from "@/lib/backTarget";
import { withQueryFocus } from "@/lib/queryFocus";

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
 *
 * Also the `?agent=<name>` deep-link consumer (D8/plan 2's query-param
 * selection contract): a companion row's name links here with `fromNav`
 * carrying the referring skill as the back target. `?agent=` only ever names
 * a USER-scope agent on THIS harness this wave (S5 — no `scope`/`project` on
 * the link; I5 emits user-scope agents only) — so the effect below always
 * resolves it against the user-scope list, independent of whatever
 * scope/project the list view itself is currently showing.
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
	// The referrer carried by a `?agent=` deep link (read once, at the moment
	// the effect below resolves the param) — `null` for an in-list open, which
	// must close back to the list, never navigate away.
	const carriedBack = useRef<BackTarget | null>(null);

	const [searchParams, setSearchParams] = useSearchParams();
	const location = useLocation();
	const navigate = useNavigate();
	const agentParam = searchParams.get("agent");
	// Gated on the param's presence so an ordinary (non-deep-linked) visit
	// never fires an extra list read. Keyed on the query's OWN data (not just
	// mounted-once) so a deep link into a cold cache resolves once the list
	// arrives rather than silently dropping (plan 2 Risk 4).
	const userAgents = useSubagentList("user", null, !!agentParam, harness);

	useEffect(() => {
		if (!agentParam) return;
		const list = userAgents.data;
		if (!list) return; // wait for the list to resolve before deciding anything
		const match = list.agents.some((a) => a.name === agentParam);
		if (match) {
			carriedBack.current = readBackTarget(location.state);
			setSelected({ scope: "user", project: null, name: agentParam });
		}
		// An unknown name is dropped silently either way — the param is stripped
		// regardless of whether it matched.
		const next = new URLSearchParams(searchParams);
		next.delete("agent");
		setSearchParams(next, withQueryFocus(agentParam, location.state));
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [agentParam, userAgents.data]);

	function openAgent(s: SubagentScope, p: string | null, name: string) {
		// An in-list open never carries a referrer — closing it must return to
		// the list, not navigate away.
		carriedBack.current = null;
		setSelected({ scope: s, project: p, name });
	}

	function closeAgent() {
		const back = carriedBack.current;
		carriedBack.current = null;
		setSelected(null);
		if (back) navigate(back.path, backReturnOptions(back));
	}

	if (selected) {
		return (
			<SubagentEditor
				harness={harness}
				scope={selected.scope}
				project={selected.project}
				name={selected.name}
				onBack={closeAgent}
				backLabel={carriedBack.current?.label}
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
