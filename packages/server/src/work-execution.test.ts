import type { Issue, Team, User } from '@prisma/client';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ADMIN_EMAIL, DEFAULT_TEAM_KEY, resetAndSeed } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import { releaseClaim } from './claim-release.ts';
import { claimWork } from './claim-service.ts';
import { createIssue } from './issue-service.ts';
import { reportRun } from './run-service-report.ts';
import { attachEvidence } from './run-service-evidence.ts';
import { retractEvidence } from './evidence-retract.ts';

loadProjectEnvironment();
const prisma = new PrismaClient();

describe('work execution ownership (INV-943)', () => {
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

  it('isolates executions of the same actor and lets the holder hand work back', async () => {
    const first = await claimWork(prisma, work.id, { executionId: 'session-a' }, asAgent());
    expect(first.claimToken).toEqual(expect.any(String));
    await expect(claimWork(prisma, work.id, { executionId: 'session-b' }, asAgent())).rejects.toThrow(/execution|lease/i);
    await expect(reportRun(prisma, { workId: work.id, status: 'running' }, asAgent())).rejects.toThrow(/execution|lease/i);
    const { run } = await reportRun(prisma, { workId: work.id, claimToken: first.claimToken, status: 'running' }, asAgent());
    await releaseClaim(prisma, { workId: work.id, reason: 'Yield to another worker', claimToken: first.claimToken }, asAgent());
    const second = await claimWork(prisma, work.id, { executionId: 'session-b' }, asAgent());
    expect(second.claimToken).not.toBe(first.claimToken);
    await expect(reportRun(prisma, { workId: work.id, claimToken: first.claimToken, status: 'running' }, asAgent())).rejects.toThrow(/execution|lease/i);
    await expect(reportRun(prisma, { workId: work.id, runId: run.id, claimToken: first.claimToken, status: 'completed' }, asAgent())).rejects.toThrow();
    await expect(reportRun(prisma, { workId: work.id, claimToken: second.claimToken, status: 'running' }, asAgent())).resolves.toBeTruthy();
  });
  it('rejects expired reports and evidence, then fences the old generation after recovery', async () => {
    const first = await claimWork(prisma, work.id, {}, asAgent());
    const { run } = await reportRun(prisma, { workId: work.id, claimToken: first.claimToken, status: 'running' }, asAgent());
    await prisma.workClaim.update({ where: { id: first.claim.id }, data: { leaseUntil: new Date(0) } });
    await expect(reportRun(prisma, { workId: work.id, runId: run.id, claimToken: first.claimToken, status: 'completed' }, asAgent())).rejects.toThrow(/claim/i);
    await expect(attachEvidence(prisma, { workId: work.id, runId: run.id, claimToken: first.claimToken, kind: 'test', url: 'https://example.com/result' }, asAgent())).rejects.toThrow(/lease/i);
    const second = await claimWork(prisma, work.id, {}, asAgent());
    expect(second.claim.id).not.toBe(first.claim.id);
    await expect(reportRun(prisma, { workId: work.id, runId: run.id, claimToken: first.claimToken, status: 'completed' }, asAgent())).rejects.toThrow(/claim/i);
  });

  it('allows correction of owned evidence before acceptance, without deleting history', async () => {
    const { claimToken } = await claimWork(prisma, work.id, {}, asAgent());
    const { run } = await reportRun(prisma, { workId: work.id, claimToken, status: 'completed' }, asAgent());
    const { evidence } = await attachEvidence(prisma, { workId: work.id, runId: run.id, claimToken, kind: 'test', url: 'https://example.com/wrong' }, asAgent());
    await expect(retractEvidence(prisma, { evidenceId: evidence.id, reason: 'Wrong link' }, asAgent())).rejects.toThrow(/execution/i);
    await retractEvidence(prisma, { evidenceId: evidence.id, claimToken, reason: 'Wrong link' }, asAgent());
    expect(await prisma.workEvidence.findUnique({ where: { id: evidence.id } })).toMatchObject({ retractReason: 'Wrong link', retractedById: agent.id });
    const next = await attachEvidence(prisma, { workId: work.id, runId: run.id, claimToken, kind: 'test', url: 'https://example.com/right' }, asAgent());
    const done = await prisma.workflowState.findFirstOrThrow({ where: { teamId: team.id, type: 'COMPLETED' } });
    await prisma.issue.update({ where: { id: work.id }, data: { stateId: done.id } });
    await expect(retractEvidence(prisma, { evidenceId: next.evidence.id, claimToken, reason: 'Too late' }, asAgent())).rejects.toThrow(/person/i);
  });

  it('rechecks a revoked credential after waiting for the work lock', async () => {
    const credential = await prisma.agentCredential.create({ data: { name: 'execution-test', tokenHash: 'execution-test-hash', userId: agent.id, teamId: team.id } });
    const actor = { ...asAgent(), agentCredentialId: credential.id };
    const { claimToken } = await claimWork(prisma, work.id, {}, actor);
    let unlock!: () => void;
    let locked!: () => void;
    const lockReady = new Promise<void>((resolve) => { locked = resolve; });
    const lockRelease = new Promise<void>((resolve) => { unlock = resolve; });
    const holder = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Issue" WHERE id = ${work.id}::uuid FOR UPDATE`;
      locked();
      await lockRelease;
    });
    await lockReady;
    const pending = reportRun(prisma, { workId: work.id, claimToken, status: 'running' }, actor);
    const denied = expect(pending).rejects.toThrow(/credential/i);
    try {
      await prisma.agentCredential.update({ where: { id: credential.id }, data: { revokedAt: new Date() } });
    } finally { unlock(); }
    await holder;
    await denied;
    expect(await prisma.workRun.count({ where: { workId: work.id } })).toBe(0);
  });

});
