import { useMemo, useRef, useState } from "react";
import { Button } from "@/components/Button";
import { MultiSelectList } from "@/components/MultiSelectList";
import { Popover } from "@/components/Popover";
import { SearchInput } from "@/components/SearchInput";
import { LineChart } from "@/components/charts/LineChart";
import { IDENTITY_SERIES, seriesColorFor } from "@/components/charts/chartColors";
import type { UsageTimelineDay } from "@/features/usage/usageAnalyticsTypes";
import { activityTotals, buildActivitySeries, type ActivitySelection, type ActivityBounds } from "./usageOverTime";
import { bucketLabel, type ChartBucket } from "./usageChartColumns";
import type { UsagePeriodKind } from "./usagePeriod";

interface UsageActivityCardProps {
  kind: "skills" | "tools";
  days: UsageTimelineDay[];
  bucket: ChartBucket;
  notice?: string;
  bounds?: ActivityBounds;
  onSelectPeriod?: (key: string, kind: UsagePeriodKind) => void;
}

/** Chart selections affect this view only; every candidate comes from its scoped timeline. */
export function UsageActivityCard({ kind, days, bucket, notice, bounds, onSelectPeriod }: UsageActivityCardProps) {
  const [selection, setSelection] = useState<ActivitySelection>();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const totals = useMemo(() => activityTotals(days, kind), [days, kind]);
  const defaults = totals.slice(0, 3).map(([id]) => id);
  const selected = selection?.ids ?? defaults;
  const visible = totals.filter(([id]) => selected.includes(id));
  const series = useMemo(() => buildActivitySeries(days, bucket, kind, selection, bounds), [days, bucket, kind, selection, bounds]);
  const title = kind === "skills" ? "Skills used" : "Tool activity";
  const noun = kind === "skills" ? "invocations" : "calls";
  const needle = search.trim().toLocaleLowerCase();
  const matches = totals.filter(([id]) => id.toLocaleLowerCase().includes(needle));
  const limit = IDENTITY_SERIES.length;
  const periodKind: UsagePeriodKind | undefined = bucket === "year" ? undefined : bucket;

  function toggle(id: string) {
    const current = visible.map(([name]) => name);
    const next = current.includes(id) ? current.filter((name) => name !== id) : [...current, id];
    setSelection({ ids: next });
  }

  return <section className="usage-card usage-over-time-card" aria-label={title}>
    <div className="usage-activity-card-head">
      <div><span className="usage-kicker">Over time</span><h3>{title}</h3></div>
      {kind === "skills" && !notice && totals.length > 0 && <Button
        icon="filter" size="sm" variant={selection ? "soft" : "ghost"}
        aria-label={`Choose skills, ${visible.length} selected`}
        aria-haspopup="dialog" aria-expanded={open}
        onClick={(event) => { anchorRef.current = event.currentTarget; setSearch(""); setOpen((value) => !value); }}
      >Skills · {visible.length}</Button>}
    </div>
    <p className="usage-note">by {bucket} · {noun}</p>
    {notice ? <p className="usage-note usage-over-time-empty">{notice}</p> : <LineChart
      series={series} formatValue={(value) => `${value} ${noun}`}
      ariaLabel={`${title}, ${bucket} ${noun}`} legend={kind === "skills" ? "always" : "auto"}
      formatAxis={(x) => bucketLabel(x, bucket).label} formatX={(x) => bucketLabel(x, bucket).tooltipLabel}
      onSelectPoint={onSelectPeriod && periodKind ? (key) => onSelectPeriod(key, periodKind) : undefined}
      emptyText={selection && totals.length > 0
        ? selection.ids.length > 0
          ? "No selected skills have data in this range. Choose skills to update the chart."
          : "No skills selected. Choose skills to add them to the chart."
        : "No data for this range"}
    />}
    <Popover open={open} onClose={() => setOpen(false)} anchorRef={anchorRef} align="right"
      label="Choose skills" width={360} className="usage-skill-picker">
      <div className="usage-skill-picker-heading"><strong>Skills on the chart</strong><span>{visible.length} of {totals.length}</span></div>
      <SearchInput value={search} onChange={setSearch} placeholder="Search skills…" trailing={<></>}
        inputProps={{ type: "search", "aria-label": "Search skills" }} />
      <div className="usage-skill-picker-actions">
        <span className="usage-note">Select up to {limit} skills</span>
        <Button size="sm" onClick={() => setSelection(undefined)}>Top 3</Button>
        <Button size="sm" onClick={() => setSelection({ ids: [] })}>Clear</Button>
      </div>
      <div className="usage-skill-picker-results">
        {matches.length === 0 ? <p className="usage-note" role="status">No matching skills.</p> : <MultiSelectList
          label="Skills on the chart"
          options={matches.map(([id, total]) => ({
            id, label: id, selected: selected.includes(id),
            glyph: <span className="chart-swatch" style={{ background: series.find((item) => item.id === id)?.color ?? seriesColorFor(id) }} aria-hidden="true" />,
            disabled: !selected.includes(id) && visible.length >= limit,
            title: !selected.includes(id) && visible.length >= limit ? `Deselect a skill to add ${id}` : id,
            meta: <>{total.toLocaleString()} <span className="usage-skill-picker-unit">invocations</span></>,
          }))}
          onToggle={toggle}
        />}
      </div>
    </Popover>
  </section>;
}
