import { expect, test, type APIRequestContext } from '@playwright/test';
import { createHmac } from 'node:crypto';

const graphqlUrl = `http://127.0.0.1:${process.env.E2E_SERVER_PORT ?? '4300'}/graphql`;
const authToken = process.env.E2E_AUTH_TOKEN ?? 'e2e-auth-token';
async function gql<T>(request: APIRequestContext, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, sub: 'admin@involute.local', subType: 'email' })).toString('base64url');
  const signature = createHmac('sha256', process.env.E2E_VIEWER_ASSERTION_SECRET ?? 'e2e-viewer-assertion-secret').update(payload).digest('base64url');
  const response = await request.post(graphqlUrl, { data: { query, variables }, headers: { authorization: `Bearer ${authToken}`, 'x-involute-viewer-assertion': `${payload}.${signature}` } });
  const body = await response.json();
  if (body.errors?.length) throw new Error(JSON.stringify(body.errors));
  return body.data as T;
}

test('delivery project switch preserves window and reconciles drill-down samples', async ({ page, request }) => {
  const { teams } = await gql<{ teams: { nodes: { id: string; key: string; states: { nodes: { id: string; type: string }[] } }[] } }>(request,
    '{ teams { nodes { id key states { nodes { id type } } } } }');
  const team = teams.nodes.find((row) => row.key === 'INV')!;
  const suffix = Date.now().toString(36);
  const repositories = [`e2e/delivery-a-${suffix}`, `e2e/delivery-b-${suffix}`];
  const titles = ['Delivery accepted A', 'Delivery accepted B'];
  for (const [index, repository] of repositories.entries()) {
    const create = async (input: Record<string, unknown>) => (await gql<{ issueCreate: { issue: { id: string } } }>(request,
      'mutation($input: IssueCreateInput!) { issueCreate(input: $input) { issue { id } } }', { input: { teamId: team.id, ...input } })).issueCreate.issue;
    const project = await create({ title: repository, kind: 'PROJECT', repository });
    const issue = await create({ title: titles[index], repository, parentId: project.id });
    for (const type of ['STARTED', 'REVIEW', 'COMPLETED']) {
      const updated = await gql<{ issueUpdate: { success: boolean; message: string | null } }>(request, 'mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success message } }',
        { id: issue.id, input: { stateId: team.states.nodes.find((state) => state.type === type)!.id } });
      expect(updated.issueUpdate.success, updated.issueUpdate.message ?? 'State update').toBe(true);
    }
  }
  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.parse(to) - 6 * 86_400_000).toISOString().slice(0, 10);
  await page.addInitScript(() => localStorage.setItem('involute.activeTeamKey', 'INV'));
  await page.goto(`/delivery?from=${from}&to=${to}&project=${repositories[0]}`);
  await expect(page.getByRole('heading', { name: 'Delivery latency', exact: true })).toBeVisible();
  await expect(page.getByLabel('Completed sample latency')).toContainText('n=1');
  const bar = page.getByRole('button', { name: /Lead time P50:.*Show samples/ });
  await bar.focus();
  await bar.press('Enter');
  const list = page.getByLabel('Delivery drill-down');
  await expect(list).toContainText('1 items · 1 samples of 1');
  await expect(list).toContainText(titles[0]!);
  await page.getByRole('button', { name: `Project: ${repositories[0]}`, exact: true }).click();
  await page.getByPlaceholder('Filter projects...').fill(repositories[1]!);
  await page.getByRole('option').filter({ hasText: repositories[1] }).click();
  await expect(list).toContainText(titles[1]!);
  await expect(list).not.toContainText(titles[0]!);
  await expect(list).toContainText('1 items · 1 samples of 1');
  const url = new URL(page.url());
  expect(url.searchParams.get('from')).toBe(from);
  expect(url.searchParams.get('to')).toBe(to);
  expect(url.searchParams.get('sample')).toBe('LEAD_TIME');
  await page.screenshot({ path: 'test-results/delivery-latency.png', fullPage: true });
});
