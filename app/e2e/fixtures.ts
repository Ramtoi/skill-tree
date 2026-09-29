import { test as base, expect, type Locator, type Page } from "@playwright/test";
import { gotoReady, waitReady, waitForPaint } from "./helpers";
import type { SceneFlagName } from "../src/mocks/scenes";

/**
 * The two widths most journeys use. `wide` clears the 820px shell breakpoint
 * (navigator panel stays docked); `narrow` puts the navigator into its
 * off-canvas drawer. See TESTS.md section 3.
 */
export const WIDTH = { wide: 1440, narrow: 520 } as const;

/**
 * Build a journey URL: scene flags in the query, the route after the hash
 * (`/?a=1&b=stdout#/route`). `true` becomes `"1"`; `false` and `undefined`
 * flags are omitted so a caller can spread an optional-flags object without
 * guarding each key. `route` must start with `/`. `flags` only accepts a
 * name declared in `SCENE_FLAGS` (`app/src/mocks/scenes.ts`) — a typo or an
 * undeclared flag is a type error.
 */
export function scene(
  route: string,
  flags?: Partial<Record<SceneFlagName, string | number | boolean>>,
): string {
  const params = new URLSearchParams();
  if (flags) {
    for (const [key, value] of Object.entries(flags)) {
      if (value === false || value === undefined) continue;
      params.set(key, value === true ? "1" : String(value));
    }
  }
  const query = params.toString();
  return query ? `/?${query}#${route}` : `/#${route}`;
}

type AllowErrors = (re: RegExp, reason: string) => void;

/**
 * Shared browser-error check, replacing the 27 copies of a local
 * `trackConsoleErrors(page)` (and 2 inline `pageerror`-only arrays). An
 * automatic fixture attaches `console` (type `error` only, matching the
 * mock's own `console.error`/`pageerror` convention — `console.warn` from
 * the mock's "unhandled command" logging does not count) and `pageerror`
 * listeners before the test body runs. A test that expects a specific
 * browser error calls `allowErrors(re, reason)`; after the test body, if the
 * body itself passed (so a test's own failure is never hidden behind this
 * check), every collected error must match an allowed pattern, or the
 * assertion lists the unmatched ones. Pages a spec opens itself via
 * `browser.newContext()` (e.g. screen-geometry's narrow-width 1440px
 * reference page) are not observed. `fixtures.self.spec.ts` proves this
 * check.
 */
export const test = base.extend<{ allowErrors: AllowErrors }>({
  allowErrors: [
    async ({ page }, use, testInfo) => {
      const collected: string[] = [];
      const allowed: { re: RegExp; reason: string }[] = [];
      const allowErrors: AllowErrors = (re, reason) => {
        allowed.push({ re, reason });
      };

      page.on("console", (msg) => {
        if (msg.type() === "error") {
          collected.push(`console.error: ${msg.text()}`);
        }
      });
      page.on("pageerror", (err) => {
        collected.push(`pageerror: ${err.message}`);
      });

      await use(allowErrors);

      // Only check a body that passed. A failed or timed-out body keeps its
      // own error in front. This does NOT compare against `expectedStatus`:
      // under `test.fail()` a body that passes must still reach this check,
      // or a `test.fail()` self-test (fixtures.self.spec.ts) could never
      // prove the check fails a test.
      if (testInfo.status !== "passed") return;

      const unmatched = collected.filter(
        (message) => !allowed.some(({ re }) => re.test(message)),
      );
      const allowedList = allowed
        .map(({ re, reason }) => `  ${re} — ${reason}`)
        .join("\n");
      expect(
        unmatched,
        `browser errors:\n${unmatched.join("\n")}` +
          (allowed.length ? `\nallowed patterns:\n${allowedList}` : ""),
      ).toEqual([]);
    },
    { auto: true },
  ],
});

export { expect, gotoReady, waitReady, waitForPaint };
export type { Page, Locator };
