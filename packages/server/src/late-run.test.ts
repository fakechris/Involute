import type { Issue, PrismaClient, Team, User } from '@prisma/client';
import { PrismaClient as PrismaClientConstructor } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ADMIN_EMAIL, DEFAULT_TEAM_KEY, resetAndSeed } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import { issueAgentCredential } from './agent-credentials.ts';
import { claimWork } from './claim-service.ts';
import { sweepExpiredClaims } from './claim-expiry.ts';
import { WORK_RUN_REQUIRES_ACTIVE_CLAIM_MESSAGE } from './errors.ts';
import { createIssue } from './issue-service.ts';
import { LATE_RUN_REFUSED_MESSAGE, LATE_RUN_WINDOW_MS } from './late-run.ts';
import { reportRun } from './run-service-report.ts';
import { testParentId } from './test-placement.ts';
import { writeActorFromViewer } from './work-service.ts';

// INV-1704: long work outlives its lease while a PR moves it to Review.
loadProjectEnvironment();
const prisma: PrismaClient = new PrismaClientConstructor();
const SHA = 'a'.repeat(40);

describe('a completed run filed after the claim expired (INV-1704)', () => {
  let team: Team;
  let human: User;
  let agent: User;
  let other: User;
  let work: Issue;

  beforeAll(async () => { await prisma.$connect(); });
  afterAll(async () => { await resetAndSeed(prisma); await prisma.$disconnect(); });
  beforeEach(async () => {
    await resetAndSeed(prisma);
    team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
    human = await prisma.user.findUniqueOrThrow({ where: { email: DEFAULT_ADMIN_EMAIL } });
    await prisma.teamMembership.upsert({ where: { teamId_userId: { teamId: team.id, userId: human.id } }, update: {}, create: { role: 'OWNER', teamId: team.id, userId: human.id } });
    const agentFor = async (handle: string) => {
      const issued = await issueAgentCredential(prisma, { email: `${handle}@agents.involute.local`, name: handle, handle, ownerId: human.id, teamKey: team.key, scopes: ['read', 'propose', 'claim', 'report'], issuedById: human.id });
      return prisma.user.findUniqueOrThrow({ where: { id: issued.credential.userId } });
    };
    agent = await agentFor('builder');
    other = await agentFor('bystander');
    const ready = await prisma.workflowState.findFirstOrThrow({ where: { teamId: team.id, type: 'UNSTARTED' } });
    work = await createIssue(prisma, { teamId: team.id, title: 'Long change', parentId: await testParentId(prisma, team.id, 'fakechris/Involute'), repository: 'fakechris/Involute', acceptance: 'Shipped.', commitmentStatus: 'COMMITTED', stateId: ready.id, assigneeId: human.id }, writeActorFromViewer(human, 'test'));
  });

  /** Claim, let a PR move the work to Review, and let the lease run out. */
  async function outlivedLease(options: { sweep: boolean; expiredAgoMs?: number }) {
    await claimWork(prisma, work.id, {}, writeActorFromViewer(agent, 'mcp'));
    const review = await prisma.workflowState.findFirstOrThrow({ where: { teamId: team.id, type: 'REVIEW' } });
    await prisma.issue.update({ where: { id: work.id }, data: { stateId: review.id } });
    const expiredAt = new Date(Date.now() - (options.expiredAgoMs ?? 60_000));
    await prisma.workClaim.updateMany({ where: { workId: work.id }, data: { leaseUntil: expiredAt } });
    if (options.sweep) await sweepExpiredClaims(prisma);
  }

  const complete = (as: User) =>
    reportRun(prisma, { workId: work.id, status: 'completed', summary: 'Shipped in #9.', commitSha: SHA, pullRequestNumber: 9, followups: { noneReason: 'Nothing left.' } }, writeActorFromViewer(as, 'mcp'));

  it('accepts the run from the agent whose claim the sweep released, keeps the work In Review, and audits it as late', async () => {
    await outlivedLease({ sweep: true });
    expect((await prisma.issue.findUniqueOrThrow({ where: { id: work.id }, include: { state: true } })).state.type).toBe('REVIEW');

    const { run, work: after } = await complete(agent);
    expect(run).toMatchObject({ status: 'COMPLETED', commitSha: SHA, pullRequestNumber: 9, claimId: null, actorId: agent.id });
    expect((await prisma.workflowState.findUniqueOrThrow({ where: { id: after.stateId } })).type).toBe('REVIEW');
    const audit = await prisma.workAudit.findFirst({ where: { workId: work.id, reason: { contains: 'INV-1704' } } });
    expect(audit?.reason).toContain(run.publicId);
  });

  it('accepts it before the sweep has removed the expired lease, and removes it', async () => {
    await outlivedLease({ sweep: false });
    const { run } = await complete(agent);
    expect(run.status).toBe('COMPLETED');
    expect(await prisma.workClaim.count({ where: { workId: work.id } })).toBe(0);
  });

  it('refuses anyone who did not hold the last claim', async () => {
    await outlivedLease({ sweep: true });
    await expect(complete(other)).rejects.toThrow(LATE_RUN_REFUSED_MESSAGE);
  });

  it('refuses once the window has passed', async () => {
    await outlivedLease({ sweep: false, expiredAgoMs: LATE_RUN_WINDOW_MS + 60_000 });
    await expect(complete(agent)).rejects.toThrow(LATE_RUN_REFUSED_MESSAGE);
  });

  it('still needs a live claim outside Review and for anything but a completed run', async () => {
    await claimWork(prisma, work.id, {}, writeActorFromViewer(agent, 'mcp'));
    await prisma.workClaim.updateMany({ where: { workId: work.id }, data: { leaseUntil: new Date(Date.now() - 60_000) } });
    await sweepExpiredClaims(prisma);
    // The sweep returned it to Ready: no PR moved it, so the usual rule applies.
    await expect(complete(agent)).rejects.toThrow(WORK_RUN_REQUIRES_ACTIVE_CLAIM_MESSAGE);

    await outlivedLease({ sweep: true });
    await expect(reportRun(prisma, { workId: work.id, status: 'running', summary: 'Still going' }, writeActorFromViewer(agent, 'mcp'))).rejects.toThrow(WORK_RUN_REQUIRES_ACTIVE_CLAIM_MESSAGE);
  });
});
