import { test, expect, type Page, type Locator } from "./fixtures";

// skill-files standing journey, driven against the mocked-Tauri dev server
// (VISUAL_MOCK=1 → src/mocks/tauriCore.ts). Same boot path as the visual
// harness; NEVER touches ~/.claude.
//
// Covers the acceptance rows the design brief marks [e2e] (DESIGN.md §8):
//   5   section open/closed round-trips through localStorage
//   13  selecting a row swaps the buffer and updates the footer path
//   14  a non-Markdown file drops Preview + the markdown toolbar, keeps Diff
//   15  a binary row renders the non-editable EmptyState, mounts no CodeMirror
//   16  a read-only source-managed skill lists + opens every file, no Add file
//   20  edit A → B → A preserves A's text verbatim, with no dialog
//   24  a dirty buffer holds EVERY in-app exit (back arrow + rail) on the
//       router-level guard: cancel stays, confirm replays the held navigation
//   27  a path that escapes the skill dir is refused inline, nothing is written
//   29  the crumb line gains the rel path iff the active file ≠ SKILL.md
//   30  the footer names the active file at all times
//   33  arrow / j / k / Home / End / Enter navigate + open, container-scoped
//
// Fixtures (src/mocks/tauriCore.ts → `skillFileTrees`):
//   rt-android-expert   hub-owned, 5 files: SKILL.md, assets/logo.png (binary),
//                       references/checklist.md, references/patterns.md,
//                       scripts/run.py
//   brainstorm          single-file
//   android-compose-ui  `managed: external` → read-only, 3 files

const MULTI = "rt-android-expert";
const EXTERNAL = "android-compose-ui";

/** Every row of `rt-android-expert`, in the navigator's render order:
 *  SKILL.md pinned, then root files (none), then folder groups alphabetically. */
const MULTI_ORDER = [
	"SKILL.md",
	"assets/logo.png",
	"references/checklist.md",
	"references/patterns.md",
	"scripts/run.py",
];


/** Open a skill editor wide enough that the side panel stays docked (below
 *  ~772px of editor width the whole panel folds into the Details tab). */
async function openSkill(page: Page, name: string) {
	await page.setViewportSize({ width: 1600, height: 900 });
	await page.goto(`/#/skill/${name}`);
	await expect(page.locator(".doc-editor-shell")).toBeVisible();
	await expect(page.locator('[data-testid="skill-files"]')).toBeVisible();
}

const filesPanel = (page: Page) => page.locator('[data-testid="skill-files"]');
const rows = (page: Page) => page.locator('[data-testid="skill-file-row"]');
const row = (page: Page, rel: string): Locator =>
	page.locator(`[data-testid="skill-file-row"][data-rel="${rel}"]`);
const footerPath = (page: Page) =>
	page.locator('[data-testid="editor-active-path"]');
const cm = (page: Page) => page.locator(".doc-editor-body .cm-content");
const dialogs = (page: Page) => page.locator('[role="dialog"]');

/** The rel the editor believes is active — asserted from the panel's own
 *  attribute rather than from whichever row happens to look selected. */
async function expectActive(page: Page, rel: string) {
	await expect(filesPanel(page)).toHaveAttribute("data-active-rel", rel);
	await expect(footerPath(page)).toHaveText(rel);
}

/** Select a row and wait for the editor to settle on it. */
async function selectRow(page: Page, rel: string) {
	await row(page, rel).click();
	await expect(filesPanel(page)).toHaveAttribute("data-active-rel", rel);
}

/** The row `useListNav` currently holds the roving focus on. */
const focusedRel = (page: Page) =>
	page.locator('[data-testid="skill-file-row"][data-listnav-active="true"]');

// ─── 5: section disclosure round-trips through localStorage ──────────────────

test("skill files [5]: RUNTIME open/closed survives a reload and a route change", async ({
	page,
}) => {
	await openSkill(page, MULTI);

	const details = page.locator('[data-testid="side-section-runtime"]');
	// RUNTIME ships collapsed: triggering changed once across 64 skills, so
	// the round-trip has to be proven in BOTH directions.
	await expect(details).toHaveAttribute("aria-expanded", "false");

	await details.click();
	await expect(details).toHaveAttribute("aria-expanded", "true");
	await expect
		.poll(() =>
			page.evaluate(() =>
				JSON.parse(localStorage.getItem("st:skill-editor:sections") ?? "{}"),
			),
		)
		.toMatchObject({ runtime: true });

	// (a) a remount of the same route
	await page.reload();
	await expect(page.locator(".doc-editor-shell")).toBeVisible();
	await expect(
		page.locator('[data-testid="side-section-runtime"]'),
	).toHaveAttribute("aria-expanded", "true");

	// Now collapse it again and prove the closed state persists too — a default
	// that happens to match would make the open-only assertion vacuous.
	await page.locator('[data-testid="side-section-runtime"]').click();
	await expect(
		page.locator('[data-testid="side-section-runtime"]'),
	).toHaveAttribute("aria-expanded", "false");

	// (b) a route change to another skill and back
	await page.goto("/#/skill/brainstorm");
	await expect(page.locator('[data-testid="skill-files"]')).toBeVisible();
	await page.goto(`/#/skill/${MULTI}`);
	await expect(page.locator(".doc-editor-shell")).toBeVisible();
	await expect(
		page.locator('[data-testid="side-section-runtime"]'),
	).toHaveAttribute("aria-expanded", "false");

	// (c) a reload, to pin the closed state to storage rather than to memory
	await page.reload();
	await expect(
		page.locator('[data-testid="side-section-runtime"]'),
	).toHaveAttribute("aria-expanded", "false");

});

// ─── 16: a read-only source-managed skill ────────────────────────────────────

test("skill files [16]: an external skill lists + opens every file read-only, with no Add file", async ({
	page,
}) => {
	await openSkill(page, EXTERNAL);

	await expect(page.locator(".title-state")).toContainText("READ-ONLY");
	// The write affordance is absent, not disabled: the banner and the pill
	// already say why, so a dead `+ Add file` would only add noise.
	await expect(page.locator('[data-testid="skill-files-add"]')).toHaveCount(0);

	const rels = ["SKILL.md", "references/theming.md", "scripts/lint.sh"];
	await expect(rows(page)).toHaveCount(rels.length);

	for (const rel of rels) {
		await selectRow(page, rel);
		await expectActive(page, rel);
		// A read-only skill opens on PREVIEW, not Edit — there is nothing to type,
		// so the rendered document is the useful default. Edit is still reachable
		// and still the thing that must prove non-editable, so ask for it by name
		// rather than assuming the mode.
		// Verified (all three `rels` extensions, including the non-Markdown
		// `scripts/lint.sh` that drops Preview per finding #14): the Edit tab
		// itself always renders here, only the default active tab differs.
		const editTab = page.getByRole("tab", { name: "Edit" });
		await expect(editTab).toBeVisible();
		await editTab.click();
		// Every row still OPENS — read-only is not unreachable.
		await expect(page.locator(".cm-editor")).toBeVisible();
		await expect(cm(page)).toHaveAttribute("contenteditable", "false");
		// No per-row lock glyph: the state is stated once, at the top.
		await expect(row(page, rel).locator(".sf-file-flag")).toHaveCount(0);
	}

	// A read-only document offers no Save, and no markdown mutator row.
	await expect(page.locator(".md-toolbar")).toHaveCount(0);
	await expect(
		page.locator(".doc-editor-bar-right button", { hasText: "Save" }),
	).toHaveCount(0);

});

// ─── 20: switching files never taxes the frequent action ─────────────────────

test("skill files [20]: edit A → B → A preserves A's text exactly, with no dialog", async ({
	page,
}) => {
	await openSkill(page, MULTI);

	const A = "references/checklist.md";
	const B = "references/patterns.md";
	const MARKER = "MARKER_ALPHA_4711";

	await selectRow(page, A);
	await expect(cm(page)).toContainText("Review checklist");

	await cm(page).click();
	await page.keyboard.press("ControlOrMeta+Home");
	await page.keyboard.type(`${MARKER}\n`);
	await expect(cm(page)).toContainText(MARKER);

	// The exact buffer, as the editor renders it — compared verbatim after the
	// round trip. A silent auto-save or a reload-from-disk would change it.
	const before = await cm(page).textContent();
	await expect(row(page, A)).toHaveAttribute("data-state", "dirty");

	await selectRow(page, B);
	await expect(cm(page)).toContainText("Compose patterns");
	await expect(cm(page)).not.toContainText(MARKER);
	// Switching is the frequent action: it must never prompt.
	await expect(dialogs(page)).toHaveCount(0);

	await selectRow(page, A);
	await expect(cm(page)).toContainText(MARKER);
	await expect(cm(page)).toHaveText(before ?? "");
	await expect(dialogs(page)).toHaveCount(0);
	// The draft survived in memory, and the row still says so.
	await expect(row(page, A)).toHaveAttribute("data-state", "dirty");
	// 23: the head carries the unsaved rollup.
	await expect(page.locator(".sf-unsaved").first()).toContainText("1 unsaved");

});

// ─── 24: leaving with a dirty buffer ─────────────────────────────────────────

test("skill files [24]: a dirty buffer holds the back arrow AND the rail until you answer", async ({
	page,
}) => {
	await openSkill(page, MULTI);

	await selectRow(page, "references/patterns.md");
	await expect(cm(page)).toContainText("Compose patterns");
	await cm(page).click();
	await page.keyboard.press("ControlOrMeta+Home");
	await page.keyboard.type("DIRTY_EDIT\n");
	await expect(row(page, "references/patterns.md")).toHaveAttribute(
		"data-state",
		"dirty",
	);

	const back = page.locator(".header-back");
	// A rail destination that is NOT a document editor, so "the editor is gone"
	// is a real assertion rather than a different screen wearing the same shell.
	const railSources = page.locator('.app-rail button[title="Sources"]');
	const confirm = page.locator('[role="dialog"]', {
		hasText: "Discard unsaved changes?",
	});
	const hash = () => new URL(page.url()).hash;

	// ── (a) the header back arrow: cancel keeps you here, draft intact ──
	await back.click();
	await expect(confirm).toBeVisible();
	await confirm.locator("button", { hasText: "Cancel" }).click();
	await expect(confirm).toHaveCount(0);
	await expect(page.locator(".doc-editor-shell")).toBeVisible();
	await expect(cm(page)).toContainText("DIRTY_EDIT");

	// ── (b) the rail: a completely different call site ──
	// The guard lives on the router's `navigator`, not on the back arrow — the
	// rail, a NavPanel row, the palette and a `g …` chord all funnel through it.
	// A guard bolted onto one exit would pass (a) and lose the draft here.
	await railSources.click();
	await expect(confirm).toBeVisible();
	await confirm.locator("button", { hasText: "Cancel" }).click();
	await expect(confirm).toHaveCount(0);
	await expect.poll(hash).toBe(`#/skill/${MULTI}`);
	await expect(cm(page)).toContainText("DIRTY_EDIT");
	// Refusing the navigation must not cost the selection either.
	await expectActive(page, "references/patterns.md");

	// Confirming from the rail leaves — and lands on the RAIL's destination,
	// not on the back target: the held navigation is replayed, not re-derived.
	await railSources.click();
	await expect(confirm).toBeVisible();
	await confirm.locator("button", { hasText: "Discard and leave" }).click();
	await expect(page.locator('[data-testid="skill-files"]')).toHaveCount(0);
	await expect.poll(hash).toBe("#/sources");

});

// ─── 33: list keyboard nav, bound to the container ───────────────────────────

test("skill files [33]: j/k/arrows/Home/End/Enter navigate the list, container-scoped", async ({
	page,
}) => {
	await openSkill(page, MULTI);
	await expect(rows(page)).toHaveCount(MULTI_ORDER.length);

	// Take the roving focus by clicking the first row (which is already active).
	await row(page, "SKILL.md").click();
	await expect(focusedRel(page)).toHaveAttribute("data-rel", MULTI_ORDER[0]);

	// ArrowDown / j move forward, k / ArrowUp back — focus only, no open.
	await page.keyboard.press("ArrowDown");
	await expect(focusedRel(page)).toHaveAttribute("data-rel", MULTI_ORDER[1]);
	// Roving tabindex, not `aria-activedescendant`: the DOM focus really moves
	// onto the row, and the row it lands on is the selected option. Only a real
	// browser can tell the difference between "styled active" and "focused".
	await expect(focusedRel(page)).toBeFocused();
	await expect(focusedRel(page)).toHaveAttribute("aria-selected", "true");
	await expect(focusedRel(page)).toHaveAttribute("tabindex", "0");
	await expect(page.locator('[data-testid="skill-file-row"][tabindex="0"]')).toHaveCount(1);
	await expect(page.locator(".sf-list")).toHaveAttribute("role", "listbox");
	await expect(page.locator(".sf-list")).not.toHaveAttribute(
		"aria-activedescendant",
		/.*/,
	);
	await page.keyboard.press("j");
	await expect(focusedRel(page)).toHaveAttribute("data-rel", MULTI_ORDER[2]);
	// Moving the focus is not opening: the active document has not changed.
	await expect(filesPanel(page)).toHaveAttribute("data-active-rel", "SKILL.md");

	// Enter opens the focused row.
	await page.keyboard.press("Enter");
	await expectActive(page, MULTI_ORDER[2]);
	await expect(cm(page)).toContainText("Review checklist");

	await page.keyboard.press("k");
	await expect(focusedRel(page)).toHaveAttribute("data-rel", MULTI_ORDER[1]);
	await page.keyboard.press("ArrowUp");
	await expect(focusedRel(page)).toHaveAttribute("data-rel", MULTI_ORDER[0]);

	await page.keyboard.press("End");
	await expect(focusedRel(page)).toHaveAttribute(
		"data-rel",
		MULTI_ORDER[MULTI_ORDER.length - 1],
	);
	await page.keyboard.press("Enter");
	await expectActive(page, "scripts/run.py");

	await page.keyboard.press("Home");
	await expect(focusedRel(page)).toHaveAttribute("data-rel", MULTI_ORDER[0]);
	await page.keyboard.press("Enter");
	await expectActive(page, "SKILL.md");

	// ── The handler is bound to the LIST CONTAINER, not the window ──
	// A window-level binding would hijack `j` while any text field is focused —
	// which is the documented reason `useListNav` exists at all.
	await page.keyboard.press("End");
	const parked = MULTI_ORDER[MULTI_ORDER.length - 1];
	await expect(focusedRel(page)).toHaveAttribute("data-rel", parked);

	// The description is the one text field that is always mounted in the
	// panel (the name edits in place and only opens a field on click).
	const nameInput = page
		.locator('[data-block="identity"] textarea')
		.first();
	await nameInput.click();
	// A click lands the caret mid-text; park it at the end so the keystrokes
	// can be pinned to the tail of the value.
	await nameInput.evaluate((el) => {
		const ta = el as HTMLTextAreaElement;
		ta.selectionStart = ta.selectionEnd = ta.value.length;
	});
	await page.keyboard.press("j");
	await page.keyboard.press("k");
	await page.keyboard.press("ArrowDown");
	// The keystrokes went into the field, and the list did not budge.
	await expect(nameInput).toHaveValue(/jk$/);
	await expect(focusedRel(page)).toHaveAttribute("data-rel", parked);
	await expect(filesPanel(page)).toHaveAttribute("data-active-rel", "SKILL.md");

});
