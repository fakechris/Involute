import type { Issue, Prisma, PrismaClient, WorkflowStateType } from '@prisma/client';

import { BUG_LABEL_NAME } from './bug-report.js';
import { enqueueWorkEvent } from './event-outbox.js';
import { currentTriager } from './bug-triage.js';
import { loadWorkTimelines, type WorkTimelineEntry } from './work-timeline.js';

type DatabaseClient = PrismaClient | Prisma.TransactionClient;

const HOUR = 60 * 60 * 1000;
/** Bug route v1 (INV-748): Urgent 24h, High 48h, everything else 7 days. */
export function slaBudgetMs(priority: number): number {
  if (priority === 1) return 24 * HOUR;
  if (priority === 2) return 48 * HOUR;
  return 7 * 24 * HOUR;
}
export const AT_RISK_SHARE = 0.2;

export type BugSlaStatus = 'ON_TRACK' | 'AT_RISK' | 'BREACHED' | 'PAUSED' | 'MET';

export interface BugSla {
  status: BugSlaStatus;
  budgetMs: number;
  elapsedMs: number;
  remainingMs: number;
  /** When the clock runs out if nothing changes; null while paused or closed. */
  dueAt: Date | null;
  startedAt: Date;
}

const STOPPED: ReadonlySet<WorkflowStateType> = new Set(['REVIEW', 'COMPLETED', 'CANCELED']);
const CLOSED: ReadonlySet<WorkflowStateType> = new Set(['COMPLETED', 'CANCELED']);

/**
 * A committed bug's SLA (INV-750). The clock starts at commitment, runs while
 * the bug is open and not in Review, stops in Review and when closed, and
 * resumes if it is reopened. Pure: computed from the audit timeline.
 */
export function computeBugSla(
  timeline: Pick<WorkTimelineEntry, 'committedAt' | 'transitions'>,
  input: { priority: number; stateType: WorkflowStateType; createdAt: Date },
  now: Date,
): BugSla {
  const startedAt = timeline.committedAt ?? input.createdAt;
  const budgetMs = slaBudgetMs(input.priority);
  const spells = timeline.transitions
    .filter((transition) => transition.at.getTime() >= startedAt.getTime())
    .map((transition) => ({ at: transition.at.getTime(), type: transition.stateType }));
  // The state at commitment: the last transition at or before it, else the current one.
  const before = timeline.transitions.filter((transition) => transition.at.getTime() < startedAt.getTime()).at(-1);
  const first = before?.stateType ?? spells[0]?.type ?? input.stateType;
  const points = [{ at: startedAt.getTime(), type: first }, ...spells];
  let elapsedMs = 0;
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index]!;
    const end = points[index + 1]?.at ?? now.getTime();
    if (!STOPPED.has(point.type)) elapsedMs += Math.max(0, end - point.at);
  }
  const remainingMs = budgetMs - elapsedMs;
  let status: BugSlaStatus;
  if (remainingMs < 0) status = 'BREACHED';
  else if (CLOSED.has(input.stateType)) status = 'MET';
  else if (input.stateType === 'REVIEW') status = 'PAUSED';
  else if (remainingMs <= budgetMs * AT_RISK_SHARE) status = 'AT_RISK';
  else status = 'ON_TRACK';
  const running = !STOPPED.has(input.stateType);
  return {
    status,
    budgetMs,
    elapsedMs,
    remainingMs,
    dueAt: running ? new Date(now.getTime() + remainingMs) : null,
    startedAt,
  };
}

const BUG_WHERE = { labels: { some: { name: { equals: BUG_LABEL_NAME, mode: 'insensitive' as const } } } };

/** SLAs for committed bugs among `issues` (others get no entry). */
export async function loadBugSlas(
  prisma: DatabaseClient,
  issueIds: string[],
  now = new Date(),
): Promise<Map<string, BugSla>> {
  if (issueIds.length === 0) return new Map();
  const bugs = await prisma.issue.findMany({
    where: { id: { in: issueIds }, commitmentStatus: 'COMMITTED', ...BUG_WHERE },
    select: { id: true, stateId: true, commitmentStatus: true, updatedAt: true, createdAt: true, priority: true, state: { select: { type: true } } },
  });
  const timelines = await loadWorkTimelines(prisma, bugs);
  const byId = new Map(timelines.map((entry) => [entry.workId, entry]));
  const result = new Map<string, BugSla>();
  for (const bug of bugs) {
    const timeline = byId.get(bug.id);
    if (!timeline) continue;
    result.set(bug.id, computeBugSla(timeline, { priority: bug.priority, stateType: bug.state.type, createdAt: bug.createdAt }, now));
  }
  return result;
}

const ALERT_EVENT = { AT_RISK: 'bug.sla_at_risk', BREACHED: 'bug.sla_breached' } as const;

/**
 * Remind the owner and this week's triager once per bug when its SLA is at
 * risk and once when it is breached (INV-750). Safe to run repeatedly and from
 * several processes: the (work, kind) unique key decides who sends.
 */
export async function sweepBugSlas(prisma: PrismaClient, now = new Date()): Promise<number> {
  const open = await prisma.issue.findMany({
    where: { commitmentStatus: 'COMMITTED', state: { type: { notIn: ['COMPLETED', 'CANCELED', 'REVIEW'] } }, ...BUG_WHERE },
    select: { id: true },
  });
  const slas = await loadBugSlas(prisma, open.map((issue) => issue.id), now);
  let sent = 0;
  for (const [workId, sla] of slas) {
    const kinds = sla.status === 'BREACHED' ? (['AT_RISK', 'BREACHED'] as const) : sla.status === 'AT_RISK' ? (['AT_RISK'] as const) : [];
    // Only the most severe reminder is sent now; the milder one is recorded as done.
    for (const kind of kinds) {
      const sendThis = kind === kinds.at(-1);
      const sentNow = await prisma.$transaction(async (transaction) => {
        const inserted = await transaction.bugSlaAlert.createMany({ data: [{ workId, kind }], skipDuplicates: true });
        if (inserted.count === 0 || !sendThis) return false;
        const work = await transaction.issue.findUniqueOrThrow({ where: { id: workId } });
        await notifySla(transaction, work, kind, sla, now);
        return true;
      });
      if (sentNow) sent += 1;
    }
  }
  return sent;
}

async function notifySla(transaction: Prisma.TransactionClient, work: Issue, kind: 'AT_RISK' | 'BREACHED', sla: BugSla, now: Date) {
  const type = ALERT_EVENT[kind];
  const payload = {
    identifier: work.identifier,
    title: work.title,
    priority: work.priority,
    remainingMs: sla.remainingMs,
    budgetMs: sla.budgetMs,
  };
  const event = await enqueueWorkEvent(transaction, { payload, type, workId: work.id, workIdentifier: work.identifier });
  const team = await transaction.team.findUniqueOrThrow({ where: { id: work.teamId }, select: { triageRotation: true } });
  const recipients = new Set<string>();
  if (work.assigneeId) recipients.add(work.assigneeId);
  const triager = currentTriager(team.triageRotation, now);
  if (triager) recipients.add(triager);
  const humans = await transaction.user.findMany({
    where: { id: { in: [...recipients] }, actorKind: 'HUMAN' },
    select: { id: true },
  });
  if (humans.length === 0) return;
  await transaction.notification.createMany({
    data: humans.map((user) => ({ payload, sourceEventId: event.id, teamId: work.teamId, type, userId: user.id, workId: work.id })),
    skipDuplicates: true,
  });
}
