import { PrismaClient as PrismaClientConstructor } from '@prisma/client';
import type { Team, User } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ADMIN_EMAIL, DEFAULT_TEAM_KEY, seedDatabase } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import { claimWork, commitWork, proposeWork } from './claim-service.ts';
import { createComment } from './issue-service.ts';
import { readUnreadNotifications } from './notification-service.ts';
import { reportRun } from './run-service.ts';
import { runPresence, sweepStaleRuns } from './run-staleness.ts';
import { testParentId } from './test-placement.ts';

loadProjectEnvironment();
const prisma = new PrismaClientConstructor();
const HOUR = 60 * 60_000;

// INV-996: a run that stops writing goes stale; its owner hears once; activity revives it.
describe('run activity and staleness (INV-996)', () => {
  let team: Team;
  let human: User;
  let agent: User;

  beforeAll(async () => { await prisma.$connect(); });
  afterAll(async () => { await prisma.$disconnect(); });
  beforeEach(async () => {
    await prisma.notification.deleteMany();
    await prisma.eventOutbox.deleteMany();
    await prisma.workRun.deleteMany();
    await prisma.workClaim.deleteMany();
    await prisma.comment.deleteMany();
    await prisma.issue.deleteMany();
    await prisma.workflowState.deleteMany();
    await prisma.team.deleteMany();
    await prisma.actorAudit.deleteMany();
    await prisma.user.deleteMany();
    await seedDatabase(prisma);
    team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
    human = await prisma.user.findUniqueOrThrow({ where: { email: DEFAULT_ADMIN_EMAIL } });
    agent = await prisma.user.create({ data: { name: 'Runner', email: 'runner@agents.local', actorKind: 'AGENT', ownerId: human.id } });
  });

  async function runningWork() {
    const candidate = await proposeWork(prisma, { parentId: await testParentId(prisma, team.id), teamId: team.id, title: 'Long task' }, { actorId: human.id, actorKind: 'HUMAN', surface: 'test' });
    const work = await commitWork(prisma, candidate.id, { acceptance: 'Done when done.', assigneeId: human.id, expectedRevision: candidate.revision }, { actorId: human.id, actorKind: 'HUMAN', surface: 'test' });
    const actor = { actorId: agent.id, actorKind: 'AGENT' as const, surface: 'test' };
    const claim = await claimWork(prisma, work.id, {}, actor);
    const { run } = await reportRun(prisma, { workId: work.id, claimToken: claim.claimToken!, status: 'running', phase: 'implement' }, actor);
    return { work, run, claim, actor };
  }

  it('reports a silent running run once, to the owner and the executor\'s owner, and is live again after activity', async () => {
    const { work, run, claim, actor } = await runningWork();
    expect(runPresence(run)).toBe('live');
    const quietSince = new Date(Date.now() - HOUR);
    await prisma.workRun.update({ where: { id: run.id }, data: { lastActivityAt: quietSince } });
    expect(runPresence({ ...run, lastActivityAt: quietSince })).toBe('stale');

    expect(await sweepStaleRuns(prisma)).toBe(1);
    expect(await sweepStaleRuns(prisma)).toBe(0);
    const inbox = await readUnreadNotifications(prisma, { first: 10, since: null, teamId: null, userId: human.id });
    const stale = inbox.filter((row) => row.type === 'run.stale');
    expect(stale).toHaveLength(1);
    expect(stale[0]!.payload).toMatchObject({ publicId: run.publicId, phase: 'implement', silentMinutes: 60 });
    expect(await prisma.eventOutbox.count({ where: { type: 'run.stale' } })).toBe(1);

    // A phase report is activity: live again, and a later silence is reported anew.
    await reportRun(prisma, { workId: work.id, claimToken: claim.claimToken!, status: 'running', phase: 'test' }, actor);
    const revived = await prisma.workRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(runPresence(revived)).toBe('live');
    expect(revived.staleNotifiedAt).toBeNull();
    await prisma.workRun.update({ where: { id: run.id }, data: { lastActivityAt: quietSince } });
    expect(await sweepStaleRuns(prisma)).toBe(1);
  });

  it('counts a comment by the executor as activity, and settles ended runs', async () => {
    const { work, run, claim, actor } = await runningWork();
    await prisma.workRun.update({ where: { id: run.id }, data: { lastActivityAt: new Date(Date.now() - HOUR) } });
    await createComment(prisma, { issueId: work.id, body: 'Still on it: tests are slow.' }, agent.id);
    expect(runPresence(await prisma.workRun.findUniqueOrThrow({ where: { id: run.id } }))).toBe('live');
    expect(await sweepStaleRuns(prisma)).toBe(0);

    await reportRun(prisma, { workId: work.id, claimToken: claim.claimToken!, status: 'completed', summary: 'Done.' }, actor);
    const ended = await prisma.workRun.findUniqueOrThrow({ where: { id: run.id } });
    await prisma.workRun.update({ where: { id: run.id }, data: { lastActivityAt: new Date(Date.now() - 2 * HOUR) } });
    expect(runPresence({ ...ended, lastActivityAt: new Date(0) })).toBe('settled');
    expect(runPresence({ ...ended, status: 'QUEUED', lastActivityAt: new Date(0) })).toBe('waiting');
    expect(await sweepStaleRuns(prisma)).toBe(0);
  });
});
