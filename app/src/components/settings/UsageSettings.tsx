import { Button } from "@/components/Button";
import { ChipRadios } from "@/components/ChipRadios";
import { Field } from "@/components/Field";
import { Toggle } from "@/components/Toggle";
import { EUR_RATE_MIN, EUR_RATE_MAX, parseEurRate } from "@/lib/usagePreferences";
import { useUsagePreferences } from "@/store/usagePreferences";

export function UsageSettings({ draft, onDraftChange }: {
  draft: string | null;
  onDraftChange: (draft: string | null) => void;
}) {
  const prefs = useUsagePreferences();
  const value = draft ?? String(prefs.eurRate);
  const parsed = parseEurRate(value);
  const dirty = draft !== null && parsed !== prefs.eurRate;
  return (
    <section className="settings-content" aria-labelledby="settings-usage-title">
      <div className="settings-section-heading">
        <h2 id="settings-usage-title">Usage</h2>
        <p>Display preferences apply across Usage screens. Your filters stay unchanged.</p>
      </div>
      <Field label="Currency">
        <ChipRadios name="settings-currency" label="Currency" value={prefs.currency}
          options={[{ value: "USD", label: "USD" }, { value: "EUR", label: "EUR" }]}
          onChange={prefs.setCurrency} />
      </Field>
      <Field label="EUR per USD" htmlFor="settings-eur-rate"
        error={draft !== null && parsed === undefined ? `Enter a rate from ${EUR_RATE_MIN} to ${EUR_RATE_MAX}.` : undefined}
        hint="Manual reference rate. Select EUR to edit it. No exchange rate is fetched.">
        <input id="settings-eur-rate" type="text" inputMode="decimal" value={value}
          disabled={prefs.currency !== "EUR"} onChange={(event) => onDraftChange(event.target.value)} />
      </Field>
      <div className="settings-actions">
        <Button size="sm" disabled={!dirty || parsed === undefined || prefs.currency !== "EUR"}
          onClick={() => {
            if (parsed === undefined) return;
            prefs.setEurRate(parsed);
            onDraftChange(null);
          }}>Save rate</Button>
        <Button size="sm" variant="ghost" disabled={draft === null} onClick={() => onDraftChange(null)}>Cancel</Button>
      </div>
      <div className="settings-row">
        <div>
          <div className="settings-control-label">Fetch public model prices on the next scan</div>
          <p className="settings-help">Changes the next scan's pricing source. The last scan keeps its recorded prices.</p>
        </div>
        <Toggle variant="switch" ariaLabel="Fetch public model prices on the next scan"
          checked={prefs.onlinePricing} onChange={prefs.setOnlinePricing} />
      </div>
      {prefs.persistenceError && <p className="settings-inline-error" role="alert">{prefs.persistenceError}</p>}
    </section>
  );
}
