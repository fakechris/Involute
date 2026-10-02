import type { Issue, Team, User } from '@prisma/client';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ADMIN_EMAIL, DEFAULT_TEAM_KEY, resetAndSeed } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import { releaseClaim } from './claim-release.ts';
import { claimWork } from './claim-service.ts';
import { createIssue } from './issue-service.ts';
import { reportRun } from './run-service-report.ts';

loadProjectEnvironment();
const prisma = new PrismaClient();

describe('a person releases an agent claim (INV-789)', () => {
  let team: Team;
  let admin: User;
  let agent: User;
  let work: Issue;
  const asHuman = () => ({ actorId: admin.id, actorKind: 'HUMAN' as const, surface: 'graphql' as const });
  const asAgent = () => ({ actorId: agent.id, actorKind: 'AGENT' as const, surface: 'mcp' as const });

  beforeEach(async () => {
    await resetAndSeed(prisma);
    team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
    admin = await prisma.user.findUniqueOrThrow({ where: { email: DEFAULT_ADMIN_EMAIL } });
    agent = await prisma.user.create({ data: { email: 'bot@agents.local', name: 'Bot', actorKind: 'AGENT', ownerId: admin.id } });
    await prisma.teamMembership.create({ data: { teamId: team.id, userId: agent.id, role: 'EDITOR' } });
    const ready = await prisma.workflowState.findFirstOrThrow({ where: { teamId: team.id, type: 'UNSTARTED' } });
    work = await createIssue(prisma, { teamId: team.id, title: 'Stuck work', stateId: ready.id, assigneeId: admin.id, acceptance: 'done' });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('ends the claim, closes its open run, records why and tells the holder and its owner', async () => {
    const other = await prisma.user.create({ data: { email: 'second@example.com', name: 'Second', actorKind: 'HUMAN' } });
    await prisma.user.update({ where: { id: agent.id }, data: { ownerId: other.id } });
    const { claimToken } = await claimWork(prisma, work.id, {}, asAgent());
    const { run } = await reportRun(prisma, { workId: work.id, status: 'running', summary: 'working', claimToken }, asAgent());

    await releaseClaim(prisma, { workId: work.identifier, reason: 'Stuck for a day' }, asHuman());

    expect(await prisma.workClaim.count({ where: { workId: work.id } })).toBe(0);
    expect(await prisma.workRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
      status: 'FAILED',
      summary: 'Claim released by Admin: Stuck for a day',
    });
    const audit = await prisma.workAudit.findFirstOrThrow({ where: { workId: work.id }, orderBy: { createdAt: 'desc' } });
    expect(audit).toMatchObject({ actorId: admin.id, reason: 'Claim released: Stuck for a day' });
    const event = await prisma.eventOutbox.findFirstOrThrow({ where: { type: 'work.claim_released' } });
    expect((event.payload as { data: { releasedActorId: string; closedRuns: number } }).data).toMatchObject({ releasedActorId: agent.id, closedRuns: 1 });
    const notified = await prisma.notification.findMany({ where: { type: 'work.claim_released' } });
    expect(notified.map((note) => note.userId).sort()).toEqual([agent.id, other.id].sort());

    // The agent's next report on that run, or a new one, is refused.
    await expect(reportRun(prisma, { workId: work.id, runId: run.id, status: 'running', summary: 'still going' }, asAgent())).rejects.toThrow();
    await expect(reportRun(prisma, { workId: work.id, status: 'running', summary: 'new run' }, asAgent())).rejects.toThrow(/claim/i);
    // The work can be claimed again.
    await expect(claimWork(prisma, work.id, {}, asAgent())).resolves.toBeTruthy();
  });

  it('requires an execution credential for agents and a reason for everyone', async () => {
    await claimWork(prisma, work.id, {}, asAgent());
    await expect(releaseClaim(prisma, { workId: work.id, reason: 'mine now' }, asAgent())).rejects.toThrow(/execution|lease/i);
    await expect(releaseClaim(prisma, { workId: work.id, reason: '  ' }, asHuman())).rejects.toThrow(/needs a reason/);
    await releaseClaim(prisma, { workId: work.id, reason: 'ok' }, asHuman());
    await expect(releaseClaim(prisma, { workId: work.id, reason: 'again' }, asHuman())).rejects.toThrow(/no claim/);
  });
});
