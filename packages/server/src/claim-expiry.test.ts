import type { Issue, Team, User } from '@prisma/client';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ADMIN_EMAIL, DEFAULT_TEAM_KEY, resetAndSeed } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import { sweepExpiredClaims } from './claim-expiry.ts';
import { claimWork } from './claim-service.ts';
import { createIssue } from './issue-service.ts';
import { reportRun } from './run-service-report.ts';

loadProjectEnvironment();
const prisma = new PrismaClient();

describe('expired claims are swept (INV-991)', () => {
  let team: Team;
  let admin: User;
  let agent: User;
  let owner: User;
  let work: Issue;
  const asAgent = () => ({ actorId: agent.id, actorKind: 'AGENT' as const, surface: 'mcp' as const });

  beforeEach(async () => {
    await resetAndSeed(prisma);
    team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
    admin = await prisma.user.findUniqueOrThrow({ where: { email: DEFAULT_ADMIN_EMAIL } });
    owner = await prisma.user.create({ data: { email: 'owner@example.com', name: 'Owner', actorKind: 'HUMAN' } });
    agent = await prisma.user.create({ data: { email: 'bot@agents.local', name: 'Bot', actorKind: 'AGENT', ownerId: owner.id } });
    await prisma.teamMembership.create({ data: { teamId: team.id, userId: agent.id, role: 'EDITOR' } });
    const ready = await prisma.workflowState.findFirstOrThrow({ where: { teamId: team.id, type: 'UNSTARTED' } });
    work = await createIssue(prisma, { teamId: team.id, title: 'Silent agent', stateId: ready.id, assigneeId: admin.id, acceptance: 'done' });
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('releases the lease, fails its run, returns the work to Ready and tells owner, holder and its owner', async () => {
    const { claimToken } = await claimWork(prisma, work.id, {}, asAgent());
    const { run } = await reportRun(prisma, { workId: work.id, status: 'running', summary: 'working', claimToken }, asAgent());
    expect((await prisma.issue.findUniqueOrThrow({ where: { id: work.id }, include: { state: true } })).state.type).toBe('STARTED');
    const past = new Date(Date.now() - 30 * 60_000);
    await prisma.workClaim.update({ where: { workId: work.id }, data: { leaseUntil: past } });

    expect(await sweepExpiredClaims(prisma)).toBe(1);

    expect(await prisma.workClaim.count({ where: { workId: work.id } })).toBe(0);
    expect(await prisma.workRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ status: 'FAILED' });
    expect((await prisma.workRun.findUniqueOrThrow({ where: { id: run.id } })).summary).toMatch(/Lease expired 30 min ago/);
    const after = await prisma.issue.findUniqueOrThrow({ where: { id: work.id }, include: { state: true } });
    expect(after.state.type).toBe('UNSTARTED');
    expect(after.revision).toBeGreaterThan(work.revision);
    const audit = await prisma.workAudit.findFirstOrThrow({ where: { workId: work.id }, orderBy: { createdAt: 'desc' } });
    expect(audit.reason).toMatch(/Lease expired/);
    const event = await prisma.eventOutbox.findFirstOrThrow({ where: { type: 'work.claim_expired' } });
    expect((event.payload as { data: { expiredActorId: string; closedRuns: number; returnedToReady: boolean } }).data).toMatchObject({ expiredActorId: agent.id, closedRuns: 1, returnedToReady: true });
    const notified = await prisma.notification.findMany({ where: { type: 'work.claim_expired' } });
    expect(notified.map((note) => note.userId).sort()).toEqual([admin.id, agent.id, owner.id].sort());
    expect(notified[0]!.payload).toMatchObject({ identifier: work.identifier, overdueMinutes: 30 });

    // Nothing left to sweep; the agent's old run is dead; the work can be claimed again.
    expect(await sweepExpiredClaims(prisma)).toBe(0);
    await expect(reportRun(prisma, { workId: work.id, runId: run.id, status: 'running', summary: 'back', claimToken }, asAgent())).rejects.toThrow();
    await expect(claimWork(prisma, work.id, {}, asAgent())).resolves.toBeTruthy();
  });

  it('leaves live leases alone and keeps a Review state a PR already reached', async () => {
    await claimWork(prisma, work.id, {}, asAgent());
    expect(await sweepExpiredClaims(prisma)).toBe(0);
    expect(await prisma.workClaim.count({ where: { workId: work.id } })).toBe(1);

    const review = await prisma.workflowState.findFirstOrThrow({ where: { teamId: team.id, type: 'REVIEW' } });
    await prisma.issue.update({ where: { id: work.id }, data: { stateId: review.id } });
    await prisma.workClaim.update({ where: { workId: work.id }, data: { leaseUntil: new Date(Date.now() - 60_000) } });
    expect(await sweepExpiredClaims(prisma)).toBe(1);
    expect((await prisma.issue.findUniqueOrThrow({ where: { id: work.id }, include: { state: true } })).state.type).toBe('REVIEW');
    expect(await prisma.workClaim.count({ where: { workId: work.id } })).toBe(0);
  });
});
