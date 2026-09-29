import { test, expect, type Page } from "./fixtures";
import { gotoReady } from "./helpers";

// Navigator "contextual second pane" journey, driven against the mocked-Tauri
// dev server (VISUAL_MOCK=1 → src/mocks/tauriCore.ts). NEVER touches ~/.claude.
//
// The contract under test: the rail picks the GROUP (five intent clusters —
// see lib/sections.ts), the panel shows that group's CONTENTS, and the item on
// screen is the active row. Several routes below share one group and so share
// one header label — that is the point of the rework, not a gap in it.

function head(page: Page) {
  return page.locator(".app-side .side-head-name");
}
function activeRowName(page: Page) {
  return page.locator('.side-item[data-active="true"] .name');
}

test("navigator: switching groups re-points the panel and lights the open item", async ({
  page,
}) => {
  await page.goto("/#/");
  await expect(page.getByText("SKILL TREE")).toBeVisible();

  // Context: bundles + snippets enumerate, skills do NOT (the screen already
  // is the list).
  await expect(head(page)).toHaveText("Context");
  await expect(page.locator(".app-side .side-group .t-name")).toHaveText([
    "Bundles",
    "Snippets",
  ]);

  // Open a bundle from the panel → that row becomes the active one.
  await page
    .locator(".app-side .side-item-main", { hasText: "android" })
    .first()
    .click();
  await expect(page).toHaveURL(/#\/bundle\/android$/);
  await expect(head(page)).toHaveText("Context");
  await expect(activeRowName(page)).toHaveText("android");
  const androidRow = page.locator(".app-side .side-item-main", { hasText: "android" }).first();
  await expect(androidRow).toHaveAttribute("aria-current", "true");

  // The active row is a toggle: clicking the selected bundle again leaves
  // bundle mode and returns to the plain library.
  await androidRow.click();
  await expect(page).toHaveURL(/#\/$/);
  await expect(androidRow).not.toHaveAttribute("aria-current", "true");

  // And once more from the library: the row selects again.
  await androidRow.click();
  await expect(page).toHaveURL(/#\/bundle\/android$/);

  // A skill route adds the sibling Skills group with the open skill active.
  await page.goto("/#/skill/code-review");
  await expect(page.locator(".app-side .side-group .t-name")).toHaveText([
    "Bundles",
    "Snippets",
    "Skills",
  ]);
  await expect(activeRowName(page)).toHaveText("code-review");

  // Projects group: the panel becomes the project list.
  await page.goto("/#/project/moon-base");
  await expect(head(page)).toHaveText("Projects");
  await expect(activeRowName(page)).toHaveText("moon-base");
  // Switch projects straight from the panel.
  await page
    .locator(".app-side .side-item-main", { hasText: "example-app" })
    .first()
    .click();
  await expect(page).toHaveURL(/#\/project\/example-app$/);
  await expect(activeRowName(page)).toHaveText("example-app");

  // Guardrails group: hook rows sit beside the Permissions block, and the
  // open hook is active.
  await page.goto("/#/hooks");
  await expect(head(page)).toHaveText("Guardrails");
  await page
    .locator(".app-side .side-item-main", { hasText: "lsp-report" })
    .first()
    .click();
  await expect(page).toHaveURL(/#\/hook\/lsp-report$/);
  await expect(activeRowName(page)).toHaveText("lsp-report");
});

test("navigator: sections whose screen IS the list get an info block, not dead rows", async ({
  page,
}) => {
  await page.goto("/#/sources");
  await expect(head(page)).toHaveText("Elsewhere");
  // The old `.side-info` descriptor is gone — every group now carries a
  // two-tile glance layer instead (the fixture's Org Skills source legitimately
  // has an update available, so a plaque line is expected here too).
  await expect(page.locator(".app-side .side-dash .side-stats")).toBeVisible();

  // Per-source rows are now real navigation, but scoped to the elsewhere
  // group's own routes — they must not leak onto context or projects.
  for (const route of ["/#/", "/#/project/moon-base"]) {
    await page.goto(route);
    await expect(
      page.locator(".app-side .side-item .name", { hasText: /^Org Skills$/ }),
    ).toHaveCount(0);
  }
  for (const route of ["/#/sources", "/#/remotes"]) {
    await page.goto(route);
    await expect(
      page.locator(".app-side .side-item .name", { hasText: /^Org Skills$/ }),
    ).toHaveCount(1);
  }

  await test.step("cloud apps are reachable from the elsewhere group", async () => {
    await page.goto("/#/remotes");
    await expect.soft(head(page)).toHaveText("Elsewhere");
    await expect.soft(page.locator(".app-side .side-group .t-name")).toHaveText([
      "Sources",
      "Remotes",
      "Cloud apps",
    ]);
    await page
      .locator(".app-side .side-item-main", { hasText: "claude.ai" })
      .first()
      .click();
    await expect.soft(page).toHaveURL(/#\/cloud\/claude-ai$/);
    await expect.soft(activeRowName(page)).toHaveText("claude.ai");
  });

  // Backup has its own elsewhere-group rail button now, and the panel still
  // names the group + wears its hue.
  await page.goto("/#/backup");
  await expect(head(page)).toHaveText("Elsewhere");
  await expect(page.locator(".app")).toHaveAttribute("data-section", "elsewhere");
  // Standing ON /backup, the "Open backup" row's destination is this very
  // route: it renders as a non-interactive "you are here" marker, not a button
  // that goes nowhere.
  const here = page.locator(".app-side .side-item.is-here");
  await expect(here).toBeVisible();
  await expect(here.locator(".name")).toHaveText("Backup");
  await expect(here.locator("button")).toHaveCount(0);
  await expect(
    page.locator(".app-side .side-item-main", { hasText: "Open backup" }),
  ).toHaveCount(0);
});

test("navigator: the attention plaque explains a problem before opening its selected item", async ({
  page,
}) => {
  await page.goto("/?contextAttention=1#/bundle/legacy-tools");
  await expect(head(page)).toHaveText("Context");
  const plaque = page.locator(".app-side .side-attn");
  await expect(plaque).toBeVisible();
  await expect(plaque).toHaveAttribute("data-worst", "error");
  // The fixture's steady default already has one conflicted skill
  // (`code-review`) ahead of the flag's own `ds-tokens`/`legacy-tools`
  // findings — errors sort first in push order, so that is the real first
  // offender here, not a scene-flag artifact.
  await plaque.locator(".side-attn-line").first().click();
  await expect(page).toHaveURL(/#\/bundle\/legacy-tools$/);
  const dialog = page.getByRole("dialog", { name: "Skill invocation settings conflict" });
  await expect(dialog).toContainText("code-review");
  await dialog.getByRole("button", { name: "Inspect invocation: code-review" }).click();
  await expect(page).toHaveURL(/#\/skill\/code-review$/);
});


test("navigator: narrow same-route action reveals the screen; Escape restores the row", async ({ page }) => {
  await page.setViewportSize({ width: 600, height: 900 });
  await gotoReady(page, "/?guardrailsAttention=1#/permissions");
  await page.getByRole("button", { name: "Toggle navigation", exact: true }).click();
  const row = page.getByRole("button", { name: /Codex runs without restrictions, show details/ });
  await row.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Codex commands have unrestricted access" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(row).toBeFocused();
  await page.keyboard.press("Enter");
  await dialog.getByRole("button", { name: "Review Codex permissions" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".app-main")).not.toHaveAttribute("inert", "");
  await expect(page.locator(".app-side")).toHaveAttribute("inert", "");
  await expect(page.getByRole("button", { name: "Toggle navigation", exact: true })).toBeFocused();
});

test("navigator: an unavailable enabled agent explains the problem before a working disable action", async ({ page }) => {
  await page.goto("/?agentsAttention=1#/harness/codex");
  await page.locator(".side-attn-line", { hasText: "not installed" }).click();
  const dialog = page.getByRole("dialog", { name: "Enabled agents are not installed" });
  await expect(dialog).toBeVisible();
  await expect(page).toHaveURL(/#\/harness\/codex$/);
  await dialog.getByRole("button", { name: "Open Harnesses" }).click();
  await expect(page).toHaveURL(/#\/harnesses$/);
  const toggle = page.getByRole("checkbox", { name: "Enable opencode globally" });
  await expect(toggle).toBeChecked();
  await expect(toggle).toBeEnabled();
  await toggle.uncheck();
  await expect(toggle).not.toBeChecked();
  await expect(toggle).toBeDisabled();
  await expect(page.locator(".side-attn-line", { hasText: "not installed" })).toHaveCount(0);
});


test("navigator: long sync diagnostics stay collapsed until requested", async ({ page }) => {
  await page.goto("/?syncErrorLong=1#/project/example-app");
  const opener = page.locator(".side-attn-line", { hasText: "sync failed" });
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "Project sync failed" });
  await expect(dialog.getByText("24 missing sources", { exact: true })).toBeVisible();
  await expect(dialog.locator("pre")).toHaveCount(0);
  const diagnostics = dialog.getByRole("button", { name: "Full diagnostics: example-app" });
  await diagnostics.focus();
  await page.keyboard.press("Enter");
  await expect(dialog.locator("pre")).toContainText("worktree/skill-24");
  await page.keyboard.press("Escape");
  await expect(opener).toBeFocused();
  await opener.click();
  await expect(dialog.locator("pre")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Open project: example-app" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/project\/example-app\?tab=loadout/);
});
