import { useMemo, type ReactNode } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useRegistry } from "@/hooks/useRegistry";
import { shortenPath } from "@/lib/shortenPath";
import { PermissionsEditor } from "./PermissionsEditor";
import { PermSublineCounts } from "./permissions/PermissionsPanels";
import { ImportedBanner } from "./ImportedBanner";
import { ScreenHeader } from "./ScreenHeader";
import { StatePill } from "./StatePill";
import { Button } from "./Button";
import { Icon } from "./Icon";
import { InfoBanner } from "./InfoBanner";

export interface ProjectPermissionsTabProps {
	projectName: string;
	projectPath: string;
	/** The project navigator (area cards, folded), rendered under the header. */
	navigator?: ReactNode;
}

export function ProjectPermissionsTab({
	projectName,
	projectPath,
	navigator,
}: ProjectPermissionsTabProps) {
	const { data: registry } = useRegistry();
	const unattached = !!registry?.projects?.[projectName]?.path_unresolved;
	const projectCount = useMemo(
		() => Object.keys(registry?.projects ?? {}).length,
		[registry],
	);

	// Approximate rule count for the banner copy — uses staged registry data.
	const stagedRuleCount = (
		registry?.projects?.[projectName] as unknown as
			| {
					permissions?: {
						allow?: unknown[];
						deny?: unknown[];
						ask?: unknown[];
						hooks?: unknown[];
					};
			  }
			| undefined
	)?.permissions
		? (
				registry!.projects![projectName] as unknown as {
					permissions: {
						allow?: unknown[];
						deny?: unknown[];
						ask?: unknown[];
						hooks?: unknown[];
					};
				}
			).permissions
		: null;
	const ruleCount = stagedRuleCount
		? (stagedRuleCount.allow?.length ?? 0) +
			(stagedRuleCount.deny?.length ?? 0) +
			(stagedRuleCount.ask?.length ?? 0) +
			(stagedRuleCount.hooks?.length ?? 0)
		: 0;

	return (
		<PermissionsEditor
			scope={{ kind: "project", name: projectName }}
			projectCount={projectCount}
			banner={
				ruleCount > 0 ? (
					<ImportedBanner projectName={projectName} ruleCount={ruleCount} />
				) : null
			}
			renderChrome={(chrome) => (
				<>
				<ScreenHeader
					leading={<span className="project-dot" />}
					nameMono={projectName}
					state={
						chrome.dirty ? (
							<StatePill state="unsaved">UNSAVED</StatePill>
						) : chrome.savedJustNow ? (
							<StatePill state="saved" icon="check">
								{unattached ? "saved" : "applied"}
							</StatePill>
						) : null
					}
					crumbs={[
						<span className="crumb-path" key="path">
							<Icon name="folder" size={11} />
							<span className="path has-tip">
								<span className="path-text">{shortenPath(projectPath)}</span>
								<span className="path-tip" role="tooltip">
									{projectPath}
								</span>
							</span>
						</span>,
					]}
					subline={
						chrome.loading ? (
							"…"
						) : (
							<PermSublineCounts counts={chrome.kindCounts} />
						)
					}
					primary={
						<Button
							variant="primary"
							icon="save"
							kbd="⌘S"
							busy={chrome.saving}
							onClick={chrome.save}
							disabled={chrome.saveDisabled}
							title={chrome.saveTooltip}
						>
							{chrome.saving ? "Saving…" : unattached ? "Save settings" : "Save & apply"}
						</Button>
					}
					overflow={[
						{
							icon: "refresh",
							label: "Discard changes",
							disabled: !chrome.dirty,
							onClick: chrome.discard,
						},
						{ icon: "warning", label: "Open doctor", onClick: chrome.openDoctor },
						{
							icon: "folder",
							label: "Reveal in Finder",
							disabled: unattached,
							onClick: () => void revealItemInDir(projectPath),
						},
						{ divider: true },
						{
							icon: "copy",
							label: "Copy permissions.toml",
							onClick: chrome.copyToml,
						},
						{ divider: true },
						{
							icon: "warning",
							label: "Disable hub-managed permissions…",
							danger: true,
							onClick: chrome.openDisable,
						},
					]}
				/>
				{navigator}
				{unattached && <InfoBanner icon="info">No local directory attached. Saved permissions remain in the loadout; local delivery waits for attachment.</InfoBanner>}
				</>
			)}
		/>
	);
}
