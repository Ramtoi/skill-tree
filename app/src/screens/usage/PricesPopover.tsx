import { useRef, useState } from "react";
import { Chip } from "@/components/Chips";
import { Popover } from "@/components/Popover";
import { Toggle } from "@/components/Toggle";
import { useUsagePricingInfo } from "@/features/usage/useUsagePricingInfo";
import type { UsagePriceOverride, UsagePricingInfo } from "@/features/usage/usageTypes";
import { ModelName } from "./ModelName";
import { foldHomeDir } from "./usageFormat";

export interface PricesPopoverProps {
  /** Names of every unpriced model in the ACTIVE scope — computed by the
   *  caller (`pricing.ts`'s `unpricedModelNames`, over `scoped.models`), not
   *  re-derived here: this popover has no scope concept of its own. */
  unpricedModelNames: string[];
  onlinePricing: boolean;
  onOnlinePricingChange: (value: boolean) => void;
}

const POPOVER_WIDTH = 380;

/** A per-token USD rate ("0.00001") as a $/MTok figure ("10.00") — the unit
 *  a price sheet actually quotes. */
function ratePerMTok(perToken: number): string {
  return (perToken * 1_000_000).toFixed(2);
}

function overrideRatesText(o: UsagePriceOverride): string {
  return `in ${ratePerMTok(o.input)} · out ${ratePerMTok(o.output)} · write ${ratePerMTok(o.cache_write)} · read ${ratePerMTok(o.cache_read)} $/MTok`;
}

function sourceLine(info: UsagePricingInfo): string {
  const version = info.ccusage_version ? `ccusage ${info.ccusage_version}` : "ccusage version unknown";
  const mode = info.offline ? "embedded price table · offline" : "public price list fetched on the last scan";
  return `${version} · ${mode}`;
}

/**
 * Price transparency (docs/changes/DESIGN-usage-numbers/PLAN.md §R4): a `Popover`
 * disclosure off a `Prices` chip in the currency cluster — a one-control
 * disclosure with no steps and no footer, so a `Popover` over a `Sheet`.
 * Names the price source, lists any local override rates and any unpriced
 * model in the current scope, and hosts the online-pricing opt-in. A failed
 * `usage_pricing_info` read degrades to one line for the source/override
 * sections — the unpriced list (scope-derived, not IPC-derived) and the
 * toggle still render either way.
 */
export function PricesPopover({ unpricedModelNames, onlinePricing, onOnlinePricingChange }: PricesPopoverProps) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  // REVIEW-W1 #7: gated on `open` — `usage_pricing_info` shells a `ccusage
  // --version` probe on the Rust side, so an always-on query would fire it
  // on every Usage-screen mount, not only when this disclosure is opened.
  const { data: info, isPending, isError } = useUsagePricingInfo(open);

  return (
    <>
      <Chip ref={anchorRef} pressed={open} onClick={() => setOpen((o) => !o)}>
        Prices
      </Chip>
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={anchorRef} label="Price sources" width={POPOVER_WIDTH}>
        <div className="usage-prices-popover">
          {isPending ? (
            // REVIEW-W1 #7: pending is not failure — a query merely in
            // flight must never read as "unavailable" on the one screen
            // whose thesis is that a claim on screen is never wrong.
            <p className="usage-note">Reading price sources…</p>
          ) : isError || !info ? (
            <p className="usage-note">Price sources are unavailable.</p>
          ) : (
            <>
              <p className="usage-note">{sourceLine(info)}</p>
              <div className="usage-prices-section">
                <span className="usage-kicker">Skill Tree overrides</span>
                {info.overrides_path ? (
                  <>
                    <p className="usage-prices-path" title={info.overrides_path}>
                      {foldHomeDir(info.overrides_path)}
                    </p>
                    <ul className="usage-prices-list">
                      {info.overrides.map((o) => (
                        <li key={o.model}>
                          <ModelName model={o.model} />
                          <span className="usage-prices-rates">{overrideRatesText(o)}</span>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : (
                  <p className="usage-note">No local price overrides are installed.</p>
                )}
              </div>
            </>
          )}
          <div className="usage-prices-section">
            <span className="usage-kicker">Unpriced in this range</span>
            {unpricedModelNames.length > 0 ? (
              <ul className="usage-prices-list">
                {unpricedModelNames.map((m) => (
                  <li key={m}>
                    <ModelName model={m} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="usage-note">Every model in this range has a price.</p>
            )}
          </div>
          <Toggle
            variant="switch"
            size="sm"
            checked={onlinePricing}
            onChange={onOnlinePricingChange}
            ariaLabel="Fetch the public price list when scanning"
            label="Fetch the public price list when scanning"
          />
          <p className="usage-note">
            {onlinePricing
              ? "The next scan downloads LiteLLM's public price table over the network. Nothing about you, your prompts or your projects is sent."
              : "Off: every scan uses the embedded price table and makes no network call. Turning this on downloads LiteLLM's public price table on the next scan; nothing about you, your prompts or your projects is sent."}
          </p>
          <p className="usage-note">
            Every figure is an API-equivalent estimate, not an invoice. Cache writes at the 1-hour TTL cost
            more than this table models, so an estimate is a floor.
          </p>
        </div>
      </Popover>
    </>
  );
}
