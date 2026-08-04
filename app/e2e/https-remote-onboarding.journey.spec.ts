import { test, expect, type Page } from "@playwright/test";

// Wide viewport so the right-anchored wizard Sheet + master–detail panes render.
test.use({ viewport: { width: 1440, height: 900 } });

// [transport-aware-onboarding] journey: onboarding an HTTPS connector end-to-end
// against the mocked-Tauri dev server (VISUAL_MOCK=1). Exercises the registry-
// driven cards (the https "Worker Pool" comes from the mocked catalog) and the
// transport branch (endpoint + token step, NO host-key/TOFU steps, https-only
// validation). Never touches ~/.claude.

function trackConsoleErrors(page: Page) {
	const errors: string[] = [];
	page.on("console", (msg) => {
		if (msg.type() === "error") errors.push(`console.error: ${msg.text()}`);
	});
	page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
	return () =>
		expect(errors, `browser errors:\n${errors.join("\n")}`).toEqual([]);
}

test("https connector: pick from catalog → endpoint+token (no fingerprint) → register", async ({
	page,
}) => {
	const assertNoErrors = trackConsoleErrors(page);
	await page.goto("/#/remotes");
	await expect(page.locator(".app-main")).toBeVisible();

	// Open the wizard.
	await page.getByRole("button", { name: /Add remote/i }).click();
	const sheet = page.getByRole("dialog");
	await expect(sheet).toBeVisible();

	// Step 1: the HTTPS "Worker Pool" card comes from the live (mocked) catalog.
	// (Exact match — "worker pool" also appears in the Socket Pool card's blurb.)
	const workerCard = sheet.getByText("Worker Pool", { exact: true });
	await expect(workerCard).toBeVisible();
	await workerCard.click();
	await sheet.getByRole("button", { name: /^Next$/ }).click();

	// Step 2: endpoint + token — and NO host-key / TOFU controls exist here.
	await expect(sheet.getByPlaceholder("https://workers.example.com")).toBeVisible();
	await expect(sheet.getByText("Bearer token", { exact: true })).toBeVisible();
	await expect(
		sheet.getByRole("button", { name: /Fetch host key/i }),
	).toHaveCount(0);
	// The https flow is 3 steps (connector → endpoint+token → health), not 5.
	await expect(sheet.getByText(/step 2 \/ 3/)).toBeVisible();

	// Fill id + token, then a plain-http endpoint → inline fail-closed error.
	await sheet.getByPlaceholder("workers-prod").fill("workers-prod");
	await sheet.getByPlaceholder("paste token").fill("s3cr3t-token");
	await sheet
		.getByPlaceholder("https://workers.example.com")
		.fill("http://insecure.example.com");
	await expect(sheet.getByText(/must never travel in the clear/i)).toBeVisible();
	await expect(sheet.getByRole("button", { name: /^Next$/ })).toBeDisabled();

	// Fix the scheme → error clears, Next unlocks.
	await sheet
		.getByPlaceholder("https://workers.example.com")
		.fill("https://workers.example.com");
	await expect(
		sheet.getByText(/must never travel in the clear/i),
	).toHaveCount(0);
	await sheet.getByRole("button", { name: /^Next$/ }).click();

	// Step 3: health/summary → register. The mock accepts the add + health probe.
	await expect(sheet.getByText(/step 3 \/ 3/)).toBeVisible();
	await sheet.getByRole("button", { name: /Create remote/i }).click();

	// Hand-off navigates to the new remote's detail page.
	await expect(page).toHaveURL(/#\/remote\/workers-prod/);
	await expect(page.locator(".app-main")).toBeVisible();

	// And it now appears in the remotes list.
	await page.goto("/#/remotes");
	await expect(page.getByText("workers-prod").first()).toBeVisible();

	assertNoErrors();
});
