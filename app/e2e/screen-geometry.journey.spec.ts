import { test, expect, WIDTH, type Page } from "./fixtures";
import { gotoReady, waitForPaint } from "./helpers";
import { SCENES } from "../visual/capture.mjs";

// ─── Screen-geometry gate ───────────────────────────────────────────────────
// Enforces the two layout corrections that kept recurring across seven
// sessions last week (transcript cluster F, docs/changes/DESIGN-LEARN-SKILLS/PLAN.md
// W2.1): a screen's content column drifting off `--pad-screen-y` below the
// header band when a screen skips the shared `.screen-pad`/`.workspace-main`
// pattern, and a side panel (`.editor-side`/`.workspace-side`) getting pushed
// down by a stray strip instead of running flush from the header band's
// bottom edge. The three invariants below are written in prose in the
// `skill-tree-design-language` skill's "Screen geometry invariants" section
// (SKILL.md) — this spec is the standing enforcement, run as part of the e2e
// gate (`npx playwright test e2e/screen-geometry.journey.spec.ts`).
//
// Origin: `~/.skill-hub/_hub-backups/unified-headers-corpus/measure-headers.mjs`,
// a one-off Node script from the unified-headers unit that booted Vite,
// walked a route list, and measured `.main-header` boxes + text contrast.
// This spec replaces it inside the real test suite: it walks `capture.mjs`'s
// `SCENES` (the same list the visual gallery and PR-proof screenshots use,
// so a route only needs registering once) instead of a hand-kept route list,
// and adds the side-panel and content-offset checks measure-headers.mjs never
// had.
//
// The real geometry, measured against every scene (see
// `docs/changes/DESIGN-LEARN-SKILLS/measure-geometry.mjs` + `geometry-measurements.md`,
// committed with this unit for the full table this spec was derived from), is FLUSH, not
// gapped: `.screen-pad` / `.workspace-main` / a document editor's shell sit
// with their own top edge exactly at the header band's bottom edge, and it is
// the box's OWN `padding-top` (already `--pad-screen-y` / `--pad-doc-top` by
// definition in `tokens.css`) that produces the visual inset — never a
// margin or gap between the band and the box. That is a stronger, more
// literal reading of "the content column starts `--pad-screen-y` below the
// header band" than a naive "box.y − band.bottom == 16" check would be: a
// gap-based check fails on ~all 146 headered scenes (the real pattern is
// padding, not a gap), which is exactly the "rule as stated is wrong, stop
// and report" case PLAN.md W2.1.3 describes — so the check here is flush
// alignment, plus a direct padding-top check for the two classes tokens.css
// names by name (`.screen-pad`, `.workspace-main`).
//
// Adding a scene: nothing to do here. Every scene in `capture.mjs`'s `SCENES`
// that has no `prep` step, or whose id contains "editor", is picked up
// automatically (see SELECTED_SCENES below) — register it in `capture.mjs`
// once (already required by the design-language skill's invariant 4) and it
// is covered here for free, UNLESS its own `prep` turns out to hang (see
// SLOW_SCENES just below) — a scene added there needs its reason logged the
// same way.
//
// Shape: one Playwright test for each scene (REPRESENTATIVES, one member for
// each distinct `path`+`init` pair among SELECTED_SCENES, preferring a member
// with no `prep`, except every id in DELIBERATE_KEEP_IDS which always gets
// its own representative even when it shares a group with another), run at
// 1440px (105), plus a narrower set at 1024/768/520px (one representative
// for each route template — the hash route with its dynamic segments
// replaced and `?tab=` kept — 75), plus four fixed `appmain` container rows:
// 184 tests total. `test.describe.configure({ mode: "parallel" })` and no
// `beforeAll`/`afterAll` make each scene its own shard group (`ci_scope.py`
// still balances by test count, but a group of one test each lets the count
// split roughly balance wall time too — see the B3 plan). Each scene test
// does its own `setViewportSize` → `init` → `gotoReady` → `waitFor` →
// `waitForPaint` → `prep` → `waitForPaint` → single DOM read, then runs the
// four rules against that one reading as `expect.soft` checks inside
// `test.step`s, so one rule failing does not hide another. A scene that never
// renders its `waitFor` locator fails outright — it can never pass by having
// nothing to measure. Below 1440px, a narrow-width test also re-measures the
// same scene at 1440px first and fails outright if that row found a content
// box and this width's row did not (NARROW_ATTACHED_READY_MARKERS below
// loosens readiness for a few markers that go off-canvas on purpose at
// narrow widths; this is the check that a real `display:none` regression
// still cannot hide behind that loosening).
//
// Cost: this replaces one five-test, single-worker-serial sweep (206 to
// 260s, all on one shard) with about 184 one-scene tests the shard splitter
// can spread across the matrix. Skip the whole surface for an unrelated run
// with `npx playwright test --grep-invert "screen geometry"`.

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Scene {
  id: string;
  label: string;
  path: string;
  waitFor?: string;
  waitForState?: "attached" | "visible";
  init?: (page: Page) => Promise<void>;
  prep?: (page: Page) => Promise<void>;
}

const ALL_SCENES = SCENES as Scene[];

// Editor scenes whose `prep` waits on a chip or card that never becomes
// actionable under this driver, so each one burns its full timeout (10 to
// 91 s measured on 2026-09-03). Skipped here; the visual gallery still
// shoots them. Extend this set the same way and say why.
const SLOW_SCENES = new Set([
  "skill-editor-diff", // clicks the "Diff" mode chip; never becomes actionable — 31s
  "skill-editor-connections", // chains 3 such clicks — 91s
  "harness-doc-editor-conflict", // clicks a SHARED WITH checkbox row — 10s
  "subagents-editor-unsaved", // clicks a sub-agent card, then types — 39s
  "subagents-editor-error", // clicks a sub-agent card, then renames — 39s
  "subagents-editor-advanced", // clicks a sub-agent card, then "Advanced" — 39s
]);

// /styleguide exists only when `import.meta.env.DEV` is true; the prebuilt
// preview bundle CI serves (ST_E2E_PREVIEW) has no such route.
const DEV_ONLY_SCENES = new Set(process.env.ST_E2E_PREVIEW ? ["styleguide"] : []);

// Keep the Usage scroll and the on-demand project library in the geometry
// sweep — both explicitly, not just "keep one member of the group": see
// DELIBERATE_KEEP_IDS below, which stops collapseToRepresentatives from
// silently dropping one of them.
const DELIBERATE_KEEP_IDS = new Set(["project-usage-rich", "project-available-cost"]);

const SELECTED_SCENES = ALL_SCENES.filter(
  (s) =>
    (!s.prep || /editor/i.test(s.id) || DELIBERATE_KEEP_IDS.has(s.id)) &&
    !SLOW_SCENES.has(s.id) &&
    !DEV_ONLY_SCENES.has(s.id),
);

// One test per scene needs one scene for each distinct (path, init) pair, not
// one for every prep variant of the same underlying screen: a prep step
// drives the SAME page to a further state (split view, preview, an added
// file…), which is not new header/panel/content geometry. Prefer the member
// with no `prep` (the plainest render of that path+init); fall back to the
// group's first member when every member has one — 21 of the 104 CI groups
// are prep-only, so those keep one prepped state each rather than being
// dropped. This intentionally drops the OTHER prepped states in a group
// (split, preview, files-multi, ref-hover, add-file, …) from this sweep; the
// visual gallery still shoots every one of them (PLAN.md B3 risk 2).
//
// `project-usage-rich` and `project-available-cost` share both path and
// (absent) init, and both have `prep` — the ordinary rule above would keep
// only one of them, dropping exactly the Add-skills-open state
// DELIBERATE_KEEP_IDS exists to keep. Every scene DELIBERATE_KEEP_IDS names
// gets its own representative regardless of what else is in its group; this
// is the smaller of the two ways to fix that (the alternative — keying the
// whole collapse on path+init+prep identity wherever every group member has
// `prep` — would also re-split the other 20 all-prep groups that collapse
// correctly today, none of which need it).
function representativeKey(s: Scene): string {
  return `${s.path}|${s.init ? s.init.toString() : ""}`;
}

function collapseToRepresentatives(scenes: Scene[]): Scene[] {
  const groups = new Map<string, Scene[]>();
  for (const s of scenes) {
    const key = representativeKey(s);
    const group = groups.get(key);
    if (group) group.push(s);
    else groups.set(key, [s]);
  }
  const reps: Scene[] = [];
  for (const group of groups.values()) {
    const forcedKeep = group.filter((s) => DELIBERATE_KEEP_IDS.has(s.id));
    if (forcedKeep.length > 0) {
      reps.push(...forcedKeep);
      const rest = group.filter((s) => !DELIBERATE_KEEP_IDS.has(s.id));
      if (rest.length > 0) reps.push(rest.find((s) => !s.prep) ?? rest[0]);
      continue;
    }
    reps.push(group.find((s) => !s.prep) ?? group[0]);
  }
  return reps;
}

const REPRESENTATIVES = collapseToRepresentatives(SELECTED_SCENES);

// The hash route a representative renders, with dynamic segments replaced by
// `:name` and only the `?tab=` query kept (every other scene flag is boot
// config, not part of "which screen"). Copied from the `<Route path=…>` list
// in `App.tsx`: matching against the real route table, not a guess at which
// segments look dynamic, is what keeps this in sync with the app.
const ROUTE_PATTERNS = [
  "/",
  "/skill/:name",
  "/skill/:name/agent/:agent",
  "/project/:name",
  "/bundle/:name",
  "/sources",
  "/permissions",
  "/harnesses",
  "/harness/:id",
  "/harness/:id/doc",
  "/snippets",
  "/snippet/:name",
  "/hooks",
  "/hook/:name",
  "/remotes",
  "/remote/:id",
  "/cloud/:id",
  "/usage",
  "/usage/project/:name",
  "/usage/session/:id",
  "/usage/pinned",
  "/backup",
  "/recovery",
  // Dev-only: App.tsx mounts it outside the preview build, and the local
  // (non-CI) run selects its scene.
  "/styleguide",
];

function routeTemplate(path: string): string {
  const hash = path.split("#")[1] ?? "";
  const [route, query = ""] = hash.split("?");
  const segments = route.split("/");
  for (const pattern of ROUTE_PATTERNS) {
    const patternSegments = pattern.split("/");
    if (patternSegments.length !== segments.length) continue;
    if (patternSegments.every((seg, i) => seg.startsWith(":") || seg === segments[i])) {
      const tab = query.split("&").find((p) => p.startsWith("tab="));
      return pattern + (tab ? `?${tab}` : "");
    }
  }
  throw new Error(`screen-geometry: no route template matches ${path} — add it to ROUTE_PATTERNS`);
}

// One representative for each route template, for the narrow-width rows
// (1024/768/520). Picks the first REPRESENTATIVES member for that template,
// in the same order capture.mjs registers scenes.
function oneRepresentativePerTemplate(reps: Scene[]): Scene[] {
  const byTemplate = new Map<string, Scene>();
  for (const s of reps) {
    const key = routeTemplate(s.path);
    if (!byTemplate.has(key)) byTemplate.set(key, s);
  }
  return [...byTemplate.values()];
}

const TEMPLATE_REPRESENTATIVES = oneRepresentativePerTemplate(REPRESENTATIVES);
const NARROW_WIDTHS = [1024, 768, 520] as const;

// A scene the rightmost-primary-action rule must find at least one primary
// header action on, so the rule is provably exercised (the old sweep-wide
// `checked > 0` guard has no per-test equivalent once each scene is its own
// test — TESTS.md section 3/PLAN.md B3 step 3).
const PRIMARY_SCENES = new Set(["usage-success"]);

// ─── Known deviations ───────────────────────────────────────────────────────
// A scene that breaks a rule TODAY is not fixed by this PR (scope: PLAN.md
// W2.1.3). Keyed `${id}@${width}`, because a narrow width can find a real
// deviation a wide one does not: the rule test skips the failure for a
// listed scene+width, and fails instead when the scene stops deviating, so a
// fix must delete its entry here. No product code changes for these.
type GeometryRule = "content-flush" | "side-panel";
const KNOWN_DEVIATIONS: Record<string, { rule: GeometryRule; reason: string }> = {
  // Below ~1280px `workspace-grid`'s ResizableSplit (project-loadout-overview,
  // fixedPane="right", defaultRightPx 320) cannot dock its side pane beside
  // the min main width, so — unlike the perm-layout split, which collapses
  // to an overlay behind an "Open Tools" trigger — this one stacks its pane
  // content ahead of `.workspace-main` in flow, pushing it well below the
  // header band. First measured 2026-09-25: off≈257px at 1024px, ≈257px at
  // 768px, ≈279px at 520px.
  "project-loadout@1024": { rule: "content-flush", reason: "workspace-grid's ResizableSplit stacks its pane above .workspace-main below ~1280px" },
  "project-loadout@768": { rule: "content-flush", reason: "workspace-grid's ResizableSplit stacks its pane above .workspace-main below ~1280px" },
  "project-loadout@520": { rule: "content-flush", reason: "workspace-grid's ResizableSplit stacks its pane above .workspace-main below ~1280px" },
};
function knownDeviation(id: string, width: number, rule: GeometryRule): string | null {
  const d = KNOWN_DEVIATIONS[`${id}@${width}`];
  return d && d.rule === rule ? d.reason : null;
}

// The automatic `allowErrors` fixture (app/e2e/fixtures.ts) now applies to
// every scene test here — the old sweep bypassed it by using
// `browser.newContext()` directly instead of the `page`/`allowErrors`
// fixtures. A scene that models an error state (python-error, screen-error,
// usage-access-error, usage-ccusage-failure, …) and logs a browser console
// error or `pageerror` on purpose needs an entry here instead of failing on
// an expected error; list the pattern and the reason. The first local run
// (2026-09-25, all 183 tests, including the four error-state scenes above)
// found none of them logging a `console.error`/`pageerror` today, so this
// starts empty — add an entry the day a scene starts logging one.
const SCENE_ALLOWED_ERRORS: Record<string, { re: RegExp; reason: string }[]> = {};

interface SidePanelRect {
  selector: ".editor-side" | ".workspace-side";
  rect: Rect;
}

interface ContentRect {
  selector: string;
  rect: Rect;
  paddingTop: number;
}

interface Measurement {
  header: Rect | null;
  headerActions: { primary: boolean; rect: Rect }[];
  row2: { selector: ".main-subheader" | ".doc-editor-bar" | ".area-strip"; rect: Rect } | null;
  sidePanels: SidePanelRect[];
  content: ContentRect | null;
  headerRow1Px: number | null;
  padScreenYPx: number | null;
}

// Runs inside the page via `page.evaluate` — must be self-contained (no
// closures over outer scope). Mirrors `docs/changes/DESIGN-LEARN-SKILLS/measure-geometry.mjs`,
// which this spec's assertions were derived from; keep the two in sync if the
// shell's markup changes.
function measureGeometry(): Measurement {
  function rect(el: Element | null): Rect | null {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: +r.x.toFixed(2), y: +r.y.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2) };
  }
  function isVisible(el: Element | null): boolean {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const cs = getComputedStyle(el);
    return cs.display !== "none" && cs.visibility !== "hidden";
  }

  // Rects are viewport-relative; a screen that scrolled during prep (an
  // autofocused control far down a tall page) would read a false offset.
  window.scrollTo(0, 0);
  for (const el of Array.from(document.querySelectorAll("*"))) {
    if (el.scrollTop > 0) el.scrollTop = 0;
  }

  const header = document.querySelector(".main-header");
  const headerVisible = !!header && isVisible(header);

  let row2El: Element | null = null;
  let row2Selector: ".main-subheader" | ".doc-editor-bar" | ".area-strip" | null = null;
  const subheader = document.querySelector(".main-subheader");
  const editorBar = document.querySelector(".doc-editor-bar");
  // Project overview and Usage share a full-width navigation band.
  // Both content and side panels begin below it.
  const projectNavigator = document.querySelector(".project-usage-body, .project-loadout-navigation")
    ? document.querySelector(".area-strip")
    : null;
  if (projectNavigator && isVisible(projectNavigator)) {
    row2El = projectNavigator;
    row2Selector = ".area-strip";
  } else if (subheader && isVisible(subheader)) {
    row2El = subheader;
    row2Selector = ".main-subheader";
  } else if (editorBar && isVisible(editorBar)) {
    row2El = editorBar;
    row2Selector = ".doc-editor-bar";
  }

  const sidePanels: SidePanelRect[] = Array.from(
    document.querySelectorAll(".editor-side, .workspace-side"),
  )
    .filter((el) => isVisible(el))
    .map((el) => ({
      selector: (el.classList.contains("editor-side") ? ".editor-side" : ".workspace-side") as
        | ".editor-side"
        | ".workspace-side",
      rect: rect(el) as Rect,
    }));

  let contentEl: Element | null = null;
  let contentSelector: string | null = null;
  // `.code-area pre` as a descendant selector can match a fenced-code-block
  // `<pre>` nested deep inside rendered markdown instead of the editor body's
  // own top box; `> pre` (direct child) never accidentally matches that —
  // neither CodeMirror (edit mode) nor the diff view render a direct `<pre>`
  // child of `.code-area` today, so it falls through to the "otherwise"
  // fallback below, same as every other document-editor scene.
  for (const sel of [".workspace-main", ".screen-pad", ".code-area > pre"]) {
    const el = document.querySelector(sel);
    if (el && isVisible(el)) {
      contentEl = el;
      contentSelector = sel;
      break;
    }
  }
  if (!contentEl && headerVisible && header) {
    // "The first element child of .app-main after the header" only holds
    // literally when `.main-header` is a direct child of `.app-main`. Two
    // real screens break that: SkillEditor wraps its whole screen in a
    // `style="display:contents"` div (the page-lock a11y carrier), which
    // reports an all-zero `getBoundingClientRect()` in Chromium; and
    // PermissionsEditor renders its ScreenHeader AS A CHILD of its own
    // `.permissions-section` wrapper, so that wrapper — not a sibling after
    // it — is `.app-main`'s first non-header child. Walking forward from
    // `.main-header`'s own DOM position (its next element sibling, whatever
    // real box that lives in) is robust to both.
    let sib: Element | null = header.nextElementSibling;
    if (sib && sib.classList.contains("main-subheader")) sib = sib.nextElementSibling;
    while (sib && !isVisible(sib)) sib = sib.nextElementSibling;
    if (sib) {
      contentEl = sib;
      contentSelector = `header-next-sibling:.${sib.className.split(" ")[0] || sib.tagName.toLowerCase()}`;
    }
  }
  const contentPaddingTop = contentEl ? parseFloat(getComputedStyle(contentEl).paddingTop) : null;

  const appMain = document.querySelector(".app-main");
  const appMainCs = appMain ? getComputedStyle(appMain) : null;

  return {
    header: headerVisible ? rect(header) : null,
    headerActions: Array.from(document.querySelectorAll(".main-header-right button"))
      .filter(isVisible)
      .map((el) => ({ primary: el.classList.contains("btn-primary"), rect: rect(el)! })),
    row2: row2El && row2Selector ? { selector: row2Selector, rect: rect(row2El) as Rect } : null,
    sidePanels,
    content:
      contentEl && contentSelector
        ? { selector: contentSelector, rect: rect(contentEl) as Rect, paddingTop: contentPaddingTop as number }
        : null,
    headerRow1Px: appMainCs ? parseFloat(appMainCs.getPropertyValue("--header-row-1")) : null,
    padScreenYPx: appMainCs ? parseFloat(appMainCs.getPropertyValue("--pad-screen-y")) : null,
  };
}

const SCENE_WAIT_TIMEOUT_MS = 8000;

// Readiness markers confirmed (by the narrow-width sweep runs of
// 2026-09-25) to render off-canvas or CSS-hidden below the 820px shell
// breakpoint ON PURPOSE — a NavPanel section head, the StatusBar brand
// segment, and Usage's "Scanning agent usage" loading text sit inside
// chrome the shell collapses at these widths. `scene.waitFor` is written
// for capture.mjs's default (1440) shot; capture.mjs itself only warns and
// continues on exactly these markers going missing at a narrow width (see
// its own comment: "an off-canvas drawer never becomes visible"). Loosen
// `visible` to `attached` ONLY for a marker listed here — every other
// scene's waitFor still requires `visible`, so a real `display:none`
// regression still fails readiness outright, and the no-content-regression
// check below catches the rest (a marker that is `attached` but the real
// content never rendering).
const NARROW_ATTACHED_READY_MARKERS = new Set([".side-head", "text=SKILL TREE", "text=Scanning agent usage"]);

async function measureScene(page: Page, scene: Scene, width: number): Promise<Measurement> {
  await page.setViewportSize({ width, height: 900 });
  if (scene.init) await scene.init(page);
  await gotoReady(page, scene.path, { waitUntil: "load" });
  await page.addStyleTag({
    content:
      "*,*::before,*::after{transition:none!important;animation:none!important;caret-color:transparent!important;scroll-behavior:auto!important}",
  });
  if (scene.waitFor) {
    // A screen that never rendered still has a header and a wrapper, so it
    // would pass every rule; fail the whole test on the missing locator
    // instead of recording a silent non-measurement.
    const requestedState = scene.waitForState ?? "visible";
    const state =
      width < WIDTH.wide && requestedState === "visible" && NARROW_ATTACHED_READY_MARKERS.has(scene.waitFor)
        ? "attached"
        : requestedState;
    await page.locator(scene.waitFor).first().waitFor({ state, timeout: SCENE_WAIT_TIMEOUT_MS });
  }
  // Wait for a painted frame instead of a fixed sleep: a scene prepped
  // mid-render either fails a rule or passes on a partially laid-out box
  // (TA-1-92aa).
  await waitForPaint(page);
  if (scene.prep) await scene.prep(page);
  await waitForPaint(page);
  return page.evaluate(measureGeometry);
}

function assertPrimaryRightmost(id: string, m: Measurement): void {
  const failures: string[] = [];
  let checked = 0;
  for (const primary of m.headerActions.filter((action) => action.primary)) {
    checked++;
    if (m.headerActions.some((action) => action !== primary && action.rect.x + action.rect.w > primary.rect.x + 1)) {
      failures.push(`${id}: another header control follows or overlaps the primary action`);
    }
  }
  if (PRIMARY_SCENES.has(id)) {
    expect.soft(checked, `${id}: expected a primary header action`).toBeGreaterThan(0);
  }
  expect.soft(failures).toEqual([]);
}

function assertHeaderBandHeight(id: string, m: Measurement): void {
  if (!m.header || m.headerRow1Px === null) return; // no header (bootstrap gate, PythonError) — not applicable
  const failures: string[] = [];
  if (Math.abs(m.header.h - m.headerRow1Px) > 1) {
    failures.push(`${id}: header.h=${m.header.h} != --header-row-1=${m.headerRow1Px}`);
  }
  expect.soft(failures).toEqual([]);
}

function assertSidePanelFlush(id: string, width: number, m: Measurement): void {
  if (!m.header || m.sidePanels.length === 0) return;
  const failures: string[] = [];
  const headerBottom = m.row2?.selector === ".area-strip" ? m.row2.rect.y + m.row2.rect.h : m.header.y + m.header.h;
  const known = knownDeviation(id, width, "side-panel");
  let stillDeviates = false;
  for (const panel of m.sidePanels) {
    const off = +(panel.rect.y - headerBottom).toFixed(2);
    if (Math.abs(off) > 1) {
      stillDeviates = true;
      if (!known) {
        failures.push(`${id}: ${panel.selector} top=${panel.rect.y} header-bottom=${headerBottom} off=${off}`);
      }
    }
  }
  if (known && !stillDeviates) {
    failures.push(
      `${id}: KNOWN_DEVIATIONS ("${known}") says the side panel should still be off-flush, but it now measures flush — remove this entry`,
    );
  }
  expect.soft(failures).toEqual([]);
}

function assertContentFlush(id: string, width: number, m: Measurement): void {
  if (!m.header || !m.content) return;
  const failures: string[] = [];
  const headerBottom = m.header.y + m.header.h;
  const useRow2 = m.row2?.selector === ".main-subheader" || m.row2?.selector === ".area-strip";
  const ref = useRow2 && m.row2 ? m.row2.rect.y + m.row2.rect.h : headerBottom;
  const off = +(m.content.rect.y - ref).toFixed(2);
  const known = knownDeviation(id, width, "content-flush");
  if (Math.abs(off) > 1) {
    if (!known) {
      failures.push(`${id}: content(${m.content.selector}).y=${m.content.rect.y} band-bottom=${ref} off=${off}`);
    }
  } else if (known) {
    failures.push(
      `${id}: KNOWN_DEVIATIONS ("${known}") says the content box should still deviate, but it now measures flush (off=${off}) — remove this entry`,
    );
  }
  // Bonus, narrower check for the two classes tokens.css names directly:
  // their OWN padding-top literally equals --pad-screen-y (16px) — this is
  // the invariant's other half, verifiable only where the sanctioned wrapper
  // class is the content box itself.
  if (
    (m.content.selector === ".workspace-main" || m.content.selector === ".screen-pad") &&
    m.padScreenYPx !== null &&
    Math.abs(m.content.paddingTop - m.padScreenYPx) > 1
  ) {
    failures.push(`${id}: ${m.content.selector} padding-top=${m.content.paddingTop} != --pad-screen-y=${m.padScreenYPx}`);
  }
  expect.soft(failures).toEqual([]);
}

async function assertGeometry(id: string, width: number, m: Measurement): Promise<void> {
  await test.step("primary action is the rightmost header control", () => assertPrimaryRightmost(id, m));
  await test.step("header band height equals --header-row-1", () => assertHeaderBandHeight(id, m));
  await test.step("side panel sits flush with the header band", () => assertSidePanelFlush(id, width, m));
  await test.step("first content box sits flush against the header/subheader band", () =>
    assertContentFlush(id, width, m));
}

function allowSceneErrors(id: string, allowErrors: (re: RegExp, reason: string) => void): void {
  for (const entry of SCENE_ALLOWED_ERRORS[id] ?? []) allowErrors(entry.re, entry.reason);
}

test.describe("screen geometry", () => {
  test.describe.configure({ mode: "parallel" });

  for (const rep of REPRESENTATIVES) {
    test(`${rep.id} at ${WIDTH.wide}px: header band, primary action, side panel and content box`, async ({
      page,
      allowErrors,
    }) => {
      allowSceneErrors(rep.id, allowErrors);
      const m = await measureScene(page, rep, WIDTH.wide);
      await assertGeometry(rep.id, WIDTH.wide, m);
    });
  }

  for (const width of NARROW_WIDTHS) {
    for (const rep of TEMPLATE_REPRESENTATIVES) {
      test(`${rep.id} at ${width}px: header band, primary action, side panel and content box`, async ({
        page,
        allowErrors,
      }) => {
        allowSceneErrors(rep.id, allowErrors);
        // Measure the real (narrow) row first, on the test's own `page` —
        // the automatic `allowErrors` fixture watches this page, so a scene
        // that logs a real console error at this width still fails here.
        const m = await measureScene(page, rep, width);
        // Then measure the same scene at 1440px as a reference, on a
        // throwaway context/page instead of reusing `page`. `gotoReady`
        // twice on the SAME page with the SAME URL (`scene.path` never
        // changes with width — only the viewport does) is a same-document
        // navigation to Chromium, not a fresh load: `init`'s
        // `addInitScript`/localStorage seeding never re-runs and a `prep`
        // step below can run twice against an already-prepared page. A
        // fresh context forces a real navigation. This reference page is
        // not covered by `allowErrors` (it never ran the test's own
        // fixture setup); it exists only to compare content-box presence,
        // so no console-error assertion is needed for it.
        const wideContext = await page.context().browser()!.newContext();
        const widePage = await wideContext.newPage();
        let wide: Measurement;
        try {
          wide = await measureScene(widePage, rep, WIDTH.wide);
        } finally {
          await wideContext.close();
        }
        // The narrow-width `attached` readiness loosening above (item 2)
        // means a marker can be present in the DOM while the real content
        // never rendered — this is the other half of that guarantee. A
        // scene that had a content box at 1440px and has none at this
        // width fails outright, rather than the emptied-out rules below
        // passing vacuously.
        if (wide.content !== null) {
          expect(
            m.content,
            `${rep.id} at ${width}px measured no content box, though the ${WIDTH.wide}px row of the same scene did`,
          ).not.toBeNull();
        }
        await assertGeometry(rep.id, width, m);
      });
    }
  }

  // ── appmain container rows ────────────────────────────────────────────
  // Each row first asserts that `.app-main` really is at or below `max`, so
  // the container query the row checks is actually in effect — the rail
  // stays docked at this width (56px), so main column = viewport − 56.
  interface ContainerRow {
    max: number;
    rule: string;
    viewport: number;
    route: string;
    ready: string;
    prep?: (page: Page) => Promise<void>;
    check: (page: Page) => Promise<void>;
  }

  async function noHorizontalOverflow(page: Page, selector: string): Promise<void> {
    const overflow = await page.locator(selector).first().evaluate((el) => el.scrollWidth - el.clientWidth);
    expect.soft(overflow, `${selector} overflows horizontally by ${overflow}px`).toBeLessThanOrEqual(1);
  }

  const CONTAINER_ROWS: ContainerRow[] = [
    {
      max: 420,
      rule: "shell-main.css:582, the screen header tightens to 14px",
      viewport: 460,
      route: "/#/skill/rt-android-expert",
      ready: ".main-header",
      check: async (page) => {
        const header = page.locator(".main-header");
        const headerBox = await header.boundingBox();
        const firstChild = await header.evaluate((el) => el.firstElementChild?.getBoundingClientRect().x ?? null);
        expect(headerBox, "header box").not.toBeNull();
        expect(firstChild, "header first child x").not.toBeNull();
        const gap = (firstChild as number) - (headerBox as { x: number }).x;
        expect.soft(Math.abs(gap - 14), `first header child x minus header x = ${gap}, expected 14`).toBeLessThanOrEqual(1);
        await noHorizontalOverflow(page, ".main-header");
      },
    },
    {
      max: 360,
      rule: "shell-main.css:515, crumbs hide",
      viewport: 400,
      route: "/#/skill/rt-android-expert",
      ready: ".main-header",
      check: async (page) => {
        await expect.soft(page.locator(".main-title .crumbs")).toBeHidden();
        await noHorizontalOverflow(page, ".main-header");
      },
    },
    {
      max: 420,
      rule: "floating-search.css:133, kind counts hide",
      viewport: 460,
      route: "/#/",
      ready: ".app-main",
      prep: async (page) => {
        await page.keyboard.press("/");
        await page.locator(".floating-search-kinds").waitFor({ state: "visible" });
      },
      check: async (page) => {
        await expect.soft(page.locator(".floating-search-kinds .chip .count").first()).toBeHidden();
        await noHorizontalOverflow(page, ".floating-search-kinds");
      },
    },
    {
      max: 360,
      rule: "permissions.css:319, worktree rows stack",
      viewport: 400,
      route: "/#/project/skill-hub?tab=permissions",
      ready: ".app-main",
      // The mock's worktree-access status always returns one row per
      // harness (unmanaged/configured/unsupported/not_installed), so the
      // rows this rule checks render without saving a change — see
      // project-worktree-access.journey.spec.ts:5 for the toggle+Save
      // journey this rule does not need. Below 520px the perm-layout
      // ResizableSplit cannot dock its fixed pane beside the min main width
      // (project-worktree-access.journey.spec.ts's own 520px test), so the
      // Tools pane renders collapsed behind a reopen trigger — at this row's
      // fixed 400px viewport that trigger is always present, so wait for it
      // deterministically rather than racing an instant `isVisible()` check
      // (which can read `false` before the split has decided it is too
      // narrow to dock, and silently skip the click).
      prep: async (page) => {
        const reopen = page.getByRole("button", { name: /Open Tools/ });
        await reopen.waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS });
        await reopen.click();
        const section = page.getByTestId("worktree-access-section");
        await expect(section).toBeVisible();
        await section.locator(".worktree-access-row").first().waitFor({ state: "visible" });
      },
      check: async (page) => {
        const row = page.locator(".worktree-access-row").first();
        const harnessBox = await row.locator(".worktree-access-harness").boundingBox();
        const badgeBox = await row.locator(".status-badge").boundingBox();
        expect(harnessBox, "harness label box").not.toBeNull();
        expect(badgeBox, "status badge box").not.toBeNull();
        const harnessBottom = (harnessBox as { y: number; height: number }).y + (harnessBox as { height: number }).height;
        const badgeTop = (badgeBox as { y: number }).y;
        expect
          .soft(badgeTop, `status badge top ${badgeTop} should sit at or below the harness label bottom ${harnessBottom}`)
          .toBeGreaterThanOrEqual(harnessBottom - 1);
        await noHorizontalOverflow(page, ".worktree-access-row");
      },
    },
  ];

  for (const row of CONTAINER_ROWS) {
    test(`appmain ≤${row.max}px: ${row.rule}`, async ({ page }) => {
      await page.setViewportSize({ width: row.viewport, height: 900 });
      await gotoReady(page, row.route, { waitUntil: "load" });
      await page.locator(row.ready).first().waitFor({ state: "visible" });
      await waitForPaint(page);
      const mainWidth = await page.locator(".app-main").evaluate((el) => el.clientWidth);
      expect(mainWidth, `.app-main width ${mainWidth} should be at or below ${row.max}`).toBeLessThanOrEqual(row.max);
      if (row.prep) await row.prep(page);
      await waitForPaint(page);
      await row.check(page);
    });
  }
});
