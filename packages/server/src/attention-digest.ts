import type { PrismaClient } from '@prisma/client';

import { buildReadableIssueWhere } from './access-control.js';
import { type AttentionItem, loadAttention, summarizeAttention } from './attention-service.js';
import type { GraphQLContext } from './auth.js';
import { resolveShareScope } from './project-sharing.js';

const DAY = 24 * 60 * 60_000;
const OLDEST_LISTED = 3;
const PACKS_LISTED = 5;

/**
 * One `attention.digest` note per person per day (INV-1094): what is still
 * waiting on their decision — counts by kind, the three that have waited
 * longest (overdue first), and the work trees with the most waiting. Nothing
 * waiting, nothing sent. It is the same list as Needs you, so the digest and
 * the queue never disagree; it replaces the Review-only `review.digest`.
 * The email sweep mails it like any other unread notification.
 */
export async function sendAttentionDigests(prisma: PrismaClient, now = new Date()): Promise<number> {
  const people = await prisma.user.findMany({ where: { actorKind: 'HUMAN', deactivatedAt: null } });
  let sent = 0;
  for (const person of people) {
    const recent = await prisma.notification.findFirst({
      where: { createdAt: { gt: new Date(now.getTime() - DAY) }, type: 'attention.digest', userId: person.id },
      select: { id: true },
    });
    if (recent) continue;
    const context: GraphQLContext = {
      authMode: 'session',
      isTrustedSystem: false,
      prisma,
      shareScope: await resolveShareScope(prisma, person.id),
      viewer: person,
    };
    const items = await loadAttention(prisma, person, buildReadableIssueWhere(context), {}, now);
    if (items.length === 0) continue;
    await prisma.notification.create({
      data: { createdAt: now, payload: await digestPayload(prisma, items, now), type: 'attention.digest', userId: person.id },
    });
    sent += 1;
  }
  return sent;
}

async function digestPayload(prisma: PrismaClient, items: AttentionItem[], now: Date) {
  const summary = summarizeAttention(items);
  const workIds = [...new Set(items.flatMap((entry) => [entry.workId, entry.groupId]).filter((id): id is string => Boolean(id)))];
  const works = new Map(
    (await prisma.issue.findMany({ where: { id: { in: workIds } }, select: { id: true, identifier: true, title: true } })).map((work) => [work.id, work]),
  );
  // Overdue first, then the longest wait.
  const oldest = [...items]
    .sort((a, b) => Number(b.overdue) - Number(a.overdue) || a.since.getTime() - b.since.getTime())
    .slice(0, OLDEST_LISTED)
    .map((entry) => ({
      identifier: entry.workId ? works.get(entry.workId)?.identifier ?? null : null,
      kind: entry.kind,
      overdue: entry.overdue,
      reason: entry.reason,
      title: entry.workId ? works.get(entry.workId)?.title ?? null : null,
      waitHours: Math.floor((now.getTime() - entry.since.getTime()) / (60 * 60_000)),
    }));
  const byPack = new Map<string, AttentionItem[]>();
  for (const entry of items) {
    if (!entry.groupId) continue;
    byPack.set(entry.groupId, [...(byPack.get(entry.groupId) ?? []), entry]);
  }
  const packs = [...byPack.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, PACKS_LISTED)
    .map(([groupId, entries]) => ({
      count: entries.length,
      identifier: works.get(groupId)?.identifier ?? null,
      title: works.get(groupId)?.title ?? null,
    }));
  return {
    byKind: summary.byKind.filter((entry) => entry.count > 0).map((entry) => ({ count: entry.count, kind: entry.kind })),
    oldest,
    overdue: items.filter((entry) => entry.overdue).length,
    packs,
    summary: `${summary.total} waiting on your decision${items.some((entry) => entry.overdue) ? `, ${items.filter((entry) => entry.overdue).length} overdue` : ''}`,
    total: summary.total,
  };
}
