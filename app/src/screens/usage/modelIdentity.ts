/** The parsed identity of a raw ccusage model id: a readable display name, an
 *  optional `[store]` prefix (ccusage's own store tag — pi-agent's, so far),
 *  and the hub harness id (for `<HarnessGlyph>`) the model's own head implies
 *  — never the store, which names WHERE a request was routed, not WHAT
 *  answered it. */
export type ModelIdentity = {
  /** Verbatim input, for the hover title. */
  raw: string;
  display: string;
  store?: string;
  provider?: "claude-code" | "codex";
};

const CLAUDE_FAMILIES = new Set(["fable", "sonnet", "opus", "haiku"]);

/** A GPT model's dash-suffix, mapped to how it should read. An unknown
 *  suffix is appended verbatim (rule 4) — this map only special-cases the
 *  ones seen in the local corpus. */
const GPT_SUFFIX_MAP: Record<string, string> = {
  codex: "Codex",
  mini: "mini",
  nano: "nano",
  sol: "Sol",
  terra: "Terra",
  luna: "Luna",
};

function capitalize(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

function isAllDigits(s: string): boolean {
  return s.length > 0 && /^\d+$/.test(s);
}

/** An 8-digit group ("20251001") is a build date, not a version number. */
function isBuildDate(s: string): boolean {
  return s.length === 8 && isAllDigits(s);
}

/** A version-shaped group: one or more dot-separated all-digit runs — "4",
 *  "4.5", "4.5.1". REVIEW-W1 #4: `isAllDigits` alone rejected a dotted group
 *  outright, so `claude-haiku-4.5` fell into the qualifier branch and read
 *  "Haiku · 4.5" — the interpunct form reserved for `thinking`/`1M` — while
 *  the gpt branch already accepted dotted versions (`gpt-5.4` → `GPT-5.4`).
 *  Still true for a build date (`isBuildDate`'s own check needs the plain,
 *  undotted shape), so a build-date group still stops here for the CALLER
 *  to decide whether to drop it, not this predicate. */
function isVersionGroup(s: string): boolean {
  return /^\d+(\.\d+)*$/.test(s);
}

function providerForHead(s: string): "claude-code" | "codex" | undefined {
  if (s.startsWith("claude-")) return "claude-code";
  if (s.startsWith("gpt-")) return "codex";
  return undefined;
}

/**
 * Parses a raw ccusage model id into a display-ready identity
 * (docs/changes/DESIGN-usage-numbers/PLAN.md §R2). Rules, in order:
 *
 * 1. A leading `"[store] "` prefix (ccusage's pi-store tag) is split off
 *    into `store` and removed from the rest.
 * 2. `claude-<family>-<version...>` (`family` one of fable/sonnet/opus/
 *    haiku): family is title-cased, the leading all-digit version groups
 *    are joined with `.`, an 8-digit group is a build date and is dropped,
 *    and any remaining group becomes a qualifier appended as `· <group>`. A
 *    trailing `[1m]` (no separating space — a context-window tag, distinct
 *    from the leading store bracket) renders `· 1M`.
 * 3. The legacy order `claude-<version>-<family>[-<date>]` maps to the same
 *    output, so `claude-3-5-sonnet-20241022` reads `Sonnet 3.5`.
 * 4. `gpt-<version>[-<suffix>]`: `GPT-<version>`, then a suffix from
 *    {@link GPT_SUFFIX_MAP} or, for an unmapped one, the suffix itself.
 * 5. Provider: a `claude-` head gives `claude-code`, a `gpt-` head gives
 *    `codex`, anything else gives none. `store` is never a provider signal.
 * 6. Anything else returns `display === raw` with no provider — an unknown
 *    shape (`pi-default`, `<synthetic>`, a future model) is kept verbatim.
 */
export function parseModelId(raw: string): ModelIdentity {
  let rest = raw;

  let store: string | undefined;
  const storeMatch = /^\[([^\]]+)\]\s+(.+)$/.exec(rest);
  if (storeMatch) {
    store = storeMatch[1];
    rest = storeMatch[2];
  }

  // A trailing "[qualifier]" with NO separating space (e.g. "[1m]") — a
  // context-window tag, distinct from the leading store bracket above.
  let contextQualifier: string | undefined;
  const contextMatch = /^(.+)\[([^\]]+)\]$/.exec(rest);
  if (contextMatch) {
    rest = contextMatch[1];
    contextQualifier = contextMatch[2].toLowerCase() === "1m" ? "1M" : contextMatch[2];
  }

  if (rest.startsWith("claude-")) {
    const groups = rest
      .slice("claude-".length)
      .split("-")
      .filter((g) => g.length > 0);
    const familyIdx = groups.findIndex((g) => CLAUDE_FAMILIES.has(g));
    if (familyIdx !== -1) {
      const family = groups[familyIdx];
      let version: string;
      let qualifier: string | undefined;

      if (familyIdx === 0) {
        // New order: claude-<family>-<version...>[-<qualifier>]
        const after = groups.slice(1);
        const versionParts: string[] = [];
        let i = 0;
        while (i < after.length && isVersionGroup(after[i])) {
          if (!isBuildDate(after[i])) versionParts.push(after[i]);
          i++;
        }
        version = versionParts.join(".");
        const remaining = after.slice(i);
        qualifier = remaining.length > 0 ? remaining.join("-") : undefined;
      } else {
        // Legacy order: claude-<version...>-<family>[-<date>]
        version = groups
          .slice(0, familyIdx)
          .filter((g) => isVersionGroup(g) && !isBuildDate(g))
          .join(".");
        const after = groups.slice(familyIdx + 1);
        qualifier = after.length > 0 && !isBuildDate(after[0]) ? after.join("-") : undefined;
      }

      const parts = [`${capitalize(family)} ${version}`.trim()];
      if (qualifier) parts.push(qualifier);
      if (contextQualifier) parts.push(contextQualifier);
      return { raw, display: parts.join(" · "), store, provider: "claude-code" };
    }
  }

  if (rest.startsWith("gpt-")) {
    const tail = rest.slice("gpt-".length);
    const dashIdx = tail.indexOf("-");
    const version = dashIdx === -1 ? tail : tail.slice(0, dashIdx);
    const suffix = dashIdx === -1 ? undefined : tail.slice(dashIdx + 1);
    let display = `GPT-${version}`;
    if (suffix) display += ` ${GPT_SUFFIX_MAP[suffix.toLowerCase()] ?? suffix}`;
    if (contextQualifier) display += ` · ${contextQualifier}`;
    return { raw, display, store, provider: "codex" };
  }

  // Nothing matched (rule 6): keep the raw string verbatim, but the head
  // still names a provider glyph when it's recognizable — a claude- or gpt-
  // prefixed id in a shape this parser does not yet know is still a Claude
  // Code or Codex model, not an unidentified one.
  return { raw, display: raw, store, provider: providerForHead(rest) };
}
