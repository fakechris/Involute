import { PrismaClient as PrismaClientConstructor } from '@prisma/client';
import type { Team, User } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ADMIN_EMAIL, DEFAULT_TEAM_KEY, seedDatabase } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import { claimWork, commitWork, proposeWork } from './claim-service.ts';
import { createComment } from './issue-service.ts';
import { readUnreadNotifications } from './notification-service.ts';
import { reportRun } from './run-service.ts';
import { upsertWorkShare } from './project-sharing.ts';
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

  // INV-1195: a run.stale note carries the work's identifier, title and phase,
  // so it goes only to people who may read that work under the usual rules.
  describe('recipients must be able to read the work (INV-1195)', () => {
    async function staleRunOwnedBy(owner: User) {
      await prisma.team.update({ where: { id: team.id }, data: { visibility: 'PRIVATE' } });
      const executor = await prisma.user.create({ data: { name: 'Owned runner', email: `runner-${owner.id}@agents.local`, actorKind: 'AGENT', ownerId: owner.id } });
      const candidate = await proposeWork(prisma, { parentId: await testParentId(prisma, team.id), teamId: team.id, title: 'Restricted task' }, { actorId: human.id, actorKind: 'HUMAN', surface: 'test' });
      const work = await commitWork(prisma, candidate.id, { acceptance: 'Done when done.', assigneeId: human.id, expectedRevision: candidate.revision }, { actorId: human.id, actorKind: 'HUMAN', surface: 'test' });
      const actor = { actorId: executor.id, actorKind: 'AGENT' as const, surface: 'test' };
      const claim = await claimWork(prisma, work.id, {}, actor);
      const { run } = await reportRun(prisma, { workId: work.id, claimToken: claim.claimToken!, status: 'running', phase: 'secret-phase' }, actor);
      await prisma.workRun.update({ where: { id: run.id }, data: { lastActivityAt: new Date(Date.now() - HOUR) } });
      return { work, run };
    }

    async function staleNotesFor(userId: string) {
      return prisma.notification.findMany({ where: { type: 'run.stale', userId } });
    }

    function person(name: string, globalRole: 'USER' | 'ADMIN' = 'USER') {
      return prisma.user.create({ data: { name, email: `${name.toLowerCase()}@people.local`, actorKind: 'HUMAN', globalRole } });
    }

    it('does not tell an executor owner who was removed from the private team', async () => {
      const owner = await person('Removed');
      await prisma.teamMembership.create({ data: { teamId: team.id, userId: owner.id, role: 'EDITOR' } });
      await prisma.teamMembership.delete({ where: { teamId_userId: { teamId: team.id, userId: owner.id } } });
      const { run } = await staleRunOwnedBy(owner);

      expect(await sweepStaleRuns(prisma)).toBe(1);
      expect(await staleNotesFor(owner.id)).toHaveLength(0);
      expect(await staleNotesFor(human.id)).toHaveLength(1);
      // The sweep itself is unchanged: reported once, outbox event written.
      expect((await prisma.workRun.findUniqueOrThrow({ where: { id: run.id } })).staleNotifiedAt).not.toBeNull();
      expect(await prisma.eventOutbox.count({ where: { type: 'run.stale' } })).toBe(1);
      expect(await sweepStaleRuns(prisma)).toBe(0);
    });

    it('does not tell a work owner (assignee) who can no longer read the work', async () => {
      const owner = await person('Member');
      await prisma.teamMembership.create({ data: { teamId: team.id, userId: owner.id, role: 'EDITOR' } });
      const outsider = await person('Outsider');
      const { work } = await staleRunOwnedBy(owner);
      await prisma.issue.update({ where: { id: work.id }, data: { assigneeId: outsider.id } });

      expect(await sweepStaleRuns(prisma)).toBe(1);
      expect(await staleNotesFor(outsider.id)).toHaveLength(0);
      expect(await staleNotesFor(owner.id)).toHaveLength(1);
    });

    it('tells an executor owner who reads the work through a project share', async () => {
      const owner = await person('Shared');
      const { work } = await staleRunOwnedBy(owner);
      const milestone = await prisma.issue.findUniqueOrThrow({ where: { id: work.parentId! } });
      await upsertWorkShare(prisma, { actor: { actorId: human.id, actorKind: 'HUMAN', surface: 'test' }, role: 'VIEWER', userId: owner.id, workId: milestone.parentId! });

      expect(await sweepStaleRuns(prisma)).toBe(1);
      const notes = await staleNotesFor(owner.id);
      expect(notes).toHaveLength(1);
      expect(notes[0]!.payload).toMatchObject({ identifier: work.identifier, phase: 'secret-phase' });
    });

    it('tells an executor owner who is on the team, and one who is an admin', async () => {
      const member = await person('Teammate');
      await prisma.teamMembership.create({ data: { teamId: team.id, userId: member.id, role: 'VIEWER' } });
      await staleRunOwnedBy(member);
      const admin = await person('Overseer', 'ADMIN');
      await staleRunOwnedBy(admin);

      expect(await sweepStaleRuns(prisma)).toBe(2);
      expect(await staleNotesFor(member.id)).toHaveLength(1);
      expect(await staleNotesFor(admin.id)).toHaveLength(1);
    });

    it('does not tell a deactivated admin or a deactivated team member', async () => {
      const member = await person('Gone');
      await prisma.teamMembership.create({ data: { teamId: team.id, userId: member.id, role: 'EDITOR' } });
      await staleRunOwnedBy(member);
      const admin = await person('Retired', 'ADMIN');
      await staleRunOwnedBy(admin);
      await prisma.user.updateMany({ where: { id: { in: [member.id, admin.id] } }, data: { deactivatedAt: new Date() } });

      expect(await sweepStaleRuns(prisma)).toBe(2);
      expect(await staleNotesFor(member.id)).toHaveLength(0);
      expect(await staleNotesFor(admin.id)).toHaveLength(0);
      expect(await staleNotesFor(human.id)).toHaveLength(2);
    });
  });
});
