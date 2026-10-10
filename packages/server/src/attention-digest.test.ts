import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ADMIN_EMAIL, DEFAULT_TEAM_KEY, resetAndSeed } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import { sendAttentionDigests } from './attention-digest.ts';
import { loadAttention, summarizeAttention } from './attention-service.ts';
import { createIssue } from './issue-service.ts';
import { testParentId } from './test-placement.ts';

loadProjectEnvironment();

const prisma = new PrismaClient();
const REPO = 'test/placement';
const DAY = 24 * 60 * 60_000;

/** INV-1094: what has waited too long, what it waits on, and one digest a day of the same list. */
describe('attention: waits, blockers and the daily digest (INV-1094)', () => {
  beforeAll(async () => { await prisma.$connect(); });
  beforeEach(async () => { await resetAndSeed(prisma); });
  afterAll(async () => { await resetAndSeed(prisma); await prisma.$disconnect(); });

  it('marks an item overdue once it has waited past its kind\'s limit', async () => {
    const f = await fixture();
    await createIssue(prisma, { acceptance: 'a', commitmentStatus: 'CANDIDATE', parentId: f.parentId, repository: REPO, teamId: f.team.id, title: 'Waiting' });

    const now = new Date();
    expect((await loadAttention(prisma, f.admin, undefined, {}, now))[0]!.overdue).toBe(false);
    // Candidates may wait three days.
    expect((await loadAttention(prisma, f.admin, undefined, {}, new Date(now.getTime() + 3 * DAY + 60_000)))[0]!.overdue).toBe(true);
  });

  it('says what an item waits on, and flags it once everything before it is finished', async () => {
    const f = await fixture();
    const before = await createIssue(prisma, { acceptance: 'a', assigneeId: f.admin.id, commitmentStatus: 'COMMITTED', parentId: f.parentId, repository: REPO, stateId: f.ready.id, teamId: f.team.id, title: 'First' });
    const after = await createIssue(prisma, { acceptance: 'a', commitmentStatus: 'CANDIDATE', parentId: f.parentId, repository: REPO, teamId: f.team.id, title: 'Second' });
    await prisma.workLink.create({ data: { fromId: before.id, toId: after.id, type: 'BLOCKS' } });

    const [waiting] = await loadAttention(prisma, f.admin, undefined);
    expect(waiting).toMatchObject({ subjectId: after.id, unblocked: false, waitingOnIds: [before.id] });

    const done = await prisma.workflowState.findFirstOrThrow({ where: { teamId: f.team.id, type: 'COMPLETED' } });
    await prisma.issue.update({ where: { id: before.id }, data: { stateId: done.id } });
    const [ready] = await loadAttention(prisma, f.admin, undefined);
    expect(ready).toMatchObject({ subjectId: after.id, unblocked: true, waitingOnIds: [] });
  });

  it('sends one digest a day of what still waits, overdue first, and none when nothing waits', async () => {
    const f = await fixture();
    const now = new Date();
    expect(await sendAttentionDigests(prisma, now)).toBe(0);

    await createIssue(prisma, { acceptance: 'a', commitmentStatus: 'CANDIDATE', parentId: f.parentId, repository: REPO, teamId: f.team.id, title: 'Fresh candidate' });
    const old = await createIssue(prisma, { acceptance: 'a', assigneeId: f.admin.id, commitmentStatus: 'COMMITTED', parentId: f.parentId, repository: REPO, stateId: f.review.id, teamId: f.team.id, title: 'Long in review' });
    await prisma.workAudit.updateMany({ where: { workId: old.id }, data: { createdAt: new Date(now.getTime() - 5 * DAY) } });
    await prisma.issue.update({ where: { id: old.id }, data: { createdAt: new Date(now.getTime() - 5 * DAY), updatedAt: new Date(now.getTime() - 5 * DAY) } });

    expect(await sendAttentionDigests(prisma, now)).toBe(1);
    expect(await sendAttentionDigests(prisma, now)).toBe(0);
    const digest = await prisma.notification.findFirstOrThrow({ where: { type: 'attention.digest', userId: f.admin.id } });
    const payload = digest.payload as { total: number; overdue: number; oldest: Array<{ identifier: string; overdue: boolean }>; byKind: Array<{ kind: string; count: number }>; packs: Array<{ identifier: string; count: number }> };
    const items = await loadAttention(prisma, f.admin, undefined, {}, now);
    expect(payload.total).toBe(summarizeAttention(items).total);
    expect(payload.byKind).toEqual(expect.arrayContaining([{ count: 1, kind: 'CANDIDATE_COMMIT' }, { count: 1, kind: 'WORK_REVIEW' }]));
    expect(payload.oldest[0]).toMatchObject({ identifier: old.identifier, overdue: true });
    expect(payload.overdue).toBe(1);
    expect(payload.packs[0]).toMatchObject({ count: 2 });

    // The next day, again.
    expect(await sendAttentionDigests(prisma, new Date(now.getTime() + DAY + 60_000))).toBe(1);
  });
});

async function fixture() {
  const team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
  const admin = await prisma.user.findUniqueOrThrow({ where: { email: DEFAULT_ADMIN_EMAIL } });
  const states = await prisma.workflowState.findMany({ where: { teamId: team.id } });
  const byType = (type: string) => states.find((state) => state.type === type)!;
  const parentId = await testParentId(prisma, team.id);
  return { admin, parentId, ready: byType('UNSTARTED'), review: byType('REVIEW'), team };
}
