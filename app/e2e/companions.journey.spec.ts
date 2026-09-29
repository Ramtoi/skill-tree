import { test, expect } from "./fixtures";

// ships_with (D1-D5, plans/ships-with): the equip consequence gate end to
// end, driven against the mocked-Tauri dev server (VISUAL_MOCK=1 →
// src/mocks/tauriCore.ts). NEVER touches ~/.claude.
//
// example-app (not moon-base) is the mock's one project with codex in its
// effective harnesses — harnesses_global is ["claude-code"] and example-app
// adds project harnesses:["codex"], while moon-base carries no extra
// harnesses and so is claude-code only. Only example-app's dialog therefore
// exercises BOTH harness groups and the codex trust row (A2) — see u10's
// report, Deviations, for why this departs from plan 2's own moon-base
// example-app-shaped scenario.

test("equip with companions: per-harness rows, trust row first in codex, provenance lands", async ({
	page,
}) => {
	await page.goto("/#/project/example-app");
  await page.getByRole("button", { name: "Add skills", exact: true }).click();
	await expect(page.locator(".area-strip")).toBeVisible();

	const row = page.getByRole("button", { name: "Equip orchestrate-advanced" });
	await row.scrollIntoViewIfNeeded();
	await row.click();

	// The dialog opens. Its structure (one collapsed summary per effective
	// harness, the codex trust row's pinned position, the fold-reason lines,
	// and expanding a summary revealing its write-items) is a component test
	// (CompanionConsequenceDialog.test.tsx:132, :151, :176) — this journey
	// keeps only the steps that cross screens: the equip, the loadout, and the
	// `via`/`shipped by` provenance tags on other areas.
	const dialog = page.locator(".confirm-dialog");
	await expect(dialog).toBeVisible();

	// Confirm: provision the companions.
	await page.getByRole("button", { name: "Equip with companions" }).click();
	await expect(dialog).toBeHidden();

	// The loadout shows the skill equipped.
	await expect(page.locator(".project-grouped-loadout")).toContainText("orchestrate-advanced");

	// The Permissions area's shipped deny rule reads `via orchestrate-advanced`
	// — the one live surface a companion's `via` tag reliably reaches (a
	// project-scope sub-agent card never renders one in this mock, and the
	// Hooks library is project-independent by design — `shipped by`, never
	// `via`; see reports/5-u8-prov.md).
	await page.locator('.area-card[data-area="permissions"] button').click();
	// Both shipped rules (deny + ask) land on the project, so two `via` tags —
	// use `.first()` for a strict-mode-safe assertion.
	const viaTags = page.locator('[data-testid="companion-tag"][data-word="via"]');
	await expect(viaTags).toHaveCount(2);
	await expect(viaTags.first()).toBeVisible();
	await expect(viaTags.first()).toHaveAttribute("data-skill", "orchestrate-advanced");

	// The Hooks library (project-independent) reads `shipped by`, never `via`,
	// for the same companion — the two words never swap (A11).
	await page.goto("/#/hooks");
	const hookRow = page.locator(".hook-row", { hasText: "orch-scope-guard" });
	await expect(hookRow.locator('[data-testid="companion-tag"]')).toHaveAttribute(
		"data-word",
		"shipped by",
	);
	await expect(hookRow.locator('[data-testid="hook-activation"]')).toContainText(
		"orchestrate-advanced runs",
	);
});

test("equip skill only: the skill lands, no companions provisioned", async ({ page }) => {
	await page.goto("/#/project/example-app");
  await page.getByRole("button", { name: "Add skills", exact: true }).click();
	await expect(page.locator(".area-strip")).toBeVisible();

	const row = page.getByRole("button", { name: "Equip orchestrate-advanced" });
	await row.scrollIntoViewIfNeeded();
	await row.click();

	const dialog = page.locator(".confirm-dialog");
	await expect(dialog).toBeVisible();
	await page.getByRole("button", { name: "Equip skill only" }).click();
	await expect(dialog).toBeHidden();

	// The skill is equipped regardless of the choice (A4: the registry equip
	// has already landed at exit 2, before the dialog is even shown).
	await expect(page.locator(".project-grouped-loadout")).toContainText("orchestrate-advanced");

	// No companion provenance anywhere — the deny rule this skill would ship
	// is simply absent from the Permissions area.
	await page.locator('.area-card[data-area="permissions"] button').click();
	await expect(
		page.locator('[data-testid="companion-tag"][data-word="via"]'),
	).toHaveCount(0);
});

// ships-with wave 2 (plans/2.md D7/D8, query-param selection contract row 1):
// the SHIPS WITH section's row-level link + hover card, and the query contract
// row 1 (W11) — the editor's back arrow returns to the SKILL, not the list,
// when it was reached via `?agent=`.
test("skill agent saves distinct models and shared instructions across a revisit", async ({ page }) => {
	await page.goto("/#/skill/orchestrate-advanced");
	await expect(page.locator(".doc-editor-shell")).toBeVisible();
	await page.getByTestId("side-section-ships-with").click();

	// Folded from "SHIPS WITH: hover a companion agent, click through, and
	// back returns to the skill": hovering the name shows the
	// `CompanionRefCard` (D8) — kind + name + the per-harness glyph row,
	// `SkillRefCard`'s own shape. R29: the popover is portalled to
	// `document.body` (`position: fixed`), no longer a descendant of `row`.
	const row = page.getByTestId("companion-row-agent:orch-implementer");
	await expect(row).toBeVisible();
	const nameLink = row.getByTestId("companion-name");
	await nameLink.hover();
	const card = page.locator('[data-testid="companion-popover"] .companion-ref-card');
	await expect.soft(card).toBeVisible();
	await expect.soft(card).toContainText("orch-implementer");
	await expect.soft(card.locator(".companion-ref-card-glyphs")).toBeVisible();

	await nameLink.click();
	// Skill-owned agents open their shared source, with both model settings.
	await expect.soft(page).toHaveURL(/#\/skill\/orchestrate-advanced\/agent\/orch-implementer$/);

	const claude = page.getByRole("combobox", { name: "Claude Code model", exact: true });
	const codex = page.getByRole("combobox", { name: "Codex model", exact: true });
	await claude.click();
	await page.getByRole("option", { name: "opus", exact: true }).click();
	await codex.click();
	await page.getByRole("option", { name: "gpt-6-astra", exact: true }).click();
	await expect(claude).toHaveText("opus");
	await expect(codex).toHaveText("gpt-6-astra");

	const editor = page.locator(".doc-editor-body .cm-content");
	await editor.click();
	await page.keyboard.press("ControlOrMeta+End");
	await page.keyboard.type("\nShared instructions for both harnesses.");
	await page.getByRole("button", { name: /^Save(?:\s|$)/ }).click();
	await expect(page.getByRole("button", { name: /^Saved/ })).toBeVisible();

	await page.locator(".header-back").click();
	await expect(page).toHaveURL(/#\/skill\/orchestrate-advanced$/);
	const ships = page.getByTestId("side-section-ships-with");
	if (await ships.getAttribute("aria-expanded") === "false") await ships.click();
	await page.getByTestId("companion-row-agent:orch-implementer").getByTestId("companion-name").click();
	await expect(claude).toHaveText("opus");
	await expect(codex).toHaveText("gpt-6-astra");
	await expect(editor).toContainText("Shared instructions for both harnesses.");
});

// ships_with wave 3 (D12/D13/D15/D16, FRAME TWEAK): the project-less,
// all-absent read — `?companionsAbsent=1` hides every declared companion
// from the mock's sub-agent list and hooks library, so the section is
// genuinely honest about having nothing anywhere: an idle status line
// explains it, and — because EVERY row here is absent (the uniform case the
// frame tweak targets) — no row repeats that same fact as a per-row badge;
// its name is inert rather than a link to a hook screen that would 404.
// Merges "a declared skill agent opens before native provisioning" and
// "SHIPS WITH (project-less, all-absent): hovering the inert row shows the
// truthful, non-imperative sentence" as further steps of the same page load.
test("SHIPS WITH (project-less, all-absent): idle line, no per-row badge (uniform case), and an inert name that never navigates", async ({
	page,
}) => {
	await page.goto("/?companionsAbsent=1#/skill/orchestrate-advanced");
	await expect(page.locator(".doc-editor-shell")).toBeVisible();

	await page.getByTestId("side-section-ships-with").click();

	await test.step("idle line, no per-row badge, and an inert name that never navigates", async () => {
		const line = page.getByTestId("companion-status-line");
		await expect.soft(line).toBeVisible();
		await expect.soft(line).toContainText(
			"Not provisioned anywhere — equip orchestrate-advanced on a project to install these",
		);

		const row = page.getByTestId("companion-row-hook:orch-scope-guard");
		await expect.soft(row).toBeVisible();
		// FRAME TWEAK: the idle line above already says it for the whole section
		// — repeating "not provisioned" on every one of the eleven rows would be
		// noise, not signal, so the uniform all-absent case carries no per-row
		// badge at all.
		await expect.soft(page.getByTestId("companion-badge-hook:orch-scope-guard")).toHaveCount(0);

		const nameLink = row.getByTestId("companion-name");
		await expect.soft(nameLink).toHaveAttribute("data-routable", "false");

		// Clicking an inert name goes nowhere — no `/hook/…` navigation, no
		// "Hook not found" (the reported failure mode a working link would have
		// hit, since the hook definition is hidden under this flag).
		await nameLink.click();
		await expect.soft(page).toHaveURL(/#\/skill\/orchestrate-advanced$/);
		await expect.soft(page.locator("body")).not.toContainText("Hook not found");
	});

	await test.step("hovering the inert row shows the truthful, non-imperative sentence", async () => {
		const row = page.getByTestId("companion-row-hook:orch-scope-guard");
		await row.getByTestId("companion-name").hover();

		const card = page.locator('[data-testid="companion-popover"] .companion-ref-card');
		await expect.soft(card).toBeVisible();
		await expect.soft(card).toContainText("Declared by the skill — not found on Claude Code");
	});

	// Goes last: unlike the hook row above, the AGENT row is a declared skill
	// agent, which stays routable and opens its own editor even with no
	// native provisioning anywhere — and this step navigates away.
	await test.step("a declared skill agent opens before native provisioning", async () => {
		await page.getByTestId("companion-row-agent:orch-implementer").getByTestId("companion-name").click();
		await expect(page).toHaveURL(/#\/skill\/orchestrate-advanced\/agent\/orch-implementer$/);
		await expect(page.getByRole("combobox", { name: "Claude Code model", exact: true })).toBeVisible();
		await expect(page.getByRole("combobox", { name: "Codex model", exact: true })).toBeVisible();
	});
});

// A16/D11/W9 — the project Loadout's `COMPANIONS_PENDING` banner reads the
// last sync's I7 reconcile record (never a client-side prediction) and its
// `Provision` action is gate-routed: the SAME consequence dialog as the
// equip-time gate, with no `force` (A22/C1) — never a raw `--with-companions`
// bypass. `?companionsPending=1` (src/mocks/tauriCore.ts) equips
// `orchestrate-advanced` on moon-base with no ledger entry AND reports it
// pending in the sync report, so the banner has something real to show.
test("Loadout COMPANIONS_PENDING banner: Provision opens the same consequence dialog", async ({
	page,
}) => {
	await page.goto("/?companionsPending=1#/project/moon-base");
  await page.getByRole("button", { name: "Add skills", exact: true }).click();
	await expect(page.locator(".area-strip")).toBeVisible();

	const banner = page.getByTestId("companions-pending-banner");
	await expect(banner).toBeVisible();
	await expect(banner).toContainText("orchestrate-advanced");

	await page
		.getByRole("button", { name: "Provision orchestrate-advanced" })
		.click();

	const dialog = page.locator(".confirm-dialog");
	await expect(dialog).toBeVisible();
	await expect(dialog).toContainText("orchestrate-advanced");
	// moon-base carries no extra harnesses (harnesses_global is
	// ["claude-code"] only) — one harness group, unlike example-app's two
	// above, so this path exercises the single-harness shape.
	await expect(dialog.locator(".companion-harness-summary")).toHaveCount(1);

	await page.getByRole("button", { name: "Equip with companions" }).click();
	await expect(dialog).toBeHidden();
});

test("pending companion skill previews and opens with the project as its back target", async ({ page }) => {
	await page.goto("/?companionsPending=1#/project/moon-base");
	const banner = page.getByTestId("companions-pending-banner");
	const link = banner.getByRole("button", { name: "orchestrate-advanced", exact: true }).and(banner.locator(".md-skill-ref"));
	await link.hover();
	await expect(banner.locator(".skill-ref-card")).toBeVisible();
	await expect(banner.locator(".skill-ref-card-desc")).not.toBeEmpty();
	await link.focus();
	await page.keyboard.press("Enter");
	await expect(page).toHaveURL(/#\/skill\/orchestrate-advanced$/);
	await page.getByRole("button", { name: "Back to moon-base", exact: true }).click();
	await expect(banner).toBeVisible();
});

// R20/wave C (`components/companions/CompanionsEditSheet.tsx`): the section's
// `Edit` rung is live, so this drives the real Sheet end to end. Unlike
// `?companionsProvisioned=1` (which only shapes what `read_registry` RETURNS,
// a clone, never the mock's live registry — see that flag's own comment),
// this test provisions moon-base for real first, through the exact
// "Equip with companions" gate the first test above drives: that dispatch
// mutates the mock's LIVE `registry.projects` object, so deselecting a
// companion below has a REAL de-provision consequence to show (W12) and a
// REAL `stale_removed` name for the reconcile toast (I7) — not an empty
// no-op. `orch-unit-brief` is one of the skill's own INLINE hooks (R18): it
// renders as a removable row in the sheet, distinct from the (empty, in this
// fixture) library-reference picker. The route change after provisioning is
// a hash-only, same-document navigation, so the live mock state survives it.
test("SHIPS WITH: Edit, deselect a companion, and Save reconciles + toasts", async ({ page }) => {
	await page.goto("/#/project/moon-base");
  await page.getByRole("button", { name: "Add skills", exact: true }).click();
	await expect(page.locator(".area-strip")).toBeVisible();
	const equipRow = page.getByRole("button", { name: "Equip orchestrate-advanced" });
	await equipRow.scrollIntoViewIfNeeded();
	await equipRow.click();
	const equipDialog = page.locator(".confirm-dialog");
	await expect(equipDialog).toBeVisible();
	await page.getByRole("button", { name: "Equip with companions" }).click();
	await expect(equipDialog).toBeHidden();

	await page.goto("/#/skill/orchestrate-advanced");
	await expect(page.locator(".doc-editor-shell")).toBeVisible();
	await page.getByTestId("side-section-ships-with").click();

	await page.getByTestId("ships-with-edit").click();
	const sheet = page.locator(".companions-edit-sheet");
	await expect(sheet).toBeVisible();

	// The picker is a `MultiSelectList` (COMPONENTS.md: "the selection IS
	// the row's own state"), not a checkbox row — `role="option"` +
	// `aria-selected`, per Approach 9. Deselecting a declared hook states
	// what Save will de-provision, and where, BEFORE the write (W12) —
	// never a silent removal.
	await sheet.getByRole("option", { name: /orch-unit-brief/ }).click();
	await expect(sheet).toContainText("orch-unit-brief");
	await expect(sheet).toContainText("de-provision");

	await sheet.getByRole("button", { name: /^Save/ }).click();
	await expect(sheet).toBeHidden();

	// The reconcile toast names the removal and offers `Provision` for
	// whatever the same save left pending (I7, reconcileSentence).
	const toast = page.locator(".toast", { hasText: "orch-unit-brief" });
	await expect(toast).toBeVisible();
});

// Wave 4c unit 5 (plans/3.md §2.3/§7 T19) — the reverse direction, driven all
// the way from a list screen: today's Hooks row is a dead provenance tag,
// this is the literal reverse — the user decides AFTER the fact that a hook
// should ship with a skill, without leaving the Hooks screen. `lsp-report`
// (the mock's first row, a BUILTIN) is shipped by no skill today, so its row
// renders the ghost `Ship with…` button rather than an interactive
// `CompanionTag` (T17's other half already covers that branch point).
test("Reverse: Hooks row → Ship with… → pick a skill → seeded sheet → Save shows shipped by", async ({
	page,
}) => {
	await page.goto("/#/hooks");
	await expect(page.locator(".hooks-list")).toBeVisible();

	const row = page.locator(".hook-row", { hasText: "lsp-report" });
	await expect(row.locator('[data-testid="companion-tag"]')).toHaveCount(0);

	await row.getByTestId("ship-with-open").click();

	// Stage one: the skill picker (a decision, not an editing surface — a
	// `Modal`, not a `Sheet`).
	const picker = page.locator(".ship-with-picker");
	await expect(picker).toBeVisible();
	await picker.locator('[role="option"]', { hasText: "orchestrate-advanced" }).click();

	// Stage two: the flow hands straight to the seeded sheet — never both
	// overlays at once (R5).
	await expect(picker).toBeHidden();
	const sheet = page.locator(".companions-edit-sheet");
	await expect(sheet).toBeVisible();
	await expect(sheet.locator('[data-seeded="true"]')).toBeVisible();
	// The sheet is dirty from the moment it opens (§3.3) — nothing has been
	// clicked inside it yet, and Save is already meaningful.
	await expect(sheet.getByRole("button", { name: /^Save/ })).toBeEnabled();

	await sheet.getByRole("button", { name: /^Save/ }).click();
	await expect(sheet).toBeHidden();

	// Back on the SAME row, with no navigation in between (the seam this
	// design protects) — the tag now names the skill, and the bare ghost
	// button is gone.
	await expect(row.getByTestId("ship-with-open")).toHaveCount(0);
	await expect(row.locator('[data-testid="companion-tag"]')).toHaveAttribute(
		"data-skill",
		"orchestrate-advanced",
	);
});

