// Pure selectors behind the navigator's per-group glance layer (the attention
// plaque + the two steady tiles) and the per-row marks that decorate the rows
// below it. No hooks, no IPC: every input is a plain value the caller already
// holds — the registry, the sync-report envelope, the harness store, and the
// ONE screen-hook query a group is allowed to mount (spec §1/R6). Both halves
// of a group's body (`<XGlance/>` and `<XRows/>`) call the SAME function here
// with the SAME data, so they can never disagree about what is true.
//
// Every string a reader sees in the panel is produced here, so a vitest can
// pin the exact copy without rendering anything (spec §8.1).

import { attentionLine, reportErrorDetails, type AttentionLine, type ActionableAttentionItem, type AttentionKind as QueueKind } from "./navAttention";
export type { AttentionLine } from "./navAttention";
import type { Bundle, Project, Registry, Skill } from "@/types";
import type { SnippetInfo } from "@/types/snippets";
import type { HarnessStatus } from "@/store";
import type { SubagentListItem } from "@/lib/subagents";
import type { LocalAgentUsageSnapshot } from "@/features/usage/usageTypes";
import type { HookRow } from "@/hooks/useHooks";
import type { BackupStatus } from "./backupContract";
import { backupHealth } from "./backupContract";
import {
	groupedSyncErrors,
	projectFreshness,
	relTime,
	type SyncReportEnvelope,
} from "./syncFreshness";
import { effectiveHarnesses } from "./affinity";
import {
	directOnly,
	getBundleScope,
	resolveActiveSkills,
	resolveTargetSkills,
} from "./resolveActiveSkills";
import { descriptionLengthState } from "./descriptionLimits";
import { deriveSources, inferSkillSourceId } from "./skillSource";
import { isUnsafeCodexCombo, SUDO_RE } from "./permissionsRisks";
import { activationWords, type CompanionActivation } from "./companions";
import { isFreshUsage } from "./usageGuidance";

type NavigatorFinding = {
	id: string;
	project: string;
	review: { project: string; area: string };
	observation?: string;
	moves?: Array<{ label: string }>;
};

// ─── Shared shapes ──────────────────────────────────────────────────────────
// Owned here (not in a `components/nav/*` file — those land in W2) so this
// pure lib has no dependency on the render layer. W2's `SideStat`/
// `SideAttention` components take these shapes directly.

export interface SideStatProps {
	/** Uppercase mono legend, carved into the top edge. */
	label: string;
	/** Plain text value, ≤ 12 chars in the default fixtures (§6.1). Kept as a
	 *  bare string (not `ReactNode`) so this lib never needs React: a tile that
	 *  also wants a `FreshnessDot` (BACKUP) carries the state separately in
	 *  `valueState`, and the W2 body component prefixes the dot. */
	value: string;
	/** Freshness state for a `FreshnessDot` the body renders before `value`.
	 *  Absent = no dot (every tile except Elsewhere's BACKUP tile today). */
	valueState?: "fresh" | "stale" | "unknown" | "error";
	/** ONE fact, ≤ 15 chars in the default fixtures. The full breakdown lives
	 *  in `title`. */
	sub: string;
	/** Colors `sub` only — a tile never changes the `value` hue (R3). */
	subTone?: "warn" | "error";
	/** The full breakdown, always present (hover). */
	title: string;
}

export interface NavGroupInsights {
	tiles: [SideStatProps, SideStatProps];
	lines: AttentionLine[];
}

/** Per-row decoration a group's `*RowMark` helper hands back to `SideRow`. */
export interface RowMark {
	hint?: string;
	hintTone?: "warn" | "error" | "severity";
	dot?: "ok" | "warn" | "error" | "never";
	dim?: boolean;
	/** Right-aligned row count (spec §2.3's per-project permissions row). */
	count?: number;
	countTitle?: string;
	/** Always present — the row's hover `title`. */
	title: string;
}

// ─── firstOffender / attentionText ──────────────────────────────────────────

/** The alphabetically-first name in a list (R2/m6: every group's "first
 *  offender" link uses this ordering, never discovery order). */
export function firstOffender(names: string[]): string {
	return [...names].sort((a, b) => a.localeCompare(b))[0];
}

type AttentionKind =
	| "projects.failed"
	| "projects.affinitySkip"
	| "projects.noAgent"
	| "projects.missingRefs"
	| "projects.stale"
	| "projects.unattached"
	| "context.descriptionOver200"
	| "context.conflicted"
	| "context.sourceMissing"
	| "context.bundleMissing"
	| "context.snippetOutdated"
	| "guardrails.hookNowhere"
	| "guardrails.hookSudo"
	| "guardrails.unmanaged"
	| "agents.onNotInstalled"
	| "agents.invalidSubagent"
	| "elsewhere.sourceUpdate"
	| "elsewhere.sourceFailing"
	| "elsewhere.cloudUnexportable";

const ATTENTION_TEMPLATES: Record<
	AttentionKind,
	{ one: (name: string) => string; many: (n: number) => string }
> = {
	"projects.failed": {
		one: (n) => `${n} sync failed`,
		many: (c) => `${c} project syncs failed`,
	},
	"projects.affinitySkip": {
		one: (n) => `${n} cannot reach an agent`,
		many: (c) => `${c} skills cannot reach an agent`,
	},
	"projects.noAgent": {
		one: (n) => `${n} has no active agent`,
		many: (c) => `${c} projects have no active agent`,
	},
	"projects.missingRefs": {
		one: (n) => `${n} lacks referenced skills`,
		many: (c) => `${c} projects lack referenced skills`,
	},
	"projects.stale": {
		one: (n) => `${n} needs a re-sync`,
		many: (c) => `${c} need a re-sync`,
	},
	"projects.unattached": {
		one: (n) => `${n} has no local directory attached`,
		many: (c) => `${c} projects have no local directory attached`,
	},
	"context.descriptionOver200": {
		// "description over 200 chars" tips real skill names past 34 chars
		// (m-5: caught by the guard once it ran on real fixture data —
		// `ds-tokens`, the spec's own §7.3 fixture, is 36 with the old
		// wording). The precise count still lives in the tile `title`.
		one: (n) => `${n} description too long`,
		many: (c) => `${c} descriptions too long`,
	},
	"context.conflicted": {
		// "has"/"have" dropped (m-5): the real mock's own `code-review` skill
		// (11 chars) already tips "has conflicted invocation" past the budget.
		one: (n) => `${n} invocation conflicts`,
		many: (c) => `${c} skill invocation conflicts`,
	},
	"context.sourceMissing": {
		one: (n) => `${n} removed upstream`,
		many: (c) => `${c} skills removed upstream`,
	},
	"context.bundleMissing": {
		one: (n) => `${n} lists missing skills`,
		many: (c) => `${c} bundles list missing skills`,
	},
	"context.snippetOutdated": {
		one: (n) => `${n} has older applied copies`,
		many: (c) => `${c} snippets have older copies`,
	},
	"guardrails.hookNowhere": {
		one: (n) => `${n} attached nowhere`,
		many: (c) => `${c} hooks attached nowhere`,
	},
	"guardrails.hookSudo": {
		one: (n) => `${n} runs sudo`,
		many: (c) => `${c} hooks run sudo`,
	},
	"guardrails.unmanaged": {
		one: (n) => `${n} rules not managed here`,
		// The full joined id list was the pre-fix copy (m-5) — over budget past
		// two ids; the N > 1 case now follows every other group's convention.
		many: (c) => `${c} agents have unmanaged rules`,
	},
	"agents.onNotInstalled": {
		one: (n) => `${n} enabled but not installed`,
		many: (c) => `${c} harnesses on but not installed`,
	},
	"agents.invalidSubagent": {
		one: (n) => `${n} definition needs review`,
		many: (c) => `${c} sub-agent definitions to review`,
	},
	"elsewhere.sourceUpdate": {
		one: (n) => `${n} has updates`,
		many: (c) => `${c} sources have updates`,
	},
	"elsewhere.sourceFailing": {
		one: (n) => `${n} update failed`,
		many: (c) => `${c} source updates failed`,
	},
	"elsewhere.cloudUnexportable": {
		one: (n) => `${n} excluded from export`,
		many: (c) => `${c} cloud selections excluded`,
	},
};

/** The N = 1 / N > 1 templates (M9). `names` is the FULL offender list; the
 *  N = 1 branch names the sole item, the N > 1 branch carries only the count
 *  (the offender is a separate trailing token, added by the caller). */
export function attentionText(kind: AttentionKind, names: string[]): string {
	const t = ATTENTION_TEMPLATES[kind];
	if (names.length === 1) return t.one(names[0]);
	return t.many(names.length);
}

function pushLine(
  lines: AttentionLine[], kind: QueueKind & AttentionKind, tone: "warn" | "error",
  names: string[], hrefFor: (name: string) => string,
  detailFor?: (name: string) => string | undefined, actionLabel = "Open item",
): void {
  if (!names.length) return;
  lines.push(attentionLine(kind, tone, attentionText(kind, names), [...names].sort((a, b) => a.localeCompare(b)).map((name) => ({
    id: name, label: name, detail: detailFor?.(name), action: { label: actionLabel, href: hrefFor(name) },
  }))));
}

// ─── Formatters ─────────────────────────────────────────────────────────────

/** Mirrors `screens/Harnesses.tsx`'s permissions-adapter labels — the short
 *  form for the CODEX tile's sub line. */
export function shortSandbox(mode: string | null | undefined): string {
	if (mode === "danger-full-access") return "full access";
	if (!mode) return "—";
	return mode;
}

/** Mirrors `screens/usage/usageFormat.ts`'s `formatMoney` — including its
 *  `currencyDisplay: "narrowSymbol"`, so the panel tile and the Usage screen
 *  cannot print the same figure two ways ("US$6,921.07" vs "$6,921.07" under
 *  a locale that disambiguates USD). This module is a `lib/` leaf and must
 *  not import a screen, so the rule is mirrored rather than shared. */
export function formatUsd(usd: number): string {
	return new Intl.NumberFormat(undefined, {
		style: "currency",
		currency: "USD",
		currencyDisplay: "narrowSymbol",
		maximumFractionDigits: 2,
	}).format(usd);
}

function formatCount(n: number): string {
	if (!Number.isFinite(n)) return "0";
	return new Intl.NumberFormat().format(n);
}

/** Descending, so the first unit a value clears is the largest one. */
const COMPACT_UNITS: ReadonlyArray<readonly [number, string]> = [
	[1e12, "T"],
	[1e9, "B"],
	[1e6, "M"],
	[1e3, "k"],
];

/** `29.7B`, `845k` — a 140px tile cannot hold a real corpus's token count
 *  in full; the exact figure rides the tile's `title` instead. Mirrors
 *  `usageFormat.ts`'s `formatCompact` (same `lib/`-may-not-import-a-screen
 *  rule as `formatUsd` above), roll-up included: 999,950 is "1M", never the
 *  four-digit "1000k" a per-unit round produces. */
function formatCompactCount(n: number): string {
	if (!Number.isFinite(n)) return "0";
	const sign = n < 0 ? "-" : "";
	const abs = Math.abs(n);
	for (let i = 0; i < COMPACT_UNITS.length; i++) {
		const [unit, suffix] = COMPACT_UNITS[i];
		if (abs < unit) continue;
		if (Math.round((abs / unit) * 10) / 10 >= 1e3 && i > 0) {
			const [bigger, biggerSuffix] = COMPACT_UNITS[i - 1];
			return `${sign}${trimTenth(abs / bigger)}${biggerSuffix}`;
		}
		return `${sign}${trimTenth(abs / unit)}${suffix}`;
	}
	return formatCount(n);
}

function trimTenth(n: number): string {
	const rounded = Math.round(n * 10) / 10;
	return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function plural(n: number, word: string): string {
	return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// ─── Projects ───────────────────────────────────────────────────────────────

export function projectsInsights(
	registry: Registry,
	env: SyncReportEnvelope | null | undefined,
	harnesses: HarnessStatus[],
	findings?: { findings: NavigatorFinding[]; last_scan_at: string | null } | null,
	now = Date.now(),
): NavGroupInsights {
	const projects = registry.projects ?? {};
	const names = Object.keys(projects);
	const total = names.length;
	const hasReport = !!env?.report;

	let freshCount = 0;
	let errorCount = 0;
	let quarantinedCount = 0;
	let staleCount = 0;
	let unknownCount = 0;
	for (const name of names) {
		const f = projectFreshness(name, env, projects[name]);
		if (f === "fresh") freshCount += 1;
		else if (f === "error") errorCount += 1;
		else if (f === "quarantined") quarantinedCount += 1;
		else if (f === "stale") staleCount += 1;
		else unknownCount += 1;
	}
	// F1: a quarantined project never counts toward IN SYNC, no matter how
	// many syncs run — it gets its own bucket ("unattached"), never folded
	// into "stale" (that reads as "needs a re-sync", which is not the fix).
	const breakdown: string[] = [];
	if (errorCount) breakdown.push(`${errorCount} failed`);
	if (quarantinedCount) breakdown.push(`${quarantinedCount} unattached`);
	if (staleCount) breakdown.push(`${staleCount} stale`);
	if (unknownCount) breakdown.push(`${unknownCount} unknown`);

	const inSyncTile: SideStatProps = {
		label: "IN SYNC",
		value: hasReport ? `${freshCount}/${total}` : "—",
		sub: hasReport ? (breakdown[0] ?? "nothing pending") : "run sync",
		title: hasReport
			? breakdown.length
				? breakdown.join(" · ")
				: "nothing pending"
			: "run sync",
	};

	const writes =
		(env?.report?.global.skills.writes ?? 0) + (env?.report?.global.mcp.writes ?? 0);
	const lastSyncTile: SideStatProps = {
		label: "LAST SYNC",
		value: hasReport ? relTime(env?.report?.generated_at) : "never",
		sub: hasReport ? `${writes} writes` : "run sync",
		title: hasReport
			? `Last synced ${relTime(env?.report?.generated_at)} · ${writes} writes`
			: "No sync report yet — run sync.",
	};

	const lines: AttentionLine[] = [];
  const projectHref = (name: string) => `/project/${encodeURIComponent(name)}?tab=loadout`;
  const freshFindings = findings && isFreshUsage(findings.last_scan_at, now) ? findings.findings : [];
  if (freshFindings.length) {
    lines.push(attentionLine("projects.freshFindings", "warn", `${plural(freshFindings.length, "usage suggestion")} to review`, freshFindings.map((finding) => ({
      id: `${finding.project}:${finding.id}`, label: finding.project,
      detail: [finding.observation ?? "Open the review to read the recorded observation.", ...(finding.moves ?? []).map((move) => `Suggested change: ${move.label}`)].join("\n"),
      action: { label: "Review suggestion", href: `/project/${encodeURIComponent(finding.review.project)}?tab=${encodeURIComponent(finding.review.area)}&review=${encodeURIComponent(finding.id)}` },
    }))));
  }
  pushLine(lines, "projects.failed", "error", names.filter((name) => projectFreshness(name, env, projects[name]) === "error"), projectHref,
    // F3: dedupe by root cause (a missing source's symlink + invocation
    // stages share one message) so ten raw errors read as five causes, with
    // each cause's contributing stages still named.
    (name) => {
      const errors = env?.report.projects[name]?.errors ?? [];
      if (!errors.length) return "The report does not include error details.";
      return groupedSyncErrors(errors)
        .map((group) => `${group.message} (${group.stages.map((stage) => stage.stage).join(" + ")})`)
        .join("\n");
    }, "Open project");
  // F1/A1/A6: quarantined projects (no local directory, `path_unresolved`)
  // are never "stale" or "failed" — their own line, with a bulk "Attach
  // directory" action alongside the usual per-project "Open project" links,
  // so 13 skipped projects never read as 13 healthy syncs.
  const unattached = [...names]
    .filter((name) => projectFreshness(name, env, projects[name]) === "quarantined")
    .sort((a, b) => a.localeCompare(b));
  if (unattached.length) {
    lines.push(attentionLine("projects.unattached", "warn", attentionText("projects.unattached", unattached),
      unattached.map((name) => ({
        id: name, label: name,
        detail: env?.report.projects[name]?.quarantined ?? env?.report.projects[name]?.skip_reason ?? "No local directory attached.",
        action: { label: "Open project", href: projectHref(name) },
      })),
      { label: "Attach directory", href: "/recovery" },
    ));
  }
  const skips: ActionableAttentionItem[] = [];
  for (const [project, record] of Object.entries(env?.report.projects ?? {})) {
    for (const skip of record.affinity_skips ?? []) {
      skips.push({ id: `${project}:${skip.skill}`, label: `${skip.skill} · ${project}`,
        detail: `Skill supports: ${skip.skill_harnesses.join(", ") || "none"}. Project harnesses: ${skip.project_harnesses.join(", ") || "none"}.`,
        action: { label: "Open project", href: projectHref(project) } });
    }
  }
  if (skips.length) lines.push(attentionLine("projects.affinitySkip", "warn", `${plural(skips.length, "skill")} cannot reach an agent`, skips));
  if (harnesses.length) {
    const installed = harnesses.filter((h) => h.installed).map((h) => h.id);
    pushLine(lines, "projects.noAgent", "warn", names.filter((name) => effectiveHarnesses(projects[name], registry, installed).length === 0), projectHref, undefined, "Open project");
  }
  const missingRefs: ActionableAttentionItem[] = [...names].sort().flatMap((project) =>
    (env?.report.projects[project]?.missing_refs ?? []).map((ref) => ({
      id: `${project}:${ref.skill}`, label: `${ref.skill} · ${project}`,
      detail: `${ref.skill} needs: ${ref.refs.join(", ")}`,
      action: { label: "Open Loadout", href: projectHref(project) },
    })),
  );
  if (missingRefs.length) lines.push(attentionLine("projects.missingRefs", "warn", `${plural(missingRefs.length, "equipped skill")} ${missingRefs.length === 1 ? "lacks" : "lack"} referenced skills`, missingRefs));
  pushLine(lines, "projects.stale", "warn", names.filter((name) => projectFreshness(name, env, projects[name]) === "stale"), projectHref, undefined, "Open project");

	return { tiles: [inSyncTile, lastSyncTile], lines };
}

export function projectRowMark(
	name: string,
	project: Project,
	registry: Registry,
	env: SyncReportEnvelope | null | undefined,
	harnesses: HarnessStatus[],
): RowMark {
	const freshness = projectFreshness(name, env, project);
	const record = env?.report?.projects?.[name];
	const skipped = record?.skipped_unowned ?? 0;
	const installedIds = harnesses.filter((h) => h.installed).map((h) => h.id);
	const eff = effectiveHarnesses(project, registry, installedIds);
	const noAgent = harnesses.length > 0 && eff.length === 0;

	let hint: string | undefined;
	let hintTone: RowMark["hintTone"];
	if (freshness === "error") {
		hint = "failed";
		hintTone = "error";
	} else if (freshness === "quarantined") {
		hint = "no directory";
		hintTone = "warn";
	} else if (noAgent) {
		hint = "no agent";
		hintTone = "warn";
	} else if (skipped > 0) {
		hint = `${skipped} skipped`;
		hintTone = "warn";
	} else if (freshness === "stale") {
		hint = "re-sync";
		hintTone = "warn";
	}

	const active = resolveActiveSkills(project, registry);
	const direct = directOnly(project, registry).length;
	const via = active.length - direct;
	const agentsText = eff.length ? eff.join(", ") : "none";
	const title = `${name}\n${project.path}\n${direct} direct · ${via} via bundles\nagents: ${agentsText}`;

	return { hint, hintTone, title };
}

// ─── Context ────────────────────────────────────────────────────────────────

export function contextInsights(
	registry: Registry,
	snippets: SnippetInfo[] | undefined,
): NavGroupInsights {
	const skills = registry.skills ?? {};
	const skillNames = Object.keys(skills);
	const mcpCount = skillNames.filter((n) => skills[n].type === "mcp-server").length;
	const bundleCount = Object.keys(registry.bundles ?? {}).length;

	const skillsTile: SideStatProps = {
		label: "SKILLS",
		value: String(skillNames.length),
		sub: skillNames.length === 0 ? "none yet" : `${mcpCount} mcp`,
		title: `${skillNames.length} skills · ${plural(mcpCount, "mcp server")} · ${plural(bundleCount, "bundle")}`,
	};

	// In use = ∪ project-active skills ∪ every `scope: global` skill (B3: a
	// global skill is linked by the global pass regardless of equip).
	const inUse = new Set<string>();
	for (const project of Object.values(registry.projects ?? {})) {
		for (const activeName of resolveActiveSkills(project, registry)) {
			if (skills[activeName]) inUse.add(activeName);
		}
	}
	for (const [name, skill] of Object.entries(skills)) {
		if (skill.scope === "global") inUse.add(name);
	}
	const idle = skillNames.length - inUse.size;

	const inUseTile: SideStatProps = {
		label: "IN USE",
		value: String(inUse.size),
		sub: `${idle} idle`,
		title: `${inUse.size} in use (on a project or scope: global) · ${idle} idle`,
	};

	const lines: AttentionLine[] = [];
  const skillHref = (name: string) => `/skill/${encodeURIComponent(name)}`;
  pushLine(lines, "context.descriptionOver200", "warn", skillNames.filter((name) => descriptionLengthState(skills[name].description?.length ?? 0).tier !== "ok"), skillHref,
    (name) => `${skills[name].description?.length ?? 0} characters`, "Inspect skill");
  pushLine(lines, "context.conflicted", "error", skillNames.filter((name) => skills[name].invocation === "conflicted"), skillHref, undefined, "Inspect invocation");
  const dropped = skillNames.filter((name) => skills[name].source_missing);
  if (dropped.length) {
    const sourceIds = new Set(dropped.map((name) => inferSkillSourceId(skills[name])));
    lines.push(attentionLine("context.sourceMissing", "error", attentionText("context.sourceMissing", dropped), dropped.sort().map((name) => ({
      id: name, label: name, detail: `Source: ${inferSkillSourceId(skills[name])}`, action: { label: "Inspect skill", href: skillHref(name) },
    })), { label: "Review sources", href: sourceIds.size === 1 ? `/sources?focus=${encodeURIComponent([...sourceIds][0])}` : "/sources" }));
  }
  const bundles = registry.bundles ?? {};
  pushLine(lines, "context.bundleMissing", "error", Object.keys(bundles).filter((name) => bundles[name].skills?.some((skill) => !skills[skill])),
    (name) => `/bundle/${encodeURIComponent(name)}`, (name) => `Missing: ${(bundles[name].skills ?? []).filter((skill) => !skills[skill]).join(", ")}`, "Open bundle");
  pushLine(lines, "context.snippetOutdated", "warn", (snippets ?? []).filter((snippet) => (snippet.usage?.outdated_count ?? 0) > 0).map((snippet) => snippet.name),
    (name) => `/snippet/${encodeURIComponent(name)}`, (name) => `${snippets?.find((snippet) => snippet.name === name)?.usage?.outdated_count} outdated applied copies`, "Review applied copies");

	return { tiles: [skillsTile, inUseTile], lines };
}

export function bundleRowMark(name: string, bundle: Bundle, registry: Registry): RowMark {
	const missing = (bundle.skills ?? []).filter((s) => !registry.skills?.[s]);
	let hint: string | undefined;
	let hintTone: RowMark["hintTone"];
	if (missing.length > 0) {
		hint = `${missing.length} missing`;
		hintTone = "error";
	} else if (bundle.source) {
		hint = "linked";
	} else if (getBundleScope(bundle) === "global") {
		hint = "global";
	}
	const appliedCount = Object.values(registry.projects ?? {}).filter((p) =>
		(p.bundles ?? []).includes(name),
	).length;
	const lines = [name, bundle.description, `applied to ${plural(appliedCount, "project")}`];
	if (bundle.source) lines.push(`follows ${bundle.source}`);
	return { hint, hintTone, title: lines.join("\n") };
}

export function snippetRowMark(snippet: SnippetInfo): RowMark {
	const count = snippet.usage?.count ?? 0;
	const outdated = snippet.usage?.outdated_count ?? 0;
	const title = `${snippet.name}\n${snippet.description}`;
	if (count === 0) return { hint: "unused", dim: true, title };
	if (outdated > 0) return { hint: `${outdated} outdated`, hintTone: "warn", title };
	return { hint: `${count} applied`, title };
}

export function skillRowMark(name: string, skill: Skill): RowMark {
	let hint: string | undefined;
	let hintTone: RowMark["hintTone"];
	if (skill.source_missing) {
		hint = "dropped";
		hintTone = "error";
	} else if (skill.invocation === "conflicted") {
		hint = "conflicted";
		hintTone = "error";
	} else if (descriptionLengthState(skill.description?.length ?? 0).tier !== "ok") {
		hint = ">200";
		hintTone = "warn";
	}
	const lines = [name, inferSkillSourceId(skill), `scope ${skill.scope}`];
	if (skill.harnesses?.length) lines.push(`agents: ${skill.harnesses.join(", ")}`);
	return { hint, hintTone, title: lines.join("\n") };
}

// ─── Guardrails ─────────────────────────────────────────────────────────────

export function guardrailsInsights(
	registry: Registry,
	env: SyncReportEnvelope | null | undefined,
	hooks: HookRow[] | undefined,
): NavGroupInsights {
	const pg = registry.permissions_global;
	const allow = pg?.allow?.length ?? 0;
	const deny = pg?.deny?.length ?? 0;
	const ask = pg?.ask?.length ?? 0;
	const total = allow + deny + ask;

	const globalRulesTile: SideStatProps = {
		label: "GLOBAL RULES",
		value: String(total),
		sub: total > 0 ? `${deny} deny` : "none yet",
		title: `${allow} allow · ${deny} deny · ${ask} ask — global`,
	};

	const approval = pg?.approval_policy;
	const sandbox = pg?.sandbox_mode;
	const codexTile: SideStatProps = {
		label: "CODEX",
		value: approval ?? "—",
		sub: approval ? shortSandbox(sandbox) : "codex defaults",
		title: `approval_policy: ${approval ?? "—"}\nsandbox_mode: ${sandbox ?? "—"}`,
	};

	const lines: AttentionLine[] = [];
  const global = env?.report.global;
  const reportLine = (kind: QueueKind, text: string, errors: unknown[] | undefined, label: string, href: string) => {
    lines.push(attentionLine(kind, "error", text, [{ id: "global", label: "Global sync report", detail: reportErrorDetails(errors) ?? "This report does not include readable error details or affected-item names." }], { label, href }));
  };
  if (global?.doctor?.ok === false && global.doctor.errors.length) reportLine("guardrails.doctor", `${global.doctor.errors.length} permission risks reported`, global.doctor.errors, "Open Permissions", "/permissions");
  if (global?.permissions.ok === false) reportLine("guardrails.permissionsStreamFailed", "Permission sync failed", global.permissions.errors, "Open Permissions", "/permissions");
  if (global?.hooks?.ok === false) reportLine("guardrails.hooksStreamFailed", "Hook sync failed", global.hooks.errors, "Open Hooks", "/hooks");
  if (isUnsafeCodexCombo(approval, sandbox)) lines.push(attentionLine("guardrails.unsafeCombo", "error", "Codex runs without restrictions", [{ id: "codex", label: "Codex global permissions", detail: `Approval: ${approval}. Sandbox: ${sandbox}.` }], { label: "Review Codex permissions", href: "/permissions" }));
  pushLine(lines, "guardrails.unmanaged", "warn", pg?._unmanaged ?? [], () => "/permissions", undefined, "Review permissions");
  pushLine(lines, "guardrails.hookSudo", "error", (hooks ?? []).filter((hook) => SUDO_RE.test(hook.command ?? "")).map((hook) => hook.name),
    (name) => `/hook/${encodeURIComponent(name)}`, (name) => hooks?.find((hook) => hook.name === name)?.command, "Inspect hook");

	return { tiles: [globalRulesTile, codexTile], lines };
}

/** A11: the declaring skill for a hook `shipped by`, from the
 *  project-independent MIRROR (`companionsIndex.shippedBy`) — never the
 *  per-project ledger, which the NavPanel's Guardrails group has no project
 *  to key off of. `activation` is the skill's own declared word for this
 *  hook (D1/A1); omitted when the caller couldn't resolve one. */
export interface HookShippedBy {
	skill: string;
	activation?: CompanionActivation;
}

export function hookRowMark(hook: HookRow, shippedBy?: HookShippedBy | null): RowMark {
	const nowhere = !hook.attached_global && hook.attached_projects.length === 0;
	let dot: RowMark["dot"] = "ok";
	let dim = false;
	if (SUDO_RE.test(hook.command ?? "")) {
		dot = "error";
	} else if (nowhere) {
		dot = "never";
		dim = true;
	}
	const attached = hook.attached_global
		? "global"
		: hook.attached_projects.length > 0
			? `${hook.attached_projects.length} projects`
			: "nowhere";
	// A11: the row's `hint` reads `shipped by <skill>` when a registered
	// skill's `ships_with` declares this hook, falling back to the plain
	// event name (today's behavior) otherwise. The title gains an activation
	// line only in the shipped case — a hook nobody ships with has no
	// activation word to show.
	const hint = shippedBy ? `shipped by ${shippedBy.skill}` : hook.event;
	const activationLine = shippedBy
		? `\n${activationWords(shippedBy.activation, shippedBy.skill)}`
		: "";
	return {
		dot,
		dim,
		hint,
		title: `${hook.name}\n${hook.event}\nattached: ${attached}${activationLine}`,
	};
}

/** The guardrails Permissions block's per-project row (project name + rule
 *  count + the amber `trust` severity mark, spec §2.3). */
export function projectPermissionsRowMark(project: Project): RowMark {
	const p = project.permissions;
	const count =
		(p?.allow?.length ?? 0) + (p?.deny?.length ?? 0) + (p?.ask?.length ?? 0) + (p?.hooks?.length ?? 0);
	const countTitle = "permission rules";
	if (p?.project_trust === true) {
		return {
			hint: "trust",
			hintTone: "severity",
			count,
			countTitle,
			title: `${plural(count, "rule")} — Codex trust auto-granted`,
		};
	}
	return { count, countTitle, title: plural(count, "rule") };
}

// ─── Agents ─────────────────────────────────────────────────────────────────

export function agentsInsights(
	harnesses: HarnessStatus[],
	usage: { snapshot: LocalAgentUsageSnapshot | null; isError: boolean },
	subagentsByHarness: Partial<Record<string, SubagentListItem[] | undefined>>,
): NavGroupInsights {
	const total = harnesses.length;
	const installedCount = harnesses.filter((h) => h.installed).length;
	const onGloballyCount = harnesses.filter((h) => h.on_globally).length;

	const harnessesTile: SideStatProps = {
		label: "HARNESSES",
		value: total > 0 ? `${installedCount}/${total}` : "—",
		sub: total > 0 ? `${onGloballyCount} on globally` : "not scanned",
		title:
			total > 0
				? `${installedCount} of ${total} installed · ${onGloballyCount} on globally`
				: "not scanned",
	};

	let usageTile: SideStatProps;
	if (usage.isError) {
		usageTile = {
			label: "USAGE",
			value: "—",
			sub: "scan failed",
			subTone: "error",
			title: "The last usage scan failed.",
		};
	} else if (!usage.snapshot) {
		usageTile = { label: "USAGE", value: "—", sub: "no scan yet", title: "No usage scan yet." };
	} else {
		const tokens = usage.snapshot.overview.totalTokens;
		const costStr = formatUsd(usage.snapshot.overview.estimatedCost.usd);
		usageTile = {
			label: "USAGE",
			value: formatCompactCount(tokens),
			sub: costStr,
			title: `${formatCount(tokens)} tokens · ${costStr} · scanned ${relTime(usage.snapshot.scannedAt)}`,
		};
	}

	const lines: AttentionLine[] = [];
  const unavailable = harnesses.filter((h) => h.on_globally && !h.installed);
  if (unavailable.length) lines.push(attentionLine("agents.onNotInstalled", "warn", attentionText("agents.onNotInstalled", unavailable.map((h) => h.label)), unavailable.map((h) => ({
    id: h.id, label: h.label, action: { label: "Open Harnesses", href: "/harnesses" },
  }))));
  const invalid: ActionableAttentionItem[] = [];
  for (const harness of harnesses) {
    if (!(harness.installed && (harness.on_globally || harness.used_by_projects.length > 0) && harness.agents?.supported)) continue;
    if (harness.id !== "claude-code" && harness.id !== "codex") continue;
    for (const agent of subagentsByHarness[harness.id] ?? []) {
      if (agent.valid && !agent.link?.twin_lost) continue;
      invalid.push({ id: `${harness.id}:${agent.name}`, label: `${agent.name} · ${harness.label}`,
        detail: [!agent.valid ? "Invalid definition" : "", agent.link?.twin_lost ? "Linked copy is missing" : ""].filter(Boolean).join(". "),
        action: { label: "Inspect sub-agent", href: `/harness/${encodeURIComponent(harness.id)}?agent=${encodeURIComponent(agent.name)}` } });
    }
  }
  if (invalid.length) lines.push(attentionLine("agents.invalidSubagent", "error", `${plural(invalid.length, "sub-agent definition")} to review`, invalid));
  if (usage.isError) lines.push(attentionLine("agents.usageScanFailed", "error", "Saved usage could not be loaded", [{ id: "usage", label: "Saved usage totals" }], { label: "Open Usage", href: "/usage" }));

	return { tiles: [harnessesTile, usageTile], lines };
}

export function harnessRowMark(h: HarnessStatus, subagentCount?: number): RowMark {
	let hint: string | undefined;
	if (!h.installed) {
		hint = "not installed";
	} else if (!h.on_globally) {
		hint = "off";
	} else if (subagentCount !== undefined) {
		hint = `${subagentCount} agents`;
	}
	// No `dot` here (n-2): the trailing `.health` dot needs a 4-state read
	// (`error`/`never`/`ok`/`stale`) that this 2-state `RowMark["dot"]` union
	// can't carry — `AgentsBody.tsx` computes it inline and is the only
	// source of truth for it.
	const title = `${h.label}${h.version ? `\nv${h.version}` : ""}`;
	return { hint, title };
}

// ─── Elsewhere ──────────────────────────────────────────────────────────────

export function elsewhereInsights(
	registry: Registry,
	env: SyncReportEnvelope | null | undefined,
	backupStatus: BackupStatus | null | undefined,
): NavGroupInsights {
	const slot = env?.report?.global.backup;
	const health = backupHealth(backupStatus, slot);

	let backupTile: SideStatProps;
	if (backupStatus === undefined) {
		backupTile = {
			label: "BACKUP",
			value: "—",
			valueState: "unknown",
			sub: "checking",
			title: "Checking backup status…",
		};
	} else {
		const commitTs = backupStatus?.last_commit?.ts;
		backupTile = {
			label: "BACKUP",
			value: health.short,
			valueState: health.state,
			sub: commitTs ? relTime(commitTs) : "no snapshot",
			title: health.detail ? `${health.label}\n${health.detail}` : health.label,
		};
	}

	const globalRemotes = env?.report?.global.remotes;
	const skipped = env?.report?.global.skipped ?? [];
	let remoteSyncTile: SideStatProps;
	if (!env?.report) {
		remoteSyncTile = {
			label: "REMOTE SYNC",
			value: "—",
			sub: "run sync",
			title: "No sync report yet — run sync.",
		};
	} else if (skipped.includes("remotes")) {
		remoteSyncTile = {
			label: "REMOTE SYNC",
			value: "—",
			sub: "auto-sync",
			title:
				"Remotes are pushed only by an explicit Sync (hub sync / hub remote sync). The last run was an auto-sync after a registry change.",
		};
	} else {
		const attempted = globalRemotes?.attempted ?? 0;
		const alarmingCount = globalRemotes?.alarming ?? 0;
		remoteSyncTile = {
			label: "REMOTE SYNC",
			value: `${attempted} pushed`,
			sub: alarmingCount > 0 ? `${alarmingCount} alarming` : relTime(env.report.generated_at),
			subTone: alarmingCount > 0 ? "error" : undefined,
			title:
				alarmingCount > 0
					? `${attempted} pushed · ${alarmingCount} alarming`
					: `${attempted} pushed · ${relTime(env.report.generated_at)}`,
		};
	}

	const lines: AttentionLine[] = [];

  for (const [status, kind] of [["update-available", "elsewhere.sourceUpdate"], ["error", "elsewhere.sourceFailing"]] as const) {
    const sources = deriveSources(registry).filter((source) => source.enabled !== false && source.status === status);
    if (sources.length) lines.push(attentionLine(kind, status === "error" ? "error" : "warn", attentionText(kind, sources.map((source) => source.name)), sources.map((source) => ({
      id: source.id, label: source.name, detail: source.error ?? undefined, action: { label: "Open source", href: `/sources?focus=${encodeURIComponent(source.id)}` },
    }))));
  }
  const alarming = globalRemotes?.alarming ?? 0;
  if (alarming) lines.push(attentionLine("elsewhere.remotesAlarmed", "error", `${plural(alarming, "remote")} ${alarming === 1 ? "needs" : "need"} review`, [{ id: "remote-summary", label: `${alarming} affected remote targets`, detail: "This sync summary contains a count, not target names." }], { label: "Review remotes", href: "/remotes" }));
  if (backupStatus !== undefined && ["refused", "paused", "push-failures"].includes(health.cause)) {
    lines.push(attentionLine("elsewhere.backupHealth", health.cause === "paused" ? "warn" : "error", health.label, [{ id: "backup", label: "Registry backup", detail: health.detail ?? health.label }], { label: "Review backup", href: "/backup" }));
  }

	const cloudBlock = registry.cloud ?? {};
	const dropped: Array<{ name: string; targetId: string }> = [];
	for (const targetId of Object.keys(cloudBlock).sort()) {
		const equip = cloudBlock[targetId];
		const requested = new Set<string>();
		if (equip.apply_global_bundles) {
			for (const bundle of Object.values(registry.bundles ?? {})) {
				if (getBundleScope(bundle) === "global") {
					(bundle.skills ?? []).forEach((s) => requested.add(s));
				}
			}
		}
		for (const bName of equip.bundles ?? []) {
			(registry.bundles?.[bName]?.skills ?? []).forEach((s) => requested.add(s));
		}
		(equip.enabled ?? []).forEach((s) => requested.add(s));
		const allowed = new Set(resolveTargetSkills(equip, registry, { excludeMcp: true }));
		for (const name of requested) {
			if (!allowed.has(name)) dropped.push({ name, targetId });
		}
	}
  if (dropped.length) lines.push(attentionLine("elsewhere.cloudUnexportable", "error", `${plural(dropped.length, "cloud selection")} excluded`, dropped.map((item) => ({
    id: `${item.targetId}:${item.name}`, label: `${item.name} · ${item.targetId}`,
    detail: registry.skills?.[item.name]?.type === "mcp-server" ? "MCP servers cannot be exported to cloud apps." : "This skill is missing from the registry.",
    action: { label: "Open cloud target", href: `/cloud/${encodeURIComponent(item.targetId)}` },
  }))));

	return { tiles: [backupTile, remoteSyncTile], lines };
}

export function sourceRowMark(source: {
	name: string;
	status: string;
	enabled?: boolean;
	error?: string | null;
	last_synced_at?: string | null;
	include?: string[];
}): RowMark {
	let dot: RowMark["dot"] = "ok";
	let dim = false;
	if (source.status === "error") {
		dot = "error";
	} else if (source.enabled === false) {
		dot = "never";
		dim = true;
	} else if (source.status === "update-available") {
		dot = "warn";
	}
	let hint: string | undefined;
	let hintTone: RowMark["hintTone"];
	if (source.enabled === false) {
		hint = "off";
	} else if (source.status === "update-available") {
		hint = "update";
		hintTone = "warn";
	}
	const lines = [source.name, source.status];
	if (source.error) lines.push(source.error);
	lines.push(`last synced ${relTime(source.last_synced_at ?? undefined)}`);
	if (source.include) lines.push(`curated: ${source.include.length}`);
	return { dot, dim, hint, hintTone, title: lines.join("\n") };
}

export function remoteRowMark(id: string, connector: string, syncEnabled: boolean): RowMark {
	const title = `${id}\nconnector ${connector}`;
	if (!syncEnabled) return { hint: "sync off", dim: true, title };
	return { title };
}

export function cloudRowMark(targetId: string, unshippableCount: number): RowMark {
	if (unshippableCount > 0) {
		return { hint: `${unshippableCount} unshippable`, hintTone: "error", title: targetId };
	}
	return { title: targetId };
}
