import type { Prisma, PrismaClient } from '@prisma/client';

import { INCIDENT_LABEL_NAME } from './labels.js';

type DatabaseClient = PrismaClient | Prisma.TransactionClient;

/**
 * What a reviewer can click to see what was done (INV-1673): a run's commit,
 * pull request or external URL, or any evidence on the work. Code work that
 * reaches Review with none of these leaves the person accepting it nothing to
 * open, so run_report warns and /hygiene lists it.
 */
export function deliveryLinksWarning(repository: string): string {
  return `This work is in ${repository}, but nothing on it says what was delivered: no run carries commit_sha, pr_number or external_url and no evidence is attached. Report the commit and PR (run_report commit_sha + pr_number) and attach links to outside systems — a Sentry issue, a dashboard — with evidence(action: 'attach'); the issue page shows them under Commits & links, and /hygiene lists Review work without any (INV-1673).`;
}

/** Research and incidents deliver a report, not a commit; decisions and containers deliver nothing to link. */
function expectsCodeLinks(work: { kind: string; repository: string | null; labels: Array<{ name: string }> }): boolean {
  if (work.kind !== 'ISSUE' || !work.repository) return false;
  return !work.labels.some((label) => ['research', INCIDENT_LABEL_NAME.toLowerCase()].includes(label.name.toLowerCase()));
}

/** The ids among `workIds` that have a delivery link: a run with commit / PR / URL, or unretracted evidence. */
export async function workIdsWithDeliveryLinks(prisma: DatabaseClient, workIds: string[]): Promise<Set<string>> {
  if (!workIds.length) return new Set();
  const [runs, evidence] = await Promise.all([
    prisma.workRun.findMany({
      where: { workId: { in: workIds }, OR: [{ commitSha: { not: null } }, { pullRequestNumber: { not: null } }, { externalUrl: { not: null } }] },
      select: { workId: true },
      distinct: ['workId'],
    }),
    prisma.workEvidence.findMany({ where: { workId: { in: workIds }, retractedAt: null }, select: { workId: true }, distinct: ['workId'] }),
  ]);
  return new Set([...runs, ...evidence].map((row) => row.workId));
}

/** The warning for a completed run on code work with no delivery link, or null. */
export async function deliveryLinksMissingWarning(prisma: DatabaseClient, workId: string): Promise<string | null> {
  const work = await prisma.issue.findUnique({ where: { id: workId }, select: { id: true, kind: true, repository: true, labels: { select: { name: true } } } });
  if (!work || !expectsCodeLinks(work)) return null;
  const linked = await workIdsWithDeliveryLinks(prisma, [work.id]);
  return linked.has(work.id) ? null : deliveryLinksWarning(work.repository!);
}

/** Of these issues, the code work in Review with no delivery link (for /hygiene). */
export async function reviewWithoutDeliveryLinks<T extends { id: string; kind: string; repository: string | null; labels: Array<{ name: string }>; state: { type: string } }>(
  prisma: DatabaseClient,
  issues: T[],
): Promise<T[]> {
  const inReview = issues.filter((issue) => issue.state.type === 'REVIEW' && expectsCodeLinks(issue));
  const linked = await workIdsWithDeliveryLinks(prisma, inReview.map((issue) => issue.id));
  return inReview.filter((issue) => !linked.has(issue.id));
}
