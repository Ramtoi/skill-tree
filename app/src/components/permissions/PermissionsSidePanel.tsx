import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Icon } from "../Icon";
import { Plaque } from "../Plaque";
import { SidePanelSection } from "../SidePanelSection";
import { StatePill } from "../StatePill";
import { HarnessGlyph, HarnessIconGroup } from "../harness/HarnessGlyph";
import { ruleAppliesToHarness, type HarnessFilter } from "@/lib/permissionHarnessFilter";
import {
	orphanSettings,
	partitionSettings,
	settingValueLabels,
	supportingHarnesses,
} from "@/lib/permissionSettingSupport";
import type {
	Capabilities,
	NormalizedPermissions,
	PermissionFeature,
	Scope,
} from "@/types/permissions";
import { CodexRulesSection, codexRuleLines } from "./CodexRulesSection";
import { CommandSimulator } from "./CommandSimulator";
import { HarnessFilterTabs, PermSublineCounts } from "./PermissionsPanels";
import { PermissionSettingRow } from "./PermissionSettingRow";
import { WorktreeAccessSection } from "./WorktreeAccessSection";
import type { PermissionsShowProject } from "@/types/permissions";

const SECTIONS_STORAGE_KEY = "st:permissions:sections";

const PATTERN_EXAMPLES: Array<{ pat: string; hint: string }> = [
	{ pat: "Bash(npm:*)", hint: "any npm subcommand" },
	{ pat: "Bash(npm run *:*)", hint: "any npm run script" },
	{ pat: "Read(src/**)", hint: "every file under src" },
	{ pat: "Edit(**/*.tsx)", hint: "any TSX in the tree" },
	{ pat: "WebFetch(domain:example.com)", hint: "fetch by host" },
];

export interface PermissionsSidePanelProps {
	scope: Scope;
	draft: NormalizedPermissions;
	onChange: (next: NormalizedPermissions) => void;
	installed: string[];
	capabilities: Capabilities;
	labels: Record<string, string>;
	globalDraft: NormalizedPermissions | null;
	harnessFilter: HarnessFilter;
	onHarnessFilter: (f: HarnessFilter) => void;
	projectCount: number;
	projectPills: Array<{ name: string }>;
	inheritedAllow: number;
	inheritedDeny: number;
	inheritedAsk: number;
	inheritedHooks: number;
	hookCount: number;
	/** True when any of the four harness-level settings differs from the
	 *  last-loaded server payload (side-panel rule 11) — forces the Shared /
	 *  Settings section open regardless of the reader's own collapse choice. */
	settingsDirty: boolean;
	worktreeSuggestion?: string;
	worktreeStatus?: PermissionsShowProject["worktree_access_status"];
	personalActive?: boolean;
}

/** Internal props the two views need beyond the panel's own contract — the
 *  simulator's command is lifted to `PermissionsSidePanel` (one `useState`)
 *  so it survives a tab switch and a section collapse/reopen. */
type ViewProps = PermissionsSidePanelProps & {
	command: string;
	onCommandChange: (next: string) => void;
};

/** The command simulator's `SidePanelSection` wrapper — identical in both
 *  views, so it lives once. */
function SimulateSection({
	draft,
	installed,
	capabilities,
	labels,
	command,
	onCommandChange,
}: Pick<
	ViewProps,
	"draft" | "installed" | "capabilities" | "labels" | "command" | "onCommandChange"
>) {
	return (
		<SidePanelSection
			id="simulate"
			title="Try a command"
			defaultOpen
			storageKey={SECTIONS_STORAGE_KEY}
		>
			<CommandSimulator
				draft={draft}
				installed={installed}
				capabilities={capabilities}
				harnessLabels={labels}
				command={command}
				onCommandChange={onCommandChange}
			/>
		</SidePanelSection>
	);
}

/** The Codex trust warning: project scope, Codex installed, ≥1 translatable
 *  rule. Safety-bearing, so it renders once at the top of the panel — in
 *  EVERY view, not gated behind clicking the Codex tab. */
function CodexTrustPlaque({
	scope,
	installed,
	draft,
}: {
	scope: Scope;
	installed: string[];
	draft: NormalizedPermissions;
}) {
	if (scope.kind !== "project" || !installed.includes("codex")) return null;
	if (codexRuleLines(draft).lines.length === 0) return null;
	return (
		<Plaque
			accent="amber"
			eyebrow="Grants Codex trust"
			data-testid="codex-trust-plaque"
		>
			<p className="source-banner-copy">
				Saving these rules marks this project trusted in Codex. Trust also
				activates a committed <code>.codex/config.toml</code> and
				project-local hooks.
			</p>
		</Plaque>
	);
}

/** Pattern-syntax cheatsheet — identical body in both views, closed by default. */
function PatternSyntaxSection() {
	return (
		<SidePanelSection
			id="syntax"
			title="Pattern syntax"
			summary="glob × tool prefix"
			storageKey={SECTIONS_STORAGE_KEY}
		>
			<div className="perm-cheat">
				{PATTERN_EXAMPLES.map((e) => (
					<div className="perm-cheat-row" key={e.pat}>
						<code>{e.pat}</code>
						<span>{e.hint}</span>
					</div>
				))}
			</div>
			<div className="perm-side-hint">Deny wins, then ask, then allow.</div>
		</SidePanelSection>
	);
}

/** The hooks pointer row — a fact + a link to the surface that owns hooks now,
 *  never a section (idle information is a line, not a disclosure). */
function HooksRow({
	count,
	hookHarnesses,
	labels,
}: {
	count: number;
	hookHarnesses: string[];
	labels: Record<string, string>;
}) {
	return (
		<div className="perm-hooks-row" data-testid="hooks-link-card">
			<Icon name="hook" size={12} />
			<span>
				{count} hook{count === 1 ? "" : "s"} attached here
			</span>
			{hookHarnesses.length > 0 && (
				<HarnessIconGroup ids={hookHarnesses} labels={labels} size={14} />
			)}
			<Link to="/hooks" className="perm-hooks-link">
				Manage on Hooks →
			</Link>
		</div>
	);
}

function ScopeFacts({
	scope,
	projectCount,
	projectPills,
	inheritedAllow,
	inheritedDeny,
	inheritedAsk,
	inheritedHooks,
}: {
	scope: Scope;
	projectCount: number;
	projectPills: Array<{ name: string }>;
	inheritedAllow: number;
	inheritedDeny: number;
	inheritedAsk: number;
	inheritedHooks: number;
}) {
	if (scope.kind === "global") {
		return (
			<div className="side-panel-block">
				<dl className="kv">
					<div className="kv-row">
						<dt>PROJECTS</dt>
						<dd className="kv-static">
							{projectCount} project{projectCount === 1 ? "" : "s"}
						</dd>
					</div>
				</dl>
				{projectPills.length > 0 && (
					<div className="perm-applied-grid">
						{projectPills.map((p) => (
							<span className="perm-applied-pill" key={p.name}>
								{p.name}
							</span>
						))}
					</div>
				)}
				<div className="perm-side-hint">
					Global rules fall back into every project.
				</div>
			</div>
		);
	}
	return (
		<div className="side-panel-block">
			<dl className="kv">
				<div
					className="kv-row"
					title="Inherited rules are read-only here. Copy to project overrides one locally; Move to global pushes a project rule up."
				>
					<dt>INHERITED</dt>
					<dd>
						<PermSublineCounts
							counts={{
								allow: inheritedAllow,
								deny: inheritedDeny,
								ask: inheritedAsk,
							}}
						/>
						{inheritedHooks > 0 && (
							<span> · {inheritedHooks} hook{inheritedHooks === 1 ? "" : "s"}</span>
						)}
					</dd>
				</div>
			</dl>
			<div className="perm-side-hint">
				Copy to project overrides a rule here. Move to global pushes one up.
			</div>
		</div>
	);
}

function AllView({
	scope,
	draft,
	onChange,
	installed,
	capabilities,
	labels,
	globalDraft,
	projectCount,
	projectPills,
	inheritedAllow,
	inheritedDeny,
	inheritedAsk,
	inheritedHooks,
	hookCount,
	onHarnessFilter,
	settingsDirty,
	command,
	onCommandChange,
}: ViewProps) {
	const { shared, exclusive } = partitionSettings(installed, capabilities);
	const orphans = orphanSettings(draft, installed, capabilities);
	const hookHarnesses = installed.filter((id) =>
		(capabilities[id] ?? []).includes("hooks"),
	);
	const exclusiveEntries = Object.entries(exclusive);
	const exclusiveSettingCount = exclusiveEntries.reduce(
		(n, [, feats]) => n + feats.length,
		0,
	);
	const isEmpty =
		shared.length === 0 && orphans.length === 0 && exclusiveEntries.length === 0;
	const setLabels = settingValueLabels(draft);

	return (
		<>
			<ScopeFacts
				scope={scope}
				projectCount={projectCount}
				projectPills={projectPills}
				inheritedAllow={inheritedAllow}
				inheritedDeny={inheritedDeny}
				inheritedAsk={inheritedAsk}
				inheritedHooks={inheritedHooks}
			/>
			<SimulateSection
				draft={draft}
				installed={installed}
				capabilities={capabilities}
				labels={labels}
				command={command}
				onCommandChange={onCommandChange}
			/>
			<SidePanelSection
				id="shared"
				title="Shared settings"
				count={shared.length + orphans.length + exclusiveSettingCount}
				defaultOpen
				storageKey={SECTIONS_STORAGE_KEY}
				headTitle="Settings honored by two or more installed harnesses."
				forceOpen={settingsDirty}
				summary={
					<>
						<span className="text-dim">
							{setLabels.length > 0 ? `${setLabels.length} set` : "inherit"}
						</span>
						{settingsDirty && <StatePill state="unsaved">unsaved</StatePill>}
					</>
				}
			>
				{isEmpty ? (
					<div className="perm-side-hint">No harness-level settings here.</div>
				) : (
					<>
						{shared.map((feature) => (
							<PermissionSettingRow
								key={feature}
								feature={feature}
								draft={draft}
								onChange={onChange}
								scope={scope}
								globalDraft={globalDraft}
								glyphIds={supportingHarnesses(feature, installed, capabilities)}
								labels={labels}
							/>
						))}
						{orphans.map((feature) => (
							<PermissionSettingRow
								key={feature}
								feature={feature}
								draft={draft}
								onChange={onChange}
								scope={scope}
								globalDraft={globalDraft}
								glyphIds={[]}
								labels={labels}
								orphan
							/>
						))}
						{exclusiveEntries.map(([id, feats]) => {
							const label = labels[id] ?? id;
							return (
								<button
									key={id}
									type="button"
									className="perm-only-row"
									aria-label={`Show ${label}-only settings`}
									onClick={() => onHarnessFilter({ harness: id })}
								>
									<HarnessGlyph id={id} label={label} size={14} decorative />
									<span className="perm-only-row-label">
										{label} only · {feats.length} setting
										{feats.length === 1 ? "" : "s"}
									</span>
									<span aria-hidden="true">→</span>
								</button>
							);
						})}
					</>
				)}
			</SidePanelSection>
			<HooksRow count={hookCount} hookHarnesses={hookHarnesses} labels={labels} />
			<PatternSyntaxSection />
		</>
	);
}

function HarnessView({
	harnessId,
	scope,
	draft,
	onChange,
	installed,
	capabilities,
	labels,
	globalDraft,
	hookCount,
	settingsDirty,
	command,
	onCommandChange,
}: ViewProps & { harnessId: string }) {
	const label = labels[harnessId] ?? harnessId;
	const allRules = [...draft.allow, ...draft.deny, ...draft.ask];
	const applies = allRules.filter((r) =>
		ruleAppliesToHarness(r, harnessId, capabilities),
	).length;

	const sole = installed.length <= 1;
	const { shared, exclusive } = partitionSettings(installed, capabilities);
	const onlyFeats: PermissionFeature[] = sole ? [] : (exclusive[harnessId] ?? []);
	const applicableShared: PermissionFeature[] = shared.filter((f) =>
		supportingHarnesses(f, installed, capabilities).includes(harnessId),
	);
	const sharedFeats: PermissionFeature[] = sole ? [] : applicableShared;
	const soleFeats: PermissionFeature[] = sole ? applicableShared : [];
	const totalSettings = sole
		? soleFeats.length
		: onlyFeats.length + sharedFeats.length;
	const setLabels = settingValueLabels(draft);

	const isCodex = harnessId === "codex";
	const codexResult = isCodex ? codexRuleLines(draft) : null;
	const hookHarnesses = installed.filter((id) =>
		(capabilities[id] ?? []).includes("hooks"),
	);
	const hasHooks = hookHarnesses.includes(harnessId);

	const renderRow = (feature: PermissionFeature, otherIds: string[]) => (
		<PermissionSettingRow
			key={feature}
			feature={feature}
			draft={draft}
			onChange={onChange}
			scope={scope}
			globalDraft={globalDraft}
			glyphIds={otherIds}
			glyphTitle={
				otherIds.length > 0
					? `Also honored by ${otherIds.map((id) => labels[id] ?? id).join(", ")}`
					: undefined
			}
			labels={labels}
		/>
	);

	return (
		<>
			<div className="side-panel-block">
				<dl className="kv">
					{/* The tab strip is glyph-only, so this is the one place the panel
					    actually names the active harness. */}
					<div className="kv-row">
						<dt>HARNESS</dt>
						<dd>
							<HarnessGlyph id={harnessId} label={label} size={14} decorative />
							<span data-testid="perm-side-harness-name">{label}</span>
						</dd>
					</div>
					<div
						className="kv-row"
						title={`${label}: rules this harness can express, minus any whose affinity excludes it. The list on the left is filtered to these.`}
					>
						<dt>RULES</dt>
						<dd className="kv-static">
							{applies} of {allRules.length} apply
						</dd>
					</div>
				</dl>
			</div>
			<SimulateSection
				draft={draft}
				installed={installed}
				capabilities={capabilities}
				labels={labels}
				command={command}
				onCommandChange={onCommandChange}
			/>
			<SidePanelSection
				id="settings"
				title="Settings"
				count={totalSettings}
				defaultOpen
				storageKey={SECTIONS_STORAGE_KEY}
				forceOpen={settingsDirty}
				summary={
					<>
						<span className="text-dim">
							{setLabels.length > 0 ? setLabels.join(" · ") : "inherit"}
						</span>
						{settingsDirty && <StatePill state="unsaved">unsaved</StatePill>}
					</>
				}
			>
				{totalSettings === 0 ? (
					<div className="perm-side-hint">
						{label} takes rules and hooks only. No harness-level settings.
					</div>
				) : sole ? (
					soleFeats.map((f) => renderRow(f, []))
				) : (
					<>
						{onlyFeats.length > 0 && (
							<div className="perm-settings-group" data-group="only">
								<div className="equip-group">
									<div className="equip-group-name">
										ONLY {label.toUpperCase()}{" "}
										<span className="equip-group-count">{onlyFeats.length}</span>
									</div>
								</div>
								{onlyFeats.map((f) => renderRow(f, []))}
							</div>
						)}
						{sharedFeats.length > 0 && (
							<div className="perm-settings-group" data-group="shared">
								<div className="equip-group">
									<div className="equip-group-name">
										SHARED{" "}
										<span className="equip-group-count">
											{sharedFeats.length}
										</span>
									</div>
								</div>
								{sharedFeats.map((f) =>
									renderRow(
										f,
										supportingHarnesses(f, installed, capabilities).filter(
											(id) => id !== harnessId,
										),
									),
								)}
							</div>
						)}
					</>
				)}
			</SidePanelSection>
			{isCodex && codexResult && (
				<SidePanelSection
					id="codex-rules"
					title="Codex rules file"
					count={codexResult.lines.length}
					summary={
						codexResult.skipped > 0 ? `${codexResult.skipped} skipped` : undefined
					}
					defaultOpen
					storageKey={SECTIONS_STORAGE_KEY}
					headTitle="skill-hub.rules — allow→allow, ask→prompt, deny→forbidden. Only a bounded Bash prefix like Bash(npm:*) translates; other rules are skipped for Codex."
				>
					<CodexRulesSection draft={draft} />
				</SidePanelSection>
			)}
			{hasHooks && (
				<HooksRow count={hookCount} hookHarnesses={hookHarnesses} labels={labels} />
			)}
			<PatternSyntaxSection />
		</>
	);
}

/**
 * The permissions screen's side panel (SPEC A). One harness selector — the
 * relocated `HarnessFilterTabs`, glyph-only — drives BOTH the rule list
 * filter (unchanged `harnessFilter` state in `PermissionsEditor`) and which
 * of the two views renders here: an All view (scope facts, shared settings,
 * pointer rows to a harness's exclusive settings) or a single harness's own
 * view (its rule coverage, its settings split into ONLY/SHARED, and — Codex
 * only — the rules-file table). The Codex trust warning and the command
 * simulator's typed value live above the view switch, not inside either
 * view, so neither depends on which tab happens to be pressed.
 */
export function PermissionsSidePanel(props: PermissionsSidePanelProps): ReactNode {
	const { installed, harnessFilter, onHarnessFilter, labels, scope, draft, personalActive } =
		props;
	const [command, setCommand] = useState("");
	const showStrip = installed.length >= 2;
	const singleHarness = installed.length === 1 ? installed[0] : null;

	let viewHarness: string | null = null;
	if (singleHarness) {
		viewHarness = singleHarness;
	} else if (
		showStrip &&
		harnessFilter !== "all" &&
		harnessFilter !== "common"
	) {
		viewHarness = harnessFilter.harness;
	}

	return (
		<aside className="perm-side" data-view={viewHarness ?? "all"}>
			{scope.kind === "project" && !personalActive && (
				<WorktreeAccessSection
					draft={draft}
					onChange={props.onChange}
					suggestion={props.worktreeSuggestion}
					status={props.worktreeStatus}
					installed={installed}
					capabilities={props.capabilities}
					labels={labels}
				/>
			)}
			{showStrip && (
				<div className="perm-harness-tabs-wrap">
					<HarnessFilterTabs
						installed={installed}
						labels={labels}
						filter={harnessFilter}
						onFilter={onHarnessFilter}
					/>
				</div>
			)}
			<CodexTrustPlaque scope={scope} installed={installed} draft={draft} />
			{viewHarness ? (
				<HarnessView
					{...props}
					harnessId={viewHarness}
					command={command}
					onCommandChange={setCommand}
				/>
			) : (
				<AllView {...props} command={command} onCommandChange={setCommand} />
			)}
		</aside>
	);
}
