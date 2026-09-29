import { test, expect, type Page } from "./fixtures";

async function openDocument(page: Page, project = "moon-base") {
  await page.goto(`/#/project/${project}?tab=agent-docs`);
  await page.locator('.ad-file').filter({
    has: page.locator('.ad-file-name:text-is("AGENTS.md")'),
  }).first().click();
  await expect(page.locator('.ad-doc-name')).toHaveText('AGENTS.md');
}

const source = (page: Page) => page.locator('.snip-strip').getByRole('link', { name: 'android-conventions' });
const back = (page: Page) => page.getByTestId('screen-header-back');

for (const input of ['mouse', 'keyboard'] as const) {
  test(`${input} opens the source and returns to the same project document`, async ({ page }) => {
    await openDocument(page);
    if (input === 'mouse') await source(page).click();
    else {
      await source(page).focus();
      await expect(source(page)).toBeFocused();
      await page.keyboard.press('Enter');
    }
    await expect(page).toHaveURL(/#\/snippet\/android-conventions$/);
    await expect(back(page)).toHaveAccessibleName('Back to moon-base');
    await back(page).click();
    await expect(page).toHaveURL(/#\/project\/moon-base\?tab=agent-docs$/);
    await expect(page.locator('.ad-doc-name')).toHaveText('AGENTS.md');
    await expect(source(page)).toBeVisible();
  });
}

test('cancelled navigation retains drafts in both editors', async ({ page }) => {
  await openDocument(page);
  const doc = page.locator('.agent-docs-editor .cm-content');
  await doc.fill('Agent Docs draft to retain');
  await source(page).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Leave without saving?');
  await dialog.getByRole('button', { name: 'Stay', exact: true }).click();
  await expect(doc).toContainText('Agent Docs draft to retain');
  await expect(page.locator('.ad-doc-name')).toHaveText('AGENTS.md');
  await source(page).click();
  await dialog.getByRole('button', { name: 'Leave', exact: true }).click();
  await expect(page).toHaveURL(/#\/snippet\/android-conventions$/);
  const snippet = page.locator('.doc-editor-pane .cm-content');
  await snippet.fill('Snippet draft to retain');
  await back(page).click();
  await expect(dialog).toContainText('Leave without saving?');
  await dialog.getByRole('button', { name: 'Stay', exact: true }).click();
  await expect(snippet).toContainText('Snippet draft to retain');
  await expect(page).toHaveURL(/#\/snippet\/android-conventions$/);
  await back(page).click();
  await dialog.getByRole('button', { name: 'Leave', exact: true }).click();
  await expect(page.locator('.ad-doc-name')).toHaveText('AGENTS.md');
});

test('orphaned source stays plain text and standalone snippet has no return arrow', async ({ page }) => {
  await openDocument(page, 'example-app');
  const strip = page.locator('.snip-strip');
  await expect(strip.getByText('orphaned-note', { exact: true })).toBeVisible();
  await expect(strip.getByRole('link', { name: 'orphaned-note' })).toHaveCount(0);
  await expect(strip.locator('.snip-strip-row').filter({ hasText: 'orphaned-note' })
    .getByRole('button', { name: 'Remove block from file' })).toBeEnabled();
  await page.goto('/#/snippet/android-conventions');
  await expect(page.getByRole('button', { name: 'Rename snippet name: android-conventions' })).toBeVisible();
  await expect(back(page)).toHaveCount(0);
});
