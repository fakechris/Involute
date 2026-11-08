import type { Team, User } from '@prisma/client';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ADMIN_EMAIL, DEFAULT_TEAM_KEY, seedDatabase } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import { claimOwnUnattached, referencedUploadUrls } from './claim-uploads.ts';
import { CAPTURE_MESSAGES } from './bug-capture.ts';
import { createComment, createIssue, updateIssue } from './issue-service.ts';

loadProjectEnvironment();

const prisma = new PrismaClient();

describe('referencedUploadUrls', () => {
  it('reads upload paths out of markdown and absolute URLs, once each', () => {
    expect(referencedUploadUrls('![a](/uploads/a.png) and https://involute.example/uploads/a.png?x=1 ![b](/uploads/b.jpeg)')).toEqual([
      '/uploads/a.png',
      '/uploads/b.jpeg',
    ]);
    expect(referencedUploadUrls(null)).toEqual([]);
  });
});

describe('claiming uploads named in the work', () => {
  let team: Team;
  let admin: User;

  beforeAll(async () => {
    await prisma.$connect();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await prisma.attachment.deleteMany();
    await prisma.comment.deleteMany();
    await prisma.issue.deleteMany();
    await prisma.workflowState.deleteMany();
    await prisma.team.deleteMany();
    await prisma.actorAudit.deleteMany();
    await prisma.user.deleteMany();
    await seedDatabase(prisma);
    team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
    admin = await prisma.user.findUniqueOrThrow({ where: { email: DEFAULT_ADMIN_EMAIL } });
  });

  it('claims the author’s own files from a description and a comment, and leaves someone else’s', async () => {
    await prisma.attachment.create({ data: { filename: 'mine.png', mimeType: 'image/png', size: 1, url: '/uploads/mine.png', uploaderId: admin.id } });
    await prisma.attachment.create({ data: { filename: 'abs.jpeg', mimeType: 'image/jpeg', size: 1, url: '/uploads/abs.jpeg', uploaderId: admin.id } });
    const other = await prisma.user.create({ data: { actorKind: 'HUMAN', email: 'claim-other@involute.local', name: 'Other' } });
    const theirs = await prisma.attachment.create({ data: { filename: 'other.png', mimeType: 'image/png', size: 1, url: '/uploads/other.png', uploaderId: other.id } });
    await prisma.attachment.create({ data: { filename: 'cmt.png', mimeType: 'image/png', size: 1, url: '/uploads/cmt.png', uploaderId: admin.id } });

    const actor = { actorId: admin.id, actorKind: 'HUMAN' as const };
    const issue = await createIssue(prisma, {
      teamId: team.id,
      title: 'With a picture',
      description: '![mine](/uploads/mine.png) https://involute.example/uploads/abs.jpeg ![other](/uploads/other.png)',
    }, actor);

    expect(await prisma.attachment.findFirst({ where: { url: '/uploads/mine.png' } })).toMatchObject({ issueId: issue.id, commentId: null });
    expect(await prisma.attachment.findFirst({ where: { url: '/uploads/abs.jpeg' } })).toMatchObject({ issueId: issue.id });
    expect(await prisma.attachment.findUnique({ where: { id: theirs.id } })).toMatchObject({ issueId: null, commentId: null });

    const comment = await createComment(prisma, { issueId: issue.id, body: '![c](/uploads/cmt.png)' }, admin.id);
    expect(await prisma.attachment.findFirst({ where: { url: '/uploads/cmt.png' } })).toMatchObject({ issueId: issue.id, commentId: comment.id });

    await updateIssue(prisma, issue.id, { description: 'the picture was removed from the text' }, actor);
    expect(await prisma.attachment.findFirst({ where: { url: '/uploads/mine.png' } })).toMatchObject({ issueId: issue.id });

    await expect(claimOwnUnattached(prisma, actor, issue.id, [theirs.id])).rejects.toThrow(CAPTURE_MESSAGES.screenshot);
    expect(await prisma.attachment.findUnique({ where: { id: theirs.id } })).toMatchObject({ issueId: null });
  });
});
