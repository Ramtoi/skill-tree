import { Button } from "@/components/Button";
import { StatCard } from "@/components/StatCard";
import { CompositionBar } from "@/components/charts/CompositionBar";
import { sequentialSteps } from "@/components/charts/chartColors";
import { useUsageFootprint } from "@/hooks/useUsageAnalytics";
import { primaryHarness, useFootprintTokens } from "@/lib/footprintTokens";
import { harnessDisplayLabel } from "@/components/harness/harnessRegistry";
import { useAgentDocsListing } from "@/hooks/useAgentDocs";
import { useProjectAreaSummaries } from "./projectAreaSummary";
import { isDeviating } from "@/components/agentDocs/agentDocHelpers";
import { useHookList, useHookCapabilities } from "@/hooks/useHooks";
import { reachBadges } from "@/lib/hookReach";
import type { Project, Registry } from "@/types";

export function ProjectContextEstimate({
  projectName,
  inspect,
  selectedHarness,
  detailed = false,
}: {
  projectName: string;
  inspect?: (harness: string | null) => void;
  selectedHarness?: string | null;
  detailed?: boolean;
}) {
  const query = useUsageFootprint(projectName);
  const payload = query.data?.ok ? query.data : undefined;
  const harness =
    selectedHarness && payload?.harnesses[selectedHarness]
      ? selectedHarness
      : primaryHarness(payload);
  const tokens = useFootprintTokens(payload, harness);
  const block = harness ? payload?.harnesses[harness] : undefined;
  const colors = sequentialSteps(tokens?.parts.length ?? 1);
  return (
    <section className="project-context-estimate" aria-label="Context estimate">
      <StatCard
        label="Context estimate"
        value={
          tokens
            ? `~${tokens.total.toLocaleString()}`
            : query.isError || query.data?.ok === false
              ? "Unavailable"
              : query.isPending
                ? "…"
                : "Unknown"
        }
        sub={
          harness
            ? `${harnessDisplayLabel(harness)} · known upfront tokens`
            : "No harness estimate available"
        }
        hint={{
          title: "Configured context",
          body: (
            <p>
              Estimated from configured text, not a runtime context-window
              measurement. Skills are counted once. Discoverable instructions
              load when the agent reaches their directory.
            </p>
          ),
        }}
      />
      {tokens && (
        <>
          <CompositionBar
            segments={tokens.parts.map((part, index) => ({
              id: part.part,
              label: part.label,
              value: part.tokens,
              color: colors[index],
            }))}
            format={(value) => `~${value.toLocaleString()}`}
            ariaLabel="Known context contributors"
          />
          <p>
            ~{tokens.discoverable.toLocaleString()} discoverable instruction
            tokens{tokens.discoverableTruncated ? " · partial estimate" : ""}
          </p>
          {!!block?.unknown.length && (
            <p>
              {block.unknown.length} contributors not sized
              {detailed ? ":" : "."}
            </p>
          )}
          {detailed &&
            block?.unknown.map((part, index) => (
              <p key={`${part.part}:${index}`}>
                {part.label}: {part.reason}. {part.hint}
              </p>
            ))}
        </>
      )}
      {(query.isError || query.data?.ok === false) && (
        <Button size="sm" variant="ghost" onClick={() => void query.refetch()}>
          Retry context
        </Button>
      )}
      {inspect && (
        <Button
          size="sm"
          variant="ghost"
          icon="arrow-right"
          onClick={() => inspect(harness)}
        >
          Inspect context
        </Button>
      )}
    </section>
  );
}

export function ProjectContextPanel({
  projectName,
  proj,
  registry,
  area,
  open,
  manageHooks,
}: {
  projectName: string;
  proj: Project;
  registry: Registry;
  area: (tab: string, focus?: string, extra?: Record<string, unknown>) => void;
  open: (path: string, focus?: string) => void;
  manageHooks: () => void;
}) {
  const summary = useProjectAreaSummaries(projectName);
  const localAttached = !proj.path_unresolved;
  const listing = useAgentDocsListing(localAttached ? proj.path : undefined, false, localAttached, false, {
    staleTime: 30_000,
  });
  const hooks = useHookList();
  const caps = useHookCapabilities();
  const attached =
    hooks.data?.hooks?.filter(
      (hook) =>
        hook.attached_global || hook.attached_projects.includes(projectName),
    ) ?? [];
  const effective = new Set([
    ...(registry.harnesses_global ?? []),
    ...(proj.harnesses ?? []),
  ]);
  const rels = localAttached ? listing.data?.instruction_rels ?? [] : [];
  const deviations = localAttached ? listing.data?.instruction_sets?.filter(isDeviating) ?? [] : [];
  return (
    <aside className="project-context-panel" aria-label="Project overview">
      <ProjectContextEstimate
        projectName={projectName}
        inspect={(harness) =>
          area("usage", "footprint", { contextHarness: harness })
        }
      />
      <section className="project-context-section">
        <div className="loadout-context-head">
          <h3>Agent Docs</h3>
          <Button size="sm" variant="ghost" onClick={() => area("agent-docs")}>
            Open
          </Button>
        </div>
        <p>
          {!localAttached
            ? "No local directory attached"
            : listing.isError
            ? "Instructions unavailable"
            : listing.isPending
              ? "Reading instructions…"
              : `${rels.length} instruction files`}
        </p>
        {rels.slice(0, 3).map((rel) => (
          <button
            key={rel}
            className="loadout-file-link"
            title={rel}
            onClick={() => area("agent-docs", undefined, { adSelected: rel })}
          >
            {rel}
          </button>
        ))}
        {localAttached && listing.isError && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void listing.refetch()}
          >
            Retry instructions
          </Button>
        )}
        {deviations.length > 0 && (
          <Button
            size="sm"
            variant="ghost"
            icon="warning"
            onClick={() =>
              area("agent-docs", undefined, {
                adSelected: deviations[0].formats.AGENT.exists
                  ? deviations[0].formats.AGENT.rel
                  : deviations[0].formats.CLAUDE.rel,
              })
            }
          >
            {deviations.length}{" "}
            {deviations.length === 1 ? "directory needs" : "directories need"} a
            layout fix
          </Button>
        )}
      </section>
      <section className="project-context-section">
        <div className="loadout-context-head">
          <h3>
            Hooks{" "}
            <span className="count">{hooks.data ? attached.length : ""}</span>
          </h3>
          <Button size="sm" variant="ghost" onClick={manageHooks}>
            Manage hooks
          </Button>
        </div>
        {hooks.isError ? (
          <p>
            Hooks unavailable{" "}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void hooks.refetch()}
            >
              Retry
            </Button>
          </p>
        ) : hooks.isPending ? (
          <p>Reading hooks…</p>
        ) : !attached.length ? (
          <p>No hooks attached.</p>
        ) : (
          attached.slice(0, 3).map((hook) => {
            const unknown = [...effective].filter(
              (id) =>
                (!hook.harnesses?.length || hook.harnesses.includes(id)) &&
                !caps.data?.harnesses?.[id],
            );
            const supported = reachBadges(caps.data, hook.event).filter(
              (badge) =>
                effective.has(badge.harnessId) &&
                (!hook.harnesses?.length ||
                  hook.harnesses.includes(badge.harnessId)) &&
                badge.verdict === "supported" &&
                !badge.eventUnsupported,
            );
            return (
              <div key={hook.name} className="loadout-hook-preview">
                <button
                  className="loadout-file-link"
                  onClick={() => open(`/hook/${encodeURIComponent(hook.name)}`)}
                >
                  {hook.name}
                </button>
                <small>
                  {hook.event} · {hook.attached_global ? "global" : ""}
                  {hook.attached_global &&
                  hook.attached_projects.includes(projectName)
                    ? " + "
                    : ""}
                  {hook.attached_projects.includes(projectName)
                    ? "project"
                    : ""}
                </small>
                <small>
                  {caps.data
                    ? `Cached support: ${supported.map((badge) => harnessDisplayLabel(badge.harnessId)).join(", ") || (unknown.length ? "not yet known" : "none of this project's harnesses")}${unknown.length && supported.length ? ` · ${unknown.length} unknown` : ""}`
                    : "Harness support unknown"}
                </small>
              </div>
            );
          })
        )}
        {attached.length > 3 && (
          <p>+{attached.length - 3} more in Manage hooks</p>
        )}
      </section>
      <section className="project-context-section">
        <div className="loadout-context-head">
          <h3>Permissions</h3>
          <Button size="sm" variant="ghost" onClick={() => area("permissions")}>
            Open
          </Button>
        </div>
        <p>
          {summary.permissions
            ? `${summary.permissions.allow} allow · ${summary.permissions.deny} deny · ${summary.permissions.ask} ask`
            : "Reading rules…"}
        </p>
        <small>
          Configured global + shared patterns. Personal and native rules are in
          the editor.
        </small>
      </section>
      <section className="project-context-section">
        <div className="loadout-context-head">
          <h3>Sub-agents</h3>
          <Button size="sm" variant="ghost" onClick={() => area("subagents")}>
            Open
          </Button>
        </div>
        <p>
          {summary.subagents === "error"
            ? "Sub-agents unavailable"
            : !summary.subagents
              ? "Reading sub-agents…"
              : `${summary.subagents.agents} project agents · ${summary.subagents.builtins - summary.subagents.builtinsOff}/${summary.subagents.builtins} built-ins on`}
        </p>
        <small>Project agent configuration</small>
      </section>
    </aside>
  );
}
