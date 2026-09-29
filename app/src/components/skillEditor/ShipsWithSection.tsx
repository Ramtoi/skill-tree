import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { SidePanelSection, openSidePanelSection } from "@/components/SidePanelSection";
import { Button } from "@/components/Button";
import { useToast } from "@/components/Toast";
import { CompanionRow, companionRowKey } from "@/components/companions/CompanionRow";
import { CompanionsEditSheet } from "@/components/companions/CompanionsEditSheet";
import { useHookList } from "@/hooks/useHooks";
import { useSubagentList } from "@/hooks/useSubagents";
import { equipWithGate } from "@/hooks/useCompanionGate";
import { isExternalManaged } from "@/lib/skillSource";
import { hubCmd } from "@/lib/hubCmd";
import { parseHubJson } from "@/lib/cloud";
import { qk } from "@/lib/queryKeys";
import { plural } from "@/lib/plural";
import {
	declaredRows,
	glyphStateFor,
	groupRows,
	isHookRef,
	statusLine,
	type CompanionItem,
	type CompanionsPayload,
	type DeclRow,
	type ShipsWith,
	type ShipsWithHook,
} from "@/lib/companions";
import type { Skill } from "@/types";

export interface ShipsWithSectionProps {
	skillName: string;
	skill: Skill;
	/** The project this editor is being viewed in the context of, when known —
	 *  the read-only skill editor route (`/skill/:name`) carries no project
	 *  today, so this is `undefined`/`null` there; a future call site that
	 *  knows its project (e.g. arriving from a project's loadout) can pass
	 *  one to turn on per-project reads/`Provision` (A5). */
	project?: string | null;
	storageKey?: string;
}

/** Total declared companions across every kind — 0 (or an absent block) means
 *  the section has nothing to show. */
function shipsWithTotal(sw: ShipsWith | undefined): number {
	if (!sw) return 0;
	return (
		(sw.agents?.length ?? 0) +
		(sw.hooks?.length ?? 0) +
		(sw.permissions?.allow?.length ?? 0) +
		(sw.permissions?.deny?.length ?? 0) +
		(sw.permissions?.ask?.length ?? 0)
	);
}

/** "6 agents · 3 hooks · 2 rules" — the closed-state summary, read for free
 *  from the mirror (no live read, so it costs nothing while the section is
 *  collapsed). Omits any zero count. */
function summaryText(sw: ShipsWith): string {
	const nAgents = sw.agents?.length ?? 0;
	const nHooks = sw.hooks?.length ?? 0;
	const nRules =
		(sw.permissions?.allow?.length ?? 0) +
		(sw.permissions?.deny?.length ?? 0) +
		(sw.permissions?.ask?.length ?? 0);
	const parts: string[] = [];
	if (nAgents > 0) parts.push(`${nAgents} ${plural(nAgents, "agent")}`);
	if (nHooks > 0) parts.push(`${nHooks} ${plural(nHooks, "hook")}`);
	if (nRules > 0) parts.push(`${nRules} ${plural(nRules, "rule")}`);
	return parts.join(" · ");
}

/** Why the `Edit` rung stays disabled for a `managed: "external"` skill
 *  (D10: "the same message the invocation override uses") — every other
 *  skill's `Edit` opens `CompanionsEditSheet`. */
const EDIT_EXTERNAL_REASON =
	"This skill is owned by an external source, so its companions are read-only.";

/** `hub skill companions <skill> [--project <p>] --json` (A5/I5). */
async function fetchCompanions(
	skillName: string,
	project: string | null | undefined,
): Promise<CompanionsPayload> {
	const args = [
		"skill",
		"companions",
		skillName,
		...(project ? ["--project", project] : []),
		"--json",
	];
	const result = await hubCmd(args);
	if (!result.success) throw new Error(result.output || "hub skill companions failed");
	return parseHubJson<CompanionsPayload>(result.output);
}

/** Every live-read item matching one declared row, across whichever harnesses
 *  the read reported. `[]` before the query resolves or on error. */
function itemsFor(payload: CompanionsPayload | undefined, row: DeclRow): CompanionItem[] {
	if (!payload) return [];
	return payload.items.filter((it) => {
		if (it.kind !== row.kind) return false;
		if (row.kind === "permission") return it.name === row.name && it.rule_kind === row.rule_kind;
		return it.name === row.name;
	});
}

/**
 * The body's own component so its live reads only ever run once
 * `SidePanelSection` actually mounts it (see the original comment this
 * carries forward: `SidePanelSection` renders `{open && <div>{children}</div>}`,
 * so a hook in this function's body never executes while the section is
 * closed). Three lazy reads live here: the companions read itself, the hooks
 * library (to resolve a `{ref}` hook's description, A18/C5), and the
 * user-scope Claude sub-agent list (to resolve an agent's description) —
 * none of them fire until the reader actually opens the section.
 */
function ShipsWithRows({
	skillName,
	sw,
	project,
}: {
	skillName: string;
	sw: ShipsWith;
	project?: string | null;
}) {
	const queryClient = useQueryClient();
	const toast = useToast();
	const [provisioning, setProvisioning] = useState(false);

	const { data: payload } = useQuery({
		queryKey: qk.skillCompanions(skillName, project ?? null),
		queryFn: () => fetchCompanions(skillName, project),
	});
	const { data: hookList, isError: hookListFailed } = useHookList();
	const { data: subagentList } = useSubagentList("user", null, true, "claude-code");

	const groups = groupRows(sw);
	const status = payload ? statusLine(payload) : null;
	const projectContext = payload?.project_context ?? false;
	// FRAME TWEAK: whether an `absent` row may wear the "not provisioned"
	// badge, computed once from the whole payload (not re-derived per row):
	// true only when at least one declared item is actually lit somewhere.
	// When every item is absent the section's own status line already says
	// "Not provisioned anywhere" — repeating the same fact on all eleven
	// rows would only crowd out the one thing that still varies, the name.
	// Defaults `true` (today's behaviour) before the read resolves.
	const absentBadge = payload
		? payload.items.some((i) => i.state != null && glyphStateFor(i.state) === "lit")
		: true;

	const hooksByName = new Map((hookList?.hooks ?? []).map((h) => [h.name, h]));
	// F2/S4: gates a hook row's routability on library presence. `undefined`
	// (not yet resolved) is a distinct, deliberately-unrouteable state from
	// "resolved, empty" (`companionRoute` treats both the same way, but only
	// this one is genuinely "the read hasn't come back yet"). `null` is a
	// THIRD state — the read came back but FAILED — where `companionRoute`
	// falls back to the row's own CLI-supplied route instead of inerting it.
	const hookNames = hookList
		? new Set(hookList.hooks.map((h) => h.name))
		: hookListFailed
			? null
			: undefined;
	const agentsByName = new Map((subagentList?.agents ?? []).map((a) => [a.name, a]));
	const inlineHooksByName = new Map(
		(sw.hooks ?? [])
			.filter((h): h is ShipsWithHook => !isHookRef(h))
			.map((h) => [h.name, h]),
	);

	function descriptionFor(row: DeclRow): string | undefined {
		if (row.kind === "agent") return agentsByName.get(row.name)?.description;
		if (row.kind === "permission") return `${row.rule_kind} · ${row.name}`;
		if (row.isRef) {
			const h = hooksByName.get(row.name);
			return h ? `${h.event} · ${h.command}` : undefined;
		}
		const inline = inlineHooksByName.get(row.name);
		return inline ? `${inline.event} · ${inline.command}` : undefined;
	}

	async function handleProvision() {
		// A17: a global-scope skill's Provision would run with NO --project —
		// the gate (`equipWithGate`) only ever runs a project-scoped `hub
		// enable` today, so a project-less pending count has no wired action
		// yet (Follow-up for the wave that extends the gate for global scope).
		if (!project) return;
		setProvisioning(true);
		try {
			await equipWithGate(skillName, project);
			await queryClient.invalidateQueries({ queryKey: qk.skillCompanionsAll() });
			toast.success(`Provisioned ${skillName} on ${project}`);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (message.includes("already open")) {
				toast.info("Another equip is open — finish it first.");
			} else {
				toast.error("Couldn't provision companions", message);
			}
		} finally {
			setProvisioning(false);
		}
	}

	return (
		<>
			{status && (
				<div
					className="companion-status-line"
					data-testid="companion-status-line"
					data-tone={status.tone}
				>
					<span>{status.text}</span>
					{status.showProvision && (
						<Button
							size="sm"
							variant="ghost"
							busy={provisioning}
							disabled={!project}
							disabledReason={
								!project ? "Open this skill from a project to provision." : undefined
							}
							onClick={() => void handleProvision()}
							data-testid="companion-provision"
						>
							Provision
						</Button>
					)}
					{status.action && (
						<Button
							size="sm"
							variant="ghost"
							onClick={() => openSidePanelSection("usedby")}
							data-testid="companion-status-action"
						>
							{status.action.label}
						</Button>
					)}
				</div>
			)}
			<div className="companions-stack">
				{groups.map((group) => (
					<div key={group.kind} className="companions-group">
						<div className="equip-group">
							<span className="equip-group-name">{group.label}</span>
							<span className="equip-group-count">{group.rows.length}</span>
						</div>
						{group.rows.map((row) => (
							<CompanionRow
								key={companionRowKey(row)}
								row={row}
								items={itemsFor(payload, row)}
								skill={skillName}
								description={descriptionFor(row)}
								project={project}
								projectContext={projectContext}
								hookNames={hookNames}
								absentBadge={absentBadge}
							/>
						))}
					</div>
				))}
			</div>
		</>
	);
}

/**
 * SHIPS WITH — one dense row per companion a skill declares (D1/D7): its kind
 * icon, a hover-carded link, and a harness glyph cluster carrying provisioning
 * STATE (never a verdict word). Built like `SkillRefsSection`: a
 * `SidePanelSection` whose closed head already states the shape (`6 agents ·
 * 3 hooks · 2 rules`) from the registry mirror alone, plus an `Edit` rung
 * that opens `CompanionsEditSheet` (disabled with a reason on a
 * `managed: "external"` skill) and, once open, ONE project-aware status
 * line. Absent entirely when the skill declares nothing.
 */
export function ShipsWithSection({ skillName, skill, project, storageKey }: ShipsWithSectionProps) {
	const sw = skill.ships_with;
	const [editOpen, setEditOpen] = useState(false);
	// The Sheet mounts only once the reader has actually clicked `Edit` —
	// same discipline as `ShipsWithRows`' own lazy live reads: its picker data
	// (`useCompanionPickerData`) is a real `subagent_list`/`hook_list` read,
	// which must not fire just because a skill with companions was opened.
	const [everOpened, setEverOpened] = useState(false);
	if (!sw || shipsWithTotal(sw) === 0) return null;
	const count = declaredRows(sw).length;
	const external = isExternalManaged(skill);

	return (
		<>
			<SidePanelSection
				id="ships-with"
				title="Ships with"
				count={count}
				storageKey={storageKey}
				summary={
					<>
						<span className="text-dim">{summaryText(sw)}</span>
						<Button
							size="sm"
							variant="ghost"
							disabled={external}
							disabledReason={external ? EDIT_EXTERNAL_REASON : undefined}
							onClick={() => {
								setEverOpened(true);
								setEditOpen(true);
							}}
							data-testid="ships-with-edit"
						>
							Edit
						</Button>
					</>
				}
			>
				<ShipsWithRows skillName={skillName} sw={sw} project={project} />
			</SidePanelSection>
			{everOpened && (
				<CompanionsEditSheet
					open={editOpen}
					onClose={() => setEditOpen(false)}
					skillName={skillName}
					declared={sw}
				/>
			)}
		</>
	);
}
