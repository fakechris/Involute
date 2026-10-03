import { visibleDeliveryChange } from './delivery-visibility.js';
import type { Prisma, PrismaClient } from '@prisma/client';
import { createValidationError } from './errors.js';

export const WORK_SECTIONS = ['children', 'links', 'comments', 'audits', 'runs', 'evidence', 'reviews', 'amendments', 'verifications', 'delivery_changes'] as const;
export type WorkSection = typeof WORK_SECTIONS[number];
interface Row { id: string; createdAt: Date }

/** Keyset pages remain traversable if the boundary row is deleted. */
export async function readWorkPage(prisma: PrismaClient, workId: string, section: WorkSection, first = 50, after?: string | null, readable: Prisma.IssueWhereInput = {}) {
  if (!WORK_SECTIONS.includes(section) || !Number.isInteger(first) || first < 1 || first > 200) throw createValidationError('Choose a valid section and first between 1 and 200.');
  let window = {};
  if (after) {
    try {
      const cursor = JSON.parse(Buffer.from(after, 'base64url').toString('utf8'));
      if (cursor.workId !== workId || cursor.section !== section || !/^[0-9a-f-]{36}$/i.test(cursor.id) || !Number.isFinite(Date.parse(cursor.createdAt))) throw new Error();
      const createdAt = new Date(cursor.createdAt);
      window = { OR: [{ createdAt: { lt: createdAt } }, { createdAt, id: { lt: cursor.id } }] };
    } catch { throw createValidationError('Invalid page cursor for this work section.'); }
  }
  const options = { take: first + 1, orderBy: [{ createdAt: 'desc' as const }, { id: 'desc' as const }] };
  let rows: Row[];
  switch (section) {
    case 'children': rows = await prisma.issue.findMany({ ...options, where: { AND: [readable, window, { OR: [{ parentId: workId }, { incomingLinks: { some: { fromId: workId, type: 'CONTAINS' } } }] }] } }); break;
    case 'links': rows = await prisma.workLink.findMany({ ...options, where: { AND: [window, { OR: [{ fromId: workId }, { toId: workId }] }, { from: readable, to: readable }] }, include: { from: true, to: true } }); break;
    case 'comments': rows = await prisma.comment.findMany({ ...options, where: { issueId: workId, ...window }, include: { user: { select: { id: true, name: true, actorKind: true } } } }); break;
    case 'audits': rows = await prisma.workAudit.findMany({ ...options, where: { workId, ...window } }); break;
    case 'runs': rows = await prisma.workRun.findMany({ ...options, where: { workId, ...window } }); break;
    case 'evidence': rows = await prisma.workEvidence.findMany({ ...options, where: { AND: [window, { OR: [{ workId }, { supersededByWorkId: workId }] }, { work: readable }] } }); break;
    case 'delivery_changes': rows = await Promise.all((await prisma.deliveryChangeSet.findMany({ ...options, where: { workId, ...window } })).map((row) => visibleDeliveryChange(prisma, row, readable))); break;
    case 'verifications': rows = await prisma.evidenceVerification.findMany({ ...options, where: { evidence: { workId }, ...window } }); break;
    case 'reviews': rows = await prisma.workReviewDecision.findMany({ ...options, where: { workId, ...window } }); break;
    case 'amendments': rows = await prisma.contractAmendment.findMany({ ...options, where: { workId, ...window } }); break;
  }
  const hasNextPage = rows.length > first;
  const nodes = rows.slice(0, first);
  const last = nodes.at(-1);
  const endCursor = last ? Buffer.from(JSON.stringify({ workId, section, id: last.id, createdAt: last.createdAt.toISOString() })).toString('base64url') : null;
  return { nodes, pageInfo: { hasNextPage, endCursor }, section };
}
