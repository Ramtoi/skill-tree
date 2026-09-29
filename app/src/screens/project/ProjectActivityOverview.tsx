import { Button } from "@/components/Button";
import { StackedColumnChart } from "@/components/charts/StackedColumnChart";
import { HorizontalBarList } from "@/components/charts/HorizontalBarList";
import {
  SINGLE_SERIES,
  sequentialSteps,
} from "@/components/charts/chartColors";
import { useUsageProject } from "@/hooks/useUsageAnalytics";
import { buildProjectSessionColumns } from "@/screens/usage/usageProjectTimeline";
import { LoadoutUsageHeader } from "./LoadoutUsageHeader";
import type { UsageProjectPayload } from "@/features/usage/usageAnalyticsTypes";

export function loadoutActivity(
  payload: UsageProjectPayload,
  equippedSkills: string[],
  now = new Date(),
) {
  const current = new Set(equippedSkills);
  const observed = payload.utilization
    .filter((row) => current.has(row.key) && row.count > 0)
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  const parents = payload.sessions.filter((row) => !row.parent_session_id);
  const columns = buildProjectSessionColumns(parents, [], 30, null, now);
  const sessions = columns.reduce(
    (total, column) =>
      total +
      Object.values(column.values).reduce((sum, value) => sum + value, 0),
    0,
  );
  const datesMissing = parents.some(
    (row) => !row.started_at || Number.isNaN(Date.parse(row.started_at)),
  );
  return {
    observed,
    columns: columns.map((column) => ({
      ...column,
      values: {
        sessions: Object.values(column.values).reduce((sum, n) => sum + n, 0),
      },
    })),
    sessions,
    datesMissing,
  };
}
export function ProjectActivityOverview({
  projectName,
  skills,
  area,
  pick,
}: {
  projectName: string;
  skills: string[];
  area: (tab: string, focus?: string, extra?: Record<string, unknown>) => void;
  pick: (name: string) => void;
}) {
  const query = useUsageProject(projectName, 30);
  const payload = query.data;
  const data = payload?.ok ? loadoutActivity(payload, skills) : null;
  const colors = sequentialSteps(4);
  const observed = data?.observed ?? [];
  return (
    <section
      className="loadout-section project-activity-overview"
      aria-label="Observed activity"
    >
      <div className="loadout-head">
        <h3>
          Activity <span className="count">Last 30 days</span>
        </h3>
        <span className="stretch" />
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            area("usage", "utilization", { usageWindow: 30, loadoutOnly: true })
          }
        >
          Review loadout
        </Button>
      </div>
      {query.isError || payload?.ok === false ? (
        <p>
          Activity unavailable.{" "}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void query.refetch()}
          >
            Retry activity
          </Button>
        </p>
      ) : !data ? (
        <p>Reading recorded activity…</p>
      ) : !payload?.last_scan_at ? (
        <p>
          No scanned activity yet. Context estimates are available
          independently.
        </p>
      ) : (
        <div className="loadout-activity-grid">
          <div>
            <div className="loadout-activity-metric">
              <strong>{data.datesMissing ? "—" : data.sessions}</strong>
              <span>recorded sessions</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => area("usage", "sessions", { usageWindow: 30 })}
              >
                View sessions
              </Button>
            </div>
            {data.datesMissing ? (
              <p>
                Session chart unavailable: some records have no usable start
                date.
              </p>
            ) : (
              <StackedColumnChart
                columns={data.columns}
                series={[
                  {
                    id: "sessions",
                    label: "Recorded sessions",
                    color: SINGLE_SERIES,
                  },
                ]}
                height={100}
                format={String}
                ariaLabel="Daily top-level recorded sessions, last 30 UTC days"
              />
            )}
          </div>
          <div>
            <div className="loadout-activity-metric">
              <strong>
                {observed.length}
                <small> / {skills.length}</small>
              </strong>
              <span>skills observed</span>
            </div>
            <HorizontalBarList
              rows={observed.slice(0, 4).map((row, index) => ({
                key: row.key,
                label: (
                  <button
                    className="loadout-file-link"
                    onClick={() => pick(row.key)}
                  >
                    {row.key}
                  </button>
                ),
                value: row.count,
                display: String(row.count),
                titleText: `${row.count} recorded invocations`,
                color: colors[index],
              }))}
              ariaLabel="Most invoked equipped skills"
            />
            {!observed.length && (
              <p>No recorded skill invocations in this window.</p>
            )}
            {observed.length > 4 && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  area("usage", "utilization", {
                    usageWindow: 30,
                    loadoutOnly: true,
                  })
                }
              >
                View all {observed.length} observed skills
              </Button>
            )}
          </div>
        </div>
      )}
      <div className="loadout-activity-foot">
        <LoadoutUsageHeader lastScanAt={payload?.last_scan_at ?? null} />
        <small>
          Top-level sessions, UTC days. Unobserved skills may still be useful.
        </small>
      </div>
      {!!payload?.not_analysed.length && (
        <p>
          Not analysed:{" "}
          {payload.not_analysed.map((item) => item.harness).join(", ")}
        </p>
      )}
    </section>
  );
}
