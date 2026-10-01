import { PrismaClient as PrismaClientConstructor } from '@prisma/client';
import type { PrismaClient, Team, User, WorkflowState } from '@prisma/client';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ADMIN_EMAIL, DEFAULT_TEAM_KEY, seedDatabase } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import {
  AGENT_DESCRIPTION_REQUIRED_MESSAGE,
  RESEARCH_CLOSE_CLAIMED_MESSAGE,
  RESEARCH_CLOSE_NOT_COMMITTED_MESSAGE,
  RESEARCH_CLOSE_NOT_ISSUE_MESSAGE,
  RESEARCH_INITIAL_DONE_ONLY_MESSAGE,
  WORK_ACCEPT_FORBIDDEN_MESSAGE,
} from './errors.ts';
import { claimWork, commitWork, proposeWork } from './claim-service.ts';
import { updateIssue } from './issue-service.ts';
import { RESEARCH_CLOSE_REASON } from './research-closure.ts';
import { testParentId } from './test-placement.ts';
import type { WriteActor } from './work-service.ts';

loadProjectEnvironment();

const prisma = new PrismaClientConstructor();

const DESCRIPTION = '### 1. 目标与架构定位\n调研。\n### 2. 核心功能与交付范围\n结论。\n### 3. 验收标准与验证方案\n来源固定。';

// INV-912: Type: Research is the one kind of work an agent may move to Done.
describe('research closure (Type: Research)', () => {
  let team: Team;
  let done: WorkflowState;
  let canceled: WorkflowState;
  let review: WorkflowState;
  let human: User;
  let agent: User;
  let otherAgent: User;
  let agentActor: WriteActor;
  let humanActor: WriteActor;

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
    done = await prisma.workflowState.findFirstOrThrow({ where: { teamId: team.id, type: 'COMPLETED' } });
    canceled = await prisma.workflowState.findFirstOrThrow({ where: { teamId: team.id, type: 'CANCELED' } });
    review = await prisma.workflowState.findFirstOrThrow({ where: { teamId: team.id, type: 'REVIEW' } });
    human = await prisma.user.findUniqueOrThrow({ where: { email: DEFAULT_ADMIN_EMAIL } });
    agent = await prisma.user.create({
      data: { actorKind: 'AGENT', email: 'researcher@involute.local', name: 'Researcher', ownerId: human.id },
    });
    otherAgent = await prisma.user.create({
      data: { actorKind: 'AGENT', email: 'other@involute.local', name: 'Other', ownerId: human.id },
    });
    agentActor = { actorId: agent.id, actorKind: 'AGENT', surface: 'mcp' };
    humanActor = { actorId: human.id, actorKind: 'HUMAN', surface: 'graphql' };
  });

  // A MILESTONE sits under the PROJECT, an ISSUE under the milestone.
  async function parentFor(kind: 'ISSUE' | 'MILESTONE'): Promise<string> {
    const milestoneId = await testParentId(prisma, team.id);
    if (kind === 'ISSUE') return milestoneId;
    return (await prisma.issue.findUniqueOrThrow({ where: { id: milestoneId } })).parentId!;
  }

  async function proposeAndCommit(labels: string[], kind: 'ISSUE' | 'MILESTONE' = 'ISSUE') {
    const candidate = await proposeWork(
      prisma,
      { description: DESCRIPTION, kind, labels, parentId: await parentFor(kind), teamId: team.id, title: `Study ${labels.join(',')}` },
      agentActor,
    );
    return commit(candidate);
  }

  function commit(candidate: { id: string; revision: number }, stateId?: string) {
    return commitWork(
      prisma,
      candidate.id,
      { acceptance: 'Findings recorded.', assigneeId: human.id, expectedRevision: candidate.revision, ...(stateId ? { stateId } : {}) },
      humanActor,
    );
  }

  it('lets an agent move a committed research ISSUE to Done and records why', async () => {
    const committed = await proposeAndCommit(['research']);
    const closed = await updateIssue(prisma, committed.id, { stateId: done.id }, agentActor);

    expect(closed.stateId).toBe(done.id);
    const audit = await prisma.workAudit.findFirstOrThrow({ where: { workId: committed.id }, orderBy: { revision: 'desc' } });
    expect(audit).toMatchObject({ actorId: agent.id, actorKind: 'AGENT', reason: RESEARCH_CLOSE_REASON });
    // No human acceptance is invented for an agent's closure.
    expect(await prisma.workReviewDecision.count({ where: { workId: committed.id } })).toBe(0);
  });

  it('matches the research label in any casing', async () => {
    const committed = await proposeAndCommit(['Research']);
    await expect(updateIssue(prisma, committed.id, { stateId: done.id }, agentActor)).resolves.toMatchObject({ stateId: done.id });
  });

  it('keeps every other Type, and untyped work, behind the human gate', async () => {
    for (const labels of [['feature'], ['improvement'], []]) {
      const committed = await proposeAndCommit(labels);
      await expect(updateIssue(prisma, committed.id, { stateId: done.id }, agentActor)).rejects.toThrow(WORK_ACCEPT_FORBIDDEN_MESSAGE);
    }
  });

  it('never lets an agent cancel research', async () => {
    const committed = await proposeAndCommit(['research']);
    await expect(updateIssue(prisma, committed.id, { stateId: canceled.id }, agentActor)).rejects.toThrow(WORK_ACCEPT_FORBIDDEN_MESSAGE);
  });

  it('refuses a research candidate that nobody has committed', async () => {
    const candidate = await proposeWork(
      prisma,
      { description: DESCRIPTION, labels: ['research'], parentId: await testParentId(prisma, team.id), teamId: team.id, title: 'Uncommitted study' },
      agentActor,
    );
    await expect(updateIssue(prisma, candidate.id, { stateId: done.id }, agentActor)).rejects.toThrow(RESEARCH_CLOSE_NOT_COMMITTED_MESSAGE);
  });

  it('refuses research that is not an ISSUE', async () => {
    const committed = await proposeAndCommit(['research'], 'MILESTONE');
    await expect(updateIssue(prisma, committed.id, { stateId: done.id }, agentActor)).rejects.toThrow(RESEARCH_CLOSE_NOT_ISSUE_MESSAGE);
  });

  it('refuses while another actor holds the claim, and allows the holder', async () => {
    const committed = await proposeAndCommit(['research']);
    await claimWork(prisma, committed.id, {}, { actorId: otherAgent.id, actorKind: 'AGENT', surface: 'mcp' });
    await expect(updateIssue(prisma, committed.id, { stateId: done.id }, agentActor)).rejects.toThrow(RESEARCH_CLOSE_CLAIMED_MESSAGE);
    await expect(
      updateIssue(prisma, committed.id, { stateId: done.id }, { actorId: otherAgent.id, actorKind: 'AGENT', surface: 'mcp' }),
    ).resolves.toMatchObject({ stateId: done.id });
  });

  it('refuses research whose record is not the three-section description', async () => {
    const committed = await proposeAndCommit(['research']);
    await prisma.issue.update({ where: { id: committed.id }, data: { description: 'see notes' } });
    await expect(updateIssue(prisma, committed.id, { stateId: done.id }, agentActor)).rejects.toThrow(AGENT_DESCRIPTION_REQUIRED_MESSAGE);
  });

  it('lets a person reopen research an agent closed', async () => {
    const committed = await proposeAndCommit(['research']);
    await updateIssue(prisma, committed.id, { stateId: done.id }, agentActor);
    await expect(updateIssue(prisma, committed.id, { stateId: review.id }, humanActor)).resolves.toMatchObject({ stateId: review.id });
  });

  it('lands a research candidate proposed with initial_state DONE in Done when a person commits it', async () => {
    const candidate = await proposeWork(
      prisma,
      {
        description: DESCRIPTION,
        initialState: 'DONE',
        labels: ['research'],
        parentId: await testParentId(prisma, team.id),
        source: 'agent',
        teamId: team.id,
        title: 'Study that closes on commit',
      },
      agentActor,
    );
    // Uncommitted, it waits in Review, not in Done.
    expect(candidate).toMatchObject({ commitmentStatus: 'CANDIDATE', stateId: review.id, source: 'agent;initial_state=DONE' });

    const committed = await commit(candidate);
    expect(committed).toMatchObject({ commitmentStatus: 'COMMITTED', stateId: done.id, source: 'agent' });
    const decision = await prisma.workReviewDecision.findFirstOrThrow({ where: { workId: candidate.id } });
    expect(decision).toMatchObject({ decision: 'ACCEPTED', reviewerId: human.id });
  });

  it('honours the state a person picks at commit over initial_state DONE', async () => {
    const candidate = await proposeWork(
      prisma,
      { description: DESCRIPTION, initialState: 'DONE', labels: ['research'], parentId: await testParentId(prisma, team.id), teamId: team.id, title: 'Study the person keeps open' },
      agentActor,
    );
    const committed = await commit(candidate, review.id);
    expect(committed.stateId).toBe(review.id);
  });

  it('refuses initial_state DONE for anything that is not a research ISSUE', async () => {
    const parentId = await testParentId(prisma, team.id);
    await expect(
      proposeWork(prisma, { description: DESCRIPTION, initialState: 'DONE', labels: ['feature'], parentId, teamId: team.id, title: 'Feature' }, agentActor),
    ).rejects.toThrow(RESEARCH_INITIAL_DONE_ONLY_MESSAGE);
    await expect(
      proposeWork(prisma, { description: DESCRIPTION, initialState: 'DONE', parentId, teamId: team.id, title: 'Untyped' }, agentActor),
    ).rejects.toThrow(RESEARCH_INITIAL_DONE_ONLY_MESSAGE);
    await expect(
      proposeWork(
        prisma,
        { description: DESCRIPTION, initialState: 'DONE', kind: 'MILESTONE', labels: ['research'], parentId: await parentFor('MILESTONE'), teamId: team.id, title: 'Research milestone' },
        agentActor,
      ),
    ).rejects.toThrow(RESEARCH_INITIAL_DONE_ONLY_MESSAGE);
    await expect(
      proposeWork(prisma, { description: DESCRIPTION, initialState: 'CANCELED', labels: ['research'], parentId, teamId: team.id, title: 'Canceled' }, agentActor),
    ).rejects.toThrow(/cannot be COMPLETED or CANCELED/);
  });
});

async function resetDatabase(prismaClient: PrismaClient): Promise<void> {
  await prismaClient.comment.deleteMany();
  await prismaClient.issue.deleteMany();
  await prismaClient.workflowState.deleteMany();
  await prismaClient.team.deleteMany();
  await prismaClient.issueLabel.deleteMany();
  await prismaClient.actorAudit.deleteMany();
  await prismaClient.user.deleteMany();
  await prismaClient.legacyLinearMapping.deleteMany();
  await seedDatabase(prismaClient);
}
