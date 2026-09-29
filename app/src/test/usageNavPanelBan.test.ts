import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// ─── The navigator must never reach the usage-analytics hooks (design D14.2,
//     G22) ────────────────────────────────────────────────────────────────
//
// `hooks/useUsageAnalytics.ts` may be imported only by `screens/usage/**`,
// the two usage route wrappers, and `LocalAgentUsage.tsx` — never by
// `components/nav/**` or `lib/navInsights.ts`. The RUNTIME half of this
// constraint is `NavPanel.test.tsx`'s `BANNED_COMMANDS`/`it.each` block,
// which already fails any `hub_cmd(["usage", …])` call on every route it
// renders and needed no edit for wave 2. This is the STATIC half: a
// source-text scan (the same style as `ipcParity.test.ts`) that finds no
// reference to `useUsageAnalytics` and no `hubCmd`/`runHubCmd` call whose
// first array element is the literal `"usage"`, in every navigator body
// file PLUS every LOCAL module any of them imports (one level deep).
//
// LIMIT, stated here so a later wave does not trust this test further than
// it goes: it follows import chains exactly ONE level from the navigator
// files themselves. A navigator body that imports a helper which in turn
// imports `useUsageAnalytics` (a TWO-level transitive import) escapes this
// check. Wave 4's navigator plaque line — which explicitly wants to read
// `hub usage findings` — needs a new, explicit, argued carve-out here; it
// must not slip past this test by hiding behind a second import hop.

const APP_ROOT = process.cwd(); // vitest runs from `app/`
const SRC = join(APP_ROOT, "src");
const NAV_DIR = join(SRC, "components", "nav");

const BANNED_IDENTIFIER_RE = /\buseUsageAnalytics\b/;
// Scoped to the FIVE wave-2 analytics verbs, not to "usage" generically:
// `useLocalAgentUsage.ts` (imported by AgentsBody.tsx for its usage-summary
// tiles) already calls `hubCmd(["usage","history",...])` and
// `hubCmd(["usage","import-claude-stats",...])` — pre-existing, allowed
// calls unrelated to this wave's hooks (`NavPanel.test.tsx`'s own R6 comment
// carves those two out explicitly). A generic `["usage"` match would flag
// that legitimate file as an offender.
const BANNED_USAGE_ANALYTICS_VERBS = ["project", "session", "footprint", "findings", "scan-sessions"];
const BANNED_HUB_CMD_RE = new RegExp(
  `\\b(?:run)?[Hh]ubCmd\\s*\\(\\s*\\[\\s*["'\`]usage["'\`]\\s*,\\s*["'\`](?:${BANNED_USAGE_ANALYTICS_VERBS.join("|")})["'\`]`,
);

/** Every `.ts`/`.tsx` file directly under a directory, recursively. */
function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...listSourceFiles(full));
      continue;
    }
    if (entry.endsWith(".ts") || entry.endsWith(".tsx")) out.push(full);
  }
  return out;
}

const IMPORT_SPEC_RE = /(?:import|export)[^;]*?from\s+["']([^"']+)["']/g;

/** Local (non-package) module specifiers a file imports from — relative
 *  (`./x`) or `@/`-aliased (resolved to `src/`). External package imports
 *  (no leading `.` or `@/`) are not followed. */
function localImportSpecs(fileText: string): string[] {
  const specs: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = IMPORT_SPEC_RE.exec(fileText))) {
    const spec = m[1];
    if (spec.startsWith(".") || spec.startsWith("@/")) specs.push(spec);
  }
  return specs;
}

function resolveLocalSpec(fromFile: string, spec: string): string | null {
  const base = spec.startsWith("@/") ? join(SRC, spec.slice(2)) : resolve(dirname(fromFile), spec);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ];
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      /* not this candidate — try the next */
    }
  }
  return null;
}

function readText(file: string): string {
  return readFileSync(file, "utf-8");
}

describe("the navigator never imports or calls the usage-analytics hooks (G22)", () => {
  const level0 = [
    ...listSourceFiles(NAV_DIR),
    join(SRC, "components", "NavPanel.tsx"),
    join(SRC, "lib", "navInsights.ts"),
  ];

  // One import level: every LOCAL module any level-0 file imports.
  const level1 = new Set<string>();
  for (const file of level0) {
    for (const spec of localImportSpecs(readText(file))) {
      const resolved = resolveLocalSpec(file, spec);
      if (resolved) level1.add(resolved);
    }
  }

  it("scans at least the navigator body files (sanity check on the scan itself)", () => {
    expect(level0.length).toBeGreaterThan(0);
    expect(level0.some((f) => f.endsWith("NavPanel.tsx"))).toBe(true);
  });

  it.each(level0)("navigator file %s carries no usage-analytics reference", (file) => {
    const text = readText(file);
    expect(BANNED_IDENTIFIER_RE.test(text), file).toBe(false);
    expect(BANNED_HUB_CMD_RE.test(text), file).toBe(false);
  });

  it("every module a navigator file imports (one level) also carries no usage-analytics reference", () => {
    const offenders: string[] = [];
    for (const file of level1) {
      const text = readText(file);
      if (BANNED_IDENTIFIER_RE.test(text) || BANNED_HUB_CMD_RE.test(text)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
