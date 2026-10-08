import type { Prisma, User } from '@prisma/client';

import { enqueueWorkEvent } from './event-outbox.js';
import { projectWorkNotifications } from './notification-service.js';
import { moveToInReview } from './run-service-report.js';
import { writeActorFromViewer } from './work-service.js';

/**
 * Package-level review (INV-1025). A unit's final receipt marks its dispatch
 * DELIVERED; when every unit of the approved grant is delivered, the root work
 * moves to In Review and its owner hears about it — the same signal a run's
 * completion sends, so nobody has to move the root by hand. With units still
 * outstanding the root stays where it is.
 */
export async function settleDeliveryRootAfterReceipt(
  tx: Prisma.TransactionClient,
  input: { rootId: string; grantRevision: number; unitKeys: string[]; viewer: User },
): Promise<{ moved: boolean }> {
  const dispatches = await tx.executorDispatch.findMany({
    where: { rootId: input.rootId, grantRevision: input.grantRevision },
    select: { workId: true, state: true },
  });
  const units = await tx.issue.findMany({
    where: { id: { in: dispatches.map((item) => item.workId) } },
    select: { id: true, deliveryUnitKey: true },
  });
  const deliveredKeys = new Set(
    dispatches
      .filter((item) => item.state === 'DELIVERED')
      .map((item) => units.find((unit) => unit.id === item.workId)?.deliveryUnitKey)
      .filter((key): key is string => typeof key === 'string'),
  );
  if (input.unitKeys.some((key) => !deliveredKeys.has(key))) return { moved: false };

  const root = await tx.issue.findUniqueOrThrow({ where: { id: input.rootId } });
  const { auditId } = await moveToInReview(tx, root, writeActorFromViewer(input.viewer));
  if (!auditId) return { moved: false };

  const summary = `All ${input.unitKeys.length} implementation unit${input.unitKeys.length === 1 ? '' : 's'} delivered; the package is ready for review.`;
  const event = await enqueueWorkEvent(tx, {
    type: 'run.completed',
    workId: root.id,
    workIdentifier: root.identifier,
    payload: { phase: 'deliver', summary, publicId: null, externalUrl: null, deliveryGrantRevision: input.grantRevision },
  });
  await projectWorkNotifications(tx, {
    eventId: event.id,
    payload: { phase: 'deliver', summary, publicId: null, externalUrl: null },
    type: 'run.completed',
    work: root,
  });
  return { moved: true };
}
