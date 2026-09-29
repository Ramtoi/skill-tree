import { useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/Button";
import { Popover } from "@/components/Popover";
import type { ProjectTotal } from "./usageAggregate";
import { fromNav, usageBackTarget } from "@/lib/backTarget";
import { formatCompact, formatMoney, type UsageCurrency } from "./usageFormat";
import type { UsageRange } from "./useUsagePrefs";

export interface UsageProjectPickerProps {
  projects: ProjectTotal[];
  projectKeys: ReadonlySet<string>;
  range: UsageRange;
  harness: string | null;
  harnessName?: string;
  currency: UsageCurrency;
  eurRate: number;
}

function handoffWindow(range: UsageRange): 7 | 30 | 90 {
  if (range === "7d") return 7;
  if (range === "30d") return 30;
  if (range === "90d") return 90;
  return 90;
}

export function UsageProjectPicker({
  projects,
  projectKeys,
  range,
  harness,
  harnessName = "any harness",
  currency,
  eurRate,
}: UsageProjectPickerProps) {
  const navigate = useNavigate();
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const candidates = useMemo(
    () => projects
      .filter((project) => Boolean(project.hubProject && projectKeys.has(project.hubProject)))
      .sort((a, b) => b.costUsd - a.costUsd || b.tokens.total - a.tokens.total || a.label.localeCompare(b.label)),
    [projects, projectKeys],
  );
  const searchable = candidates.length > 8;
  const filtered = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    return needle ? candidates.filter((project) => project.label.toLocaleLowerCase().includes(needle)) : candidates;
  }, [candidates, search]);
  const disabledReason = `No projects with usage in this range for ${harness ? harnessName : "any harness"} in the latest scan`;
  const openProject = (project: ProjectTotal) => {
    if (!project.hubProject) return;
    navigate(`/usage/project/${encodeURIComponent(project.hubProject)}`, {
      ...fromNav(usageBackTarget()),
      state: { usageWindow: handoffWindow(range) },
    });
    setOpen(false);
  };

  return (
    <>
      <span ref={anchorRef} tabIndex={-1}>
        <Button
          icon="folder-open"
          variant="ghost"
          aria-label="Open project"
          aria-haspopup="dialog"
          aria-expanded={open}
          disabled={candidates.length === 0}
          disabledReason={candidates.length === 0 ? disabledReason : undefined}
          onClick={() => { setSearch(""); setOpen((value) => !value); }}
        >
          Open project…
        </Button>
      </span>
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={anchorRef} label="Open project" width={360}>
        <div className="usage-project-picker">
          <div className="usage-section-head">
            <div><span className="usage-kicker">Projects</span><h3>Open project</h3></div>
          </div>
          {searchable && (
            <label className="usage-project-picker-search">
              <span>Search projects</span>
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter" && filtered[0]) openProject(filtered[0]); }}
              />
            </label>
          )}
          {filtered.length === 0 ? (
            <p className="usage-note" aria-live="polite">No matching projects.</p>
          ) : (
            <div className="usage-project-picker-list">
              {filtered.map((project) => (
                <button type="button" className="usage-project-picker-row" key={project.key} onClick={() => openProject(project)}>
                  <span className="usage-project-picker-name">{project.label}</span>
                  <span className="usage-project-picker-cost">{formatMoney(project.costUsd, currency, eurRate)}</span>
                  <span className="usage-project-picker-meta">{formatCompact(project.tokens.total)} tokens · {project.sessions} sessions{handoffWindow(range) === 90 && range !== "90d" ? " · opens the last 90 days" : ""}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </Popover>
    </>
  );
}
