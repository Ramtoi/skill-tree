import { useEffect, useId, useRef, type ReactNode } from "react";
import { Icon } from "@/components/Icon";
import { StatusBadge } from "@/components/StatusBadge";
import { HarnessTargetsLine } from "@/components/harness/HarnessTargetsLine";
import { KIND_META } from "@/components/permissions/PermissionsPanels";
import { useRegistry } from "@/hooks/useRegistry";
import { PROJECT_AREAS, type ProjectArea } from "@/lib/projectViews";
import { plural } from "@/lib/plural";
import type { RuleKind } from "@/types/permissions";
import { useUsageLoadoutDelta, type UsageLoadoutDelta } from "@/store/usageLoadoutDelta";
import {
	useProjectAreaSummaries,
	type AreaSummaries,
} from "./projectAreaSummary";

/** What one area card says. `value: null` = still loading, or unreadable. */
export interface CardModel {
	value: number | null;
	unit: string;
	sub: ReactNode;
	/** Plain-text twin of `sub` for tests and the accessible description. */
	subText: string;
	foot?: ReactNode;
	/** The foot holds its own controls (buttons). It then renders as a
	 *  sibling of the card's button, never inside it — a button cannot be a
	 *  descendant of a button. */
	footInteractive?: boolean;
	attention?: "warn" | null;
}

const LOADING = "…";
const PERM_KINDS: RuleKind[] = ["allow", "deny", "ask"];

function loadoutCard(
	sk: AreaSummaries["skills"],
	harnessLine: ReactNode,
): CardModel {
	if (!sk) return { value: null, unit: "skills", sub: LOADING, subText: LOADING };
	const sub =
		`${sk.direct} direct · ${sk.via} via bundles` +
		(sk.mcp > 0 ? ` · ${sk.mcp} MCP` : "") +
		(sk.wontSync > 0 ? ` · ${sk.wontSync} won't sync` : "");
	return {
		value: sk.equipped,
		unit: plural(sk.equipped, "skill"),
		sub,
		subText: sub,
		foot: harnessLine,
		footInteractive: true,
		attention: sk.wontSync > 0 ? "warn" : null,
	};
}

function agentDocsCard(docs: AreaSummaries["docs"]): CardModel {
	if (docs === "error") {
		const t = "could not read the project";
		return { value: null, unit: "agent docs", sub: t, subText: t, attention: "warn" };
	}
	if (!docs) return { value: null, unit: "agent docs", sub: LOADING, subText: LOADING };
	const n = docs.deviations;
	const sub =
		docs.files === 0
			? "no agent docs yet"
			: `~${docs.upfrontTokens} tokens upfront · ~${docs.discoverableTokens} discoverable`;
	return {
		value: docs.files,
		unit: plural(docs.files, "agent doc"),
		sub,
		subText: sub,
		// Quiet when the layout is fine — the Agent Docs screen is too.
		foot:
			n > 0 ? (
				<StatusBadge channel="warn" icon="warning">
					{n} {plural(n, "dir")} {n === 1 ? "needs" : "need"} a fix
				</StatusBadge>
			) : null,
		attention: n > 0 ? "warn" : null,
	};
}

function permissionsCard(perm: AreaSummaries["permissions"]): CardModel {
	if (!perm) return { value: null, unit: "rules", sub: LOADING, subText: LOADING };
	const subText = PERM_KINDS.map((k) => `${perm[k]} ${k}`).join(" · ");
	return {
		value: perm.total,
		unit: plural(perm.total, "rule"),
		// The kinds as the Permissions screen draws them: its icon in its hue.
		sub: (
			<span className="perm-kinds">
				{PERM_KINDS.map((k) => (
					<span
						key={k}
						className="perm-kind"
						data-kind={k}
						style={{ color: KIND_META[k].accent }}
						aria-label={`${perm[k]} ${k}`}
						title={KIND_META[k].help}
					>
						<Icon name={KIND_META[k].icon} size={11} />
						{perm[k]}
					</span>
				))}
			</span>
		),
		subText,
		foot:
			perm.total === 0
				? "no rules in effect"
				: perm.own === 0
					? "all inherited from global"
					: `${perm.own} own · ${perm.inherited} inherited`,
	};
}

function subagentsCard(ag: AreaSummaries["subagents"]): CardModel {
	if (ag === "error") {
		const t = "could not list agents";
		return { value: null, unit: "sub-agents", sub: t, subText: t, attention: "warn" };
	}
	if (!ag) return { value: null, unit: "sub-agents", sub: LOADING, subText: LOADING };
	const sub =
		ag.agents === 0
			? "none in .claude/agents"
			: ag.disabled > 0
				? `${ag.agents - ag.disabled} enabled · ${ag.disabled} off`
				: "all enabled";
	return {
		value: ag.agents,
		unit: plural(ag.agents, "sub-agent"),
		sub,
		subText: sub,
		foot:
			ag.builtins > 0
				? `${ag.builtins - ag.builtinsOff}/${ag.builtins} built-ins on`
				: null,
	};
}

function usageCard(usage: AreaSummaries["usage"], delta?: UsageLoadoutDelta | null): CardModel {
	if (usage === "error") {
		const sub = "could not read usage";
		return { value: null, unit: "sessions", sub, subText: sub, attention: "warn" };
	}
	if (!usage) return { value: null, unit: "sessions", sub: LOADING, subText: LOADING };
	const tokens = usage.observedTokens ?? usage.loadoutTokens;
	const tokenText = tokens == null ? "token count unavailable" : `~${tokens.toLocaleString()} tokens ${usage.observedTokens != null ? "observed" : "of loadout"}`;
	if (!usage.scanned) {
		const sub = usage.loadoutTokens == null ? "no scan yet" : `no scan yet · ${tokenText}`;
		return { value: null, unit: "sessions", sub, subText: sub };
	}
	// The value line already carries the session count, so the sub never repeats it.
	const sessionText = usage.analysedHarness == null ? " · not analysed yet" : "";
	const cacheText = usage.analysedHarness == null || usage.cacheHitRatio == null ? "" : ` · ${Math.round(usage.cacheHitRatio * 100)}% cached`;
	const ageText = usage.scanAgeDays != null && usage.scanAgeDays > 7 ? ` · as of ${usage.scanAgeDays}d ago` : "";
	const deltaText = delta && delta.delta !== 0
		? ` · ${delta.delta > 0 ? "+" : "−"}${Math.abs(delta.delta).toLocaleString()} loadout tokens`
		: "";
	const sub = `${tokenText}${sessionText}${cacheText}${ageText}${deltaText}`;
	return {
		value: usage.analysedHarness == null ? null : usage.sessions,
		unit: "sessions",
		sub,
		subText: sub,
		foot: usage.idle > 0 ? `${usage.idle} ${plural(usage.idle, "skill")} idle` : null,
	};
}

export function cardModels(
	s: AreaSummaries,
	harnessLine: ReactNode,
	delta?: UsageLoadoutDelta | null,
): Record<ProjectArea, CardModel> {
	return {
		loadout: loadoutCard(s.skills, harnessLine),
		"agent-docs": agentDocsCard(s.docs),
		permissions: permissionsCard(s.permissions),
		subagents: subagentsCard(s.subagents),
		usage: usageCard(s.usage, delta),
	};
}

export interface ProjectAreaStripProps {
	projectName: string;
	value: ProjectArea;
	onChange: (area: ProjectArea) => void;
	/** Expanded = the dashboard's overview cards. Collapsed = the same cards
	 *  folded to their label and count, one row: the area screens' navigator. */
	expanded: boolean;
}

// Which state the strip was last drawn in, across mounts. An area switch
// unmounts one screen's strip and mounts the next screen's in the same place
// under the header; the incoming strip animates from the state the outgoing
// one had, so the two read as one element folding or unfolding.
let lastExpanded: boolean | null = null;

/** Test hook: forget the previous state so a mount does not animate. */
export function resetAreaStripMemory(): void {
	lastExpanded = null;
}

/**
 * The project navigator. One set of area cards in two densities, fed by one
 * hook, so the dashboard's cards and an area screen's compact row never
 * disagree about what a project holds — and a user learns one order of
 * areas, not two.
 *
 * The cards are navigation, not a tab widget: choosing one swaps the whole
 * screen, header included, and nothing on the dashboard is a tab panel. So
 * they are plain buttons in a `nav`, the lit one marked `aria-current`.
 */
export function ProjectAreaStrip({
	projectName,
	value,
	onChange,
	expanded,
}: ProjectAreaStripProps) {
	const { data: registry } = useRegistry();
	const summaries = useProjectAreaSummaries(projectName);
	const delta = useUsageLoadoutDelta(projectName);
	const uid = useId();
	const proj = registry?.projects?.[projectName];
	const animate = useRef<"expand" | "collapse" | null>(
		lastExpanded === null || lastExpanded === expanded
			? null
			: expanded
				? "expand"
				: "collapse",
	);
	useEffect(() => {
		lastExpanded = expanded;
	}, [expanded]);

	const harnessLine = proj ? (
		<HarnessTargetsLine
			projectName={projectName}
			globalHarnesses={registry?.harnesses_global ?? []}
			projectHarnesses={proj.harnesses ?? []}
		/>
	) : null;
	const models = cardModels(summaries, harnessLine, delta);
	if (proj?.path_unresolved) {
		for (const area of ["agent-docs", "subagents"] as const) {
			models[area] = {
				value: null, unit: models[area].unit,
				sub: "No local directory attached", subText: "No local directory attached",
			};
		}
	}

	return (
		<nav
			className="area-strip"
			aria-label="Project areas"
			data-expanded={expanded}
			data-animate={animate.current ?? undefined}
		>
			{PROJECT_AREAS.map((a) => {
				const m = models[a.id];
				const selected = value === a.id;
				const id = (part: string) => `${uid}-${a.id}-${part}`;
				const attention = m.attention ? (
					<span
						className="attention-dot"
						role="img"
						aria-label="needs attention"
					/>
				) : null;
				const foot = m.foot ? (
					<span className="foot" id={id("foot")}>
						{m.foot}
					</span>
				) : null;
				// Name = area + number; description = the breakdown and, when it
				// is text, the foot. An interactive foot is its own thing and is
				// not read as part of the button.
				const describedBy = [
					id("sub"),
					m.foot && !m.footInteractive ? id("foot") : null,
				]
					.filter(Boolean)
					.join(" ");
				return (
					<div
						key={a.id}
						className={`stat-card area-card${selected ? " accent" : ""}`}
						data-area={a.id}
						data-attention={m.attention ?? undefined}
					>
						<button
							type="button"
							aria-current={selected ? "page" : undefined}
							aria-labelledby={`${id("label")} ${id("value")}`}
							aria-describedby={describedBy}
							className="area-card-hit"
							onClick={() => onChange(a.id)}
						>
							<span className="label" id={id("label")}>
								{a.icon && <Icon name={a.icon} size={12} />}
								{a.label}
								{attention}
								{/* The count in the folded row; the value carries it
								    when expanded, so this one is not read twice. */}
								<span className="count" aria-hidden="true">
									{m.value ?? "–"}
								</span>
							</span>
							<span className="area-card-body">
								<span className="area-card-body-in">
									<span className="value" id={id("value")}>
										{m.value ?? "–"}
										<span className="unit">{m.unit}</span>
									</span>
									<span className="sub" id={id("sub")}>
										{m.sub}
									</span>
									{!m.footInteractive && foot}
								</span>
							</span>
						</button>
						{m.footInteractive && foot && (
							<div className="area-card-body">
								<div className="area-card-body-in">{foot}</div>
							</div>
						)}
					</div>
				);
			})}
		</nav>
	);
}
