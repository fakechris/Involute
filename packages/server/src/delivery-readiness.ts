import type { Issue, Prisma, PrismaClient, WorkLink } from '@prisma/client';
import { assertDeliveryExecution, deliveryTechnicalContract } from './delivery-grant.js';
import { assessVerifiedEvidence } from './evidence-verification.js';

type DatabaseClient = PrismaClient | Prisma.TransactionClient;
export async function hasTechnicalDeliveryProof(prisma: DatabaseClient, work: Issue): Promise<boolean> {
  try {
    const technical = await deliveryTechnicalContract(prisma, work);
    if (!technical) return false;
    const run = await prisma.workRun.findFirst({ where: { workId: work.id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
    return (await assessVerifiedEvidence(prisma, work, run, technical)).eligible;
  } catch { return false; }
}

export async function deliveryLinkBlocks(prisma: DatabaseClient, link: Pick<WorkLink, 'fromId' | 'toId'>): Promise<boolean> {
  const [from, to] = await Promise.all([
    prisma.issue.findUnique({ where: { id: link.fromId }, include: { state: true } }),
    prisma.issue.findUnique({ where: { id: link.toId } }),
  ]);
  if (!from || !to || from.commitmentStatus !== 'COMMITTED' || from.supersededById) return false;
  const ordinaryBlocked = !['COMPLETED', 'CANCELED'].includes(from.state.type);
  if (!to.deliveryRootId || from.deliveryRootId !== to.deliveryRootId || from.deliveryGrantRevision !== to.deliveryGrantRevision) return ordinaryBlocked;
  try {
    const binding = await assertDeliveryExecution(prisma, to);
    if (!binding?.unit.dependsOn.includes(from.deliveryUnitKey ?? '')) return ordinaryBlocked;
    return !(await hasTechnicalDeliveryProof(prisma, from));
  } catch { return true; }
}

export async function isDeliveryExecutionReady(prisma: DatabaseClient, work: Issue): Promise<boolean> {
  try {
    const binding = await assertDeliveryExecution(prisma, work);
    if (binding) for (const key of binding.unit.dependsOn) {
      const predecessor = await prisma.issue.findUnique({ where: { deliveryRootId_deliveryUnitKey_deliveryGrantRevision: { deliveryRootId: binding.work.id, deliveryUnitKey: key, deliveryGrantRevision: binding.grant.revision } } });
      if (!predecessor || !(await hasTechnicalDeliveryProof(prisma, predecessor))) return false;
    }
  } catch { return false; }
  const blockers = await prisma.workLink.findMany({ where: { toId: work.id, type: 'BLOCKS' } });
  for (const link of blockers) if (await deliveryLinkBlocks(prisma, link)) return false;
  return true;
}
