import { expect, test } from '@playwright/test';

// Journeys from docs/manual, walked as written. See docs/acceptance-scenarios.md.
test.describe('manual journeys', () => {
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
    await page.locator('body').press('c');
    const createDrawer = page.getByRole('dialog', { name: 'Create issue drawer' });
    await expect(createDrawer).toBeVisible();
    await createDrawer.getByLabel('Issue title').fill(issueTitle);
    await createDrawer.getByLabel('Issue description').fill('Created by walking the Getting started chapter.');
    await createDrawer.getByLabel('Project').selectOption({ label: projectName });
    await expect(createDrawer.getByLabel('Location').locator('option:checked')).toHaveText('No milestone');
    await createDrawer.locator('form').getByRole('button', { name: 'Create issue', exact: true }).click();

    const issueDrawer = page.getByRole('dialog', { name: 'Issue detail drawer' });
    await expect(issueDrawer.getByLabel('Issue title')).toHaveValue(issueTitle);
    const identifier = (await issueDrawer.getByText(/^[A-Z]+-\d+$/).first().textContent())?.trim();
    expect(identifier).toMatch(/^[A-Z]+-\d+$/);

    await page.goto('/backlog');
    await expect(page.getByText(issueTitle, { exact: true }).first()).toBeVisible();

    await page.goto('/search');
    const search = page.getByLabel('Search all work');
    await search.fill(identifier!);
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(page.getByText(issueTitle, { exact: true }).first()).toBeVisible();
  });
});
