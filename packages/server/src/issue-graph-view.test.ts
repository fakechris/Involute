import type { PrismaClient, Team, WorkflowState } from '@prisma/client';

import { PrismaClient as PrismaClientConstructor } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_TEAM_KEY, seedDatabase } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import { startServer, type StartedServer } from './index.ts';
import { createWorkLink } from './link-service.ts';
import { loadIssueWorkGraph } from './issue-graph-view.ts';

loadProjectEnvironment();

const prisma = new PrismaClientConstructor();
const TEST_AUTH_TOKEN = 'test-auth-token';

let server: StartedServer;

const ISSUE_GRAPH_QUERY = `
  query IssueGraph($id: String!, $depth: Int) {
    issueGraph(id: $id, depth: $depth) {
      focus { identifier title }
      truncated
      nodes { identifier kind state { type } }
      ancestors { identifier kind }
      edges { type fromId toId }
      rollups { identifier kind total completed inProgress blocked canceled }
    }
  }
`;

describe('issueGraph neighbourhood view (INV-1496)', () => {
  let team: Team;
  let ready: WorkflowState;
  let started: WorkflowState;
  let done: WorkflowState;
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
    started = await prisma.workflowState.findFirstOrThrow({ where: { teamId: team.id, name: 'In Progress' } });
    done = await prisma.workflowState.findFirstOrThrow({ where: { teamId: team.id, name: 'Done' } });
    server = await startServer({ allowAdminFallback: true, prisma, authToken: TEST_AUTH_TOKEN, port: 0 });
  });

  afterEach(async () => {
    await server.stop();
  });

  /** Work in the project under test; a CONTAINS link needs a repository on both ends. */
  function make(title: string, extra: Record<string, unknown> = {}) {
    counter += 1;
    return prisma.issue.create({
      data: {
        identifier: `INV-${800 + counter}`,
        title,
        teamId: team.id,
        stateId: ready.id,
        repository: 'acme/app',
        ...extra,
      },
    });
  }

  /** The chain a reader sees when one item is open: above it, beside it, under it. */
  it('returns the ancestors, siblings, children and dependency chain of one item', async () => {
    const project = await make('acme/app', { kind: 'PROJECT' });
    const milestone = await make('M1', { kind: 'MILESTONE' });
    const epic = await make('E1', { kind: 'EPIC' });
    const focus = await make('The focus');
    const sibling = await make('A sibling');
    const child = await make('A child');
    const blocker = await make('A blocker');
    const dependent = await make('A dependent');

    await createWorkLink(prisma, { fromId: project.id, toId: milestone.id, type: 'CONTAINS' });
    await createWorkLink(prisma, { fromId: milestone.id, toId: epic.id, type: 'CONTAINS' });
    await createWorkLink(prisma, { fromId: epic.id, toId: focus.id, type: 'CONTAINS' });
    await createWorkLink(prisma, { fromId: epic.id, toId: sibling.id, type: 'CONTAINS' });
    await createWorkLink(prisma, { fromId: focus.id, toId: child.id, type: 'CONTAINS' });
    await createWorkLink(prisma, { fromId: blocker.id, toId: focus.id, type: 'BLOCKS' });
    await createWorkLink(prisma, { fromId: focus.id, toId: dependent.id, type: 'BLOCKS' });

    const response = await postGraphQL({
      query: ISSUE_GRAPH_QUERY,
      variables: { id: focus.identifier, depth: 1 },
    });
    expectGraphQLSuccess(response);
    const graph = response.body.data.issueGraph;

    expect(graph.focus.identifier).toBe(focus.identifier);
    // The chain above the focus, topmost first.
    expect(graph.ancestors.map((node: { identifier: string }) => node.identifier)).toEqual([
      project.identifier,
      milestone.identifier,
      epic.identifier,
    ]);

    const identifiers = graph.nodes.map((node: { identifier: string }) => node.identifier);
    expect(identifiers).toContain(focus.identifier);
    expect(identifiers).toContain(sibling.identifier);
    expect(identifiers).toContain(child.identifier);
    expect(identifiers).toContain(blocker.identifier);
    expect(identifiers).toContain(dependent.identifier);
    expect(identifiers).toContain(milestone.identifier);
  });

  it('follows the dependency chain as far as the reader asks', async () => {
    const focus = await make('The focus');
    const first = await make('First blocker');
    const second = await make('Second blocker');
    await createWorkLink(prisma, { fromId: first.id, toId: focus.id, type: 'BLOCKS' });
    await createWorkLink(prisma, { fromId: second.id, toId: first.id, type: 'BLOCKS' });

    const oneStep = await postGraphQL({ query: ISSUE_GRAPH_QUERY, variables: { id: focus.identifier, depth: 1 } });
    expectGraphQLSuccess(oneStep);
    const oneStepIds = oneStep.body.data.issueGraph.nodes.map((node: { identifier: string }) => node.identifier);
    expect(oneStepIds).toContain(first.identifier);
    expect(oneStepIds).not.toContain(second.identifier);

    const twoSteps = await postGraphQL({ query: ISSUE_GRAPH_QUERY, variables: { id: focus.identifier, depth: 2 } });
    expectGraphQLSuccess(twoSteps);
    const twoStepIds = twoSteps.body.data.issueGraph.nodes.map((node: { identifier: string }) => node.identifier);
    expect(twoStepIds).toContain(second.identifier);
  });

  it('rolls the nearest milestone and epic up by state category', async () => {
    const milestone = await make('M1', { kind: 'MILESTONE' });
    const epic = await make('E1', { kind: 'EPIC' });
    const finished = await make('Finished', { stateId: done.id });
    const running = await make('Running', { stateId: started.id });
    const waiting = await make('Waiting');
    const blocker = await make('Blocker', { stateId: started.id });

    await createWorkLink(prisma, { fromId: milestone.id, toId: epic.id, type: 'CONTAINS' });
    await createWorkLink(prisma, { fromId: epic.id, toId: finished.id, type: 'CONTAINS' });
    await createWorkLink(prisma, { fromId: epic.id, toId: running.id, type: 'CONTAINS' });
    await createWorkLink(prisma, { fromId: epic.id, toId: waiting.id, type: 'CONTAINS' });
    await createWorkLink(prisma, { fromId: blocker.id, toId: waiting.id, type: 'BLOCKS' });

    const response = await postGraphQL({
      query: ISSUE_GRAPH_QUERY,
      variables: { id: waiting.identifier, depth: 1 },
    });
    expectGraphQLSuccess(response);
    const rollups = response.body.data.issueGraph.rollups as Array<{
      identifier: string;
      kind: string;
      total: number;
      completed: number;
      inProgress: number;
      blocked: number;
    }>;

    // Nearest ancestor first.
    expect(rollups[0].identifier).toBe(epic.identifier);
    expect(rollups[0].kind).toBe('EPIC');
    expect(rollups[0].total).toBe(3);
    expect(rollups[0].completed).toBe(1);
    expect(rollups[0].inProgress).toBe(1);
    // The one item waiting on an unfinished blocker.
    expect(rollups[0].blocked).toBe(1);

    expect(rollups[1].identifier).toBe(milestone.identifier);
    // The epic is a container, not a piece of work: three leaves either way.
    expect(rollups[1].total).toBe(3);
  });

  it('shows nothing the reader may not read', async () => {
    const otherTeam = await prisma.team.create({ data: { key: 'OTHER', name: 'Other team' } });
    const otherReady = await prisma.workflowState.create({
      data: { teamId: otherTeam.id, name: 'Ready', type: 'UNSTARTED', position: 0 },
    });
    const focus = await make('The focus');
    const foreign = await prisma.issue.create({
      data: {
        identifier: 'INV-9001',
        title: 'Someone else’s work',
        teamId: otherTeam.id,
        stateId: otherReady.id,
        repository: 'acme/app',
      },
    });
    // The service refuses a link that crosses teams; the row is written
    // directly so the read filter is tested against a neighbour that exists
    // but may not be shown.
    await prisma.workLink.create({
      data: { type: 'BLOCKS', fromId: foreign.id, toId: focus.id },
    });

    // The loader is given the readable scope a reader of this team has.
    const graph = await loadIssueWorkGraph(prisma, { id: focus.id, depth: 1 }, { teamId: team.id });
    expect(graph.nodes.map((node) => node.identifier)).not.toContain(foreign.identifier);
    // The edge goes with it: an edge is only drawn when both ends are shown.
    expect(graph.edges.some((edge) => edge.fromId === foreign.id || edge.toId === foreign.id)).toBe(false);

    // And the same neighbourhood, read by someone who may see both teams.
    const wide = await loadIssueWorkGraph(prisma, { id: focus.id, depth: 1 }, undefined);
    expect(wide.nodes.map((node) => node.identifier)).toContain(foreign.identifier);
  });

  it('refuses an item that does not exist', async () => {
    const response = await postGraphQL({
      query: ISSUE_GRAPH_QUERY,
      variables: { id: 'INV-99999', depth: 1 },
    });
    expect(response.body.errors).toBeDefined();
  });
});

async function resetDatabase(prismaClient: PrismaClient): Promise<void> {
  await prismaClient.comment.deleteMany();
  await prismaClient.issue.deleteMany();
  await prismaClient.workflowState.deleteMany();
  await prismaClient.team.deleteMany();
  await prismaClient.issueLabel.deleteMany();
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
