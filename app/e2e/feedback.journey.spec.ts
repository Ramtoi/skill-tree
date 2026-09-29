import { test, expect } from './fixtures';
import { gotoReady } from './helpers';

test.beforeEach(async ({ page }) => {
  await page.route('https://formspree.io/**', route => {
    void route.abort();
    throw new Error('A preview attempted a real Formspree request');
  });
});

test('feedback preserves the editor, traps focus, and blocks page shortcuts', async ({ page }) => {
  await gotoReady(page, '/#/skill/rt-android-expert');
  const editor = page.locator('.doc-editor-body .cm-content').first();
  await editor.click(); await page.keyboard.press('ControlOrMeta+Home');
  await page.keyboard.type('FEEDBACK_UNSAVED_MARKER\n');
  const dirty = page.locator('.doc-editor-bar-right .btn-signal');
  await expect(dirty).toBeVisible();
  const trigger = page.getByRole('button', { name: 'Feedback', exact: true });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'Feedback', exact: true });
  await expect(dialog.getByLabel('Message', { exact: true })).toBeFocused();
  await dialog.getByLabel('Message', { exact: true }).fill('A suggestion');
  await page.keyboard.press('ControlOrMeta+s'); await page.keyboard.press('ControlOrMeta+k'); await page.keyboard.press('ControlOrMeta+,');
  await expect(page.getByRole('dialog')).toHaveCount(1); await expect(dirty).toBeVisible();
  await dialog.locator('.modal-foot').getByRole('button', { name: 'Close', exact: true }).focus();
  await page.keyboard.press('g'); await page.keyboard.press('l'); await page.keyboard.press('/');
  await expect(page).toHaveURL(/#\/skill\/rt-android-expert$/);
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('Tab');
    expect(await dialog.evaluate(el => el.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press('Escape'); await expect(trigger).toBeFocused();
  await expect(editor).toContainText('FEEDBACK_UNSAVED_MARKER'); await expect(dirty).toBeVisible();
  await trigger.click(); await expect(dialog.getByLabel('Message', { exact: true })).toHaveValue('A suggestion');
  await dialog.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(dialog.getByRole('status')).toHaveText('Feedback sent. Thank you.');
  await expect(dialog.getByLabel('Message', { exact: true })).toHaveValue('');
});

test('draft retains the original safe context across navigation', async ({ page }) => {
  await page.goto('/#/project/moon-base?tab=permissions');
  await page.getByRole('button', { name: 'Feedback', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Feedback', exact: true });
  await dialog.getByLabel('Message', { exact: true }).fill('Keep this draft');
  await dialog.locator('summary').click();
  await expect(dialog.locator('dl')).toContainText('project'); await expect(dialog.locator('dl')).toContainText('permissions');
  await expect(dialog.locator('dl')).not.toContainText('moon-base');
  await page.keyboard.press('Escape');
  await page.evaluate(() => { location.hash = '#/'; });
  await page.getByRole('button', { name: 'Feedback', exact: true }).click();
  await expect(dialog.getByLabel('Message', { exact: true })).toHaveValue('Keep this draft');
  await dialog.locator('summary').click(); await expect(dialog.locator('dl')).toContainText('permissions');
  await dialog.getByRole('button', { name: 'Clear', exact: true }).click();
  await expect(dialog.locator('dl')).toContainText('library');
});

for (const [flag, screen] of [['bootstrap=1', 'setup'], ['pythonError=1', 'runtime-error'], ['feedbackLoading=1', 'loading']]) {
  test(`feedback works without the shell at ${screen}`, async ({ page }) => {
    await page.goto(`/?${flag}#/`);
    if (screen !== 'loading') await expect(page.locator('.app[data-gate="true"]')).toBeVisible();
    await page.getByRole('button', { name: 'Feedback', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Feedback', exact: true });
    await dialog.locator('summary').click(); await expect(dialog.locator('dl')).toContainText(screen);
    await dialog.getByLabel('Message', { exact: true }).fill('Setup feedback');
    await dialog.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(dialog.getByRole('status')).toHaveText('Feedback sent. Thank you.');
  });
}

for (const state of ['uncertain', 'blocked', 'sending']) {
  test(`retains the draft after ${state}`, async ({ page }) => {
    await page.goto(`/?feedback=${state}#/`);
    await page.getByRole('button', { name: 'Feedback', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Feedback', exact: true });
    await dialog.getByLabel('Message', { exact: true }).fill('Retained message');
    await dialog.getByRole('button', { name: 'Send', exact: true }).click();
    if (state === 'sending') {
      await expect(dialog.getByLabel('Message', { exact: true })).toBeDisabled();
      await expect(dialog.getByRole('button', { name: 'Clear', exact: true })).toBeDisabled();
    } else await expect(dialog.getByRole('alert')).toContainText(state === 'uncertain' ? 'duplicate' : 'blocked');
    await page.keyboard.press('Escape'); await page.getByRole('button', { name: 'Feedback', exact: true }).click();
    await expect(dialog.getByLabel('Message', { exact: true })).toHaveValue('Retained message');
    if (state === 'sending') await expect(dialog.getByRole('button', { name: 'Sending…' })).toBeDisabled();
    else {
      await page.evaluate(() => history.replaceState(null, '', '/#/'));
      await dialog.getByRole('button', { name: 'Retry', exact: true }).click();
      await expect(dialog.getByRole('status')).toHaveText('Feedback sent. Thank you.');
    }
  });
}

for (const width of [520, 680, 1200]) {
  test(`feedback stays reachable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 700 });
    await page.goto('/?backupStale=1&staleReport=1#/');
    const trigger = page.getByRole('button', { name: 'Feedback', exact: true });
    await expect(trigger).toBeInViewport();
    await expect(page.getByTestId("backup-chip")).toBeInViewport();
    const syncChip = page.locator('.sync-chip[data-state="stale"]');
    await expect(syncChip).toBeInViewport();
    await expect(syncChip).toContainText('registry changed — re-sync');
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: 'Feedback', exact: true });
    await dialog.getByLabel('Message', { exact: true }).fill('long text '.repeat(400));
    await expect(dialog.getByRole('button', { name: 'Send', exact: true })).toBeInViewport();
    await expect(dialog).toHaveCSS('transform', 'none');
    const box = await dialog.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    expect(box!.y + box!.height).toBeLessThanOrEqual(700);
  });
}

test('feedback remains available with both navigation columns hidden', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('skill-tree:tweaks', JSON.stringify({ density: 'default', showRail: false, showNav: false })));
  await page.goto('/#/');
  await expect(page.locator('.app')).toHaveAttribute('data-rail', 'false');
  await expect(page.locator('.app')).toHaveAttribute('data-nav', 'false');
  await page.getByRole('button', { name: 'Feedback', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Feedback', exact: true });
  const send = dialog.getByRole('button', { name: 'Send', exact: true });
  await expect(send).toBeDisabled();
  await dialog.getByLabel('Message', { exact: true }).fill('   ');
  await expect(send).toBeDisabled(); await expect(dialog.getByRole('alert')).toContainText('Enter a message');
  await dialog.getByLabel('Message', { exact: true }).fill('😀'.repeat(4001));
  await expect(send).toBeDisabled(); await expect(dialog.getByRole('alert')).toContainText('4,000');
  await dialog.getByLabel('Message', { exact: true }).fill('😀'.repeat(4000));
  await expect(send).toBeEnabled();
});
