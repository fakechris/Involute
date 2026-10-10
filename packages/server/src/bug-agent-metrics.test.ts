import type { Team, User } from '@prisma/client';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ADMIN_EMAIL, DEFAULT_TEAM_KEY, resetAndSeed } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import { loadBugMetrics, percentile } from './bug-metrics.ts';
import { reportBug } from './bug-report.ts';
import { commitWork, proposeWork, rejectWork } from './claim-service.ts';
import { createIssue, updateIssue } from './issue-service.ts';

loadProjectEnvironment();
const prisma = new PrismaClient();
const HOUR = 3_600_000;
const DESCRIPTION = '### 1. 目标与架构定位\nx\n### 2. 核心功能与交付范围\ny\n### 3. 验收标准与验证方案\nz';

describe('agent-filed bugs and bug metrics (INV-751 / INV-787)', () => {
  let team: Team;
  let admin: User;
  let agent: User;
  let projectId: string;
  const asAgent = () => ({ actorId: agent.id, actorKind: 'AGENT' as const, surface: 'mcp' as const });
  const asHuman = () => ({ actorId: admin.id, actorKind: 'HUMAN' as const, surface: 'graphql' as const });

  beforeEach(async () => {
    await resetAndSeed(prisma);
    team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
    admin = await prisma.user.findUniqueOrThrow({ where: { email: DEFAULT_ADMIN_EMAIL } });
    agent = await prisma.user.create({ data: { email: 'bot@agents.local', name: 'Bot', actorKind: 'AGENT', ownerId: admin.id } });
    projectId = (await createIssue(prisma, { teamId: team.id, kind: 'PROJECT', title: 'acme/app', repository: 'acme/app' })).id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  const fileBug = (extra: Record<string, unknown> = {}) =>
    proposeWork(prisma, { teamId: team.id, title: 'Crash on save', description: DESCRIPTION, labels: ['bug'], acceptance: 'Saving no longer crashes.', ...extra }, asAgent());

  it('commits an agent bug with a parent, priority and steps at once, owned by the agent\'s human', async () => {
    const bug = await fileBug({ parentId: projectId, priority: 2, stepsToReproduce: '1. Save\n2. Crash', initialState: 'BACKLOG' });
    const state = await prisma.workflowState.findUniqueOrThrow({ where: { id: bug.stateId } });
    expect(bug).toMatchObject({ commitmentStatus: 'COMMITTED', priority: 2, assigneeId: admin.id, parentId: projectId, repository: 'acme/app' });
    expect(state.type).toBe('UNSTARTED'); // never the backlog
    expect(bug.description).toContain('### Steps to reproduce\n\n1. Save\n2. Crash');
    const events = await prisma.eventOutbox.findMany({ where: { payload: { path: ['work', 'id'], equals: bug.id } }, orderBy: { createdAt: 'asc' } });
    expect(events.map((event) => event.type).sort()).toEqual(['bug.reported', 'work.committed']);
    const reported = events.find((event) => event.type === 'bug.reported')!.payload as { data: { triage: boolean } };
    expect(reported.data.triage).toBe(false);
  });

  it('counts an inherited parent and honours initial_state REVIEW for a bug fixed on the spot', async () => {
    const task = await createIssue(prisma, { teamId: team.id, title: 'Task', repository: 'acme/app', parentId: projectId });
    const bug = await fileBug({ relatedWorkId: task.id, relatedWorkType: 'DISCOVERED_DURING', priority: 3, stepsToReproduce: 'x', initialState: 'REVIEW' });
    const state = await prisma.workflowState.findUniqueOrThrow({ where: { id: bug.stateId } });
    expect(bug.commitmentStatus).toBe('COMMITTED');
    expect(bug.parentId).toBe(projectId);
    expect(state.type).toBe('REVIEW');
  });

  it('commits an agent bug directly, and refuses one that cannot be committed (it does not go to Candidates)', async () => {
    await expect(fileBug({ parentId: projectId, stepsToReproduce: 'x' })).rejects.toThrow(/Proposing a bug needs a priority/);
    await expect(fileBug({ parentId: projectId, priority: 1 })).rejects.toThrow(/does not go to Candidates/);
    await expect(fileBug({ priority: 1, stepsToReproduce: 'x' })).rejects.toThrow(/does not go to Candidates/);
    await expect(fileBug({ parentId: projectId, priority: 9, stepsToReproduce: 'x' })).rejects.toThrow(/needs a priority/);
    // Committed on filing and agents cannot add acceptance later, so it is required here (INV-836).
    await expect(fileBug({ parentId: projectId, priority: 2, stepsToReproduce: 'x', acceptance: '  ' })).rejects.toThrow(/needs acceptance/);
    await prisma.teamMembership.deleteMany({ where: { teamId: team.id, userId: admin.id } });
    await expect(fileBug({ parentId: projectId, priority: 1, stepsToReproduce: 'x' })).rejects.toThrow(/human owner on this team/);
    await prisma.teamMembership.create({ data: { teamId: team.id, userId: admin.id, role: 'OWNER' } });
    const rejectedParent = await createIssue(prisma, { teamId: team.id, title: 'Dropped', repository: 'acme/app', parentId: projectId });
    await prisma.issue.update({ where: { id: rejectedParent.id }, data: { commitmentStatus: 'REJECTED' } });
    await expect(fileBug({ parentId: rejectedParent.id, priority: 1, stepsToReproduce: 'x' })).rejects.toThrow(/does not go to Candidates/);
    const plain = await proposeWork(prisma, { teamId: team.id, title: 'Idea', description: DESCRIPTION, parentId: projectId, priority: 1, stepsToReproduce: 'x' }, asAgent());
    expect(plain.commitmentStatus).toBe('CANDIDATE');
  });

  it('measures triage time, SLA outcomes, sources and unplaced bugs', async () => {
    const empty = await loadBugMetrics(prisma, { teamId: team.id });
    expect(empty).toMatchObject({ triageHoursP50: null, triagedCount: 0, slaMetRate: null, bySource: [], unplacedOpenCount: 0 });

    // Human report placed directly (no triage), agent bug committed directly, and two triaged candidates.
    await reportBug(prisma, { teamId: team.id, title: 'Human placed', priority: 3, stepsToReproduce: 'x', parentId: projectId }, asHuman());
    const agentBug = await fileBug({ parentId: projectId, priority: 2, stepsToReproduce: 'x' });
    const triaged = await reportBug(prisma, { teamId: team.id, title: 'Human triaged', priority: 3, stepsToReproduce: 'x' }, asHuman());
    const declined = await reportBug(prisma, { teamId: team.id, title: 'Human declined', priority: 3, stepsToReproduce: 'x' }, asHuman());
    await prisma.workAudit.updateMany({ where: { workId: { in: [triaged.id, declined.id] } }, data: { createdAt: new Date(Date.now() - 10 * HOUR) } });
    await commitWork(prisma, triaged.id, { expectedRevision: 1, assigneeId: admin.id, acceptance: 'fixed', parentId: projectId }, asHuman());
    await rejectWork(prisma, declined.id, { expectedRevision: 1, resolution: 'WONT_DO', reason: 'Not a bug' }, asHuman());

    // Close the agent bug in time; leave an unplaced committed bug open.
    const done = await prisma.workflowState.findFirstOrThrow({ where: { teamId: team.id, type: 'COMPLETED' } });
    await updateIssue(prisma, agentBug.id, { stateId: done.id }, asHuman());
    const bugLabel = await prisma.issueLabel.findFirstOrThrow({ where: { name: { equals: 'bug', mode: 'insensitive' } } });
    await createIssue(prisma, { teamId: team.id, title: 'Legacy orphan bug', labelIds: [bugLabel.id], priority: 4 });

    const metrics = await loadBugMetrics(prisma, { teamId: team.id });
    expect(metrics.triagedCount).toBe(2);
    expect(metrics.triageHoursP50).toBeGreaterThanOrEqual(9.9);
    expect(metrics.untriagedCount).toBe(0);
    expect(metrics).toMatchObject({ slaMetCount: 1, slaBreachedClosedCount: 0, slaMetRate: 1, unplacedOpenCount: 1 });
    expect(Object.fromEntries(metrics.bySource.map((entry) => [entry.source, entry.count]))).toEqual({ HUMAN_REPORT: 3, AGENT: 1, OTHER: 1 });
  });

  it('lists open bugs past their SLA, most overdue first', async () => {
    const bug = await reportBug(prisma, { teamId: team.id, title: 'Old urgent', priority: 1, stepsToReproduce: 'x', parentId: projectId }, asHuman());
    await prisma.workAudit.updateMany({ where: { workId: bug.id }, data: { createdAt: new Date(Date.now() - 30 * HOUR) } });
    const metrics = await loadBugMetrics(prisma, { teamId: team.id });
    expect(metrics.breachedOpen).toEqual([expect.objectContaining({ identifier: bug.identifier, overdueHours: expect.any(Number) })]);
    expect(metrics.breachedOpen[0]!.overdueHours).toBeGreaterThanOrEqual(5.9);
  });

  it('takes nearest-rank percentiles', () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
  });
});
