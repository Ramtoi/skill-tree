import { test, expect, type Page } from "./fixtures";

// Self-test for the automatic browser-error check in `./fixtures`. Each body
// passes on its own. The `test.fail()` cases pass only because the fixture's
// teardown check fails them; if the check is disabled or stops seeing an
// error type, they become unexpected passes and this file fails.
//
// The pages stay on about:blank, so no app code adds its own errors.

async function emitConsoleError(page: Page, text: string) {
  await Promise.all([
    page.waitForEvent("console", (msg) => msg.type() === "error" && msg.text() === text),
    page.evaluate((message) => console.error(message), text),
  ]);
}

async function emitPageError(page: Page, text: string) {
  await Promise.all([
    page.waitForEvent("pageerror", (err) => err.message === text),
    page.evaluate((message) => {
      setTimeout(() => {
        throw new Error(message);
      });
    }, text),
  ]);
}

test("an unexpected console.error fails an otherwise passing test", async ({ page }) => {
  test.fail();
  await emitConsoleError(page, "self-test console error");
  expect(true).toBe(true);
});

test("an unexpected pageerror fails an otherwise passing test", async ({ page }) => {
  test.fail();
  await emitPageError(page, "self-test page error");
  expect(true).toBe(true);
});

test("allowErrors lets a matching console.error and pageerror pass", async ({ page, allowErrors }) => {
  allowErrors(/self-test console error/, "self-test");
  allowErrors(/self-test page error/, "self-test");
  await emitConsoleError(page, "self-test console error");
  await emitPageError(page, "self-test page error");
});

test("allowErrors does not excuse an error that does not match", async ({ page, allowErrors }) => {
  test.fail();
  allowErrors(/some other error/, "self-test");
  await emitConsoleError(page, "self-test console error");
});

test("console.warn is not collected", async ({ page }) => {
  await Promise.all([
    page.waitForEvent("console", (msg) => msg.type() === "warning"),
    page.evaluate(() => console.warn("self-test warning")),
  ]);
});
