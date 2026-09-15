import { PrismaClient as PrismaClientConstructor } from '@prisma/client';
import type { Issue, PrismaClient, User } from '@prisma/client';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_TEAM_KEY, resetAndSeed } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import { issueAgentCredential } from './agent-credentials.ts';
import { createComment } from './issue-service.ts';
import { syncCommentMentions } from './mention-service.ts';

loadProjectEnvironment();

const prisma = new PrismaClientConstructor();

describe('comment mentions (INV-558 / A2)', () => {
  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  it('writes a CommentMention for @mia and not for @mia inside a code block', async () => {
    const mia = await createAgent(prisma, 'Mia', 'mia');
    const issue = await createIssue(prisma);
    const author = await prisma.user.findFirstOrThrow({ where: { actorKind: 'HUMAN' } });

    const comment = await createComment(
      prisma,
      {
        body: [
          '@mia what was your reasoning on this?',
          '',
          '```ts',
          '// not a mention: @mia',
          '```',
          '',
          'also `@mia` inline is not a mention.',
        ].join('\n'),
        issueId: issue.id,
      },
      author.id,
    );

    const mentions = await prisma.commentMention.findMany({ where: { commentId: comment.id } });

    expect(mentions).toHaveLength(1);
    expect(mentions[0]?.actorId).toBe(mia.id);
  });

  it('writes nothing when every @ is inside code', async () => {
    await createAgent(prisma, 'Mia', 'mia');
    const issue = await createIssue(prisma);
    const author = await prisma.user.findFirstOrThrow({ where: { actorKind: 'HUMAN' } });

    const comment = await createComment(
      prisma,
      { body: '```\n@mia\n```', issueId: issue.id },
      author.id,
    );

    await expect(prisma.commentMention.count({ where: { commentId: comment.id } })).resolves.toBe(0);
  });

  it('resolves only AGENT actors, and ignores unknown handles without failing the write', async () => {
    const mia = await createAgent(prisma, 'Mia', 'mia');
    await prisma.user.create({
      data: { actorKind: 'HUMAN', email: 'dana@test.local', handle: 'dana', name: 'Dana' },
    });
    const issue = await createIssue(prisma);
    const author = await prisma.user.findFirstOrThrow({ where: { actorKind: 'HUMAN' } });

    const comment = await createComment(
      prisma,
      { body: '@mia @dana @nobody-at-all', issueId: issue.id },
      author.id,
    );

    const mentions = await prisma.commentMention.findMany({ where: { commentId: comment.id } });

    expect(mentions.map((mention) => mention.actorId)).toEqual([mia.id]);
  });

  it('records a repeated mention of the same actor exactly once', async () => {
    const mia = await createAgent(prisma, 'Mia', 'mia');
    const issue = await createIssue(prisma);
    const author = await prisma.user.findFirstOrThrow({ where: { actorKind: 'HUMAN' } });

    const comment = await createComment(
      prisma,
      { body: '@mia ping. @Mia again. @MIA once more.', issueId: issue.id },
      author.id,
    );

    const mentions = await prisma.commentMention.findMany({ where: { commentId: comment.id } });

    expect(mentions).toHaveLength(1);
    expect(mentions[0]?.actorId).toBe(mia.id);
  });

  it('syncs by difference: a withdrawn @ is removed, an unchanged one keeps its row', async () => {
    const mia = await createAgent(prisma, 'Mia', 'mia');
    const bob = await createAgent(prisma, 'Bob', 'bob');
    const kai = await createAgent(prisma, 'Kai', 'kai');
    const issue = await createIssue(prisma);
    const author = await prisma.user.findFirstOrThrow({ where: { actorKind: 'HUMAN' } });

    const comment = await createComment(prisma, { body: '@mia @bob', issueId: issue.id }, author.id);
    const before = await prisma.commentMention.findFirstOrThrow({
      where: { actorId: mia.id, commentId: comment.id },
    });

    await syncCommentMentions(prisma, comment.id, '@mia @kai');

    const after = await prisma.commentMention.findMany({ where: { commentId: comment.id } });
    const actorIds = after.map((mention) => mention.actorId).sort();

    expect(actorIds).toEqual([mia.id, kai.id].sort());
    expect(after.find((mention) => mention.actorId === bob.id)).toBeUndefined();
    expect(after.find((mention) => mention.actorId === mia.id)?.id).toBe(before.id);
  });

  it('cascades: deleting the comment removes its mentions', async () => {
    await createAgent(prisma, 'Mia', 'mia');
    const issue = await createIssue(prisma);
    const author = await prisma.user.findFirstOrThrow({ where: { actorKind: 'HUMAN' } });

    const comment = await createComment(prisma, { body: '@mia', issueId: issue.id }, author.id);
    await prisma.comment.delete({ where: { id: comment.id } });

    await expect(prisma.commentMention.count({ where: { commentId: comment.id } })).resolves.toBe(0);
  });

  it('gives every issued agent credential a mentionable handle', async () => {
    const { credential } = await issueAgentCredential(prisma, {
      name: 'Codex Chris Mac',
      teamKey: DEFAULT_TEAM_KEY,
    });
    const user = await prisma.user.findUniqueOrThrow({ where: { id: credential.userId } });

    expect(user.handle).toBe('codex-chris-mac');
  });

  it('suffixes a colliding auto-derived handle instead of failing issuance', async () => {
    const first = await issueAgentCredential(prisma, { name: 'Mia', teamKey: DEFAULT_TEAM_KEY });
    const second = await issueAgentCredential(prisma, { name: 'Mia', teamKey: DEFAULT_TEAM_KEY });

    const firstUser = await prisma.user.findUniqueOrThrow({ where: { id: first.credential.userId } });
    const secondUser = await prisma.user.findUniqueOrThrow({ where: { id: second.credential.userId } });

    expect(firstUser.handle).toBe('mia');
    expect(secondUser.handle).toBe('mia-1');
  });

  it('rejects an explicit handle that is already taken', async () => {
    await createAgent(prisma, 'Mia', 'mia');

    await expect(issueAgentCredential(prisma, {
      handle: 'mia',
      name: 'Impostor',
      teamKey: DEFAULT_TEAM_KEY,
    })).rejects.toThrow('Agent handle already taken: mia.');
  });
});

async function createAgent(
  prismaClient: PrismaClient,
  name: string,
  handle: string,
): Promise<User> {
  return prismaClient.user.create({
    data: {
      actorKind: 'AGENT',
      email: `${handle}@agents.test.local`,
      handle,
      name,
    },
  });
}

async function createIssue(prismaClient: PrismaClient): Promise<Issue> {
  const team = await prismaClient.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
  const state = await prismaClient.workflowState.findFirstOrThrow({
    where: { name: 'Ready', teamId: team.id },
  });

  return prismaClient.issue.create({
    data: {
      identifier: 'INV-900',
      stateId: state.id,
      teamId: team.id,
      title: 'Mention host',
    },
  });
}

async function resetDatabase(prismaClient: PrismaClient): Promise<void> {
  await resetAndSeed(prismaClient);
}
