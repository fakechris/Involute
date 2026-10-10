import { PrismaClient as PrismaClientConstructor } from '@prisma/client';
import type { Team, User, WorkflowState } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ADMIN_EMAIL, DEFAULT_TEAM_KEY, seedDatabase } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import { commitWork, proposeWork } from './claim-service.ts';
import { updateIssue } from './issue-service.ts';
import { readUnreadNotifications } from './notification-service.ts';
import { loadReviewWaits, sweepOverdueReviews } from './review-wait.ts';
import { testParentId } from './test-placement.ts';

loadProjectEnvironment();
const prisma = new PrismaClientConstructor();
const DAY = 86_400_000;
const DESCRIPTION = '### 1. 目标与架构定位\nx\n### 2. 核心功能与交付范围\nx\n### 3. 验收标准与验证方案\nx';

// INV-1002: a fixed bug waiting in Review has its own clock; owners get a daily digest.
describe('review wait clock and digest (INV-1002)', () => {
  let team: Team;
  let human: User;
  let review: WorkflowState;
  const humanActor = () => ({ actorId: human.id, actorKind: 'HUMAN' as const, surface: 'test' });

  beforeAll(async () => { await prisma.$connect(); });
  afterAll(async () => { await prisma.$disconnect(); });
  beforeEach(async () => {
    await prisma.notification.deleteMany();
    await prisma.eventOutbox.deleteMany();
    await prisma.bugSlaAlert.deleteMany();
    await prisma.comment.deleteMany();
    await prisma.issue.deleteMany();
    await prisma.workflowState.deleteMany();
    await prisma.team.deleteMany();
    await prisma.issueLabel.deleteMany();
    await prisma.actorAudit.deleteMany();
    await prisma.user.deleteMany();
    await seedDatabase(prisma);
    team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
    human = await prisma.user.findUniqueOrThrow({ where: { email: DEFAULT_ADMIN_EMAIL } });
    review = await prisma.workflowState.findFirstOrThrow({ where: { teamId: team.id, type: 'REVIEW' } });
  });

  async function inReview(title: string, labels: string[] = []) {
    const parentId = await testParentId(prisma, team.id);
    const created = await proposeWork(prisma, { parentId, teamId: team.id, title, labels, description: DESCRIPTION, ...(labels.includes('bug') ? { priority: 3, stepsToReproduce: 'Open it.', acceptance: 'Fixed.' } : {}) }, humanActor());
    const committed = created.commitmentStatus === 'COMMITTED' ? created : await commitWork(prisma, created.id, { acceptance: 'Done.', assigneeId: human.id, expectedRevision: created.revision }, humanActor());
    return updateIssue(prisma, committed.id, { stateId: review.id, expectedRevision: committed.revision }, humanActor());
  }

  it('measures the current Review spell and flags only bugs past the threshold', async () => {
    const bug = await inReview('Crash on save', ['bug']);
    const feature = await inReview('Nicer board');
    const now = new Date(Date.now() + 4 * DAY);
    const waits = await loadReviewWaits(prisma, [bug.id, feature.id], now);
    expect(waits.get(bug.id)).toMatchObject({ overdue: true });
    expect(waits.get(bug.id)!.waitMs).toBeGreaterThanOrEqual(4 * DAY - 60_000);
    expect(waits.get(feature.id)).toMatchObject({ overdue: false });
    expect((await loadReviewWaits(prisma, [bug.id], new Date(Date.now() + DAY))).get(bug.id)).toMatchObject({ overdue: false });
  });

  it('tells the owner once per spell that a fixed bug is overdue, and again after it comes back to Review', async () => {
    const bug = await inReview('Crash on save', ['bug']);
    const later = new Date(Date.now() + 4 * DAY);
    expect(await sweepOverdueReviews(prisma, later)).toBe(1);
    expect(await sweepOverdueReviews(prisma, later)).toBe(0);
    const inbox = await readUnreadNotifications(prisma, { first: 10, since: null, teamId: null, userId: human.id });
    const overdue = inbox.filter((row) => row.type === 'review.overdue');
    expect(overdue).toHaveLength(1);
    expect(overdue[0]!.payload).toMatchObject({ identifier: bug.identifier, waitDays: 4, thresholdDays: 3 });
    expect(await prisma.eventOutbox.count({ where: { type: 'review.overdue' } })).toBe(1);

    // Returned for changes, then back in Review: a fresh clock, a fresh notice.
    const ready = await prisma.workflowState.findFirstOrThrow({ where: { teamId: team.id, type: 'UNSTARTED' } });
    const fresh = await prisma.issue.findUniqueOrThrow({ where: { id: bug.id } });
    const back = await updateIssue(prisma, bug.id, { stateId: ready.id, expectedRevision: fresh.revision }, humanActor());
    expect(await sweepOverdueReviews(prisma, later)).toBe(0);
    await updateIssue(prisma, bug.id, { stateId: review.id, expectedRevision: back.revision }, humanActor());
    expect(await sweepOverdueReviews(prisma, new Date(Date.now() + 8 * DAY))).toBe(1);
  });

});
