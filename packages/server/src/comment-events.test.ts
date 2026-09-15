import { PrismaClient as PrismaClientConstructor } from '@prisma/client';
import type { Issue, PrismaClient, User } from '@prisma/client';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_TEAM_KEY, resetAndSeed } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import { WORK_EVENT_TYPES } from './event-outbox.ts';
import { createComment } from './issue-service.ts';

loadProjectEnvironment();

const prisma = new PrismaClientConstructor();

interface CommentEventPayload {
  data: {
    comment?: { body: string; id: string; rootCommentId: string };
    mentionedActorIds?: string[];
    promptContext?: string;
    speaker?: { actorId: string; actorKind: string | null; handle: string | null };
    target?: { actorId: string; handle: string };
  };
  type: string;
  work: { id: string; identifier: string };
}

describe('comment events (INV-559)', () => {
  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  it('registers both new event types on the existing outbox contract', () => {
    expect(WORK_EVENT_TYPES).toContain('comment.created');
    expect(WORK_EVENT_TYPES).toContain('agent.mentioned');
  });

  it('emits comment.created for every comment, with no mention events when nobody is mentioned', async () => {
    const issue = await createIssue(prisma);
    const author = await humanAuthor(prisma);

    const comment = await createComment(prisma, { body: 'just a note', issueId: issue.id }, author.id);
    const events = await readEvents(prisma);

    expect(events.map((event) => event.type)).toEqual(['comment.created']);
    expect(events[0]?.data.comment?.id).toBe(comment.id);
    expect(events[0]?.data.comment?.rootCommentId).toBe(comment.id);
    expect(events[0]?.data.mentionedActorIds).toEqual([]);
    expect(events[0]?.work.identifier).toBe(issue.identifier);
  });

  it('emits one agent.mentioned per mentioned actor, addressed to that actor', async () => {
    const mia = await createAgent(prisma, 'Mia', 'mia');
    const bob = await createAgent(prisma, 'Bob', 'bob');
    const issue = await createIssue(prisma);
    const author = await humanAuthor(prisma);

    await createComment(prisma, { body: '@mia @bob thoughts?', issueId: issue.id }, author.id);
    const events = await readEvents(prisma);
    const mentionEvents = events.filter((event) => event.type === 'agent.mentioned');

    expect(events.filter((event) => event.type === 'comment.created')).toHaveLength(1);
    expect(mentionEvents).toHaveLength(2);
    expect(mentionEvents.map((event) => event.data.target?.actorId).sort())
      .toEqual([mia.id, bob.id].sort());
    expect(mentionEvents.map((event) => event.data.target?.handle).sort())
      .toEqual(['bob', 'mia']);
  });

  it('does not emit agent.mentioned for an @ that only appears inside code', async () => {
    await createAgent(prisma, 'Mia', 'mia');
    const issue = await createIssue(prisma);
    const author = await humanAuthor(prisma);

    await createComment(prisma, { body: '```\n@mia\n```', issueId: issue.id }, author.id);
    const events = await readEvents(prisma);

    expect(events.map((event) => event.type)).toEqual(['comment.created']);
  });

  it('ships an assembled promptContext so the consumer does not have to collect it', async () => {
    await createAgent(prisma, 'Mia', 'mia');
    const issue = await createIssue(prisma, {
      acceptance: 'A2: mention inside a code block is not recorded.',
      description: 'Resolve @handles server-side.',
    });
    const author = await humanAuthor(prisma);

    const run = await prisma.workRun.create({
      data: {
        phase: 'implement',
        publicId: 'RUN-901',
        status: 'COMPLETED',
        summary: 'parser landed',
        workId: issue.id,
      },
    });
    await prisma.workEvidence.create({
      data: {
        kind: 'PR',
        runId: run.id,
        summary: 'B1 PR',
        url: 'https://github.com/fakechris/Involute/pull/77',
        workId: issue.id,
      },
    });

    await createComment(prisma, { body: '@mia why?', issueId: issue.id }, author.id);
    const mention = (await readEvents(prisma)).find((event) => event.type === 'agent.mentioned');
    const promptContext = mention?.data.promptContext ?? '';

    expect(promptContext).toContain(issue.identifier);
    expect(promptContext).toContain('## Contract');
    expect(promptContext).toContain('Resolve @handles server-side.');
    expect(promptContext).toContain('## Acceptance');
    expect(promptContext).toContain('A2: mention inside a code block is not recorded.');
    expect(promptContext).toContain('parser landed');
    expect(promptContext).toContain('https://github.com/fakechris/Involute/pull/77');
    expect(promptContext.length).toBeLessThanOrEqual(8_000);
  });

  it('identifies the speaker, so an agent reply is attributable to that agent', async () => {
    await createAgent(prisma, 'Mia', 'mia');
    const codex = await createAgent(prisma, 'Codex', 'codex');
    const issue = await createIssue(prisma);

    await createComment(prisma, { body: '@mia answering for you', issueId: issue.id }, codex.id);
    const events = await readEvents(prisma);

    for (const event of events) {
      expect(event.data.speaker?.actorId).toBe(codex.id);
      expect(event.data.speaker?.actorKind).toBe('AGENT');
      expect(event.data.speaker?.handle).toBe('codex');
    }
  });

  it('rolls the events back with the comment when the transaction fails', async () => {
    await createAgent(prisma, 'Mia', 'mia');

    await expect(createComment(
      prisma,
      { body: '@mia', issueId: '00000000-0000-0000-0000-000000000000' },
      (await humanAuthor(prisma)).id,
    )).rejects.toThrow();

    await expect(prisma.eventOutbox.count()).resolves.toBe(0);
    await expect(prisma.comment.count()).resolves.toBe(0);
  });
});

async function readEvents(prismaClient: PrismaClient): Promise<CommentEventPayload[]> {
  const events = await prismaClient.eventOutbox.findMany({
    where: { type: { in: ['agent.mentioned', 'comment.created'] } },
    orderBy: { createdAt: 'asc' },
  });
  return events.map((event) => event.payload as unknown as CommentEventPayload);
}

async function humanAuthor(prismaClient: PrismaClient): Promise<User> {
  return prismaClient.user.findFirstOrThrow({ where: { actorKind: 'HUMAN' } });
}

async function createAgent(
  prismaClient: PrismaClient,
  name: string,
  handle: string,
): Promise<User> {
  return prismaClient.user.create({
    data: { actorKind: 'AGENT', email: `${handle}@agents.test.local`, handle, name },
  });
}

async function createIssue(
  prismaClient: PrismaClient,
  extra: { acceptance?: string; description?: string } = {},
): Promise<Issue> {
  const team = await prismaClient.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
  const state = await prismaClient.workflowState.findFirstOrThrow({
    where: { name: 'Ready', teamId: team.id },
  });

  return prismaClient.issue.create({
    data: {
      identifier: 'INV-901',
      stateId: state.id,
      teamId: team.id,
      title: 'Mention host',
      ...extra,
    },
  });
}

async function resetDatabase(prismaClient: PrismaClient): Promise<void> {
  await resetAndSeed(prismaClient);
}
