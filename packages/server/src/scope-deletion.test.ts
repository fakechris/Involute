import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { afterAll, expect, it } from 'vitest';

import { DEFAULT_ADMIN_EMAIL, resetAndSeed } from '../prisma/seed-helpers.js';
import { buildReadableDeletionWhere } from './access-control.js';
import { createIssue, deleteIssue, updateIssue } from './issue-service.js';
import { callMcpTool } from './mcp-tools.js';
import { loadMilestoneBurndown } from './scope-query.js';
import { restoreDeletedIssue } from './work-tombstone.js';

// INV-1929: deleting work keeps its scope history for milestone burndown.
const prisma = new PrismaClient();
const at = (day: number) => new Date(Date.UTC(2026, 0, day, 12));
afterAll(() => prisma.$disconnect());

type Point = { scope: number | null; remaining: number | null };
type Event = { workId: string; type: string; effectiveAt: string; source: { auditId: string; surface: string | null } };
type Gap = { workId: string; reason: string; start: string | null; end: string | null };

it('keeps a deleted member in burndown history, reports unrecorded deletions as gaps, and hides deletions from non-readers', async () => {
  await resetAndSeed(prisma);
  const admin = await prisma.user.findUniqueOrThrow({ where: { email: DEFAULT_ADMIN_EMAIL } });
  const member = await prisma.user.create({ data: { name: 'Member', email: 'deletion-member@example.com', globalRole: 'USER' } });
  const outsider = await prisma.user.create({ data: { name: 'Outsider', email: 'deletion-outsider@example.com', globalRole: 'USER' } });
  const team = await prisma.team.create({ data: { key: 'DEL', name: 'Deletion fixture', visibility: 'PRIVATE' } });
  await prisma.teamMembership.create({ data: { teamId: team.id, userId: member.id, role: 'VIEWER' } });
  const todo = await prisma.workflowState.create({ data: { teamId: team.id, name: 'Todo', type: 'UNSTARTED', position: 0 } });
  const actor = { actorId: admin.id, actorKind: 'HUMAN' as const, surface: 'graphql' };
  const repository = 'deletion/fixture';
  const project = await createIssue(prisma, { teamId: team.id, title: 'Project', kind: 'PROJECT', repository }, actor);
  const milestone = await createIssue(prisma, { teamId: team.id, title: 'Milestone', kind: 'MILESTONE', parentId: project.id, repository }, actor);
  const kept = await createIssue(prisma, { teamId: team.id, title: 'Kept', parentId: milestone.id, repository, stateId: todo.id }, actor);
  const deleted = await createIssue(prisma, { teamId: team.id, title: 'Secret deleted title', parentId: milestone.id, repository, stateId: todo.id }, actor);
  await prisma.workAudit.updateMany({ where: { workId: { in: [kept.id, deleted.id] } }, data: { createdAt: at(1) } });

  const args = { action: 'burndown', milestone_id: milestone.id, from: '2026-01-01', to: '2026-01-05' };
  const context = { prisma, viewer: member, authMode: 'session' as const, isTrustedSystem: false };
  const burndown = async (viewer = member) => await callMcpTool({ ...context, viewer }, 'work_timeline', args, true) as {
    points: Point[]; events: Event[]; coverage: { gaps: Gap[]; memberCount: number }; emptyReason: string | null;
  };
  const before = await burndown();
  expect(before.points.map(p => [p.scope, p.remaining])).toEqual([[2, 2], [2, 2], [2, 2], [2, 2], [2, 2]]);

  await deleteIssue(prisma, deleted.id, { ...actor, surface: 'mcp', reason: 'Duplicate' });
  const deletion = await prisma.workDeletion.findFirstOrThrow({ where: { workId: deleted.id } });
  expect(deletion).toMatchObject({ identifier: deleted.identifier, actorId: admin.id, actorKind: 'HUMAN', surface: 'mcp', reason: 'Duplicate', parentIds: [milestone.id] });
  expect(JSON.stringify(deletion)).not.toContain('Secret deleted title');
  await prisma.workDeletion.update({ where: { id: deletion.id }, data: { deletedAt: at(3) } });

  // Ordinary current reads no longer list it.
  expect(await prisma.issue.findUnique({ where: { id: deleted.id } })).toBeNull();
  await expect(callMcpTool(context, 'work_get_context', { id: deleted.id }, true)).rejects.toThrow();

  const after = await burndown();
  expect(after.points.map(p => [p.scope, p.remaining])).toEqual([[2, 2], [2, 2], [1, 1], [1, 1], [1, 1]]);
  expect(after.coverage.memberCount).toBe(2);
  expect(after.events.filter(e => e.workId === deleted.id && e.type === 'REMOVE')).toEqual([
    expect.objectContaining({ effectiveAt: at(3).toISOString(), source: expect.objectContaining({ auditId: deletion.id, surface: 'mcp' }) }),
  ]);

  // A deletion is visible only to readers of its team.
  expect(await prisma.workDeletion.count({ where: buildReadableDeletionWhere({ ...context, viewer: outsider }) })).toBe(0);
  expect(await prisma.workDeletion.count({ where: buildReadableDeletionWhere(context) })).toBe(1);
  await expect(burndown(outsider)).rejects.toThrow('Readable milestone not found.');
  const withoutDeletions = await loadMilestoneBurndown(prisma, {}, { milestoneId: milestone.id, from: '2026-01-01', to: '2026-01-05' });
  expect(withoutDeletions.coverage.memberCount).toBe(1);
  expect(withoutDeletions.events.some(e => e.workId === deleted.id)).toBe(false);

  // Restoring brings it back from the deletion point, without a discontinuity.
  await restoreDeletedIssue(prisma, deleted.id, actor);
  const restore = await prisma.workAudit.findFirstOrThrow({ where: { workId: deleted.id }, orderBy: { createdAt: 'desc' } });
  await prisma.workAudit.update({ where: { id: restore.id }, data: { createdAt: at(4) } });
  expect((await prisma.workDeletion.findUniqueOrThrow({ where: { id: deletion.id } })).restoredAt).not.toBeNull();
  const restored = await burndown();
  expect(restored.points.map(p => [p.scope, p.remaining])).toEqual([[2, 2], [2, 2], [1, 1], [2, 2], [2, 2]]);
  expect(restored.events.filter(e => e.workId === deleted.id).map(e => e.type)).toEqual(['ADD', 'COMMIT', 'REMOVE', 'ADD']);
  expect(restored.coverage.gaps.filter(g => g.workId === deleted.id)).toEqual([]);
});

it('reports a legacy deletion with no recorded history as an explicit coverage gap', async () => {
  await resetAndSeed(prisma);
  const admin = await prisma.user.findUniqueOrThrow({ where: { email: DEFAULT_ADMIN_EMAIL } });
  const team = await prisma.team.create({ data: { key: 'LEG', name: 'Legacy fixture', visibility: 'PRIVATE' } });
  const todo = await prisma.workflowState.create({ data: { teamId: team.id, name: 'Todo', type: 'UNSTARTED', position: 0 } });
  const actor = { actorId: admin.id, actorKind: 'HUMAN' as const, surface: 'graphql' };
  const repository = 'legacy/fixture';
  const project = await createIssue(prisma, { teamId: team.id, title: 'Project', kind: 'PROJECT', repository }, actor);
  const milestone = await createIssue(prisma, { teamId: team.id, title: 'Milestone', kind: 'MILESTONE', parentId: project.id, repository }, actor);
  const moved = await createIssue(prisma, { teamId: team.id, title: 'Moved under a lost epic', parentId: milestone.id, repository, stateId: todo.id }, actor);
  const epic = await createIssue(prisma, { teamId: team.id, title: 'Lost epic', kind: 'EPIC', parentId: project.id, repository }, actor);
  await updateIssue(prisma, moved.id, { parentId: epic.id }, actor);
  await prisma.workAudit.updateMany({ where: { workId: moved.id, revision: 1 }, data: { createdAt: at(1) } });
  await prisma.workAudit.updateMany({ where: { workId: moved.id, revision: 2 }, data: { createdAt: at(2) } });
  // Before INV-1929 a deletion left nothing behind.
  await prisma.issue.update({ where: { id: moved.id }, data: { parentId: null } });
  await prisma.issue.delete({ where: { id: epic.id } });
  // A backfilled deletion whose audit trail was already gone.
  const ghost = randomUUID();
  await prisma.workDeletion.create({
    data: {
      workId: ghost, teamId: team.id, identifier: 'LEG-99', parentIds: [milestone.id], audits: [],
      final: { parentId: milestone.id, commitmentStatus: 'COMMITTED', stateId: todo.id, kind: 'ISSUE' },
      revision: 1, actorKind: 'HUMAN', deletedAt: at(3),
    },
  });

  const result = await loadMilestoneBurndown(prisma, {}, { milestoneId: milestone.id, from: '2026-01-01', to: '2026-01-04' }, {});
  expect(result.coverage.status).toBe('NONE');
  expect(result.coverage.gaps).toEqual(expect.arrayContaining([
    { workId: moved.id, reason: 'DELETED_WITHOUT_HISTORY', start: at(2), end: null },
    { workId: ghost, reason: 'DELETED_WITHOUT_HISTORY', start: null, end: at(3) },
  ]));
  expect(result.points.map(p => p.scope)).toEqual([null, null, null, null]);
});
