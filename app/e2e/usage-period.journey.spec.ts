import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { gotoReady } from "./helpers";

// A: every chart selection for a period opens the same complete period,
// with no scan and (round trip) keyboard focus returned to the trigger.
type ChartRow = {
  period: "day" | "week" | "month";
  radio: string;
  key: string;
  label: string;
  extraTriggers?: (page: Page) => Locator[];
  urlRegex?: RegExp;
  scopeText?: string;
  check?: (dialog: Locator) => Promise<void>;
};

const CHART_ROWS: ChartRow[] = [
  {
    period: "day",
    radio: "Day",
    key: "2026-07-14",
    label: "Tue, Jul 14, 2026:",
    extraTriggers: (page) => [page.getByRole("gridcell", { name: /tokens on July 14, 2026$/ })],
    check: async (dialog) => {
      await expect(dialog.locator(".usage-day-metrics .value").last()).toHaveText("8");
    },
  },
  {
    period: "week",
    radio: "Week",
    key: "2026-07-13",
    label: "Week of Jul 13, 2026:",
    urlRegex: /week=2026-07-13/,
    scopeText: "All harnesses · Weekly usage",
  },
  {
    period: "month",
    radio: "Month",
    key: "2026-07",
    label: "July 2026:",
    urlRegex: /month=2026-07/,
    scopeText: "All harnesses · Monthly usage",
  },
];

for (const row of CHART_ROWS) {
  test(`${row.period}: every chart selection opens the same ${row.period} without a scan`, async ({ page }) => {
    await page.goto("/#/usage");
    await page.getByRole("radio", { name: row.radio, exact: true }).click();
    const triggers = [
      page.getByRole("region", { name: "Spend over time", exact: true }).locator(`.chart-col[aria-label^="${row.label}"]`),
      page.getByRole("region", { name: "Skills used", exact: true }).locator(`.line-chart-point[data-x="${row.key}"]`).first(),
      page.getByRole("region", { name: "Tool activity", exact: true }).locator(`.line-chart-point[data-x="${row.key}"]`).first(),
      page.getByRole("region", { name: "Model mix", exact: true }).locator(`.chart-col[aria-label^="${row.label}"]`),
      ...(row.extraTriggers?.(page) ?? []),
    ];
    const dialog = row.period === "day"
      ? page.getByRole("dialog", { name: "Usage for Tuesday, July 14, 2026" })
      : page.getByRole("dialog");
    let expected: string[] | undefined;
    for (const [index, trigger] of triggers.entries()) {
      await trigger.focus();
      if (index === 0) await trigger.click(); else await trigger.press(index % 2 ? "Enter" : "Space");
      await expect(dialog).toBeVisible();
      if (row.urlRegex) await expect(page).toHaveURL(row.urlRegex);
      if (row.scopeText) await expect(dialog.getByText(row.scopeText)).toBeVisible();
      if (row.period !== "day") await expect(dialog.locator(".usage-day-tools")).toBeVisible();
      await row.check?.(dialog);
      const values = await dialog.locator(".usage-day-metrics .value").allTextContents();
      if (expected) expect(values).toEqual(expected); else expected = values;
      await expect(dialog.getByText("Snippets screen redesign", { exact: true })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(dialog).not.toBeVisible();
      await expect(trigger).toBeFocused();
    }
    const calls = await page.evaluate(() => (window as unknown as { __invokeCalls: { cmd: string; args?: { args?: string[] } }[] }).__invokeCalls);
    expect(calls.some(call => call.cmd === "usage_scan_ccusage" || call.args?.args?.includes("scan-sessions"))).toBe(false);
  });
}

// B: a period outside the dashboard's default range keeps its scope through
// search, navigation and session inspection.
type OutsideRow = {
  period: "day" | "week";
  flow: (page: Page) => Promise<void>;
};

const OUTSIDE_ROWS: OutsideRow[] = [
  {
    period: "day",
    flow: async (page) => {
      const trigger = page.getByRole("gridcell", { name: /tokens on July 14, 2026$/ });
      await trigger.click();
      let dialog = page.getByRole("dialog");
      await expect(dialog.getByText("Snippets screen redesign", { exact: true })).toBeVisible();
      await dialog.getByRole("textbox", { name: "Search this day's sessions" }).fill("Snippets");
      await expect(dialog.getByTestId("usage-session-row")).toHaveCount(1);
      await dialog.getByRole("button", { name: "Next day" }).click();
      await dialog.getByRole("button", { name: "Previous day" }).click();
      await expect(dialog.getByRole("textbox", { name: "Search this day's sessions" })).toHaveValue("");
      await dialog.getByText("Snippets screen redesign", { exact: true }).click();
      await dialog.getByRole("button", { name: "Inspect session", exact: true }).click();
      await expect(page).toHaveURL(/usage\/session\//);
      await page.getByRole("button", { name: "Back to Usage" }).click();
      dialog = page.getByRole("dialog", { name: "Usage for Tuesday, July 14, 2026" });
      await expect(dialog).toBeVisible();
      await dialog.getByRole("button", { name: "Close", exact: true }).click();
      await expect(page.getByRole("radio", { name: "7 days", exact: true })).toBeChecked();
    },
  },
  {
    period: "week",
    flow: async (page) => {
      await page.getByRole("radio", { name: "Weekly", exact: true }).click();
      await page.getByRole("gridcell", { name: /tokens in the week of July 13, 2026$/ }).last().click();
      const dialog = page.getByRole("dialog");
      await expect(page).toHaveURL(/week=2026-07-13/);
      await expect(dialog.locator(".usage-day-title")).toHaveText("Jul 13, 2026 – Jul 19, 2026");
      await dialog.getByRole("textbox", { name: "Search this week's sessions" }).fill("Snippets");
      await dialog.getByRole("button", { name: "Next week" }).click();
      await expect(page).toHaveURL(/week=2026-07-20/);
      await dialog.getByRole("button", { name: "Previous week" }).click();
      await expect(page).toHaveURL(/week=2026-07-13/);
      await expect(dialog.getByRole("textbox", { name: "Search this week's sessions" })).toHaveValue("");
      await dialog.getByText("Snippets screen redesign", { exact: true }).click();
      await dialog.getByRole("button", { name: "Inspect session", exact: true }).click();
      await page.getByRole("button", { name: "Back to Usage" }).click();
      await expect(page).toHaveURL(/week=2026-07-13/);
      await expect(dialog).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("radio", { name: "7 days", exact: true })).toBeChecked();
      await expect(page.getByRole("radio", { name: "Weekly", exact: true })).toBeChecked();
    },
  },
];

for (const row of OUTSIDE_ROWS) {
  test(`${row.period} outside the range keeps its scope through search, navigation and inspection`, async ({ page }) => {
    // Both rows open the same "outside the default range" scope before
    // branching into their own period control.
    await page.goto("/#/usage");
    await page.getByRole("radio", { name: "7 days", exact: true }).click();
    await row.flow(page);
  });
}

// C: at 520px the modal keeps the Codex scope, shows no session list, and
// does not overflow.
type NarrowRow = {
  period: "day" | "month";
  scopeText: string;
  open: (page: Page) => Promise<void>;
  extra: (page: Page, dialog: Locator) => Promise<void>;
};

const NARROW_ROWS: NarrowRow[] = [
  {
    period: "day",
    scopeText: "Codex · Daily usage",
    open: async (page) => {
      await page.getByRole("gridcell", { name: /tokens on July 14, 2026$/ }).click();
    },
    extra: async (page, dialog) => {
      expect(await dialog.locator(".modal-body").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      const arrows = await dialog.locator(".usage-day-nav .btn").evaluateAll(buttons => buttons.map(button => {
        const box = button.getBoundingClientRect();
        const path = button.querySelector("svg path")!.getBoundingClientRect();
        return { x: Math.abs(path.x + path.width / 2 - box.x - box.width / 2), y: Math.abs(path.y + path.height / 2 - box.y - box.height / 2) };
      }));
      for (const arrow of arrows) { expect(arrow.x).toBeLessThan(0.1); expect(arrow.y).toBeLessThan(0.1); }
      await dialog.getByRole("button", { name: "Previous day" }).focus();
      await page.keyboard.press("Shift+Tab");
      expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
    },
  },
  {
    period: "month",
    scopeText: "Codex · Monthly usage",
    open: async (page) => {
      await page.getByRole("radio", { name: "Month", exact: true }).click();
      await page.getByRole("region", { name: "Spend over time", exact: true }).locator('.chart-col[aria-label^="July 2026:"]').click();
    },
    extra: async (_page, dialog) => {
      await dialog.getByRole("button", { name: "Next month" }).click();
      await expect(dialog.locator(".usage-day-title")).toHaveText("August 2026");
      await dialog.getByRole("button", { name: "Previous month" }).click();
      await expect(dialog.locator(".usage-day-title")).toHaveText("July 2026");
    },
  },
];

for (const row of NARROW_ROWS) {
  test(`${row.period} modal keeps the Codex scope and fits 520px`, async ({ page }) => {
    await page.setViewportSize({ width: 520, height: 1000 });
    await gotoReady(page, "/#/usage");
    await page.getByRole("radio", { name: "Codex", exact: true }).focus();
    await page.keyboard.press("Space");
    await row.open(page);
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText(row.scopeText, { exact: true })).toBeVisible();
    await expect(dialog.getByText("Snippets screen redesign", { exact: true })).toHaveCount(0);
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await row.extra(page, dialog);
    await page.mouse.click(4, 4);
    await expect(dialog).not.toBeVisible();
  });
}
