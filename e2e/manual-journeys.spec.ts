import { expect, test } from '@playwright/test';

// Journeys from docs/manual, walked as written. See docs/acceptance-scenarios.md.
test.describe('manual journeys', () => {
  test.afterEach(async ({ page }, testInfo) => {
    if (testInfo.status === testInfo.expectedStatus) return;
    const storage = await page.evaluate(() => JSON.stringify(Object.fromEntries(Object.entries(localStorage)))).catch(() => '');
    const text = await page.locator('body').innerText().catch(() => '');
    console.log(`DIAG url=${page.url()}\nDIAG storage=${storage.slice(0, 1500)}\nDIAG body=${text.slice(0, 2500).replace(/\n+/g, ' | ')}`);
  });
  test('getting started: new project, first issue with C, found on Backlog and in Search', async ({ page }) => {
    const suffix = Date.now().toString(36);
    const projectName = `E2E onboarding ${suffix}`;
    const issueTitle = `First issue ${suffix}`;

    await page.goto('/projects');
    await page.getByRole('button', { name: 'New project' }).first().click();
    const projectDialog = page.getByRole('dialog', { name: 'New project' });
    await projectDialog.getByPlaceholder('Project name').fill(projectName);
    await projectDialog.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(projectDialog).toBeHidden();
    await expect(page.getByText(projectName, { exact: true }).first()).toBeVisible();

    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'All issues', exact: true })).toBeVisible();
    // The board query also carries the delivery spec's fixtures; on CI it can take longer than the default 5s.
    await expect(page.getByTestId('column-Backlog')).toBeVisible({ timeout: 30_000 });
    await page.locator('body').press('c');
    const createDrawer = page.getByRole('dialog', { name: 'Create issue drawer' });
    await expect(createDrawer).toBeVisible();
    await createDrawer.getByLabel('Issue title').fill(issueTitle);
    await createDrawer.getByLabel('Issue description').fill('Created by walking the Getting started chapter.');
    const projectSelect = createDrawer.getByLabel('Project', { exact: true });
    await expect(projectSelect.locator('option', { hasText: projectName })).toBeAttached({ timeout: 15_000 });
    await projectSelect.selectOption({ label: projectName });
    await expect(createDrawer.getByLabel('Location').locator('option:checked')).toHaveText('No milestone');
    await createDrawer.locator('form').getByRole('button', { name: 'Create issue', exact: true }).click();

    const issueDrawer = page.getByRole('dialog', { name: 'Issue detail drawer' });
    await expect(issueDrawer.getByLabel('Issue title')).toHaveValue(issueTitle, { timeout: 15_000 });

    await page.goto('/backlog');
    await expect(page.getByText(issueTitle, { exact: true }).first()).toBeVisible({ timeout: 15_000 });

    await page.goto('/search');
    await page.getByLabel('Search all work').fill(issueTitle);
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(page.getByText(issueTitle, { exact: true }).first()).toBeVisible({ timeout: 15_000 });
  });
});
