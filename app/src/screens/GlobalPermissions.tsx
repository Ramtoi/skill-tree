import { useMemo } from "react";
import { useRegistry } from "@/hooks/useRegistry";
import { PermissionsEditor } from "@/components/PermissionsEditor";
import { PermSublineCounts } from "@/components/permissions/PermissionsPanels";
import { Button } from "@/components/Button";
import { Icon } from "@/components/Icon";
import { Tag } from "@/components/Tag";
import { ScreenHeader } from "@/components/ScreenHeader";
import { StatePill } from "@/components/StatePill";

export function GlobalPermissions() {
	const { data: registry } = useRegistry();

	// NOTE: this screen deliberately records nothing in Recent. It used to push
	// `{type: "source", name: "permissions"}` — a chip whose href resolved to
	// `/source/permissions`, a route that does not exist. Permissions is one
	// rail click and one `g ⇧p` chord away; it never needed a chip.

	// This screen used to also carry a "Scope" chip strip that jumped straight
	// from Global to a project's `?tab=permissions`. That was a real navigate,
	// not an in-place one, so it silently dropped the guardrails chrome (rail
	// pill, hue, navigator) on the way — the navigator already lists every
	// project's own permissions, so the strip was a second, worse path to the
	// same place.
	const projectNames = useMemo(
		() => Object.keys(registry?.projects ?? {}),
		[registry],
	);

	return (
		<PermissionsEditor
			scope={{ kind: "global" }}
			projectCount={projectNames.length}
			renderChrome={(chrome) => (
				<ScreenHeader
					icon="permissions"
					title="Permissions"
					meta={
						<Tag size="sm" color="var(--cyan)">
							GLOBAL
						</Tag>
					}
					state={
						chrome.dirty ? (
							<StatePill state="unsaved">UNSAVED</StatePill>
						) : chrome.savedJustNow ? (
							<StatePill state="saved" icon="check">
								applied
							</StatePill>
						) : null
					}
					crumbs={[
						<span className="crumb-path" key="path">
							<Icon name="folder" size={11} />
							<span className="path">registry.yaml</span>
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
							{chrome.saving ? "Applying…" : "Save & apply"}
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
			)}
		/>
	);
}
