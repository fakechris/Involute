import type { Team, User } from '@prisma/client';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ADMIN_EMAIL, DEFAULT_TEAM_KEY, resetAndSeed } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import { reportBug } from './bug-report.ts';
import { computeBugSla, loadBugSlas, sweepBugSlas } from './bug-sla.ts';
import { currentTriager, setTriageRotation } from './bug-triage.ts';
import { commitWork, proposeWork, rejectWork } from './claim-service.ts';
import { createIssue, updateIssue } from './issue-service.ts';

loadProjectEnvironment();
const prisma = new PrismaClient();
const HOUR = 3_600_000;
const at = (hours: number) => new Date(Date.UTC(2026, 8, 1) + hours * HOUR);
const spell = (hours: number, stateType: 'UNSTARTED' | 'STARTED' | 'REVIEW' | 'COMPLETED') => ({
  at: at(hours),
  stateId: stateType,
  stateName: stateType,
  stateType,
});

describe('bug SLA clock (INV-750)', () => {
  const urgent = { priority: 1, createdAt: at(0) };

  it('runs from commitment while the bug is open', () => {
    const sla = computeBugSla({ committedAt: at(0), transitions: [spell(0, 'UNSTARTED'), spell(2, 'STARTED')] }, { ...urgent, stateType: 'STARTED' }, at(10));
    expect(sla).toMatchObject({ status: 'ON_TRACK', budgetMs: 24 * HOUR, elapsedMs: 10 * HOUR, remainingMs: 14 * HOUR });
    expect(sla.dueAt).toEqual(at(24));
  });

  it('stops in Review, resumes when reopened, and reports at risk and breached', () => {
    const transitions = [spell(0, 'UNSTARTED'), spell(4, 'REVIEW'), spell(30, 'STARTED')];
    const paused = computeBugSla({ committedAt: at(0), transitions: transitions.slice(0, 2) }, { ...urgent, stateType: 'REVIEW' }, at(29));
    expect(paused).toMatchObject({ status: 'PAUSED', elapsedMs: 4 * HOUR, dueAt: null });
    // 4h before review + 16h after reopening = 20h of 24h: 4h left, under 20%.
    expect(computeBugSla({ committedAt: at(0), transitions }, { ...urgent, stateType: 'STARTED' }, at(46))).toMatchObject({ status: 'AT_RISK', elapsedMs: 20 * HOUR });
    expect(computeBugSla({ committedAt: at(0), transitions }, { ...urgent, stateType: 'STARTED' }, at(51))).toMatchObject({ status: 'BREACHED' });
  });

  it('is met when closed in time, and budgets by priority', () => {
    const done = computeBugSla({ committedAt: at(0), transitions: [spell(0, 'UNSTARTED'), spell(30, 'COMPLETED')] }, { priority: 2, createdAt: at(0), stateType: 'COMPLETED' }, at(100));
    expect(done).toMatchObject({ status: 'MET', budgetMs: 48 * HOUR, elapsedMs: 30 * HOUR });
    expect(computeBugSla({ committedAt: null, transitions: [] }, { priority: 4, createdAt: at(0), stateType: 'UNSTARTED' }, at(1)).budgetMs).toBe(7 * 24 * HOUR);
  });

  it('rotates the triager weekly from the start date', () => {
    const rotation = { userIds: ['a', 'b', 'c'], startsAt: at(0).toISOString() };
    expect(currentTriager(rotation, at(1))).toBe('a');
    expect(currentTriager(rotation, at(24 * 7 + 1))).toBe('b');
    expect(currentTriager(rotation, at(24 * 21 + 1))).toBe('a');
    expect(currentTriager(rotation, at(-100))).toBe('a');
    expect(currentTriager(null, at(1))).toBeNull();
  });
});

describe('zero-bug triage (INV-750)', () => {
  let team: Team;
  let admin: User;
  let projectId: string;
  const human = () => ({ actorId: admin.id, actorKind: 'HUMAN' as const, surface: 'graphql' as const });

  beforeEach(async () => {
    await resetAndSeed(prisma);
    team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
    admin = await prisma.user.findUniqueOrThrow({ where: { email: DEFAULT_ADMIN_EMAIL } });
    projectId = (await createIssue(prisma, { teamId: team.id, kind: 'PROJECT', title: 'acme/app', repository: 'acme/app' })).id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  const bugCandidate = (extra: Record<string, unknown> = {}) =>
    proposeWork(prisma, { teamId: team.id, title: 'Crash', labels: ['bug'], parentId: projectId, acceptance: 'No crash', ...extra });

  it('commits a bug only with a priority, and never into the backlog', async () => {
    const bug = await bugCandidate({ initialState: 'BACKLOG' });
    await expect(commitWork(prisma, bug.id, { expectedRevision: 1, assigneeId: admin.id }, human())).rejects.toThrow(/needs a priority/);

    const backlog = await prisma.workflowState.findFirstOrThrow({ where: { teamId: team.id, type: 'BACKLOG' } });
    const fresh = await prisma.issue.findUniqueOrThrow({ where: { id: bug.id } });
    await expect(
      commitWork(prisma, bug.id, { expectedRevision: fresh.revision, assigneeId: admin.id, priority: 2, stateId: backlog.id }, human()),
    ).rejects.toThrow(/do not go to the backlog/);

    const again = await prisma.issue.findUniqueOrThrow({ where: { id: bug.id } });
    const committed = await commitWork(prisma, bug.id, { expectedRevision: again.revision, assigneeId: admin.id, priority: 2 }, human());
    const state = await prisma.workflowState.findUniqueOrThrow({ where: { id: committed.stateId } });
    expect(committed.priority).toBe(2);
    expect(state.type).toBe('UNSTARTED'); // initial_state=BACKLOG is ignored for bugs

    await expect(updateIssue(prisma, bug.id, { stateId: backlog.id }, human())).rejects.toThrow(/do not go to the backlog/);
    const plain = await proposeWork(prisma, { teamId: team.id, title: 'Chore', parentId: projectId, acceptance: 'Done' });
    await commitWork(prisma, plain.id, { expectedRevision: 1, assigneeId: admin.id }, human());
    await expect(updateIssue(prisma, plain.id, { stateId: backlog.id }, human())).resolves.toBeTruthy();
  });

  it('declines a bug only with a reason', async () => {
    const bug = await bugCandidate();
    await expect(rejectWork(prisma, bug.id, { expectedRevision: 1 }, human())).rejects.toThrow(/needs a reason/);
    const fresh = await prisma.issue.findUniqueOrThrow({ where: { id: bug.id } });
    await expect(rejectWork(prisma, bug.id, { expectedRevision: fresh.revision, reason: 'Works as designed' }, human())).resolves.toMatchObject({ commitmentStatus: 'REJECTED' });
  });

  it('reminds the owner and triager once when a bug is at risk and once when breached', async () => {
    const other = await prisma.user.create({ data: { email: 'triager@example.com', name: 'Triager', actorKind: 'HUMAN' } });
    await prisma.teamMembership.create({ data: { teamId: team.id, userId: other.id, role: 'EDITOR' } });
    await setTriageRotation(prisma, { teamId: team.id, userIds: [other.id], startsAt: new Date(Date.now() - HOUR).toISOString() });

    const bug = await reportBug(prisma, { teamId: team.id, title: 'Urgent crash', priority: 1, stepsToReproduce: 'x', parentId: projectId }, human());
    await prisma.issue.update({ where: { id: bug.id }, data: { assigneeId: admin.id } });
    const now = Date.now();
    const sla = (await loadBugSlas(prisma, [bug.id], new Date(now))).get(bug.id)!;
    expect(sla.status).toBe('ON_TRACK');

    expect(await sweepBugSlas(prisma, new Date(now + 20 * HOUR))).toBe(1); // 4h of 24h left
    expect(await sweepBugSlas(prisma, new Date(now + 21 * HOUR))).toBe(0); // already reminded
    expect(await sweepBugSlas(prisma, new Date(now + 25 * HOUR))).toBe(1); // breached
    expect(await sweepBugSlas(prisma, new Date(now + 26 * HOUR))).toBe(0);

    const notes = await prisma.notification.findMany({ where: { workId: bug.id, type: { startsWith: 'bug.sla' } }, orderBy: { createdAt: 'asc' } });
    expect(notes.map((note) => `${note.type}:${note.userId === admin.id ? 'owner' : 'triager'}`).sort()).toEqual([
      'bug.sla_at_risk:owner',
      'bug.sla_at_risk:triager',
      'bug.sla_breached:owner',
      'bug.sla_breached:triager',
    ]);
    expect(await prisma.eventOutbox.count({ where: { type: { in: ['bug.sla_at_risk', 'bug.sla_breached'] } } })).toBe(2);
  });

  it('sends triage reports to this week\'s triager, and validates the rotation', async () => {
    const triager = await prisma.user.create({ data: { email: 't2@example.com', name: 'T2', actorKind: 'HUMAN' } });
    await prisma.teamMembership.create({ data: { teamId: team.id, userId: triager.id, role: 'EDITOR' } });
    const outsider = await prisma.user.create({ data: { email: 'out@example.com', name: 'Out', actorKind: 'HUMAN' } });
    await expect(setTriageRotation(prisma, { teamId: team.id, userIds: [outsider.id] })).rejects.toThrow(/human members/);
    await setTriageRotation(prisma, { teamId: team.id, userIds: [triager.id] });

    const report = await reportBug(prisma, { teamId: team.id, title: 'Unsure where', priority: 3, stepsToReproduce: 'x' }, human());
    const notes = await prisma.notification.findMany({ where: { workId: report.id, type: 'bug.reported' } });
    expect(notes.map((note) => note.userId)).toEqual([triager.id]);

    await setTriageRotation(prisma, { teamId: team.id, userIds: [] });
    expect((await prisma.team.findUniqueOrThrow({ where: { id: team.id } })).triageRotation).toBeNull();
  });
});
