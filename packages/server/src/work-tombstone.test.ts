import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ADMIN_EMAIL, DEFAULT_TEAM_KEY, seedDatabase } from '../prisma/seed-helpers.ts';
import { createComment, createIssue, deleteIssue } from './issue-service.ts';
import { createWorkLink } from './link-service.ts';
import { restoreDeletedIssue, TOMBSTONE_ID_TAKEN_MESSAGE, TOMBSTONE_NOT_FOUND_MESSAGE } from './work-tombstone.ts';

// INV-840: deleting work leaves a tombstone; restoring puts the same id back
// with its fields, labels, comments, links, children and audit trail.
const prisma = new PrismaClient();
let teamId: string;
let userId: string;
const repo = 'fakechris/Involute';

beforeEach(async () => {
  await prisma.workTombstone.deleteMany();
  await prisma.issue.deleteMany();
  await prisma.workflowState.deleteMany();
  await prisma.team.deleteMany();
  await prisma.issueLabel.deleteMany();
  await prisma.actorAudit.deleteMany();
  await prisma.user.deleteMany();
  await seedDatabase(prisma);
  teamId = (await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } })).id;
  userId = (await prisma.user.findUniqueOrThrow({ where: { email: DEFAULT_ADMIN_EMAIL } })).id;
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe('restoreDeletedIssue', () => {
  it('puts a deleted issue back under its original id with children, comments, labels and links', async () => {
    const project = await createIssue(prisma, { teamId, kind: 'PROJECT', title: 'P', repository: repo });
    const label = await prisma.issueLabel.create({ data: { name: 'restored-label' } });
    const issue = await createIssue(prisma, {
      teamId, kind: 'ISSUE', title: 'Delete me', description: 'kept', priority: 2, repository: repo,
      parentId: project.id, labelIds: [label.id], assigneeId: userId,
    });
    const child = await createIssue(prisma, { teamId, kind: 'ISSUE', title: 'Child', repository: repo, parentId: issue.id });
    const peer = await createIssue(prisma, { teamId, kind: 'ISSUE', title: 'Peer', repository: repo, parentId: project.id });
    await createWorkLink(prisma, { fromId: issue.id, toId: peer.id, type: 'BLOCKS' });
    const root = await createComment(prisma, { issueId: issue.id, body: 'root comment' }, userId);
    await createComment(prisma, { issueId: issue.id, body: 'reply', parentCommentId: root.id }, userId);
    const auditsBefore = await prisma.workAudit.count({ where: { workId: issue.id } });

    await deleteIssue(prisma, issue.id, { actorId: userId, actorKind: 'HUMAN', surface: 'test' });
    expect(await prisma.issue.findUnique({ where: { id: issue.id } })).toBeNull();
    expect((await prisma.issue.findUniqueOrThrow({ where: { id: child.id } })).parentId).toBeNull();
    expect(await prisma.workTombstone.findUnique({ where: { id: issue.id } })).not.toBeNull();

    const restored = await restoreDeletedIssue(prisma, issue.id, { actorId: userId, actorKind: 'HUMAN', surface: 'test' });
    expect(restored.id).toBe(issue.id);
    expect(restored.identifier).toBe(issue.identifier);
    expect(restored.title).toBe('Delete me');
    expect(restored.description).toBe('kept');
    expect(restored.priority).toBe(2);
    expect(restored.parentId).toBe(project.id);
    expect(restored.assigneeId).toBe(userId);
    expect(restored.stateId).toBe(issue.stateId);
    expect(restored.createdAt.getTime()).toBe(issue.createdAt.getTime());

    const full = await prisma.issue.findUniqueOrThrow({
      where: { id: issue.id },
      include: { labels: true, comments: { orderBy: { createdAt: 'asc' } }, children: true, outgoingLinks: true, incomingLinks: true, audits: true },
    });
    expect(full.labels.map((item) => item.name)).toEqual(['restored-label']);
    expect(full.comments.map((comment) => [comment.body, comment.parentCommentId])).toEqual([['root comment', null], ['reply', root.id]]);
    expect(full.children.map((item) => item.id)).toEqual([child.id]);
    expect(full.outgoingLinks.map((link) => [link.type, link.toId])).toEqual(expect.arrayContaining([['BLOCKS', peer.id], ['CONTAINS', child.id]]));
    expect(full.incomingLinks.map((link) => [link.type, link.fromId])).toEqual([['CONTAINS', project.id]]);
    // The old trail is back, plus one row for the restore itself.
    expect(full.audits.length).toBe(auditsBefore + 1);
    expect(await prisma.workTombstone.findUnique({ where: { id: issue.id } })).toBeNull();
  });

  it('refuses when there is nothing to restore or the identifier is taken', async () => {
    const issue = await createIssue(prisma, { teamId, kind: 'ISSUE', title: 'Twice', repository: repo });
    await expect(restoreDeletedIssue(prisma, issue.id)).rejects.toThrow(TOMBSTONE_NOT_FOUND_MESSAGE);
    await deleteIssue(prisma, issue.id);
    await prisma.issue.create({
      data: { identifier: issue.identifier, title: 'Squatter', teamId, stateId: issue.stateId },
    });
    await expect(restoreDeletedIssue(prisma, issue.id)).rejects.toThrow(TOMBSTONE_ID_TAKEN_MESSAGE);
  });

  it('drops a parent that no longer exists instead of failing', async () => {
    const parent = await createIssue(prisma, { teamId, kind: 'ISSUE', title: 'Parent', repository: repo });
    const issue = await createIssue(prisma, { teamId, kind: 'ISSUE', title: 'Orphan-to-be', repository: repo, parentId: parent.id });
    await deleteIssue(prisma, issue.id);
    await deleteIssue(prisma, parent.id);
    const restored = await restoreDeletedIssue(prisma, issue.id);
    expect(restored.parentId).toBeNull();
    expect(await prisma.workLink.count({ where: { toId: issue.id, type: 'CONTAINS' } })).toBe(0);
  });
});
