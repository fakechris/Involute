import { PrismaClient as PrismaClientConstructor } from '@prisma/client';
import type { PrismaClient, Team, User, WorkflowState } from '@prisma/client';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ADMIN_EMAIL, DEFAULT_TEAM_KEY, seedDatabase } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import {
  WORK_ALREADY_CLAIMED_MESSAGE,
  WORK_COMMIT_FORBIDDEN_MESSAGE,
  WORK_COMMIT_REQUIRES_ACCEPTANCE_MESSAGE,
  WORK_NOT_CANDIDATE_MESSAGE,
  WORK_OWNER_MUST_BELONG_TO_TEAM_MESSAGE,
  WORK_REJECT_FORBIDDEN_MESSAGE,
  WORK_REVISION_CONFLICT_MESSAGE,
  WORK_IDEMPOTENCY_CONFLICT_MESSAGE,
} from './errors.ts';
import { claimWork, commitWork, proposeWork, rejectWork } from './claim-service.ts';
import { listReadyWork } from './context-service.ts';
import { updateIssue } from './issue-service.ts';

loadProjectEnvironment();

const prisma = new PrismaClientConstructor();

describe('claim service', () => {
  let team: Team;
  let ready: WorkflowState;
  let inProgress: WorkflowState;
  let human: User;
  let agent: User;

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
    ready = await prisma.workflowState.findFirstOrThrow({
      where: { teamId: team.id, name: 'Ready' },
    });
    inProgress = await prisma.workflowState.findFirstOrThrow({
      where: { teamId: team.id, name: 'In Progress' },
    });
    human = await prisma.user.findUniqueOrThrow({ where: { email: DEFAULT_ADMIN_EMAIL } });
    agent = await prisma.user.create({
      data: {
        actorKind: 'AGENT',
        email: 'codex@involute.local',
        name: 'Codex',
      },
    });
  });

  it('proposes candidates that stay out of the ready queue and is idempotent', async () => {
    const first = await proposeWork(prisma, {
      idempotencyKey: 'discover-cycle',
      teamId: team.id,
      title: 'History links may contain a cycle',
    });
    const second = await proposeWork(prisma, {
      idempotencyKey: 'discover-cycle',
      teamId: team.id,
      title: 'History links may contain a cycle',
    });

    expect(first.id).toBe(second.id);
    expect(first.commitmentStatus).toBe('CANDIDATE');
    expect(first.identifier).toMatch(/^INV-/);

    const readyQueue = await listReadyWork(prisma);
    expect(readyQueue.nodes.map((issue) => issue.id)).not.toContain(first.id);
  });

  it('scopes idempotency by team and rejects reuse with a different payload', async () => {
    const otherTeam = await prisma.team.create({
      data: {
        key: 'OTHER',
        name: 'Other',
        states: { create: { name: 'Backlog', position: 0, type: 'BACKLOG' } },
      },
    });
    const first = await proposeWork(prisma, {
      idempotencyKey: 'same-key', teamId: team.id, title: 'First payload',
    });
    const other = await proposeWork(prisma, {
      idempotencyKey: 'same-key', teamId: otherTeam.id, title: 'Other team payload',
    });
    expect(other.id).not.toBe(first.id);
    await expect(proposeWork(prisma, {
      idempotencyKey: 'same-key', teamId: team.id, title: 'Changed payload',
    })).rejects.toThrow(WORK_IDEMPOTENCY_CONFLICT_MESSAGE);
  });

  it('creates one candidate for concurrent propose retries', async () => {
    const input = { idempotencyKey: 'concurrent-propose', teamId: team.id, title: 'One candidate' };
    const [left, right] = await Promise.all([
      proposeWork(prisma, input),
      proposeWork(prisma, input),
    ]);
    expect(left.id).toBe(right.id);
    expect(await prisma.issue.count({ where: { title: 'One candidate' } })).toBe(1);
  });

  it('commits only with acceptance and a human owner, then allows claim', async () => {
    const candidate = await proposeWork(
      prisma,
      {
        teamId: team.id,
        title: 'Add ready queue',
      },
      { actorId: human.id, actorKind: 'HUMAN', surface: 'test' },
    );

    await expect(
      commitWork(
        prisma,
        candidate.id,
        { expectedRevision: candidate.revision },
        { actorId: human.id, actorKind: 'HUMAN', surface: 'test' },
      ),
    ).rejects.toThrow(WORK_COMMIT_REQUIRES_ACCEPTANCE_MESSAGE);

    const committed = await commitWork(
      prisma,
      candidate.id,
      {
        acceptance: 'readyWork excludes claimed and blocked items',
        assigneeId: human.id,
        expectedRevision: candidate.revision,
      },
      { actorId: human.id, actorKind: 'HUMAN', surface: 'test' },
    );

    expect(committed.commitmentStatus).toBe('COMMITTED');
    expect(committed.assigneeId).toBe(human.id);
    expect(committed.stateId).toBe(ready.id);

    const claimed = await claimWork(
      prisma,
      committed.id,
      {},
      { actorId: agent.id, actorKind: 'AGENT', surface: 'test' },
    );
    expect(claimed.claim.actorId).toBe(agent.id);
    expect(claimed.work.assigneeId).toBe(human.id);

    const readyQueue = await listReadyWork(prisma);
    expect(readyQueue.nodes.map((issue) => issue.id)).not.toContain(committed.id);

    await expect(
      claimWork(
        prisma,
        committed.id,
        {},
        { actorId: human.id, actorKind: 'HUMAN', surface: 'test' },
      ),
    ).rejects.toThrow(WORK_ALREADY_CLAIMED_MESSAGE);

    const refreshed = await claimWork(
      prisma,
      committed.id,
      {},
      { actorId: agent.id, actorKind: 'AGENT', surface: 'test' },
    );
    expect(refreshed.claim.actorId).toBe(agent.id);
    expect(refreshed.claim.leaseUntil.getTime()).toBeGreaterThanOrEqual(
      claimed.claim.leaseUntil.getTime(),
    );
  });

  it('atomically rejects concurrent commits with the same expected revision', async () => {
    const candidate = await proposeWork(prisma, { teamId: team.id, title: 'CAS commit' });
    const mutation = () => commitWork(
      prisma,
      candidate.id,
      { acceptance: 'exactly one commit wins', assigneeId: human.id, expectedRevision: candidate.revision },
      { actorId: human.id, actorKind: 'HUMAN', surface: 'test' },
    );
    const results = await Promise.allSettled([mutation(), mutation()]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toBeDefined();
    expect((rejected as PromiseRejectedResult).reason.message).toMatch(
      new RegExp(`${WORK_REVISION_CONFLICT_MESSAGE}|Only candidate work`),
    );
  });

  it('rejects a human owner who is not a member of the work team', async () => {
    const outsider = await prisma.user.create({
      data: { actorKind: 'HUMAN', email: 'outsider@example.test', name: 'Outsider' },
    });
    const candidate = await proposeWork(prisma, { teamId: team.id, title: 'Team-scoped ownership' });

    await expect(commitWork(
      prisma,
      candidate.id,
      {
        acceptance: 'owner is selected from the work team',
        assigneeId: outsider.id,
        expectedRevision: candidate.revision,
      },
      { actorId: human.id, actorKind: 'HUMAN', surface: 'test' },
    )).rejects.toThrow(WORK_OWNER_MUST_BELONG_TO_TEAM_MESSAGE);
  });

  it('forbids agents from committing and does not treat In Progress as a claim', async () => {
    const candidate = await proposeWork(
      prisma,
      { teamId: team.id, title: 'Agent discovered' },
      { actorId: agent.id, actorKind: 'AGENT', surface: 'codex' },
    );

    await expect(
      commitWork(
        prisma,
        candidate.id,
        {
          acceptance: 'should not commit',
          assigneeId: human.id,
          expectedRevision: candidate.revision,
        },
        { actorId: agent.id, actorKind: 'AGENT', surface: 'codex' },
      ),
    ).rejects.toThrow(WORK_COMMIT_FORBIDDEN_MESSAGE);

    await expect(
      commitWork(
        prisma,
        candidate.id,
        {
          acceptance: 'now a contract',
          assigneeId: human.id,
          expectedRevision: candidate.revision + 1,
        },
        { actorId: human.id, actorKind: 'HUMAN', surface: 'test' },
      ),
    ).rejects.toThrow();

    const committed = await commitWork(
      prisma,
      candidate.id,
      {
        acceptance: 'now a contract',
        assigneeId: human.id,
        expectedRevision: candidate.revision,
      },
      { actorId: human.id, actorKind: 'HUMAN', surface: 'test' },
    );

    await updateIssue(
      prisma,
      committed.id,
      { stateId: inProgress.id },
      { actorId: agent.id, actorKind: 'AGENT', surface: 'mcp' },
    );

    expect(await prisma.workClaim.findUnique({ where: { workId: committed.id } })).toBeNull();
    expect(committed.commitmentStatus).toBe('COMMITTED');
  });

  it('rejects committing work that is already committed', async () => {
    const candidate = await proposeWork(prisma, { teamId: team.id, title: 'Once' });
    await commitWork(
      prisma,
      candidate.id,
      {
        acceptance: 'once',
        assigneeId: human.id,
        expectedRevision: candidate.revision,
      },
      { actorId: human.id, actorKind: 'HUMAN', surface: 'test' },
    );

    await expect(
      commitWork(
        prisma,
        candidate.id,
        {
          acceptance: 'twice',
          assigneeId: human.id,
          expectedRevision: candidate.revision + 1,
        },
        { actorId: human.id, actorKind: 'HUMAN', surface: 'test' },
      ),
    ).rejects.toThrow(WORK_NOT_CANDIDATE_MESSAGE);
  });

  it('rejects candidates without putting them on the ready queue', async () => {
    const candidate = await proposeWork(prisma, {
      teamId: team.id,
      title: 'Noise from a failed probe',
    });

    await expect(
      rejectWork(
        prisma,
        candidate.id,
        { expectedRevision: candidate.revision, reason: 'duplicate of existing work' },
        { actorId: agent.id, actorKind: 'AGENT', surface: 'codex' },
      ),
    ).rejects.toThrow(WORK_REJECT_FORBIDDEN_MESSAGE);

    const rejected = await rejectWork(
      prisma,
      candidate.id,
      { expectedRevision: candidate.revision, reason: 'duplicate of existing work' },
      { actorId: human.id, actorKind: 'HUMAN', surface: 'web' },
    );

    expect(rejected.commitmentStatus).toBe('REJECTED');
    expect(rejected.revision).toBe(candidate.revision + 1);

    const readyQueue = await listReadyWork(prisma);
    expect(readyQueue.nodes.map((issue) => issue.id)).not.toContain(rejected.id);

    await expect(
      rejectWork(
        prisma,
        rejected.id,
        { expectedRevision: rejected.revision },
        { actorId: human.id, actorKind: 'HUMAN', surface: 'web' },
      ),
    ).rejects.toThrow(WORK_NOT_CANDIDATE_MESSAGE);

    const audit = await prisma.workAudit.findFirstOrThrow({
      where: { workId: rejected.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit.reason).toBe('duplicate of existing work');
  });
});

async function resetDatabase(prismaClient: PrismaClient): Promise<void> {
  await prismaClient.comment.deleteMany();
  await prismaClient.issue.deleteMany();
  await prismaClient.workflowState.deleteMany();
  await prismaClient.team.deleteMany();
  await prismaClient.issueLabel.deleteMany();
  await prismaClient.user.deleteMany();
  await prismaClient.legacyLinearMapping.deleteMany();
  await seedDatabase(prismaClient);
}
