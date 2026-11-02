import type { PrismaClient, Team, User } from '@prisma/client';
import { PrismaClient as PrismaClientConstructor } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ADMIN_EMAIL, DEFAULT_TEAM_KEY, resetAndSeed } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import { startServer, type StartedServer } from './index.ts';
import { createIssue } from './issue-service.ts';
import { createSession } from './session.js';
import { writeActorFromViewer } from './work-service.ts';

// INV-1516: per-state totals under the board's own filter, so a column can say what it has not loaded.
loadProjectEnvironment();
const prisma: PrismaClient = new PrismaClientConstructor();

const QUERY = /* GraphQL */ `
  query Counts($filter: IssueFilter, $query: String) { issueStateCounts(filter: $filter, query: $query) { stateId count } }
`;

describe('issueStateCounts (INV-1516)', () => {
  let team: Team;
  let human: User;
  let server: StartedServer;

  beforeAll(async () => { await prisma.$connect(); });
  afterAll(async () => { await resetAndSeed(prisma); await prisma.$disconnect(); });
  beforeEach(async () => {
    await resetAndSeed(prisma);
    team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
    human = await prisma.user.findUniqueOrThrow({ where: { email: DEFAULT_ADMIN_EMAIL } });
    server = await startServer({ allowAdminFallback: true, prisma, authToken: 'unused-static-token', port: 0 });
  });
  afterEach(async () => { await server.stop(); });

  async function counts(variables: Record<string, unknown>) {
    const session = await createSession(prisma, human.id, 3600);
    const response = await fetch(`${server.url}/graphql`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: `involute_session=${session.token}` }, body: JSON.stringify({ query: QUERY, variables }) });
    const body = await response.json() as { data: { issueStateCounts: Array<{ stateId: string; count: number }> }; errors?: unknown };
    expect(body.errors).toBeUndefined();
    return Object.fromEntries(body.data.issueStateCounts.map((row) => [row.stateId, row.count]));
  }

  it('counts committed items per state with the same filter and query the board sends', async () => {
    const actor = writeActorFromViewer(human, 'test');
    const states = await prisma.workflowState.findMany({ where: { teamId: team.id } });
    const canceled = states.find((state) => state.type === 'CANCELED')!;
    const ready = states.find((state) => state.type === 'UNSTARTED')!;
    const project = await createIssue(prisma, { teamId: team.id, title: 'P', kind: 'PROJECT', repository: 'test/counts', commitmentStatus: 'COMMITTED', stateId: ready.id }, actor);
    for (const title of ['Gone one', 'Gone two', 'Gone three']) {
      await createIssue(prisma, { teamId: team.id, title, parentId: project.id, repository: 'test/counts', acceptance: 'a', stateId: canceled.id }, actor);
    }
    await createIssue(prisma, { teamId: team.id, title: 'Open', parentId: project.id, repository: 'test/counts', acceptance: 'a', stateId: ready.id }, actor);
    await createIssue(prisma, { teamId: team.id, title: 'Idea', parentId: project.id, repository: 'test/counts', acceptance: 'a', stateId: ready.id, commitmentStatus: 'CANDIDATE' }, actor);

    const committed = await counts({ filter: { commitmentStatus: 'COMMITTED', team: { key: { eq: DEFAULT_TEAM_KEY } } } });
    expect(committed[canceled.id]).toBe(3);
    // The PROJECT and the open issue; the candidate is not on the board.
    expect(committed[ready.id]).toBe(2);
    const searched = await counts({ filter: { commitmentStatus: 'COMMITTED' }, query: 'kind:ISSUE Gone' });
    expect(searched).toEqual({ [canceled.id]: 3 });
  });

  it('orders by last change and pages with its own cursor when asked (INV-1516)', async () => {
    const actor = writeActorFromViewer(human, 'test');
    const project = await createIssue(prisma, { teamId: team.id, title: 'P', kind: 'PROJECT', repository: 'test/order', commitmentStatus: 'COMMITTED' }, actor);
    const oldest = await createIssue(prisma, { teamId: team.id, title: 'Oldest', parentId: project.id, repository: 'test/order', acceptance: 'a' }, actor);
    await createIssue(prisma, { teamId: team.id, title: 'Middle', parentId: project.id, repository: 'test/order', acceptance: 'a' }, actor);
    await createIssue(prisma, { teamId: team.id, title: 'Newest', parentId: project.id, repository: 'test/order', acceptance: 'a' }, actor);
    // Cancelling an old item today makes it the most recently changed.
    await prisma.issue.update({ where: { id: oldest.id }, data: { title: 'Oldest, changed today', updatedAt: new Date(Date.now() + 60_000) } });
    const session = await createSession(prisma, human.id, 3600);
    const page = async (variables: Record<string, unknown>) => {
      const response = await fetch(`${server.url}/graphql`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: `involute_session=${session.token}` }, body: JSON.stringify({ query: `query Page($after: String, $orderBy: IssueOrder) { issues(first: 2, after: $after, orderBy: $orderBy, query: "kind:ISSUE") { nodes { title } pageInfo { endCursor hasNextPage } } }`, variables }) });
      return (await response.json() as { data: { issues: { nodes: Array<{ title: string }>; pageInfo: { endCursor: string; hasNextPage: boolean } } } }).data.issues;
    };
    const first = await page({ orderBy: 'UPDATED' });
    expect(first.nodes.map((node) => node.title)).toEqual(['Oldest, changed today', 'Newest']);
    const second = await page({ orderBy: 'UPDATED', after: first.pageInfo.endCursor });
    expect(second.nodes.map((node) => node.title)).toEqual(['Middle']);
    expect(second.pageInfo.hasNextPage).toBe(false);
    // The default stays newest-created first.
    expect((await page({})).nodes.map((node) => node.title)).toEqual(['Newest', 'Middle']);
  });
});
