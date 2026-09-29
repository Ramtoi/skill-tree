import { ResourceRow } from "@/components/ResourceRow";
import { ScopeBadge, KindMark } from "@/components/Tag";
import { Button } from "@/components/Button";
import { InvocationBadge } from "@/components/InvocationBadge";
import { SkillInvocationOverride } from "@/components/SkillInvocationOverride";
import { StatusBadge } from "@/components/StatusBadge";
import { IdleExplanation } from "./IdleExplanation";
import { IdleBadge } from "@/components/IdleBadge";
import { affinityMismatch } from "@/lib/affinity";
import { skillMissesRefs, missingRefsIn } from "@/lib/missingRefs";
import type { OverrideChoice } from "@/lib/invocation";
import type { MissingRef } from "@/lib/syncFreshness";
import type { Project, Registry } from "@/types";
import type { UsageProjectPayload } from "@/features/usage/usageAnalyticsTypes";
import type { HarnessFootprintTokens } from "@/lib/footprintTokens";
import { useMcpSummary } from "@/hooks/useMcpSummary";
import { capabilityCountsLine } from "@/lib/mcpContract";
import { relTime } from "@/lib/syncFreshness";

function McpSummary({ name }: { name: string }) {
  const query = useMcpSummary(name);
  const probe = query.data?.last_probe;
  return (
    <span className="loadout-mcp-summary">
      {query.data?.spec?.transport ? `${query.data.spec.transport} · ` : ""}
      {query.isError || query.data?.ok === false
        ? "Catalog unavailable"
        : query.isPending
          ? "Reading stored catalog…"
          : probe?.catalog
            ? `${capabilityCountsLine(probe.catalog)} · read ${relTime(probe.checked_at)}`
            : "No stored catalog"}
    </span>
  );
}
export interface ProjectLoadoutRowProps {
  name: string;
  projectName: string;
  proj: Project;
  registry: Registry;
  sources: string[];
  installedHarnessIds: string[];
  missingRefs: MissingRef[];
  usage?: UsageProjectPayload;
  tokens: HarnessFootprintTokens | null;
  pending: boolean;
  highlighted: boolean;
  reviewed: boolean;
  open: () => void;
  openBundle: (name: string) => void;
  disclosed: boolean;
  toggle: () => void;
  onDisable: () => void;
  onInvocation: (
    name: string,
    choice: OverrideChoice,
    previous: "auto" | "user-only" | "model-only" | undefined,
  ) => void;
}
export function ProjectLoadoutRow(props: ProjectLoadoutRowProps) {
  const { name, projectName, proj, registry, sources, tokens, usage } = props;
  const skill = registry.skills[name];
  if (!skill)
    return (
      <ResourceRow
        name={name}
        ariaLabel={name}
        desc="Referenced member is missing from the registry"
        className="project-loadout-row"
        role="group"
        tabIndex={0}
        dataset={{ member: name, "shared-highlight": props.highlighted }}
      />
    );
  const mcp = skill.type === "mcp-server";
  const direct = proj.enabled.includes(name);
  const row = usage?.utilization.find((entry) => entry.key === name);
  const idle = usage?.findings.find((finding) => finding.kind === "idle");
  const upfront = tokens?.bySkill.get(name);
  const wontSync = affinityMismatch(
    skill,
    proj,
    registry,
    props.installedHarnessIds,
  );
  const misses = skillMissesRefs(props.missingRefs, name);
  return (
    <ResourceRow
      name={name}
      ariaLabel={name}
      title={name}
      glyph={<ScopeBadge scope={skill.scope} />}
      className="project-loadout-row"
      dataset={{
        "shared-highlight": props.highlighted,
        reviewed: props.reviewed,
        pending: props.pending,
        direct,
        member: name,
      }}
      meta={
        <>
          <KindMark kind={skill.type} />
          {sources.length > 1 && (
            <span title={`Also supplied by ${sources.join(", ")}`}>
              shared · {sources.length} sources
            </span>
          )}
        </>
      }
      desc={skill.description || "No description"}
      excerpt={
        mcp ? (
          <McpSummary name={name} />
        ) : (
          <span>
            {upfront === undefined
              ? "Metadata tokens unavailable"
              : `~${upfront.toLocaleString()} metadata tokens`}
            {row && row.count > 0 ? ` · ${row.count} recorded invocations` : ""}
          </span>
        )
      }
      badges={
        <>
          {wontSync && (
            <StatusBadge
              channel="warn"
              shape="pill"
              icon="warning"
              title="No installed harness matches this skill"
              className="skill-affinity-badge"
              ariaLabel="Won't sync here — no matching harness"
            />
          )}
          {misses && (
            <StatusBadge
              channel="warn"
              shape="pill"
              icon="link"
              className="skill-missing-refs-badge"
              ariaLabel="References a skill this project does not have"
              title={`Missing references on ${projectName}: ${missingRefsIn(props.missingRefs, name).join(", ")}`}
            />
          )}
          {!mcp && (
            <InvocationBadge
              invocation={proj.invocation_overrides?.[name] ?? skill.invocation}
              requested={proj.invocation_overrides?.[name] !== undefined}
              className={
                proj.invocation_overrides?.[name] !== undefined
                  ? "invocation-override-badge"
                  : undefined
              }
            />
          )}
        </>
      }
      actions={
        direct ? (
          <Button
            variant="ghost"
            size="sm"
            icon="x"
            data-testid="skill-card-unequip"
            disabled={props.pending}
            title={
              sources.length
                ? `Remove direct attachment of ${name}; remains supplied by bundle`
                : `Unequip ${name}`
            }
            onClick={(event) => {
              event.stopPropagation();
              props.onDisable();
            }}
          />
        ) : undefined
      }
      onClick={props.open}
      detailOpen={props.disclosed}
      onDetailToggle={props.toggle}
      detailLabel={`${name} details`}
      detail={
        // Clicks within the disclosure must not activate its enclosing editor link.
        <div
          className="loadout-row-detail"
          role="presentation"
          onClick={(event) => event.stopPropagation()}
        >
          <p>{skill.description || "No description"}</p>
          <div className="loadout-row-facts">
            <span>
              {skill.version ? `v${skill.version}` : "Version unspecified"}
            </span>
            <span>
              {skill.harnesses?.length
                ? skill.harnesses.join(", ")
                : "All compatible harnesses"}
            </span>
            {direct && (
              <span>
                Direct attachment
                {sources.length ? " · also supplied by bundle" : ""}
              </span>
            )}
          </div>
          {sources.length > 0 && (
            <div>
              From{" "}
              {sources.map((source) => (
                <Button
                  key={source}
                  size="sm"
                  variant="ghost"
                  onClick={(event) => {
                    event.stopPropagation();
                    props.openBundle(source);
                  }}
                >
                  {source}
                </Button>
              ))}
            </div>
          )}
          {!mcp && (
            <SkillInvocationOverride
              skillName={name}
              projectName={projectName}
              libraryInvocation={skill.invocation}
              override={proj.invocation_overrides?.[name]}
              scope={skill.scope}
              onPick={(choice, previous) =>
                props.onInvocation(name, choice, previous)
              }
            />
          )}
          {row?.idle &&
            !mcp &&
            (idle ? (
              <IdleExplanation
                finding={idle}
                row={row}
                skillKey={name}
                projectName={projectName}
                bundleName={sources[0]}
                onOpenBundle={props.openBundle}
                tokens={tokens}
                canUnequip={direct}
                canOverrideInvocation={!mcp}
              />
            ) : (
              <IdleBadge />
            ))}
        </div>
      }
    />
  );
}
