import type { Issue, IssueSeverity, Prisma, PrismaClient } from '@prisma/client';

import { createValidationError, INCIDENT_CLOSE_NO_DOWNSTREAM_MESSAGE, INCIDENT_CLOSE_NO_POSTMORTEM_MESSAGE } from './errors.js';
import { enqueueWorkEvent } from './event-outbox.js';
import { isIncidentWork } from './labels.js';
import { projectDecisionNotifications } from './notification-service.js';
import { missingCloseRequirements, type CloseRequirement } from './work-closure.js';

type DatabaseClient = PrismaClient | Prisma.TransactionClient;

/**
 * Closing an incident (INV-1126). An incident is finished when what it taught
 * has turned into work: follow-ups DERIVED_FROM it, or a statement that there
 * was nothing to act on ("无可执行点"). A SEV1 or SEV2 incident also carries
 * its postmortem as an attachment (docs/postmortem.md). The rule is about the
 * work, not the actor: every path into Done checks it — the issue page, the
 * board, review acceptance and creation straight into Done.
 */
export const POSTMORTEM_SEVERITIES: ReadonlySet<IssueSeverity> = new Set<IssueSeverity>(['SEV1', 'SEV2']);

export function incidentNeedsPostmortem(severity: IssueSeverity | null | undefined): boolean {
  return Boolean(severity && POSTMORTEM_SEVERITIES.has(severity));
}

export function incidentCloseRequirements(severity: IssueSeverity | null | undefined): CloseRequirement[] {
  return incidentNeedsPostmortem(severity) ? ['downstream', 'attachment'] : ['downstream'];
}

/**
 * Refuses, with the reason, moving `work` into Done when it is an incident that
 * has not met its closing requirements. Not an incident: no-op. `work` carries
 * the values that will stand once the change is saved (a description or
 * severity sent with the close replaces the stored one).
 */
export async function assertIncidentMayClose(prisma: DatabaseClient, work: Issue): Promise<void> {
  if (!(await isIncidentWork(prisma, work.id))) return;
  const missing = await missingCloseRequirements(prisma, work, incidentCloseRequirements(work.severity));
  if (missing.includes('downstream')) throw createValidationError(INCIDENT_CLOSE_NO_DOWNSTREAM_MESSAGE);
  if (missing.includes('attachment')) throw createValidationError(INCIDENT_CLOSE_NO_POSTMORTEM_MESSAGE);
}

/**
 * Open incidents `workId` was derived from whose follow-ups are now all
 * committed: nothing left to wait for before closing them.
 */
export async function closableIncidentSources(prisma: DatabaseClient, workId: string): Promise<Issue[]> {
  const links = await prisma.workLink.findMany({ where: { type: 'DERIVED_FROM', fromId: workId }, select: { toId: true } });
  const closable: Issue[] = [];
  for (const { toId } of links) {
    const incident = await prisma.issue.findUnique({ where: { id: toId }, include: { state: { select: { type: true } } } });
    if (!incident || incident.commitmentStatus !== 'COMMITTED' || incident.state.type === 'COMPLETED' || incident.state.type === 'CANCELED') continue;
    if (!(await isIncidentWork(prisma, incident.id))) continue;
    const derived = await prisma.workLink.findMany({ where: { type: 'DERIVED_FROM', toId }, select: { from: { select: { commitmentStatus: true } } } });
    if (derived.length > 0 && derived.every((link) => link.from.commitmentStatus === 'COMMITTED')) {
      const { state: _state, ...rest } = incident;
      closable.push(rest);
    }
  }
  return closable;
}

/**
 * Committing `work` may be the last follow-up an incident was waiting for:
 * then its declarer, and the Incident Lead who closes it, are told it can be
 * closed — once per incident (mirrors research.closable, INV-1001).
 */
export async function notifyClosableIncidents(prisma: DatabaseClient, work: Pick<Issue, 'id' | 'identifier'>): Promise<void> {
  for (const incident of await closableIncidentSources(prisma, work.id)) {
    if (await prisma.notification.count({ where: { type: 'incident.closable', workId: incident.id } })) continue;
    const payload = {
      lastFollowUpWorkId: work.id,
      lastFollowUpIdentifier: work.identifier,
      postmortemRequired: incidentNeedsPostmortem(incident.severity),
    };
    const event = await enqueueWorkEvent(prisma, { type: 'incident.closable', workId: incident.id, workIdentifier: incident.identifier, payload });
    await projectDecisionNotifications(prisma, {
      alsoNotify: [incident.assigneeId],
      deciderId: null,
      eventId: event.id,
      payload,
      type: 'incident.closable',
      work: incident,
    });
  }
}
