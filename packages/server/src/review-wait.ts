import type { Prisma, PrismaClient } from '@prisma/client';

import { BUG_LABEL_NAME } from './bug-report.js';
import { enqueueWorkEvent } from './event-outbox.js';
import { loadWorkTimelines } from './work-timeline.js';

type DatabaseClient = PrismaClient | Prisma.TransactionClient;

const DAY = 24 * 60 * 60_000;
/** How long a fixed bug may wait in Review before its owner is told (INV-1002). */
export const DEFAULT_REVIEW_OVERDUE_MS = 3 * DAY;
export function reviewOverdueMs(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(env.REVIEW_OVERDUE_MS);
  return Number.isFinite(configured) && configured >= 60 * 60_000 ? configured : DEFAULT_REVIEW_OVERDUE_MS;
}
const REVIEW_OVERDUE_KIND = 'REVIEW_OVERDUE';

export interface ReviewWait {
  /** Entry into the current Review spell. */
  since: Date;
  waitMs: number;
  /** A bug waited longer than the review clock allows (the SLA clock is a different one, paused in Review). */
  overdue: boolean;
  thresholdMs: number;
}

const BUG_WHERE = { labels: { some: { name: { equals: BUG_LABEL_NAME, mode: 'insensitive' as const } } } };

/**
 * How long committed work in Review has been waiting for a person (INV-1002).
 * The bug SLA stops in Review by design; this is the other clock — the one
 * that says how long the person has been sitting on a finished fix.
 */
export async function loadReviewWaits(prisma: DatabaseClient, issueIds: string[], now = new Date(), thresholdMs = reviewOverdueMs()): Promise<Map<string, ReviewWait>> {
  if (issueIds.length === 0) return new Map();
  const items = await prisma.issue.findMany({
    where: { id: { in: issueIds }, commitmentStatus: 'COMMITTED', state: { type: 'REVIEW' } },
    select: { id: true, stateId: true, commitmentStatus: true, updatedAt: true, createdAt: true, labels: { select: { name: true } } },
  });
  const timelines = new Map((await loadWorkTimelines(prisma, items)).map((entry) => [entry.workId, entry]));
  const waits = new Map<string, ReviewWait>();
  for (const item of items) {
    const timeline = timelines.get(item.id);
    // The current Review spell: the last entry into Review, not the first ever.
    const since = timeline?.transitions.filter((transition) => transition.stateType === 'REVIEW').at(-1)?.at ?? timeline?.reviewAt ?? item.updatedAt;
    const waitMs = Math.max(0, now.getTime() - since.getTime());
    const isBug = item.labels.some((label) => label.name.toLowerCase() === BUG_LABEL_NAME.toLowerCase());
    waits.set(item.id, { since, waitMs, overdue: isBug && waitMs >= thresholdMs, thresholdMs });
  }
  return waits;
}

/**
 * Once per Review spell, tell the owner a fixed bug has waited past the review
 * clock: `review.overdue` to the outbox and the owner's inbox. The marker is
 * removed when the bug leaves Review, so a second spell is reported again.
 */
export async function sweepOverdueReviews(prisma: PrismaClient, now = new Date(), thresholdMs = reviewOverdueMs()): Promise<number> {
  // A bug that left Review and came back starts a fresh clock.
  await prisma.bugSlaAlert.deleteMany({ where: { kind: REVIEW_OVERDUE_KIND, work: { state: { type: { not: 'REVIEW' } } } } });
  const waiting = await prisma.issue.findMany({ where: { commitmentStatus: 'COMMITTED', state: { type: 'REVIEW' }, ...BUG_WHERE }, select: { id: true } });
  const waits = await loadReviewWaits(prisma, waiting.map((item) => item.id), now, thresholdMs);
  let sent = 0;
  for (const [workId, wait] of waits) {
    if (!wait.overdue) continue;
    sent += await prisma.$transaction(async (tx) => {
      const inserted = await tx.bugSlaAlert.createMany({ data: [{ workId, kind: REVIEW_OVERDUE_KIND }], skipDuplicates: true });
      if (inserted.count === 0) return 0;
      const work = await tx.issue.findUniqueOrThrow({ where: { id: workId } });
      const payload = { identifier: work.identifier, title: work.title, priority: work.priority, waitingSince: wait.since.toISOString(), waitDays: Math.floor(wait.waitMs / DAY), thresholdDays: Math.round(thresholdMs / DAY) };
      const event = await enqueueWorkEvent(tx, { payload, type: 'review.overdue', workId: work.id, workIdentifier: work.identifier });
      const owner = work.assigneeId ? await tx.user.findUnique({ where: { id: work.assigneeId, actorKind: 'HUMAN' }, select: { id: true } }) : null;
      if (owner) await tx.notification.createMany({ data: [{ payload, sourceEventId: event.id, teamId: work.teamId, type: 'review.overdue', userId: owner.id, workId: work.id }], skipDuplicates: true });
      return 1;
    });
  }
  return sent;
}

/**
 * One `review.digest` inbox note per owner per day while they have committed
 * work waiting in Review: how many, and the longest wait. The existing email
 * digest mails it with everything else unread.
 */
export async function sendReviewDigests(prisma: PrismaClient, now = new Date()): Promise<number> {
  const waiting = await prisma.issue.findMany({
    where: { commitmentStatus: 'COMMITTED', state: { type: 'REVIEW' }, assignee: { actorKind: 'HUMAN', deactivatedAt: null } },
    select: { id: true, identifier: true, title: true, assigneeId: true, teamId: true },
  });
  const waits = await loadReviewWaits(prisma, waiting.map((item) => item.id), now);
  const byOwner = new Map<string, typeof waiting>();
  for (const item of waiting) byOwner.set(item.assigneeId!, [...(byOwner.get(item.assigneeId!) ?? []), item]);
  let sent = 0;
  for (const [userId, items] of byOwner) {
    const recent = await prisma.notification.findFirst({ where: { userId, type: 'review.digest', createdAt: { gt: new Date(now.getTime() - DAY) } }, select: { id: true } });
    if (recent) continue;
    const longest = items.map((item) => ({ item, wait: waits.get(item.id) })).filter((entry) => entry.wait).sort((a, b) => b.wait!.waitMs - a.wait!.waitMs)[0];
    if (!longest) continue;
    const payload = {
      count: items.length,
      overdue: items.filter((item) => waits.get(item.id)?.overdue).length,
      longestIdentifier: longest.item.identifier,
      longestTitle: longest.item.title,
      longestWaitDays: Math.floor(longest.wait!.waitMs / DAY),
      identifiers: items.map((item) => item.identifier).slice(0, 20),
    };
    await prisma.notification.create({ data: { payload, teamId: longest.item.teamId, type: 'review.digest', userId, workId: longest.item.id, createdAt: now } });
    sent += 1;
  }
  return sent;
}
