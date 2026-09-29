import { UsageTrail } from "@/components/UsageTrail";
import type { UsageUtilizationRow } from "@/features/usage/usageAnalyticsTypes";
import type { HarnessFootprintTokens } from "@/lib/footprintTokens";

export interface LoadoutUsageTrailProps {
  row: UsageUtilizationRow | undefined;
  tokens: HarnessFootprintTokens | null;
  skillKey: string;
  lastScanAt: string | null;
}

function TokenFigure({
  tokens,
  skillKey,
  missing,
  lastScanAt,
}: Pick<LoadoutUsageTrailProps, "tokens" | "skillKey" | "lastScanAt"> & { missing: boolean }) {
  const value = tokens?.bySkill.get(skillKey);
  const title = missing
    ? `no data since the last scan${lastScanAt ? ` (${lastScanAt})` : ""}`
    : "Estimated tokens loaded upfront for this skill’s name, description, and path. Full skill instructions load when invoked.";
  return (
    <span className="loadout-trail-tokens" title={title}>
      {value === undefined ? "— tokens upfront" : `~${value} tokens upfront`}
    </span>
  );
}

export function LoadoutUsageTrail({ row, tokens, skillKey, lastScanAt }: LoadoutUsageTrailProps) {
  if (!row) return null;
  const missingTokens = tokens !== null && !tokens.bySkill.has(skillKey);
  const status =
    row.count > 0
      ? null
      : row.idle
        ? "no invocations in 30 days"
        : `not enough history yet (${row.sessions_with_skill} sessions counted)`;
  const label = `${skillKey} usage over the last 30 days`;
  return (
    <div
      className="loadout-usage-trail"
      title={row.last_used_at ?? undefined}
      data-testid="loadout-usage-trail"
    >
      <span className="loadout-trail-summary">
        {status ? (
          <span className="loadout-trail-status" title={status}>{status}</span>
        ) : (
          <>
            <span className="loadout-trail-count">{row.count}</span>
            {row.you > 0 && <><span> · </span><span>you </span><span className="loadout-trail-count">{row.you}</span></>}
            {row.model > 0 && <><span> · </span><span>model </span><span className="loadout-trail-count">{row.model}</span></>}
            {row.script > 0 && <><span> · </span><span>script </span><span className="loadout-trail-count">{row.script}</span></>}
          </>
        )}
      </span>
      <UsageTrail values={row.trail} ariaLabel={label} />
      <TokenFigure tokens={tokens} skillKey={skillKey} missing={missingTokens} lastScanAt={lastScanAt} />
    </div>
  );
}
