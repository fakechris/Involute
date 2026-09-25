import type { PrismaClient, Team, WorkflowState } from '@prisma/client';

import { PrismaClient as PrismaClientConstructor } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_TEAM_KEY, seedDatabase } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import { startServer, type StartedServer } from './index.ts';
import { createWorkLink } from './link-service.ts';

loadProjectEnvironment();

const prisma = new PrismaClientConstructor();
const TEST_AUTH_TOKEN = 'test-auth-token';

let server: StartedServer;

const WORK_GRAPH_QUERY = `
  query WorkGraph($project: String!, $includeCandidates: Boolean) {
    workGraph(project: $project, includeCandidates: $includeCandidates) {
      root { identifier }
      repository
      truncated
      nodes { identifier kind state { type } }
      externalNodes { identifier }
      edges { type fromId toId }
    }
  }
`;

describe('workGraph project view (INV-681)', () => {
  let team: Team;
  let ready: WorkflowState;
  let counter = 0;

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
    ready = await prisma.workflowState.findFirstOrThrow({ where: { teamId: team.id, name: 'Ready' } });
    server = await startServer({ allowAdminFallback: true, prisma, authToken: TEST_AUTH_TOKEN, port: 0 });
  });

  afterEach(async () => {
    await server.stop();
  });

  function make(title: string, extra: Record<string, unknown> = {}) {
    counter += 1;
    return prisma.issue.create({
      data: { identifier: `INV-${700 + counter}`, title, teamId: team.id, stateId: ready.id, ...extra },
    });
  }

  it('returns the project subtree, links touching it, and linked work outside it', async () => {
    const root = await make('acme/app', { kind: 'PROJECT', repository: 'acme/app' });
    const milestone = await make('M1', { kind: 'MILESTONE', repository: 'acme/app' });
    const upstream = await make('Upstream', { repository: 'acme/app' });
    const downstream = await make('Downstream', { repository: 'acme/app' });
    const candidate = await make('Proposed', { repository: 'acme/app', commitmentStatus: 'CANDIDATE' });
    const elsewhere = await make('Other repo blocker', { repository: 'acme/other' });
    await make('Unrelated', { repository: 'acme/other' });

    await createWorkLink(prisma, { fromId: root.id, toId: milestone.id, type: 'CONTAINS' });
    await createWorkLink(prisma, { fromId: milestone.id, toId: upstream.id, type: 'CONTAINS' });
    await createWorkLink(prisma, { fromId: milestone.id, toId: downstream.id, type: 'CONTAINS' });
    await createWorkLink(prisma, { fromId: upstream.id, toId: downstream.id, type: 'BLOCKS' });
    await createWorkLink(prisma, { fromId: elsewhere.id, toId: upstream.id, type: 'BLOCKS' });

    const byRepository = await postGraphQL({ query: WORK_GRAPH_QUERY, variables: { project: 'acme/app' } });
    expectGraphQLSuccess(byRepository);
    const graph = byRepository.body.data.workGraph;
    expect(graph.root).toEqual({ identifier: root.identifier });
    expect(graph.repository).toBe('acme/app');
    expect(graph.truncated).toBe(false);
    expect(graph.nodes.map((node: { identifier: string }) => node.identifier).sort()).toEqual(
      [root, milestone, upstream, downstream].map((issue) => issue.identifier).sort(),
    );
    expect(graph.externalNodes).toEqual([{ identifier: elsewhere.identifier }]);
    const edgeKeys = graph.edges.map((edge: { type: string; fromId: string; toId: string }) => `${edge.type}:${edge.fromId}>${edge.toId}`);
    expect(edgeKeys).toEqual(expect.arrayContaining([
      `CONTAINS:${root.id}>${milestone.id}`,
      `BLOCKS:${upstream.id}>${downstream.id}`,
      `BLOCKS:${elsewhere.id}>${upstream.id}`,
    ]));
    expect(edgeKeys).toHaveLength(5);

    const byIdentifier = await postGraphQL({ query: WORK_GRAPH_QUERY, variables: { project: root.identifier } });
    expectGraphQLSuccess(byIdentifier);
    expect(byIdentifier.body.data.workGraph.nodes.map((node: { identifier: string }) => node.identifier).sort())
      .toEqual(graph.nodes.map((node: { identifier: string }) => node.identifier).sort());

    const withCandidates = await postGraphQL({
      query: WORK_GRAPH_QUERY,
      variables: { project: 'acme/app', includeCandidates: true },
    });
    expectGraphQLSuccess(withCandidates);
    expect(withCandidates.body.data.workGraph.nodes.map((node: { identifier: string }) => node.identifier))
      .toContain(candidate.identifier);
  });

  it('resolves a bare repository value that has no owner/ prefix', async () => {
    const loose = await make('Loose work', { repository: 'involute' });
    const response = await postGraphQL({ query: WORK_GRAPH_QUERY, variables: { project: 'involute' } });
    expectGraphQLSuccess(response);
    expect(response.body.data.workGraph.nodes).toEqual([
      expect.objectContaining({ identifier: loose.identifier }),
    ]);
  });

  it('derives each item\'s timeline from real audited state changes', async () => {
    await make('acme/time', { kind: 'PROJECT', repository: 'acme/time' });
    const progress = await prisma.workflowState.findFirstOrThrow({ where: { teamId: team.id, type: 'STARTED' } });
    const done = await prisma.workflowState.findFirstOrThrow({ where: { teamId: team.id, type: 'COMPLETED' } });
    const created = await postGraphQL({
      query: `mutation($input: IssueCreateInput!) { issueCreate(input: $input) { issue { id } } }`,
      variables: { input: { teamId: team.id, title: 'Tracked', stateId: ready.id, repository: 'acme/time' } },
    });
    expectGraphQLSuccess(created);
    const tracked = created.body.data.issueCreate.issue.id as string;
    for (const stateId of [progress.id, done.id]) {
      const moved = await postGraphQL({
        query: `mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`,
        variables: { id: tracked, input: { stateId } },
      });
      expectGraphQLSuccess(moved);
    }
    const imported = await make('Imported without audit', { repository: 'acme/time', stateId: done.id });

    const response = await postGraphQL({
      query: `
        query($project: String!) {
          workGraph(project: $project) {
            timeline { workId history startedAt completedAt transitions { stateType } }
            cycles { id }
          }
        }
      `,
      variables: { project: 'acme/time' },
    });
    expectGraphQLSuccess(response);
    const timeline = response.body.data.workGraph.timeline as Array<{
      workId: string; history: string; startedAt: string | null; completedAt: string | null; transitions: Array<{ stateType: string }>;
    }>;
    const trackedEntry = timeline.find((entry) => entry.workId === tracked)!;
    expect(trackedEntry.history).toBe('FULL');
    expect(trackedEntry.transitions.map((transition) => transition.stateType)).toEqual(['UNSTARTED', 'STARTED', 'COMPLETED']);
    expect(trackedEntry.startedAt).not.toBeNull();
    expect(new Date(trackedEntry.completedAt!).getTime()).toBeGreaterThanOrEqual(new Date(trackedEntry.startedAt!).getTime());
    expect(timeline.find((entry) => entry.workId === imported.id)).toMatchObject({ history: 'NONE', completedAt: null });
    expect(response.body.data.workGraph.cycles).toEqual([]);
  });

  it('an unknown selector resolves as a repository; one with no work is just empty', async () => {
    const unknown = await postGraphQL({ query: WORK_GRAPH_QUERY, variables: { project: 'INV-99999' } });
    expectGraphQLSuccess(unknown);
    expect(unknown.body.data.workGraph).toMatchObject({ root: null, nodes: [] });

    const empty = await postGraphQL({ query: WORK_GRAPH_QUERY, variables: { project: 'acme/missing' } });
    expectGraphQLSuccess(empty);
    expect(empty.body.data.workGraph).toMatchObject({ root: null, nodes: [], edges: [] });
  });
});

async function resetDatabase(prismaClient: PrismaClient): Promise<void> {
  await prismaClient.comment.deleteMany();
  await prismaClient.issue.deleteMany();
  await prismaClient.workflowState.deleteMany();
  await prismaClient.team.deleteMany();
  await prismaClient.issueLabel.deleteMany();
  // ActorAudit references users with Restrict (INV-586/604): it goes first.
  await prismaClient.actorAudit.deleteMany();
  await prismaClient.user.deleteMany();
  await prismaClient.legacyLinearMapping.deleteMany();
  await seedDatabase(prismaClient);
}

async function postGraphQL({
  query,
  variables,
}: {
  query: string;
  variables?: Record<string, unknown>;
}): Promise<{ body: any; status: number }> {
  const response = await fetch(`${server.url}/graphql`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${TEST_AUTH_TOKEN}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  return {
    body: await response.json(),
    status: response.status,
  };
}

function expectGraphQLSuccess(response: { body: any; status: number }): void {
  expect(response.status).toBe(200);
  expect(response.body.errors).toBeUndefined();
}
