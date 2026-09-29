import type { SkillReferenceStats } from "@/lib/skillRowStats";
import type { ReactNode } from "react";
import type { Skill } from "@/types";
import type { LibraryClassificationSummary } from "@/lib/libraryClassification";
import { classificationValues } from "@/lib/libraryClassification";
import { ClassificationValue } from "./skillEditor/ClassificationContributions";
import { HarnessIconGroup } from "./harness/HarnessGlyph";

export function SkillRowDetails({ skill, bundleNames = [], source, classification, projectCount, referenceStats, onInspect }: {
  skill: Skill;
  projectCount?: number;
  referenceStats?: SkillReferenceStats;
  bundleNames?: string[];
  source?: ReactNode;
  classification?: LibraryClassificationSummary;
  onInspect?: (field: "classes" | "outputs", value: string) => void;
}) {
  const { classes, outputs } = classificationValues(skill, classification, "references");
  const { working_mode: mode, maturity } = skill.classification ?? {};
  const hasContext = source || bundleNames.length > 0 || !!skill.harnesses?.length;
  if (projectCount === undefined && !referenceStats && !classes.length && !outputs.length && !mode && !maturity && !hasContext && !skill.invocation) return null;
  return <div className="skill-row-detail" role="presentation" onClick={(event) => event.stopPropagation()}>
    {(projectCount !== undefined || referenceStats) && <dl className="skill-detail-stats">
      {projectCount !== undefined && <div><dt>Equipped projects</dt><dd>{projectCount}</dd></div>}
      {referenceStats && <>
        <div title={referenceStats.outgoing.join(", ") || "No outgoing skill references"}><dt>References</dt><dd>{referenceStats.outgoing.length}<span>skills</span></dd></div>
        <div title={referenceStats.incoming.join(", ") || "No incoming skill references"}><dt>Referenced by</dt><dd>{referenceStats.incoming.length}<span>skills</span></dd></div>
      </>}
    </dl>}
    {(classes.length > 0 || outputs.length > 0 || mode || maturity) && <dl className="skill-detail-facts">
      {([['classes', 'Use for', classes], ['outputs', 'Produces', outputs]] as const).map(([field, label, values]) => values.length > 0 && <div key={field}>
        <dt>{label}</dt><dd>
          {values.slice(0, 4).map((item) => <ClassificationValue key={`${item.value}:${item.provenance}`} field={field} value={item.value} provenance={item.provenance} onInspect={onInspect} />)}
          {values.length > 4 && <span className="text-dim" title={values.slice(4).map((item) => item.value).join(", ")}>+{values.length - 4}</span>}
        </dd>
      </div>)}
      {mode && <div><dt>Working mode</dt><dd className="skill-working-mode">{mode}</dd></div>}
      {maturity && <div><dt>Maturity</dt><dd>{maturity}</dd></div>}
    </dl>}
    <dl className="skill-detail-context">
      {skill.type === "claude-skill" && <div><dt>Invoked by</dt><dd>{skill.invocation === "user-only" ? "You only" : skill.invocation === "model-only" ? "Agent only" : skill.invocation === "conflicted" ? "Conflicting trigger flags" : "You or agent"}</dd></div>}
      {source && <div><dt>Source</dt><dd>{source}</dd></div>}
      {!!skill.harnesses?.length && <div><dt>Harnesses</dt><dd><HarnessIconGroup ids={skill.harnesses} /></dd></div>}
      {bundleNames.length > 0 && <div><dt>In bundles</dt><dd className="text-mono" title={bundleNames.join(", ")}>{bundleNames.slice(0, 3).join(", ")}{bundleNames.length > 3 ? ` +${bundleNames.length - 3}` : ""}</dd></div>}
    </dl>
  </div>;
}
