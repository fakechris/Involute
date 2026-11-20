import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { loadProjectEnvironment } from '../prisma/env.ts';
import { DEFAULT_ADMIN_EMAIL, DEFAULT_TEAM_KEY, resetAndSeed } from '../prisma/seed-helpers.ts';
import { loadRegressionMetrics } from './bug-metrics.ts';
import { createIssue, updateIssue } from './issue-service.ts';

loadProjectEnvironment();
const prisma = new PrismaClient();
const now = new Date('2026-10-25T12:00:00Z');
const ago = (days: number) => new Date(now.getTime() - days * 86_400_000);

describe('delivery regressions (INV-752)', () => {
  let teamId: string;
  let doneId: string;
  let adminId: string;
  beforeEach(async () => {
    await resetAndSeed(prisma);
    teamId = (await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } })).id;
    adminId = (await prisma.user.findUniqueOrThrow({ where: { email: DEFAULT_ADMIN_EMAIL } })).id;
    doneId = (await prisma.workflowState.findFirstOrThrow({ where: { teamId, type: 'COMPLETED' } })).id;
  });
  afterAll(() => prisma.$disconnect());

  const deliver = async (title: string, days: number, parentId?: string) => {
    const item = await createIssue(prisma, { teamId, title, parentId });
    await updateIssue(prisma, item.id, { stateId: doneId }, { actorId: adminId, actorKind: 'HUMAN', surface: 'graphql' });
    await prisma.workAudit.updateMany({ where: { workId: item.id }, data: { createdAt: ago(days) } });
    return item;
  };

  it('returns a null rate and empty groups without deliveries', async () => {
    expect(await loadRegressionMetrics(prisma, { teamId }, now)).toEqual({ windowDays: 30, deliveredCount: 0, regressedCount: 0, regressionCount: 0, regressionRate: null, byProject: [], byMilestone: [] });
  });

  it('uses the latest completion rather than creation or an earlier delivery', async () => {
    const item = await deliver('Delivered again', 40);
    const open = await prisma.workflowState.findFirstOrThrow({ where: { teamId, type: 'STARTED' } });
    const actor = { actorId: adminId, actorKind: 'HUMAN' as const, surface: 'graphql' as const };
    await updateIssue(prisma, item.id, { stateId: open.id }, actor);
    await updateIssue(prisma, item.id, { stateId: doneId }, actor);
    await prisma.workAudit.updateMany({ where: { workId: item.id, revision: { gt: 2 } }, data: { createdAt: ago(10) } });
    expect((await loadRegressionMetrics(prisma, { teamId }, now)).deliveredCount).toBe(1);
    expect((await loadRegressionMetrics(prisma, { teamId }, now, 5)).deliveredCount).toBe(0);
  });

  it('uses latest completion, scopes deliveries, deduplicates introducers and groups ancestors', async () => {
    const project = await createIssue(prisma, { teamId, title: 'App', kind: 'PROJECT' });
    const milestone = await createIssue(prisma, { teamId, title: 'Launch', kind: 'MILESTONE', parentId: project.id });
    const epic = await createIssue(prisma, { teamId, title: 'Engine', kind: 'EPIC', parentId: milestone.id });
    const delivered = await deliver('Recent feature', 10, epic.id);
    const fix = await deliver('Bug fix', 10, project.id);
    const bugLabel = await prisma.issueLabel.findFirstOrThrow({ where: { name: { equals: 'bug', mode: 'insensitive' } } });
    await prisma.issue.update({ where: { id: fix.id }, data: { labels: { connect: { id: bugLabel.id } } } });
    await deliver('Old', 40, milestone.id);
    const reopened = await deliver('Reopened', 10, milestone.id);
    const openState = await prisma.workflowState.findFirstOrThrow({ where: { teamId, type: 'STARTED' } });
    await updateIssue(prisma, reopened.id, { stateId: openState.id }, { actorId: adminId, actorKind: 'HUMAN', surface: 'graphql' });
    const superseded = await deliver('Superseded', 10);
    await prisma.issue.update({ where: { id: superseded.id }, data: { supersededById: delivered.id } });
    const candidate = await deliver('Candidate', 10);
    await prisma.issue.update({ where: { id: candidate.id }, data: { commitmentStatus: 'CANDIDATE' } });
    const source1 = await createIssue(prisma, { teamId, title: 'Regression one' });
    const source2 = await createIssue(prisma, { teamId, title: 'Regression two' });
    const rejected = await createIssue(prisma, { teamId, title: 'Rejected report' });
    await prisma.issue.update({ where: { id: rejected.id }, data: { commitmentStatus: 'REJECTED' } });
    await prisma.workLink.createMany({ data: [
      { type: 'REGRESSED_BY', fromId: source1.id, toId: delivered.id },
      { type: 'REGRESSED_BY', fromId: source2.id, toId: delivered.id },
      { type: 'REGRESSED_BY', fromId: rejected.id, toId: fix.id },
    ] });
    const metrics = await loadRegressionMetrics(prisma, { teamId }, now);
    expect(metrics).toMatchObject({ deliveredCount: 2, regressedCount: 1, regressionCount: 2, regressionRate: 0.5 });
    expect(metrics.byProject).toEqual([{ id: project.id, identifier: project.identifier, title: 'App', deliveredCount: 2, regressedCount: 1, regressionRate: 0.5 }]);
    expect(metrics.byMilestone).toEqual([
      { id: milestone.id, identifier: milestone.identifier, title: 'Launch', deliveredCount: 1, regressedCount: 1, regressionRate: 1 },
      { id: null, identifier: null, title: 'No milestone', deliveredCount: 1, regressedCount: 0, regressionRate: 0 },
    ]);
    expect((await loadRegressionMetrics(prisma, { id: fix.id }, now)).deliveredCount).toBe(1);
    expect((await loadRegressionMetrics(prisma, { id: source1.id }, now)).regressionRate).toBeNull();
  });
});
