import { useState } from "react";
import { Button } from "@/components/Button";
import { EmptyState } from "@/components/EmptyState";
import { Icon } from "@/components/Icon";
import { Tag } from "@/components/Tag";
import { Toggle } from "@/components/Toggle";
import { useToast } from "@/components/Toast";
import { useRegistry } from "@/hooks/useRegistry";
import {
	useLinkSubagent,
	useSetSubagentDisabled,
	useSubagentList,
} from "@/hooks/useSubagents";
import {
	sandboxSummary,
	toolAccessSummary,
	type SubagentBuiltin,
	type SubagentHarness,
	type SubagentLink,
	type SubagentListItem,
	type SubagentScope,
} from "@/lib/subagents";
import { HarnessGlyph } from "@/components/harness/HarnessGlyph";
import { harnessLabel } from "@/components/harness/harnessRegistry";
import { NewSubagentSheet } from "./NewSubagentSheet";

export interface SubagentListProps {
	/** Harness whose agents this list reads/writes (default claude-code). */
	harness?: SubagentHarness;
	scope: SubagentScope;
	project: string | null;
	onScopeChange: (scope: SubagentScope, project: string | null) => void;
	onOpen: (scope: SubagentScope, project: string | null, name: string) => void;
	/** Hide the User/Project scope switcher (the project tab fixes the scope). */
	hideScopeSwitcher?: boolean;
	/** Disable the Project scope pill with this hint (codex user-scope only). */
	projectScopeDisabledHint?: string;
}

export function SubagentList({
	harness = "claude-code",
	scope,
	project,
	onScopeChange,
	onOpen,
	hideScopeSwitcher = false,
	projectScopeDisabledHint,
}: SubagentListProps) {
	const { data: registry } = useRegistry();
	const projectNames = registry ? Object.keys(registry.projects) : [];
	const {
		data: list,
		isLoading,
		error,
	} = useSubagentList(scope, project, scope === "user" || !!project, harness);
	const [newOpen, setNewOpen] = useState(false);
	const isCodex = harness === "codex";

	return (
		<div className="subagent-list">
			{/* ── Scope switcher ── */}
			<div className="subagent-scope-bar">
				{!hideScopeSwitcher && (
					<>
						<div className="chips" role="tablist" aria-label="Scope">
							<button
								type="button"
								className="chip"
								role="tab"
								aria-pressed={scope === "user"}
								onClick={() => onScopeChange("user", null)}
							>
								<Icon name="scope.global" size={12} />
								<span className="chip-label">User</span>
							</button>
							<button
								type="button"
								className="chip"
								role="tab"
								aria-pressed={scope === "project"}
								disabled={
									projectNames.length === 0 || !!projectScopeDisabledHint
								}
								title={projectScopeDisabledHint}
								onClick={() =>
									onScopeChange("project", project ?? projectNames[0] ?? null)
								}
							>
								<Icon name="project" size={12} />
								<span className="chip-label">Project</span>
							</button>
						</div>
						{projectScopeDisabledHint && (
							<span
								className="text-dim"
								style={{ fontSize: 11, alignSelf: "center" }}
							>
								{projectScopeDisabledHint}
							</span>
						)}
						{scope === "project" && (
							<select
								className="subagent-project-select"
								value={project ?? ""}
								onChange={(e) =>
									onScopeChange("project", e.target.value || null)
								}
								aria-label="Project"
							>
								{projectNames.length === 0 && (
									<option value="">No projects</option>
								)}
								{projectNames.map((p) => (
									<option key={p} value={p}>
										{p}
									</option>
								))}
							</select>
						)}
					</>
				)}
				<span className="stretch" />
				<Button
					variant="primary"
					icon="plus"
					onClick={() => setNewOpen(true)}
				>
					New sub-agent
				</Button>
			</div>

			{error ? (
				<EmptyState
					icon="warning"
					title="Could not load sub-agents"
					description={String(error)}
				/>
			) : isLoading ? (
				<div className="subagent-loading">Loading sub-agents…</div>
			) : !list || list.agents.length === 0 ? (
				<EmptyState
					icon="agent"
					title="No sub-agents yet"
					description={
						scope === "user"
							? "Create a sub-agent to delegate focused tasks to a tailored Claude Code persona."
							: `No sub-agents in ${project ?? "this project"}'s .claude/agents/ yet.`
					}
					action={
						<Button
							variant="primary"
							icon="plus"
							onClick={() => setNewOpen(true)}
						>
							New sub-agent
						</Button>
					}
				/>
			) : (
				<>
					{list.links_warning && (
						<div className="subagent-links-warning" role="status">
							<Icon name="warning" size={11} /> {list.links_warning}
						</div>
					)}
					<div className="subagent-grid">
						{list.agents.map((a) => (
							<AgentCard
								key={a.name}
								agent={a}
								scope={scope}
								project={project}
								harness={harness}
								onOpen={() => onOpen(scope, project, a.name)}
							/>
						))}
					</div>
				</>
			)}

			{/* ── Built-ins strip ── */}
			{list && list.builtins.length > 0 && (
				<div className="subagent-builtins">
					<div className="harnesses-section-eyebrow">
						<Icon name="agent" size={12} />
						<span>
							{isCodex
								? "Built-in agents (read-only)"
								: "Built-in agents (read-only · disable only)"}
						</span>
					</div>
					<div className="subagent-builtins-list">
						{list.builtins.map((b) => (
							<BuiltinRow
								key={b.name}
								builtin={b}
								scope={scope}
								project={project}
								harness={harness}
							/>
						))}
					</div>
				</div>
			)}

			{newOpen && (
				<NewSubagentSheet
					harness={harness}
					scope={scope}
					project={project}
					projects={projectNames}
					onClose={() => setNewOpen(false)}
					onCreated={(s, p, name) => {
						setNewOpen(false);
						onOpen(s, p, name);
					}}
				/>
			)}
		</div>
	);
}

// ─── Cards ────────────────────────────────────────────────────────────────────

function DisableSwitch({
	scope,
	project,
	name,
	disabled,
	builtin,
	harness = "claude-code",
}: {
	scope: SubagentScope;
	project: string | null;
	name: string;
	disabled: boolean;
	builtin?: boolean;
	harness?: SubagentHarness;
}) {
	const toast = useToast();
	const mut = useSetSubagentDisabled(scope, project, harness);
	// Claude toggles a settings.json deny rule; Codex renames the file out of the
	// `*.toml` glob — surface a harness-appropriate hint.
	const title =
		harness === "codex"
			? disabled
				? "Enable renames the file back into the *.toml glob"
				: "Disable renames the file to *.toml.disabled"
			: disabled
				? `Enabled removes the Agent(${name}) deny rule`
				: `Disabling adds Agent(${name}) to permissions.deny`;
	return (
		<span
			className="subagent-switch"
			title={title}
			onClick={(e) => e.stopPropagation()}
		>
			<Toggle
				variant="switch"
				size="sm"
				checked={!disabled}
				ariaLabel={`${disabled ? "Enable" : "Disable"} ${name}`}
				label={disabled ? "Off" : builtin ? "On" : "Enabled"}
				onChange={(checked) => {
					mut
						.mutateAsync({ name, disabled: !checked })
						.catch((err) => toast.error("Couldn't toggle sub-agent", String(err)));
				}}
			/>
		</span>
	);
}

function AgentCard({
	agent,
	scope,
	project,
	harness,
	onOpen,
}: {
	agent: SubagentListItem;
	scope: SubagentScope;
	project: string | null;
	harness: SubagentHarness;
	onOpen: () => void;
}) {
	const isCodex = harness === "codex";
	const hasIssue = agent.warnings.some(
		(w) => w.level === "warn" || w.level === "error",
	);
	const hasError = agent.warnings.some((w) => w.level === "error") || !agent.valid;
	return (
		<div
			className="subagent-card"
			data-disabled={agent.disabled || undefined}
			onClick={onOpen}
			role="button"
			tabIndex={0}
			onKeyDown={(e) => {
				if (e.key === "Enter" || e.key === " ") onOpen();
			}}
		>
			<div className="subagent-card-head">
				{/* Codex has no per-agent color — render a neutral glyph, no color dot. */}
				<span
					className="subagent-card-glyph"
					data-color={isCodex ? undefined : agent.color || undefined}
				>
					<Icon name="agent" size={18} />
				</span>
				<div className="subagent-card-id">
					<div className="subagent-card-name text-mono">{agent.name}</div>
					<div className="subagent-card-model text-mono text-dim">
						{agent.model || "inherit"}
					</div>
				</div>
				{hasIssue && (
					<span
						className="subagent-validity-dot"
						data-tone={hasError ? "error" : "warn"}
						title={agent.warnings.map((w) => w.message).join("\n")}
					/>
				)}
			</div>

			<div className="subagent-card-desc">
				{agent.description || (
					<span className="text-dim">No description</span>
				)}
			</div>

			<div className="subagent-card-meta">
				<Tag size="sm">
					{isCodex ? sandboxSummary(agent) : toolAccessSummary(agent)}
				</Tag>
				{agent.skills.length > 0 && (
					<Tag size="sm" color="var(--violet)">
						{agent.skills.length} skill{agent.skills.length === 1 ? "" : "s"}
					</Tag>
				)}
			</div>

			{agent.link && (
				<CardLinkRow
					link={agent.link}
					name={agent.name}
					scope={scope}
					project={project}
					harness={harness}
				/>
			)}

			<div className="subagent-card-foot" onClick={(e) => e.stopPropagation()}>
				<DisableSwitch
					scope={scope}
					project={project}
					name={agent.name}
					disabled={agent.disabled}
					harness={harness}
				/>
				<Button variant="ghost" size="sm" icon="arrow-right" onClick={onOpen}>
					Edit
				</Button>
			</div>
		</div>
	);
}

/**
 * Compact one-row link-presence strip on a user-scope card (D3):
 *  - linked      → "also in <other harness>" chip (+ "twin missing" when lost)
 *  - suggested   → a subtle "same name in <other> — Link?" action chip
 * One row, no new card sections — keeps the list dense.
 */
function CardLinkRow({
	link,
	name,
	scope,
	project,
	harness,
}: {
	link: SubagentLink;
	name: string;
	scope: SubagentScope;
	project: string | null;
	harness: SubagentHarness;
}) {
	const toast = useToast();
	const linkMut = useLinkSubagent(scope, project);
	const others = link.harnesses.filter((h) => h !== harness);
	const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();

	if (link.linked) {
		return (
			<div className="subagent-link-row" onClick={stop}>
				{link.twin_lost ? (
					<span
						className="subagent-link-chip"
						data-tone="warn"
						title="A linked twin file is missing — it was renamed or deleted outside Skill Tree."
					>
						<Icon name="warning" size={11} /> linked twin missing
					</span>
				) : (
					<span
						className="subagent-link-chip"
						data-tone="linked"
						title={`Linked — shares its core with ${others
							.map(harnessLabel)
							.join(", ")}.`}
					>
						<Icon name="link" size={11} />
						<span>also in</span>
						{others.map((h) => (
							<span key={h} className="subagent-link-harness">
								<HarnessGlyph id={h} size={12} decorative />
								{harnessLabel(h)}
							</span>
						))}
					</span>
				)}
			</div>
		);
	}

	if (link.suggested) {
		return (
			<div className="subagent-link-row" onClick={stop}>
				<button
					type="button"
					className="subagent-link-chip"
					data-tone="suggest"
					disabled={linkMut.isPending}
					title={`A same-named agent exists in ${others
						.map(harnessLabel)
						.join(", ")}. Link them to share one core.`}
					onClick={() =>
						linkMut
							.mutateAsync({ name })
							.then((res) =>
								res.ok
									? toast.success(`Linked ${name}`)
									: toast.error("Couldn't link sub-agent", res.error ?? "could not link"),
							)
							.catch((err) => toast.error("Couldn't link sub-agent", String(err)))
					}
				>
					<Icon name="link" size={11} />
					same name in {others.map(harnessLabel).join(", ")} — Link?
				</button>
			</div>
		);
	}

	return null;
}

function BuiltinRow({
	builtin,
	scope,
	project,
	harness,
}: {
	builtin: SubagentBuiltin;
	scope: SubagentScope;
	project: string | null;
	harness: SubagentHarness;
}) {
	// Codex built-ins (default/worker/explorer) have no file — hub cannot disable
	// them, so show a read-only hint instead of a (broken) toggle (D6 / MINOR-7).
	const canDisable = harness !== "codex";
	return (
		<div className="subagent-builtin-row" data-disabled={builtin.disabled || undefined}>
			<span className="subagent-builtin-glyph">
				<Icon name="agent" size={14} />
			</span>
			<div className="subagent-builtin-id">
				<span className="text-mono subagent-builtin-name">{builtin.name}</span>
				{builtin.description && (
					<span className="subagent-builtin-desc text-dim">
						{builtin.description}
					</span>
				)}
			</div>
			<span className="text-mono text-dim subagent-builtin-model">
				{builtin.model || "inherit"}
			</span>
			{canDisable ? (
				<DisableSwitch
					scope={scope}
					project={project}
					name={builtin.name}
					disabled={builtin.disabled}
					harness={harness}
					builtin
				/>
			) : (
				<span
					className="text-dim text-mono"
					style={{ fontSize: 11 }}
					title="Codex built-ins cannot be disabled by Skill Tree."
				>
					read-only
				</span>
			)}
		</div>
	);
}
