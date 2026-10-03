import type { DeliveryChangeSet, Prisma, PrismaClient } from '@prisma/client';

/** A proposal may contain contracts and graph snapshots outside its target's share. */
export async function visibleDeliveryChange(prisma: PrismaClient, change: DeliveryChangeSet, readable: Prisma.IssueWhereInput = {}): Promise<DeliveryChangeSet & { restricted?: boolean }> {
  const before = change.before as { revisions?: Record<string, number> };
  const ids = [...new Set([change.workId, ...Object.keys(before.revisions ?? {})])];
  const visible = await prisma.issue.count({ where: { AND: [{ id: { in: ids } }, readable] } });
  if (visible === ids.length) return change;
  return { ...change, restricted: true, reason: 'This change includes work outside your access. An authorized reviewer must review the complete change.', changes: { contract: {}, mergeSourceIds: [] }, before: { contracts: {}, revisions: {}, links: [], policy: null } };
}
