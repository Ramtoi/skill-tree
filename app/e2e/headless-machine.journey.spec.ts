import { test, expect } from "./fixtures";

test.use({ viewport: { width: 1440, height: 900 } });

test("headless machine resumes setup and reviews native settings before delivery", async ({ page }) => {
  await page.goto("/#/remotes");
  await page.getByRole("main").getByRole("button", { name: /Add remote/i }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByText("Headless machine", { exact: true }).click();
  await dialog.getByRole("button", { name: "Next", exact: true }).click();
  await dialog.getByLabel("Machine id", { exact: true }).fill("journey-box");
  await dialog.getByLabel("SSH host or alias", { exact: true }).fill("fixture-box");
  await dialog.getByRole("button", { name: "Save machine draft" }).click();
  await expect(page.getByRole("heading", { name: "journey-box", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Install receiver", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Fetch host key", exact: true }).click();
  await page.getByRole("checkbox", { name: "I checked this fingerprint against the machine." }).check();
  await page.getByRole("button", { name: "Test connection", exact: true }).click();
  await page.getByRole("button", { name: "Install receiver", exact: true }).click();
  await page.getByLabel("Private Git feed URL", { exact: true }).fill("git@example.org:team/private-loadouts.git");
  await page.getByRole("checkbox", { name: "I configured private repository access for this Mac and receiver." }).check();
  await page.getByRole("button", { name: "Configure receiver", exact: true }).click();
  await page.getByLabel("Source project", { exact: true }).selectOption("example-app");
  await page.getByLabel("Remote checkout path", { exact: true }).fill("/home/example/projects/app");
  await page.getByRole("checkbox", { name: "Confirm this path manually without repository matching." }).check();
  await page.getByRole("checkbox", { name: "codex", exact: true }).uncheck();
  await page.getByRole("checkbox", { name: "claude-code", exact: true }).check();
  await page.getByRole("checkbox", { name: "permissions", exact: true }).check();
  await page.getByRole("button", { name: "Confirm checkout mapping", exact: true }).click();
  await page.getByRole("button", { name: "Preview latest loadouts", exact: true }).click();
  await expect(page.getByRole("button", { name: "Apply and start periodic delivery" })).toBeDisabled();
  await page.getByText("Review native configuration and scripts", { exact: true }).click();
  await expect(page.locator(".machine-review-entry .machine-native-review").first()).toContainText("Bash(rm:*)");
  await page.getByRole("button", { name: "Approve these native and shared changes" }).click();
  await page.getByRole("button", { name: "Apply and start periodic delivery" }).click();
  await expect(page.getByRole("button", { name: "Deliver now", exact: true })).toBeVisible();
  const polling = page.getByLabel("Polling interval in seconds", { exact: true });
  await polling.fill("120");
  await expect(page.getByText("Unsaved interval", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Save interval", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save interval", exact: true })).toBeDisabled();
  await page.reload();
  await expect(polling).toHaveValue("120");
  await expect(page.locator(".main-header").getByRole("button", { name: "Deliver now", exact: true })).toBeVisible();
  await page.locator(".main-header").getByRole("button", { name: "Pause delivery", exact: true }).click();
  await expect(page.getByRole("button", { name: "Resume delivery", exact: true })).toBeVisible();
});


test("setup can be scrolled with the mouse without moving the header", async ({ page }) => {
  await page.goto("/#/remotes");
  await page.evaluate(() => localStorage.setItem("st:mock:machines", JSON.stringify({
    "scroll-box": { id: "scroll-box", connector: "headless-loadouts", phase: "connected", sync_enabled: false,
      draft: { revision: 1, input: { ssh_host: "fixture-box", host_key_sha256: "SHA256:test", poll_interval_seconds: 60 },
        observations: { connect: "confirmed" } }, bindings: {} },
  })));
  await page.goto("/#/remote/scroll-box");
  await page.reload();
  const title = page.getByRole("heading", { name: "scroll-box", exact: true });
  await expect(title).toBeVisible();
  const header = await title.boundingBox();
  await expect(page.getByRole("button", { name: "Install receiver", exact: true })).toHaveClass(/btn-primary/);
  const delivery = page.getByRole("button", { name: "Confirm checkout mapping", exact: true });
  await expect(delivery).not.toBeInViewport();
  await page.locator(".machine-detail").hover({ position: { x: 100, y: 100 } });
  await page.mouse.wheel(0, 5000);
  await expect(delivery).toBeInViewport();
  expect((await title.boundingBox())?.y).toBe(header?.y);
});


test("discovers a shared checkout before deliberate mapping confirmation", async ({ page }) => {
  await page.goto("/#/remotes");
  await page.evaluate(() => localStorage.setItem("st:mock:machines", JSON.stringify({
    "discovery-box": { id: "discovery-box", connector: "headless-loadouts", phase: "configured", sync_enabled: false,
      draft: { revision: 1, input: { ssh_host: "fixture-box", poll_interval_seconds: 60 },
        observations: { connect: "confirmed", install: { command: "hub" }, configure: {} } }, bindings: {} },
  })));
  await page.goto("/#/remote/discovery-box");
  await page.reload();
  await page.getByRole("button", { name: "Find project checkouts", exact: true }).click();
  const checkout = page.getByRole("checkbox", { name: /home\/example\/projects\/app/ });
  await expect(checkout).not.toBeChecked();
  await expect(page.getByText("No checkout has been confirmed.")).toBeVisible();
  await checkout.check();
  await page.getByRole("checkbox", { name: "codex", exact: true }).check();
  await page.getByRole("button", { name: "Confirm selected mappings (1)", exact: true }).click();
  await expect(page.locator(".machine-bindings")).toContainText("example-app");
  await expect(page.locator(".machine-bindings")).toContainText("repository");
  await expect(page.getByRole("button", { name: "Preview latest loadouts", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Apply and start periodic delivery" })).toHaveCount(0);
});


test("failed preview is red and Resume prepares review without starting delivery", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("st:mock:machines", JSON.stringify({
    "retry-box": { id: "retry-box", connector: "headless-loadouts", phase: "bound", sync_enabled: false,
      draft: { revision: 1, input: { ssh_host: "fixture-box", poll_interval_seconds: 180 },
        observations: { connect: "confirmed", install: { command: "hub" }, configure: {}, start: {} } },
      bindings: { app: { source_project: "app", mode: "manual", harnesses: ["codex"] } },
      delivery: { state: "unsupported_source", error: { message: "Skill review-code: reference must stay inside a registered source." } } },
  })));
  await page.goto("/#/remote/retry-box");
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("reference must stay inside");
  const colors = await alert.evaluate(el => {
    const expected = document.createElement("span");
    expected.style.color = "var(--red)";
    el.append(expected);
    const result = [getComputedStyle(el).color, getComputedStyle(expected).color];
    expected.remove();
    return result;
  });
  expect(colors[0]).toBe(colors[1]);
  await page.locator(".main-header").getByRole("button", { name: "Resume delivery", exact: true }).click();
  await expect(page.getByText("Saved delivery preview", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Resume delivery", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Pause delivery", exact: true })).toHaveCount(0);
});


test("reconnects a receiver already owned by another Skill Tree installation", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("st:mock:machines", JSON.stringify({
    "reconnect-box": { id: "reconnect-box", connector: "headless-loadouts", phase: "installed", sync_enabled: false,
      draft: { revision: 3, input: { ssh_host: "fixture-box", host_key_sha256: "SHA256:test",
        feed_url: "git@example.org:team/private-loadouts.git", private_feed_confirmed: true, poll_interval_seconds: 60 },
        observations: { connect: "confirmed", install: { command: "hub" },
          channel_conflict: { feed_id: "6f4c606b201e4d5ab2518bd32fdf136d", publisher_key_id: "SHA256:0f2b9c1d7e4a6b83",
            controller_key_id: "SHA256:9a71e4c2b0d5f638", applied: { generation: 3, applied_at: "2026-09-17T12:13:14Z" } } } },
      bindings: {} },
  })));
  await page.goto("/#/remote/reconnect-box");
  await expect(page.getByText("This receiver already delivers loadouts for another Skill Tree installation.")).toBeVisible();
  await expect(page.getByText("SHA256:0f2b9c1d7e4a6b83")).toBeVisible();
  await expect(page.getByText("SHA256:9a71e4c2b0d5f638")).toBeVisible();
  await expect(page.getByText(/generation 3/)).toBeVisible();
  await page.getByRole("button", { name: "Reconnect receiver", exact: true }).click();
  await expect(page.getByText("This receiver already delivers loadouts for another Skill Tree installation.")).toHaveCount(0);
  await expect(page.locator(".machine-status")).toContainText("Automatic delivery off");
  await expect(page.getByText(/Receiver setup is saved/)).toBeVisible();
});
