import { HarnessGlyph } from "@/components/harness/HarnessGlyph";
import { Tag } from "@/components/Tag";
import { parseModelId } from "./modelIdentity";

export interface ModelNameProps {
  model: string;
}

/** A model row's identity: a provider glyph, the readable display name
 *  (docs/changes/DESIGN-usage-numbers/PLAN.md §R2), and a small `[store]` tag when
 *  ccusage attributes the model to a store like pi-agent. The raw id is
 *  always recoverable on hover. The single `label` this screen's model rows
 *  use — the screen-wide Top models card, a session's own Models block, and
 *  the Sessions card's Model filter — so the same row can never read
 *  differently in two places. */
export function ModelName({ model }: ModelNameProps) {
  const identity = parseModelId(model);
  return (
    <span className="usage-model-name" title={identity.raw}>
      {identity.provider && <HarnessGlyph id={identity.provider} size={14} decorative />}
      {/* REVIEW-W1 #6: the display text gets its OWN elidable box. As a
          child of `.hbar-label` (whose own `overflow:hidden; text-overflow:
          ellipsis; white-space:nowrap` clips an atomic inline-level box
          outright — `text-overflow` elides text, not a nested flex item), a
          long name (a rule-6 verbatim raw id, "Opus 4.6 · thinking" in a
          narrow tile) hard-cut with no ellipsis and no visible affordance
          that it was truncated. The `title` on the outer span still
          recovers it either way. */}
      <span className="usage-model-text">{identity.display}</span>
      {identity.store && <Tag size="sm">{identity.store}</Tag>}
    </span>
  );
}
