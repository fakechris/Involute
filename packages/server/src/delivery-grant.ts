import type { Issue, Prisma, PrismaClient } from '@prisma/client';
import { digest, type AcceptanceContract } from './evidence-contract.js';
import { executionContract, parseDeliveryPolicy, type DeliveryContract } from './delivery-policy.js';
import { createValidationError } from './errors.js';

type DatabaseClient = PrismaClient | Prisma.TransactionClient;
export function deliveryContractDigest(work: DeliveryContract): string {
  return digest({ outcome: work.outcome ?? null, acceptance: work.acceptance, scope: work.scope, constraints: work.constraints, repository: work.repository, verification: work.verification });
}

export async function approvedDelivery(prisma: DatabaseClient, workId: string) {
  const work = await prisma.issue.findUnique({ where: { id: workId }, include: { deliveryPackage: true, state: true } });
  const grant = work?.deliveryPackage;
  if (!work || !grant || grant.revokedAt || work.commitmentStatus !== 'COMMITTED' || work.supersededById || ['COMPLETED', 'CANCELED'].includes(work.state.type) || grant.contractDigest !== deliveryContractDigest(work)) {
    throw createValidationError('Delivery authorization is missing, revoked, closed or stale; propose a candidate change.');
  }
  return { work, grant, policy: parseDeliveryPolicy(grant.policy, work) };
}

/** Contract edits and moves never turn inherited authority into an independent grant. */
export async function assertDeliveryExecution(prisma: DatabaseClient, work: Issue) {
  if (!work.deliveryRootId) return null;
  const binding = await approvedDelivery(prisma, work.deliveryRootId);
  if (work.deliveryGrantRevision !== binding.grant.revision || !work.deliveryUnitKey || work.parentId !== binding.work.id || work.kind !== 'ISSUE' || work.outcome !== null) {
    throw createValidationError('Execution task no longer matches its approved delivery unit.');
  }
  const expected = executionContract(binding.policy, work.deliveryUnitKey, binding.work);
  if (['acceptance', 'scope', 'constraints', 'repository', 'verification'].some((field) => work[field as keyof typeof expected] !== expected[field as keyof typeof expected])) {
    throw createValidationError('Execution contract differs from its approved delivery unit; propose a candidate change.');
  }
  return { ...binding, unit: binding.policy.units.find((unit) => unit.key === work.deliveryUnitKey)! };
}

/** Technical proof is explicit workflow/job coverage, separate from business acceptance. */
export async function deliveryTechnicalContract(prisma: DatabaseClient, work: Issue): Promise<AcceptanceContract | null> {
  const binding = await assertDeliveryExecution(prisma, work);
  if (!binding || !binding.unit.checks.length) return null;
  return { version: 1, criteria: binding.unit.checks.map((check, index) => ({ id: `${binding.unit.key}-${index}`, required: true, ...check })) };
}
