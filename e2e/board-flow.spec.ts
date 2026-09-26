import { expect, test, type APIRequestContext } from '@playwright/test';
import { execFileSync } from 'node:child_process';

const graphqlUrl = `http://127.0.0.1:${process.env.E2E_SERVER_PORT ?? '4300'}/graphql`;
const authToken = process.env.E2E_AUTH_TOKEN ?? 'e2e-auth-token';

async function gql<T>(request: APIRequestContext, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const response = await request.post(graphqlUrl, { data: { query, variables }, headers: { authorization: `Bearer ${authToken}` } });
  const body = (await response.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (body.errors?.length) throw new Error(body.errors.map((error) => error.message).join('; '));
  return body.data as T;
}

/** New work needs a parent (INV-744): a project for the board to create under. */
async function createProject(request: APIRequestContext, repository: string): Promise<{ id: string }> {
  const teams = await gql<{ teams: { nodes: Array<{ id: string; key: string }> } }>(request, `{ teams { nodes { id key } } }`);
  const team = teams.teams.nodes.find((candidate) => candidate.key === 'INV') ?? teams.teams.nodes[0]!;
  return (
    await gql<{ issueCreate: { issue: { id: string } } }>(
      request,
      `mutation($input: IssueCreateInput!) { issueCreate(input: $input) { issue { id } } }`,
      { input: { teamId: team.id, title: repository, kind: 'PROJECT', repository } },
    )
  ).issueCreate.issue;
}

test.describe('board flow', () => {
  test('creates, updates, comments, deletes comment, and deletes issue from the board', async ({ page, request }) => {
    const repository = `e2e/board-flow-${Date.now().toString(36)}`;
    const project = await createProject(request, repository);
    const createdTitle = 'Playwright lifecycle issue';
    const updatedTitle = 'Playwright lifecycle issue updated';
    const createdDescription = 'Created from the end-to-end acceptance suite.';
    const updatedDescription = 'Updated description from the end-to-end acceptance suite.';

    page.on('dialog', (dialog) => dialog.accept());

    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'All issues', exact: true })).toBeVisible();
    await page.getByRole('region', { name: 'Done column (collapsed)' }).click();
    await expect(page.getByRole('region', { name: 'Done column', exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Create issue' }).click();

    const createDrawer = page.getByRole('dialog', { name: 'Create issue drawer' });
    await expect(createDrawer).toBeVisible();
    await createDrawer.getByLabel('Issue title').fill(createdTitle);
    await createDrawer.getByLabel('Issue description').fill(createdDescription);
    const submit = createDrawer.locator('form').getByRole('button', { name: 'Create issue', exact: true });
    await createDrawer.getByLabel('Project').selectOption(repository);
    await expect(createDrawer.getByLabel('Location')).toHaveValue(/.+/);
    await expect(createDrawer.getByLabel('Location').locator('option:checked')).toHaveText('No milestone');
    await expect(submit).toBeEnabled();
    await submit.click();

    const issueDrawer = page.getByRole('dialog', { name: 'Issue detail drawer' });
    await expect(issueDrawer).toBeVisible();
    await expect(issueDrawer.getByLabel('Issue title')).toHaveValue(createdTitle);
    await expect(page.getByTestId('column-Backlog').getByText(createdTitle, { exact: true })).toBeVisible();

    const titleInput = issueDrawer.getByLabel('Issue title');
    await titleInput.fill(updatedTitle);
    await titleInput.press('Enter');
    await expect(issueDrawer.getByLabel('Issue title')).toHaveValue(updatedTitle);

    await issueDrawer.getByLabel('Edit description').click();
    const descriptionInput = issueDrawer.getByLabel('Issue description');
    await descriptionInput.fill(updatedDescription);
    await issueDrawer.getByRole('button', { name: 'Save' }).click();
    await expect(issueDrawer.getByText(updatedDescription)).toBeVisible();

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
    await expect(page.locator('[data-testid="column-Done"]').getByText(updatedTitle, { exact: true })).toHaveCount(
      0,
    );
    await gql(request, `mutation($id: String!) { issueDelete(id: $id) { success } }`, { id: project.id }).catch(() => undefined);
  });

  test('renders imported workflow states and issues on the board for visual acceptance', async ({ page }) => {
    try {
      runBoardFixtureCommand('seed');

      await page.goto('/');
      await expect(page.getByRole('heading', { name: 'All issues', exact: true })).toBeVisible();

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
    ['--filter', '@turnkeyai/involute-server', 'exec', 'tsx', 'scripts/import-board-fixture.ts', command],
    {
      cwd: process.cwd(),
      env: process.env,
      stdio: 'inherit',
      timeout: 60_000,
    },
  );
}
