import { useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useRegistry } from "@/hooks/useRegistry";
import { useAppStore } from "@/store";
import { PermissionsEditor } from "@/components/PermissionsEditor";
import { Button } from "@/components/Button";
import { Icon } from "@/components/Icon";
import { Tag } from "@/components/Tag";
import { ScreenHeader } from "@/components/ScreenHeader";
import { StatePill } from "@/components/StatePill";
import { SubheaderGroup } from "@/components/SubheaderGroup";

export function GlobalPermissions() {
	const { data: registry } = useRegistry();
	const navigate = useNavigate();
	const addRecentlyVisited = useAppStore((s) => s.addRecentlyVisited);

	useEffect(() => {
		addRecentlyVisited({ type: "source", name: "permissions" });
	}, [addRecentlyVisited]);

	const projectNames = useMemo(
		() => Object.keys(registry?.projects ?? {}),
		[registry],
	);

	const scopeOptions = [
		{
			key: "global",
			label: "Global",
			scope: { kind: "global" as const },
			active: true,
		},
		...projectNames.map((name) => ({
			key: `project:${name}`,
			label: name,
			scope: { kind: "project" as const, name },
			active: false,
			hint: `Open ${name} permissions`,
		})),
	];

	return (
		<PermissionsEditor
			scope={{ kind: "global" }}
			projectCount={projectNames.length}
			scopeOptions={scopeOptions}
			onSelectScope={(next) => {
				if (next.kind === "global") navigate("/permissions");
				else
					navigate(`/project/${encodeURIComponent(next.name)}?tab=permissions`);
			}}
			renderChrome={(chrome) => (
				<ScreenHeader
					leading={
						<span
							className="scope-glyph header-leading-glyph"
							data-scope="cog"
						>
							<Icon name="cog" size={14} />
						</span>
					}
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
								saved
							</StatePill>
						) : null
					}
					crumbs={[
						<span className="crumb-path" key="path">
							<Icon name="folder" size={11} />
							<span className="path">registry.yaml</span>
						</span>,
					]}
					subline={`${chrome.ruleCount} rule${chrome.ruleCount === 1 ? "" : "s"} · ${chrome.hookCount} hook${chrome.hookCount === 1 ? "" : "s"}`}
					primary={
						<Button
							variant="primary"
							icon="save"
							kbd="⌘S"
							onClick={chrome.save}
							disabled={chrome.saveDisabled}
							title={chrome.saveTooltip}
						>
							{chrome.saving ? "Saving…" : "Save"}
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
					subheader={{
						left: (
							<SubheaderGroup label="SCOPE">
								<div
									className="perm-scope-switcher"
									role="group"
									aria-label="Permission scope"
								>
									{chrome.scopeOptions?.map((option) => (
										<button
											key={option.key}
											type="button"
											className="perm-scope-chip"
											aria-pressed={option.active}
											title={option.hint}
											onClick={() =>
												!option.active && chrome.onSelectScope?.(option.scope)
											}
										>
											{option.label}
										</button>
									))}
								</div>
							</SubheaderGroup>
						),
					}}
				/>
			)}
		/>
	);
}
