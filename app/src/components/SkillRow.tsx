import type { SkillReferenceStats } from "@/lib/skillRowStats";
import type { MouseEvent, ReactNode } from "react";
import type { Registry, Skill } from "@/types";
import { resolveActiveSkills } from "@/lib/resolveActiveSkills";
import { Button } from "./Button";
import { Icon } from "./Icon";
import { ResourceRow } from "./ResourceRow";
import { InvocationBadge } from "./InvocationBadge";
import { KindMark, ScopeBadge } from "./Tag";
import { SkillRowDetails } from "./SkillRowDetails";
import type { LibraryClassificationSummary } from "@/lib/libraryClassification";
import { formatTokens } from "@/lib/estimateTokens";

export interface SkillRowProps {
  name: string;
  /**
   * A marked-up render of `name` (e.g. matched characters wrapped in
   * `<mark>`) shown in place of the plain string. `title`/`ariaLabel`/
   * `detailLabel` keep reading the plain `name` — only the visible glyph
   * changes.
   */
  nameNode?: ReactNode;
  /**
   * A marked-up render of the skill's description, in place of the plain
   * string. Falls back to `skill.description` when omitted (e.g. no query,
   * or the match wasn't on the description).
   */
  descNode?: ReactNode;
  /** The Library's content-search "why this row matched" line — a body-only
   *  hit's excerpt. Pass-through to `ResourceRow.excerpt`. */
  excerpt?: ReactNode;
  skill: Skill;
  registry: Registry;
  onClick: () => void;
  onPreview?: () => void;
  onEdit?: () => void;
  /** Opens the equip picker anchored to the triggering button's rect. */
  onOpenEquipPicker?: (anchor: DOMRect) => void;
  equippedCount?: number;
  /** Bundle names this skill belongs to — rendered as `in N` (mono, `title`
   *  lists the names). Replaces the retired per-bundle color `Tag` cluster. */
  bundleNames?: string[];
  selected?: boolean;
  /** Optional source chip rendered alongside the kind mark. */
  source?: ReactNode;
  /**
   * Right-aligned status cluster. When present it REPLACES the whole default
   * InvocationBadge/equipped-pip/version cluster — it does not merge with
   * it. A caller that wants "the defaults plus one more" composes the
   * defaults itself.
   */
  badges?: ReactNode;
  /**
   * Hover-revealed action cluster. When present it REPLACES the whole
   * default preview/edit/equip buttons — `onPreview`/`onEdit`/
   * `onOpenEquipPicker` are ignored while `actions` is passed.
   */
  actions?: ReactNode;
  /**
   * Rendered AFTER the default preview/edit/equip cluster (never after a
   * caller-supplied `actions`, which already replaces that cluster whole).
   * The Library's bundle mode uses this for its per-row "remove from
   * bundle" action / linked-lock glyph — one more action, not a fork of the
   * row's whole action set.
   */
  extraActions?: ReactNode;
  /**
   * Second-tier detail body. When present it REPLACES the auto-built detail
   * (bundle names + harness affinity) — it does not merge with it. Pass
   * `ariaLabel` alongside it: the row root is a `role="button"` div, so
   * without an explicit name the chevron's own "Show … details" label would
   * fold into the row's accessible name.
   */
  detail?: ReactNode;
  /** Controlled mode pass-through to `ResourceRow` — pass both or neither. */
  detailOpen?: boolean;
  onDetailToggle?: () => void;
  detailLabel?: string;
  /** Domain data-* attrs, passed straight through to `ResourceRow`. */
  dataset?: Record<string, string | boolean | undefined>;
  /** Appended after the fixed `skill-row` class — never replaces it. */
  className?: string;
  /** Root `aria-label`. Defaults to `name`. */
  ariaLabel?: string;
  /** Pass-through to `ResourceRow.tabIndex` — `-1` when a roving-list
   *  wrapper (e.g. Library's `.lib-nav-row`) owns the one tab stop. */
  tabIndex?: number;
  classification?: LibraryClassificationSummary;
  onClassificationInspect?: (field: "classes" | "outputs", value: string) => void;
  /** Body estimate from the Library's cached corpus; null means unavailable. */
  bodyTokens?: number | null;
  referenceStats?: SkillReferenceStats;
  /** True while a follow-up `bundle-add:<bundle>:<name>` process is running
   *  after this skill was created and is being added to the open bundle
   *  (design.md Decisions #4, create-then-follow-up). Marks the row
   *  `aria-busy` and appends a dim mono "adding…" segment to the meta
   *  cluster — no new state, it clears itself when the process settles. */
  pending?: boolean;
}

function stop(fn: () => void) {
  return (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    fn();
  };
}

/**
 * Skill-domain preset of `ResourceRow` (D5). Keeps the skill-specific
 * resolved-count / bundle-name logic and maps it onto the shared list
 * anatomy — so skill code doesn't leak into the generic. `badges`, `actions`
 * and `detail` each REPLACE their preset default when passed; they never
 * merge with it (COMPONENTS.md §Skill row).
 */
export function SkillRow({
  name,
  nameNode,
  descNode,
  excerpt,
  skill,
  registry,
  onClick,
  onPreview,
  onEdit,
  onOpenEquipPicker,
  equippedCount,
  bundleNames,
  selected,
  source,
  badges,
  actions,
  extraActions,
  detail,
  detailOpen,
  onDetailToggle,
  detailLabel,
  dataset,
  className,
  ariaLabel,
  tabIndex,
  classification,
  onClassificationInspect,
  bodyTokens = null,
  referenceStats,
  pending,
}: SkillRowProps) {
  // REVIEW-B #13: a caller that overrides `badges` (e.g. a remote unit row)
  // never renders the default equipped-pip, so skip the every-project walk
  // that would otherwise compute a count nobody uses.
  const resolvedCount = badges
    ? 0
    : (equippedCount ??
      Object.values(registry.projects).filter((p) =>
        resolveActiveSkills(p, registry).includes(name),
      ).length);

  const interactionStyle = skill.classification?.interaction_style;
  const bodyTokenTitle = "Approximate skill body tokens: UTF-8 bytes divided by 4. Excludes frontmatter and files from referenced or companion skills.";

  return (
    <ResourceRow
      className={`skill-row ${className ?? ""}`.trim()}
      selected={selected}
      onClick={onClick}
      title={name}
      ariaLabel={ariaLabel ?? name}
      dataset={dataset}
      tabIndex={tabIndex}
      ariaBusy={pending}
      glyph={<ScopeBadge scope={skill.scope} />}
      name={nameNode ?? name}
      meta={
        <span className="skill-meta">
          <KindMark kind={skill.type} />
          <span className="skill-interaction-style" title={interactionStyle ? "How this skill works with you" : "Interaction style not specified"}>
            {interactionStyle ?? "Unspecified"}
          </span>
          <span className="skill-body-tokens" title={pending ? "Adding to the bundle" : bodyTokenTitle}>
            {/* While pending, this cell shows "adding…" IN PLACE of the token
             *  text rather than appended after it — a freshly created skill
             *  has no token estimate yet, so nothing real is displaced, and
             *  swapping content (instead of adding a sibling span) keeps this
             *  in the one grid item `.skill-body-tokens` already owns
             *  (skill-rows.css: `grid-column: 4`, dim + mono). An appended
             *  sibling overflowed into the description column and overlapped
             *  "No description" at both 1440 and 680px. */}
            {pending
              ? "adding…"
              : bodyTokens === null
                ? "tokens unavailable"
                : `~${formatTokens(bodyTokens)} tokens`}
          </span>
        </span>
      }
      desc={descNode ?? (skill.description || "No description")}
      excerpt={excerpt}
      actions={
        actions ?? (
          <>
            {onPreview ? (
              <Button variant="ghost" size="sm" icon="eye" title="Preview" onClick={stop(onPreview)} />
            ) : null}
            {onEdit ? (
              <Button variant="ghost" size="sm" icon="edit" title="Edit" onClick={stop(onEdit)} />
            ) : null}
            {onOpenEquipPicker ? (
              <Button
                variant="ghost"
                size="sm"
                icon="equip"
                title="Equip on…"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenEquipPicker(e.currentTarget.getBoundingClientRect());
                }}
              />
            ) : null}
            {extraActions}
          </>
        )
      }
      badges={
        badges ?? (
          <>
            <InvocationBadge invocation={skill.invocation} />
            <span className="equipped-pip" data-active={resolvedCount > 0}>
              <Icon name="equip" size={11} />
              {resolvedCount}
            </span>
            <span className="ver">v{skill.version || "—"}</span>
          </>
        )
      }
      detail={detail ?? SkillRowDetails({ skill, bundleNames, source, classification, projectCount: badges ? equippedCount : resolvedCount, referenceStats, onInspect: onClassificationInspect })}
      detailOpen={detailOpen}
      onDetailToggle={onDetailToggle}
      detailLabel={detailLabel ?? `${name} details`}
    />
  );
}
