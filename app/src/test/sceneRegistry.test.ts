import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { SCENE_FLAGS, KNOWN_UNUSED, type SceneFlagName } from "@/mocks/scenes";

// ─── The scene-flag registry's own honesty checks ──────────────────────────
//
// `app/src/mocks/scenes.ts` is the ONLY file allowed to read the browser's
// query string; every mock reads a scene flag through its typed
// `sceneFlag`/`sceneValue`. That typing catches a typo or an undeclared flag
// at compile time. This file catches the two things TypeScript cannot:
//
//   1. No mock file reopens the raw channel `scenes.ts` closed.
//   2. Every declared flag actually reaches a journey or a visual scene, or
//      names an honest reason it does not (`KNOWN_UNUSED`) — a flag a
//      test never sets can silently stop mattering without a failure.
//      (`KNOWN_NO_FIDELITY_ROW`, the sibling map in `scenes.ts`, excuses
//      `sceneFidelity.test.ts`'s row requirement instead — a flag can need
//      one, the other, both, or neither.)
//   3. Every flag a journey or a visual scene DOES set is declared here, or
//      is a product route param the app reads for its own routing (not a
//      mock scene) — an undeclared flag a spec sets is either a typo or a
//      registry gap, either way worth a name and a file.

const APP_ROOT = process.cwd(); // vitest runs from `app/`

/**
 * Route parameters that product screens/hooks read via `useSearchParams()`
 * or `new URLSearchParams(location.search)` — never through the mock's
 * `sceneFlag`/`sceneValue`. An e2e spec that sets one of these is deep-
 * linking into the app's own routing, not opting the mock into a scene.
 * Verified by grepping `useSearchParams|searchParams.get|location.search` in
 * `app/src` outside `mocks/`.
 */
const APP_ROUTE_PARAMS: Record<string, string> = {
  add: "src/screens/Sources.tsx",
  addBundle: "src/screens/SkillLibrary.tsx",
  addProject: "src/screens/SkillLibrary.tsx",
  agent: "src/components/subagents/SubagentManager.tsx",
  class: "src/hooks/useLibraryListState.ts",
  classScope: "src/hooks/useLibraryListState.ts",
  day: "src/screens/usage/useUsagePeriodSelection.ts",
  focus: "src/components/nav/ElsewhereBody.tsx",
  harness: "src/screens/usage/UsageSessionRoute.tsx",
  kind: "src/hooks/useLibraryListState.ts",
  mcp: "src/screens/SkillLibrary.tsx",
  mode: "src/hooks/useLibraryListState.ts",
  month: "src/screens/usage/useUsagePeriodSelection.ts",
  name: "src/components/snippets/SnippetCreateForm.tsx",
  new: "src/screens/SkillLibrary.tsx",
  now: "src/screens/BackupScreen.tsx",
  project: "src/screens/RecoveryWizard.tsx",
  q: "src/hooks/useLibraryListState.ts",
  rename: "src/screens/library/BundleName.tsx",
  review: "src/screens/project/ProjectReviewProvider.tsx",
  run: "src/screens/usage/UsageSessionRoute.tsx",
  source: "src/hooks/useLibraryListState.ts",
  stage: "src/screens/RecoveryWizard.tsx",
  tab: "src/screens/ProjectWorkspace.tsx",
  trigger: "src/hooks/useLibraryListState.ts",
  week: "src/screens/usage/useUsagePeriodSelection.ts",
};

function listFiles(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...listFiles(full, exts));
    else if (exts.includes(extname(entry))) out.push(full);
  }
  return out;
}

function stripComments(src: string): string {
  // Block comments first (so a `//` inside one is not mistaken for a line
  // comment), then line comments. Naive — does not special-case `//` inside
  // a string literal — but nothing under `app/e2e`/`app/visual` puts a raw
  // `//` before a scene-flag string, so this holds today.
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

const MOCKS_DIR = join(APP_ROOT, "src/mocks");
const E2E_DIR = join(APP_ROOT, "e2e");
const VISUAL_DIR = join(APP_ROOT, "visual");

const mockFiles = listFiles(MOCKS_DIR, [".ts", ".tsx"]);
const e2eFiles = listFiles(E2E_DIR, [".ts"]);
const visualFiles = readdirSync(VISUAL_DIR)
  .filter((f) => f.endsWith(".mjs"))
  .map((f) => join(VISUAL_DIR, f));
const sceneUsageFiles = [...e2eFiles, ...visualFiles];

const flagNames = Object.keys(SCENE_FLAGS) as SceneFlagName[];

// ─── Rule 1: no raw reads outside scenes.ts ────────────────────────────────

// Exactly `src/mocks/scenes.ts` is exempt — not any file whose name merely
// ends in "scenes.ts" (a `visualScenes.ts` beside it must still be checked).
const SCENES_FILE = join(MOCKS_DIR, "scenes.ts");

// Every raw route to the query string a mock could take instead of
// `sceneFlag`/`sceneValue`: `URLSearchParams`, a `URL`'s `searchParams`,
// `location.search`/`location.href` (dot, `?.` or bracket access), `document.URL`.
const RAW_QUERY_READ_RE =
  /URLSearchParams|searchParams|\blocation\s*(?:\??\.\s*(?:search|href)\b|(?:\?\.)?\[\s*(["'`])(?:search|href)\1\s*\])|\bdocument\s*\??\.\s*URL\b/;

describe("sceneRegistry: rule 1 — scenes.ts owns the query string", () => {
  it("no mock file other than scenes.ts reads URLSearchParams, searchParams, location.search/href or document.URL", () => {
    const offenders: string[] = [];
    for (const file of mockFiles) {
      if (file === SCENES_FILE) continue;
      const content = readFileSync(file, "utf-8");
      if (RAW_QUERY_READ_RE.test(content)) {
        offenders.push(file.slice(APP_ROOT.length + 1));
      }
    }
    expect(offenders, `raw query-string reads outside scenes.ts: ${offenders.join(", ")}`).toEqual([]);
  });
});

// ─── Discover flag-shaped usage in app/e2e/** and app/visual/*.mjs ────────
//
// Usage means one of:
//   - a literal `?name=` / `&name=` inside a `/?...#/route`-shaped string
//     (covers both a direct `page.goto("/?flag=1#/...")` and a `capture.mjs`
//     `path: "/?flag=1#/...",` scene entry);
//   - a `scene(route, { name: ... })` fixture call naming `name` as a key;
//   - for `ipcDelay`, the documented `__IPC_DELAY_MS` window alias.

interface Usage {
  file: string;
  names: Set<string>;
}

const SCENE_URL_RE = /\?([^"'`]*?)#\//g;
const SCENE_CALL_RE = /\bscene\(\s*[^,]+,\s*\{([^}]*)\}\s*\)/g;
const OBJECT_KEY_RE = /["']?([a-zA-Z_][a-zA-Z0-9_]*)["']?\s*:/g;
// A standalone `'name=1'` string token (e.g. `['bootstrap=1', 'setup']` in
// `feedback.journey.spec.ts`), later interpolated into a `/?${flag}#/` URL.
// The quote must open immediately before the name and close right after a
// digit value, so this does not match a `text=...` Playwright locator, an
// HTML `width=device-width` attribute, or a `body=@file` CLI flag — none of
// those are scene-flag tuples, and none end the string in bare digits.
const QUOTED_PAIR_RE = /(['"`])([a-zA-Z_][a-zA-Z0-9_]*)=\d+\1/g;

function namesUsedIn(content: string): Set<string> {
  const names = new Set<string>();
  const stripped = stripComments(content);

  let m: RegExpExecArray | null;
  SCENE_URL_RE.lastIndex = 0;
  while ((m = SCENE_URL_RE.exec(stripped))) {
    for (const part of m[1].split("&")) {
      const eq = part.indexOf("=");
      if (eq <= 0) continue;
      const name = part.slice(0, eq);
      if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) names.add(name);
    }
  }

  SCENE_CALL_RE.lastIndex = 0;
  while ((m = SCENE_CALL_RE.exec(stripped))) {
    OBJECT_KEY_RE.lastIndex = 0;
    let km: RegExpExecArray | null;
    while ((km = OBJECT_KEY_RE.exec(m[1]))) names.add(km[1]);
  }

  QUOTED_PAIR_RE.lastIndex = 0;
  while ((m = QUOTED_PAIR_RE.exec(stripped))) names.add(m[2]);

  return names;
}

const usages: Usage[] = sceneUsageFiles.map((file) => ({
  file: file.slice(APP_ROOT.length + 1),
  names: namesUsedIn(readFileSync(file, "utf-8")),
}));

function usesFlag(name: SceneFlagName): boolean {
  if (name === "ipcDelay") {
    if (usages.some((u) => u.names.has("ipcDelay"))) return true;
    return sceneUsageFiles.some((file) => readFileSync(file, "utf-8").includes("__IPC_DELAY_MS"));
  }
  return usages.some((u) => u.names.has(name));
}

// ─── Rule 2: every declared flag is used, or has an honest reason ─────────

describe("sceneRegistry: rule 2 — every declared flag is exercised or excused", () => {
  it.each(flagNames)("%s is used by an e2e spec or a visual scene, or is in KNOWN_UNUSED", (name) => {
    const used = usesFlag(name);
    const excused = typeof KNOWN_UNUSED[name] === "string" && KNOWN_UNUSED[name].trim().length > 0;
    expect(
      used || excused,
      `"${name}" is read by no e2e spec or visual scene and has no KNOWN_UNUSED reason`,
    ).toBe(true);
  });

  it("every KNOWN_UNUSED key names a declared flag", () => {
    const declared = new Set(flagNames);
    const unknown = Object.keys(KNOWN_UNUSED).filter((k) => !declared.has(k as SceneFlagName));
    expect(unknown, `KNOWN_UNUSED names undeclared flags: ${unknown.join(", ")}`).toEqual([]);
  });
});

// ─── Rule 3: every flag/param a spec or scene sets is declared or allowed ──

describe("sceneRegistry: rule 3 — no undeclared flag in an e2e spec or a visual scene", () => {
  const declared = new Set<string>(flagNames);
  const routeParams = new Set(Object.keys(APP_ROUTE_PARAMS));

  for (const usage of usages) {
    const unknown = [...usage.names].filter((n) => !declared.has(n) && !routeParams.has(n));
    it(`${usage.file} sets only declared flags or APP_ROUTE_PARAMS`, () => {
      expect(
        unknown,
        `${usage.file} sets undeclared name(s): ${unknown.join(", ")} — declare in SCENE_FLAGS ` +
          `(app/src/mocks/scenes.ts) or add to APP_ROUTE_PARAMS with the product file that reads it`,
      ).toEqual([]);
    });
  }
});
