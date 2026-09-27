import { Prisma, type PrismaClient } from '@prisma/client';

import { BUG_LABEL_NAME, BUG_REPORT_SOURCE } from './bug-report.js';
import { loadBugSlas } from './bug-sla.js';

type DatabaseClient = PrismaClient | Prisma.TransactionClient;

export interface BugMetrics {
  /** Hours from report to commit or decline, over bugs that went through triage. */
  triageHoursP50: number | null;
  triageHoursP90: number | null;
  triagedCount: number;
  untriagedCount: number;
  /** Closed committed bugs that finished within / beyond their SLA. */
  slaMetCount: number;
  slaBreachedClosedCount: number;
  slaMetRate: number | null;
  atRiskOpenCount: number;
  breachedOpen: Array<{ id: string; identifier: string; title: string; overdueHours: number }>;
  bySource: Array<{ source: 'HUMAN_REPORT' | 'AGENT' | 'OTHER'; count: number }>;
  /** Committed open bugs that no parent contains — the goal is zero (INV-749). */
  unplacedOpenCount: number;
}

interface AuditRow {
  workId: string;
  createdAt: Date;
  actorKind: string | null;
  isCreation: boolean;
  commitment: string | null;
}

/** Nearest-rank percentile of sorted values. */
export function percentile(sorted: number[], share: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil(share * sorted.length));
  return sorted[rank - 1]!;
}

const round1 = (value: number) => Math.round(value * 10) / 10;

/**
 * Bug route v1 metrics (INV-751) for the bugs `scope` selects (team and read
 * access; any commitment). Triage and source come from the audit trail, SLA
 * from the same clock the board shows.
 */
export async function loadBugMetrics(prisma: DatabaseClient, scope: Prisma.IssueWhereInput, now = new Date()): Promise<BugMetrics> {
  const bugs = await prisma.issue.findMany({
    where: { AND: [scope, { labels: { some: { name: { equals: BUG_LABEL_NAME, mode: 'insensitive' } } } }] },
    select: {
      id: true,
      identifier: true,
      title: true,
      source: true,
      parentId: true,
      commitmentStatus: true,
      createdAt: true,
      state: { select: { type: true } },
    },
  });
  const ids = bugs.map((bug) => bug.id);
  const audits = ids.length
    ? await prisma.$queryRaw<AuditRow[]>(Prisma.sql`
        SELECT "workId", "createdAt", "actorKind"::text AS "actorKind", ("before" IS NULL) AS "isCreation",
               "after"->>'commitmentStatus' AS "commitment"
        FROM "WorkAudit"
        WHERE "workId" IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})
        ORDER BY "workId", "createdAt", "revision"`)
    : [];
  const byWork = new Map<string, AuditRow[]>();
  for (const row of audits) byWork.set(row.workId, [...(byWork.get(row.workId) ?? []), row]);

  const triageHours: number[] = [];
  const sources = { HUMAN_REPORT: 0, AGENT: 0, OTHER: 0 };
  for (const bug of bugs) {
    const rows = byWork.get(bug.id) ?? [];
    const creation = rows.find((row) => row.isCreation);
    if (creation?.commitment === 'CANDIDATE') {
      const decided = rows.find((row) => row.commitment === 'COMMITTED' || row.commitment === 'REJECTED');
      if (decided) triageHours.push((decided.createdAt.getTime() - creation.createdAt.getTime()) / 3_600_000);
    }
    if (bug.source?.startsWith(BUG_REPORT_SOURCE)) sources.HUMAN_REPORT += 1;
    else if (creation?.actorKind === 'AGENT') sources.AGENT += 1;
    else sources.OTHER += 1;
  }
  triageHours.sort((left, right) => left - right);

  const committed = bugs.filter((bug) => bug.commitmentStatus === 'COMMITTED');
  const slas = await loadBugSlas(prisma, committed.map((bug) => bug.id), now);
  let slaMetCount = 0;
  let slaBreachedClosedCount = 0;
  let atRiskOpenCount = 0;
  const breachedOpen: BugMetrics['breachedOpen'] = [];
  const containedIds = new Set(
    committed.length
      ? (
          await prisma.workLink.findMany({
            where: { type: 'CONTAINS', toId: { in: committed.map((bug) => bug.id) } },
            select: { toId: true },
          })
        ).map((link) => link.toId)
      : [],
  );
  let unplacedOpenCount = 0;
  for (const bug of committed) {
    const closed = bug.state.type === 'COMPLETED' || bug.state.type === 'CANCELED';
    const sla = slas.get(bug.id);
    if (closed) {
      if (sla?.status === 'BREACHED') slaBreachedClosedCount += 1;
      else if (sla) slaMetCount += 1;
      continue;
    }
    if (!bug.parentId && !containedIds.has(bug.id)) unplacedOpenCount += 1;
    if (sla?.status === 'AT_RISK') atRiskOpenCount += 1;
    if (sla?.status === 'BREACHED') {
      breachedOpen.push({ id: bug.id, identifier: bug.identifier, title: bug.title, overdueHours: round1(-sla.remainingMs / 3_600_000) });
    }
  }
  breachedOpen.sort((left, right) => right.overdueHours - left.overdueHours);
  const closedTotal = slaMetCount + slaBreachedClosedCount;
  const p50 = percentile(triageHours, 0.5);
  const p90 = percentile(triageHours, 0.9);

  return {
    triageHoursP50: p50 === null ? null : round1(p50),
    triageHoursP90: p90 === null ? null : round1(p90),
    triagedCount: triageHours.length,
    untriagedCount: bugs.filter((bug) => bug.commitmentStatus === 'CANDIDATE').length,
    slaMetCount,
    slaBreachedClosedCount,
    slaMetRate: closedTotal ? Math.round((slaMetCount / closedTotal) * 1000) / 1000 : null,
    atRiskOpenCount,
    breachedOpen,
    bySource: (Object.entries(sources) as Array<[BugMetrics['bySource'][number]['source'], number]>)
      .filter(([, count]) => count > 0)
      .map(([source, count]) => ({ source, count })),
    unplacedOpenCount,
  };
}
