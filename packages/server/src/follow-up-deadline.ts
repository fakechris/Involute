import type { Issue, Prisma, PrismaClient, WorkflowStateType, WorkResolution } from '@prisma/client';

import { computeSlaClock, owedSlaAlerts, type SlaClock, type SlaClockStatus } from './bug-sla.js';
import { enqueueWorkEvent } from './event-outbox.js';
import { INCIDENT_LABEL_NAME } from './labels.js';
import { loadReporterWaits } from './need-info-service.js';
import { loadWorkTimelines } from './work-timeline.js';

type DatabaseClient = PrismaClient | Prisma.TransactionClient;

const DAY = 24 * 60 * 60_000;

/**
 * Incident follow-up deadlines (INV-1127), in days by priority: Urgent 7,
 * High 14, everything else (Medium, Low, none) 30. Override with
 * FOLLOW_UP_DEADLINE_DAYS="<urgent>,<high>,<other>" (positive numbers of days);
 * a malformed value is ignored with a warning and the defaults apply.
 */
export const DEFAULT_FOLLOW_UP_DEADLINE_DAYS = { urgent: 7, high: 14, other: 30 } as const;

export interface FollowUpDeadlineDays {
  urgent: number;
  high: number;
  other: number;
}

export function followUpDeadlineDays(env: NodeJS.ProcessEnv = process.env): FollowUpDeadlineDays {
  const raw = env.FOLLOW_UP_DEADLINE_DAYS?.trim();
  if (!raw) return { ...DEFAULT_FOLLOW_UP_DEADLINE_DAYS };
  const parts = raw.split(',').map((part) => Number(part.trim()));
  if (parts.length !== 3 || parts.some((days) => !Number.isFinite(days) || days <= 0)) {
    console.warn(`FOLLOW_UP_DEADLINE_DAYS="${raw}" is not "<urgent>,<high>,<other>" in positive days; using 7,14,30.`);
    return { ...DEFAULT_FOLLOW_UP_DEADLINE_DAYS };
  }
  const [urgent, high, other] = parts as [number, number, number];
  return { urgent, high, other };
}

export function followUpBudgetMs(priority: number, days: FollowUpDeadlineDays = followUpDeadlineDays()): number {
  if (priority === 1) return days.urgent * DAY;
  if (priority === 2) return days.high * DAY;
  return days.other * DAY;
}

/** The SLA clock's statuses plus DECLINED: closed without doing it (canceled, e.g. resolution WONT_DO) — never overdue. */
export type FollowUpDeadlineStatus = SlaClockStatus | 'DECLINED';

export interface FollowUpDeadline extends Omit<SlaClock, 'status'> {
  status: FollowUpDeadlineStatus;
  /** The incidents it was derived from, oldest first. */
  incidentIds: string[];
  /** Done or canceled. */
  closed: boolean;
}

/**
 * The deadline of one follow-up: the bug SLA clock (starts at commitment,
 * paused in Review and while waiting on its reporter, stops when closed)
 * with the follow-up budget. Canceled work is DECLINED, whatever the clock
 * said before: a follow-up declined with a reason is not overdue.
 */
export function computeFollowUpDeadline(
  clock: SlaClock,
  input: { stateType: WorkflowStateType; resolution: WorkResolution | null },
): FollowUpDeadlineStatus {
  if (input.stateType === 'CANCELED' && input.resolution !== 'COMPLETED') return 'DECLINED';
  return clock.status;
}

const INCIDENT_WHERE = { labels: { some: { name: { equals: INCIDENT_LABEL_NAME, mode: 'insensitive' as const } } } };

/** Prisma filter for the DERIVED_FROM links that make an item a follow-up; batch it into list reads as `outgoingLinks`. */
export const FOLLOW_UP_LINK_WHERE = { type: 'DERIVED_FROM' as const, to: INCIDENT_WHERE };

/**
 * Committed ISSUEs among `workIds` that derive from a Type: Incident, with the
 * incidents (oldest first). Anything else is not a follow-up and gets no entry.
 */
export async function loadFollowUpIncidents(prisma: DatabaseClient, workIds: string[]): Promise<Map<string, string[]>> {
  if (workIds.length === 0) return new Map();
  const links = await prisma.workLink.findMany({
    where: { ...FOLLOW_UP_LINK_WHERE, fromId: { in: workIds }, from: { kind: 'ISSUE', commitmentStatus: 'COMMITTED' } },
    select: { fromId: true, toId: true, to: { select: { createdAt: true } } },
    orderBy: [{ to: { createdAt: 'asc' } }, { toId: 'asc' }],
  });
  const result = new Map<string, string[]>();
  for (const link of links) result.set(link.fromId, [...(result.get(link.fromId) ?? []), link.toId]);
  return result;
}

/** Deadlines for the follow-ups among `workIds` (others get no entry). */
export async function loadFollowUpDeadlines(
  prisma: DatabaseClient,
  workIds: string[],
  now = new Date(),
  days: FollowUpDeadlineDays = followUpDeadlineDays(),
): Promise<Map<string, FollowUpDeadline>> {
  const incidents = await loadFollowUpIncidents(prisma, workIds);
  if (incidents.size === 0) return new Map();
  const items = await prisma.issue.findMany({
    where: { id: { in: [...incidents.keys()] } },
    select: { id: true, stateId: true, commitmentStatus: true, updatedAt: true, createdAt: true, priority: true, resolution: true, state: { select: { type: true } } },
  });
  const [timelines, waits] = await Promise.all([loadWorkTimelines(prisma, items), loadReporterWaits(prisma, items.map((item) => item.id))]);
  const byId = new Map(timelines.map((entry) => [entry.workId, entry]));
  const result = new Map<string, FollowUpDeadline>();
  for (const item of items) {
    const timeline = byId.get(item.id);
    if (!timeline) continue;
    const clock = computeSlaClock(
      timeline,
      { budgetMs: followUpBudgetMs(item.priority, days), stateType: item.state.type, createdAt: item.createdAt },
      now,
      waits.get(item.id) ?? [],
    );
    const status = computeFollowUpDeadline(clock, { stateType: item.state.type, resolution: item.resolution });
    result.set(item.id, { ...clock, status, ...(status === 'DECLINED' ? { dueAt: null } : {}), incidentIds: incidents.get(item.id)!, closed: item.state.type === 'COMPLETED' || item.state.type === 'CANCELED' });
  }
  return result;
}

export interface IncidentFollowUpStats {
  total: number;
  /** Closed as done (Done, or canceled with resolution COMPLETED). */
  completed: number;
  /** Closed without doing it (canceled with any other resolution, e.g. WONT_DO): never overdue. */
  declined: number;
  /** Past the deadline: still open, or finished late. */
  overdue: number;
  /** Past the deadline and still open. */
  overdueOpen: number;
}

/**
 * Follow-up counts per incident, for the incident metrics (INV-1129). Each
 * follow-up counts once under every incident it derives from; incidents with
 * no follow-ups get zeros.
 */
export async function loadIncidentFollowUpStats(
  prisma: DatabaseClient,
  incidentIds: string[],
  now = new Date(),
  days: FollowUpDeadlineDays = followUpDeadlineDays(),
): Promise<Map<string, IncidentFollowUpStats>> {
  const result = new Map<string, IncidentFollowUpStats>(
    incidentIds.map((id) => [id, { total: 0, completed: 0, declined: 0, overdue: 0, overdueOpen: 0 }]),
  );
  if (incidentIds.length === 0) return result;
  const links = await prisma.workLink.findMany({
    where: { type: 'DERIVED_FROM', toId: { in: incidentIds }, from: { kind: 'ISSUE', commitmentStatus: 'COMMITTED' } },
    select: { fromId: true },
  });
  const deadlines = await loadFollowUpDeadlines(prisma, [...new Set(links.map((link) => link.fromId))], now, days);
  for (const deadline of deadlines.values()) {
    for (const incidentId of deadline.incidentIds) {
      const stats = result.get(incidentId);
      if (!stats) continue;
      stats.total += 1;
      if (deadline.status === 'DECLINED') stats.declined += 1;
      else if (deadline.closed) stats.completed += 1;
      if (deadline.status === 'BREACHED') {
        stats.overdue += 1;
        if (!deadline.closed) stats.overdueOpen += 1;
      }
    }
  }
  return result;
}

const ALERT_KIND = { AT_RISK: 'FOLLOW_UP_AT_RISK', BREACHED: 'FOLLOW_UP_BREACHED' } as const;
const ALERT_EVENT = { AT_RISK: 'incident.follow_up_at_risk', BREACHED: 'incident.follow_up_overdue' } as const;

/**
 * Remind the follow-up's owner and each incident's Lead (its owner) once when
 * the deadline is at risk (20% left) and once when it has passed (INV-1127).
 * Same once-only marker table as the bug SLA, under follow-up kinds, so a
 * follow-up that is also a bug hears about both clocks separately.
 */
export async function sweepFollowUpDeadlines(prisma: PrismaClient, now = new Date()): Promise<number> {
  const open = await prisma.issue.findMany({
    where: {
      kind: 'ISSUE',
      commitmentStatus: 'COMMITTED',
      state: { type: { notIn: ['COMPLETED', 'CANCELED', 'REVIEW'] } },
      outgoingLinks: { some: FOLLOW_UP_LINK_WHERE },
    },
    select: { id: true },
  });
  const deadlines = await loadFollowUpDeadlines(prisma, open.map((issue) => issue.id), now);
  let sent = 0;
  for (const [workId, deadline] of deadlines) {
    if (deadline.status === 'DECLINED') continue;
    const kinds = owedSlaAlerts(deadline.status);
    for (const kind of kinds) {
      const sendThis = kind === kinds.at(-1);
      const sentNow = await prisma.$transaction(async (transaction) => {
        const inserted = await transaction.bugSlaAlert.createMany({ data: [{ workId, kind: ALERT_KIND[kind] }], skipDuplicates: true });
        if (inserted.count === 0 || !sendThis) return false;
        const work = await transaction.issue.findUniqueOrThrow({ where: { id: workId } });
        await notifyFollowUp(transaction, work, kind, deadline);
        return true;
      });
      if (sentNow) sent += 1;
    }
  }
  return sent;
}

async function notifyFollowUp(transaction: Prisma.TransactionClient, work: Issue, kind: 'AT_RISK' | 'BREACHED', deadline: FollowUpDeadline) {
  const type = ALERT_EVENT[kind];
  const incidents = await transaction.issue.findMany({
    where: { id: { in: deadline.incidentIds } },
    select: { id: true, identifier: true, assigneeId: true },
  });
  const payload = {
    identifier: work.identifier,
    title: work.title,
    priority: work.priority,
    remainingMs: deadline.remainingMs,
    budgetMs: deadline.budgetMs,
    incidents: incidents.map((incident) => incident.identifier),
  };
  const event = await enqueueWorkEvent(transaction, { payload, type, workId: work.id, workIdentifier: work.identifier });
  const recipients = new Set<string>();
  if (work.assigneeId) recipients.add(work.assigneeId);
  for (const incident of incidents) if (incident.assigneeId) recipients.add(incident.assigneeId);
  const humans = await transaction.user.findMany({ where: { id: { in: [...recipients] }, actorKind: 'HUMAN' }, select: { id: true } });
  if (humans.length === 0) return;
  await transaction.notification.createMany({
    data: humans.map((user) => ({ payload, sourceEventId: event.id, teamId: work.teamId, type, userId: user.id, workId: work.id })),
    skipDuplicates: true,
  });
}
