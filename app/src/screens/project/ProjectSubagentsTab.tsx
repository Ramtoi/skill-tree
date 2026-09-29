import type { ReactNode } from "react";
import { Button } from "@/components/Button";
import { Icon } from "@/components/Icon";
import { ScreenHeader } from "@/components/ScreenHeader";
import { SubagentManager } from "@/components/subagents/SubagentManager";
import { Tag } from "@/components/Tag";

export function ProjectSubagentsTab({
	projectName,
	navigator,
	equippedCount,
	codexActive,
	onNavigate,
}: {
	projectName: string;
	/** The project navigator (area cards, folded), rendered under the header. */
	navigator?: ReactNode;
	equippedCount: number;
	codexActive: boolean;
	onNavigate: (to: string) => void;
}) {
	// Effective harnesses for this project (global ∪ project). Codex is
	// user-scope only — its agents live at /harness/codex, not here — so the
	// hint is shown ONLY when codex is actually active, where it's relevant.
	return (
		<SubagentManager
			initialScope="project"
			initialProject={projectName}
			lockScope
			listClassName="project-subagents-tab"
			listLead={
				codexActive ? (
					<div className="project-subagents-codex-hint" role="note">
						<Icon name="agent" size={13} />
						<span>
							Only <strong>Claude Code</strong> has project sub-agents —
							Codex agents are user-wide by design.
						</span>
						<Button
							variant="ghost"
							size="sm"
							icon="arrow-right"
							onClick={() => onNavigate("/harness/codex")}
						>
							Manage Codex agents
						</Button>
					</div>
				) : undefined
			}
			listHeader={
				<>
				<ScreenHeader
					leading={<span className="project-dot" />}
					nameMono={projectName}
					meta={
						<Tag size="sm">
							{equippedCount} {equippedCount === 1 ? "skill" : "skills"}
						</Tag>
					}
					crumbs={["project", projectName, "sub-agents"]}
					subline="Project sub-agents — Claude Code personas in .claude/agents/"
				/>
				{navigator}
				</>
			}
		/>
	);
}
