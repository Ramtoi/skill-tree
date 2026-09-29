import { test, expect } from "./fixtures";

// The J3 journey (plans/E1.md §5, case 30): "see what a server IS and
// whether it is really delivered" — the MCP editor panel replaces the old
// markdown buffer for `type: mcp-server`. Mocked-Tauri dev server
// (VISUAL_MOCK=1 → src/mocks/tauriCore.ts). NEVER touches ~/.claude.
// E2 (plans/E2.md §5 case 26, m11) adds the J1 journey — wiring an existing
// server through the New sheet — plus a band walk, as two more `test()`s.

test("MCP panel: never-probed → Check → answered → edit → save", async ({ page }) => {
	await page.goto("/#/skill/context7");

	const panel = page.locator('[data-testid="mcp-panel"]');
	await expect(panel).toBeVisible();
	// The document column is the panel, never a CodeMirror instance.
	await expect(page.locator(".cm-editor")).toHaveCount(0);

	const checkButton = page.locator('[data-testid="mcp-check-button"]');
	// Never probes on mount — the resting line is honest, not a fake "checking".
	await expect(page.getByText("Never checked.")).toBeVisible();
	await expect(checkButton).toHaveText("Check");

	await checkButton.click();
	// DELIVERY answers liveness only; the counts belong to CAPABILITIES, which
	// pages the full catalogue while `probe.tool_count` is one un-paginated
	// `tools/list`. Assert the split rather than just the happy word.
	const deliveryResult = page.locator(".mcp-probe-line");
	await expect(deliveryResult).toHaveText(/Answered/);
	await expect(deliveryResult).not.toHaveText(/tool/);
	await expect(page.locator(".mcp-probe-detail").first()).toHaveText(/ms/);
	await expect(page.locator(".mcp-capabilities-line")).toHaveText(/tool/);
	await expect(checkButton).toHaveText("Check again");

	// Edit the URL field — the Save button gains the unsaved dot.
	const urlField = page.locator('input[placeholder="https://mcp.example.com/mcp"]');
	await urlField.fill("https://mcp.context7.com/mcp/v2");
	await expect(page.locator(".btn-signal-dot")).toBeVisible();

	await page.keyboard.press("ControlOrMeta+s");
	await expect(page.locator(".toast", { hasText: "Server updated" })).toBeVisible();
	await expect(page.locator(".btn-signal-dot")).toHaveCount(0);
});

test("MCP panel: Check shows the in-flight label while a probe is running", async ({ page }) => {
	await page.goto("/?mcpProbeHangs=1#/skill/context7");

	const panel = page.locator('[data-testid="mcp-panel"]');
	await expect(panel).toBeVisible();

	const checkButton = page.locator('[data-testid="mcp-check-button"]');
	await checkButton.click();
	await expect(checkButton).toHaveText("Checking…");
	await expect(page.getByText("Talking to the server…")).toBeVisible();
});

// ─── plans/E2.md §5 case 26 (m11) — the J1 journey ───────────────────────────
// "Wire an existing server" — the New sheet's zero-friction path (D1), the
// one stdin submit path (M8), the literal-secret plaque (F4/m5), and the
// probe-primed panel (m6) all in one walk.

test("J1: paste an existing server, resolve its secret, and land on the panel with a probe result", async ({ page }) => {
	await page.goto("/?mcpCandidates=1#/?new=1");
	await expect(page.locator(".palette-backdrop .palette")).toBeVisible();

	await page.locator(".palette-backdrop .palette select").first().selectOption("mcp-server");
	await expect(page.getByRole("radio", { name: "Add existing server" })).toBeChecked();

	await page
		.getByPlaceholder(/mcp.example.com/)
		.fill(
			JSON.stringify({
				type: "http",
				url: "https://mcp.notion.example.com/mcp",
				headers: { Authorization: "Bearer sk-live-notion12345678" },
			}),
		);
	await expect(page.getByText("A token is written in plain text")).toBeVisible();

	await page.getByRole("button", { name: /Replace with/ }).click();
	await expect(page.locator(".palette-backdrop .palette textarea")).toHaveValue(/Bearer \$\{/);

	await page.getByPlaceholder("my-skill-name").fill("notion-mcp");
	await page.getByRole("button", { name: "Add server" }).click();

	await expect(page).toHaveURL(/\/skill\/notion-mcp/);
	await expect(page.locator('[data-testid="mcp-panel"]')).toBeVisible();
	await expect(page.getByText("Never checked.")).not.toBeVisible();
	await expect(page.getByText(/Answered/)).toBeVisible();
});

// ─── plans/G.md §6/§7 — the MCP capability catalogue ─────────────────────────
// CAPABILITIES sits between DELIVERY and REACH; it reads the SAME `qk.mcpShow`
// key `McpDeliveryBlock` already fetches on mount (no extra CLI call, no
// arming of its own), and its data only appears once a `Check` has actually
// run — the "not checked" copy must be honest, never a fake zero.

test("MCP capabilities: honest empty state before a Check, real counts after", async ({ page }) => {
	await page.goto("/#/skill/context7");

	const block = page.locator('[data-testid="mcp-capabilities-block"]');

	// This step's reason (the honest empty state, then real counts after a
	// Check) is hard: step 2 below needs the browse button this step proves
	// exists.
	await test.step("honest empty state before a Check, real counts after", async () => {
		await expect(block).toBeVisible();
		await expect(
			block.getByText("Not checked yet. Check the connection above to read what this server offers."),
		).toBeVisible();
		await expect(page.locator('[data-testid="mcp-capabilities-browse"]')).toHaveCount(0);

		await page.locator('[data-testid="mcp-check-button"]').click();
		await expect(block.getByText(/44 tools/)).toBeVisible();
		await expect(page.locator('[data-testid="mcp-capabilities-browse"]')).toBeVisible();
	});

	await test.step("browse a tool, read its parameters and a declared annotation chip", async () => {
		await page.locator('[data-testid="mcp-capabilities-browse"]').click();

		// `get_page` declares a `title` ("Get Page") that differs from its wire
		// name — rev 3 §11.4: the title is the primary label, the name stays a
		// secondary suffix, never hidden.
		await page.locator('[data-testid="mcp-sheet-row"]', { hasText: "Get Page" }).click();
		const detail = page.locator('[data-testid="mcp-sheet-tool-detail"]');
		await expect.soft(detail).toBeVisible();
		await expect.soft(detail.getByText("get_page")).toBeVisible();

		const params = detail.locator('[data-testid="mcp-parameters-table"]');
		await expect.soft(params).toContainText("id");
		await expect.soft(params).toContainText("required");
		await expect.soft(params).toContainText("format");
		await expect.soft(params).toContainText("markdown");

		// A server-declared annotation renders as a neutral Chip carrying the
		// "untrusted hint" title — never a RiskBadge (rev 3 §11.6).
		const chip = detail.locator(".chip", { hasText: "read-only" });
		await expect.soft(chip).toBeVisible();
		await expect.soft(chip).toHaveAttribute("title", /does not verify/);
	});
});

test("MCP capability sheet: a tool with an outputSchema shows a collapsed RETURNS table", async ({ page }) => {
	await page.goto("/#/skill/context7");
	await page.locator('[data-testid="mcp-check-button"]').click();
	await page.locator('[data-testid="mcp-capabilities-browse"]').click();

	await page.locator('[data-testid="mcp-sheet-row"]', { hasText: "create_page" }).click();
	const returns = page.locator(".mcp-sheet-returns");
	await expect(returns).toBeVisible();

	const returnsTable = returns.locator('[data-testid="mcp-parameters-table"]');
	// Collapsed by default so it never competes with the input parameters.
	await expect(returnsTable).not.toBeVisible();
	await returns.locator("summary").click();
	await expect(returnsTable).toBeVisible();
	await expect(returnsTable).toContainText("url");
});

test("MCP capability sheet: ArrowDown selects rows, / returns focus to search", async ({ page }) => {
	await page.goto("/?mcpCatalogUnreadable=1#/skill/context7");
	await page.locator('[data-testid="mcp-check-button"]').click();
	await page.locator('[data-testid="mcp-capabilities-browse"]').click();

	// This step's reason (keyboard row selection and search-focus return) is
	// hard: it is the sheet's own real-focus behavior, not a rendered label.
	await test.step("ArrowDown selects rows, / returns focus to search", async () => {
		// Opens with focus already in the search field (the standard palette
		// pattern) — typing and arrowing compose without an extra click.
		const search = page.locator('[data-testid="mcp-sheet-search"]');
		await expect(search).toBeFocused();

		const rows = page.locator('[data-testid="mcp-sheet-row"]');
		await expect(rows).toHaveCount(1);
		await page.keyboard.press("ArrowDown");
		await expect(rows.first()).toHaveAttribute("data-selected", "true");
		await expect(search).toBeFocused();

		// Clicking a row moves focus away from search; "/" brings it straight back.
		await rows.first().click();
		await expect(search).not.toBeFocused();
		await page.keyboard.press("/");
		await expect(search).toBeFocused();
	});

	await test.step("an unreadable schema says so, never a lying empty parameter list", async () => {
		await page.locator('[data-testid="mcp-sheet-row"]', { hasText: "legacy_tool" }).click();
		await expect.soft(page.getByText("This tool declares no readable parameters.")).toBeVisible();
	});
});
