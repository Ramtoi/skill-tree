import { test, expect } from "./fixtures";

// The Library's unified floating search, driven against the mocked-Tauri dev
// server (VISUAL_MOCK=1 → src/mocks/tauriCore.ts). NEVER touches ~/.claude.
// Covers the kind pill escape hatch, the bundle/snippet body-hit mode, and
// the keyboard contract (Esc ladder, Enter). §11: the floating bar never
// lists results itself — every match renders in the Library's own body.
//
// Wave 2 adds content search (skill/snippet BODY text) over the same mock
// registry. The "brainstorm" absent for "andr", and "no skill row" for
// "conventions", assertions below are NEGATIVES that hold only because no
// mock body contains those substrings — pinned once, in code, by
// `src/test/searchCorpusMockFidelity.test.ts`, so a future body edit that
// violates it fails a fast unit test instead of a flaky e2e run.

/** Move DOM focus off whatever's focused, so a fresh `/` press starts clean. */
async function blur(page: import("@playwright/test").Page) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

async function openLibrarySearch(page: import("@playwright/test").Page) {
  await page.goto("/#/");
  const bar = page.getByTestId("floating-search");
  await expect(bar).toBeVisible();
  await expect(bar).toHaveAttribute("data-state", "idle");
  await page.keyboard.press("/");
  await expect(page.getByTestId("floating-search-input")).toBeFocused();
  await expect(bar).toHaveAttribute("data-state", "focused");
}

// §10.17: kind = bundle renders BODY rows (not a "Bundles aren't rows here"
// placard) — the list is gone, and clicking a row navigates directly.
// §10.17 test 8: the pill is the escape hatch with the stack closed — folded
// in from the cut "the kind pill survives a blur and clears the mode when
// clicked" (same BUNDLES-chip setup).
test("the BUNDLES chip renders body rows in place of the list; a row navigates", async ({ page }) => {
  await openLibrarySearch(page);
  await page
    .getByTestId("floating-search-kinds")
    .getByRole("button", { name: /^BUNDLES/ })
    .click();

  await expect.soft(page.locator(".lib-list")).toHaveCount(0);
  const androidRow = page.locator(
    '[data-testid="library-body-hit"][data-kind="bundle"][data-id="android"]',
  );
  await expect.soft(androidRow).toBeVisible();

  await blur(page);
  const pill = page.getByTestId("floating-search-kind-pill");
  await expect.soft(pill).toBeVisible();
  await expect.soft(pill).toContainText("BUNDLES");
  // Body rows persist while the pill is the only trace the mode is active.
  await expect.soft(page.locator('[data-testid="library-body-hit"]').first()).toBeVisible();

  await pill.click();
  await expect.soft(page.getByTestId("floating-search-kind-pill")).toHaveCount(0);
  await expect.soft(page.locator(".lib-list")).toBeVisible();

  // The pill click restored the list and left the bar idle (blurred) again —
  // reopen it before picking BUNDLES a second time.
  await page.keyboard.press("/");
  await expect(page.getByTestId("floating-search-input")).toBeFocused();
  await page
    .getByTestId("floating-search-kinds")
    .getByRole("button", { name: /^BUNDLES/ })
    .click();
  await expect(androidRow).toBeVisible();
  await androidRow.click();
  await expect(page).toHaveURL(/#\/bundle\/android/);
});

test("the bar never covers the last row", async ({ page }) => {
  await page.goto("/#/");
  await expect(page.locator(".app-main")).toBeVisible();

  await page.locator(".main-body").evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });

  const rowBox = (await page.locator(".skill-row").last().boundingBox())!;
  const barBox = (await page.getByTestId("floating-search").boundingBox())!;
  expect(rowBox.y + rowBox.height).toBeLessThanOrEqual(barBox.y);
});

// M4: the CLOSED-bar test above only proves clearance for the bar itself —
// the OPEN stack (the kind chip row) needs its own reservation.
test("the open stack never covers the last row either", async ({ page }) => {
  await openLibrarySearch(page);
  await page.keyboard.type("an");

  await page.locator(".main-body").evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });

  // review M1: after §11 the body's last content can be a `library-body-hit`
  // row (the BUNDLES/SNIPPETS groups), not a `.skill-row` — measure whichever
  // is actually last, or the regression this test exists to catch (a
  // cross-entity row hidden under the chip row) would pass silently.
  const rowBox = (
    await page.locator('.skill-row, [data-testid="library-body-hit"]').last().boundingBox()
  )!;
  const kindsBox = (await page.getByTestId("floating-search-kinds").boundingBox())!;
  expect(rowBox.y + rowBox.height).toBeLessThanOrEqual(kindsBox.y);
});

// G13: Enter now OPENS the cursor row (navigates) rather than merely
// focusing it — "andr" also matches the "android" BUNDLE's own name, so the
// reset cursor (row 0, G9) is that cross-entity hit (G1: it renders before
// the skill rows).
test("Enter with a query opens the cursor row — here the BUNDLES hit, since the query also matches the android bundle (G13)", async ({ page }) => {
  await openLibrarySearch(page);
  await page.keyboard.type("andr");

  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#\/bundle\/android/);
});

// ─── S2/S3/G4: the arrow cursor and the kind cycle ────

test("S2: ArrowDown twice from the input, then Enter, opens the third result", async ({ page }) => {
  await openLibrarySearch(page);
  await page.keyboard.type("android");

  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");

  const activeName = await page
    .locator('[data-listnav-active="true"] .resource-name')
    .first()
    .getAttribute("title");
  expect(activeName).toBeTruthy();

  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`#/skill/${activeName}`));
});

test("S3/G12: ArrowLeft from ALL wraps to SNIPPETS", async ({ page }) => {
  await openLibrarySearch(page);
  await page.keyboard.press("ArrowLeft");

  const pill = page.getByTestId("floating-search-kind-pill");
  await expect(pill).toBeVisible();
  await expect(pill).toContainText("SNIPPETS");
});

// G4: `scrollIntoView({block:"nearest"})` respects `scroll-padding-bottom` —
// walking the arrow-cursor all the way to the last result must never leave it
// hidden under the open stack (the closed-bar and open-stack DOM-scroll
// variants of this are covered above; this is the KEYBOARD-CURSOR variant).
test("G4: walking the arrow-cursor to the last result keeps it above the open stack (dock occlusion)", async ({ page }) => {
  await openLibrarySearch(page);

  for (let i = 0; i < 40; i++) {
    await page.keyboard.press("ArrowDown");
  }

  const active = page.locator('[data-listnav-active="true"]');
  await expect(active).toBeVisible();
  const activeBox = (await active.boundingBox())!;
  const kindsBox = (await page.getByTestId("floating-search-kinds").boundingBox())!;
  expect(activeBox.y + activeBox.height).toBeLessThanOrEqual(kindsBox.y);
});

// Wave 2: content search. "quorum" appears in NO skill/bundle/snippet name,
// description, or tag — only in the brainstorm skill's BODY and the
// android-conventions snippet's body (see tauriCore.ts's search-corpus
// comment). This is the one query that can only be answered by reading body
// text, so it proves the feature end to end.
test("a word that only exists in a skill's body still finds it, and says why", async ({ page }) => {
  await openLibrarySearch(page);
  await page.keyboard.type("quorum");

  const row = page.locator(".lib-list .skill-row", { hasText: "brainstorm" });
  await expect(row).toBeVisible();
  const excerpt = row.locator(".resource-excerpt");
  await expect(excerpt).toBeVisible();
  await expect(excerpt.locator("mark")).toHaveText("quorum");

  // "code-review" has no "quorum" anywhere (its own marker is "lighthouse").
  await expect(page.locator(".lib-list .skill-row", { hasText: "code-review" })).toHaveCount(0);
});

// ─── Wave 2 (PLAN-2-return.md): the Library remembers where you were ────────

/** The active row's identity, independent of whether it's a cross-entity
 *  body hit or a skill/mcp row — so a "same row after return" assertion
 *  never has to know which fixture item the cursor happens to land on. */
async function activeRowIdentity(page: import("@playwright/test").Page): Promise<string> {
  const active = page.locator('[data-listnav-active="true"]').first();
  const bodyHit = active.locator('[data-testid="library-body-hit"]');
  // Both call sites below type "an" and arrow down once, which
  // deterministically lands the cursor on the openspec bundle's body hit —
  // assert the branch explicitly instead of silently falling through to the
  // skill/mcp name path.
  await expect(bodyHit).toHaveCount(1);
  return `${await bodyHit.getAttribute("data-kind")}:${await bodyHit.getAttribute("data-id")}`;
}

test("R3: goBack after opening a result restores the query, cursor, and focus", async ({ page }) => {
  await openLibrarySearch(page);
  await page.keyboard.type("an");
  await page.keyboard.press("ArrowDown");
  const before = await activeRowIdentity(page);

  await page.keyboard.press("Enter");
  await expect(page).not.toHaveURL(/#\/$/);

  await page.goBack();
  await expect(page.getByTestId("floating-search-input")).toHaveValue("an");
  await expect(page.getByTestId("floating-search-input")).toBeFocused();
  const after = await activeRowIdentity(page);
  expect(after).toBe(before);

  // "g l" afterwards is a FRESH Library, not the one just left.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("g");
  await page.keyboard.press("l");
  await expect(page.getByTestId("floating-search-input")).toHaveValue("");
});

// H1/H10: the explicit header back arrow carries the same restore payload a
// real history pop would — not just browser Back.
test("H1: the header back arrow restores the query, cursor, and focus", async ({ page }) => {
  await openLibrarySearch(page);
  await page.keyboard.type("an");
  await page.keyboard.press("ArrowDown");
  const before = await activeRowIdentity(page);

  await page.keyboard.press("Enter");
  await expect(page.locator(".header-back")).toBeVisible();

  await page.locator(".header-back").click();
  await expect(page.getByTestId("floating-search-input")).toHaveValue("an");
  await expect(page.getByTestId("floating-search-input")).toBeFocused();
  const after = await activeRowIdentity(page);
  expect(after).toBe(before);
});

// H10: every keystroke writes the URL with `replace` — never a push.
// Finding 2: with the debounce gone, the URL write is no longer buffered
// behind a fixed delay — it can still lag a render or two behind the
// keystroke (the mirror effect, not the keystroke itself, owns the write).
// Reading `history.length` before that write has SETTLED would race it, so
// wait for the URL to actually contain what was typed first.
test("H10: five keystrokes never grow the history stack", async ({ page }) => {
  await openLibrarySearch(page);
  const before = await page.evaluate(() => window.history.length);
  await page.keyboard.type("andro", { delay: 20 });
  await expect(page).toHaveURL(/[?&]q=andro/);
  const after = await page.evaluate(() => window.history.length);
  expect(after).toBe(before);
});

// Finding 0 (root cause): the controlled input's value used to be derived
// from `searchParams`, which react-router 7 updates inside `startTransition`
// — a burst of keystrokes could re-render the input against a stale,
// not-yet-settled URL value and visibly drop characters. `q` is now LOCAL
// state (the fix), so the input can never lose a keystroke; the URL mirror
// may lag a render behind but always converges. Twelve real keydown events
// at zero delay is the sharpest version of the burst that used to drop
// characters — assert both the input's live value AND the settled URL carry
// every character, in order.
test("finding 0: 12 fast keystrokes (delay: 0) drop no characters — input and URL both settle to the full string", async ({ page }) => {
  await openLibrarySearch(page);
  const typed = "abcdefghijkl"; // 12 characters, delay 0 — the burst that used to drop characters
  await page.keyboard.type(typed, { delay: 0 });

  // The input's LIVE value must be complete immediately — this is the whole
  // point of `q` being local state rather than derived from the URL.
  await expect(page.getByTestId("floating-search-input")).toHaveValue(typed);

  // The URL mirror may lag a render or two behind the last keystroke —
  // `expect.poll` waits for it to settle rather than reading it too early.
  await expect
    .poll(() => page.evaluate(() => window.location.hash))
    .toContain(`q=${typed}`);
});
