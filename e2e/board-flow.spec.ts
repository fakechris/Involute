import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';

test.describe('board flow', () => {
  test('creates, updates, comments, deletes comment, and deletes issue from the board', async ({ page }) => {
    const createdTitle = 'Playwright lifecycle issue';
    const updatedTitle = 'Playwright lifecycle issue updated';
    const createdDescription = 'Created from the end-to-end acceptance suite.';
    const updatedDescription = 'Updated description from the end-to-end acceptance suite.';

    page.on('dialog', (dialog) => dialog.accept());

    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Board', exact: true })).toBeVisible();
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
    await expect(page.getByText(createdTitle, { exact: true })).toBeVisible();

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

    const featureCheckbox = issueDrawer.getByRole('checkbox', { name: 'Feature' });
    await featureCheckbox.check();
    await expect(featureCheckbox).toBeChecked();

    const assigneeSelect = issueDrawer.getByLabel('Issue assignee');
    await assigneeSelect.selectOption({ label: 'Admin' });
    await expect(assigneeSelect.locator('option:checked')).toHaveText('Admin');

    await issueDrawer.getByLabel('Comment body').fill('Playwright comment');
    await issueDrawer.getByRole('button', { name: 'Add comment' }).click();
    await expect(issueDrawer.getByText('Playwright comment')).toBeVisible();

    await issueDrawer.getByRole('button', { name: 'Delete comment' }).last().click();
    await expect(issueDrawer.getByText('Playwright comment')).toHaveCount(0);

    await issueDrawer.getByRole('button', { name: 'Delete issue' }).click();
    await expect(page.getByRole('dialog', { name: 'Issue detail drawer' })).toHaveCount(0);
    await expect(page.getByText(updatedTitle)).toHaveCount(0);
  });

  test('renders imported workflow states and issues on the board for visual acceptance', async ({ page }) => {
    try {
      runBoardFixtureCommand('seed');

      await page.goto('/');
      await expect(page.getByRole('heading', { name: 'Board', exact: true })).toBeVisible();

      await page.getByLabel('Select team').selectOption({ label: 'Imported Acceptance Team' });

      await expect(page.getByTestId('column-Triage')).toContainText('E2E-42');
      await expect(page.getByTestId('column-Triage')).toContainText('Imported triage issue');
      await expect(page.getByTestId('column-Todo')).toContainText('E2E-43');
      await expect(page.getByTestId('column-Done')).toContainText('E2E-44');

      await page.getByText('Imported triage issue', { exact: true }).click();

      const issueDrawer = page.getByRole('dialog', { name: 'Issue detail drawer' });
      await expect(issueDrawer).toBeVisible();
      await expect(issueDrawer.getByLabel('Issue title')).toHaveValue('Imported triage issue');
      await expect(issueDrawer.getByText('Imported comment from fixture.')).toBeVisible();
    } finally {
      runBoardFixtureCommand('cleanup');
    }
  });
});

function runBoardFixtureCommand(command: 'seed' | 'cleanup'): void {
  execFileSync(
    'pnpm',
    ['--filter', '@involute/server', 'exec', 'tsx', 'scripts/import-board-fixture.ts', command],
    {
      cwd: process.cwd(),
      env: process.env,
      stdio: 'inherit',
      timeout: 60_000,
    },
  );
}
