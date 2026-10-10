import type { IssueSeverity, Prisma, PrismaClient } from '@prisma/client';

import { loadIncidentFollowUpStats } from './follow-up-deadline.js';
import { incidentNeedsPostmortem } from './incident-closure.js';
import { countsInIncidentMetrics, incidentDurations } from './incident-timestamps.js';
import { INCIDENT_LABEL_NAME } from './labels.js';
import { SEVERITIES } from './severity.js';

type DatabaseClient = PrismaClient | Prisma.TransactionClient;

/**
 * The /incidents page (INV-1129): counts, MTTR / MTTM as plain averages with
 * their sample size, and follow-up progress. No percentiles or period
 * comparisons — a month brings single-digit incidents (decision INV-1130).
 * Only committed Type: Incident work counts; a declined one, one closed as a
 * duplicate or invalid, or one marked DUPLICATE_OF another is left out and
 * reported as excludedCount.
 */
export interface IncidentSummary {
  openCount: number;
  resolvedCount: number;
  excludedCount: number;
  bySeverity: Array<{ severity: IssueSeverity | null; openCount: number; resolvedCount: number }>;
  byRepository: Array<{ repository: string | null; openCount: number; resolvedCount: number }>;
  /** Mean impact started → resolved, hours, over counted incidents with resolvedAt. */
  mttrHours: number | null;
  mttrSampleCount: number;
  /** Mean impact started → mitigated (resolvedAt when mitigation is not recorded), hours. */
  mttmHours: number | null;
  mttmSampleCount: number;
  followUps: {
    total: number;
    completed: number;
    declined: number;
    overdue: number;
    overdueOpen: number;
    /** completed / (total − declined): a declined follow-up is no longer owed. Null when none are owed. */
    completionRate: number | null;
  };
  incidents: IncidentSummaryItem[];
}

export interface IncidentSummaryItem {
  id: string;
  identifier: string;
  title: string;
  severity: IssueSeverity | null;
  repository: string | null;
  stateName: string;
  impactStartedAt: Date;
  resolvedAt: Date | null;
  /** Impact so far: to resolvedAt, or to now while ongoing. */
  impactHours: number;
  ongoing: boolean;
  postmortemRequired: boolean;
  postmortemAttached: boolean;
  followUpTotal: number;
  followUpCompleted: number;
  followUpDeclined: number;
  followUpOverdueOpen: number;
}

const HOUR_MS = 3_600_000;
const round1 = (value: number) => Math.round(value * 10) / 10;
const meanHours = (values: number[]) => (values.length ? round1(values.reduce((sum, value) => sum + value, 0) / values.length / HOUR_MS) : null);
const SEVERITY_ORDER = (severity: IssueSeverity | null) => (severity ? SEVERITIES.indexOf(severity) : SEVERITIES.length);

/** Incident metrics over the work `scope` selects (team and read access). */
export async function loadIncidentSummary(prisma: DatabaseClient, scope: Prisma.IssueWhereInput, now = new Date()): Promise<IncidentSummary> {
  const rows = await prisma.issue.findMany({
    where: {
      AND: [
        scope,
        { commitmentStatus: { in: ['COMMITTED', 'REJECTED'] } },
        { labels: { some: { name: { equals: INCIDENT_LABEL_NAME, mode: 'insensitive' } } } },
      ],
    },
    select: {
      id: true,
      identifier: true,
      title: true,
      severity: true,
      repository: true,
      commitmentStatus: true,
      resolution: true,
      createdAt: true,
      impactStartedAt: true,
      detectedAt: true,
      mitigatedAt: true,
      resolvedAt: true,
      state: { select: { name: true, type: true } },
      _count: { select: { attachments: true } },
      outgoingLinks: { where: { type: 'DUPLICATE_OF' }, select: { id: true }, take: 1 },
    },
  });
  const counted = rows.filter((row) =>
    countsInIncidentMetrics({ commitmentStatus: row.commitmentStatus, resolution: row.resolution, duplicateOf: row.outgoingLinks.length > 0 }),
  );
  const stats = await loadIncidentFollowUpStats(prisma, counted.map((row) => row.id), now);

  const severities = new Map<IssueSeverity | null, { openCount: number; resolvedCount: number }>();
  const repositories = new Map<string | null, { openCount: number; resolvedCount: number }>();
  const toResolve: number[] = [];
  const toMitigate: number[] = [];
  const followUps = { total: 0, completed: 0, declined: 0, overdue: 0, overdueOpen: 0 };
  const incidents: IncidentSummaryItem[] = [];
  let openCount = 0;

  for (const row of counted) {
    const durations = incidentDurations(row, now);
    const closed = row.state.type === 'COMPLETED' || row.state.type === 'CANCELED';
    const resolved = !durations.ongoing || closed;
    if (!resolved) openCount += 1;
    const bump = <K>(map: Map<K, { openCount: number; resolvedCount: number }>, key: K) => {
      const entry = map.get(key) ?? { openCount: 0, resolvedCount: 0 };
      if (resolved) entry.resolvedCount += 1;
      else entry.openCount += 1;
      map.set(key, entry);
    };
    bump(severities, row.severity);
    bump(repositories, row.repository);
    if (durations.timeToResolveMs !== null) toResolve.push(durations.timeToResolveMs);
    if (durations.timeToMitigateMs !== null) toMitigate.push(durations.timeToMitigateMs);
    const own = stats.get(row.id) ?? { total: 0, completed: 0, declined: 0, overdue: 0, overdueOpen: 0 };
    followUps.total += own.total;
    followUps.completed += own.completed;
    followUps.declined += own.declined;
    followUps.overdue += own.overdue;
    followUps.overdueOpen += own.overdueOpen;
    incidents.push({
      id: row.id,
      identifier: row.identifier,
      title: row.title,
      severity: row.severity,
      repository: row.repository,
      stateName: row.state.name,
      impactStartedAt: durations.impactStartedAt,
      resolvedAt: row.resolvedAt,
      impactHours: round1(durations.impactMs / HOUR_MS),
      ongoing: !resolved,
      postmortemRequired: incidentNeedsPostmortem(row.severity),
      postmortemAttached: row._count.attachments > 0,
      followUpTotal: own.total,
      followUpCompleted: own.completed,
      followUpDeclined: own.declined,
      followUpOverdueOpen: own.overdueOpen,
    });
  }

  // Ongoing first, then the most recent impact.
  incidents.sort((left, right) => Number(right.ongoing) - Number(left.ongoing) || right.impactStartedAt.getTime() - left.impactStartedAt.getTime());
  const owed = followUps.total - followUps.declined;
  return {
    openCount,
    resolvedCount: counted.length - openCount,
    excludedCount: rows.length - counted.length,
    bySeverity: [...severities.entries()]
      .sort(([left], [right]) => SEVERITY_ORDER(left) - SEVERITY_ORDER(right))
      .map(([severity, counts]) => ({ severity, ...counts })),
    byRepository: [...repositories.entries()]
      .sort(([leftRepo, left], [rightRepo, right]) => right.openCount + right.resolvedCount - (left.openCount + left.resolvedCount) || (leftRepo ?? '').localeCompare(rightRepo ?? ''))
      .map(([repository, counts]) => ({ repository, ...counts })),
    mttrHours: meanHours(toResolve),
    mttrSampleCount: toResolve.length,
    mttmHours: meanHours(toMitigate),
    mttmSampleCount: toMitigate.length,
    followUps: { ...followUps, completionRate: owed > 0 ? Math.round((followUps.completed / owed) * 1000) / 1000 : null },
    incidents,
  };
}
