import { useQueries } from "@tanstack/react-query";
import { mcpSummaryOptions } from "@/hooks/useMcpSummary";
import { useRef, useState } from "react";
import { Button } from "@/components/Button";
import { SearchInput } from "@/components/SearchInput";
import { Icon } from "@/components/Icon";
import { useHoldDrag } from "@/hooks/useHoldDrag";
import { useProjectLoadoutOrder } from "@/hooks/useProjectLoadoutOrder";
import { useFocusAfterCommit } from "@/hooks/useFocusAfterCommit";
import {
  projectLoadout,
  occurrenceKey,
  sectionKey,
} from "@/lib/projectLoadout";
import type { ProjectLoadoutReturn } from "@/lib/projectLoadoutReturn";
import type { Project, Registry } from "@/types";
import type { EquipStatus } from "@/screens/ProjectWorkspace";
import type { MissingRef } from "@/lib/syncFreshness";
import type { OverrideChoice } from "@/lib/invocation";
import type { HarnessFootprintTokens } from "@/lib/footprintTokens";
import type { UsageProjectPayload } from "@/features/usage/usageAnalyticsTypes";
import { ProjectLoadoutRow } from "./ProjectLoadoutRow";
import { useProjectReview } from "./ProjectReviewProvider";

function SectionCatalogSummary({ names }: { names: string[] }) {
  const queries = useQueries({
    queries: [...new Set(names)].map(mcpSummaryOptions),
  });
  const known = queries.flatMap((query) =>
    query.data?.last_probe?.catalog ? [query.data.last_probe.catalog] : [],
  );
  return (
    <p className="loadout-group-meta">
      {known.length
        ? `${known.reduce((sum, catalog) => sum + catalog.tools, 0)} tools in stored catalogs`
        : "No stored tool counts"}
      {known.length < names.length
        ? ` · ${names.length - known.length} catalogs unavailable`
        : ""}
      . Cached capabilities, not runtime status.
    </p>
  );
}
type Props = {
  projectName: string;
  proj: Project;
  registry: Registry;
  installedHarnessIds: string[];
  equipStatus: Record<string, EquipStatus>;
  missingRefs: MissingRef[];
  usage?: UsageProjectPayload;
  footprintTokens: HarnessFootprintTokens | null;
  onSetDragOver: (zone: "equipped" | "avail" | null) => void;
  onDrop: (zone: "equipped" | "avail", name: string) => void;
  onDisableSkill: (name: string) => void;
  onSetInvocationOverride: (
    name: string,
    choice: OverrideChoice,
    previous: "auto" | "user-only" | "model-only" | undefined,
  ) => void;
  state: ProjectLoadoutReturn;
  update: (patch: Partial<ProjectLoadoutReturn>) => unknown;
  open: (path: string, focus?: string) => void;
};
export function ProjectGroupedLoadout(props: Props) {
  const { registry, proj, state, update, open } = props;
  const model = projectLoadout(proj, registry);
  const order = useProjectLoadoutOrder(proj.path, model.sections);
  const [hovered, setHovered] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const review = useProjectReview();
  const filtered = !!(state.query || state.exact || state.source);
  const query = state.query.toLowerCase().trim();
  const requestFocus = useFocusAfterCommit();
  const focusSection = (key: string) =>
    requestFocus(() =>
      [
        ...(root.current?.querySelectorAll<HTMLElement>("[data-section-key]") ??
          []),
      ]
        .find((element) => element.dataset.sectionKey === key)
        ?.querySelector<HTMLButtonElement>(".loadout-section-toggle"),
    );
  function move(key: string, before?: string) {
    if (!filtered) {
      order.move(key, before);
      focusSection(key);
    }
  }
  const targetAt = (point: { x: number; y: number }) =>
    document
      .elementFromPoint(point.x, point.y)
      ?.closest<HTMLElement>("[data-section-key]")?.dataset.sectionKey;
  const drag = useHoldDrag<string>({
    scrollContainer: (owner) => {
      const overview = owner.closest<HTMLElement>(".project-loadout-overview");
      return overview && getComputedStyle(overview).overflowY === "auto"
        ? overview
        : owner.closest<HTMLElement>(".loadout-overview-main");
    },
    onStart: setDragging,
    onMove: (_, point) => setDropTarget(targetAt(point) ?? null),
    onEnd: (key, point) => {
      const target = point && targetAt(point);
      if (target && target !== key) move(key, target);
      setDragging(null);
      setDropTarget(null);
    },
  });
  const visible = order.sections.filter(
    (section) =>
      !state.source ||
      (section.ref.kind === "bundle" ? section.ref.bundle : "direct") ===
        state.source,
  );
  const matches = (name: string) =>
    state.exact
      ? name === state.exact
      : !query ||
        `${name} ${registry.skills[name]?.description ?? ""}`
          .toLowerCase()
          .includes(query);
  const visibleCount = new Set(
    visible.flatMap((section) => section.members.filter(matches)),
  ).size;
  return (
    <div
      ref={root}
      className={`loadout-section project-grouped-loadout${review.isParticipating("loadout") ? " review-area-emphasis" : ""}`}
      data-review-area={
        review.isParticipating("loadout") ? "loadout" : undefined
      }
    >
      <div className="loadout-head">
        <h3>
          <Icon name="plug" size={14} />
          Equipped skills <span className="count">{model.members.length}</span>
        </h3>
        <span className="stretch" />
        <Button
          size="sm"
          variant="ghost"
          disabled={!order.custom}
          onClick={order.reset}
        >
          Reset order
        </Button>
      </div>
      <SearchInput
        value={state.query}
        onChange={(query) => update({ query, exact: null })}
        placeholder="Find in loadout…"
        inputTestId="loadout-search"
        inputProps={{ "aria-label": "Find in loadout" }}
        screenSearch={state.panel !== "library"}
      />
      <div className="loadout-source-filters" aria-label="Filter by source">
        <Button
          size="sm"
          variant={!state.source ? "soft" : "ghost"}
          aria-pressed={!state.source}
          onClick={() => update({ source: "" })}
        >
          All sources
        </Button>
        {model.sources.map((source) => (
          <Button
            key={source}
            size="sm"
            variant={state.source === source ? "soft" : "ghost"}
            aria-pressed={state.source === source}
            onClick={() =>
              update({ source: state.source === source ? "" : source })
            }
          >
            {source}
          </Button>
        ))}
        {model.sections.some((section) => section.ref.kind === "direct") && (
          <Button
            size="sm"
            variant="ghost"
            aria-pressed={state.source === "direct"}
            onClick={() =>
              update({ source: state.source === "direct" ? "" : "direct" })
            }
          >
            Direct
          </Button>
        )}
      </div>
      <p className="loadout-order-note">
        {filtered ? (
          <>
            {visibleCount} matching items. Clear filters to reorder sections.{" "}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => update({ query: "", exact: null, source: "" })}
            >
              Clear filters
            </Button>
          </>
        ) : (
          <>
            Hold a section header to reorder, or use its move controls.{" "}
            {order.custom
              ? "Personal order on this machine."
              : "Following bundle order."}
          </>
        )}
      </p>
      {/* Native drop is a pointer alternative to the keyboard-operable Add skills panel. */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
      <div
        role="group"
        aria-label="Equipped sections"
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes("text/skill")) {
            event.preventDefault();
            props.onSetDragOver("equipped");
          }
        }}
        onDragLeave={() => props.onSetDragOver(null)}
        onDrop={(event) => {
          event.preventDefault();
          props.onDrop("equipped", event.dataTransfer.getData("text/skill"));
        }}
      >
        {visible.map((section) => {
          const key = sectionKey(section.ref);
          const members = section.members.filter(matches);
          if ((state.query || state.exact) && !members.length) return null;
          const collapsed =
            state.collapsed.includes(key) && !state.query && !state.exact;
          const index = order.sections.indexOf(section);
          const mcp = section.members.filter(
            (name) => registry.skills[name]?.type === "mcp-server",
          ).length;
          const missingMembers = section.members.filter(
            (name) => !registry.skills[name],
          ).length;
          const tokenValues = section.members
            .filter(
              (name) =>
                registry.skills[name] &&
                registry.skills[name].type !== "mcp-server",
            )
            .map((name) => props.footprintTokens?.bySkill.get(name));
          const knownTokens = tokenValues.reduce<number>(
            (sum, value) => sum + (value ?? 0),
            0,
          );
          const missingTokens = tokenValues.filter(
            (value) => value === undefined,
          ).length;
          return (
            <section
              key={key}
              className="loadout-group"
              data-section-key={key}
              data-loadout-focus={key}
              data-dragging={dragging === key || undefined}
              data-drop-target={
                (dropTarget === key && dragging !== key) || undefined
              }
            >
              <div
                className="loadout-group-head"
                onPointerDown={(event) => {
                  if (!filtered) drag.onPointerDown(event, key);
                }}
                onClickCapture={drag.onClickCapture}
              >
                <Icon name="drag" size={13} />
                <button
                  className="loadout-section-toggle"
                  type="button"
                  aria-expanded={!collapsed}
                  onClick={() =>
                    update({
                      collapsed: state.collapsed.includes(key)
                        ? state.collapsed.filter((item) => item !== key)
                        : [...state.collapsed, key],
                    })
                  }
                >
                  <Icon
                    name={collapsed ? "chevron-right" : "chevron-down"}
                    size={12}
                  />
                  <span>{section.title}</span>
                </button>
                {section.ref.kind === "bundle" && (
                  <Button
                    variant="ghost"
                    size="sm"
                    title={`Open bundle ${section.ref.bundle}`}
                    onClick={() => {
                      if (section.ref.kind === "bundle")
                        open(
                          `/bundle/${encodeURIComponent(section.ref.bundle)}`,
                          key,
                        );
                    }}
                  >
                    {section.ref.bundle}
                    {section.scope === "global" ? " · global" : ""}
                  </Button>
                )}
                <div className="loadout-move-controls">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={filtered || index === 0}
                    aria-label={`Move ${section.title} up`}
                    onClick={() =>
                      move(key, sectionKey(order.sections[index - 1].ref))
                    }
                  >
                    ↑
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={filtered || index === order.sections.length - 1}
                    aria-label={`Move ${section.title} down`}
                    onClick={() =>
                      move(
                        key,
                        order.sections[index + 2]
                          ? sectionKey(order.sections[index + 2].ref)
                          : undefined,
                      )
                    }
                  >
                    ↓
                  </Button>
                  <select
                    aria-label={`Move ${section.title} before`}
                    value=""
                    disabled={filtered}
                    onChange={(event) => {
                      if (event.target.value)
                        move(
                          key,
                          event.target.value === "end"
                            ? undefined
                            : event.target.value,
                        );
                    }}
                  >
                    <option value="">Move before…</option>
                    {order.sections
                      .filter((other) => other !== section)
                      .map((other) => (
                        <option
                          key={sectionKey(other.ref)}
                          value={sectionKey(other.ref)}
                        >
                          {other.ref.kind === "bundle"
                            ? `${other.ref.bundle} / `
                            : ""}
                          {other.title}
                        </option>
                      ))}
                    <option value="end">End</option>
                  </select>
                </div>
              </div>
              <p className="loadout-group-meta">
                {section.members.length - mcp - missingMembers} skills · {mcp}{" "}
                MCPs{missingMembers > 0 && ` · ${missingMembers} unresolved`}
                {tokenValues.length > 0
                  ? ` · ~${knownTokens.toLocaleString()} known metadata tokens${missingTokens ? ` · ${missingTokens} unavailable` : ""}`
                  : ""}
              </p>
              {!collapsed && (
                <>
                  {mcp > 0 && (
                    <SectionCatalogSummary
                      names={section.members.filter(
                        (name) => registry.skills[name]?.type === "mcp-server",
                      )}
                    />
                  )}
                  {section.guidance && (
                    <p className="loadout-group-guidance">{section.guidance}</p>
                  )}
                  {!members.length && (
                    <p className="loadout-order-note">
                      No members in this section.
                    </p>
                  )}
                  {members.map((name) => {
                    const occurrence = occurrenceKey(section.ref, name);
                    const sources = model.sources.filter((source) =>
                      registry.bundles[source].skills.includes(name),
                    );
                    return (
                      <div
                        key={occurrence}
                        data-loadout-focus={occurrence}
                        onPointerEnter={() => setHovered(name)}
                        onPointerLeave={() => setHovered(null)}
                        onFocusCapture={() => setFocused(name)}
                        onBlurCapture={(event) => {
                          if (
                            !event.currentTarget.contains(event.relatedTarget)
                          )
                            setFocused(null);
                        }}
                      >
                        <ProjectLoadoutRow
                          name={name}
                          proj={proj}
                          registry={registry}
                          projectName={props.projectName}
                          sources={sources}
                          tokens={props.footprintTokens}
                          usage={props.usage}
                          installedHarnessIds={props.installedHarnessIds}
                          missingRefs={props.missingRefs}
                          pending={props.equipStatus[name] === "pending"}
                          highlighted={name === hovered || name === focused}
                          reviewed={review.highlight.includes(name)}
                          disclosed={state.disclosed.includes(occurrence)}
                          toggle={() =>
                            update({
                              disclosed: state.disclosed.includes(occurrence)
                                ? state.disclosed.filter(
                                    (item) => item !== occurrence,
                                  )
                                : [...state.disclosed, occurrence],
                            })
                          }
                          open={() =>
                            open(
                              `/skill/${encodeURIComponent(name)}`,
                              occurrence,
                            )
                          }
                          openBundle={(source) =>
                            open(
                              `/bundle/${encodeURIComponent(source)}`,
                              occurrence,
                            )
                          }
                          onDisable={() => props.onDisableSkill(name)}
                          onInvocation={props.onSetInvocationOverride}
                        />
                      </div>
                    );
                  })}
                </>
              )}
            </section>
          );
        })}
        {!model.members.length && (
          <p>
            No skills equipped. Add skills or apply a bundle to get started.
          </p>
        )}
        {model.members.length > 0 && visibleCount === 0 && (
          <p>No matching members.</p>
        )}
      </div>
    </div>
  );
}
