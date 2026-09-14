import { PrismaClient, type Issue, type Team, type User, type WorkflowState } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedDatabase, DEFAULT_ADMIN_EMAIL, DEFAULT_TEAM_KEY } from '../prisma/seed-helpers.ts';
import { listReadyWork } from './context-service.ts';
import { createWorkLink } from './link-service.ts';

const prisma = new PrismaClient();
let team: Team;
let owner: User;
let ready: WorkflowState;
let sequence = 0;

async function work(data: Partial<Issue> = {}) {
  sequence += 1;
  return prisma.issue.create({ data: {
    identifier: `SCOPE-${sequence}`, title: 'Scope fixture', teamId: team.id,
    stateId: ready.id, assigneeId: owner.id, acceptance: 'reviewed contract',
    repository: 'test/project', ...data,
  } });
}

const ids = (result: Awaited<ReturnType<typeof listReadyWork>>) => result.nodes.map(node => node.id);

describe('Ready project scope', () => {
  beforeAll(async () => { await prisma.$connect(); });
  afterAll(async () => { await prisma.$disconnect(); });
  beforeEach(async () => {
    await prisma.comment.deleteMany();
    await prisma.issue.deleteMany();
    await prisma.project.deleteMany();
    await prisma.workflowState.deleteMany();
    await prisma.team.deleteMany();
    await prisma.issueLabel.deleteMany();
    await prisma.user.deleteMany();
    await prisma.legacyLinearMapping.deleteMany();
    await seedDatabase(prisma);
    team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
    owner = await prisma.user.findUniqueOrThrow({ where: { email: DEFAULT_ADMIN_EMAIL } });
    ready = await prisma.workflowState.findFirstOrThrow({ where: { teamId: team.id, type: 'UNSTARTED' } });
    sequence = 0;
  });

  it('returns the same ordered prefix and hasNextPage for repository, root UUID and identifier', async () => {
    const root = await work({ kind: 'PROJECT' });
    await work({ priority: 1 });
    await work({ priority: 2 });
    await work({ priority: 1, repository: 'other/project' });
    const baseline = await listReadyWork(prisma, { repository: root.repository, first: 2 });
    expect(baseline.nodes).toHaveLength(2);
    expect(baseline.hasNextPage).toBe(true);
    for (const projectId of [root.id, root.identifier]) {
      const result = await listReadyWork(prisma, { projectId, first: 2 });
      expect(ids(result)).toEqual(ids(baseline));
      expect(result.hasNextPage).toBe(baseline.hasNextPage);
    }
    expect(ids(await listReadyWork(prisma, { projectId: root.id }))).toContain(root.id);
    expect(ids(await listReadyWork(prisma, { projectId: root.id, kind: 'ISSUE' }))).not.toContain(root.id);
  });

  it('preserves the explicit legacy Project UUID filter', async () => {
    const legacy = await prisma.project.create({ data: { name: 'Legacy', teamId: team.id } });
    const included = await work({ projectId: legacy.id });
    await work();
    expect(ids(await listReadyWork(prisma, { projectId: legacy.id }))).toEqual([included.id]);
  });

  it('uses a repository-less root subtree, including legacy parentId edges, without looping', async () => {
    const root = await work({ kind: 'PROJECT', repository: null });
    const milestone = await work({ kind: 'MILESTONE', repository: null, parentId: root.id });
    const leaf = await work({ repository: null });
    await createWorkLink(prisma, { fromId: milestone.id, toId: leaf.id, type: 'CONTAINS' });
    await prisma.workLink.create({ data: { fromId: leaf.id, toId: root.id, type: 'CONTAINS' } });
    const unrelated = await work({ repository: null });
    const result = ids(await listReadyWork(prisma, { projectId: root.identifier }));
    expect(result.sort()).toEqual([root.id, milestone.id, leaf.id].sort());
    expect(result).not.toContain(unrelated.id);
  });

  it('keeps claim, blocker and commitment predicates under the resolved scope', async () => {
    const root = await work({ kind: 'PROJECT' });
    const claimed = await work();
    await prisma.workClaim.create({ data: { workId: claimed.id, actorId: owner.id, leaseUntil: new Date(Date.now() + 60_000) } });
    const blocked = await work();
    await createWorkLink(prisma, { fromId: root.id, toId: blocked.id, type: 'BLOCKS' });
    const candidate = await work({ commitmentStatus: 'CANDIDATE' });
    const included = await work();
    const result = ids(await listReadyWork(prisma, { projectId: root.id, kind: 'ISSUE' }));
    expect(result).toEqual([included.id]);
    for (const excluded of [claimed, blocked, candidate]) expect(result).not.toContain(excluded.id);
  });

  it('fails closed for unknown IDs, non-project work and conflicting repository selectors', async () => {
    const root = await work({ kind: 'PROJECT' });
    const issue = await work();
    for (const projectId of ['', '  ', 'NO-SUCH-PROJECT', '00000000-0000-0000-0000-000000000001', issue.id]) {
      await expect(listReadyWork(prisma, { projectId })).rejects.toThrow('Project scope not found');
    }
    await expect(listReadyWork(prisma, { projectId: root.id, repository: 'wrong/repo' }))
      .rejects.toThrow('Project selectors conflict');
  });

  it('prefers a committed root but rejects two committed declarations of the same repository', async () => {
    const root = await work({ kind: 'PROJECT' });
    const candidate = await work({ kind: 'PROJECT', commitmentStatus: 'CANDIDATE' });
    expect(ids(await listReadyWork(prisma, { repository: root.repository }))).toContain(root.id);
    await expect(listReadyWork(prisma, { projectId: candidate.id })).rejects.toThrow('Project selectors conflict');
    await work({ kind: 'PROJECT' });
    await expect(listReadyWork(prisma, { repository: root.repository })).rejects.toThrow('Project scope is ambiguous');
    await expect(listReadyWork(prisma, { projectId: root.id })).rejects.toThrow('Project scope is ambiguous');
  });

  it('does not resolve an inaccessible graph root or expand beyond readable/team filters', async () => {
    const root = await work({ kind: 'PROJECT' });
    const leaf = await work();
    await expect(listReadyWork(prisma, { projectId: root.id }, { id: leaf.id }))
      .rejects.toThrow('Project scope not found');
    await expect(listReadyWork(prisma, { projectId: root.id, teamKey: 'UNKNOWN' }))
      .rejects.toThrow('Project scope not found');
    expect(ids(await listReadyWork(prisma, { repository: root.repository }, { id: leaf.id }))).toEqual([leaf.id]);
  });

  it('intersects a repository filter with an explicitly selected repository-less subtree', async () => {
    const root = await work({ kind: 'PROJECT', repository: null });
    const included = await work({ parentId: root.id });
    const excluded = await work({ parentId: root.id, repository: 'other/project' });
    await work({ kind: 'PROJECT' });
    await work({ kind: 'PROJECT' });
    const result = ids(await listReadyWork(prisma, { projectId: root.id, repository: included.repository }));
    expect(result).toEqual([included.id]);
    expect(result).not.toContain(excluded.id);
  });

  it('applies readable team scope to legacy projects and repository declarations', async () => {
    const otherTeam = await prisma.team.create({ data: { key: 'PRIVATE', name: 'Private' } });
    const privateReady = await prisma.workflowState.create({ data: {
      teamId: otherTeam.id, name: 'Ready', type: 'UNSTARTED',
    } });
    const privateProject = await prisma.project.create({ data: { name: 'Private', teamId: otherTeam.id } });
    await work({ teamId: otherTeam.id, stateId: privateReady.id, projectId: privateProject.id });
    const publicRoot = await work({ kind: 'PROJECT' });
    const visibility = { team: { id: team.id } };
    await expect(listReadyWork(prisma, { projectId: privateProject.id }, visibility))
      .rejects.toThrow('Project scope not found');
    expect(ids(await listReadyWork(prisma, { repository: publicRoot.repository }, visibility)))
      .toEqual([publicRoot.id]);
  });

  it('preserves repository-only queries when no graph project declares that repository', async () => {
    const leaf = await work();
    expect(ids(await listReadyWork(prisma, { repository: leaf.repository }))).toEqual([leaf.id]);
  });
});
