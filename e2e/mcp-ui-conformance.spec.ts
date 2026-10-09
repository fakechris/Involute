import { createHmac } from 'node:crypto';
import { expect, test, type APIRequestContext } from '@playwright/test';

test.use({ actionTimeout: 10_000 });

// Public HTTP and actual browser controls. Credentials exist only in this isolated test process.
const server = `http://127.0.0.1:${process.env.E2E_SERVER_PORT ?? '4300'}`;
const auth = process.env.E2E_AUTH_TOKEN ?? 'e2e-auth-token';
const assertionSecret = process.env.E2E_VIEWER_ASSERTION_SECRET ?? 'e2e-viewer-assertion-secret';
function assertion() {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 600, sub: 'admin@involute.local', subType: 'email' })).toString('base64url');
  return `${payload}.${createHmac('sha256', assertionSecret).update(payload).digest('base64url')}`;
}
async function gql(request: APIRequestContext, query: string, variables: object = {}) {
  const response = await request.post(`${server}/graphql`, { headers: { authorization: `Bearer ${auth}`, 'x-involute-viewer-assertion': assertion() }, data: { query, variables } });
  const body = await response.json();
  if (body.errors?.length) throw new Error(JSON.stringify(body.errors));
  return body.data;
}
async function mcp(request: APIRequestContext, token: string, name: string, args: object) {
  const response = await request.post(`${server}/mcp`, { headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream' }, data: { jsonrpc: '2.0', id: 'conformance', method: 'tools/call', params: { name, arguments: args } } });
  const text = await response.text();
  const body = JSON.parse(text.startsWith('{') ? text : text.split('\n').find((line) => line.startsWith('data:'))!.slice(5));
  if (body.error || body.result?.isError) throw new Error(JSON.stringify(body.error ?? body.result.content));
  return JSON.parse(body.result.content.find((item: { type: string }) => item.type === 'text').text);
}
const description = '### 1. 目标与架构定位\n真实 HTTP 与网页操作符合性。\n### 2. 核心功能与交付范围\n测试隔离任务，保留授权边界。\n### 3. 验收标准与验证方案\n浏览器与 MCP 观察同一结果。';
async function fixture(request: APIRequestContext) {
  const repository = `e2e/conformance-${Date.now().toString(36)}`;
  const team = (await gql(request, '{ teams { nodes { id key states { nodes { id name type } } } } }')).teams.nodes.find((item: { key: string }) => item.key === 'INV');
  const create = async (title: string, kind: string, parentId?: string) => {
    const result = (await gql(request, 'mutation($input:IssueCreateInput!){ issueCreate(input:$input){ success message issue { id identifier revision } } }', { input: { teamId: team.id, title, kind, repository, parentId, stateId: team.states.nodes.find((item: { type: string }) => item.type === 'UNSTARTED').id } })).issueCreate;
    if (!result.success) throw new Error(result.message);
    return result.issue;
  };
  const project = await create(repository, 'PROJECT');
  const first = await create('Conformance first milestone', 'MILESTONE', project.id);
  const second = await create('Conformance second milestone', 'MILESTONE', project.id);
  const credential = (await gql(request, 'mutation($input:AgentCredentialCreateInput!){ agentCredentialCreate(input:$input){ success message token credential { id } } }', { input: { team: team.id, name: `Conformance ${Date.now()}` } })).agentCredentialCreate;
  expect(credential.success).toBe(true);
  const call = (name: string, args: object) => mcp(request, credential.token, name, args);
  return { repository, team, project, first, second, create, call, credential };
}

test('agent and human complete the same work through real MCP and UI controls', async ({ page, request }) => {
  test.setTimeout(120_000);
  const f = await fixture(request);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const work = await f.call('work_propose', { team: f.team.id, title: 'Conformance delivery', description, acceptance: 'Public conformance passes', parent_id: f.first.id, repository: f.repository, idempotency_key: 'propose' });
  const context = () => f.call('work_get_context', { id: work.id });
  await expect(f.call('work_commit', { id: work.id, expected_revision: work.revision })).rejects.toThrow();
  expect((await context()).work.commitmentStatus).toBe('CANDIDATE');
  await page.goto(`/candidates?project=${encodeURIComponent(f.repository)}`);
  const card = page.getByRole('article', { name: `${work.identifier} candidate` });
  await card.getByRole('button', { name: /Commit/ }).click();
  await expect(card).toHaveCount(0);
  expect((await context()).work.commitmentStatus).toBe('COMMITTED');

  await f.call('work_update', { id: work.id, expected_revision: (await context()).work.revision, parent_id: f.second.id });
  await page.goto(`/issue/${work.id}`);
  await expect(page.getByLabel('Location')).toHaveValue(f.second.id);
  await page.getByLabel('Location').selectOption(f.first.id);
  await expect.poll(async () => (await context()).work.parentId).toBe(f.first.id);
  const other = await f.create('Conformance blocker', 'ISSUE', f.first.id);
  await f.call('work_link', { from_id: other.id, to_id: work.id, type: 'BLOCKS' });
  await page.reload();
  const relations = page.getByLabel('Relations');
  await expect(relations.getByRole('list', { name: 'Blocked by' })).toContainText(other.identifier);
  await relations.getByRole('button', { name: `Remove blocked by ${other.identifier}` }).click();
  await expect.poll(async () => (await context()).blockedBy.length).toBe(0);
  await f.call('work_link', { from_id: other.id, to_id: work.id, type: 'BLOCKS' });
  await f.call('work_unlink', { from_id: other.id, to_id: work.id, type: 'BLOCKS' });
  await page.reload();
  await expect(relations.getByRole('list', { name: 'Blocked by' })).toHaveCount(0);

  const labels = await f.call('work_catalog', { kind: 'labels', first: 200 });
  const feature = labels.nodes.find((label: { name: string }) => label.name.toLowerCase() === 'feature');
  await f.call('work_update', { id: work.id, expected_revision: (await context()).work.revision, label_ids: [feature.id] });
  await page.reload();
  await expect(page.getByRole('checkbox', { name: 'Feature', exact: true })).toBeChecked();
  await page.getByRole('checkbox', { name: 'Feature', exact: true }).uncheck();
  await expect.poll(async () => (await f.call('work_search', { query: work.identifier, filter: 'label:Feature', repository: f.repository })).length).toBe(0);
  await f.call('work_comment', { work_id: work.id, body: 'Agent conformance comment', idempotency_key: 'comment' });
  await page.reload();
  await expect(page.getByText('Agent conformance comment', { exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'Leave a comment…' }).fill('Human conformance reply');
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await expect.poll(async () => JSON.stringify((await context()).pages.comments)).toContain('Human conformance reply');

  const firstClaim = await f.call('work_claim', { id: work.id });
  await f.call('work_claim_release', { work_id: work.id, claim_token: firstClaim.claim_token, reason: 'Yield this execution' });
  await page.goto(`/work/${work.id}`);
  await expect(page.getByText('Unclaimed', { exact: true })).toBeVisible();
  const secondClaim = await f.call('work_claim', { id: work.id });
  await page.reload();
  await page.getByRole('button', { name: 'Release claim', exact: true }).click();
  await page.getByLabel('Why release this claim').fill('Operator recovery');
  await page.getByRole('button', { name: 'Release', exact: true }).click();
  await expect.poll(async () => (await context()).claim).toBeNull();
  await expect(f.call('run_report', { work_id: work.id, claim_token: secondClaim.claim_token, status: 'running' })).rejects.toThrow();

  const claim = await f.call('work_claim', { id: work.id });
  const run = (await f.call('run_report', { work_id: work.id, claim_token: claim.claim_token, status: 'running' })).run;
  const runArgs = { work_id: work.id, run_id: run.id, claim_token: claim.claim_token };
  const evidence = await f.call('evidence_attach', { ...runArgs, kind: 'test', url: 'https://example.test/incorrect', idempotency_key: 'wrong' });
  await f.call('evidence_retract', { evidence_id: evidence.evidence.id, claim_token: claim.claim_token, reason: 'Wrong fixture artifact' });
  await f.call('evidence_attach', { ...runArgs, kind: 'test', url: 'https://example.test/correct', idempotency_key: 'correct' });
  await page.reload();
  await page.getByRole('button', { name: 'Retract evidence https://example.test/correct', exact: true }).click();
  await page.getByLabel('Why retract https://example.test/correct').fill('Human correction through the web');
  await page.getByRole('button', { name: 'Confirm retract', exact: true }).click();
  await expect.poll(async () => JSON.stringify((await context()).pages.evidence)).toContain('Human correction through the web');
  await f.call('evidence_attach', { ...runArgs, kind: 'test', url: 'https://example.test/corrected-again', idempotency_key: 'corrected-again' });
  await f.call('run_report', { ...runArgs, status: 'completed', summary: 'Public conformance evidence attached' });
  await expect(f.call('work_update', { id: work.id, expected_revision: (await context()).work.revision, state: 'DONE' })).rejects.toThrow();
  await page.reload();
  await expect(page.getByText('Wrong fixture artifact', { exact: false }).first()).toBeVisible();
  await page.getByLabel('Review reason').fill('Return for a second verified attempt');
  await page.getByRole('button', { name: 'Reject', exact: true }).click();
  await expect.poll(async () => (await context()).reviewDecisions[0]?.decision).toBe('REJECTED');
  const retry = await f.call('work_claim', { id: work.id });
  const retryRun = (await f.call('run_report', { work_id: work.id, claim_token: retry.claim_token, status: 'running' })).run;
  await f.call('evidence_attach', { work_id: work.id, run_id: retryRun.id, claim_token: retry.claim_token, kind: 'test', url: 'https://example.test/retested' });
  await f.call('run_report', { work_id: work.id, run_id: retryRun.id, claim_token: retry.claim_token, status: 'completed' });
  await page.reload();
  await page.getByRole('button', { name: 'Accept', exact: true }).click();
  await expect.poll(async () => (await context()).reviewDecisions[0]?.decision).toBe('ACCEPTED');
  await f.call('work_update', { id: work.id, expected_revision: (await context()).work.revision, state: 'UNSTARTED' });
  await page.goto(`/issue/${work.id}`);
  await expect(page.getByLabel('Issue state').locator('option:checked')).toHaveText('Ready');
  expect(errors).toEqual([]);
  await page.screenshot({ path: test.info().outputPath('reopened-work.png'), fullPage: true });
  await gql(request, 'mutation($id:String!){ agentCredentialRevoke(id:$id){success} }', { id: f.credential.credential.id });
});

test('pagination never limits MCP search, board filtering or an opened issue', async ({ page, request }) => {
  test.setTimeout(120_000);
  const f = await fixture(request);
  const target = await f.create('Boundaryneedle distant target', 'ISSUE', f.first.id);
  // Batch GraphQL aliases still execute the public creation resolver for every row.
  for (let start = 0; start < 204; start += 20) {
    const count = Math.min(20, 204 - start);
    const definitions = Array.from({ length: count }, (_, i) => `$i${i}:IssueCreateInput!`).join(',');
    const mutations = Array.from({ length: count }, (_, i) => `n${i}:issueCreate(input:$i${i}){success message issue{id}}`).join('\n');
    const variables = Object.fromEntries(Array.from({ length: count }, (_, i) => [`i${i}`, { teamId: f.team.id, title: `Boundaryneedle filler ${start + i}`, kind: 'ISSUE', parentId: f.first.id, stateId: f.team.states.nodes.find((item: { type: string }) => item.type === 'UNSTARTED').id }]));
    const result = await gql(request, `mutation(${definitions}){${mutations}}`, variables);
    for (const value of Object.values(result) as Array<{ success: boolean }>) expect(value.success).toBe(true);
  }
  const ids: string[] = [];
  let after: string | undefined;
  do {
    const result = await f.call('work_search', { query: 'Boundaryneedle', repository: f.repository, paginate: true, first: 75, ...(after ? { after } : {}) });
    ids.push(...result.nodes.map((item: { id: string }) => item.id));
    after = result.pageInfo.hasNextPage ? result.pageInfo.endCursor : undefined;
  } while (after);
  expect(ids).toHaveLength(205);
  expect(new Set(ids).size).toBe(205);
  expect(ids).toContain(target.id);
  expect((await f.call('work_search', { query: target.identifier, repository: f.repository })).map((item: { id: string }) => item.id)).toContain(target.id);
  const childIds: string[] = [];
  do {
    const result = await f.call('work_read_page', { id: f.first.id, section: 'children', first: 75, ...(after ? { after } : {}) });
    childIds.push(...result.nodes.map((item: { id: string }) => item.id));
    after = result.pageInfo.hasNextPage ? result.pageInfo.endCursor : undefined;
  } while (after);
  expect(new Set(childIds)).toEqual(new Set(ids));
  await page.goto(`/?project=${encodeURIComponent(f.repository)}`);
  await expect(page.getByRole('heading', { name: f.repository, exact: true })).toBeVisible();
  await expect(page.getByTestId(`issue-card-${target.id}`)).toHaveCount(0);
  // A project in the URL is a filter in effect, so the bar is already open (INV-1086).
  await page.getByLabel('Search board issues').fill(target.identifier);
  const targetCard = page.getByTestId(`issue-card-${target.id}`);
  await expect(targetCard).toBeVisible();
  await targetCard.getByRole('button', { name: `Open ${target.identifier}` }).click();
  const drawer = page.getByRole('dialog', { name: 'Issue detail drawer' });
  await expect(drawer.getByLabel('Issue title')).toHaveValue('Boundaryneedle distant target');
  // A real mutation refetches the list: selected work and filtering must survive it.
  await drawer.getByLabel('Issue title').fill('Boundaryneedle distant target opened');
  await drawer.getByLabel('Issue title').press('Enter');
  await expect(drawer.getByLabel('Issue title')).toHaveValue('Boundaryneedle distant target opened');
  await expect(page.getByLabel('Search board issues')).toHaveValue(target.identifier);
  await expect(targetCard).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('filtered-open-work.png'), fullPage: true });
  await gql(request, 'mutation($id:String!){ agentCredentialRevoke(id:$id){success} }', { id: f.credential.credential.id });
});
