import { PrismaClient } from '@prisma/client';
import type { Issue, User } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ADMIN_EMAIL, DEFAULT_TEAM_KEY, resetAndSeed } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import { setActorSuccessor } from './actor-lifecycle.ts';
import {
  answerAgentRequest,
  answerAgentRequestAsHuman,
  claimAgentRequest,
  replyToAgentRequest,
} from './agent-request-service.ts';
import { createComment } from './issue-service.ts';

loadProjectEnvironment();
const prisma = new PrismaClient();

describe('asking back and replying to a request (INV-794)', () => {
  let admin: User;
  let asker: User;
  let mia: User;
  let issue: Issue;

  beforeEach(async () => {
    await resetAndSeed(prisma);
    admin = await prisma.user.findUniqueOrThrow({ where: { email: DEFAULT_ADMIN_EMAIL } });
    asker = await prisma.user.create({ data: { actorKind: 'HUMAN', email: 'asker@test.local', name: 'Asker' } });
    mia = await prisma.user.create({ data: { actorKind: 'AGENT', email: 'mia@agents.test.local', handle: 'mia', name: 'Mia' } });
    const team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
    const state = await prisma.workflowState.findFirstOrThrow({ where: { name: 'Ready', teamId: team.id } });
    issue = await prisma.issue.create({ data: { identifier: 'INV-903', stateId: state.id, teamId: team.id, title: 'Request host' } });
  });

  afterAll(async () => {
    // ActorAudit rows reference users with Restrict; leave none behind.
    await resetAndSeed(prisma);
    await prisma.$disconnect();
  });

  async function askedBack() {
    await createComment(prisma, { body: '@mia which option?', issueId: issue.id }, asker.id);
    const request = await prisma.agentRequest.findFirstOrThrow({ where: { targetActorId: mia.id } });
    const held = await claimAgentRequest(prisma, { actorId: mia.id, id: request.id });
    await answerAgentRequest(prisma, { actorId: mia.id, body: 'A or B?', claimToken: held.claimToken, id: request.id, state: 'input-required' });
    return request;
  }

  it('tells the person who asked that the agent asked back', async () => {
    const request = await askedBack();
    const notification = await prisma.notification.findFirstOrThrow({ where: { type: 'agent.request_input_required' } });
    expect(notification).toMatchObject({ userId: asker.id, workId: issue.id });
    expect(await prisma.eventOutbox.count({ where: { type: 'agent.request_input_required' } })).toBe(1);
    expect((await prisma.agentRequest.findUniqueOrThrow({ where: { id: request.id } })).state).toBe('INPUT_REQUIRED');
  });

  it('lets the person who asked reply, which hands the request back to the agent', async () => {
    const request = await askedBack();
    const replied = await replyToAgentRequest(prisma, {
      id: request.id,
      body: 'Option B.',
      by: { actorId: asker.id, actorKind: 'HUMAN', globalRole: 'USER' },
    });
    expect(replied).toMatchObject({ state: 'SUBMITTED', answeredCommentId: null });
    const comment = await prisma.comment.findFirstOrThrow({ where: { body: 'Option B.' } });
    expect(comment).toMatchObject({ userId: asker.id, parentCommentId: request.rootCommentId });
    expect(await prisma.eventOutbox.count({ where: { type: 'agent.request_replied' } })).toBe(1);

    // Only once: it is no longer waiting on the asker.
    await expect(
      replyToAgentRequest(prisma, { id: request.id, body: 'again', by: { actorId: asker.id, actorKind: 'HUMAN', globalRole: 'USER' } }),
    ).rejects.toThrow(/asked back/i);
  });

  it('refuses anyone else, and an admin only with a reason', async () => {
    const request = await askedBack();
    const other = await prisma.user.create({ data: { actorKind: 'HUMAN', email: 'other@test.local', name: 'Other' } });
    await expect(
      replyToAgentRequest(prisma, { id: request.id, body: 'x', by: { actorId: other.id, actorKind: 'HUMAN', globalRole: 'USER' } }),
    ).rejects.toThrow(/Only the person who asked/);
    await expect(
      replyToAgentRequest(prisma, { id: request.id, body: 'x', by: { actorId: mia.id, actorKind: 'AGENT', globalRole: 'USER' } }),
    ).rejects.toThrow(/Only the person who asked/);
    await expect(
      replyToAgentRequest(prisma, { id: request.id, body: 'x', by: { actorId: admin.id, actorKind: 'HUMAN', globalRole: 'ADMIN' } }),
    ).rejects.toThrow(/override reason/);
    const replied = await replyToAgentRequest(prisma, {
      id: request.id,
      body: 'B, per the call',
      by: { actorId: admin.id, actorKind: 'HUMAN', globalRole: 'ADMIN' },
      overrideReason: 'Asker is out today',
    });
    expect(replied.state).toBe('SUBMITTED');
  });

  it('lets a person answer with "cannot do it" or by asking back, and asking back reaches the asker', async () => {
    const human = await prisma.user.create({ data: { actorKind: 'HUMAN', email: 'target@test.local', handle: 'target', name: 'Target' } });
    await createComment(prisma, { body: '@mia thoughts?', issueId: issue.id }, asker.id);
    const request = await prisma.agentRequest.findFirstOrThrow({ where: { targetActorId: mia.id } });
    // Handed to a person, as a handoff does.
    await prisma.agentRequest.update({ where: { id: request.id }, data: { targetActorId: human.id } });
    const by = { actorId: human.id, actorKind: 'HUMAN' as const, globalRole: 'USER' as const };

    const asked = await answerAgentRequestAsHuman(prisma, { id: request.id, body: 'Which release?', by, state: 'input-required' });
    expect(asked.request.state).toBe('INPUT_REQUIRED');
    // Nobody closes it while it waits on the asker's reply.
    await expect(answerAgentRequestAsHuman(prisma, { id: request.id, body: 'Never mind', by, state: 'failed' })).rejects.toThrow(/waiting for the reply/);
    expect(await prisma.notification.count({ where: { type: 'agent.request_input_required', userId: asker.id } })).toBe(1);

    await replyToAgentRequest(prisma, { id: request.id, body: 'The next one.', by: { actorId: asker.id, actorKind: 'HUMAN', globalRole: 'USER' } });
    const failed = await answerAgentRequestAsHuman(prisma, { id: request.id, body: 'Not something I can decide.', by, state: 'failed' });
    expect(failed.request.state).toBe('FAILED');
  });
});

describe('declaring a successor (INV-794)', () => {
  let admin: User;
  let mia: User;
  let codex: User;

  beforeEach(async () => {
    await resetAndSeed(prisma);
    admin = await prisma.user.findUniqueOrThrow({ where: { email: DEFAULT_ADMIN_EMAIL } });
    mia = await prisma.user.create({ data: { actorKind: 'AGENT', email: 'mia@agents.test.local', handle: 'mia', name: 'Mia' } });
    codex = await prisma.user.create({ data: { actorKind: 'AGENT', email: 'codex@agents.test.local', handle: 'codex', name: 'Codex' } });
  });

  it('is set by a person, audited, and cleared with null', async () => {
    const set = await setActorSuccessor(prisma, { actorId: mia.id, by: { actorId: admin.id, actorKind: 'HUMAN' }, successorId: codex.id });
    expect(set.successorActorId).toBe(codex.id);
    expect(await prisma.actorAudit.findFirstOrThrow({ where: { subjectId: mia.id, action: 'successor-set' } })).toMatchObject({
      byActorId: admin.id,
    });
    const cleared = await setActorSuccessor(prisma, { actorId: mia.id, by: { actorId: admin.id, actorKind: 'HUMAN' }, successorId: null });
    expect(cleared.successorActorId).toBeNull();
  });

  it('refuses agents, the actor itself and deactivated successors', async () => {
    await expect(
      setActorSuccessor(prisma, { actorId: mia.id, by: { actorId: codex.id, actorKind: 'AGENT' }, successorId: codex.id }),
    ).rejects.toThrow(/Only a human/);
    await expect(
      setActorSuccessor(prisma, { actorId: mia.id, by: { actorId: admin.id, actorKind: 'HUMAN' }, successorId: mia.id }),
    ).rejects.toThrow();
    await prisma.user.update({ where: { id: codex.id }, data: { deactivatedAt: new Date() } });
    await expect(
      setActorSuccessor(prisma, { actorId: mia.id, by: { actorId: admin.id, actorKind: 'HUMAN' }, successorId: codex.id }),
    ).rejects.toThrow();
  });
});
