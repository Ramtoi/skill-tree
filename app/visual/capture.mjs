// ─── Responsive-screenshot harness ───────────────────────────────────────────
// Boots the REAL Skill Tree React frontend in headless Chromium with MOCKED
// Tauri data (VISUAL_MOCK=1 vite alias), navigates every relevant screen/state
// at multiple viewport WIDTHS (fixed height), screenshots each, and emits an
// HTML gallery showing full-width vs reduced-width side by side.
//
//   Run from app/:  npm run visual
//   Output:         app/visual/out/<sceneId>__<width>.png  +  index.html
//                   (ST_VISUAL_ONLY=<ids> re-shoots just those scenes in place,
//                    keeps every other frame, and writes index-only.html)
//
// Env knobs (parsed in ./config.mjs):
//   ST_DEV_PORT=1478            Vite port (parallel worktrees)
//   ST_VISUAL_ONLY=a,b          scene-id allowlist
//   ST_VISUAL_WIDTHS=1440,520   viewport widths (default 1440,1024,768,520)
//   ST_VISUAL_CLIP=.app-main:160  clip each frame to an element's box (+height)
//   ST_VISUAL_OUT=<dir>         output dir (default visual/out)
//   ST_VISUAL_APP=<dir>         photograph ANOTHER app checkout (its Vite, its
//                               node_modules) with THIS file's scene list —
//                               how pr-proof.mjs shoots the "before" side.
//   ST_VISUAL_LIST=1            print the scene ids and exit (no browser)
//   ST_VISUAL_HOST=127.0.0.1    probe/navigate this loopback instead of [::1]
//                               (Linux hosts whose localhost is IPv4 only)
//
// Every run writes `capture-report.json` next to the frames: per frame
// { scene, width, ok, clipped } so a consumer can tell a full-frame fallback
// from a real clip. A full run wipes the output dir ONLY when it is missing,
// empty, or carries the OUT_SENTINEL file (see config.mjs).
//
// `SCENES` is exported so tooling (pr-proof.mjs) shares the one scene list;
// `main()` only runs when this file is the entrypoint.
//
// This OBSERVES the UI only — it never modifies components or CSS.

import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import {
  OUT_SENTINEL,
  canWipe,
  clipRect,
  frameName,
  resolveAppDir,
  resolveClip,
  resolveDevPort,
  resolveOnly,
  resolveOutDir,
  resolveWidths,
} from "./config.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolveAppDir(process.env, path.resolve(__dirname, ".."));
const OUT_DIR = resolveOutDir(process.env, __dirname);

const PORT = resolveDevPort();
// ST_VISUAL_HOST=127.0.0.1 for hosts whose `localhost` resolves to IPv4 only
// (Vite then binds 127.0.0.1 and the default IPv6 probe never answers).
const HOST = process.env.ST_VISUAL_HOST || "[::1]";
const BASE = `http://${HOST}:${PORT}`;
const WIDTHS = resolveWidths();
// Optional comma-separated scene-id allowlist (e.g. ST_VISUAL_ONLY=project-agent-docs)
// to iterate on a subset without rendering the whole gallery.
const ONLY = resolveOnly();
const CLIP = resolveClip();
const HEIGHT = 900;
const SCALE = 2;
// Scene-prep synchronization budgets (not arbitrary sleeps): how long we wait
// for the sync-report drawer to mount, and for an expanded row to settle.
const SYNC_REPORT_DRAWER_WAIT_MS = 6000;
const DETAIL_EXPAND_SETTLE_MS = 300;
// Default budget for a scene-prep element to appear before we shoot anyway.
const SCENE_WAIT_TIMEOUT_MS = 4000;
// Word-like filler for length-meter scenes: a real sentence, repeated, so the
// textarea wraps the way a genuine over-long description would.
const PROSE_SENTENCE =
  "Review a pull request diff for correctness, flag risky changes, and call out missing tests before the author asks for a second opinion. ";
const prose = (n) =>
  PROSE_SENTENCE.repeat(Math.ceil(n / PROSE_SENTENCE.length)).slice(0, n);

// ─── Scenes ───────────────────────────────────────────────────────────────────
// Each scene: { id, label, path (hash route), waitFor, waitForState?, init?, prep? }.
// `waitFor` is a representative selector that must exist before we screenshot;
// `waitForState` (default "visible") relaxes that to "attached" for elements
// that are legitimately off-canvas in some frames.
// `init(page)` runs BEFORE navigation — for state the app reads once at boot
// (e.g. a localStorage tweak the Zustand store hydrates from at module load),
// which a post-load `prep` could no longer influence for that frame.
// `prep(page)` runs after navigation+wait to drive a toggle/state.

/** Below ~744px of container width `ResizableSplit` folds the map into an
 *  overlay behind a "Map" tab. Every Agent Docs scene has to open it or the
 *  narrow frames capture the editor with no map at all. */
/** Below the 820px breakpoint the navigator is an off-canvas DRAWER. Any scene
 *  that photographs panel content has to open it first — otherwise the narrow
 *  frames spend their whole waitFor budget (and Playwright's 30s actionability
 *  budget on the first interaction) on an element parked off screen, then shoot
 *  the wrong thing anyway. No-op at widths where the panel is docked. */
const NAV_DRAWER_BREAKPOINT = 820;
async function openNavDrawer(page) {
  if ((page.viewportSize()?.width ?? 0) > NAV_DRAWER_BREAKPOINT) return;
  const toggle = page.locator(
    '.app-rail button[title="Toggle navigation"], .nav-handle',
  );
  if (!(await toggle.count())) return;
  await toggle.first().click().catch(() => {});
  await page
    .locator(".app-nav-scrim")
    .waitFor({ state: "attached", timeout: SCENE_WAIT_TIMEOUT_MS })
    .catch(() => {});
}

/** For a scene whose real `waitFor` target lives INSIDE the panel (the
 *  glance layer's attention plaque, an expanded row's detail block): at a
 *  narrow width that target starts out `display:none` behind the closed
 *  drawer, so a top-level `waitFor` (which defaults to "visible") times out
 *  before `prep` ever runs. Wait on something always attached first
 *  (`.app-side`), open the drawer, THEN wait for the real target — the same
 *  two-step `nav-filter-open` already uses. */
async function openNavDrawerThenWait(page, selector) {
  await openNavDrawer(page);
  await page
    .locator(selector)
    .waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS })
    .catch(() => {});
}

async function openAgentDocsMap(page) {
  const reopen = page.locator(".resizable-split-reopen");
  if (await reopen.count()) await reopen.first().click().catch(() => {});
  await page
    .locator(".agent-docs-map")
    .waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS })
    .catch(() => {});
}

/** The skill editor's side panel is the fixed pane of the same `ResizableSplit`
 *  the agent-docs map uses: below its breakpoint it auto-collapses behind a
 *  "Details" tab. Any FILES scene has to reopen it, or the narrow frames — the
 *  exact widths a row would clip at — photograph an editor with no navigator. */
async function openEditorSidePanel(page) {
  const reopen = page.locator(".resizable-split-reopen");
  if (await reopen.count()) await reopen.first().click().catch(() => {});
  await page
    .locator('[data-testid="skill-files"]')
    .waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS })
    .catch(() => {});
}

/** The skill editor's Details side panel (`DocumentEditorShell`'s
 *  `ResizableSplit`, `paneLabel="Details"`) auto-collapses into a vertical
 *  "Open Details" reopen tab below its dock breakpoint — the case at 520px —
 *  and can also be user-collapsed at any width; both share the same
 *  `.resizable-split-reopen` button. A SHIPS WITH scene needs the panel
 *  showing before it can expand the section or click `Edit`, so this reopens
 *  it FIRST when collapsed. Unlike `openEditorSidePanel` (which tolerates a
 *  missed click because the FILES panel is open by default at every width
 *  this repo ships), this never swallows the click: a reopen tab present but
 *  unclickable is exactly the silent-failure bug this scene was fixed for,
 *  so it must fail the capture loudly instead of producing a blank frame. */
async function openDetailsSidePanel(page) {
  const reopen = page.locator(".resizable-split-reopen");
  if (await reopen.count()) await reopen.first().click();
}

/** The permissions side panel is the fixed pane of its own `ResizableSplit`
 *  and auto-collapses the same way below its breakpoint — reopen it (if
 *  collapsed) before clicking its Codex tab, then wait for the harness
 *  view's own real target rather than the panel root itself (which can be
 *  narrower-than-"visible" mid-collapse-animation). A harness tab is
 *  glyph-only at rest (the name shows only once pressed), so target it by
 *  its stable `data-tab` attribute rather than its visible text. */
async function openPermSidePanelCodexView(page) {
  const reopen = page.locator(".resizable-split-reopen");
  if (await reopen.count()) await reopen.first().click().catch(() => {});
  await page
    .locator('.perm-side .perm-harness-tabs [data-tab="harness:codex"]')
    .click()
    .catch(() => {});
  await page
    .locator('[data-testid="codex-rules-preview"]')
    .waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS })
    .catch(() => {});
  await delay(400);
}

/** In overlay mode the panel sits over the editor behind a scrim, so a click
 *  meant for the document would land on the scrim instead. Escape puts it away;
 *  a no-op while the panel is docked. */
async function closeEditorSidePanelOverlay(page) {
  const scrim = page.locator(".resizable-split-scrim");
  if (!(await scrim.count())) return;
  await page.keyboard.press("Escape").catch(() => {});
  await scrim
    .waitFor({ state: "detached", timeout: SCENE_WAIT_TIMEOUT_MS })
    .catch(() => {});
}

/** Open one FILES row by its rel path and wait for the editor to settle on it —
 *  on the panel's own `data-active-rel`, not on whichever row looks selected. */
async function selectSkillFile(page, rel) {
  await openEditorSidePanel(page);
  await page
    .locator(`[data-testid="skill-file-row"][data-rel="${rel}"]`)
    .first()
    .click()
    .catch(() => {});
  await page
    .locator(`[data-testid="skill-files"][data-active-rel="${rel}"]`)
    .waitFor({ state: "attached", timeout: SCENE_WAIT_TIMEOUT_MS })
    .catch(() => {});
}

/** The Library's list/grid toggle is local `useState`, not URL-addressable —
 *  so a grid scene has to drive the same `Grid view` chip a user would click.
 *  Waits for a `.resource-card` to land so the shot isn't taken mid-toggle. */
async function switchToGridView(page) {
  const gridChip = page.locator('button[aria-label="Grid view"]');
  try {
    await gridChip.waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS });
    await gridChip.click();
    await page
      .locator(".skill-grid .resource-card")
      .first()
      .waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS });
  } catch {
    console.warn("    [warn] could not switch the Library to grid view");
  }
}

async function openClassificationRuntime(page) {
  const runtime = page.getByTestId("side-section-runtime");
  await runtime.waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS });
  if ((await runtime.getAttribute("aria-expanded")) === "false") await runtime.click();
  const section = page.locator('[data-section-id="runtime"]');
  await section.scrollIntoViewIfNeeded();
  await section.locator(".classification-section-body").waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS });
}

async function openClassificationGroups(page) {
  const classGroup = page.getByTitle("Group by class");
  await classGroup.waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS });
  await classGroup.click();
  await page.locator(".section-header").filter({ has: page.getByText("PROCESS", { exact: true }) }).waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS });
}

async function openClassificationPaths(page) {
  await openClassificationGroups(page);
  const processHeader = page.locator(".section-header").filter({ has: page.getByText("PROCESS", { exact: true }) });
  const processRows = page.locator('.lib-nav-row').filter({ has: page.locator('.resource-name[title="rt-android-expert"]') });
  const processRow = processRows.first();
  await processHeader.waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS });
  await processRow.locator("xpath=preceding-sibling::div[contains(@class, 'section-header')][1]").getByText("PROCESS", { exact: true }).waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS });
  await processRow.waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS });
  await processRow.focus();
  await page.keyboard.press("ArrowRight");
  await processRow.locator(".resource-detail").waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS });
  await processRow.getByRole("button", { name: /^code change,/i }).click();
  const inspector = page.locator(".classification-path-inspector");
  await inspector.waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS });
  const box = await inspector.boundingBox();
  const viewport = page.viewportSize();
  if (!box || !viewport || box.bottom <= 0 || box.top >= viewport.height) {
    throw new Error("classification path inspector is outside the viewport");
  }
}

async function openClassificationFilterPopover(page) {
  const filter = page.locator(".main-subheader").getByRole("button", { name: /^Filter/ });
  await filter.waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS });
  await filter.click();
  await page.getByRole("dialog", { name: "Filter skills" }).waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS });
}

async function expandClassificationOutputRow(page) {
  const row = page.locator('.skill-row').filter({ has: page.locator('.resource-name[title="rt-android-expert"]') });
  await row.waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS });
  await row.getByRole("button", { name: /Show rt-android-expert details/ }).click();
  await row.locator(".resource-detail .output-flow").waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS });
}

export const SCENES = [
  ...["draft", "uncertain", "blocked"].map((state) => ({
    id: `feedback-${state}`, label: `Feedback ${state}`,
    path: `/?feedback=${state}#/project/moon-base?tab=permissions`, waitFor: ".app-main",
    prep: async (page) => {
      await page.getByRole("button", { name: "Feedback", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Feedback", exact: true });
      await dialog.getByLabel("Message", { exact: true }).fill("I could not tell which permissions apply to this project.");
      await dialog.locator("summary").click();
      if (state !== "draft") {
        await dialog.getByRole("button", { name: "Send", exact: true }).click();
        await dialog.getByRole("alert").waitFor();
      }
    },
  })),
  {
    id: "headless-machine-preview", label: "Headless machine · reviewed delivery", path: "/#/remote/build-box",
    waitFor: ".machine-detail",
    init: async (page, active = false) => {
      await page.addInitScript((active) => {
        const machines = {
        "build-box": { id: "build-box", connector: "headless-loadouts", phase: "previewed", sync_enabled: false,
          draft: { revision: 4, input: { ssh_host: "build-box", host_key_sha256: "SHA256:exampleFingerprintForPreviewOnly01234567890",
            feed_url: "git@example.org:team/private-loadouts.git", private_feed_confirmed: true, poll_interval_seconds: 60 },
            observations: { connect: "confirmed", install: { command: "/home/example/.local/share/skill-tree/receiver/bin/hub" }, configure: {},
              preview: { ok: true, state: "ready", plan_digest: "preview-example", approval_digest: null, blockers: [],
                native_review: { entries: [{ path: "/home/example/projects/application/.claude/settings.json", selector: ["permissions", "allow"], value: "Bash(git status:*)", binding: "application" }], files: [{ path: "/home/example/projects/application/.claude/hooks/skill-tree-review.sh", content: "git diff --check\n" }], removals: [], retained_bindings: [] }, changes: [
                { action: "write", path: "/home/example/projects/application/.agents/skills/review-code/SKILL.md" },
                { action: "write", path: "/home/example/projects/application/.agents/skills/test-code/SKILL.md" }] } } },
          bindings: { application: { source_project: "my-project", mode: "repository", harnesses: ["codex"] } },
          delivery: { state: "published_waiting_for_receiver", published: { revision: "a".repeat(40), generation: 1 }, applied: null, observed_at: null }
        }
        };
        if (active === true) {
          const machine = machines["build-box"];
          machine.sync_enabled = true;
          machine.phase = "ready";
          machine.delivery.state = "applied";
          machine.delivery.applied = machine.delivery.published;
          machine.delivery.observed_at = "2026-09-17T10:00:00Z";
          machine.delivery.invocation = ["review-code", "test-code"].map(skill => ({ skill, binding: "application", harness: "codex", limitations: ["Explicit invocation remains available."] }));
        }
        if (active === "error") {
          const machine = machines["build-box"];
          machine.phase = "bound";
          machine.draft.observations.start = {};
          delete machine.draft.observations.preview;
          machine.delivery.error = { message: "Project 'my-project', skill 'review-code': Asset 'references/criteria.md': File link must resolve to a regular asset in a registered skill source." };
          machine.delivery.state = "unsupported_source";
        }
        localStorage.setItem("st:mock:machines", JSON.stringify(machines));
      }, active);
    },
  },

  {
    id: "headless-machine-active", label: "Headless machine · confirmed delivery", path: "/#/remote/build-box",
    waitFor: ".machine-detail",
    init: async (page) => SCENES.find(scene => scene.id === "headless-machine-preview").init(page, true),
  },

  {
    id: "headless-machine-blocked", label: "Headless machine · delivery enabled but blocked", path: "/?machineBlocked=1#/remote/build-box",
    waitFor: ".machine-error",
  },

  {
    id: "headless-machine-error", label: "Headless machine · preview error and resume", path: "/#/remote/build-box",
    waitFor: ".machine-error",
    init: async (page) => SCENES.find(scene => scene.id === "headless-machine-preview").init(page, "error"),
  },

  {
    id: "headless-machine-reconnect", label: "Headless machine · receiver owned by another installation", path: "/#/remote/build-box",
    waitFor: ".machine-detail",
    init: async (page) => {
      await page.addInitScript(() => {
        const machines = {
          "build-box": { id: "build-box", connector: "headless-loadouts", phase: "installed", sync_enabled: false,
            draft: { revision: 3, input: { ssh_host: "build-box", host_key_sha256: "SHA256:exampleFingerprintForPreviewOnly01234567890",
              feed_url: "git@example.org:team/private-loadouts.git", private_feed_confirmed: true, poll_interval_seconds: 60 },
              observations: { connect: "confirmed", install: { command: "/home/example/.local/share/skill-tree/receiver/bin/hub" },
                channel_conflict: { feed_id: "6f4c606b201e4d5ab2518bd32fdf136d", publisher_key_id: "SHA256:0f2b9c1d7e4a6b83",
                  controller_key_id: "SHA256:9a71e4c2b0d5f638", applied: { generation: 3, applied_at: "2026-09-17T12:13:14Z" } } } },
            bindings: {},
            delivery: { state: "setup_required", published: null, applied: null, observed_at: null,
              error: { message: "Could not publish this machine's loadout. Review its setup.", code: "setup_required" } },
          },
        };
        localStorage.setItem("st:mock:machines", JSON.stringify(machines));
      });
    },
    // The conflict panel sits just above the polling controls at the bottom of
    // the receiver section; bring that area into the frame on both sides.
    prep: async (page) => {
      await page.locator(".machine-polling").scrollIntoViewIfNeeded({ timeout: 3000 });
    },
  },

  ...["appearance", "agents", "worktrees", "usage", "backup", "remotes"].map((category) => ({
    id: `settings-${category}`,
    label: `Settings ${category}`,
    path: "/#/",
    waitFor: ".app-main",
    prep: async (page) => {
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
      await dialog.waitFor();
      if (category !== "appearance") {
        const label = category[0].toUpperCase() + category.slice(1);
        const select = dialog.getByRole("combobox", { name: "Settings category" });
        if (await select.isVisible()) {
          await select.click();
          await page.getByRole("option", { name: label, exact: true }).click();
        } else await dialog.getByRole("button", { name: label, exact: true }).click();
      }
    },
  })),
  { id: "skill-header-classes", label: "Skill header classes", path: "/?classification=1&classOverflow=1#/skill/rt-android-expert", waitFor: ".skill-header-classes" },
  { id: "skill-header-classes-overlay", label: "Skill header all classes", path: "/?classification=1&classOverflow=1#/skill/rt-android-expert", waitFor: ".skill-header-classes", prep: async (page) => { await page.getByRole("button", { name: "Show all classes" }).hover(); await page.getByRole("dialog", { name: "All classes" }).waitFor(); } },
  { id: "classification-library", label: "Classification — Library class groups", path: "/?classification=1#/?q=android&classScope=references", waitFor: ".lib-list", prep: openClassificationGroups },
  { id: "classification-bundle", label: "Classification — Android bundle lens", path: "/?classification=1#/bundle/android?q=android&class=process&mode=mixed&classScope=assigned", waitFor: "text=android", prep: openClassificationGroups },
  { id: "classification-editor", label: "Classification — Runtime editor", path: "/?classification=1#/skill/rt-android-expert", waitFor: ".doc-editor-shell", prep: openClassificationRuntime },
  { id: "classification-external", label: "Classification — Imported Runtime editor", path: "/?classification=1#/skill/android-compose-ui", waitFor: ".doc-editor-shell", prep: openClassificationRuntime },
  { id: "classification-filters", label: "Classification — Filter popover", path: "/?classification=1#/?q=android", waitFor: ".lib-list", prep: openClassificationFilterPopover },
  { id: "classification-paths", label: "Classification — Contribution paths", path: "/?classification=1#/?q=android", waitFor: ".lib-list", prep: openClassificationPaths },
  { id: "classification-outputs", label: "Classification — Expanded output flow", path: "/?classification=1#/?q=android", waitFor: ".lib-list", prep: expandClassificationOutputRow },
  {
    id: "skill-library",
    label: "Skill Library",
    path: "/#/",
    waitFor: "text=SKILL TREE",
  },
  {
    id: "skill-library-grid",
    label: "Skill Library — Grid view (equipped-pip badges)",
    path: "/#/",
    waitFor: "text=SKILL TREE",
    prep: switchToGridView,
  },
  {
    id: "library-search-typing",
    label: "Library — floating unified search, typing (kind chips + body-hit groups)",
    path: "/#/",
    waitFor: '[data-testid="floating-search"]',
    prep: async (page) => {
      const input = page.locator('[data-testid="floating-search-input"]');
      await input.click().catch(() => {});
      await input.type("an", { delay: 20 }).catch(() => {});
      await page
        .locator('[data-testid="library-body-hit"]')
        .first()
        .waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS })
        .catch(() => {});
      await delay(400); // let the rise settle before the shutter
    },
  },
  {
    id: "library-search-cursor",
    label: "Library — search cursor: ArrowDown twice from the bar, focus stays in the input",
    path: "/#/",
    waitFor: '[data-testid="floating-search"]',
    prep: async (page) => {
      const input = page.locator('[data-testid="floating-search-input"]');
      await input.click().catch(() => {});
      await input.type("an", { delay: 20 }).catch(() => {});
      await page
        .locator('[data-testid="library-body-hit"]')
        .first()
        .waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS })
        .catch(() => {});
      await input.press("ArrowDown").catch(() => {});
      await input.press("ArrowDown").catch(() => {});
      await delay(300);
    },
  },
  {
    id: "library-search-return",
    label: "Library — search return: open a result, go back — query and cursor restored",
    path: "/#/",
    waitFor: '[data-testid="floating-search"]',
    prep: async (page) => {
      const input = page.locator('[data-testid="floating-search-input"]');
      await input.click().catch(() => {});
      await input.type("an", { delay: 20 }).catch(() => {});
      await input.press("ArrowDown").catch(() => {});
      await input.press("Enter").catch(() => {});
      // Whichever result kind the cursor landed on (skill/mcp or bundle), the
      // detail screen's header back arrow is the common "we navigated away"
      // signal — waiting on it (rather than the skill editor specifically)
      // doesn't depend on the mock fixture's search ranking.
      await page
        .locator(".header-back")
        .waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS })
        .catch(() => {});
      await page.goBack().catch(() => {});
      await page
        .locator('[data-testid="floating-search"]')
        .waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS })
        .catch(() => {});
      await delay(300);
    },
  },
  {
    id: "library-search-content",
    label: "Library — content search: a body-only match with its excerpt",
    path: "/#/",
    waitFor: '[data-testid="floating-search"]',
    prep: async (page) => {
      const input = page.locator('[data-testid="floating-search-input"]');
      await input.click().catch(() => {});
      await input.type("quorum", { delay: 20 }).catch(() => {});
      await page.locator(".resource-excerpt").first()
        .waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS }).catch(() => {});
      await delay(400); // let the rise settle before the shutter
    },
  },
  {
    id: "rail-expanded",
    label: "Icon rail — labels mode (168px rail; compacts again at narrow widths)",
    path: "/#/",
    waitFor: ".app-rail",
    init: async (page) => {
      await page.addInitScript(() => {
        localStorage.setItem(
          "skill-tree:tweaks",
          JSON.stringify({ railExpanded: true }),
        );
      });
    },
  },
  // ── Header band (nav-header-align) ────────────────────────────────────────
  // The band is one row across rail strip + navigator head + screen header. Its
  // three failure modes are all LAYOUT modes, so each needs a frame of its own.
  {
    id: "fullscreen-header-band",
    label:
      "Header band — fullscreen, rail + navigator docked (the reported mode: strip, panel head and screen header must share one edge)",
    // `?fullscreen=1` makes the mocked window report fullscreen (see
    // src/mocks/tauriWindow.ts). Without it every frame in this gallery is
    // windowed, and fullscreen is where the band last broke.
    // /#/hooks carries a subheader row, so row 2 is in frame too.
    path: "/?fullscreen=1#/hooks",
    waitFor: ".side-head",
  },
  {
    id: "rail-hidden-nav-docked",
    label:
      "Header band — rail hidden, navigator docked (title strip collapses; the panel head takes the full 84px traffic-light inset)",
    path: "/#/hooks",
    waitFor: ".side-head",
    init: async (page) => {
      await page.addInitScript(() => {
        localStorage.setItem(
          "skill-tree:tweaks",
          JSON.stringify({ showRail: false }),
        );
      });
    },
  },
  {
    id: "no-left-chrome",
    label:
      "Header band — rail AND navigator off (the strip spans the window as a plain title bar above the header, never a second band)",
    path: "/#/hooks",
    waitFor: ".main-header",
    init: async (page) => {
      await page.addInitScript(() => {
        localStorage.setItem(
          "skill-tree:tweaks",
          JSON.stringify({ showRail: false, showNav: false }),
        );
      });
    },
  },
  {
    id: "nav-drawer-open",
    label:
      "Navigator drawer — open over the content at narrow widths (520/768; wide frames stay docked)",
    path: "/#/",
    // ATTACHED, not visible: a closed drawer is translated off-canvas and goes
    // `visibility: hidden`, so a visible-wait burns the full budget on exactly
    // the narrow frames this scene exists to photograph.
    waitFor: ".app-side",
    waitForState: "attached",
    // The drawer toggle only exists below the breakpoint, so the wide frames of
    // this scene simply show the docked panel — which is the comparison we want
    // beside the narrow ones.
    prep: openNavDrawer,
  },
  {
    id: "skill-editor-edit",
    label: "Skill Editor — Edit",
    path: "/#/skill/rt-android-expert",
    waitFor: ".code-area",
  },
  {
    id: "skill-editor-preview",
    label: "Skill Editor — Preview (renderMarkdown v2: real ol, headings, code)",
    path: "/#/skill/rt-android-expert",
    waitFor: ".code-area",
    prep: async (page) => {
      await clickChip(page, "Preview");
    },
  },
  {
    // AFTER-ONLY by construction: the skill-reference hover card did not exist
    // before this feature, so there is no BEFORE state to photograph.
    id: "skill-editor-ref-hover-preview",
    label: "Skill Editor — Preview, a skill-reference hover card",
    path: "/#/skill/rt-android-expert",
    waitFor: ".code-area",
    prep: async (page) => {
      await clickChip(page, "Preview");
      await page.locator(".md-skill-ref").first().hover();
      await delay(600);
    },
  },
  {
    // AFTER-ONLY by construction: the completion overlay did not exist before
    // this feature, so there is no BEFORE state to photograph (same as
    // `skill-editor-ref-hover-preview` above). The gate-6 run therefore needs
    // `--allow-missing`.
    id: "skill-editor-ref-completion",
    label: "Skill Editor — Edit, the slash-reference completion overlay",
    path: "/#/skill/rt-android-expert",
    waitFor: ".code-area",
    prep: async (page) => {
      // Anchor on a line that is provably in the BODY (the completion never
      // opens inside frontmatter): the line already carrying a decorated ref.
      // This line soft-wraps across several visual rows, so clicking its
      // bottom-right corner (not the box center) is what lands the caret at
      // the true end of the LOGICAL line — CM's default `End` binding
      // (`cursorLineBoundaryForward`) is wrap-aware and only reaches the end
      // of whichever visual row a center-click landed on.
      const line = page.locator(".cm-line:has(.cm-skill-ref)").first();
      const box = await line.boundingBox();
      await line.click(box ? { position: { x: box.width - 2, y: box.height - 2 } } : undefined);
      await page.keyboard.press("End");
      await page.keyboard.type(" /cod");
      await page.locator(".cm-tooltip-autocomplete").waitFor({ timeout: 3000 });
      await delay(200);
    },
  },
  {
    id: "skill-editor-rename-refs",
    label: "Skill editor — rename cascade confirm (grouped referrers, agent-docs opt-in OFF)",
    path: "/#/skill/rt-android-expert",
    waitFor: ".doc-editor-shell",
    prep: async (page) => {
      await page.getByRole("button", { name: /^Rename skill name: / }).click().catch(() => {});
      const field = page.getByRole("textbox", { name: "Skill name" });
      await field.fill("rt-android-planner").catch(() => {});
      await field.press("Enter").catch(() => {});
      await page.keyboard.press("ControlOrMeta+s").catch(() => {});
      await page.locator('[data-testid="rename-refs-dialog"]')
        .waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS }).catch(() => {});
      await delay(300);
    },
  },
  {
    id: "skill-editor-rename-refs-running",
    label: "Skill editor — rename cascade in flight (step 1 busy, actions disabled)",
    path: "/?renameHangs=1#/skill/rt-android-expert",
    waitFor: ".doc-editor-shell",
    prep: async (page) => {
      await page.getByRole("button", { name: /^Rename skill name: / }).click().catch(() => {});
      const field = page.getByRole("textbox", { name: "Skill name" });
      await field.fill("rt-android-planner").catch(() => {});
      await field.press("Enter").catch(() => {});
      await page.keyboard.press("ControlOrMeta+s").catch(() => {});
      await page.locator('[data-testid="rename-refs-dialog"]')
        .waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS }).catch(() => {});
      await page.locator('[data-testid="rename-refs-rewrite"]').click().catch(() => {});
      await page.locator('[data-testid="rename-refs-step"][data-state="busy"]')
        .waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS }).catch(() => {});
      await delay(300);
    },
  },
  {
    id: "skill-editor-refs-section",
    label: "Skill Editor — side panel REFERENCES (mentions / mentioned by)",
    path: "/#/skill/rt-android-expert",
    waitFor: ".code-area",
    prep: async (page) => {
      // The side panel is off-canvas below ~820px; the narrow frame then just
      // shows the editor (honest: the section is a wide-layout affordance).
      // `side-section-refs` is the head BUTTON (carries aria-expanded); the
      // section box is its `.side-panel-section[data-section-id="refs"]` parent.
      const head = page.locator('[data-testid="side-section-refs"]');
      if ((await head.getAttribute("aria-expanded").catch(() => null)) === "false") {
        await head.click().catch(() => {});
      }
      await page
        .locator('.side-panel-section[data-section-id="refs"]')
        .scrollIntoViewIfNeeded({ timeout: 3000 })
        .catch(() => {});
      await delay(300);
    },
  },
  {
    // ships_with wave 2 (D7/D8, plans/ships-with-2 plan 2): the rebuilt SHIPS
    // WITH section — one dense row per declared companion (agent/hook/rule)
    // under compact AGENTS · HOOKS · RULES sub-group labels, a harness glyph
    // cluster carrying provisioning STATE (never a verdict word), and the
    // status line. `.companion-glyph` only lights up once the lazy
    // `hub skill companions` read resolves.
    id: "skill-editor-ships-with",
    label: "Skill Editor — side panel SHIPS WITH (orchestrate-advanced)",
    path: "/#/skill/orchestrate-advanced",
    waitFor: ".code-area",
    prep: async (page) => {
      // Below the Details panel's dock breakpoint (520px included) it's a
      // collapsed reopen tab, not the panel itself — open it FIRST, for real
      // (see `openDetailsSidePanel`), or every step below operates on a panel
      // that was never shown and the frame comes back blank.
      await openDetailsSidePanel(page);
      const head = page.locator('[data-testid="side-section-ships-with"]');
      if ((await head.getAttribute("aria-expanded").catch(() => null)) === "false") {
        await head.click();
      }
      await page
        .locator('.side-panel-section[data-section-id="ships-with"]')
        .scrollIntoViewIfNeeded({ timeout: 3000 })
        .catch(() => {});
      await page
        .locator('[data-testid^="companion-row-"] .companion-glyph')
        .first()
        .waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS })
        .catch(() => {});
      await delay(300);
    },
  },
  {
    // ships_with wave 3 (D16): the project-less, all-absent read — every
    // declared agent/hook is hidden from the mock's sub-agent list/hooks
    // library under `?companionsAbsent=1`, so every row is genuinely
    // `absent` and unroutable (F2/F4): the idle status line ("Not
    // provisioned anywhere — equip … on a project to install these"), the
    // `Equip…` rung, the `not installed` row badge, and an inert `<span>`
    // name all render together in one frame.
    id: "skill-editor-ships-with-absent",
    label: "Skill Editor — SHIPS WITH, project-less all-absent (orchestrate-advanced)",
    path: "/?companionsAbsent=1#/skill/orchestrate-advanced",
    waitFor: ".code-area",
    prep: async (page) => {
      await openDetailsSidePanel(page);
      const head = page.locator('[data-testid="side-section-ships-with"]');
      if ((await head.getAttribute("aria-expanded").catch(() => null)) === "false") {
        await head.click();
      }
      await page
        .locator('.side-panel-section[data-section-id="ships-with"]')
        .scrollIntoViewIfNeeded({ timeout: 3000 })
        .catch(() => {});
      await page
        .locator('[data-testid="companion-status-line"]')
        .waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS })
        .catch(() => {});
      await delay(300);
    },
  },
  {
    // ships_with wave 2 (Approach 9, D10): the rare-path editor — an `Edit`
    // rung in the section header opens `CompanionsEditSheet` with its staged
    // agent/hook/rule pickers.
    id: "skill-editor-ships-with-edit",
    label: "Skill Editor — SHIPS WITH edit sheet (orchestrate-advanced)",
    path: "/#/skill/orchestrate-advanced",
    waitFor: ".code-area",
    prep: async (page) => {
      // Same narrow-width exposure as the read scene above: reopen the
      // Details panel before anything inside it can be clicked.
      await openDetailsSidePanel(page);
      const head = page.locator('[data-testid="side-section-ships-with"]');
      if ((await head.getAttribute("aria-expanded").catch(() => null)) === "false") {
        await head.click();
      }
      // No `.catch` on the Edit click or the sheet wait: a swallowed failure
      // here is exactly the bug this scene was fixed for (a rung the capture
      // silently never found, producing a frame with no sheet at all) — let
      // it fail the run loudly instead.
      await page.locator('[data-testid="ships-with-edit"]').click();
      await page
        .locator(".companions-edit-sheet")
        .waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS });
      await delay(300);
    },
  },
  {
    // Wave 4c unit 2 (plans/3.md §2.1/§3.1/§6.6): the sheet's collapsed
    // "New hook…" disclosure, opened and mid-fill. Named `ships-with-new-
    // hook-sheet` — NOT `skill-editor-…` (grill #15) — so it never matches
    // `/editor/i` and never enters `screen-geometry.journey.spec.ts`'s
    // SELECTED_SCENES: an overlay-open frame is not what those three
    // geometry invariants measure. That coverage stays with
    // `skill-editor-ships-with-edit` above, unchanged by this wave.
    id: "ships-with-new-hook-sheet",
    label: "Companions edit sheet — New hook… form open (orchestrate-advanced)",
    path: "/#/skill/orchestrate-advanced",
    waitFor: ".code-area",
    prep: async (page) => {
      await openDetailsSidePanel(page);
      const head = page.locator('[data-testid="side-section-ships-with"]');
      if ((await head.getAttribute("aria-expanded").catch(() => null)) === "false") {
        await head.click();
      }
      await page.locator('[data-testid="ships-with-edit"]').click();
      await page
        .locator(".companions-edit-sheet")
        .waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS });
      await page.locator('[data-testid="companions-new-hook-toggle"]').click();
      await page.locator('[data-testid="companions-new-hook-name"]').fill("scope-guard");
      await page
        .locator('[data-testid="companions-new-hook-event"] .select-trigger')
        .click()
        .catch(() => {});
      await delay(300);
    },
  },
  {
    id: "skill-editor-diff",
    label: "Skill Editor — Diff v2 (real aligned line diff, one inserted line)",
    path: "/#/skill/rt-android-expert",
    waitFor: ".code-area",
    prep: async (page) => {
      // Insert one line so the diff shows a single change (not the empty state).
      const cm = page.locator(".doc-editor-body .cm-content");
      await cm.click().catch(() => {});
      await page.keyboard.press("ControlOrMeta+Home").catch(() => {});
      await page.keyboard.type("A freshly inserted line for the diff.\n").catch(() => {});
      await clickChip(page, "Diff");
      await delay(200);
    },
  },
  {
    id: "skill-editor-split",
    label: "Skill Editor — Split view (edit | preview, wide-width only)",
    path: "/#/skill/rt-android-expert",
    waitFor: ".code-area",
    prep: async (page) => {
      // The Split chip is gated to ≥ --bp-nav; at narrow widths it falls back
      // to single-pane edit (the gate is the point of this scene).
      await clickChip(page, "Split");
      await delay(300);
    },
  },

  // ── FILES navigator (skill-files) ─────────────────────────────────────────
  // The side panel is where this feature lives, and its four shapes fail in
  // four different ways: a folder-grouped list overflows, a one-row list looks
  // broken, a read-only skill must not show a dead affordance, and a binary
  // row swaps the whole document body for an EmptyState. `waitFor` is the
  // SHELL, not the panel: below the split's breakpoint the fixed pane is not
  // even mounted until `prep` reopens it, so waiting on the panel would just
  // burn the budget on every narrow frame before opening it anyway.
  {
    id: "skill-editor-files-multi",
    label: "Skill Editor — FILES navigator (multi-file skill, nested reference active)",
    path: "/#/skill/rt-android-expert",
    waitFor: ".doc-editor-shell",
    prep: async (page) => {
      await selectSkillFile(page, "references/patterns.md");
      await delay(200);
    },
  },
  {
    id: "skill-editor-files-single",
    label: "Skill Editor — FILES navigator (single-file skill: SKILL.md only, no filter)",
    path: "/#/skill/brainstorm",
    waitFor: ".doc-editor-shell",
    prep: async (page) => {
      await openEditorSidePanel(page);
      await delay(200);
    },
  },
  {
    id: "skill-editor-files-readonly",
    label: "Skill Editor — FILES navigator (source-managed skill: read-only, no Add file)",
    path: "/#/skill/android-compose-ui",
    waitFor: ".doc-editor-shell",
    prep: async (page) => {
      await selectSkillFile(page, "references/theming.md");
      await delay(200);
    },
  },
  {
    id: "skill-editor-files-binary",
    label: "Skill Editor — binary row selected (non-editable EmptyState, no CodeMirror)",
    path: "/#/skill/rt-android-expert",
    waitFor: ".doc-editor-shell",
    prep: async (page) => {
      await selectSkillFile(page, "assets/logo.png");
      await page
        .locator(".doc-editor-body .empty-state")
        .waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS })
        .catch(() => {});
      await delay(200);
    },
  },
  {
    id: "skill-editor-files-dirty",
    label: "Skill Editor — two unsaved siblings (N-unsaved head summary + row dots)",
    path: "/#/skill/rt-android-expert",
    waitFor: ".doc-editor-shell",
    prep: async (page) => {
      // Dirty TWO siblings and then leave a THIRD file active, so the frame
      // carries the half of the rollup that is easy to lose: unsaved state on
      // rows that are not the document on screen.
      for (const rel of ["references/checklist.md", "references/patterns.md"]) {
        await selectSkillFile(page, rel);
        // In overlay mode the scrim would eat this click, and the frame would
        // silently show a clean list instead of the state it is named for.
        await closeEditorSidePanelOverlay(page);
        await page
          .locator(".doc-editor-body .cm-content")
          .click()
          .catch(() => {});
        await page.keyboard.press("ControlOrMeta+Home").catch(() => {});
        await page.keyboard.type("An unsaved edit.\n").catch(() => {});
      }
      await selectSkillFile(page, "SKILL.md");
      await delay(250);
    },
  },
  {
    id: "skill-editor-renamed",
    label: "Skill Editor — header name edited in place, rename staged (RENAMED pill until ⌘S)",
    path: "/#/skill/rt-android-expert",
    waitFor: ".doc-editor-shell",
    prep: async (page) => {
      // The field opens with its text selected, so typing replaces the name.
      await page.locator(".main-header .inline-name").click().catch(() => {});
      await page.keyboard.type("rt-android-expert-v2").catch(() => {});
      await page.keyboard.press("Enter").catch(() => {});
      await page
        .locator(".main-header .state-pill-unsaved")
        .waitFor({ timeout: 2000 })
        .catch(() => {});
    },
  },
  {
    id: "skill-editor-scope-menu",
    label: "Skill Editor — IDENTITY scope Select open (themed menu anchored to the row)",
    path: "/#/skill/rt-android-expert",
    waitFor: ".doc-editor-shell",
    prep: async (page) => {
      await openEditorSidePanel(page);
      await page
        .locator('[data-block="identity"] .select-trigger')
        .click()
        .catch(() => {});
      await page.locator(".select-menu").waitFor({ timeout: 2000 }).catch(() => {});
    },
  },
  {
    id: "skill-editor-add-file",
    label: "Skill Editor — Add file sheet (kind chips + prefixed path)",
    path: "/#/skill/rt-android-expert",
    waitFor: ".doc-editor-shell",
    prep: async (page) => {
      await openEditorSidePanel(page);
      await page.locator('[data-testid="skill-files-add"]').click().catch(() => {});
      await page
        .locator('[data-testid="skill-files-path"]')
        .waitFor({ timeout: 2000 })
        .catch(() => {});
    },
  },
  {
    id: "skill-editor-connections",
    label: "Skill Editor — CONNECTIONS block (shared SidePanelSection heads)",
    path: "/#/skill/rt-android-expert",
    waitFor: ".doc-editor-shell",
    prep: async (page) => {
      await openEditorSidePanel(page);
      // FILES is the tall section and CONNECTIONS is the last one, so at every
      // width the connections heads start below the fold. Collapse the
      // navigator, open the three closed blocks, and they all land in frame.
      await page
        .locator('[data-testid="side-section-files"]')
        .click()
        .catch(() => {});
      for (const id of ["subagents", "runtime"]) {
        const head = page.locator(
          `[data-testid="side-section-${id}"][aria-expanded="false"]`,
        );
        if (await head.count()) await head.first().click().catch(() => {});
      }
      await page
        .locator('[data-section-id="runtime"]')
        .scrollIntoViewIfNeeded()
        .catch(() => {});
      await delay(250);
    },
  },

  {
    id: "skill-editor-triggering-pending",
    label: "Skill Editor — changing triggering to User-only, write pending",
    path: "/?invocationHangs=1#/skill/rt-android-expert",
    waitFor: ".doc-editor-shell",
    prep: async (page) => {
      await openEditorSidePanel(page);
      const head = page.locator('[data-testid="side-section-runtime"][aria-expanded="false"]');
      if (await head.count()) await head.click();
      await page.getByRole("radio", { name: "User-only", exact: true }).click();
      await page.locator('[data-section-id="runtime"]').scrollIntoViewIfNeeded();
    },
  },

  {
    id: "skill-editor-triggering-partial-sync",
    label: "Skill Editor — triggering saved while sync remains incomplete",
    path: "/?invocationPartial=1#/skill/brainstorm",
    waitFor: ".doc-editor-shell",
    prep: async (page) => {
      await openEditorSidePanel(page);
      const head = page.locator(
        '[data-testid="side-section-runtime"][aria-expanded="false"]',
      );
      if (await head.count()) await head.click();
      await page.getByRole("radio", { name: "User-only", exact: true }).click();
      await page.getByText(/Run hub sync to retry\./).waitFor({ state: "visible" });
      await page.locator('[data-section-id="runtime"]').scrollIntoViewIfNeeded();
    },
  },

  ...["codex", "opencode-command", "opencode-shared", "opencode-unknown", "yaml-failure", "none"].map((scene) => ({
    id: `skill-editor-native-${scene}`,
    label: `Native invocation: ${scene}`,
    path: `/?invocationNative=${scene}#/skill/brainstorm`,
    waitFor: ".doc-editor-shell",
    prep: async (page) => {
      await openEditorSidePanel(page);
      const head = page.locator('[data-testid="side-section-runtime"][aria-expanded="false"]');
      if (await head.count()) await head.click();
      await page.getByRole("radio", { name: "User-only", exact: true }).check();
      await page.locator(".triggering-settled").waitFor();
      await page.locator('[data-section-id="runtime"]').scrollIntoViewIfNeeded();
    },
  })),

  // ── External (source-managed) skill page — DESIGN-EXTERNAL-SKILL ─────────
  {
    id: "skill-editor-external",
    label:
      "Skill Editor — source-managed skill (opens in Preview, soft Duplicate beside Export, BUNDLES above PROJECTS)",
    path: "/#/skill/android-compose-ui",
    waitFor: ".doc-editor-shell",
    prep: async (page) => {
      await openEditorSidePanel(page);
      await page
        .locator('[data-testid="side-section-usedby"]')
        .scrollIntoViewIfNeeded()
        .catch(() => {});
      await delay(200);
    },
  },
  {
    // `?equipHangs=1` — the mocked `bundle update` never resolves, so the
    // BUNDLES row's in-flight state (R7: aria-busy, the shared rune trace,
    // the Spinner in place of the Toggle) can be photographed.
    //
    // android-compose-ui (external skill): `ConnectionsPanel`'s
    // `disabled={busy}` (SkillEditorSidePanel.tsx) gates on the archive/forget
    // page lock only — `readOnly` alone no longer short-circuits the toggle,
    // so a source-managed skill's bundle write genuinely reaches `hub_cmd` and
    // stays pending under `?equipHangs=1` just like a local skill's would.
    id: "skill-editor-equip-pending",
    label: "Skill Editor — USED BY bundle toggle in flight (rune trace + Spinner, no checkbox)",
    path: "/?equipHangs=1#/skill/android-compose-ui",
    waitFor: ".doc-editor-shell",
    prep: async (page) => {
      await openEditorSidePanel(page);
      await page
        .locator('[data-testid="side-section-usedby"]')
        .scrollIntoViewIfNeeded()
        .catch(() => {});
      const bundles = page.getByRole("listbox", { name: "Bundles" });
      const offRow = bundles
        .locator('[role="option"][data-state="off"] input[type="checkbox"]')
        .first();
      await offRow.click().catch(() => {});
      await page
        .locator('[data-pending="true"]')
        .first()
        .waitFor({ timeout: SCENE_WAIT_TIMEOUT_MS })
        .catch(() => {});
      await delay(300);
    },
  },
  {
    // Default mock (no `equipHangs`) — the bundle toggle resolves instantly,
    // so the row lands in its ~2.4s settled hold (R8: `data-settled="true"`,
    // `synced` in the meta slot). Shot inside the hold, not after it clears.
    // Unlike the pending scene, android-compose-ui is fine here: EquipPicker
    // marks a row settled the instant its OWN `onToggle` prop resolves,
    // whether or not ConnectionsPanel's `disabled` gate turned that call into
    // a no-op underneath — the visual is identical either way.
    id: "skill-editor-equip-settled",
    label: "Skill Editor — USED BY bundle toggle settled (`synced` in the meta slot)",
    path: "/#/skill/android-compose-ui",
    waitFor: ".doc-editor-shell",
    prep: async (page) => {
      await openEditorSidePanel(page);
      await page
        .locator('[data-testid="side-section-usedby"]')
        .scrollIntoViewIfNeeded()
        .catch(() => {});
      const bundles = page.getByRole("listbox", { name: "Bundles" });
      const offRow = bundles
        .locator('[role="option"][data-state="off"] input[type="checkbox"]')
        .first();
      await offRow.click().catch(() => {});
      await page
        .locator('[data-settled="true"]')
        .first()
        .waitFor({ timeout: SCENE_WAIT_TIMEOUT_MS })
        .catch(() => {});
      await delay(150);
    },
  },

  // ── MCP editor panel (plans/E1.md §5.30) ──────────────────────────────────
  {
    id: "mcp-panel-http",
    label: "MCP panel — CONNECTION/CREDENTIALS/REACH/DELIVERY (http, context7)",
    path: "/#/skill/context7",
    waitFor: '[data-testid="mcp-panel"]',
  },
  {
    id: "mcp-panel-stdio",
    label: "MCP panel — stdio server with a real folder (fs-mcp)",
    path: "/#/skill/fs-mcp",
    waitFor: '[data-testid="mcp-panel"]',
  },
  {
    // No honest "before" — the in-flight Check state has no prior art either
    // (published after-only, same as the ref-hover-preview scene above).
    id: "mcp-panel-checking",
    label: "MCP panel — Check in flight (\"Checking…\")",
    path: "/?mcpProbeHangs=1#/skill/context7",
    waitFor: '[data-testid="mcp-panel"]',
    prep: async (page) => {
      await page.locator('[data-testid="mcp-check-button"]').click();
      await delay(200);
    },
  },
  {
    id: "mcp-panel-blocked",
    label: "MCP panel — a blocked delivery row",
    path: "/?mcpBlocked=1#/skill/context7",
    waitFor: '[data-testid="mcp-panel"]',
  },

  // ── MCP capability catalogue (plans/G.md §6.5/§7.2) ────────────────────────
  {
    id: "skill-editor-mcp-capabilities",
    label: "MCP panel — CAPABILITIES glance block after a Check (counts + server identity)",
    path: "/#/skill/context7",
    waitFor: '[data-testid="mcp-panel"]',
    prep: async (page) => {
      await page.locator('[data-testid="mcp-check-button"]').click();
      await page
        .locator('[data-testid="mcp-capabilities-browse"]')
        .waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS });
      await delay(150);
    },
  },
  {
    id: "mcp-capability-sheet",
    label: "MCP capabilities — browse sheet, a tool selected (title differs from name, enum + annotations)",
    path: "/#/skill/context7",
    waitFor: '[data-testid="mcp-panel"]',
    prep: async (page) => {
      await page.locator('[data-testid="mcp-check-button"]').click();
      const browse = page.locator('[data-testid="mcp-capabilities-browse"]');
      await browse.waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS });
      await browse.click();
      const row = page.locator('[data-testid="mcp-sheet-row"]', { hasText: "Get Page" });
      await row.waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS });
      await row.click();
      await page
        .locator('[data-testid="mcp-sheet-tool-detail"]')
        .waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS });
      await delay(150);
    },
  },
  {
    id: "mcp-capability-sheet-prompt",
    label: "MCP capabilities — browse sheet, a prompt selected (ARGUMENTS table)",
    path: "/#/skill/context7",
    waitFor: '[data-testid="mcp-panel"]',
    prep: async (page) => {
      await page.locator('[data-testid="mcp-check-button"]').click();
      const browse = page.locator('[data-testid="mcp-capabilities-browse"]');
      await browse.waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS });
      await browse.click();
      const row = page.locator('[data-testid="mcp-sheet-row"]', { hasText: "compare_versions" });
      await row.waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS });
      await row.click();
      await page
        .locator('[data-testid="mcp-sheet-prompt-detail"]')
        .waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS });
      await delay(150);
    },
  },

  // ── Dropped-upstream skills (source_missing) ──────────────────────────────
  // `?contextAttention=1` seeds two dropped skills into the mock registry:
  // `diagnose` (renamed, a registered successor) and `ds-tokens` (deleted,
  // equipped on example-app, carries a below-confidence hedge candidate too).
  {
    id: "skill-editor-dropped-renamed",
    label: "Skill Editor — dropped upstream, RENAMED (primary: Open successor)",
    path: "/?contextAttention=1#/skill/diagnose",
    // The banner lives in the side panel, which auto-collapses below the
    // split's breakpoint — wait on the always-attached shell first, then open
    // the panel and wait for the real target (see `openEditorSidePanelThen*`
    // callers above).
    waitFor: ".doc-editor-shell",
    prep: async (page) => {
      await openEditorSidePanel(page);
      await page
        .locator('[data-testid="dropped-upstream-banner"]')
        .waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS })
        .catch(() => {});
      await delay(200);
    },
  },
  {
    id: "skill-editor-dropped-deleted",
    label: "Skill Editor — dropped upstream, DELETED (primary: Forget, hedge line)",
    path: "/?contextAttention=1#/skill/ds-tokens",
    waitFor: ".doc-editor-shell",
    prep: async (page) => {
      await openEditorSidePanel(page);
      await page
        .locator('[data-testid="dropped-upstream-banner"]')
        .waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS })
        .catch(() => {});
      await delay(200);
    },
  },
  {
    // `?archiveHangs=1` mirrors `?syncHangs=1` — the mocked `archive` never
    // resolves, so the locked page (aria-busy, disabled header/panel, the
    // loading-label button) can be photographed. `git-committer-mcp` is
    // unequipped anywhere, so this skips the confirm dialog entirely.
    id: "skill-editor-archiving",
    label: "Skill Editor — archive in flight (page locked: aria-busy, disabled actions)",
    path: "/?archiveHangs=1#/skill/git-committer-mcp",
    waitFor: ".doc-editor-shell",
    prep: async (page) => {
      await openEditorSidePanel(page);
      await page.getByRole("button", { name: "Archive this skill" }).click();
      await page
        .locator('[aria-busy="true"]')
        .first()
        .waitFor({ timeout: SCENE_WAIT_TIMEOUT_MS })
        .catch(() => {});
      await delay(200);
    },
  },
  {
    // `ds-tokens` is deliberately equipped on `example-app` — Forget opens the
    // blast-radius confirm instead of going straight through.
    id: "skill-forget-confirm",
    label: "Skill Editor — Forget confirm (equipped fixture, blast radius listed)",
    path: "/?contextAttention=1#/skill/ds-tokens",
    // The header primary button (not the collapsible side panel) is the click
    // target, so waiting on the always-attached shell is enough here. A CSS
    // selector, not `getByRole` by name: below `--bp-nav` the primary's label
    // span goes `display:none` (icon-only), which drops it from the a11y
    // tree's accessible name entirely.
    waitFor: ".doc-editor-shell",
    prep: async (page) => {
      await page.locator(".main-header-right .btn-primary").first().click();
      await page
        .locator(".confirm-dialog")
        .waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS })
        .catch(() => {});
      await delay(200);
    },
  },

  {
    id: "project-hooks-compact",
    label: "Project hooks — equipped summary",
    path: "/#/project/example-app",
    waitFor: ".project-hooks-summary .chip",
    prep: async (page) => { await page.getByRole("button", { name: "Manage hooks", exact: true }).scrollIntoViewIfNeeded(); },
  },
  {
    id: "project-hooks-expanded",
    label: "Project hooks — inline editor",
    path: "/#/project/example-app",
    waitFor: ".project-hooks-summary .chip",
    prep: async (page) => {
      await page.getByRole("button", { name: "Manage hooks", exact: true }).click();
    },
  },
  {
    id: "project-loadout",
    label: "Project Workspace — Overview and grouped loadout",
    path: "/?projectOverview=1#/project/example-app",
    waitFor: ".area-strip",
  },
  {
    id: "project-missing-skills-review",
    label: "Project Loadout: review missing skills",
    path: "/?missingSkills=1#/project/moon-base",
    waitFor: ".area-strip",
    prep: async (page) => {
      await page.getByRole("button", { name: "Review missing skills" }).click();
      await page.getByRole("checkbox", { name: "Select review-helper", exact: true }).check();
    },
  },
  {
    id: "project-bundle-removal-pending",
    label: "Project Workspace — bundle removal in flight",
    path: "/#/project/moon-base",
    waitFor: ".area-strip",
    prep: async (page) => {
      await page.evaluate(() => { window.__IPC_DELAY_MS = 60_000; });
      await page.locator(".ws-band-overview .bundle-chip .remove").first().click();
      await page.mouse.move(0, 0);
      await delay(300);
    },
  },
  {
    id: "project-usage-rich",
    label: "Project Workspace — Usage-rich loadout",
    path: "/?usageRich=1#/project/moon-base",
    waitFor: ".project-activity-overview",
    prep: async (page) => {
      await page.locator(".project-activity-overview").scrollIntoViewIfNeeded();
      await page.mouse.move(0, 0);
    },
  },
  {
    id: "project-usage-area",
    label: "Project Workspace — Usage area",
    path: "/?usageRich=1#/project/moon-base?tab=usage",
    waitFor: ".usage-project-area",
  },
  {
    id: "project-usage-sessions",
    label: "Project Usage, recent sessions across harnesses",
    path: "/?usageRich=1&projectSessions=1#/project/moon-base?tab=usage",
    waitFor: 'section[aria-label="Sessions"]',
    prep: async (page) => {
      await page.locator('section[aria-label="Sessions"]').scrollIntoViewIfNeeded();
    },
  },
  {
    id: "project-usage-session-expanded",
    label: "Project Usage, shared expanded session details",
    path: "/?usageRich=1&projectSessions=1#/project/moon-base?tab=usage",
    waitFor: 'section[aria-label="Sessions"]',
    prep: async (page) => {
      const row = page.locator('[data-session-id="591ce7a6-72cc-4d7e-b6ca-3b6f7d7c3e2f"]');
      // The baseline has no disclosure; capture its original list.
      if (await row.count()) {
        await row.locator('.resource-disclosure').click();
        await row.locator('.usage-session-detail').waitFor({ state: 'visible' });
      }
      await page.locator('section[aria-label="Sessions"]').scrollIntoViewIfNeeded();
    },
  },
  {
    id: "project-agent-docs-tokens",
    label: "Project Workspace — Agent Docs with usage tokens",
    path: "/?usageRich=1#/project/moon-base?tab=agent-docs",
    // `[role="tab"]` is the Map tab that only exists below ~744px, so it cannot
    // anchor a prep-free scene the geometry sweep shoots at every width.
    waitFor: ".agent-docs-grid",
  },
  {
    // A prep removes this scene from the geometry sweep (SELECTED_SCENES).
    id: "project-usage-idle-explained",
    label: "Project Workspace — idle usage explanation",
    path: "/?usageIdle=1#/project/moon-base",
    waitFor: ".area-strip",
    prep: async (page) => {
      await page.locator('.project-loadout-row[data-member="deep-research"]').getByRole("button", { name: / details$/ }).click();
      const trigger = page.getByRole("button", { name: "Explain idle skill", exact: true });
      // The card is itself a button whose name absorbs the trigger label, hence `exact`;
      // the Popover closes on trailing scroll, hence scroll, settle, then click.
      await trigger.scrollIntoViewIfNeeded();
      await delay(300);
      await trigger.click();
      await page.locator(".idle-explanation").waitFor();
      await delay(250);
    },
  },
  {
    id: "project-usage-guidance",
    label: "Project Workspace — usage guidance",
    path: "/?usageRich=1#/project/moon-base?tab=usage",
    waitFor: ".usage-project-area",
    prep: async (page) => {
      // `Why` is a native <summary>, not a button.
      await page.locator("summary", { hasText: "Why" }).first().click();
      await page.locator(".usage-loadout-tick").first().scrollIntoViewIfNeeded();
      await delay(250);
    },
  },
  {
    id: "project-usage-review",
    label: "Project Workspace — usage review emphasis",
    path: "/?usageRich=1#/project/moon-base?tab=loadout&review=footprint-skill-brainstorm%3Aalpha",
    waitFor: ".area-strip",
    prep: async (page) => {
      await page.locator(".review-area-emphasis").waitFor({ state: "visible" });
      await page.locator('.project-loadout-row[data-reviewed="true"]').waitFor({ state: "visible" });
      // The emphasised card sits below the bundles and hooks; bring it in frame.
      await page.locator('.project-loadout-row[data-reviewed="true"]').first().scrollIntoViewIfNeeded();
      await delay(300);
    },
  },
  {
    id: "project-available-cost",
    label: "Project Workspace — Available prospective cost",
    path: "/?usageRich=1#/project/moon-base",
    waitFor: ".area-strip",
    prep: async (page) => {
      await page.getByRole("button", { name: "Add skills", exact: true }).click();
      await page.locator(".avail-cost").first().waitFor({ state: "visible" });
    },
  },
  {
    // AFTER-ONLY by construction: the name was plain text before, so there is
    // no hover state to photograph on the other side.
    id: "project-loadout-rename-hover",
    label: "Project Workspace — header name hovered (rename affordance)",
    path: "/#/project/moon-base",
    waitFor: ".area-strip",
    prep: async (page) => {
      await page.getByRole("button", { name: /^Rename project name/ }).hover();
      await delay(250);
    },
  },
  {
    // AFTER-ONLY by construction: the path crumb was static text before.
    id: "project-loadout-path-hover",
    label: "Project Workspace — path crumb hovered (opens Edit path)",
    path: "/#/project/moon-base",
    waitFor: ".area-strip",
    prep: async (page) => {
      await page.getByRole("button", { name: /^Edit project path/ }).hover();
      await delay(250);
    },
  },
  {
    // AFTER-ONLY by construction (same reason as the hover scene).
    id: "project-loadout-rename-edit",
    label: "Project Workspace — header name being edited (Save shown)",
    path: "/#/project/moon-base",
    waitFor: ".area-strip",
    prep: async (page) => {
      await page.getByRole("button", { name: /^Rename project name/ }).click();
      await page.getByRole("textbox", { name: "Project name" }).press("End");
      await page.keyboard.type("-two");
      await page.getByRole("button", { name: "Save" }).waitFor();
      await delay(250);
    },
  },
  {
    // AFTER-ONLY by construction: before this change the header's Sync button
    // had no busy state, so there is nothing to photograph on the other side.
    // `?syncHangs=1` parks the mocked `hub sync` so the in-flight frame can be
    // caught at all — the harness could not shoot a busy affordance before.
    id: "project-loadout-syncing",
    label: "Project Workspace — sync in flight",
    path: "/?syncHangs=1#/project/moon-base",
    waitFor: ".area-strip",
    prep: async (page) => {
      await page.getByRole("button", { name: /^Sync$/ }).click();
      await page.getByRole("button", { name: /Syncing…/ }).waitFor();
      await delay(400);
    },
  },
  {
    // ships_with (D2/D5, plans/ships-with wave E): equipping a skill that
    // declares companions gates on the consequence dialog before the write
    // (I1/A4) — the registry equip has already landed at exit 2, so this is
    // a consent screen, not a blocker. example-app (not moon-base) is the one
    // mock project with codex in its effective harnesses
    // (harnesses_global=["claude-code"] + project harnesses:["codex"]), so
    // it's the project that exercises BOTH harness groups and the codex
    // trust row (A2) — moon-base is claude-code only. No query flag is
    // needed to keep the dialog open: `gate.equip`'s promise does not
    // resolve until the user picks an action, so the collapsed default
    // (the state that must fit 520px) just sits there once `prep` opens it.
    id: "companion-consequence-dialog",
    label: "Project Loadout — ships_with equip consequence dialog (per-harness summary, codex trust row)",
    path: "/#/project/example-app",
    waitFor: ".area-strip",
    prep: async (page) => {
      // Below `ResizableSplit`'s min-main-width, the project workspace's
      // Available panel auto-collapses to a reopen tab
      // (`aria-label="Open Available"`) and the row lives in an overlay —
      // same idiom `openAgentDocsMap` already uses for its own split. At
      // 1440px there is no reopen tab (the panel is already docked), so
      // this is a no-op there.
      const reopen = page.locator(".resizable-split-reopen");
      if (await reopen.count()) await reopen.first().click().catch(() => {});
      const row = page.getByRole("button", { name: "Equip orchestrate-advanced" });
      await row.waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS });
      await row.click();
      await page
        .locator(".confirm-dialog .companion-harness-summary")
        .first()
        .waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS });
      await delay(200);
    },
  },
  {
    id: "project-agent-docs",
    label: "Project Workspace — Agent Docs",
    path: "/#/project/moon-base?tab=agent-docs",
    waitFor: '[role="tab"]',
    prep: async (page) => {
      // `ResizableSplit` collapses the map behind a "Map" tab below ~744px of
      // container width, so at 768 and 520 the filter row, the toggle, and the
      // imported rows are simply not on screen unless the overlay is opened
      // first. Capturing the collapsed state instead is how a narrow-width
      // regression in the new header goes unseen.
      await openAgentDocsMap(page);
      await delay(300);
    },
  },
  {
    id: "project-agent-docs-harness-manager",
    label: "Project Workspace — Agent Docs harness manager",
    path: "/#/project/moon-base?tab=agent-docs",
    waitFor: ".agent-docs-grid",
    prep: async (page) => {
      await openAgentDocsMap(page);
      await page
        .locator(".agent-docs-map:visible")
        .waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS });
      await page
        .getByRole("button", { name: "Manage", exact: true })
        .click();
      await page
        .getByRole("dialog", { name: "Harnesses for moon-base" })
        .waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS });
      await delay(300);
    },
  },
  {
    id: "project-agent-docs-filtered",
    label: "Project Workspace — Agent Docs (filtered)",
    path: "/#/project/moon-base?tab=agent-docs",
    waitFor: '[role="tab"]',
    prep: async (page) => {
      await openAgentDocsMap(page);
      const input = page.locator(".agent-docs-filter input");
      await input
        .waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS })
        .catch(() => {});
      // `architecture.md` lives only in the browse index, so this is the
      // hidden-match report plus its switch — the affordance that replaces
      // "no results" for a file that exists.
      await input.fill("architecture").catch(() => {});
      await delay(400);
    },
  },
  {
    id: "project-agent-docs-markdown",
    label: "Project Workspace — Agent Docs (all Markdown)",
    path: "/#/project/moon-base?tab=agent-docs",
    waitFor: '[role="tab"]',
    prep: async (page) => {
      // Open the collapsed map first, then flip "Show all Markdown files" so
      // the tree lists every .md — and, with it, the withheld-by-ignore-rules
      // report and its "Include them" escape hatch.
      await openAgentDocsMap(page);
      const toggle = page.locator('[data-testid="agent-docs-show-all-markdown"]');
      await toggle
        .waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS })
        .catch(() => {});
      await toggle.click().catch(() => {});
      await delay(400);
    },
  },
  {
    // The one project-scoped `renderChrome` header. Unphotographed until the
    // unified-header pass, so a regression here was invisible to the gallery.
    id: "project-permissions",
    label: "Project Workspace — Permissions",
    path: "/#/project/moon-base?tab=permissions",
    waitFor: ".main-header",
  },
  {
    id: "bundle-playbook-delete",
    label: "Bundle section inline delete confirmation",
    path: "/?bundlePlaybook=1#/bundle/android",
    waitFor: ".bundle-playbook .skill-row",
    prep: async (page) => {
      const heading = page.locator(".playbook-section-heading").first();
      await heading.hover();
      await heading.locator(".playbook-delete-trigger").click();
      await page.mouse.move(0, 0);
    },
  },
  {
    id: "bundle-playbook-sparse-detail",
    label: "Bundle row with sparse metadata and relationship stats",
    path: "/?bundlePlaybook=1#/bundle/android",
    waitFor: ".bundle-playbook .skill-row",
    prep: async (page) => { await page.locator('.playbook-skill[data-skill-name="android-jetpack-compose-material3-theming-helper"] .resource-disclosure').click(); await page.mouse.move(0, 0); },
  },
  {
    id: "bundle-playbook-detail",
    label: "Bundle skill expanded insight",
    path: "/?bundlePlaybook=1#/bundle/android",
    waitFor: ".bundle-playbook .skill-row",
    prep: async (page) => { await page.locator(".bundle-playbook .skill-row").first().locator(".resource-disclosure").click(); },
  },
  {
    id: "bundle-playbook",
    label: "Bundle playbook sections and shared skill rows",
    path: "/?bundlePlaybook=1#/bundle/android",
    waitFor: ".lib-list",
  },
  {
    id: "bundle-manager",
    label: "Library — bundle mode (android)",
    path: "/#/bundle/android",
    waitFor: '[data-testid="library-bundle-band"]',
  },
  {
    id: "bundle-global-menu",
    label: "Library — bundle Global switch",
    path: "/#/bundle/android",
    waitFor: '[data-testid="library-bundle-band"]',
    prep: async (page) => {
      await page.locator(".main-header").getByTestId("overflow-trigger").click();
    },
  },
  {
    id: "bundle-global-saving",
    label: "Library — bundle Global switch saving",
    path: "/?equipHangs=1#/bundle/android",
    waitFor: '[data-testid="library-bundle-band"]',
    prep: async (page) => {
      await page.locator(".main-header").getByTestId("overflow-trigger").click();
      await page.getByRole("menuitemcheckbox", { name: "Global" }).click();
      const toggle = page.getByRole("menuitemcheckbox", { name: "Global" });
      if ((await toggle.getAttribute("aria-busy")) !== "true") throw new Error("Global switch did not enter saving state");
    },
  },
  {
    // A bundle that FOLLOWS a source: a "Follows" tag in the header (the
    // scene key), every row locked (no remove action, a link glyph
    // instead), and Detach — not Add skills — in the overflow.
    id: "bundle-manager-linked",
    label: "Library — bundle mode, follows a source (membership locked)",
    path: "/#/bundle/org-pack",
    waitFor: '[data-testid="bundle-linked-lock"]',
  },
  {
    id: "global-permissions",
    label: "Global Permissions",
    path: "/#/permissions",
    waitFor: ".app-main",
  },
  {
    id: "mcp-permissions",
    label: "MCP editor — permissions block with stored tool decisions",
    path: "/#/skill/context7",
    waitFor: '[data-testid="mcp-permissions-block"]',
    prep: async (page) => {
      const block = page.getByTestId("mcp-permissions-block");
      await block.getByRole("combobox", { name: "All tools permission" }).click();
      await block.getByRole("option", { name: "Ask", exact: true }).click();
      await block.getByRole("combobox", { name: "search_docs permission" }).click();
      await block.getByRole("option", { name: "Deny", exact: true }).click();
      await block.getByRole("textbox", { name: "Search MCP tools" }).fill("search");
      await block.scrollIntoViewIfNeeded();
    },
  },
  {
    id: "mcp-permissions-picker",
    label: "Permissions — Add MCP permissions picker",
    path: "/#/permissions",
    waitFor: ".app-main",
    prep: async (page) => {
      await page.getByRole("button", { name: "Choose permission type" }).click();
      await page.getByRole("button", { name: /^MCP permissions/ }).click();
      const dialog = page.getByRole("dialog", { name: "Add MCP permissions" });
      await dialog.waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS });
      await dialog.getByRole("combobox", { name: "MCP server" }).selectOption("context7");
      await dialog.getByRole("combobox", { name: "All tools permission" }).click();
      await dialog.getByRole("option", { name: "Ask", exact: true }).click();
      await dialog.getByRole("combobox", { name: "search_docs permission" }).click();
      await dialog.getByRole("option", { name: "Deny", exact: true }).click();
      await dialog.getByRole("textbox", { name: "Search MCP tools" }).fill("search");
      await delay(250);
    },
  },
  {
    // The side panel's harness view: the Codex tab switches the panel to its
    // own facts + settings + the rules-file table (SPEC A). The real target
    // (`codex-rules-preview`) does not exist until `prep` clicks the Codex
    // tab (and, at narrow widths, reopens the collapsed panel first), so the
    // top-level `waitFor` targets something always visible on first load
    // (`.app-main`) and `prep` owns waiting for the real one.
    id: "global-permissions-codex",
    label: "Global Permissions — side panel, Codex harness view",
    path: "/#/permissions",
    waitFor: ".app-main",
    prep: openPermSidePanelCodexView,
  },
  {
    id: "project-permissions-codex",
    label: "Project Workspace — Permissions, side panel Codex harness view",
    path: "/#/project/moon-base?tab=permissions",
    waitFor: ".app-main",
    prep: openPermSidePanelCodexView,
  },
  {
    // ships_with provenance (D4/D5, A11/A12): a companion permission rule
    // reads `via orchestrate-advanced` — never amber, S2/S3. `?companionsProvisioned=1`
    // is the same flag `project-loadout`'s sibling scenes already reuse for the
    // moon-base ledger (D4); it now also seeds the two shipped rules into the
    // `permissions_show` twin (A12: a shipped rule lands where the project
    // block lands today), so the row this scene is about actually exists.
    id: "project-permissions-companion-provenance",
    label: "Project Workspace — Permissions, a shipped rule reads via orchestrate-advanced",
    path: "/?companionsProvisioned=1#/project/moon-base?tab=permissions",
    waitFor: '[data-testid="companion-tag"][data-word="via"]',
  },
  {
    id: "permissions-divergence",
    label: "Permissions — registry/native divergence banner",
    path: "/?permDivergence=1#/permissions",
    waitFor: ".perm-divergence-banner",
  },
  {
    id: "permissions-reconcile-review",
    label:
      "Permissions: reconcile dialog with general rules, specific approvals, and partial choices",
    path: "/?permDivergence=1#/permissions",
    // The dialog only exists after `prep` clicks Review, so the outer waitFor
    // targets what's on screen at load (mirrors the `permissions-divergence`
    // scene above) — `prep` does its own explicit wait for the dialog itself.
    waitFor: ".perm-divergence-banner",
    prep: async (page) => {
      await page
        .locator(".perm-divergence-banner")
        .getByRole("button", { name: /Review/ })
        .click()
        .catch(() => {});
      await page
        .locator('[role="dialog"] [data-testid="import-merged-row"]')
        .first()
        .waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS })
        .catch(() => {});
      await delay(300);
    },
  },
  {
    id: "snippets",
    label: "Snippets — landing redirect (content-first)",
    path: "/#/snippets",
    waitFor: ".doc-editor-shell",
  },
  {
    id: "snippets-detail",
    label: "Snippets — Detail (/snippet/:name, DocumentEditorShell)",
    path: "/#/snippet/android-conventions",
    waitFor: ".doc-editor-shell",
  },
  {
    id: "snippets-detail-dense",
    label:
      "Snippets — a row's overflow menu open: portalled to document.body, positioned off the trigger's own rect (flips above it near the list's end), past the capped well's clip",
    path: "/#/snippet/android-conventions",
    waitFor: ".equip-picker-search",
    prep: async (page) => {
      const trigger = page
        .locator(".snip-loc")
        .last()
        .locator('[data-testid="overflow-trigger"]');
      await trigger.scrollIntoViewIfNeeded().catch(() => {});
      // The capped list's own scroll needs a moment to settle before a click
      // lands reliably on a row this deep into it.
      await delay(300);
      await trigger.click().catch(() => {});
      await page.locator(".overflow-menu-panel").waitFor({ timeout: 2000 }).catch(() => {});
      await delay(150);
    },
  },
  {
    id: "snippets-detail-collapsed",
    label: "Snippets — Detail, Details panel COLLAPSED (editor must still render)",
    path: "/#/snippet/android-conventions",
    waitFor: ".doc-editor-shell",
    prep: async (page) => {
      // Collapse the Details panel — the editor body must not go blank.
      await page
        .getByRole("button", { name: "Collapse Details" })
        .click()
        .catch(() => {});
      await delay(250);
    },
  },
  {
    id: "snippet-new",
    label: "Snippets — create form",
    path: "/#/snippet/new",
    waitFor: ".snip-create, .resizable-split",
  },
  {
    id: "snippets-detail-scanning",
    label: "Snippets — body painted, applied-to scan still running (skeleton rows + header pill)",
    path: "/?snippetScanHangs=1#/snippet/android-conventions",
    waitFor: ".snip-usage-skel",
  },
  {
    id: "snippets-detail-save-refresh",
    label: "Snippets — body edited: Save reads 'Save & update N', the plaque says it refreshes them",
    path: "/#/snippet/android-conventions",
    waitFor: ".doc-editor-shell",
    prep: async (page) => {
      await page.locator(".snip-loc").first().waitFor().catch(() => {});
      const cm = page.locator(".doc-editor-body .cm-content");
      await cm.click().catch(() => {});
      await page.keyboard.press("ControlOrMeta+End").catch(() => {});
      await page.keyboard.type("\nOne more rule.").catch(() => {});
      await delay(200);
    },
  },
  {
    id: "snippets-detail-refreshing",
    label: "Snippets — Save & update in flight: busy button 'Updating N…', process card, rows marked updating (after-only: no honest before)",
    path: "/?snippetUpdateHangs=1#/snippet/android-conventions",
    waitFor: ".doc-editor-shell",
    prep: async (page) => {
      await page.locator(".snip-loc").first().waitFor().catch(() => {});
      const cm = page.locator(".doc-editor-body .cm-content");
      await cm.click().catch(() => {});
      await page.keyboard.press("ControlOrMeta+End").catch(() => {});
      await page.keyboard.type("\nOne more rule.").catch(() => {});
      await page.getByRole("button", { name: /Save & update/ }).click().catch(() => {});
      await page.locator(".snip-loc-refreshing").first().waitFor({ timeout: 4000 }).catch(() => {});
      await delay(200);
    },
  },
  {
    id: "snippets-detail-update-everywhere",
    label: "Snippets — 'Update everywhere' in flight: only the outdated rows read as updating (applied rows are not rewritten)",
    path: "/?snippetUpdateHangs=1#/snippet/android-conventions",
    waitFor: ".doc-editor-shell",
    prep: async (page) => {
      await page.locator(".snip-loc").first().waitFor().catch(() => {});
      await page.locator(".snip-update-all").click().catch(() => {});
      await page.locator(".snip-loc-refreshing").first().waitFor({ timeout: 4000 }).catch(() => {});
      await delay(200);
    },
  },
  {
    id: "sources",
    label: "Sources",
    path: "/#/sources",
    waitFor: ".source-card",
  },
  {
    // Batch resolution (spec decision 2: no new screen) — the Design System
    // card's "Dropped upstream · 2" block: a renamed row (Open successor +
    // Keep as local + Forget), a deleted row with its hedge line, the
    // error-toned "2 dropped" head count, and "Forget all 2".
    id: "sources-dropped",
    label: "Sources — Dropped upstream block (batch resolution on the card)",
    path: "/?contextAttention=1#/sources",
    waitFor: '[data-testid="source-dropped-design-system"]',
  },
  {
    // Toolbar working: a search term plus an active status facet, so the chip
    // counts, the sort control, and the narrowed card list are all in frame.
    id: "sources-filtered",
    label: "Sources — search + status filter",
    path: "/#/sources",
    waitFor: ".source-card",
    prep: async (page) => {
      await page
        .getByPlaceholder("Search sources by name, id, or URL…")
        .fill("s")
        .catch(() => {});
      await page
        .getByRole("button", { name: /^Errors/ })
        .click()
        .catch(() => {});
      await delay(DETAIL_EXPAND_SETTLE_MS);
    },
  },
  {
    // The per-card overflow menu open — home of rename / bundle ops / disable.
    id: "sources-menu",
    label: "Sources — card overflow menu",
    path: "/#/sources",
    waitFor: ".source-card",
    prep: async (page) => {
      await page
        .locator('button[title="Actions for Org Skills"]')
        .click()
        .catch(() => {});
      await page
        .locator(".overflow-menu-panel")
        .waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS })
        .catch(() => {});
    },
  },
  {
    // The create-bundle-from-source dialog: the reworked IconPicker (adaptive
    // tile grid + any-emoji slot) and the "Keep in sync with source" toggle,
    // inside a 520px modal — the narrow widths are the real test here.
    id: "sources-bundle-from-source",
    label: "Sources — create bundle from source (IconPicker + follow toggle)",
    path: "/#/sources",
    waitFor: ".source-card",
    prep: async (page) => {
      await page
        .locator('button[title="Actions for Org Skills"]')
        .click()
        .catch(() => {});
      await page
        .getByRole("menuitem", { name: "Create bundle from source…" })
        .click()
        .catch(() => {});
      await page
        .locator(".icon-picker-grid")
        .waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS })
        .catch(() => {});
      await delay(250);
    },
  },
  {
    id: "harnesses",
    label: "Harnesses",
    path: "/#/harnesses",
    waitFor: ".app-main",
  },
  {
    id: "harnesses-used-by-many",
    label: "Harnesses — USED BY truncated ('+N more')",
    path: "/?usedByMany=1#/harnesses",
    waitFor: ".harness-users-more",
  },
  {
    id: "harness-doc-editor",
    label: "Harness — Global instructions (claude-code)",
    path: "/#/harness/claude-code/doc",
    waitFor: ".doc-editor-shell",
  },
  {
    id: "harness-doc-editor-missing",
    label: "Harness — Global instructions (missing file)",
    // codex now FOLLOWS claude-code in the default mock (global-doc-sharing),
    // so pi — genuinely missing — is the harness that still demonstrates the
    // "Not created yet" plaque.
    path: "/#/harness/pi/doc",
    waitFor: ".doc-editor-shell",
  },
  {
    id: "harness-doc-editor-shared",
    label: "Harness — Global instructions (SHARED WITH, source for a follower)",
    path: "/#/harness/claude-code/doc",
    waitFor: "text=Shared with",
  },
  {
    id: "harness-doc-editor-follower",
    label: "Harness — Global instructions (follower plaque)",
    path: "/#/harness/codex/doc",
    waitFor: "text=Follows Claude Code",
  },
  {
    id: "harness-doc-editor-conflict",
    label: "Harness — Global instructions (SHARED WITH conflict confirm)",
    // The flag forces `hub harness doc link` to return the exit-2 conflict
    // shape regardless of the follower's real mock state, so the confirm is
    // deterministically reachable here.
    path: "/?docLinkConflict=1#/harness/claude-code/doc",
    waitFor: ".confirm-dialog",
    prep: async (page) => {
      await page
        .locator(".doc-editor-shell")
        .waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS });
      // From Claude Code's doc (a source), the opencode row is the one live
      // switch whose follower has its own text: Codex already follows this
      // doc, and a `source` row is disabled. Scope by the row's OWN label,
      // not a substring match on the row.
      await page
        .locator(".shared-with-row", {
          has: page.locator(".shared-with-row-label", { hasText: "opencode" }),
        })
        .locator('input[type="checkbox"]')
        .click();
      await delay(200);
    },
  },
  {
    id: "remotes-list",
    label: "Remotes — List",
    path: "/#/remotes",
    waitFor: ".remotes-screen",
  },
  {
    id: "remotes-detail",
    label: "Remotes — Detail",
    path: "/#/remote/hermes-main",
    waitFor: ".remote-detail",
  },
  {
    id: "remotes-wizard",
    label: "Remotes — Add wizard",
    path: "/#/remotes",
    waitFor: ".remotes-screen",
    prep: async (page) => {
      const btn = page
        .locator('button:has-text("Add remote")')
        .first();
      await btn.click().catch(() => {});
      await delay(300);
    },
  },
  {
    id: "library-equip-picker",
    label: "Library — Equip picker (row popover)",
    path: "/#/",
    waitFor: ".resource-row",
    prep: async (page) => {
      const row = page.locator(".resource-row").first();
      await row.hover().catch(() => {});
      await row
        .locator('button[title="Equip on…"]')
        .first()
        .click()
        .catch(() => {});
      await page
        .locator(".equip-popover")
        .waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS })
        .catch(() => {});
    },
  },
  {
    id: "library-filter-popover",
    label: "Library — Filter (inline at 1440, popover below)",
    path: "/#/",
    waitFor: "text=SKILL TREE",
    prep: async (page) => {
      // At 1440 the SOURCE/TRIGGER facets fit inline — there is no Filter
      // chip to click, so this `.catch` swallows the miss and the frame
      // shows the inline row. At a narrow capture width the row collapses to
      // a Filter chip and this click opens the popover.
      await page
        .locator('.chip:has-text("Filter")')
        .first()
        .click()
        .catch(() => {});
      await delay(250);
    },
  },
  {
    id: "remotes-detail-equip",
    label: "Remotes — Detail equip picker",
    path: "/#/remote/hermes-main",
    waitFor: ".remote-detail",
    prep: async (page) => {
      await page
        .locator('button:has-text("Equip")')
        .first()
        .click()
        .catch(() => {});
      await page
        .locator(".remote-equip-panel")
        .waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS })
        .catch(() => {});
    },
  },
  {
    id: "cloud-apps-band",
    label: "Remotes — Cloud apps band",
    path: "/#/remotes",
    waitFor: '[data-testid="cloud-apps"]',
    prep: async (page) => {
      await page
        .locator('[data-testid="cloud-apps"]')
        .scrollIntoViewIfNeeded()
        .catch(() => {});
      await delay(DETAIL_EXPAND_SETTLE_MS);
    },
  },
  {
    id: "cloud-detail",
    label: "Cloud — claude.ai detail",
    path: "/#/cloud/claude-ai",
    waitFor: ".cloud-detail",
  },
  {
    id: "cloud-detail-equip",
    label: "Cloud — claude.ai equip picker",
    path: "/#/cloud/claude-ai",
    waitFor: ".cloud-detail",
    prep: async (page) => {
      await page
        .locator('button:has-text("Equip")')
        .first()
        .click()
        .catch(() => {});
      await page
        .locator(".cloud-equip-panel")
        .waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS })
        .catch(() => {});
    },
  },
  {
    id: "cloud-detail-empty",
    label: "Cloud — ChatGPT (web), nothing equipped",
    path: "/#/cloud/chatgpt-web",
    waitFor: ".cloud-detail",
  },
  {
    id: "sources-conflict",
    label: "Sources — Add + conflict resolver",
    path: "/#/sources",
    waitFor: ".app-main",
    prep: async (page) => {
      await page
        .locator('button:has-text("Add source")')
        .first()
        .click()
        .catch(() => {});
      await page
        .getByPlaceholder("git@github.com:org/skills.git")
        .fill("git@github.com:org/pack.git")
        .catch(() => {});
      await page
        .locator('button:has-text("Preview")')
        .first()
        .click()
        .catch(() => {});
      await page
        .locator(".source-conflict-resolver")
        .waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS })
        .catch(() => {});
    },
  },
  {
    id: "sources-add-selection",
    label: "Sources — Add: deep link scoped + per-skill selection (2 of 3)",
    path: "/#/sources",
    waitFor: ".app-main",
    prep: async (page) => {
      await page
        .locator('button:has-text("Add source")')
        .first()
        .click()
        .catch(() => {});
      await page
        .getByPlaceholder("git@github.com:org/skills.git")
        .fill("https://github.com/cursor/plugins/tree/main/pstack/skills")
        .catch(() => {});
      await page
        .locator('button:has-text("Preview")')
        .first()
        .click()
        .catch(() => {});
      await page
        .locator('[data-testid="candidate-unslop"]')
        .waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS })
        .catch(() => {});
      // Deselect one NEW row so the subset note + "Import 2 of 3" both show.
      await page
        .getByLabel("Import pstack-audit")
        .click()
        .catch(() => {});
      await delay(DETAIL_EXPAND_SETTLE_MS);
    },
  },
  {
    id: "sources-add-path-not-found",
    label: "Sources — Add: scan path missing, with a one-click fix",
    path: "/#/sources",
    waitFor: ".app-main",
    prep: async (page) => {
      await page
        .locator('button:has-text("Add source")')
        .first()
        .click()
        .catch(() => {});
      await page
        .getByPlaceholder("git@github.com:org/skills.git")
        .fill("https://github.com/cursor/plugins")
        .catch(() => {});
      await page
        .getByTestId("source-path-input")
        .fill("skills/unslop")
        .catch(() => {});
      await page
        .locator('button:has-text("Preview")')
        .first()
        .click()
        .catch(() => {});
      await page
        .locator('[data-testid="source-path-error"]')
        .waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS })
        .catch(() => {});
    },
  },
  {
    id: "command-palette",
    label: "Command Palette",
    path: "/#/",
    waitFor: "text=SKILL TREE",
    prep: async (page) => {
      await page.keyboard.press("Meta+k");
      await delay(300);
    },
  },

  // ─── Usage (ccusage) ────────────────────────────────────────────────────────
  {
    // Capture-on-open (see `useCaptureOnOpen.ts`) fires a scan the instant
    // the cached-scan query settles with a null cache, so the old "no
    // cached scan yet" first-run copy is now transient — it flips to a
    // busy Refresh button and a "Scanning agent usage" process card almost
    // immediately. The mock hangs `usage_scan_ccusage` under this flag (see
    // `mocks/tauriCore.ts`) so this scene photographs that in-flight state
    // honestly instead of racing it.
    id: "usage-empty",
    label: "Usage — first scan in flight",
    path: "/?usageEmpty=1#/usage",
    waitFor: "text=Scanning agent usage",
  },
  {
    id: "usage-success",
    label: "Usage — fresh cached dashboard",
    path: "/#/usage",
    waitFor: "text=Largest sessions",
  },
  {
    id: "usage-day-detail",
    label: "Usage — selected day details",
    path: "/#/usage?day=2026-07-14",
    waitFor: ".usage-day-modal .usage-day-tools",
    prep: async (page) => { await page.locator(".usage-day-modal").waitFor({ state: "visible" }); },
  },
  {
    id: "usage-day-history-only",
    label: "Usage — day with token history only",
    path: "/?usageBackfilled=1#/usage?day=2026-05-18",
    waitFor: ".usage-day-modal .usage-day-notice",
    prep: async (page) => { await page.locator(".usage-day-modal").waitFor({ state: "visible" }); },
  },
  {
    id: "usage-week-detail",
    label: "Usage — selected week details",
    path: "/#/usage?week=2026-07-13",
    waitFor: ".usage-day-modal .usage-day-tools",
    prep: async (page) => { await page.locator(".usage-day-modal").waitFor({ state: "visible" }); },
  },
  {
    id: "usage-month-detail",
    label: "Usage — selected month details",
    path: "/#/usage?month=2026-07",
    waitFor: ".usage-day-modal .usage-day-tools",
    prep: async (page) => { await page.locator(".usage-day-modal").waitFor({ state: "visible" }); },
  },
  {
    id: "usage-permission-presets",
    label: "Usage — Add permission presets",
    path: "/#/usage",
    waitFor: "text=Largest sessions",
    prep: async (page) => {
      await page.getByRole("button", { name: "Add", exact: true }).click();
      await page.getByRole("dialog", { name: "Add permission presets" }).waitFor({ state: "visible" });
    },
  },
  {
    id: "usage-mcp-permissions",
    label: "Usage — Global MCP permission decisions",
    path: "/#/usage",
    waitFor: "text=Largest sessions",
    prep: async (page) => {
      await page.getByRole("button", { name: "Add", exact: true }).click();
      await page.getByRole("dialog", { name: "Add permission presets" }).getByRole("button", { name: "MCP permissions", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Add MCP permissions" });
      await dialog.getByRole("combobox", { name: "MCP server" }).selectOption("context7");
      await dialog.getByRole("combobox", { name: "All tools permission" }).click();
      await dialog.getByRole("option", { name: "Ask", exact: true }).click();
      await dialog.getByRole("combobox", { name: "search_docs permission" }).click();
      await dialog.getByRole("option", { name: "Deny", exact: true }).click();
      await dialog.getByRole("textbox", { name: "Search MCP tools" }).fill("search");
      await delay(250);
    },
  },
  {
    id: "usage-controls-stuck",
    label: "Usage — controls shelf pinned over cards",
    path: "/#/usage",
    waitFor: "text=Largest sessions",
    prep: async (page) => {
      await page.locator(".main-body").evaluate((el) => {
        el.scrollTop = 900;
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
    },
  },
  {
    id: "usage-heatmap-daily",
    label: "Usage — token activity daily",
    path: "/#/usage",
    waitFor: '[role="grid"][aria-label="Token activity, daily"]',
    prep: async (page) => {
      // The card sits below the fold at 1440; bring the whole band into frame.
      await page.locator(".usage-activity-card").scrollIntoViewIfNeeded();
    },
  },
  {
    id: "usage-heatmap-weekly",
    label: "Usage — token activity weekly",
    path: "/#/usage",
    waitFor: '[role="grid"][aria-label="Token activity, daily"]',
    prep: async (page) => {
      await page.getByRole("radio", { name: "Weekly" }).click();
      await page.locator('[role="grid"][aria-label="Token activity, weekly"]').waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS });
    },
  },
  {
    // On plain /#/usage, UsageSessionsCard always supplies `onInspect` for
    // every row (UsageSessionsCard.tsx ~:353), and UsageSessionItem only
    // offers its `Timeline` button when `onOpenTimeline && !onInspect`
    // (UsageSessionItem.tsx ~:199) — so an analysed Codex row here shows
    // `Inspect session`, never `Timeline` (UsageSessionsCard.test.tsx
    // "offers one inspection action for an analysed Codex row" asserts
    // exactly this). The prior wait for a `Timeline` button could never
    // resolve honestly on this route; wait for the affordance this route
    // actually renders for an analysed session instead.
    id: "usage-codex-analysis",
    label: "Usage — analysed Codex session detail affordance",
    path: "/#/usage",
    waitFor: '[data-testid="usage-session-row"]',
    prep: async (page) => {
      const row = page.getByTestId("usage-session-row").filter({ hasText: "Codex" }).first();
      await row.getByRole("button", { name: "Show session details" }).click();
      await row.getByRole("button", { name: "Inspect session" }).waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS });
    },
  },
  {
    id: "usage-project-area",
    label: "Usage — project drill-down area",
    path: "/?usageDrilldown=1#/usage/project/moon-base",
    waitFor: "text=Footprint",
  },
  {
    id: "usage-project-picker",
    label: "Usage — project picker",
    path: "/?pickerMany=1#/usage",
    waitFor: 'button[aria-label="Open project"]',
    prep: async (page) => {
      await page.getByRole("button", { name: "Open project" }).click();
      await page.getByRole("dialog", { name: "Open project" }).waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS });
    },
  },
  {
    id: "usage-project-activity",
    label: "Usage — project activity band",
    path: "/?usageDrilldown=1&usageRich=1#/usage/project/moon-base",
    waitFor: '[aria-label="Project activity"]',
    prep: async (page) => {
      await page.locator('[aria-label="Project activity"]').scrollIntoViewIfNeeded();
    },
  },
  {
    id: "usage-session-timeline",
    label: "Usage — captured session inspection timeline",
    path: "/#/usage/session/eeeeeeee-6666-4666-8666-666666666666?harness=claude-code",
    waitFor: '[data-testid="usage-inspection-timeline"]',
  },
  {
    id: "usage-session-timeline-pruned",
    label: "Usage — captured session timeline with explicit scale",
    path: "/?pruned=1#/usage/session/cccccccc-4444-4444-8444-444444444444?harness=claude-code",
    waitFor: '[data-testid="usage-timeline"]',
  },
  {
    id: "usage-session-not-scanned",
    label: "Usage — session inspection unavailable",
    path: "/?sessionMissing=1#/usage/session/cccccccc-4444-4444-8444-444444444444",
    waitFor: '[data-testid="usage-timeline-not-found"]',
  },
  {
    id: "usage-no-scan",
    label: "Usage — project with no scanned sessions",
    path: "/?noScan=1#/usage/project/moon-base",
    waitFor: "text=No scanned sessions yet",
  },
  {
    id: "usage-unregistered",
    label: "Usage — unregistered sessions bucket",
    path: "/?usageUnregistered=1#/usage",
    waitFor: "text=Unregistered",
  },
  {
    id: "usage-scan-inflight",
    label: "Usage — transcript scan in flight",
    path: "/?scanHangs=1#/usage/project/moon-base",
    waitFor: "text=Scanning transcripts",
    // This prep captures the busy geometry before the intentionally hung mock settles.
    // Because it has a prep, screen-geometry's automatic sweep covers the six prep-free scenes.
    prep: async (page) => {
      // Below 480px the header hides the primary label (shell-main.css `--bp-stack`), which also
      // drops its accessible name, so the prep selects the primary by class, not by role name.
      await page.locator(".main-header-right .btn-primary").first().click();
      await page.locator('[aria-busy="true"]').waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS });
      await delay(400);
    },
  },
  {
    id: "usage-over-time",
    label: "Usage — over-time activity band",
    path: "/#/usage",
    waitFor: '.usage-over-time[data-ready="true"]',
    prep: async (page) => {
      await page.locator(".usage-over-time").scrollIntoViewIfNeeded();
    },
  },
  {
    id: "usage-over-time-recent",
    label: "Usage — daily activity with quiet days",
    path: "/?usageRecent=1#/usage",
    waitFor: '.usage-over-time[data-ready="true"]',
    prep: async (page) => {
      await page.getByRole("radio", { name: "7 days", exact: true }).click();
      await page.locator('.usage-over-time[data-ready="true"]').waitFor();
      await page.locator(".usage-over-time").scrollIntoViewIfNeeded();
    },
  },
  {
    id: "usage-skill-picker",
    label: "Usage — searchable skill chart selection",
    path: "/#/usage",
    waitFor: '.usage-over-time[data-ready="true"]',
    prep: async (page) => {
      await page.getByRole("region", { name: "Skills used" }).evaluate((card) => card.scrollIntoView({ block: "center" }));
      await page.getByRole("region", { name: "Skills used" }).getByRole("button", { name: /Choose skills/ }).click();
      await page.getByRole("dialog", { name: "Choose skills" }).waitFor();
    },
  },
  {
    id: "usage-skill-search",
    label: "Usage — skill search with a custom comparison",
    path: "/#/usage",
    waitFor: '.usage-over-time[data-ready="true"]',
    prep: async (page) => {
      await page.getByRole("region", { name: "Skills used" }).evaluate((card) => card.scrollIntoView({ block: "center" }));
      await page.getByRole("region", { name: "Skills used" }).getByRole("button", { name: /Choose skills/ }).click();
      const dialog = page.getByRole("dialog", { name: "Choose skills" });
      await dialog.getByRole("button", { name: "Clear", exact: true }).click();
      await dialog.getByRole("searchbox", { name: "Search skills" }).fill("deliver");
      await dialog.getByRole("option", { name: /^deliver-it/ }).click();
    },
  },
  {
    id: "usage-over-time-hover",
    label: "Usage — over-time hover detail",
    path: "/#/usage",
    waitFor: '.usage-over-time[data-ready="true"]',
    prep: async (page) => {
      await page.locator('[aria-label="Skills used"]').scrollIntoViewIfNeeded();
      const plot = page.locator('[aria-label="Skills used"] .line-chart-area');
      // Playwright positions are pixels, not fractions.
      const box = await plot.boundingBox();
      await plot.hover({ position: { x: box.width * 0.4, y: box.height / 2 } });
    },
  },
  {
    id: "usage-peaks",
    label: "Usage — weekday and UTC-hour token peaks",
    path: "/#/usage",
    waitFor: '.usage-over-time[data-ready="true"]',
    prep: async (page) => {
      await page.locator(".usage-peaks-card").scrollIntoViewIfNeeded();
    },
  },
  {
    id: "usage-model-mix",
    label: "Usage — six-model cost mix with hover detail",
    path: "/?usageModelMix=1#/usage",
    waitFor: '.usage-over-time[data-ready="true"]',
    prep: async (page) => {
      const card = page.locator('[aria-label="Model mix"]');
      await card.scrollIntoViewIfNeeded();
      const columns = card.locator(".chart-col");
      const middle = Math.floor((await columns.count()) / 2);
      await columns.nth(middle).hover({ position: { x: 3, y: 92 } });
    },
  },
  {
    id: "usage-success-big",
    label: "Usage — real-world magnitudes (billions of tokens, thousands of dollars)",
    path: "/?usageBig=1#/usage",
    waitFor: "text=Largest sessions",
  },
  {
    id: "usage-success-long",
    label: "Usage — 40+ day axis (thinned labels, one shared baseline)",
    path: "/?usageLong=1#/usage",
    waitFor: "text=Largest sessions",
  },
  {
    id: "usage-unpriced-models",
    label: "Usage — a model with tokens but no price reads as unpriced, not $0.00",
    path: "/?usageUnpriced=1#/usage",
    waitFor: "text=Largest sessions",
  },
  {
    id: "usage-session-labels",
    label: "Usage — long session titles keep metadata and totals visible",
    path: "/?codexFamilies=1&longSessionTitles=1#/usage",
    waitFor: ".usage-session-title",
    prep: async (page) => {
      await page.locator('.usage-session-title').filter({ hasText: '$plan-it Support invocation modes' }).scrollIntoViewIfNeeded();
    },
  },
  {
    id: "usage-session-detail",
    label: "Usage — session drill-down: an expanded row's Tokens/Models/Activity detail",
    path: "/#/usage",
    waitFor: "text=Largest sessions",
    prep: async (page) => {
      await page.locator('[data-testid="usage-session-row"]').first().click().catch(() => {});
      await page
        .locator(".usage-session-detail")
        .waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS })
        .catch(() => {});
    },
  },
  ...["complete", "partial"].map((state) => ({
    id: `usage-tokens-${state}`,
    label: `Usage token capture: ${state}`,
    path: `/?inspection=1&usageTokens=${state}#/usage`,
    waitFor: "text=Largest sessions",
    prep: async (page) => {
      const row = page.locator('[data-session-id="eeeeeeee-6666-4666-8666-666666666666"]');
      await row.waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS });
      await row.scrollIntoViewIfNeeded();
      await row.locator(".usage-session-title, .usage-session-fallback").first().click();
      await row.locator(".usage-session-detail").waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS });
    },
  })),
  ...["observed", "partial", "unavailable"].map((state) => ({
    id: `usage-native-${state}`,
    label: `Usage native evidence: ${state}`,
    path: `/?inspection=1&usageNative=${state}#/usage`,
    waitFor: "text=Largest sessions",
    prep: async (page) => {
      const row = page.locator('[data-session-id="eeeeeeee-6666-4666-8666-666666666666"]');
      await row.waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS });
      await row.locator(".usage-session-title, .usage-session-fallback").first().click();
      await row.locator(".usage-session-detail").waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS });
      await row.locator(".usage-session-detail").scrollIntoViewIfNeeded();
    },
  })),
  {
    id: "usage-session-family-expanded",
    label: "Usage — an expanded agent family row: one summary, no second agent list",
    path: "/?codexFamilies=1#/usage",
    waitFor: "text=Largest sessions",
    prep: async (page) => {
      const row = page
        .locator('[data-testid="usage-session-row"]')
        .filter({ hasText: "Usage identity rollout" });
      await row.waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS });
      await row.getByRole("button", { name: "Show session details" }).click();
      await row
        .locator(".usage-session-detail")
        .waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS })
        .catch(() => {});
    },
  },
  {
    id: "usage-session-sheet",
    label: "Usage — shared session inspector: timeline, evidence, and pin control",
    path: "/?inspection=1#/usage",
    waitFor: "text=Largest sessions",
    prep: async (page) => {
      const row = page.locator('[data-session-id="eeeeeeee-6666-4666-8666-666666666666"]');
      await row.waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS });
      await row.locator(".usage-session-title, .usage-session-fallback").first().click();
      await row.getByRole("button", { name: "Inspect session" }).click();
      await page.locator('[data-testid="usage-session-sheet"]').waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS });
      await page.locator('[data-testid="usage-inspection-timeline"]').waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS });
    },
  },
  {
    id: "usage-session-sheet-tools",
    label: "Usage — shared inspector: grouped Tool calls and retained bodies",
    path: "/?inspection=1#/usage",
    waitFor: "text=Largest sessions",
    prep: async (page) => {
      const row = page.locator('[data-session-id="ffffffff-7777-4777-8777-777777777777"]');
      await row.waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS });
      await row.locator(".usage-session-title, .usage-session-fallback").first().click();
      await row.getByRole("button", { name: "Inspect session" }).click();
      const sheet = page.locator('[data-testid="usage-session-sheet"]');
      await sheet.waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS });
      const panel = sheet.locator('[data-testid="usage-inspection-panel"]');
      await panel.waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS });
      await panel.getByRole("radio", { name: "Tool calls" }).click();
      const group = panel.locator(".usage-tool-group-toggle").first();
      await group.waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS });
      await group.click();
      const input = panel.getByRole("button", { name: /Input: available/ }).first();
      await input.waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS });
      await input.click();
      await panel.getByRole("region", { name: "Captured body" }).getByText(/git status/).waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS });
    },
  },
  {
    id: "usage-session-sheet-changes",
    label: "Usage — shared inspector: Changes with attribution and file evidence",
    path: "/?inspection=1#/usage",
    waitFor: "text=Largest sessions",
    prep: async (page) => {
      const row = page.locator('[data-session-id="ffffffff-7777-4777-8777-777777777777"]');
      await row.waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS });
      await row.locator(".usage-session-title, .usage-session-fallback").first().click();
      await row.getByRole("button", { name: "Inspect session" }).click();
      const sheet = page.locator('[data-testid="usage-session-sheet"]');
      await sheet.waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS });
      const panel = sheet.locator('[data-testid="usage-inspection-panel"]');
      await panel.waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS });
      await panel.getByRole("radio", { name: "Changes" }).click();
      const change = panel
        .locator(".usage-inspection-change")
        .filter({ hasText: "confirmed" })
        .filter({ hasText: "demo.txt" })
        .filter({ hasText: "tool patch" });
      await change.waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS });
      await change.getByRole("button", { name: "Open retained patch body" }).click();
      const patchBody = panel.getByRole("region", { name: "Captured body" }).locator("pre");
      await patchBody.waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS });
      await patchBody.getByText(/\*\*\* Update File: demo\.txt/).waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS });
    },
  },
  {
    id: "usage-session-sheet-pr-picker",
    label: "Usage — full-route inspector: additional PR evidence picker",
    path: "/#/usage/session/ffffffff-7777-4777-8777-777777777777?harness=codex",
    waitFor: '[data-testid="usage-inspection-panel"]',
    prep: async (page) => {
      await page.getByText(/Additional PR evidence/).click();
      const links = page.locator(".usage-pr-link");
      await links.nth(1).waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS });
      const repositories = new Set(await links.evaluateAll((items) => items.map((item) => item.textContent?.split(" · ")[1]).filter(Boolean)));
      if (repositories.size < 2) throw new Error("Expected PR evidence from two generated repositories");
    },
  },
  {
    id: "usage-session-row-pr-picker",
    label: "Usage — captured session row PR picker without opening the sheet",
    path: "/?inspection=1#/usage",
    waitFor: "text=Largest sessions",
    prep: async (page) => {
      const row = page.locator('[data-session-id="ffffffff-7777-4777-8777-777777777777"]');
      await row.waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS });
      const picker = row.locator(".usage-row-pr-picker");
      await picker.locator("summary").click();
      await picker.locator(".usage-pr-link").nth(1).waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS });
      if (await page.locator('[data-testid="usage-session-sheet"]').count()) throw new Error("Row PR picker opened the inspector sheet");
    },
  },
  {
    id: "usage-pinned-sessions",
    label: "Usage — pinned agent subtree sessions",
    path: "/#/usage/pinned",
    waitFor: "text=Pinned sessions",
    prep: async (page) => {
      await page
        .locator(".usage-pinned-item")
        .filter({ hasText: "codex" })
        .filter({ hasText: "agent subtree" })
        .first()
        .waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS });
    },
  },
  {
    id: "usage-prices-popover",
    label: "Usage — price transparency: source, overrides, unpriced models, online-pricing opt-in",
    path: "/#/usage",
    waitFor: "text=Largest sessions",
    prep: async (page) => {
      await page.getByRole("button", { name: "Prices" }).click().catch(() => {});
      await page
        .locator("text=Skill Tree overrides")
        .waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS })
        .catch(() => {});
    },
  },
  {
    id: "usage-no-usage",
    label: "Usage — no local usage found",
    path: "/?usageNoUsage=1#/usage",
    waitFor: "text=No local harness usage was detected yet",
  },
  {
    id: "usage-access-error",
    label: "Usage — permission/local access issue",
    path: "/?usageAccessError=1#/usage",
    waitFor: "text=Skill Tree cannot access local usage logs",
  },
  {
    id: "usage-ccusage-failure",
    label: "Usage — ccusage failure diagnostics",
    path: "/?usageFailure=1#/usage",
    waitFor: "text=ccusage could not finish the scan",
  },
  {
    id: "usage-backfilled",
    label: "Usage — backfilled ledger days, faded segments + legend note",
    path: "/?usageBackfilled=1#/usage",
    waitFor: "text=from Claude Code's own stats",
  },
  {
    id: "statusbar-sync-drawer",
    label: "StatusBar — Sync report drawer + error chip (freshness + affinity skips)",
    // `?syncError=1` serves the failure envelope (error + stale + affinity skips)
    // so the chip's error state AND the drawer's failure row get one dedicated
    // frame set; the default mock is all-ok ("in sync") for every other scene.
    path: "/?syncError=1#/",
    waitFor: ".app-status",
    prep: async (page) => {
      await page.locator(".sync-chip").first().click().catch(() => {});
      await page
        .locator(".sync-report-drawer")
        .first()
        .waitFor({ state: "visible", timeout: SYNC_REPORT_DRAWER_WAIT_MS })
        .catch(() => {});
      // Expand the first row carrying detail (errors / affinity skips).
      await page
        .locator(".srd-row-head[data-detail]")
        .first()
        .click()
        .catch(() => {});
      await delay(DETAIL_EXPAND_SETTLE_MS);
    },
  },

  // ─── Command layer (ux-command-layer) ─────────────────────────────────────

  {
    id: "cheatsheet-overlay",
    label: "Shortcut Cheatsheet (?)",
    path: "/#/sources",
    waitFor: ".app-main",
    prep: async (page) => {
      await page.evaluate(() => document.activeElement?.blur?.());
      await page.keyboard.press("Shift+Slash"); // "?"
      await page.waitForSelector(".cheatsheet-row[data-binding-id]");
      await delay(200);
    },
  },
  {
    id: "palette-verb-stage",
    label: "Command Palette — verb argument stage",
    path: "/#/",
    waitFor: "text=SKILL TREE",
    prep: async (page) => {
      await page.keyboard.press("ControlOrMeta+k");
      await page.waitForSelector(".palette input");
      await page.fill(".palette input", "Equip skill");
      await page.click("text=Equip skill…");
      await page.waitForSelector(".palette-crumbs");
      // Advance one stage so the breadcrumb shows a picked argument.
      await page.click('.palette-item:has-text("deep-research")');
      await page.waitForSelector('.palette-crumbs:has-text("deep-research")');
      await delay(200);
    },
  },
  {
    id: "chord-pending-indicator",
    label: "StatusBar — chord pending indicator",
    path: "/#/sources",
    waitFor: ".app-main",
    prep: async (page) => {
      await page.evaluate(() => document.activeElement?.blur?.());
      await page.keyboard.press("g"); // arm the pending prefix
      await page.waitForSelector(".chord-pending-chip");
      await delay(150);
    },
  },

  {
    id: "skill-agent-editor",
    label: "Skill-owned agent — shared prompt and separate model settings",
    path: "/#/skill/orchestrate-advanced/agent/orch-implementer",
    waitFor: ".skill-agent-editor .cm-content",
    prep: async (page) => {
      await openDetailsSidePanel(page);
    },
  },
  // ─── Sub-agents (Wave 6) ─────────────────────────────────────────────────────
  {
    id: "subagents-harness-empty",
    label: "Sub-agents — Harness config (Codex, genuinely empty)",
    // `subagentsEmpty` flag → subagent_list returns zero agents so the EmptyState
    // renders (the default codex store is populated — was a scene-wiring bug).
    path: "/?subagentsEmpty=1#/harness/codex",
    waitFor: ".empty-state",
  },
  {
    id: "subagents-list",
    label: "Sub-agents — List (populated · disabled · invalid + built-ins)",
    // User scope seeds: code-reviewer (skills), doc-writer, legacy-helper
    // (disabled + validity dot) + the built-ins strip.
    path: "/#/harness/claude-code",
    waitFor: ".subagent-list",
  },
  {
    id: "subagents-new-sheet",
    label: "Sub-agents — New-agent sheet",
    path: "/#/harness/claude-code",
    waitFor: ".subagent-list",
    prep: async (page) => {
      await page
        .locator('button:has-text("New sub-agent")')
        .first()
        .click()
        .catch(() => {});
      await delay(300);
    },
  },
  {
    id: "subagents-editor-clean",
    label: "Sub-agents — Editor (clean) + attach-skills picker",
    path: "/#/harness/claude-code",
    waitFor: ".subagent-list",
    prep: async (page) => {
      await page
        .locator('.subagent-card:has-text("code-reviewer")')
        .first()
        .click()
        .catch(() => {});
      await page
        .locator(".subagent-editor")
        .first()
        .waitFor({ state: "visible", timeout: 6000 })
        .catch(() => {});
      await delay(300);
    },
  },
  {
    id: "subagents-editor-unsaved",
    label: "Sub-agents — Editor (unsaved)",
    path: "/#/harness/claude-code",
    waitFor: ".subagent-list",
    prep: async (page) => {
      await page
        .locator('.subagent-card:has-text("code-reviewer")')
        .first()
        .click()
        .catch(() => {});
      await page
        .locator(".subagent-editor")
        .first()
        .waitFor({ state: "visible", timeout: 6000 })
        .catch(() => {});
      // Type into the body to flip the UNSAVED pill.
      await page
        .locator(".doc-editor-body .cm-content")
        .click()
        .catch(() => {});
      await page.keyboard.type(" edited").catch(() => {});
      await delay(300);
    },
  },
  {
    id: "subagents-editor-error",
    label: "Sub-agents — Editor (validation error)",
    path: "/#/harness/claude-code",
    waitFor: ".subagent-list",
    prep: async (page) => {
      await page
        .locator('.subagent-card:has-text("code-reviewer")')
        .first()
        .click()
        .catch(() => {});
      await page
        .locator(".subagent-editor")
        .first()
        .waitFor({ state: "visible", timeout: 6000 })
        .catch(() => {});
      // The name field lives in the header now (InlineName) — open it and
      // type an invalid value so its own inline error renders.
      await page
        .getByRole("button", { name: /Rename agent name/i })
        .click()
        .catch(() => {});
      await page
        .getByRole("textbox", { name: "Agent name" })
        .fill("Bad Name")
        .catch(() => {});
      await delay(300);
    },
  },
  {
    id: "subagents-editor-advanced",
    label: "Sub-agents — Editor (advanced YAML open)",
    // legacy-helper seeds advanced_yaml; Advanced is closed by default (the
    // summary states "custom keys" / "none"), so open it explicitly.
    path: "/#/harness/claude-code",
    waitFor: ".subagent-list",
    prep: async (page) => {
      await page
        .locator('.subagent-card:has-text("legacy-helper")')
        .first()
        .click()
        .catch(() => {});
      await page
        .getByRole("button", { name: /^Advanced \(raw/ })
        .click()
        .catch(() => {});
      await page
        .locator(".subagent-advanced-yaml")
        .first()
        .waitFor({ state: "visible", timeout: 6000 })
        .catch(() => {});
      await delay(300);
    },
  },
  {
    id: "subagents-project-tab",
    label: "Sub-agents — Project tab",
    path: "/#/project/moon-base",
    waitFor: ".area-strip",
    prep: async (page) => {
      await clickAreaCard(page, "subagents");
      await page
        .locator(".subagent-list")
        .first()
        .waitFor({ state: "visible", timeout: 6000 })
        .catch(() => {});
      await delay(300);
    },
  },
  {
    id: "subagents-skill-preload",
    label: "Sub-agents — Skill 'Preloaded by' + attach picker",
    // code-review is preloaded by the seeded code-reviewer agent. The attach
    // picker spans harnesses (Claude + Codex) → glyphs per option.
    path: "/#/skill/code-review",
    waitFor: ".side-panel-block",
    prep: async (page) => {
      await page
        .locator('button:has-text("Attach to sub-agent")')
        .first()
        .click()
        .catch(() => {});
      await page
        .locator(".skill-attach-picker")
        .first()
        .waitFor({ state: "visible", timeout: 6000 })
        .catch(() => {});
      await delay(300);
    },
  },

  // ─── Codex sub-agents (Wave 7) ───────────────────────────────────────────────
  {
    id: "subagents-codex-list",
    label: "Sub-agents — Codex list (agents + built-ins · project pill gated)",
    // Codex user store: pr_explorer, release_captain, shared-agent (linked),
    // twin-suggest (suggested) + the read-only built-ins strip.
    path: "/#/harness/codex",
    waitFor: ".subagent-list",
  },
  {
    id: "subagents-codex-editor",
    label: "Sub-agents — Codex editor (sandbox + effort + advanced TOML + foreign)",
    // release_captain carries advanced TOML (custom_key) + a foreign, disabled
    // skills.config entry → the read-only "Other skill entries" list.
    path: "/#/harness/codex",
    waitFor: ".subagent-list",
    prep: async (page) => {
      await page
        .locator('.subagent-card:has-text("release_captain")')
        .first()
        .click()
        .catch(() => {});
      await page
        .locator(".subagent-editor")
        .first()
        .waitFor({ state: "visible", timeout: 6000 })
        .catch(() => {});
      await delay(300);
    },
  },
  {
    id: "subagents-codex-editor-clean",
    label: "Sub-agents — Codex editor (clean · sandbox radios + effort)",
    path: "/#/harness/codex",
    waitFor: ".subagent-list",
    prep: async (page) => {
      await page
        .locator('.subagent-card:has-text("pr_explorer")')
        .first()
        .click()
        .catch(() => {});
      await page
        .locator(".subagent-editor")
        .first()
        .waitFor({ state: "visible", timeout: 6000 })
        .catch(() => {});
      await delay(300);
    },
  },

  // ─── Linked twins (Wave 7) ───────────────────────────────────────────────────
  {
    id: "subagents-drift-banner",
    label: "Sub-agents — Linked editor + drift banner (both sides shown)",
    // shared-agent is linked with a drifted `description` → the drift banner
    // renders both harness values with a per-field winner choice.
    path: "/#/harness/claude-code",
    waitFor: ".subagent-list",
    prep: async (page) => {
      await page
        .locator('.subagent-card:has-text("shared-agent")')
        .first()
        .click()
        .catch(() => {});
      await page
        .locator(".subagent-drift-banner")
        .first()
        .waitFor({ state: "visible", timeout: 6000 })
        .catch(() => {});
      await delay(300);
    },
  },
  {
    id: "subagents-link-suggestion",
    label: "Sub-agents — Link suggestion chip (same-named unlinked pair)",
    // twin-suggest exists in both stores but is unlinked → suggestion chip on
    // the list card.
    path: "/#/harness/claude-code",
    waitFor: ".subagent-list",
    prep: async (page) => {
      await page
        .locator('.subagent-link-chip[data-tone="suggest"]')
        .first()
        .waitFor({ state: "visible", timeout: 6000 })
        .catch(() => {});
      await delay(200);
    },
  },

  // ─── Attach-skill provisioning (Wave 7) ──────────────────────────────────────
  {
    id: "subagents-provision-panel",
    label: "Sub-agents — Provisioning consequence panel (make-global)",
    // Attaching the unresolved `needs-global` skill to doc-writer then Saving
    // raises the consequence-disclosure panel (no write until confirmed).
    path: "/#/harness/claude-code",
    waitFor: ".subagent-list",
    prep: async (page) => {
      await page
        .locator('.subagent-card:has-text("doc-writer")')
        .first()
        .click()
        .catch(() => {});
      await page
        .locator(".subagent-editor")
        .first()
        .waitFor({ state: "visible", timeout: 6000 })
        .catch(() => {});
      // Check the unresolved provisioning skill, then Save to trigger the prompt.
      // (Locator forms mirror e2e/provisioning.journey.spec.ts, which is proven.)
      // Short timeouts: at narrow widths the guided form (side panel) collapses
      // to an overlay, so these controls aren't actionable — fail fast instead
      // of blocking on the default 30s action timeout.
      await page
        .locator('.subagent-skill-row:has-text("needs-global") input[type="checkbox"]')
        .first()
        .check({ timeout: 1500 })
        .catch(() => {});
      await page
        .locator("button", { has: page.locator(".btn-label", { hasText: /^Save$/ }) })
        .first()
        .click({ timeout: 1500 })
        .catch(() => {});
      // The panel renders at the top of the form column — scroll it into the
      // frame (Playwright "visible" does not imply in-viewport).
      const panel = page.locator(".subagent-provision-panel").first();
      await panel.waitFor({ state: "visible", timeout: 6000 }).catch(() => {});
      await panel.scrollIntoViewIfNeeded().catch(() => {});
      await delay(300);
    },
  },

  // ─── Hooks (hooks-surface) ───────────────────────────────────────────────────
  {
    id: "hooks-library",
    label: "Hooks — Library (builtin + user · mixed reach badges)",
    // `?hookCapsVaried=1` → claude-code supported / codex feature_off / opencode
    // unsupported / pi not_installed, so the row reach badges show the full
    // state palette (green + neutral, not_installed omitted).
    path: "/?hookCapsVaried=1#/hooks",
    waitFor: ".hooks-list",
  },
  {
    id: "hooks-empty",
    label: "Hooks — empty library (EmptyState)",
    path: "/?hooksEmpty=1#/hooks",
    waitFor: ".empty-state",
  },
  {
    id: "hooks-library-health",
    label: "Hooks — Library (doctor health badges · danger/warning/info rows)",
    path: "/?hookDoctorFindings=1#/hooks",
    waitFor: ".hooks-list",
  },
  {
    // Wave 4c unit 5 (plans/3.md §2.3/§3.4/§6.6) — the reverse direction's
    // FIRST stage: an untagged Hooks row's ghost "Ship with…" button
    // (`ship-with-open`, the mock's first row — `lsp-report` — is shipped by
    // no skill) opens the shared `useShipWith()` flow's skill-picker `Modal`
    // (`SkillPickerModal`), not a Sheet: a pick is a decision. Named
    // `hooks-ship-with-*`, NOT `skill-editor-…`/`…-edit` (grill #15) — neither
    // id matches `/editor/i`, so neither enters
    // `screen-geometry.journey.spec.ts`'s SELECTED_SCENES despite carrying a
    // `prep`; that gate's coverage for this surface stays with
    // `skill-editor-ships-with-edit`, unchanged by this wave.
    id: "hooks-ship-with-picker",
    label: "Hooks — Ship with… skill picker (untagged row)",
    path: "/#/hooks",
    waitFor: ".hooks-list",
    prep: async (page) => {
      // No `.catch` on the click or the picker wait — a swallowed failure
      // here is the exact "rung the capture silently never found" bug
      // `skill-editor-ships-with-edit`'s own comment names; let it fail loudly.
      await page.locator('[data-testid="ship-with-open"]').first().click();
      await page
        .locator(".ship-with-picker")
        .waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS });
      await delay(300);
    },
  },
  {
    // The flow's SECOND stage: picking an eligible skill (`orchestrate-
    // advanced`, already shipping three OTHER hooks — not `lsp-report` — so
    // its row is enabled) advances the picker straight to the seeded
    // `CompanionsEditSheet` (`useShipWith`'s `pick()`), with the target row
    // marked `data-seeded="true"` (§3.3) — the literal reverse of today's
    // read-only `CompanionTag`.
    id: "hooks-ship-with-seeded",
    label: "Hooks — Ship with… seeded companions sheet (orchestrate-advanced)",
    path: "/#/hooks",
    waitFor: ".hooks-list",
    prep: async (page) => {
      await page.locator('[data-testid="ship-with-open"]').first().click();
      await page
        .locator(".ship-with-picker")
        .waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS });
      await page
        .locator('.ship-with-picker [role="option"]', { hasText: "orchestrate-advanced" })
        .click();
      await page
        .locator(".companions-edit-sheet")
        .waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS });
      await page
        .locator('[data-seeded="true"]')
        .waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS });
      await delay(300);
    },
  },
  {
    id: "hook-editor-health",
    label: "Hooks — Editor (doctor findings banner under the summary)",
    path: "/?hookDoctorFindings=1#/hook/format-on-write",
    waitFor: ".hook-health",
  },
  {
    id: "hook-editor-builtin",
    label:
      "Hooks — Editor (built-in lsp-report · read-only summary rows + primary settings)",
    path: "/?hookCapsVaried=1#/hook/lsp-report",
    waitFor: ".lsp-lang-table",
  },
  {
    id: "hook-editor-user",
    label: "Hooks — Editor (user hook · fully editable fields)",
    path: "/#/hook/notify-on-stop",
    waitFor: ".hook-editor",
  },
  {
    id: "hook-editor-settings-dirty",
    label:
      "Hooks — Editor (SETTINGS force-open + UNSAVED pill in the closed head — AUDIT M6)",
    path: "/#/hook/notify-on-stop",
    waitFor: '[data-testid="side-section-settings"]',
    prep: async (page) => {
      // Dirty the generic settings JSON draft, then collapse the section by
      // hand — `forceOpen` must keep it visibly open with the pill legible
      // (never clipped) even though the user just tried to close it.
      const box = page.locator('textarea[aria-label="settings JSON"]');
      await box.waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS });
      await box.fill('{"voice": "Karen", "retries": 5}');
      await page
        .locator('[data-testid="side-section-settings"]')
        .click({ force: true }) // the head is `disabled` while forced — proves the click is inert
        .catch(() => {});
      await delay(150);
    },
  },
  {
    id: "hook-editor-script",
    label: "Hooks — Editor (managed script · in-app body editor + tool picker)",
    path: "/#/hook/format-on-write",
    waitFor: ".hook-script-body",
    prep: async (page) => {
      // Open the tool picker so the D2 progressive-disclosure surface (chips +
      // filter + collapsible groups) is in frame at every width — it is the
      // element most at risk of overflowing at 520px.
      await page
        .locator('[aria-label="Applies to"] .chip', { hasText: "Specific tools" })
        .click()
        .catch(() => {});
      await page
        .locator(".tool-picker")
        .waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS })
        .catch(() => {});
      await delay(150);
    },
  },
  {
    id: "hook-editor-new",
    label: "Hooks — Editor (create mode · progressive defaults)",
    path: "/#/hook/new",
    waitFor: ".hook-editor",
  },
  {
    id: "hook-editor-command-script",
    label:
      "Hooks — Editor (command hook naming a repo script · read-only source + convert offer)",
    path: "/#/hook/lint-on-edit",
    waitFor: ".hook-command-script",
  },
  {
    id: "hooks-palette-attach-consequence",
    label: "Hooks — Palette Attach, global-scope consequence dialog",
    path: "/#/",
    waitFor: "text=SKILL TREE",
    prep: async (page) => {
      await page.keyboard.press("ControlOrMeta+k");
      await page.waitForSelector(".palette input").catch(() => {});
      await page.fill(".palette input", "Attach hook").catch(() => {});
      await page.click("text=Attach hook…").catch(() => {});
      await page.waitForSelector(".palette-crumbs").catch(() => {});
      await page.click('.palette-item:has-text("notify-on-stop")').catch(() => {});
      await page.click('.palette-item:has-text("Global")').catch(() => {});
      await page
        .locator(".confirm-dialog")
        .waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS })
        .catch(() => {});
      await delay(200);
    },
  },

  // ─── Empty / error / overlay states (B2 coverage gaps) ───────────────────────
  // Each opts into a non-happy-path via a query flag BEFORE the hash route
  // (read by src/mocks/tauriCore.ts `sceneFlag`), so the default populated mock
  // (and every other scene) is untouched.
  {
    id: "python-error",
    label: "Runtime preflight failure — PythonError card",
    path: "/?pythonError=1#/",
    waitFor: ".error-card",
  },
  {
    id: "screen-error",
    label: "Bootstrap query rejects — error card (degraded escape)",
    path: "/?screenError=1#/",
    waitFor: ".error-card",
  },
  {
    id: "library-empty",
    label: "Skill Library — empty registry",
    path: "/?libraryEmpty=1#/",
    waitFor: ".empty-state",
  },
  {
    id: "project-empty",
    label: "Project Workspace — unknown project (Add-project CTA)",
    path: "/#/project/__none__",
    waitFor: ".empty-state",
  },
  {
    id: "snippets-empty",
    label: "Snippets — empty library",
    path: "/?snippetsEmpty=1#/snippets",
    waitFor: ".empty-state",
  },
  // NOTE: no plain `bootstrap-wizard` scene — `/?bootstrap=1` renders the SAME
  // choose step as `bootstrap-choose`, and the wizard's real branches are
  // covered by `bootstrap-import` / `bootstrap-backup` / `bootstrap-restore`.
  {
    id: "remotes-doctor-banner",
    label: "Remotes — danger doctor banner (host-key mismatch)",
    path: "/?remoteDoctor=1#/remotes",
    waitFor: '[data-testid="remote-doctor-banner"]',
  },
  {
    id: "confirm-dialog-danger",
    label: "Library bundle mode — delete confirm (blast radius)",
    path: "/#/bundle/android",
    waitFor: '[data-testid="library-bundle-band"]',
    prep: async (page) => {
      // Delete lives in the header overflow now, not a bare danger-zone
      // button — no `.catch(() => {})` anywhere here: a missing dialog must
      // fail the scene, not silently shoot the band underneath it.
      await page.locator(".main-header").getByTestId("overflow-trigger").click();
      await page.getByRole("menuitem", { name: "Delete bundle…" }).click();
      await page
        .locator(".confirm-dialog")
        .waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS });
      await delay(200);
    },
  },
  {
    id: "bundle-mode-add-skills",
    label: "Library — bundle mode, Add skills popover open",
    path: "/#/bundle/android",
    waitFor: '[data-testid="library-bundle-band"]',
    prep: async (page) => {
      await page.locator('[data-testid="bundle-add-skills"]').click();
      await page
        .locator(".equip-picker-list")
        .waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS });
      await delay(200);
    },
  },
  {
    id: "bundle-mode-create-skill",
    label: "Library — bundle mode, create-and-add skill sheet",
    path: "/#/bundle/android",
    waitFor: '[data-testid="library-bundle-band"]',
    prep: async (page) => {
      await page.locator('[data-testid="bundle-add-skills"]').click();
      await page.getByRole("button", { name: "Create new skill" }).click();
      await page
        .getByRole("dialog", { name: "New skill" })
        .waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS });
      await delay(200);
    },
  },
  {
    // `?pendingBundleAdd=1` (tauriCore.ts) defers the mocked `bundle update`
    // MUTATION itself by 60s instead of hanging it forever — the mock
    // registry gains the membership only when the timer fires, so for the
    // whole capture window the pending row comes only from the optimistic
    // write (`useBundleMembership`), never from an already-mutated mock. The
    // create-then-add follow-up (newSkillCompletion.ts) leaves the sheet
    // closed and the new member's row visibly `pending` (SkillRow: aria-busy
    // + "adding…") for that window — design.md "Visual mock".
    //
    // `minWidth: 768` — at 520px the sidebar rail narrows `.app-main` (the
    // `appmain` container) below 480px, which trips shell-main.css's
    // `@container appmain (max-width: 480px) { .main-header-right .btn
    // .btn-label { display: none; } }`. `NewSkillSheet`'s dialog mounts as a
    // DOM descendant of `.main-header-right`, so that HEADER-scoped rule also
    // strips this dialog's "Create and add" submit button down to an
    // icon-only, UNNAMED button (no `aria-label` fallback) — not a
    // create-then-follow-up regression, a pre-existing DOM/CSS scoping
    // collision between the sheet and the header's narrow-width label
    // shedding. Deferred, not fixed here (out of this slice's files).
    id: "bundle-create-pending",
    label: "Library — bundle member pending after create",
    path: "/?pendingBundleAdd=1#/bundle/android",
    waitFor: "text=android",
    minWidth: 768,
    prep: async (page) => {
      await page.locator('[data-testid="bundle-add-skills"]').click();
      await page.getByRole("button", { name: "Create new skill" }).click();
      await page
        .getByRole("dialog", { name: "New skill" })
        .waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS });
      await page.getByPlaceholder("my-skill-name").fill("pending-helper");
      await page.getByRole("button", { name: "Create and add" }).click();
      await page
        .locator('.skill-row[aria-busy="true"]')
        .waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS });
      await delay(200);
    },
  },
  {
    id: "toast-undo",
    label: "Project Workspace — equip success toast + Undo",
    path: "/#/project/moon-base",
    waitFor: '[role="tab"]',
    prep: async (page) => {
      // Equip the first Available skill → the reversible-edge undo toast.
      await page.locator(".avail-skill").first().click().catch(() => {});
      await page
        .locator(".toast-title")
        .first()
        .waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS })
        .catch(() => {});
      await delay(200);
    },
  },
  {
    id: "tips-tour",
    label: "First-run tips tour (relaunched from palette)",
    path: "/#/",
    // `.app-main` is present at every width (the topbar "SKILL TREE" label
    // collapses in narrow mode), so the pre-prep wait never spuriously warns.
    waitFor: ".app-main",
    prep: async (page) => {
      await page.keyboard.press("ControlOrMeta+k");
      await page.waitForSelector(".palette input").catch(() => {});
      await page.fill(".palette input", "tips tour").catch(() => {});
      await page.getByText("Show tips tour").click().catch(() => {});
      await page
        .locator(".tips-card")
        .waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS })
        .catch(() => {});
      await delay(300);
    },
  },

  // ─── Backup & restore ─────────────────────────────────────────────────────

  {
    id: "backup-configured",
    label: "Backup — healthy: health card leads, maintenance behind disclosures",
    path: "/#/backup",
    waitFor: '[data-testid="backup-screen"]',
  },
  {
    // The reported first-use state: credentials already work, `gh` is simply
    // not installed. This is the frame the whole wave exists to fix.
    id: "backup-unconfigured",
    label: "Backup — never set up: the guided 3-stage journey (repo stage live)",
    path: "/?backupUnconfigured=1&backupNoGh=1#/backup",
    waitFor: '[data-testid="backup-journey"]',
  },
  {
    id: "backup-journey-ladder",
    label: "Backup — credential stage reopened: gh reads OPTIONAL with a copyable install",
    path: "/?backupUnconfigured=1&backupNoGh=1#/backup",
    waitFor: '[data-testid="backup-journey"]',
    prep: async (page) => {
      await page
        .locator('[data-testid="backup-stage-change-credential"]')
        .click()
        .catch(() => {});
      await page
        .locator('[data-testid="auth-rung-gh"]')
        .waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS })
        .catch(() => {});
      await delay(DETAIL_EXPAND_SETTLE_MS);
    },
  },
  {
    id: "backup-journey-no-credential",
    label: "Backup — nothing can push: every rung states its own fix (stage 1 live)",
    path: "/?backupUnconfigured=1&backupNoCredential=1#/backup",
    waitFor: '[data-testid="rung-fix-ssh"]',
  },
  {
    id: "backup-journey-first-snapshot",
    label: "Backup — repo configured, stage 3 live (the big first-snapshot CTA)",
    path: "/?backupNoSnapshot=1#/backup",
    waitFor: '[data-testid="backup-first-run"]',
  },
  {
    id: "backup-restore-fork",
    label: "Backup — the fresh-machine fork: restore instead of setting up",
    path: "/?backupUnconfigured=1&backupNoGh=1#/backup",
    waitFor: '[data-testid="backup-restore-fork"]',
    prep: async (page) => {
      await page
        .locator('[data-testid="backup-restore-fork-toggle"]')
        .click()
        .catch(() => {});
      await page
        .locator('[data-testid="restore-danger-zone"]')
        .waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS })
        .catch(() => {});
      await delay(DETAIL_EXPAND_SETTLE_MS);
    },
  },
  {
    id: "backup-credentials-open",
    label: "Backup — configured: credential section opened from its disclosure",
    path: "/#/backup",
    waitFor: '[data-testid="backup-credential-disclosure"]',
    prep: async (page) => {
      await page
        .locator('[data-testid="backup-credential-disclosure"]')
        .click()
        .catch(() => {});
      await page
        .locator('[data-testid="auth-rung-ssh"]')
        .waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS })
        .catch(() => {});
      await delay(DETAIL_EXPAND_SETTLE_MS);
    },
  },
  {
    id: "restore-recovery-dense",
    label: "Restore — fifteen projects with long paths and mixed outcomes",
    path: "/?restoreRecoveryDense=1#/recovery",
    waitFor: '[data-testid="recovery-projects-step"]',
  },
  {
    id: "restore-recovery-sources",
    label: "Restore — recover missing sources and retry a failure",
    path: "/?restoreRecovery=1#/recovery",
    waitFor: '[data-testid="recovery-sources-step"]',
  },
  {
    id: "restore-recovery-projects",
    label: "Restore — attach projects while preserving skipped loadouts",
    path: "/?restoreRecovery=1#/recovery?project=dev",
    waitFor: '[data-testid="recovery-projects-step"]',
  },
  {
    id: "backup-stale",
    label: "Backup — 4 failed pushes + gh account mismatch (StatusBar danger chip)",
    path: "/?backupStale=1#/backup",
    waitFor: '[data-testid="backup-chip"]',
  },
  {
    id: "backup-pending-reconcile",
    label: "Backup — pending_reconcile after a restore (push blocked)",
    path: "/?backupPending=1#/backup",
    waitFor: '[data-testid="pending-reconcile-banner"]',
  },
  {
    id: "backup-no-keyring",
    label: "Backup — degraded PAT rung (keyring package missing)",
    path: "/?backupNoKeyring=1#/backup",
    waitFor: '[data-testid="backup-credential-disclosure"]',
    prep: async (page) => {
      await page
        .locator('[data-testid="backup-credential-disclosure"]')
        .click()
        .catch(() => {});
      await page
        .locator('[data-testid="pat-unavailable"]')
        .waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS })
        .catch(() => {});
      await delay(DETAIL_EXPAND_SETTLE_MS);
    },
  },
  {
    id: "backup-pat-form",
    label: "Backup — masked PAT entry form",
    path: "/#/backup",
    waitFor: '[data-testid="backup-credential-disclosure"]',
    prep: async (page) => {
      await page
        .locator('[data-testid="backup-credential-disclosure"]')
        .click()
        .catch(() => {});
      await page.locator('[data-testid="open-pat-form"]').click().catch(() => {});
      await page
        .locator('[data-testid="pat-form"]')
        .waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS })
        .catch(() => {});
    },
  },
  {
    id: "backup-restore-preview",
    label: "Backup — restore dry-run plan (lost entries, hooks verbatim, out-of-home writes)",
    path: "/#/backup",
    waitFor: '[data-testid="backup-restore-disclosure"]',
    prep: async (page) => {
      await page.locator('[data-testid="backup-restore-disclosure"]').click().catch(() => {});
      await page.fill("#restore-source", "git@github.com:me/skill-tree-backup.git").catch(() => {});
      await page.locator('[data-testid="restore-preview-btn"]').click().catch(() => {});
      await page
        .locator('[data-testid="restore-consequences"]')
        .waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS })
        .catch(() => {});
      await delay(DETAIL_EXPAND_SETTLE_MS);
    },
  },
  {
    id: "backup-restore-confirm",
    label: "Backup — restore ConfirmDialog (typed confirm + executable-state consent)",
    path: "/#/backup",
    waitFor: '[data-testid="backup-restore-disclosure"]',
    prep: async (page) => {
      await page.locator('[data-testid="backup-restore-disclosure"]').click().catch(() => {});
      await page.fill("#restore-source", "git@github.com:me/skill-tree-backup.git").catch(() => {});
      await page.locator('[data-testid="restore-preview-btn"]').click().catch(() => {});
      await page
        .locator('[data-testid="restore-apply-btn"]')
        .waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS })
        .catch(() => {});
      await page.locator('[data-testid="restore-apply-btn"]').click().catch(() => {});
      await page
        .locator(".confirm-dialog")
        .waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS })
        .catch(() => {});
      await delay(DETAIL_EXPAND_SETTLE_MS);
    },
  },
  {
    id: "new-bundle-sheet",
    label: "New bundle — sheet (Modal preset, icon slot + name, scope chips)",
    path: "/#/?addBundle=1",
    waitFor: '[role="dialog"][aria-label="New bundle"]',
  },
  {
    id: "new-bundle-sheet-icon-picker",
    label: "New bundle — emoji picker open",
    path: "/#/?addBundle=1",
    waitFor: '[role="dialog"][aria-label="New bundle"]',
    prep: async (page) => {
      await page.getByRole("button", { name: /^Icon:/ }).click();
      await page.locator(".emoji-picker").waitFor();
    },
  },
  {
    id: "new-bundle-sheet-icon-search",
    label: "New bundle — emoji picker, search 'rocket'",
    path: "/#/?addBundle=1",
    waitFor: '[role="dialog"][aria-label="New bundle"]',
    prep: async (page) => {
      await page.getByRole("button", { name: /^Icon:/ }).click();
      await page.getByLabel("Search emoji").fill("rock");
      await page.locator(".emoji-picker-tile").first().waitFor();
    },
  },
  {
    // The scope hint switches between one and two lines; the sheet must keep
    // the same height as `new-bundle-sheet` (portable) with global picked.
    id: "new-bundle-sheet-global",
    label: "New bundle — global scope picked (same sheet height as portable)",
    path: "/#/?addBundle=1",
    waitFor: '[role="dialog"][aria-label="New bundle"]',
    prep: async (page) => {
      await page.getByRole("radio", { name: "global" }).check();
    },
  },
  {
    id: "new-skill-sheet-desc-warn",
    label: "New skill — description over the claude.ai limit (amber meter + note)",
    path: "/#/?new=1",
    waitFor: ".palette-backdrop .palette",
    prep: async (page) => {
      await fillNewSkillDescription(page, prose(220));
    },
  },
  {
    id: "new-skill-sheet-desc-over",
    label:
      "New skill — description over the Agent Skills spec limit (red meter + note)",
    path: "/#/?new=1",
    waitFor: ".palette-backdrop .palette",
    prep: async (page) => {
      await fillNewSkillDescription(page, prose(1100));
    },
  },
  {
    // plans/E2.md §5.24 — the New sheet's MCP path with the literal-secret
    // plaque in frame (F4/m5). No honest "before" for the MCP body itself
    // (a new state); the sheet's own open/closed frame has prior art under
    // this same id from an earlier wave — deliver-it re-shoots that before
    // frame from `main` before publishing PR proof.
    id: "new-skill-sheet-mcp",
    label: "New skill — MCP · Add existing server, literal-secret plaque",
    path: "/#/?new=1",
    waitFor: ".palette-backdrop .palette",
    prep: async (page) => {
      await prepMcpAddSheet(page);
    },
  },
  {
    // E3 rev 2 §2.8 — the wrapper paste's name-slugify + "from" hint (a
    // non-slug raw key, distinct from `new-skill-sheet-mcp`'s bare-object
    // literal-plaque scene). After-only: no prior art.
    id: "new-skill-sheet-mcp-paste",
    label: "New skill — MCP · Add existing server, wrapper paste prefills the slug + 'from' hint",
    path: "/#/?new=1",
    waitFor: ".palette-backdrop .palette",
    // N11: the subject of this scene is the PREFILLED name field, not the
    // sheet merely being open — a select/paste that silently failed used to
    // still pass (the outer `waitFor` above only gates the sheet). Waiting
    // on the actual post-prep state, and letting a failure throw instead of
    // `console.warn`-and-continue, means a broken scene now fails loudly.
    prep: async (page) => {
      const typeSelect = page.locator(".palette-backdrop .palette select").first();
      await typeSelect.selectOption("mcp-server", { timeout: SCENE_WAIT_TIMEOUT_MS });
      const textarea = page.locator(".palette-backdrop .palette textarea").first();
      await textarea.fill(
        JSON.stringify({
          mcpServers: { Sanity: { command: "npx", args: ["-y", "@sanity/mcp"] } },
        }),
      );
      await page.waitForFunction(
        () => {
          const el = document.querySelector(
            '.palette-backdrop .palette input[placeholder="my-skill-name"]',
          );
          return el instanceof HTMLInputElement && el.value === "sanity";
        },
        undefined,
        { timeout: SCENE_WAIT_TIMEOUT_MS },
      );
      await delay(DETAIL_EXPAND_SETTLE_MS);
    },
  },
  {
    id: "bootstrap-choose",
    label: "Bootstrap — first decision: fresh setup vs restore",
    path: "/?bootstrap=1#/",
    waitFor: '[data-testid="bootstrap-choose"]',
  },
  {
    // The navigator's list filter, open with a query — the panel state the
    // gallery had zero coverage of. `/skill/:name` is where the sibling Skills
    // list (and therefore the filter) lives.
    id: "nav-filter-open",
    label: "Navigator — list filter, typed query (skills sibling list)",
    path: "/#/skill/code-review",
    // The filter lives INSIDE the panel, which is an off-canvas drawer at
    // 768/520 — waiting on the input itself timed out there and then shot a
    // closed drawer. Wait on the panel, open it if narrow, then type.
    waitFor: ".app-side",
    waitForState: "attached",
    prep: async (page) => {
      await openNavDrawer(page);
      const input = page.locator(".app-side .side-filter input").last();
      await input
        .waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS })
        .catch(() => {});
      await input.fill("re", { timeout: SCENE_WAIT_TIMEOUT_MS }).catch(() => {});
      await delay(DETAIL_EXPAND_SETTLE_MS);
    },
  },
  // ─── Navigator dashboard (NAV-DASHBOARD-SPEC.md §7.4, W3) ──────────────────
  // The glance layer (attention plaque + steady tiles) and the expanding
  // detail block, per group, in their worst (attention) and steady states.
  {
    id: "nav-attention-dialog",
    label: "Navigator — missing references explained, with both affected projects",
    path: "/?attentionQueue=1#/project/moon-base",
    waitFor: ".app-side",
    waitForState: "attached",
    prep: async (page) => {
      await openNavDrawerThenWait(page, ".side-attn");
      const more = page.locator(".side-attn-more");
      if (await more.count()) await more.click();
      await page.getByRole("button", { name: /equipped skills lack referenced skills, show details/ }).click();
      await page.getByRole("dialog", { name: "Referenced skills are not equipped" }).waitFor();
    },
  },
  {
    id: "nav-projects-attention",
    label: "Navigator — Projects: attention plaque + expanded row (failed sync)",
    path: "/?syncError=1#/project/moon-base",
    waitFor: ".app-side",
    waitForState: "attached",
    prep: (page) => openNavDrawerThenWait(page, ".side-attn"),
  },
  {
    id: "nav-projects-attention-600",
    label: "Navigator — Projects: attention + expanded row at a 600px window (§1 row budget)",
    path: "/?syncError=1#/project/moon-base",
    waitFor: ".app-side",
    waitForState: "attached",
    viewportHeight: 600,
    prep: (page) => openNavDrawerThenWait(page, ".side-attn"),
  },
  {
    id: "nav-context-attention",
    label: "Navigator — Context: attention plaque (dropped skill, bundle missing a member)",
    path: "/?contextAttention=1#/bundle/legacy-tools",
    waitFor: ".app-side",
    waitForState: "attached",
    prep: (page) => openNavDrawerThenWait(page, ".side-attn"),
  },
  {
    id: "nav-context-skill-expanded",
    label: "Navigator — Context: expanded skill row (bundles carrying it)",
    path: "/#/skill/android-compose-ui",
    waitFor: ".app-side",
    waitForState: "attached",
    prep: (page) => openNavDrawerThenWait(page, ".side-item-detail"),
  },
  {
    id: "nav-guardrails-attention",
    label: "Navigator — Guardrails: attention plaque + expanded hook row",
    path: "/?guardrailsAttention=1&hooksAttention=1&syncError=1#/hook/audit-bash",
    waitFor: ".app-side",
    waitForState: "attached",
    prep: (page) => openNavDrawerThenWait(page, ".side-attn"),
  },
  {
    id: "nav-agents-attention",
    label: "Navigator — Agents: attention plaque + expanded harness row",
    path: "/?agentsAttention=1#/harness/codex",
    waitFor: ".app-side",
    waitForState: "attached",
    prep: (page) => openNavDrawerThenWait(page, ".side-attn"),
  },
  {
    id: "nav-elsewhere-attention",
    label: "Navigator — Elsewhere: attention plaque, sticky legend under scroll",
    path: "/?elsewhereAttention=1&backupPending=1#/sources?focus=partner-skills",
    waitFor: ".app-side",
    waitForState: "attached",
    // At the default 900px window this group's content (worst-case glance
    // layer + 3 sub-groups) fits with NO overflow — the 120px scroll below
    // would be a no-op and the sticky-legend proof (§6.5 #3) would have
    // nothing to sample. A shorter window is the honest way to photograph a
    // real scroll, the same move `nav-projects-attention-600` makes for its
    // own budget proof.
    viewportHeight: 700,
    prep: async (page) => {
      await openNavDrawerThenWait(page, ".side-attn");
      await page
        .locator(".side-scroll")
        .evaluate((el) => {
          el.scrollTop = 120;
        });
      await delay(DETAIL_EXPAND_SETTLE_MS);
    },
  },
  {
    id: "nav-elsewhere-autosync",
    label: "Navigator — Elsewhere: REMOTE SYNC tile after a post-equip auto-sync (— / auto-sync)",
    path: "/?remotesSkipped=1#/remotes",
    waitFor: ".side-stats",
  },
  {
    id: "nav-keyboard-focus",
    label: "Navigator — focus ring on the aria-current row (g ⇧n)",
    path: "/#/project/moon-base",
    waitFor: ".app-side",
    waitForState: "attached",
    prep: async (page) => {
      await openNavDrawer(page);
      await page.keyboard.press("g");
      await page.keyboard.press("Shift+N");
      await page
        .locator(".app-side [data-side-row]:focus")
        .waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS })
        .catch(() => {});
    },
  },
  {
    id: "nav-steady-all-groups",
    label: "Navigator — Agents: steady state, no attention (tiles only)",
    path: "/#/harnesses",
    waitFor: ".side-stats",
  },
  {
    // Gate layout: the import step is a full-window takeover with no rail and
    // no navigator — it must occupy the whole grid, not sit in column 2.
    id: "bootstrap-import",
    label: "Bootstrap — import wizard (full-window gate)",
    path: "/?bootstrap=1#/",
    waitFor: '[data-testid="bootstrap-choose"]',
    prep: async (page) => {
      await page.locator('[data-testid="choose-fresh"]').click().catch(() => {});
      await page
        .locator("text=Importable skills")
        .first()
        .waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS })
        .catch(() => {});
      await delay(DETAIL_EXPAND_SETTLE_MS);
    },
  },
  {
    // The optional backup step that follows a successful import — the last
    // gate screen, and the one that had no frame at all.
    id: "bootstrap-backup",
    label: "Bootstrap — optional backup step (after import)",
    path: "/?bootstrap=1#/",
    waitFor: '[data-testid="bootstrap-choose"]',
    prep: async (page) => {
      await page.locator('[data-testid="choose-fresh"]').click().catch(() => {});
      // The footer CTA is "Initialize Skill Tree" on a fresh install and
      // "Finish upgrade" when a library already exists (the mock's case).
      await page
        .getByRole("button", { name: /Initialize Skill Tree|Finish upgrade/ })
        .first()
        .click({ timeout: SCENE_WAIT_TIMEOUT_MS })
        .catch(() => {});
      await page
        .locator('[data-testid="bootstrap-backup-step"]')
        .waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS })
        .catch(() => {});
      await delay(DETAIL_EXPAND_SETTLE_MS);
    },
  },
  {
    id: "bootstrap-restore",
    label: "Bootstrap — restore branch (skips the import wizard)",
    path: "/?bootstrap=1#/",
    waitFor: '[data-testid="bootstrap-choose"]',
    prep: async (page) => {
      await page.locator('[data-testid="choose-restore"]').click().catch(() => {});
      await page
        .locator('[data-testid="bootstrap-restore-step"]')
        .waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS })
        .catch(() => {});
    },
  },
  {
    id: "styleguide",
    label: "Styleguide — every primitive in every state (redesign iteration surface)",
    path: "/#/styleguide",
    waitFor: ".sg-root",
    viewportHeight: 3900,
  },
  // plans/E2.md §5.24 — the Library's Detected MCP servers band (design D5).
  // After-only: no prior art (the band did not exist before this wave).
  {
    id: "library-detected-mcp",
    label: "Library — Detected MCP servers band (new, literal, conflict, folded unsupported)",
    path: "/?mcpCandidates=1#/",
    waitFor: '[data-testid="detected-mcp-servers"]',
  },
  {
    id: "library-detected-mcp-compare",
    label: "Library — Detected MCP servers, compare sheet open",
    path: "/?mcpConflict=1#/",
    waitFor: '[data-testid="detected-mcp-servers"]',
    // N11: the subject of this scene is the OPEN SHEET's card, not just the
    // band being on screen — wait on that, and let a failed click throw
    // (no swallowed `console.warn`) so a broken scene fails loudly instead
    // of silently shooting the band with the sheet never open.
    prep: async (page) => {
      const btn = page.getByRole("button", { name: "Compare…" });
      await btn.click({ timeout: SCENE_WAIT_TIMEOUT_MS });
      await page
        .locator('[data-testid="mcp-compare-option"]')
        .first()
        .waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS });
      await delay(DETAIL_EXPAND_SETTLE_MS);
    },
  },
  // E3 rev 2 §2.4/§2.7 — the compare sheet's literal-secret card actions
  // (`Adopt anyway` only, for a `url.userinfo` warning). After-only: no
  // prior art (this candidate set did not exist before this wave).
  {
    id: "library-detected-mcp-compare-literal",
    label: "Library — Detected MCP servers, compare sheet open on a literal (url.userinfo) conflict",
    path: "/?mcpLiteral=1#/",
    waitFor: '[data-testid="detected-mcp-servers"]',
    prep: async (page) => {
      const row = page.locator(".detected-mcp-row", { hasText: "creds-mcp" });
      const btn = row.getByRole("button", { name: "Compare…" });
      await btn.click({ timeout: SCENE_WAIT_TIMEOUT_MS });
      await page
        .locator('[data-testid="mcp-compare-option"]')
        .first()
        .waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS });
      await delay(DETAIL_EXPAND_SETTLE_MS);
    },
  },
];
SCENES.push({
  ...SCENES.find(scene => scene.id === "headless-machine-preview"),
  id: "headless-native-review", label: "Headless machine · native configuration review",
  prep: async (page) => {
    await page.getByText("Review native configuration and scripts", { exact: true }).click();
    await page.getByRole("heading", { name: "Delivery", exact: true }).scrollIntoViewIfNeeded();
  },
});


// Type a description into the New-skill sheet, warning (not dying) if the
// sheet never mounted — the scene still shoots, just without the filler.
async function fillNewSkillDescription(page, text) {
  const desc = page.locator(".palette-backdrop .palette textarea").first();
  try {
    await desc.fill(text, { timeout: SCENE_WAIT_TIMEOUT_MS });
  } catch {
    console.warn("    [warn] could not fill the new-skill description");
  }
  await delay(DETAIL_EXPAND_SETTLE_MS);
}

// Switch the New sheet's Type select to MCP (Add existing server + Paste
// mode are already the defaults) and paste a token-bearing server object, so
// the literal-secret plaque (F4/m5) is in frame.
async function prepMcpAddSheet(page) {
  const typeSelect = page.locator(".palette-backdrop .palette select").first();
  try {
    await typeSelect.selectOption("mcp-server", { timeout: SCENE_WAIT_TIMEOUT_MS });
  } catch {
    console.warn("    [warn] could not select the MCP type");
  }
  const textarea = page.locator(".palette-backdrop .palette textarea").first();
  try {
    await textarea.fill(
      JSON.stringify({
        type: "http",
        url: "https://mcp.context7.com/mcp",
        headers: { Authorization: "Bearer sk-live-abcdefgh12345678" },
      }),
      { timeout: SCENE_WAIT_TIMEOUT_MS },
    );
  } catch {
    console.warn("    [warn] could not paste the MCP server JSON");
  }
  await delay(DETAIL_EXPAND_SETTLE_MS);
}

// Click a SubheaderViewChips tab by its visible label.
/** Open a project area from its dashboard card (the cards are the nav). */
async function clickAreaCard(page, area) {
  const card = page.locator(`.area-card[data-area="${area}"] .area-card-hit`).first();
  try {
    await card.waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS });
    await card.click();
  } catch {
    console.warn(`    [warn] could not open area card "${area}"`);
  }
}

async function clickChip(page, label) {
  const chip = page.locator(`button[role="tab"]:has-text("${label}")`).first();
  try {
    await chip.waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS });
    await chip.click();
  } catch {
    console.warn(`    [warn] could not click chip "${label}"`);
  }
}

// ─── Vite dev server lifecycle ────────────────────────────────────────────────

async function waitForServer(url, timeoutMs = 60000, proc = null) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (proc?.exited) {
      throw new Error(`Vite exited before it became ready (code ${proc.exited.code}, signal ${proc.exited.signal}) — see [vite:err] lines above`);
    }
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await delay(300);
  }
  throw new Error(`Vite dev server did not become ready at ${url}`);
}

function startVite() {
  console.log("Starting Vite dev server (VISUAL_MOCK=1) …");
  const viteBin = path.join(APP_DIR, "node_modules", "vite", "bin", "vite.js");
  // The port goes on the CLI (overrides the target checkout's vite.config),
  // so an older BEFORE checkout that ignores ST_DEV_PORT still binds ours.
  const proc = spawn(process.execPath, [viteBin, "--port", String(PORT), "--strictPort"], {
    cwd: APP_DIR,
    env: { ...process.env, VISUAL_MOCK: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.exited = null;
  proc.on("exit", (code, signal) => {
    proc.exited = { code, signal };
  });
  proc.stdout.on("data", (d) => {
    const s = String(d);
    if (s.includes("error") || s.includes("Error")) process.stdout.write(`  [vite] ${s}`);
  });
  proc.stderr.on("data", (d) => process.stderr.write(`  [vite:err] ${d}`));
  return proc;
}

/** Playwright `clip` option for `ST_VISUAL_CLIP`, or `{}` for a full frame.
 *  The box is the FIRST matching element's, intersected with the viewport;
 *  a forced height replaces the element's own. A missing element warns and
 *  falls back to the full frame so a scene never fails just because the clip
 *  target is absent on that branch (that IS the comparison sometimes). */
async function clipFor(page, width) {
  if (!CLIP) return {};
  const box = await page
    .locator(CLIP.selector)
    .first()
    .boundingBox({ timeout: 2000 })
    .catch(() => null);
  if (!box) {
    console.warn(`    [warn] clip "${CLIP.selector}" not found @${width} — full frame`);
    return {};
  }
  const rect = clipRect(box, width, HEIGHT, CLIP.height);
  if (!rect) {
    console.warn(`    [warn] clip "${CLIP.selector}" is off-screen @${width} — full frame`);
    return {};
  }
  return { clip: rect };
}

/** Refuse to start when something already answers on our port: with two
 *  checkouts told apart only by port, a leftover server would silently get
 *  photographed as the wrong side. */
async function assertPortFree(url) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(500) });
  } catch {
    return;
  }
  throw new Error(`${url} already answers — another Vite is bound to port ${PORT}; stop it or pick another ST_DEV_PORT`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // A FULL run owns the directory and starts clean. A targeted `ST_VISUAL_ONLY`
  // run must NOT: wiping here deleted the other ~250 frames of an existing
  // gallery, which is the opposite of what a scene allowlist is for. It writes
  // its frames in place (same filenames, so the full gallery picks them up) and
  // its own index so `index.html` survives.
  if (process.env.ST_VISUAL_LIST === "1") {
    for (const scene of SCENES) console.log(scene.id);
    return;
  }
  if (!ONLY.length) {
    const entries = await readdir(OUT_DIR).catch(() => null);
    if (!canWipe(entries)) {
      throw new Error(
        `refusing to wipe ${OUT_DIR}: it is not empty and has no ${OUT_SENTINEL} sentinel — pick an empty or harness-owned ST_VISUAL_OUT`,
      );
    }
    await rm(OUT_DIR, { recursive: true, force: true });
  }
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(path.join(OUT_DIR, OUT_SENTINEL), "written by app/visual/capture.mjs — marks a dir it may wipe\n");

  console.log(`App checkout: ${APP_DIR}\nOutput dir:   ${OUT_DIR}`);
  await assertPortFree(BASE);
  const vite = startVite();
  let browser;
  const results = []; // { scene, captures: [{ width, file, ok, clipped }] }

  try {
    await waitForServer(BASE, 60000, vite);
    console.log(`Vite ready at ${BASE}`);

    browser = await chromium.launch();

    for (const scene of SCENES) {
      if (ONLY.length && !ONLY.includes(scene.id)) continue;
      console.log(`\n■ ${scene.label}  (${scene.path})`);
      const captures = [];

      for (const width of WIDTHS) {
        // `scene.minWidth` opts a scene OUT of a narrower default width when
        // the surface it drives is legitimately unusable there in the real
        // product (not a capture-script problem to paper over) — skipped
        // outright rather than recorded as a failure.
        if (scene.minWidth && width < scene.minWidth) {
          console.log(`    – ${width}px skipped (scene.minWidth=${scene.minWidth})`);
          continue;
        }
        const context = await browser.newContext({
          // A scene may ask for a taller viewport (tall single-scroll surfaces
          // like the styleguide — the app shell is a fixed-height grid with an
          // internal scroller, so fullPage capture can never see below the fold).
          viewport: { width, height: scene.viewportHeight ?? HEIGHT },
          deviceScaleFactor: SCALE,
        });
        const page = await context.newPage();
        // Kill animations + the blinking caret so frames are stable.
        await page.addStyleTag?.({}).catch(() => {});

        const fileName = frameName(scene.id, width);
        const filePath = path.join(OUT_DIR, fileName);
        let ok = false;
        let clipped = false;

        try {
          if (scene.init) await scene.init(page);
          await page.goto(`${BASE}${scene.path}`, { waitUntil: "load" });
          // Inject anim-disable CSS once the document exists.
          await page.addStyleTag({
            content:
              "*,*::before,*::after{transition:none!important;animation:none!important;caret-color:transparent!important;scroll-behavior:auto!important}",
          });
          await page
            .waitForLoadState("networkidle", { timeout: 8000 })
            .catch(() => {});

          if (scene.waitFor) {
            await page
              .locator(scene.waitFor)
              .first()
              // `waitForState` lets a scene wait on ATTACHED instead — an
              // off-canvas drawer never becomes "visible", so a visible-wait
              // there is a guaranteed 8s burn per frame.
              .waitFor({ state: scene.waitForState ?? "visible", timeout: 8000 })
              .catch(() =>
                console.warn(`    [warn] waitFor "${scene.waitFor}" not found @${width}`),
              );
          }
          await delay(350); // settle
          if (scene.prep) await scene.prep(page);
          await delay(250);

          const clip = await clipFor(page, width);
          clipped = Boolean(clip.clip);
          await page.screenshot({ path: filePath, fullPage: false, ...clip });
          ok = true;
          console.log(`    ✓ ${width}px → ${fileName}`);
        } catch (err) {
          console.warn(`    ✗ ${width}px failed: ${err.message}`);
        } finally {
          await context.close();
        }

        captures.push({ width, file: fileName, ok, clipped });
      }

      results.push({ scene, captures });
    }

    const galleryName = ONLY.length ? "index-only.html" : "index.html";
    await writeGallery(results, galleryName);
    await writeFile(
      path.join(OUT_DIR, "capture-report.json"),
      JSON.stringify(
        {
          app: APP_DIR,
          clip: CLIP,
          widths: WIDTHS,
          frames: results.flatMap((r) => r.captures.map((c) => ({ scene: r.scene.id, ...c }))),
        },
        null,
        2,
      ),
    );
    console.log(`\nGallery written → ${path.join(OUT_DIR, galleryName)}`);
    const okCount = results.flatMap((r) => r.captures).filter((c) => c.ok).length;
    const total = results.length * WIDTHS.length;
    console.log(`Captured ${okCount}/${total} frames across ${results.length} scenes.`);
  } finally {
    if (browser) await browser.close();
    vite.kill("SIGTERM");
    // Give it a moment, then SIGKILL if still alive.
    await delay(500);
    try {
      vite.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

// ─── Gallery ──────────────────────────────────────────────────────────────────

async function writeGallery(results, fileName = "index.html") {
  const nav = results
    .map((r) => `<a href="#${r.scene.id}">${esc(r.scene.label)}</a>`)
    .join("");

  const sections = results
    .map((r) => {
      const cards = r.captures
        .map((c) => {
          const inner = c.ok
            ? `<a href="${c.file}" target="_blank" rel="noopener"><img loading="lazy" src="${c.file}" alt="${esc(r.scene.label)} @ ${c.width}px"></a>`
            : `<div class="missing">capture failed</div>`;
          return `<figure class="shot${c.ok ? "" : " bad"}">
  <figcaption>${c.width}px${c.ok ? "" : " — FAILED"}</figcaption>
  ${inner}
</figure>`;
        })
        .join("\n");
      return `<section id="${r.scene.id}" class="scene">
  <h2>${esc(r.scene.label)} <span class="route">${esc(r.scene.path)}</span></h2>
  <div class="row">
${cards}
  </div>
</section>`;
    })
    .join("\n");

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Skill Tree — Responsive Capture Gallery</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: #0c0d11; color: #e4e6eb;
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  }
  header {
    position: sticky; top: 0; z-index: 5;
    background: #14151b; border-bottom: 1px solid #23252e;
    padding: 14px 22px;
  }
  header h1 { margin: 0 0 8px; font-size: 16px; letter-spacing: .04em; }
  header .meta { color: #8a8f9c; font-size: 12px; }
  nav { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
  nav a {
    color: #c7cad3; text-decoration: none; font-size: 12px;
    padding: 3px 9px; border: 1px solid #2b2e39; border-radius: 999px;
    background: #1a1c24;
  }
  nav a:hover { border-color: #4b4fff; color: #fff; }
  main { padding: 22px; }
  .scene { margin-bottom: 40px; }
  .scene h2 {
    font-size: 15px; margin: 0 0 12px; display: flex; align-items: baseline; gap: 10px;
    border-bottom: 1px solid #23252e; padding-bottom: 8px;
  }
  .scene h2 .route {
    font: 11px/1 ui-monospace, "SF Mono", Menlo, monospace; color: #7a7f8c;
  }
  .row {
    display: flex; gap: 16px; overflow-x: auto; padding-bottom: 12px;
    align-items: flex-start;
  }
  figure.shot { margin: 0; flex: 0 0 auto; }
  figure.shot figcaption {
    font: 11px/1 ui-monospace, Menlo, monospace; color: #9aa0ad;
    margin-bottom: 6px;
  }
  figure.shot.bad figcaption { color: #ff6b6b; }
  figure.shot img {
    display: block; height: 460px; width: auto; border: 1px solid #2b2e39;
    border-radius: 6px; background: #000;
  }
  figure.shot .missing {
    height: 460px; width: 300px; display: grid; place-items: center;
    border: 1px dashed #5a2b2b; border-radius: 6px; color: #ff6b6b;
    background: #1a1012; font-size: 12px;
  }
</style>
</head>
<body>
<header>
  <h1>SKILL TREE — Responsive Capture Gallery</h1>
  <div class="meta">Widths: ${WIDTHS.join(" · ")} px (fixed height ${HEIGHT}px, @${SCALE}x) · mocked Tauri data · generated ${new Date().toISOString()}</div>
  <nav>${nav}</nav>
</header>
<main>
${sections}
</main>
</body>
</html>`;

  await writeFile(path.join(OUT_DIR, fileName), html, "utf8");
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// realpath both sides: `import.meta.url` is symlink-resolved for the main
// module, `process.argv[1]` is not.
const isEntrypoint =
  process.argv[1] && realpathSync(path.resolve(process.argv[1])) === fileURLToPath(import.meta.url);
if (isEntrypoint) main().catch((err) => {
  console.error(err);
  process.exit(1);
});
