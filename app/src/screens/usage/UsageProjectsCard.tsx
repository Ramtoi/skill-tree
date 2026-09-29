import { formatCapturedCount } from "./usageFormat";
import { HorizontalBarList, type BarRow } from "@/components/charts/HorizontalBarList";
import { Icon } from "@/components/Icon";
import { plural } from "@/lib/plural";
import type { ProjectTotal } from "./usageAggregate";
import { formatCount, formatMoney, type UsageCurrency } from "./usageFormat";

const PROJECTS_LIMIT = 8;

/** The aggregate's own placeholder label for sessions with no attributed
 *  project (`usageAggregate.ts`'s `"No project"` fallback) — relabeled to
 *  "Unregistered" for display only, per design D14.8/G4: renaming it in the
 *  aggregation itself would also rename it on the spend chart and the
 *  harness breakdown, which read the same label. */
const UNREGISTERED_LABEL = "No project";

export interface UsageProjectsCardProps {
  projects: ProjectTotal[];
  currency: UsageCurrency;
  eurRate: number;
  /** Registered hub project names — a row links only when its `hubProject`
   *  is set AND present here, so `/usage/project/<name>` can never name a
   *  project hub does not have (design D14.8, G3). */
  projectKeys: ReadonlySet<string>;
  onOpenProject?: (hubProject: string) => void;
}

/**
 * "Projects" — top 8 by estimated cost, plus a hoisted `Unregistered`
 * bucket. Renders whenever there is at least one project total, INCLUDING
 * the all-unregistered case (design D14.8, G4) — the card used to hide
 * itself entirely there; that was exactly story 53's own case and had to go.
 */
export function UsageProjectsCard({
  projects,
  currency,
  eurRate,
  projectKeys,
  onOpenProject,
}: UsageProjectsCardProps) {
  if (projects.length === 0) return null;

  const unregistered = projects.find((p) => p.label === UNREGISTERED_LABEL);
  const registered = projects.filter((p) => p.label !== UNREGISTERED_LABEL);

  // Hoisted OUT of the top-8 slice: a ninth registered label must not push
  // the one row story 53 asks for off the list.
  const rows: BarRow[] = registered.slice(0, PROJECTS_LIMIT).map((project) => {
    const linkable = Boolean(project.hubProject && projectKeys.has(project.hubProject));
    return {
      key: project.key,
      // The row's LABEL is the interactive element — never the whole row —
      // so the shared `HorizontalBarList` primitive stays untouched and the
      // affordance is keyboard-reachable by construction (design D14.8).
      label:
        linkable && onOpenProject ? (
          <button
            type="button"
            className="usage-project-link"
            title={project.label}
            onClick={() => onOpenProject(project.hubProject!)}
          >
            <span>{project.label}</span>
            <Icon name="chevronRight" size={12} />
          </button>
        ) : (
          <span title={project.label}>{project.label}</span>
        ),
      sub: `${formatCount(project.sessions)} ${plural(project.sessions, "session")} · ${`${formatCapturedCount(project.toolCalls, project.toolCallsKnown !== false)} ${plural(project.toolCalls, "tool call")}`}`,
      color: "color-mix(in oklab, var(--ctx) 85%, var(--bg-3))",
      value: project.costUsd,
      display: formatMoney(project.costUsd, currency, eurRate),
    };
  });

  if (unregistered) {
    rows.push({
      key: unregistered.key,
      // Never a link — no path is shown anywhere, per story 53 and the
      // ledger privacy rules.
      label: "Unregistered",
      sub: `${formatCount(unregistered.sessions)} ${plural(unregistered.sessions, "session")} in directories no project covers`,
      color: "var(--fg-dim)",
      value: unregistered.costUsd,
      display: formatMoney(unregistered.costUsd, currency, eurRate),
    });
  }

  return (
    <section className="usage-card usage-projects-card" aria-label="Projects">
      <div className="usage-section-head">
        <div>
          <span className="usage-kicker">Projects</span>
          <h3>By estimated cost</h3>
        </div>
      </div>
      <HorizontalBarList rows={rows} ariaLabel="Projects by estimated cost" />
      {unregistered && (
        <p className="usage-note usage-unregistered-hint">
          Register a project to attribute these.
        </p>
      )}
    </section>
  );
}
