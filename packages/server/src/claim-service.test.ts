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
  WORK_READY_STATE_MISSING_MESSAGE,
  WORK_REJECT_FORBIDDEN_MESSAGE,
  WORK_REVISION_CONFLICT_MESSAGE,
  WORK_IDEMPOTENCY_CONFLICT_MESSAGE,
  AGENT_DESCRIPTION_REQUIRED_MESSAGE,
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

  it('proposes work with explicit parentId establishing correct CONTAINS hierarchy', async () => {
    const parent = await proposeWork(prisma, {
      kind: 'MILESTONE',
      teamId: team.id,
      title: 'M1: Test Milestone',
    });

    const child = await proposeWork(prisma, {
      kind: 'ISSUE',
      parentId: parent.identifier,
      teamId: team.id,
      title: 'Task under M1',
    });

    expect(child.parentId).toBe(parent.id);

    const link = await prisma.workLink.findFirst({
      where: {
        fromId: parent.id,
        toId: child.id,
        type: 'CONTAINS',
      },
    });
    expect(link).not.toBeNull();
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

  it('refuses to commit when the team has no unstarted state', async () => {
    // Candidates now default to Ready, which would hold an FK reference and
    // block the delete below; park this one in Backlog explicitly instead.
    const candidate = await proposeWork(prisma, { teamId: team.id, title: 'No ready state', initialState: 'BACKLOG' });
    await prisma.workflowState.delete({ where: { id: ready.id } });

    await expect(commitWork(
      prisma,
      candidate.id,
      { acceptance: 'must remain claimable', assigneeId: human.id, expectedRevision: candidate.revision },
      { actorId: human.id, actorKind: 'HUMAN', surface: 'test' },
    )).rejects.toThrow(WORK_READY_STATE_MISSING_MESSAGE);
  });

  it('lists and claims ready committed work of every work kind', async () => {
    const candidate = await proposeWork(prisma, { kind: 'EPIC', teamId: team.id, title: 'Claimable epic' });
    const committed = await commitWork(
      prisma,
      candidate.id,
      { acceptance: 'epic is executable', assigneeId: human.id, expectedRevision: candidate.revision },
      { actorId: human.id, actorKind: 'HUMAN', surface: 'test' },
    );

    expect((await listReadyWork(prisma)).nodes.map((work) => work.id)).toContain(committed.id);
    await expect(claimWork(
      prisma,
      committed.id,
      {},
      { actorId: agent.id, actorKind: 'AGENT', surface: 'test' },
    )).resolves.toMatchObject({ work: { id: committed.id, kind: 'EPIC' } });
  });

  it('forbids agents from committing and does not treat In Progress as a claim', async () => {
    const candidate = await proposeWork(
      prisma,
      {
        teamId: team.id,
        title: 'Agent discovered',
        description: '### 1. 目标与架构定位\n测试定位\n### 2. 核心功能与交付范围\n测试范围\n### 3. 验收标准与验证方案\n测试验证',
      },
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

  describe('defensive title sanitization and agent description gate', () => {
    it('sanitizes status prefixes from titles automatically in proposeWork and updateIssue', async () => {
      const candidate = await proposeWork(prisma, {
        teamId: team.id,
        title: '[已交付] 修复底层通信协议',
      });
      expect(candidate.title).toBe('修复底层通信协议');

      const updated = await updateIssue(prisma, candidate.id, {
        title: '[TODO] 新的工单标题',
        expectedRevision: candidate.revision,
      });
      expect(updated.title).toBe('新的工单标题');
    });

    it('rejects lazy ref docs/... descriptions for all callers', async () => {
      await expect(
        proposeWork(
          prisma,
          { teamId: team.id, title: 'Lazy work', description: 'ref docs/milestones/INV-2.md' },
          { actorId: human.id, actorKind: 'HUMAN', surface: 'web' },
        ),
      ).rejects.toThrow(AGENT_DESCRIPTION_REQUIRED_MESSAGE);
    });

    it('enforces mandatory 3-section Chinese description on AGENT proposals', async () => {
      const agentActor = { actorId: agent.id, actorKind: 'AGENT' as const, surface: 'mcp' };

      // Empty description rejected for agent
      await expect(
        proposeWork(prisma, { teamId: team.id, title: 'Agent work with no desc' }, agentActor),
      ).rejects.toThrow(AGENT_DESCRIPTION_REQUIRED_MESSAGE);

      // Incomplete description missing 3 sections rejected for agent
      await expect(
        proposeWork(
          prisma,
          { teamId: team.id, title: 'Agent work', description: 'Just a short note' },
          agentActor,
        ),
      ).rejects.toThrow(AGENT_DESCRIPTION_REQUIRED_MESSAGE);

      // Valid 3 sections accepted for agent
      const validDesc = [
        '### 1. 目标与架构定位',
        '实现底层通信协议加固',
        '### 2. 核心功能与交付范围',
        '支持 Claim-Scoped Run Resolution',
        '### 3. 验收标准与验证方案',
        'pnpm test 全部通过',
      ].join('\n');

      const proposed = await proposeWork(
        prisma,
        { teamId: team.id, title: 'Agent valid work', description: validDesc },
        agentActor,
      );
      expect(proposed.description).toBe(validDesc);
    });

    it('enforces description gate when updating candidate work as an agent', async () => {
      const agentActor = { actorId: agent.id, actorKind: 'AGENT' as const, surface: 'mcp' };
      const validDesc = [
        '### 1. 目标与架构定位',
        '初始定位',
        '### 2. 核心功能与交付范围',
        '初始范围',
        '### 3. 验收标准与验证方案',
        '初始验证',
      ].join('\n');

      const candidate = await proposeWork(
        prisma,
        { teamId: team.id, title: 'Candidate for update', description: validDesc },
        agentActor,
      );

      // Attempting to bypass by updating to unstructured text is rejected
      await expect(
        updateIssue(
          prisma,
          candidate.id,
          { description: 'bypassed description', expectedRevision: candidate.revision },
          agentActor,
        ),
      ).rejects.toThrow(AGENT_DESCRIPTION_REQUIRED_MESSAGE);

      // Attempting to bypass by updating to ref docs/ is rejected
      await expect(
        updateIssue(
          prisma,
          candidate.id,
          { description: 'ref docs/milestones/INV-2.md', expectedRevision: candidate.revision },
          agentActor,
        ),
      ).rejects.toThrow(AGENT_DESCRIPTION_REQUIRED_MESSAGE);
    });
  });

  describe('candidate initial_state and direct commit workflow', () => {
    it('defaults candidates without initialState to Ready, not the team default Backlog', async () => {
      const candidate = await proposeWork(prisma, {
        teamId: team.id,
        title: 'Work without explicit initial state',
      });

      expect(candidate.stateId).toBe(ready.id);

      const committed = await commitWork(
        prisma,
        candidate.id,
        {
          acceptance: 'Verified',
          assigneeId: human.id,
          expectedRevision: candidate.revision,
        },
        { actorId: human.id, actorKind: 'HUMAN', surface: 'web' },
      );
      expect(committed.stateId).toBe(ready.id);
    });

    it('proposes work with initialState REVIEW and commits directly into REVIEW state', async () => {
      const candidate = await proposeWork(prisma, {
        teamId: team.id,
        title: 'Work targeting review',
        initialState: 'REVIEW',
      });

      const reviewState = await prisma.workflowState.findFirstOrThrow({
        where: { teamId: team.id, type: 'REVIEW' },
      });
      expect(candidate.stateId).toBe(reviewState.id);

      const committed = await commitWork(
        prisma,
        candidate.id,
        {
          acceptance: 'Verified in review',
          assigneeId: human.id,
          expectedRevision: candidate.revision,
        },
        { actorId: human.id, actorKind: 'HUMAN', surface: 'web' },
      );
      expect(committed.commitmentStatus).toBe('COMMITTED');
      expect(committed.stateId).toBe(reviewState.id);
    });

    it('proposes work with initialState STARTED and commits directly into STARTED state', async () => {
      const candidate = await proposeWork(prisma, {
        teamId: team.id,
        title: 'Work targeting started',
        initialState: 'IN_PROGRESS',
      });

      const startedState = await prisma.workflowState.findFirstOrThrow({
        where: { teamId: team.id, type: 'STARTED' },
      });
      expect(candidate.stateId).toBe(startedState.id);

      const committed = await commitWork(
        prisma,
        candidate.id,
        {
          acceptance: 'Verified in progress',
          assigneeId: human.id,
          expectedRevision: candidate.revision,
        },
        { actorId: human.id, actorKind: 'HUMAN', surface: 'web' },
      );
      expect(committed.stateId).toBe(startedState.id);
    });

    it('proposes work with initialState BACKLOG and commits directly into BACKLOG state', async () => {
      const candidate = await proposeWork(prisma, {
        teamId: team.id,
        title: 'Work targeting backlog',
        initialState: 'BACKLOG',
      });

      const backlogState = await prisma.workflowState.findFirstOrThrow({
        where: { teamId: team.id, type: 'BACKLOG' },
      });
      expect(candidate.stateId).toBe(backlogState.id);

      const committed = await commitWork(
        prisma,
        candidate.id,
        {
          acceptance: 'Verified in backlog',
          assigneeId: human.id,
          expectedRevision: candidate.revision,
        },
        { actorId: human.id, actorKind: 'HUMAN', surface: 'web' },
      );
      expect(committed.commitmentStatus).toBe('COMMITTED');
      expect(committed.stateId).toBe(backlogState.id);
    });

    it('rejects proposing candidate with COMPLETED or CANCELED initial_state', async () => {
      await expect(
        proposeWork(prisma, {
          teamId: team.id,
          title: 'Illegal completed proposal',
          initialState: 'COMPLETED',
        }),
      ).rejects.toThrow('Candidate initial_state cannot be COMPLETED or CANCELED');

      await expect(
        proposeWork(prisma, {
          teamId: team.id,
          title: 'Illegal canceled proposal',
          initialState: 'CANCELED',
        }),
      ).rejects.toThrow('Candidate initial_state cannot be COMPLETED or CANCELED');
    });

    it('allows commitWork to explicitly specify stateId override', async () => {
      const candidate = await proposeWork(prisma, {
        teamId: team.id,
        title: 'Default candidate',
      });

      const inProgressState = await prisma.workflowState.findFirstOrThrow({
        where: { teamId: team.id, type: 'STARTED' },
      });

      const committed = await commitWork(
        prisma,
        candidate.id,
        {
          acceptance: 'Verified explicit state',
          assigneeId: human.id,
          expectedRevision: candidate.revision,
          stateId: inProgressState.id,
        },
        { actorId: human.id, actorKind: 'HUMAN', surface: 'web' },
      );
      expect(committed.stateId).toBe(inProgressState.id);
    });
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
