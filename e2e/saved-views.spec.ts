import { expect, test } from '@playwright/test';

// INV-2157: the e2e stack signs in with a bearer token and viewer assertion, with no
// cookie session. A Backlog view saved there must be stored, listed on Views after a
// reload, and open with its filter applied (manual: Views and search).
test('saves a Backlog view in token sign-in mode and reopens it from Views', async ({ page }) => {
  const viewName = `Ready backlog ${Date.now().toString(36)}`;
  page.on('dialog', (dialog) => void dialog.accept(viewName));

  await page.goto('/backlog');
  const toolbar = page.getByRole('toolbar', { name: 'Backlog filters' }).or(page.getByLabel('Backlog filters'));
  await toolbar.getByRole('button', { name: 'States' }).click();
  await page.getByRole('checkbox', { name: 'Ready' }).click();
  await expect(page.getByRole('button', { name: 'Remove State: Ready' })).toBeVisible();
  await page.getByRole('button', { name: 'Save view' }).click();
  await expect(page.getByLabel('Load saved backlog view').locator('option', { hasText: viewName })).toHaveCount(1);

  await page.goto('/views');
  await page.reload();
  const card = page.getByLabel(`View ${viewName}`);
  await expect(card).toBeVisible();

  await page.goto('/backlog');
  await page.getByRole('button', { name: 'Clear' }).click();
  await expect(page.getByRole('button', { name: 'Remove State: Ready' })).toHaveCount(0);
  await page.goto('/views');
  await page.getByLabel(`View ${viewName}`).getByRole('button', { name: new RegExp(viewName) }).click();
  await expect(page).toHaveURL(/\/backlog/);
  await expect(page.getByRole('button', { name: 'Remove State: Ready' })).toBeVisible();
});
