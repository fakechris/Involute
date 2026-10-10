import type { Issue, Prisma } from '@prisma/client';

import { enqueueWorkEvent } from './event-outbox.js';

/**
 * Type: Incident (INV-1123). An incident that has happened is a fact, so like a
 * bug (decision INV-787) it is committed when declared — with a parent, a
 * severity and an impact statement — and starts In Progress: investigating.
 * Its owner, the declarer's human, is the Incident Lead. The "is incident"
 * checks live in labels.ts (isIncidentWork, namesIncident).
 */
export const INCIDENT_EVENT_TYPE = 'incident.declared';

/** Used when the declarer gives none: committed work needs acceptance to be claimed (INV-836). */
export const INCIDENT_DEFAULT_ACCEPTANCE = 'The impact described above has ended and the Incident Lead has confirmed recovery.';

const MAX_RECIPIENTS = 200;

/**
 * Tell the team an incident was declared: the incident.declared outbox event,
 * and an Inbox notification to every human on the team — not only the owner,
 * as other work events do: during an incident the whole team should know.
 * The person who declared it is not told what they just did.
 */
export async function announceIncident(transaction: Prisma.TransactionClient, issue: Issue, declaredById: string | null): Promise<void> {
  const payload = {
    identifier: issue.identifier,
    priority: issue.priority,
    severity: issue.severity,
    repository: issue.repository,
    title: issue.title,
  };
  const event = await enqueueWorkEvent(transaction, {
    payload,
    type: 'incident.declared',
    workId: issue.id,
    workIdentifier: issue.identifier,
  });
  const members = await transaction.teamMembership.findMany({
    where: { teamId: issue.teamId, user: { actorKind: 'HUMAN' }, ...(declaredById ? { userId: { not: declaredById } } : {}) },
    select: { userId: true },
    take: MAX_RECIPIENTS,
  });
  if (members.length === 0) return;
  await transaction.notification.createMany({
    data: members.map((member) => ({ payload, sourceEventId: event.id, teamId: issue.teamId, type: 'incident.declared', userId: member.userId, workId: issue.id })),
    skipDuplicates: true,
  });
}
