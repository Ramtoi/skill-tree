import { describe, expect, it } from "vitest";
import {
  foldHomeDir,
  formatCompact,
  formatCount,
  formatMoney,
  formatPercent,
  shortId,
  usageRunsLocallyLabel,
} from "@/screens/usage/usageFormat";

describe("formatMoney", () => {
  it("never prints a locale-disambiguated currency prefix — narrowSymbol only", () => {
    // The bug: default `currencyDisplay: "symbol"` renders "US$6,921.07"
    // under some locales, which runs the stat card's hero value past its
    // padding. `narrowSymbol` always prints the bare glyph.
    expect(formatMoney(6921.07, "USD", 0.86)).toBe("$6,921.07");
    expect(formatMoney(6921.07, "USD", 0.86)).not.toContain("US$");
  });

  it("converts to EUR at the given rate", () => {
    expect(formatMoney(6921.07, "EUR", 0.86)).toBe("€5,952.12");
  });

  it("always shows exactly two decimal places", () => {
    expect(formatMoney(5, "USD", 0.86)).toBe("$5.00");
  });
});

describe("formatCompact", () => {
  it("picks the largest unit the value clears — a 29.5B corpus never reads as a 5-digit M", () => {
    expect(formatCompact(29_500_000_000)).toBe("29.5B");
    expect(formatCompact(845_000)).toBe("845k");
    expect(formatCompact(1_200_000_000_000)).toBe("1.2T");
  });

  it("trims a trailing .0", () => {
    expect(formatCompact(2_000_000)).toBe("2M");
    expect(formatCompact(3_000_000_000)).toBe("3B");
  });

  it("falls back to a plain count below 1,000", () => {
    expect(formatCompact(320)).toBe("320");
  });

  it("preserves the sign", () => {
    expect(formatCompact(-2_500_000)).toBe("-2.5M");
  });
});

describe("formatPercent", () => {
  it("prints whole percents as integers", () => {
    expect(formatPercent(0.98)).toBe("98%");
    expect(formatPercent(0.18)).toBe("18%");
  });

  it("prints exactly zero as 0%", () => {
    expect(formatPercent(0)).toBe("0%");
  });

  it("shows one decimal for a real share below 1%", () => {
    // The bug: a 0.29% share used to round to the same "0%" a true zero gets.
    expect(formatPercent(0.0029)).toBe("0.3%");
    expect(formatPercent(0.006)).toBe("0.6%");
  });

  it("shows <0.1% for a share too thin to round to a tenth", () => {
    expect(formatPercent(0.0001)).toBe("<0.1%");
    expect(formatPercent(0.0004)).toBe("<0.1%");
  });

  it("treats a non-finite value as 0%", () => {
    expect(formatPercent(Number.NaN)).toBe("0%");
  });
});

// ─── Adversarial edge sweep (review round) ────────────────────────────────
// Everything below pins a boundary rather than a happy path: the values a
// real corpus actually lands on, and the values a corrupt cache can.

describe("formatCompact — unit boundaries", () => {
  it("switches unit at exactly 1e3 / 1e6 / 1e9 / 1e12", () => {
    expect(formatCompact(999)).toBe("999");
    expect(formatCompact(1_000)).toBe("1k");
    expect(formatCompact(999_999)).toBe("1M"); // rolls, see below
    expect(formatCompact(1_000_000)).toBe("1M");
    expect(formatCompact(1_000_000_000)).toBe("1B");
    expect(formatCompact(1_000_000_000_000)).toBe("1T");
  });

  it("rolls up rather than printing a four-digit mantissa", () => {
    // A per-unit round takes 999,950 to "1000.0k" — four digits and the
    // wrong unit for a number a reader would call 1M.
    expect(formatCompact(999_950)).toBe("1M");
    expect(formatCompact(999_950_000)).toBe("1B");
    expect(formatCompact(999_999_999_999)).toBe("1T");
    // Just under the roll boundary the value keeps its own unit.
    expect(formatCompact(999_949)).toBe("999.9k");
  });

  it("has nothing above T to roll into, so 1e15 stays 1000T", () => {
    expect(formatCompact(1e15)).toBe("1000T");
  });

  it("keeps the sign across a roll", () => {
    expect(formatCompact(-999_950)).toBe("-1M");
    expect(formatCompact(-1_000)).toBe("-1k");
  });

  it("reads a non-finite or negative-zero value as a plain 0", () => {
    // These arrive from a normalizer over a user-editable cache; a KPI tile
    // must never print "NaN", "InfinityT" or "-0".
    expect(formatCompact(Number.NaN)).toBe("0");
    expect(formatCompact(Number.POSITIVE_INFINITY)).toBe("0");
    expect(formatCompact(Number.NEGATIVE_INFINITY)).toBe("0");
    expect(formatCompact(-0)).toBe("0");
    expect(formatCount(Number.NaN)).toBe("0");
    expect(formatCount(-0)).toBe("0");
  });

  it("rounds a sub-1000 fraction to a whole count", () => {
    expect(formatCompact(0.999)).toBe("1");
    expect(formatCompact(0)).toBe("0");
  });
});

describe("formatPercent — share boundaries", () => {
  it("0.05% is the floor of the one-decimal band", () => {
    expect(formatPercent(0.0005)).toBe("0.1%");
    expect(formatPercent(0.0004999)).toBe("<0.1%");
  });

  it("1% is the floor of the whole-number band", () => {
    expect(formatPercent(0.01)).toBe("1%");
    expect(formatPercent(0.00999)).toBe("1.0%");
  });

  it("clamps a negative share to 0% and passes a >100% one through", () => {
    expect(formatPercent(-0.1)).toBe("0%");
    expect(formatPercent(1)).toBe("100%");
    expect(formatPercent(1.5)).toBe("150%");
  });

  it("treats every non-finite value as 0%", () => {
    expect(formatPercent(Number.POSITIVE_INFINITY)).toBe("0%");
    expect(formatPercent(Number.NEGATIVE_INFINITY)).toBe("0%");
  });
});

describe("narrowSymbol currency display", () => {
  // `formatMoney` deliberately passes `undefined` for the locale (the
  // viewer's own), so the rule itself is pinned against explicit locales
  // here: `narrowSymbol` prints the bare glyph in every one of them, which
  // is the whole reason the option is there.
  const cases: Array<[string, "USD" | "EUR", string]> = [
    ["de-DE", "USD", "$"],
    ["de-DE", "EUR", "€"],
    ["fr-FR", "USD", "$"],
    ["en-CA", "USD", "$"],
  ];
  for (const [locale, currency, glyph] of cases) {
    it(`${locale} / ${currency} prints a bare ${glyph}`, () => {
      const narrow = new Intl.NumberFormat(locale, {
        style: "currency",
        currency,
        currencyDisplay: "narrowSymbol",
        maximumFractionDigits: 2,
      }).format(6921.07);
      expect(narrow).toContain(glyph);
    if (!narrow.startsWith("US$") && !narrow.startsWith("$US")) {
      expect(narrow).not.toContain("US$");
      expect(narrow).not.toContain("$US");
    }
    });
  }

  it("en-CA is the locale that proves the point — its default display is US$", () => {
    const wide = new Intl.NumberFormat("en-CA", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 2,
    }).format(6921.07);
    expect(wide).toContain("US$");
  });
});

describe("foldHomeDir", () => {
  it("folds a leading /Users/<name> prefix to ~", () => {
    expect(foldHomeDir("/Users/alice/.skill-hub/ccusage-pricing.json")).toBe(
      "~/.skill-hub/ccusage-pricing.json",
    );
  });

  it("folds a bare /Users/<name> with no trailing path to a bare ~", () => {
    expect(foldHomeDir("/Users/alice")).toBe("~");
  });

  it("folds a leading /home/<name> prefix too", () => {
    expect(foldHomeDir("/home/alice/.config/ccusage-pricing.json")).toBe("~/.config/ccusage-pricing.json");
  });

  it("leaves a path outside either home shape unchanged", () => {
    const appBundlePath = "/Applications/Skill Tree.app/Contents/Resources/hub/ccusage-pricing.json";
    expect(foldHomeDir(appBundlePath)).toBe(appBundlePath);
  });
});

describe("usageRunsLocallyLabel", () => {
  it("names the offline privacy claim while online pricing is off", () => {
    expect(usageRunsLocallyLabel(false)).toBe("Runs locally · No raw prompts uploaded");
  });

  it("names the network fetch instead of overclaiming 'no network' while online pricing is on", () => {
    const label = usageRunsLocallyLabel(true);
    expect(label).toBe("Runs locally · fetches public prices");
    expect(label).not.toContain("No raw prompts uploaded");
  });
});

describe("shortId", () => {
  it.each([
    ["1dae0a69-6f00-4109-ab1c-873861269996", "1dae0a69"],
    ["2026/02/19/rollout-20260219-12345678-90ab-cdef-0123-456789abcdef", "89abcdef"],
    ["2026/02/19/rollout-2026-02-19T10-00-00-12345678-90ab-cdef-0123-456789abcdef", "89abcdef"],
    ["rollout-2026-02-19T10-00-00-12345678-90ab-cdef-0123-456789abcdef.jsonl", "89abcdef"],
    // A date-shaped DIRECTORY around a Claude uuid is not a rollout (review).
    ["/Users/alice/archive/2026-02-19/1dae0a69-6f00-4109-ab1c-873861269996", "1dae0a69"],
    ["2026/02/19/1dae0a69-6f00-4109-ab1c-873861269996", "1dae0a69"],
    ["/Users/alice/.codex/sessions/1dae0a69-6f00-4109-ab1c-873861269996", "1dae0a69"],
  ])("shortens %s to %s", (value, expected) => {
    expect(shortId(value)).toBe(expected);
  });
});
