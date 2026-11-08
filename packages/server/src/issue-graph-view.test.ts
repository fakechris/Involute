import type { PrismaClient, Team, WorkflowState } from '@prisma/client';

import { PrismaClient as PrismaClientConstructor } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_TEAM_KEY, seedDatabase } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import { startServer, type StartedServer } from './index.ts';
import { createWorkLink } from './link-service.ts';
import { loadIssueWorkGraph, ISSUE_GRAPH_NODE_LIMIT } from './issue-graph-view.ts';

loadProjectEnvironment();

const prisma = new PrismaClientConstructor();
const TEST_AUTH_TOKEN = 'test-auth-token';

let server: StartedServer;

const ISSUE_GRAPH_QUERY = `
  query IssueGraph($id: String!, $depth: Int) {
    issueGraph(id: $id, depth: $depth) {
      focus { identifier title }
      truncated
      omitted { siblings children blockers dependents ancestors rollups }
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
    expect(graph.truncated).toBe(false);
    expect(graph.omitted).toEqual({
      siblings: 0,
      children: 0,
      blockers: 0,
      dependents: 0,
      ancestors: 0,
      rollups: 0,
    });
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

  it('stops the dependency walk at work the reader may not see', async () => {
    const otherTeam = await prisma.team.create({ data: { key: 'OTHER', name: 'Other team' } });
    const otherReady = await prisma.workflowState.create({
      data: { teamId: otherTeam.id, name: 'Ready', type: 'UNSTARTED', position: 0 },
    });
    const focus = await make('The focus');
    const foreign = await prisma.issue.create({
      data: {
        identifier: 'INV-9002',
        title: 'Someone else’s blocker',
        teamId: otherTeam.id,
        stateId: otherReady.id,
        repository: 'acme/app',
      },
    });
    const behind = await make('Work behind the hidden blocker');
    // The chain is focus ← hidden ← behind. The reader may not see the middle
    // link, so the walk must not reach past it either.
    await prisma.workLink.create({ data: { type: 'BLOCKS', fromId: foreign.id, toId: focus.id } });
    await prisma.workLink.create({ data: { type: 'BLOCKS', fromId: behind.id, toId: foreign.id } });

    const graph = await loadIssueWorkGraph(prisma, { id: focus.id, depth: 2 }, { teamId: team.id });
    const identifiers = graph.nodes.map((node) => node.identifier);
    expect(identifiers).not.toContain(foreign.identifier);
    // The item behind the hidden one is not shown either: it would be a node
    // with no visible path to the focus.
    expect(identifiers).not.toContain(behind.identifier);
  });

  it('leaves out a dependency path that mixes both directions', async () => {
    const focus = await make('The focus');
    const shared = await make('A blocker that blocks something else too');
    const other = await make('The other thing it blocks');
    await createWorkLink(prisma, { fromId: shared.id, toId: focus.id, type: 'BLOCKS' });
    await createWorkLink(prisma, { fromId: shared.id, toId: other.id, type: 'BLOCKS' });

    const graph = await loadIssueWorkGraph(prisma, { id: focus.id, depth: 2 });
    const identifiers = graph.nodes.map((node) => node.identifier);
    expect(identifiers).toContain(shared.identifier);
    // "other" waits on the same blocker, not on the focus — it is not part of
    // this item's dependency neighbourhood, and the graph draws it that way too.
    expect(identifiers).not.toContain(other.identifier);
  });

  it('counts only committed work in a rollup', async () => {
    const epic = await make('E1', { kind: 'EPIC' });
    const committed = await make('Committed work', { stateId: done.id });
    const candidate = await make('Not agreed to yet', { commitmentStatus: 'CANDIDATE' });
    await createWorkLink(prisma, { fromId: epic.id, toId: committed.id, type: 'CONTAINS' });
    await createWorkLink(prisma, { fromId: epic.id, toId: candidate.id, type: 'CONTAINS' });

    const graph = await loadIssueWorkGraph(prisma, { id: committed.id, depth: 1 });
    const rollup = graph.rollups[0];
    expect(rollup.identifier).toBe(epic.identifier);
    // A candidate is a proposal, not progress; it stays out of the denominator.
    expect(rollup.total).toBe(1);
    expect(rollup.completed).toBe(1);
  });

  it('says so when the neighbourhood is larger than one read shows', async () => {
    const focus = await make('The focus');
    const count = ISSUE_GRAPH_NODE_LIMIT + 1;
    const blockers = await prisma.issue.createMany({
      data: Array.from({ length: count }, (_, index) => ({
        identifier: `INV-${1000 + index}`,
        title: `Blocker ${index}`,
        teamId: team.id,
        stateId: ready.id,
        repository: 'acme/app',
      })),
    });
    expect(blockers.count).toBe(count);
    const blockerRows = await prisma.issue.findMany({
      where: { identifier: { startsWith: 'INV-1' }, teamId: team.id },
      select: { id: true },
    });
    await prisma.workLink.createMany({
      data: blockerRows.map((row) => ({ type: 'BLOCKS' as const, fromId: row.id, toId: focus.id })),
    });

    const graph = await loadIssueWorkGraph(prisma, { id: focus.id, depth: 1 });
    expect(graph.truncated).toBe(true);
    expect(graph.nodes.length).toBeLessThanOrEqual(ISSUE_GRAPH_NODE_LIMIT + 1);
  });

  it('keeps the unfinished, recently updated siblings when there are 81 (INV-1766)', async () => {
    const parent = await make('Parent');
    const focus = await make('The focus');
    await createWorkLink(prisma, { fromId: parent.id, toId: focus.id, type: 'CONTAINS' });
    const open = await placeUnder(parent.id, team.id, Array.from({ length: 80 }, (_, index) => ({
      identifier: `INV-${21000 + index}`,
      title: `Open sibling ${index}`,
      stateId: ready.id,
      updatedAt: new Date(Date.UTC(2026, 0, 1) + index * 60_000),
    })));
    const finished = await make('Finished sibling', { stateId: done.id });
    await createWorkLink(prisma, { fromId: parent.id, toId: finished.id, type: 'CONTAINS' });
    await stamp(finished.id, new Date('2026-08-01T00:00:00.000Z'));

    const graph = await loadIssueWorkGraph(prisma, { id: focus.id, depth: 1 });
    const again = await loadIssueWorkGraph(prisma, { id: focus.id, depth: 1 });
    const ids = graph.nodes.map((node) => node.identifier);
    for (const row of open) expect(ids).toContain(row.identifier);
    expect(ids).not.toContain(finished.identifier);
    expect(graph.omitted.siblings).toBe(1);
    expect(graph.truncated).toBe(true);
    expect(again.nodes.map((node) => node.id).sort()).toEqual(graph.nodes.map((node) => node.id).sort());
  });

  it('breaks a sibling tie by id ascending (INV-1766)', async () => {
    const parent = await make('Parent');
    const focus = await make('The focus');
    await createWorkLink(prisma, { fromId: parent.id, toId: focus.id, type: 'CONTAINS' });
    const tied = await placeUnder(parent.id, team.id, Array.from({ length: 81 }, (_, index) => ({
      identifier: `INV-${22000 + index}`,
      title: `Tied sibling ${index}`,
      stateId: ready.id,
      updatedAt: new Date('2026-03-01T00:00:00.000Z'),
    })));

    const graph = await loadIssueWorkGraph(prisma, { id: focus.id, depth: 1 });
    const kept = new Set(graph.nodes.map((node) => node.id));
    const dropped = tied.filter((row) => !kept.has(row.id));
    const largestId = [...tied].sort((a, b) => (a.id < b.id ? 1 : -1))[0]!;
    expect(dropped.map((row) => row.id)).toEqual([largestId.id]);
    expect(graph.omitted.siblings).toBe(1);
  });

  it('keeps unfinished children ahead of a newer canceled one when there are 121 (INV-1766)', async () => {
    const focus = await make('The focus');
    const canceled = await prisma.workflowState.findFirstOrThrow({ where: { teamId: team.id, type: 'CANCELED' } });
    const open = await placeUnder(focus.id, team.id, Array.from({ length: 120 }, (_, index) => ({
      identifier: `INV-${23000 + index}`,
      title: `Open child ${index}`,
      stateId: ready.id,
      updatedAt: new Date(Date.UTC(2026, 0, 2) + index * 60_000),
    })));
    const dropped = await make('Canceled child', { stateId: canceled.id });
    await createWorkLink(prisma, { fromId: focus.id, toId: dropped.id, type: 'CONTAINS' });
    await stamp(dropped.id, new Date('2026-09-01T00:00:00.000Z'));

    const graph = await loadIssueWorkGraph(prisma, { id: focus.id, depth: 1 });
    const ids = graph.nodes.map((node) => node.identifier);
    for (const row of open) expect(ids).toContain(row.identifier);
    expect(ids).not.toContain(dropped.identifier);
    expect(graph.omitted.children).toBe(1);
    expect(graph.truncated).toBe(true);
  });

  it('keeps dependents when the blockers alone would fill the read (INV-1766)', async () => {
    const focus = await make('The focus');
    const openCount = 400;
    await prisma.issue.createMany({
      data: Array.from({ length: openCount }, (_, index) => ({
        identifier: `INV-${30000 + index}`,
        title: `Open blocker ${index}`,
        teamId: team.id,
        stateId: ready.id,
        repository: 'acme/app',
        updatedAt: new Date(Date.UTC(2026, 0, 1) + index * 1000),
      })),
    });
    await stampByTitle('Open blocker %', team.id);
    const openBlockers = await prisma.issue.findMany({
      where: { title: { startsWith: 'Open blocker ' }, teamId: team.id },
      select: { id: true, title: true },
    });
    expect(openBlockers).toHaveLength(openCount);
    const finished = await make('Finished blocker', { stateId: done.id });
    await stamp(finished.id, new Date('2026-12-01T00:00:00.000Z'));
    const dependents = [];
    for (let index = 0; index < 5; index += 1) dependents.push(await make(`Dependent ${index}`));
    await prisma.workLink.createMany({
      data: [
        ...openBlockers.map((row) => ({ type: 'BLOCKS' as const, fromId: row.id, toId: focus.id })),
        { type: 'BLOCKS' as const, fromId: finished.id, toId: focus.id },
        ...dependents.map((row) => ({ type: 'BLOCKS' as const, fromId: focus.id, toId: row.id })),
      ],
    });

    const graph = await loadIssueWorkGraph(prisma, { id: focus.id, depth: 1 });
    const again = await loadIssueWorkGraph(prisma, { id: focus.id, depth: 1 });
    const titles = new Set(graph.nodes.map((node) => node.title));
    for (let index = 0; index < 5; index += 1) expect(titles.has(`Open blocker ${index}`)).toBe(false);
    for (let index = 5; index < openCount; index += 1) expect(titles.has(`Open blocker ${index}`)).toBe(true);
    for (const row of dependents) expect(titles.has(row.title)).toBe(true);
    expect(titles.has(finished.title)).toBe(false);
    expect(graph.omitted.blockers).toBe(6);
    expect(graph.omitted.dependents).toBe(0);
    expect(graph.truncated).toBe(true);
    expect(again.nodes.map((node) => node.id).sort()).toEqual(graph.nodes.map((node) => node.id).sort());
  });

  it('does not call an unreadable ancestor a truncation, and does call the 17th one (INV-1766)', async () => {
    const otherTeam = await prisma.team.create({ data: { key: 'HIDDEN', name: 'Hidden team' } });
    const otherReady = await prisma.workflowState.create({
      data: { teamId: otherTeam.id, name: 'Ready', type: 'UNSTARTED', position: 0 },
    });
    const visibleGrandparent = await make('Visible grandparent');
    const hidden = await prisma.issue.create({
      data: {
        identifier: 'INV-9100',
        title: 'Hidden parent',
        teamId: otherTeam.id,
        stateId: otherReady.id,
        repository: 'acme/app',
        parentId: visibleGrandparent.id,
      },
    });
    const hiddenFocus = await make('Focus under a hidden parent');
    await prisma.issue.update({ where: { id: hiddenFocus.id }, data: { parentId: hidden.id } });

    const hiddenGraph = await loadIssueWorkGraph(prisma, { id: hiddenFocus.id, depth: 1 }, { teamId: team.id });
    expect(hiddenGraph.ancestors.map((node) => node.identifier)).not.toContain(visibleGrandparent.identifier);
    expect(hiddenGraph.omitted.ancestors).toBe(0);
    expect(hiddenGraph.truncated).toBe(false);

    const deepFocus = await make('Deep focus');
    let child = deepFocus;
    const levels = [];
    for (let index = 0; index < 17; index += 1) {
      const parent = await make(`Level ${index}`);
      await createWorkLink(prisma, { fromId: parent.id, toId: child.id, type: 'CONTAINS' });
      levels.push(parent);
      child = parent;
    }
    const deep = await loadIssueWorkGraph(prisma, { id: deepFocus.id });
    expect(deep.ancestors).toHaveLength(16);
    expect(deep.ancestors.map((node) => node.identifier)).not.toContain(levels[16]!.identifier);
    expect(deep.ancestors[0]?.identifier).toBe(levels[15]!.identifier);
    expect(deep.ancestors[15]?.identifier).toBe(levels[0]!.identifier);
    expect(deep.omitted.ancestors).toBe(1);
    expect(deep.truncated).toBe(true);
  });

  it('counts a milestone past the three nearest rollups without changing the leaf totals (INV-1766)', async () => {
    const leaf = await make('Leaf', { stateId: done.id });
    let child = leaf;
    const milestones = [];
    for (let index = 0; index < 4; index += 1) {
      const parent = await make(`Rollup milestone ${index}`, { kind: 'MILESTONE' });
      // Written directly: a legal CONTAINS chain cannot hold four milestones,
      // and this test is about the read cap, not the link rule.
      await prisma.issue.update({ where: { id: child.id }, data: { parentId: parent.id } });
      await prisma.workLink.create({ data: { type: 'CONTAINS', fromId: parent.id, toId: child.id } });
      milestones.push(parent);
      child = parent;
    }
    const graph = await loadIssueWorkGraph(prisma, { id: leaf.id, depth: 1 });
    expect(graph.rollups.map((rollup) => rollup.identifier)).toEqual([
      milestones[0]!.identifier,
      milestones[1]!.identifier,
      milestones[2]!.identifier,
    ]);
    expect(graph.omitted.rollups).toBe(1);
    expect(graph.truncated).toBe(true);
    expect(graph.rollups[0]?.total).toBe(1);
    expect(graph.rollups[0]?.completed).toBe(1);
  });

  it('refuses an item that does not exist', async () => {
    const response = await postGraphQL({
      query: ISSUE_GRAPH_QUERY,
      variables: { id: 'INV-99999', depth: 1 },
    });
    expect(response.body.errors).toBeDefined();
  });
});

async function stamp(id: string, updatedAt: Date): Promise<void> {
  await prisma.$executeRaw`UPDATE "Issue" SET "updatedAt" = ${updatedAt} WHERE id = ${id}::uuid`;
}

/** Children under one parent, with the given updatedAt kept exactly. */
async function placeUnder(
  parentId: string,
  teamId: string,
  rows: Array<{ identifier: string; title: string; stateId: string; updatedAt: Date }>,
): Promise<Array<{ id: string; identifier: string; title: string }>> {
  await prisma.issue.createMany({
    data: rows.map((row) => ({
      identifier: row.identifier,
      title: row.title,
      stateId: row.stateId,
      teamId,
      repository: 'acme/app',
      parentId,
      updatedAt: row.updatedAt,
    })),
  });
  const created = await prisma.issue.findMany({
    where: { identifier: { in: rows.map((row) => row.identifier) } },
    select: { id: true, identifier: true, title: true },
  });
  await prisma.workLink.createMany({
    data: created.map((row) => ({ type: 'CONTAINS' as const, fromId: parentId, toId: row.id })),
  });
  const values = rows.flatMap((row) => [row.identifier, row.updatedAt]);
  const tuples = rows.map((_, index) => `($${index * 2 + 1}, $${index * 2 + 2}::timestamptz)`).join(', ');
  await prisma.$executeRawUnsafe(
    `UPDATE "Issue" AS issue SET "updatedAt" = data.updated_at FROM (VALUES ${tuples}) AS data(identifier, updated_at) WHERE issue.identifier = data.identifier`,
    ...values,
  );
  return created;
}

/** Open blocker N gets a later timestamp than open blocker N-1. */
async function stampByTitle(like: string, teamId: string): Promise<void> {
  await prisma.$executeRawUnsafe(
    `UPDATE "Issue" SET "updatedAt" = TIMESTAMP '2026-01-01 00:00:00+00' + (substring(title from '[0-9]+$')::int * INTERVAL '1 second') WHERE title LIKE $1 AND "teamId" = $2::uuid`,
    like,
    teamId,
  );
}

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
