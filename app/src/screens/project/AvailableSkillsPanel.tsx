import { useEffect, useRef } from "react";
import { Button } from "@/components/Button";
import { Icon } from "@/components/Icon";
import { SearchInput } from "@/components/SearchInput";
import { ResourceRow } from "@/components/ResourceRow";
import { KindMark } from "@/components/Tag";
import { HarnessIconGroup } from "@/components/harness/HarnessGlyph";
import type { ListNav } from "@/hooks/useListNav";
import type { Registry, Skill, SkillScope } from "@/types";
import type { EquipStatus } from "@/screens/ProjectWorkspace";
import { ProspectiveCostCell } from "@/components/EquipPicker";

/**
 * Second-tier facts behind the row's disclosure chevron (COMPONENTS.md
 * §Resource row / card). Drops the words SKILL/MCP/scope — the group headers
 * above already carry scope, and `KindMark` already carries kind (R1/R4).
 */
function AvailableSkillDetail({
	skill,
	bundleNames,
}: {
	skill: Skill;
	bundleNames: string[];
}) {
	const harnesses = skill.harnesses ?? [];
	return (
		<>
			<p className="avail-row-desc">
				{skill.description || "No description yet."}
			</p>
			{(skill.version || harnesses.length > 0) && (
				<div className="avail-row-meta">
					{skill.version && <span className="ver">v{skill.version}</span>}
					{harnesses.length > 0 && (
						<HarnessIconGroup ids={harnesses} size={14} maxVisible={3} />
					)}
				</div>
			)}
			{bundleNames.length > 0 && (
				<div className="avail-row-bundles">
					would also come via {bundleNames.slice(0, 2).join(", ")}
					{bundleNames.length > 2 ? ` +${bundleNames.length - 2}` : ""}
				</div>
			)}
		</>
	);
}

export function AvailableSkillsPanel({
  onClose,
	registry,
	availQuery,
	onSetAvailQuery,
	filteredUnequipped,
	dragOver,
	onSetDragOver,
	onDrop,
	scopeGroups,
	availNav,
	availRowIndex,
	equipStatus,
	expandedAvailable,
	onToggleAvailableDetails,
	onEnableSkill,
	onReadSkill,
}: {
  onClose?: () => void;
	registry: Registry;
	availQuery: string;
	onSetAvailQuery: (q: string) => void;
	filteredUnequipped: string[];
	dragOver: "equipped" | "avail" | null;
	onSetDragOver: (zone: "equipped" | "avail" | null) => void;
	onDrop: (zone: "equipped" | "avail", skillName: string) => void;
	scopeGroups: { scope: SkillScope; label: string; names: string[] }[];
	availNav: ListNav;
	availRowIndex: Map<string, number>;
	equipStatus: Record<string, EquipStatus>;
	expandedAvailable: Set<string>;
	onToggleAvailableDetails: (skillName: string) => void;
	onEnableSkill: (skillName: string) => void;
	onReadSkill: (skillName: string) => void;
}) {
	const search = useRef<HTMLInputElement>(null);
	useEffect(() => { search.current?.focus(); }, []);
	return (
		/* Side panel: Available */
		<div className="workspace-side">
			<div className="avail-panel-head">
        {onClose && <Button className="avail-panel-close" variant="ghost" size="sm" icon="x" onClick={onClose}>Close library</Button>}
				<div className="avail-panel-title-row">
					<div className="avail-panel-title">Available</div>
					<span className="text-dim text-mono avail-panel-count">
						{filteredUnequipped.length}
					</span>
				</div>
				<div className="avail-panel-search">
					<SearchInput
						value={availQuery}
						onChange={onSetAvailQuery}
						placeholder="Filter library…"
 inputRef={search}
 screenSearch
					/>
				</div>
				{/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- this list delegates roving j/k, Enter, and e from its focusable list items; Read keeps its own native-button keys. */}
				<div
					role="list"
					onKeyDown={(event) => {
						// Read is a sibling native button. Its Enter/Space belongs to
						// that action, never to the list's Enter-to-equip binding.
						if ((event.target as HTMLElement).closest(".avail-row-read")) return;
						availNav.containerProps.onKeyDown(event);
					}}
					className={`avail-list ${dragOver === "avail" ? "dropzone-active" : ""}`.trim()}
					aria-label="Available skills"
					onDragOver={(e) => {
						e.preventDefault();
						onSetDragOver("avail");
					}}
					onDragLeave={() => onSetDragOver(null)}
					onDrop={(e) => onDrop("avail", e.dataTransfer.getData("text/skill"))}
				>
					{scopeGroups.map((group) => {
						if (group.names.length === 0) return null;
						return (
							<div key={group.scope} className="avail-scope-group">
								<div className="avail-scope-label">
									{group.label} · {group.names.length}
								</div>
								{group.names.map((name) => {
									const s = registry.skills[name];
									if (!s) return null;
									const status = equipStatus[name];
									const isPending = status === "pending";
									const isExpanded = expandedAvailable.has(name);
									const bundleNames = Object.entries(registry.bundles)
										.filter(([, bundle]) => bundle.skills?.includes(name))
										.map(([bundleName]) => bundleName);
									const rowNavProps = availNav.itemProps(
										availRowIndex.get(name) ?? 0,
									);
									return (
										<div
											key={name}
											className="avail-row-wrap"
											data-status={status ?? "idle"}
											data-loadout-focus={`available:${name}`}
											role="listitem"
											tabIndex={rowNavProps.tabIndex}
											data-listnav-active={rowNavProps["data-listnav-active"]}
											ref={rowNavProps.ref}
										>
											<ResourceRow
												className="avail-row"
												tabIndex={-1}
												title={name}
												ariaLabel={`Equip ${name}`}
												ariaBusy={isPending}
												draggable={!isPending}
												onDragStart={(e) =>
													e.dataTransfer.setData("text/skill", name)
												}
												onClick={() => {
													if (!isPending) onEnableSkill(name);
												}}
												name={name}
													meta={<><KindMark kind={s.type} /> <ProspectiveCostCell name={name} /></>}
												badges={
													<>
														<span className="equip-copy">
															{status === "success"
																? "Equipped"
																: status === "error"
																	? "Retry"
																	: isPending
																		? "Equipping…"
																		: "Equip"}
														</span>
														<Icon
															name={status === "success" ? "check" : "plus"}
															size={12}
															className="equip"
														/>
													</>
												}
												detail={
													<AvailableSkillDetail
														skill={s}
														bundleNames={bundleNames}
													/>
												}
												detailOpen={isExpanded}
												onDetailToggle={() => onToggleAvailableDetails(name)}
												detailLabel={`${name} summary`}
											/>
											<Button
												className="avail-row-read"
												variant="ghost"
												size="sm"
												aria-label={`Read skill ${name}`}
												onClick={() => onReadSkill(name)}
											>
												Read skill
											</Button>
										</div>
									);
								})}
							</div>
						);
					})}
					{filteredUnequipped.length === 0 && (
						<div className="avail-empty">
							{availQuery ? "No skills match the filter." : "Every skill is equipped."}
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
