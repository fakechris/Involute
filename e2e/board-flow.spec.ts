import { expect, test } from '@playwright/test';

test.describe('board flow', () => {
  test('creates, updates, comments, deletes comment, and deletes issue from the board', async ({ page }) => {
    const createdTitle = 'Playwright lifecycle issue';
    const updatedTitle = 'Playwright lifecycle issue updated';
    const createdDescription = 'Created from the end-to-end acceptance suite.';
    const updatedDescription = 'Updated description from the end-to-end acceptance suite.';

    page.on('dialog', (dialog) => dialog.accept());

    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Board' })).toBeVisible();
    await expect(page.getByText('Workflow overview for Involute.')).toBeVisible();

    await page.getByRole('button', { name: 'Create issue' }).click();

    const createDrawer = page.getByRole('dialog', { name: 'Create issue drawer' });
    await expect(createDrawer).toBeVisible();
    await createDrawer.getByLabel('Issue title').fill(createdTitle);
    await createDrawer.getByLabel('Issue description').fill(createdDescription);
    await createDrawer.locator('form').getByRole('button', { name: 'Create issue', exact: true }).click();

    const issueDrawer = page.getByRole('dialog', { name: 'Issue detail drawer' });
    await expect(issueDrawer).toBeVisible();
    await expect(issueDrawer.getByLabel('Issue title')).toHaveValue(createdTitle);
    await expect(page.getByText(createdTitle)).toBeVisible();

    const titleInput = issueDrawer.getByLabel('Issue title');
    await titleInput.fill(updatedTitle);
    await titleInput.press('Enter');
    await expect(issueDrawer.getByLabel('Issue title')).toHaveValue(updatedTitle);

    const descriptionInput = issueDrawer.getByLabel('Issue description');
    await descriptionInput.fill(updatedDescription);
    await descriptionInput.blur();
    await expect(issueDrawer.getByLabel('Issue description')).toHaveValue(updatedDescription);

    await issueDrawer.getByLabel('Issue state').selectOption({ label: 'Done' });
    await expect(page.locator('[data-testid="column-Done"]')).toContainText(updatedTitle);

    await issueDrawer.getByRole('checkbox', { name: 'Feature' }).check();
    await expect(issueDrawer.getByLabel('Issue labels')).toContainText('Feature');

    await issueDrawer.getByLabel('Issue assignee').selectOption({ label: 'Admin' });
    await expect(issueDrawer.getByLabel('Issue assignee')).toHaveValue(/.+/);

    await issueDrawer.getByLabel('Comment body').fill('Playwright comment');
    await issueDrawer.getByRole('button', { name: 'Add comment' }).click();
    await expect(issueDrawer.getByText('Playwright comment')).toBeVisible();

    await issueDrawer.getByRole('button', { name: 'Delete comment' }).click();
    await expect(issueDrawer.getByText('Playwright comment')).toHaveCount(0);

    await issueDrawer.getByRole('button', { name: 'Delete issue' }).click();
    await expect(page.getByRole('dialog', { name: 'Issue detail drawer' })).toHaveCount(0);
    await expect(page.getByText(updatedTitle)).toHaveCount(0);
  });
});
