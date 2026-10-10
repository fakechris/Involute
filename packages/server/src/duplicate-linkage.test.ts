import type { Team, User, WorkflowState } from '@prisma/client';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ADMIN_EMAIL, DEFAULT_TEAM_KEY, resetAndSeed } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import { loadBugSlas } from './bug-sla.ts';
import { proposeWork } from './claim-service.ts';
import { linkWork } from './duplicate-linkage.ts';
import { createIssue, updateIssue } from './issue-service.ts';
import { deleteWorkLink } from './link-service.ts';

loadProjectEnvironment();
const prisma = new PrismaClient();
const DESCRIPTION = '### 1. 目标与架构定位\nx\n### 2. 核心功能与交付范围\ny\n### 3. 验收标准与验证方案\nz';

describe('DUPLICATE_OF closes the duplicate and keeps its reporter informed (INV-1124)', () => {
  let team: Team;
  let admin: User;
  let agent: User;
  let projectId: string;
  let canceled: WorkflowState;
  let started: WorkflowState;
  const asHuman = () => ({ actorId: admin.id, actorKind: 'HUMAN' as const, surface: 'graphql' as const });
  const asAgent = () => ({ actorId: agent.id, actorKind: 'AGENT' as const, surface: 'mcp' as const });

  beforeEach(async () => {
    await resetAndSeed(prisma);
    team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
    admin = await prisma.user.findUniqueOrThrow({ where: { email: DEFAULT_ADMIN_EMAIL } });
    agent = await prisma.user.create({ data: { email: 'bot@agents.local', name: 'Bot', actorKind: 'AGENT', ownerId: admin.id } });
    projectId = (await createIssue(prisma, { teamId: team.id, kind: 'PROJECT', title: 'acme/app', repository: 'acme/app' })).id;
    canceled = await prisma.workflowState.findFirstOrThrow({ where: { teamId: team.id, type: 'CANCELED' } });
    started = await prisma.workflowState.findFirstOrThrow({ where: { teamId: team.id, type: 'STARTED' } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  const agentBug = (title: string) =>
    proposeWork(prisma, { teamId: team.id, title, description: DESCRIPTION, labels: ['bug'], acceptance: 'No crash.', parentId: projectId, priority: 2, stepsToReproduce: 'Save' }, asAgent());
  const comments = async (workId: string) => (await prisma.comment.findMany({ where: { issueId: workId }, orderBy: { createdAt: 'asc' } })).map((comment) => comment.body);
  const notifications = (type: string, userId: string) => prisma.notification.findMany({ where: { type, userId } });

  it('a person marking it closes the duplicate with resolution duplicate, stops its SLA and notes both items', async () => {
    const original = await agentBug('Crash on save');
    const duplicate = await agentBug('Saving crashes');

    const { duplicate: outcome } = await linkWork(prisma, { actor: asHuman(), fromId: duplicate.id, toId: original.id, type: 'DUPLICATE_OF' });
    expect(outcome).toMatchObject({ closed: true });

    const closed = await prisma.issue.findUniqueOrThrow({ where: { id: duplicate.id } });
    expect(closed).toMatchObject({ stateId: canceled.id, resolution: 'DUPLICATE' });
    const sla = (await loadBugSlas(prisma, [duplicate.id])).get(duplicate.id);
    expect(sla?.status).toBe('MET');
    expect(sla?.dueAt).toBeNull();

    expect(await comments(duplicate.id)).toEqual([expect.stringContaining(`Closed as a duplicate of ${original.identifier}`)]);
    expect(await comments(original.id)).toEqual([`${duplicate.identifier} was marked as a duplicate of this item and closed.`]);
    // The reporter (the filing agent) hears it; the person who did it does not.
    expect(await notifications('duplicate.marked', agent.id)).toHaveLength(1);
    expect(await notifications('duplicate.marked', admin.id)).toHaveLength(0);
  });

  it('an agent marking it only links and notes: the duplicate stays open and its owner is asked to decline it', async () => {
    const original = await agentBug('Crash on save');
    const duplicate = await agentBug('Saving crashes');

    const { duplicate: outcome } = await linkWork(prisma, { actor: asAgent(), fromId: duplicate.id, toId: original.id, type: 'DUPLICATE_OF' });
    expect(outcome).toMatchObject({ closed: false });
    expect(outcome?.note).toMatch(/stays open until a person declines it/);

    const still = await prisma.issue.findUniqueOrThrow({ where: { id: duplicate.id } });
    expect(still.stateId).not.toBe(canceled.id);
    expect(still.resolution).toBeNull();
    expect(await comments(duplicate.id)).toHaveLength(1);
    expect(await comments(original.id)).toEqual([`${duplicate.identifier} was marked as a duplicate of this item.`]);
    const toOwner = await notifications('duplicate.marked', admin.id);
    expect(toOwner).toHaveLength(1);
    expect(toOwner[0]?.payload).toMatchObject({ closed: false, originalIdentifier: original.identifier });
  });

  it('a person marking a candidate declines it; its proposer hears through work.rejected only', async () => {
    const original = await agentBug('Crash on save');
    const candidate = await proposeWork(prisma, { teamId: team.id, title: 'Same idea', description: DESCRIPTION, parentId: projectId, repository: 'acme/app' }, asAgent());

    const { duplicate: outcome } = await linkWork(prisma, { actor: asHuman(), fromId: candidate.id, toId: original.id, type: 'DUPLICATE_OF' });
    expect(outcome?.closed).toBe(true);
    expect(await prisma.issue.findUniqueOrThrow({ where: { id: candidate.id } })).toMatchObject({ commitmentStatus: 'REJECTED', resolution: 'DUPLICATE' });
    expect(await notifications('work.rejected', agent.id)).toHaveLength(1);
    expect(await notifications('duplicate.marked', agent.id)).toHaveLength(0);
  });

  it('an existing link is not applied twice, and already-closed work is left as it is', async () => {
    const original = await agentBug('Crash on save');
    const duplicate = await agentBug('Saving crashes');
    await updateIssue(prisma, duplicate.id, { stateId: canceled.id, resolution: 'INVALID', reason: 'Not a bug' }, asHuman());

    const first = await linkWork(prisma, { actor: asHuman(), fromId: duplicate.id, toId: original.id, type: 'DUPLICATE_OF' });
    expect(first.duplicate).toMatchObject({ closed: false });
    expect((await prisma.issue.findUniqueOrThrow({ where: { id: duplicate.id } })).resolution).toBe('INVALID');
    const again = await linkWork(prisma, { actor: asHuman(), fromId: duplicate.id, toId: original.id, type: 'DUPLICATE_OF' });
    expect(again.duplicate).toBeNull();
    expect(await comments(duplicate.id)).toHaveLength(1);
  });

  it("tells the duplicate's reporter when the original changes state, from any surface", async () => {
    const original = await agentBug('Crash on save');
    const duplicate = await agentBug('Saving crashes');
    await linkWork(prisma, { actor: asHuman(), fromId: duplicate.id, toId: original.id, type: 'DUPLICATE_OF' });

    await updateIssue(prisma, original.id, { stateId: started.id }, asHuman());
    const told = await notifications('duplicate.original_changed', agent.id);
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({ workId: original.id });
    expect(told[0]?.payload).toMatchObject({ duplicates: [duplicate.identifier], stateName: started.name, stateType: 'STARTED' });
    // The person who moved it is never told about their own change.
    expect(await notifications('duplicate.original_changed', admin.id)).toHaveLength(0);

    // A change that is not a state change says nothing.
    await updateIssue(prisma, original.id, { title: 'Crash on save (renamed)' }, asHuman());
    expect(await notifications('duplicate.original_changed', agent.id)).toHaveLength(1);
  });

  it('removing the link does not reopen the duplicate, it only notes it', async () => {
    const original = await agentBug('Crash on save');
    const duplicate = await agentBug('Saving crashes');
    const { link } = await linkWork(prisma, { actor: asHuman(), fromId: duplicate.id, toId: original.id, type: 'DUPLICATE_OF' });

    const removed = await deleteWorkLink(prisma, link.id, asHuman());
    expect(removed.note).toMatch(/does not reopen/);
    expect((await prisma.issue.findUniqueOrThrow({ where: { id: duplicate.id } })).stateId).toBe(canceled.id);
    expect((await comments(duplicate.id)).at(-1)).toMatch(`No longer marked as a duplicate of ${original.identifier}`);
  });

  it('a proposal filed as a duplicate gets the same rule: an agent proposal stays a candidate', async () => {
    const original = await agentBug('Crash on save');
    const proposed = await proposeWork(prisma, {
      teamId: team.id, title: 'Crash again', description: DESCRIPTION, parentId: projectId, repository: 'acme/app',
      relatedWorkId: original.id, relatedWorkType: 'DUPLICATE_OF',
    }, asAgent());
    expect(proposed.commitmentStatus).toBe('CANDIDATE');
    expect(await prisma.workLink.count({ where: { fromId: proposed.id, toId: original.id, type: 'DUPLICATE_OF' } })).toBe(1);
    expect(await comments(original.id)).toEqual([`${proposed.identifier} was marked as a duplicate of this item.`]);

    const byPerson = await proposeWork(prisma, {
      teamId: team.id, title: 'Crash once more', parentId: projectId, repository: 'acme/app',
      relatedWorkId: original.id, relatedWorkType: 'DUPLICATE_OF',
    }, asHuman());
    expect(byPerson).toMatchObject({ commitmentStatus: 'REJECTED', resolution: 'DUPLICATE' });
  });
});
