import { createHmac } from 'node:crypto';

import { expect, test, type APIRequestContext } from '@playwright/test';

// End-to-end acceptance for issue relations (INV-679), the project graph
// (INV-681) and the timeline (INV-682), against the real server and database.
// The fixture is built through GraphQL so every link and state change goes
// through the same validation and audit path as a person or agent would.

const serverPort = process.env.E2E_SERVER_PORT ?? '4300';
const authToken = process.env.E2E_AUTH_TOKEN ?? 'e2e-auth-token';
const graphqlUrl = `http://127.0.0.1:${serverPort}/graphql`;
const viewerAssertionSecret = process.env.E2E_VIEWER_ASSERTION_SECRET ?? 'e2e-viewer-assertion-secret';
// Unique per run: a retry or a leftover from an aborted run must not make two
// PROJECT nodes claim the same repository (the view would rightly call it ambiguous).
const REPOSITORY = `e2e/work-graph-${Date.now().toString(36)}`;

/**
 * Done is human-gated: a bare service token may not accept work. Moves that
 * need a person are signed as the seeded admin, exactly as the e2e web client is.
 */
function humanViewerAssertion(email = 'admin@involute.local'): string {
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 600, sub: email, subType: 'email' }),
    'utf8',
  ).toString('base64url');
  return `${payload}.${createHmac('sha256', viewerAssertionSecret).update(payload).digest('base64url')}`;
}

async function gql<T>(
  request: APIRequestContext,
  query: string,
  variables: Record<string, unknown> = {},
  options: { asHuman?: boolean } = {},
): Promise<T> {
  const response = await request.post(graphqlUrl, {
    data: { query, variables },
    headers: {
      authorization: `Bearer ${authToken}`,
      ...(options.asHuman ? { 'x-involute-viewer-assertion': humanViewerAssertion() } : {}),
    },
  });
  const body = (await response.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (body.errors?.length) throw new Error(body.errors.map((error) => error.message).join('; '));
  return body.data as T;
}

interface Fixture {
  project: { id: string; identifier: string };
  milestone: { id: string; identifier: string };
  upstream: { id: string; identifier: string };
  downstream: { id: string; identifier: string };
  other: { id: string; identifier: string };
}

async function buildFixture(request: APIRequestContext): Promise<Fixture> {
  const teams = await gql<{ teams: { nodes: Array<{ id: string; key: string; states: { nodes: Array<{ id: string; name: string }> } }> } }>(
    request,
    `{ teams { nodes { id key states { nodes { id name } } } } }`,
  );
  const team = teams.teams.nodes.find((candidate) => candidate.key === 'INV') ?? teams.teams.nodes[0]!;
  const state = (name: string) => team.states.nodes.find((candidate) => candidate.name === name)!.id;
  const create = async (title: string, stateName: string, kind = 'ISSUE') =>
    (
      await gql<{ issueCreate: { issue: { id: string; identifier: string } } }>(
        request,
        `mutation($input: IssueCreateInput!) { issueCreate(input: $input) { issue { id identifier } } }`,
        { input: { teamId: team.id, title, stateId: state(stateName), kind, repository: REPOSITORY } },
      )
    ).issueCreate.issue;
  const link = async (fromId: string, toId: string, type: string) => {
    const result = await gql<{ workLink: { success: boolean } }>(
      request,
      `mutation($fromId: String!, $toId: String!, $type: WorkLinkType!) { workLink(fromId: $fromId, toId: $toId, type: $type) { success } }`,
      { fromId, toId, type },
    );
    expect(result.workLink.success).toBe(true);
  };
  const move = (id: string, stateName: string) =>
    gql(
      request,
      `mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`,
      { id, input: { stateId: state(stateName) } },
      { asHuman: true },
    );

  const project = await create(REPOSITORY, 'In Progress', 'PROJECT');
  const milestone = await create('E2E milestone', 'In Progress', 'MILESTONE');
  const upstream = await create('E2E upstream work', 'Ready');
  const downstream = await create('E2E downstream work', 'Ready');
  const other = await create('E2E other work', 'Ready');
  await link(project.id, milestone.id, 'CONTAINS');
  for (const child of [upstream, downstream, other]) await link(milestone.id, child.id, 'CONTAINS');
  await link(upstream.id, downstream.id, 'BLOCKS');
  await move(upstream.id, 'In Progress');
  await move(other.id, 'In Progress');
  await move(other.id, 'Done');
  return { project, milestone, upstream, downstream, other };
}

async function removeFixture(request: APIRequestContext, fixture: Fixture | null) {
  if (!fixture) return;
  for (const item of [fixture.other, fixture.downstream, fixture.upstream, fixture.milestone, fixture.project]) {
    await gql(request, `mutation($id: String!) { issueDelete(id: $id) { success } }`, { id: item.id }, { asHuman: true }).catch(
      () => undefined,
    );
  }
}

test.describe('work graph acceptance', () => {
  let fixture: Fixture | null = null;

  test.beforeAll(async ({ request }) => {
    fixture = await buildFixture(request);
  });

  test.afterAll(async ({ request }) => {
    await removeFixture(request, fixture);
  });

  test('board shows the blocked marker and the drawer lists and edits relations', async ({ page }) => {
    const { upstream, downstream, other } = fixture!;
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'All issues', exact: true })).toBeVisible();

    const blockedCard = page.getByTestId(`issue-card-${downstream.id}`);
    await expect(blockedCard.getByTestId(`issue-blocked-${downstream.id}`)).toHaveText('Blocked');
    await expect(page.getByTestId(`issue-blocked-${upstream.id}`)).toHaveCount(0);

    await blockedCard.getByRole('button', { name: `Open ${downstream.identifier}` }).click();
    const drawer = page.getByRole('dialog', { name: 'Issue detail drawer' });
    const relations = drawer.getByLabel('Relations');
    await expect(relations.getByRole('list', { name: 'Blocked by' })).toContainText(upstream.identifier);

    // A cycle is refused with the server's reason, not a silent failure.
    await relations.getByRole('button', { name: 'Add relation' }).click();
    await relations.getByLabel('Relation type').selectOption('blocking');
    await relations.getByLabel('Related issue identifier').fill(upstream.identifier);
    await relations.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(relations.getByRole('alert')).toContainText(/cycle/i);

    // A valid relation is added, shown, and removed again.
    await relations.getByLabel('Relation type').selectOption('related');
    await relations.getByLabel('Related issue identifier').fill(other.identifier);
    await relations.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(relations.getByRole('list', { name: 'Related' })).toContainText(other.identifier);
    await relations.getByRole('button', { name: `Remove related ${other.identifier}` }).click();
    await expect(relations.getByRole('list', { name: 'Related' })).toHaveCount(0);

    // The full issue page (where the graph's "Open issue" lands) shows the same section.
    await page.goto(`/issue/${downstream.id}`);
    await expect(page.getByLabel('Relations').getByRole('list', { name: 'Blocked by' })).toContainText(upstream.identifier);
  });

  test('graph outline, dependency view and timeline render the project', async ({ page }) => {
    const { milestone, upstream, downstream, other } = fixture!;
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));

    await page.goto(`/graph?project=${encodeURIComponent(REPOSITORY)}`);
    const outline = page.getByRole('tree', { name: 'Project outline' });
    await expect(outline).toBeVisible();
    const milestoneRow = outline.getByRole('treeitem', { name: `${milestone.identifier} E2E milestone` });
    await expect(milestoneRow.getByLabel('1 of 3 done')).toBeVisible();
    await expect(outline.getByRole('treeitem', { name: `${downstream.identifier} E2E downstream work` }).getByText('Blocked')).toBeVisible();

    await page.getByRole('tab', { name: /Dependencies/ }).click();
    const graph = page.getByRole('region', { name: 'Dependency graph' });
    await expect(graph.getByRole('button', { name: `Focus ${upstream.identifier} E2E upstream work` })).toBeVisible();
    await expect(graph.getByRole('button', { name: `Focus ${other.identifier} E2E other work` })).toHaveCount(0);
    await expect(graph.locator('[data-edge-kind="open"]')).toHaveCount(1);
    await graph.getByRole('button', { name: `Focus ${downstream.identifier} E2E downstream work` }).click();
    await expect(page.getByRole('complementary', { name: `Focused ${downstream.identifier}` })).toContainText(upstream.identifier);

    await page.getByRole('tab', { name: 'Timeline' }).click();
    const timeline = page.getByRole('region', { name: 'Project timeline' });
    await expect(timeline).toBeVisible();
    // Done item: waiting line, in-progress bar, done dot — all from its audit trail.
    await expect(timeline.locator(`[data-work-id="${other.id}"] .timeline-dot`)).toHaveCount(1);
    await expect(timeline.locator(`[data-work-id="${upstream.id}"] .timeline-bar`)).toHaveCount(2);
    await expect(timeline.getByText(/done 1/)).toBeVisible();

    expect(errors).toEqual([]);
  });

  test('a candidate without a parent is placed while committing it (INV-719)', async ({ page, request }) => {
    const { milestone } = fixture!;
    const teams = await gql<{ teams: { nodes: Array<{ id: string; key: string }> } }>(request, `{ teams { nodes { id key } } }`);
    const team = teams.teams.nodes.find((candidate) => candidate.key === 'INV') ?? teams.teams.nodes[0]!;
    const proposed = (
      await gql<{ workPropose: { issue: { id: string; identifier: string } } }>(
        request,
        `mutation($input: WorkProposeInput!) { workPropose(input: $input) { issue { id identifier } } }`,
        { input: { teamId: team.id, title: 'E2E unplaced candidate', repository: REPOSITORY, acceptance: 'placed at commit' } },
      )
    ).workPropose.issue;

    await page.goto(`/candidates?project=${encodeURIComponent(REPOSITORY)}`);
    const card = page.getByRole('article', { name: `${proposed.identifier} candidate` });
    await expect(card).toBeVisible();
    await expect(card.getByRole('button', { name: /Commit/ })).toBeDisabled();

    await card.getByLabel(`Parent for ${proposed.identifier}`).selectOption({ label: `${milestone.identifier} — E2E milestone` });
    await card.getByRole('button', { name: /Commit/ }).click();
    await expect(card).toHaveCount(0);

    await page.goto(`/graph?project=${encodeURIComponent(REPOSITORY)}`);
    const milestoneRow = page
      .getByRole('tree', { name: 'Project outline' })
      .getByRole('treeitem', { name: `${milestone.identifier} E2E milestone` });
    await expect(milestoneRow.getByRole('treeitem', { name: `${proposed.identifier} E2E unplaced candidate` })).toBeVisible();

    await gql(request, `mutation($id: String!) { issueDelete(id: $id) { success } }`, { id: proposed.id }, { asHuman: true });
  });

  test('mentions become relations and a worded dependency can be recorded from the candidate card (INV-720)', async ({ page, request }) => {
    const { milestone, upstream } = fixture!;
    const teams = await gql<{ teams: { nodes: Array<{ id: string; key: string }> } }>(request, `{ teams { nodes { id key } } }`);
    const team = teams.teams.nodes.find((candidate) => candidate.key === 'INV') ?? teams.teams.nodes[0]!;
    const proposed = (
      await gql<{ workPropose: { issue: { id: string; identifier: string } } }>(
        request,
        `mutation($input: WorkProposeInput!) { workPropose(input: $input) { issue { id identifier } } }`,
        { input: { teamId: team.id, title: 'E2E mentions', parentId: milestone.id, description: `依赖 ${upstream.identifier} 完成后再做。`, acceptance: 'linked' } },
      )
    ).workPropose.issue;

    await page.goto(`/candidates?project=${encodeURIComponent(REPOSITORY)}`);
    const card = page.getByRole('article', { name: `${proposed.identifier} candidate` });
    await card.getByLabel(`Dependency hints for ${proposed.identifier}`).getByRole('button', { name: `${upstream.identifier} blocks this` }).click();
    await expect(card.getByLabel(`Dependency hints for ${proposed.identifier}`)).toHaveCount(0);

    await page.goto(`/issue/${proposed.id}`);
    await expect(page.getByLabel('Relations').getByRole('list', { name: 'Blocked by' })).toContainText(upstream.identifier);

    await gql(request, `mutation($id: String!) { issueDelete(id: $id) { success } }`, { id: proposed.id }, { asHuman: true });
  });
});
