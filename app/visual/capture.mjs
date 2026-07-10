// ─── Responsive-screenshot harness ───────────────────────────────────────────
// Boots the REAL Skill Tree React frontend in headless Chromium with MOCKED
// Tauri data (VISUAL_MOCK=1 vite alias), navigates every relevant screen/state
// at multiple viewport WIDTHS (fixed height), screenshots each, and emits an
// HTML gallery showing full-width vs reduced-width side by side.
//
//   Run from app/:  npm run visual
//   Output:         app/visual/out/<sceneId>__<width>.png  +  index.html
//
// This OBSERVES the UI only — it never modifies components or CSS.

import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, "..");
const OUT_DIR = path.join(__dirname, "out");

const PORT = 1420;
const BASE = `http://localhost:${PORT}`;
const WIDTHS = [1440, 1024, 768, 520];
const HEIGHT = 900;
const SCALE = 2;
// Scene-prep synchronization budgets (not arbitrary sleeps): how long we wait
// for the sync-report drawer to mount, and for an expanded row to settle.
const SYNC_REPORT_DRAWER_WAIT_MS = 6000;
const DETAIL_EXPAND_SETTLE_MS = 300;
// Default budget for a scene-prep element to appear before we shoot anyway.
const SCENE_WAIT_TIMEOUT_MS = 4000;

// ─── Scenes ───────────────────────────────────────────────────────────────────
// Each scene: { id, label, path (hash route), waitFor (selector or fn), prep? }.
// `waitFor` is a representative selector that must exist before we screenshot.
// `prep(page)` runs after navigation+wait to drive a toggle/state.

const SCENES = [
  {
    id: "skill-library",
    label: "Skill Library",
    path: "/#/",
    waitFor: "text=SKILL TREE",
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
  {
    id: "project-loadout",
    label: "Project Workspace — Loadout",
    path: "/#/project/moon-base",
    waitFor: '[role="tab"]',
  },
  {
    id: "project-tree",
    label: "Project Workspace — Tree",
    path: "/#/project/moon-base",
    waitFor: '[role="tab"]',
    prep: async (page) => {
      await clickChip(page, "Tree");
      await delay(400);
    },
  },
  {
    id: "bundle-manager",
    label: "Bundle Manager",
    path: "/#/bundle/android",
    waitFor: ".app-main",
  },
  {
    id: "global-permissions",
    label: "Global Permissions",
    path: "/#/permissions",
    waitFor: ".app-main",
  },
  {
    id: "snippets",
    label: "Snippets",
    path: "/#/snippets",
    waitFor: ".app-main",
  },
  {
    id: "snippets-detail",
    label: "Snippets — Detail (DocumentEditorShell + master-detail preserved)",
    path: "/#/snippets",
    waitFor: ".snip-row",
    prep: async (page) => {
      await page.locator(".snip-row").first().click().catch(() => {});
      await page
        .locator(".doc-editor-shell")
        .first()
        .waitFor({ state: "visible", timeout: 6000 })
        .catch(() => {});
      await delay(250);
    },
  },
  {
    id: "snippets-detail-collapsed",
    label: "Snippets — Detail, Details panel COLLAPSED (editor must still render)",
    path: "/#/snippets",
    waitFor: ".snip-row",
    prep: async (page) => {
      await page.locator(".snip-row").first().click().catch(() => {});
      await page
        .locator(".doc-editor-shell")
        .first()
        .waitFor({ state: "visible", timeout: 6000 })
        .catch(() => {});
      // Collapse the Details panel — the editor body must not go blank.
      await page
        .getByRole("button", { name: "Collapse Details" })
        .click()
        .catch(() => {});
      await delay(250);
    },
  },
  {
    id: "sources",
    label: "Sources",
    path: "/#/sources",
    waitFor: ".app-main",
  },
  {
    id: "harnesses",
    label: "Harnesses",
    path: "/#/harnesses",
    waitFor: ".app-main",
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
    label: "Library — Filter popover",
    path: "/#/",
    waitFor: "text=SKILL TREE",
    prep: async (page) => {
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
    id: "command-palette",
    label: "Command Palette",
    path: "/#/",
    waitFor: "text=SKILL TREE",
    prep: async (page) => {
      await page.keyboard.press("Meta+k");
      await delay(300);
    },
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
      // Force an invalid name so the inline field-error renders.
      const nameInput = page.locator(".subagent-editor-form input").first();
      await nameInput.fill("Bad Name").catch(() => {});
      await page
        .locator("button", {
          has: page.locator(".btn-label", { hasText: /^Save$/ }),
        })
        .click()
        .catch(() => {});
      await delay(300);
    },
  },
  {
    id: "subagents-editor-advanced",
    label: "Sub-agents — Editor (advanced YAML open)",
    // legacy-helper seeds advanced_yaml so the Advanced panel auto-expands and
    // the validity warnings render.
    path: "/#/harness/claude-code",
    waitFor: ".subagent-list",
    prep: async (page) => {
      await page
        .locator('.subagent-card:has-text("legacy-helper")')
        .first()
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
    waitFor: '[role="tab"]',
    prep: async (page) => {
      await clickChip(page, "Sub-Agents");
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
  {
    id: "bootstrap-wizard",
    label: "Bootstrap wizard (healthy · un-bootstrapped)",
    path: "/?bootstrap=1#/",
    waitFor: ".app-main h1",
  },
  {
    id: "remotes-doctor-banner",
    label: "Remotes — danger doctor banner (host-key mismatch)",
    path: "/?remoteDoctor=1#/remotes",
    waitFor: '[data-testid="remote-doctor-banner"]',
  },
  {
    id: "confirm-dialog-danger",
    label: "Bundle Manager — delete confirm (blast radius)",
    path: "/#/bundle/android",
    waitFor: ".app-main",
    prep: async (page) => {
      await page
        .locator('button:has-text("Delete bundle…")')
        .first()
        .click()
        .catch(() => {});
      await page
        .locator(".confirm-dialog")
        .waitFor({ state: "visible", timeout: SCENE_WAIT_TIMEOUT_MS })
        .catch(() => {});
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
];

// Click a SubheaderViewChips tab by its visible label.
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

async function waitForServer(url, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await delay(500);
  }
  throw new Error(`Vite dev server did not become ready at ${url}`);
}

function startVite() {
  console.log("Starting Vite dev server (VISUAL_MOCK=1) …");
  const proc = spawn("npm", ["run", "dev"], {
    cwd: APP_DIR,
    env: { ...process.env, VISUAL_MOCK: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", (d) => {
    const s = String(d);
    if (s.includes("error") || s.includes("Error")) process.stdout.write(`  [vite] ${s}`);
  });
  proc.stderr.on("data", (d) => process.stderr.write(`  [vite:err] ${d}`));
  return proc;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });

  const vite = startVite();
  let browser;
  const results = []; // { scene, captures: [{ width, file, ok }] }

  try {
    await waitForServer(BASE);
    console.log(`Vite ready at ${BASE}`);

    browser = await chromium.launch();

    for (const scene of SCENES) {
      console.log(`\n■ ${scene.label}  (${scene.path})`);
      const captures = [];

      for (const width of WIDTHS) {
        const context = await browser.newContext({
          viewport: { width, height: HEIGHT },
          deviceScaleFactor: SCALE,
        });
        const page = await context.newPage();
        // Kill animations + the blinking caret so frames are stable.
        await page.addStyleTag?.({}).catch(() => {});

        const fileName = `${scene.id}__${width}.png`;
        const filePath = path.join(OUT_DIR, fileName);
        let ok = false;

        try {
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
              .waitFor({ state: "visible", timeout: 8000 })
              .catch(() =>
                console.warn(`    [warn] waitFor "${scene.waitFor}" not found @${width}`),
              );
          }
          await delay(350); // settle
          if (scene.prep) await scene.prep(page);
          await delay(250);

          await page.screenshot({ path: filePath, fullPage: false });
          ok = true;
          console.log(`    ✓ ${width}px → ${fileName}`);
        } catch (err) {
          console.warn(`    ✗ ${width}px failed: ${err.message}`);
        } finally {
          await context.close();
        }

        captures.push({ width, file: fileName, ok });
      }

      results.push({ scene, captures });
    }

    await writeGallery(results);
    console.log(`\nGallery written → ${path.join(OUT_DIR, "index.html")}`);
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

async function writeGallery(results) {
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

  await writeFile(path.join(OUT_DIR, "index.html"), html, "utf8");
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
