import type { Issue, Prisma } from '@prisma/client';

import {
  BUG_COMMIT_PRIORITY_REQUIRED_MESSAGE,
  WORK_COMMIT_PARENT_REJECTED_MESSAGE,
  WORK_COMMIT_PENDING_DELIVERY_MESSAGE,
  WORK_COMMIT_REQUIRES_ACCEPTANCE_MESSAGE,
  WORK_COMMIT_REQUIRES_PARENT_MESSAGE,
  WORK_COMMIT_SUPERSEDED_MESSAGE,
  WORK_READY_STATE_MISSING_MESSAGE,
} from './errors.js';
import { missingRequiredFields, requiredFieldsMessage } from './field-definitions.js';
import { isBugWork } from './labels.js';

type DatabaseClient = Prisma.TransactionClient;

export type CommitBlockerCode =
  | 'SUPERSEDED'
  | 'PENDING_DELIVERY_CHANGE'
  | 'MISSING_PARENT'
  | 'PARENT_REJECTED'
  | 'MISSING_ACCEPTANCE'
  | 'BUG_PRIORITY'
  | 'MISSING_FIELDS'
  | 'NO_READY_STATE';

export interface CommitBlocker {
  code: CommitBlockerCode;
  /** The message commitWork refuses with for the same reason, word for word. */
  message: string;
}

/** A blank acceptance, or the sentence an old batch commit filled in (INV-998). */
export const ACCEPTANCE_PLACEHOLDER = /^\s*Accepted and committed for execution\b/i;

export function lacksAcceptance(acceptance: string | null | undefined): boolean {
  const text = acceptance?.trim();
  return !text || ACCEPTANCE_PLACEHOLDER.test(text);
}

/**
 * Why committing this candidate as it stands would be refused (INV-2193), so a
 * person sees it on the card and a batch commit can stop before sending
 * anything instead of failing item by item. Same rules and messages as
 * commitWork; the owner is left out because it is chosen at commit, and so are
 * the values a person types at commit (acceptance, priority, parent, fields) —
 * the card says which of these it still needs, and filling them clears them.
 * Not a candidate: no blockers.
 */
export async function commitBlockers(
  prisma: DatabaseClient,
  issue: Pick<Issue, 'id' | 'teamId' | 'kind' | 'parentId' | 'attributes' | 'acceptance' | 'priority' | 'supersededById' | 'commitmentStatus'>,
): Promise<CommitBlocker[]> {
  if (issue.commitmentStatus !== 'CANDIDATE') return [];
  const blockers: CommitBlocker[] = [];
  if (issue.supersededById) blockers.push({ code: 'SUPERSEDED', message: WORK_COMMIT_SUPERSEDED_MESSAGE });
  if (await prisma.deliveryChangeSet.count({ where: { workId: issue.id, status: 'PENDING' } })) {
    blockers.push({ code: 'PENDING_DELIVERY_CHANGE', message: WORK_COMMIT_PENDING_DELIVERY_MESSAGE });
  }
  let parentId = issue.parentId;
  if (!parentId && issue.kind !== 'PROJECT') {
    const link = await prisma.workLink.findFirst({ where: { toId: issue.id, type: 'CONTAINS' }, select: { fromId: true } });
    parentId = link?.fromId ?? null;
  }
  if (issue.kind !== 'PROJECT') {
    if (!parentId) {
      blockers.push({ code: 'MISSING_PARENT', message: WORK_COMMIT_REQUIRES_PARENT_MESSAGE });
    } else {
      const parent = await prisma.issue.findUnique({ where: { id: parentId }, select: { commitmentStatus: true } });
      if (!parent || parent.commitmentStatus === 'REJECTED') blockers.push({ code: 'PARENT_REJECTED', message: WORK_COMMIT_PARENT_REJECTED_MESSAGE });
    }
  }
  if (lacksAcceptance(issue.acceptance)) blockers.push({ code: 'MISSING_ACCEPTANCE', message: WORK_COMMIT_REQUIRES_ACCEPTANCE_MESSAGE });
  if ((await isBugWork(prisma, issue.id)) && !(issue.priority >= 1 && issue.priority <= 4)) {
    blockers.push({ code: 'BUG_PRIORITY', message: BUG_COMMIT_PRIORITY_REQUIRED_MESSAGE });
  }
  const missing = await missingRequiredFields(prisma, { ...issue, parentId });
  if (missing.length) blockers.push({ code: 'MISSING_FIELDS', message: requiredFieldsMessage(missing) });
  const ready = await prisma.workflowState.findFirst({ where: { teamId: issue.teamId, type: 'UNSTARTED' }, select: { id: true } });
  if (!ready) blockers.push({ code: 'NO_READY_STATE', message: WORK_READY_STATE_MISSING_MESSAGE });
  return blockers;
}
