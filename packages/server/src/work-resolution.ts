import type { Prisma, WorkResolution } from '@prisma/client';

import {
  BUG_CANCEL_REASON_REQUIRED_MESSAGE,
  createValidationError,
  WORK_RESOLUTION_INVALID_MESSAGE,
} from './errors.js';
import { enqueueWorkEvent } from './event-outbox.js';

/**
 * Structured close reasons (INV-1118). A rejected candidate and committed work
 * moved to a CANCELED state always carry one; the free-text reason stays on the
 * audit row and the event payload. Bugzilla's FIXED/WONTFIX/INVALID/DUPLICATE/
 * WORKSFORME and GitHub's "not planned" are the models.
 */
export const WORK_RESOLUTIONS: readonly WorkResolution[] = [
  'COMPLETED',
  'WONT_DO',
  'INVALID',
  'DUPLICATE',
  'CANNOT_REPRODUCE',
  'OBSOLETE',
];

/**
 * Reads a resolution from any surface: GraphQL sends the enum name, the CLI
 * and the contract spell it lowercase (`wont_do`, `cannot-reproduce`). Empty
 * means "none given"; anything else unknown is refused with the valid list.
 */
export function parseWorkResolution(value: string | null | undefined): WorkResolution | null {
  const normalized = value?.trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (!normalized) return null;
  if ((WORK_RESOLUTIONS as readonly string[]).includes(normalized)) return normalized as WorkResolution;
  throw createValidationError(WORK_RESOLUTION_INVALID_MESSAGE);
}

/** A bug is never closed without saying why (zero-bug, INV-750). */
export function assertBugCloseReason(isBug: boolean, reason: string | null): void {
  if (isBug && !reason) throw createValidationError(BUG_CANCEL_REASON_REQUIRED_MESSAGE);
}

/**
 * The event a cancel emits: subscribers and the activity feed learn why the
 * work was closed, not only that its state changed.
 */
export async function enqueueWorkCanceledEvent(
  tx: Prisma.TransactionClient,
  input: {
    work: { id: string; identifier: string; revision: number; stateId: string };
    before: { revision: number; stateId: string };
    actorId: string | null | undefined;
    resolution: WorkResolution;
    reason: string | null;
    duplicateOfId?: string | null;
    /** Who closed it: a person by default, `duplicate` when a DUPLICATE_OF link did (INV-1124). */
    source?: 'person' | 'duplicate';
  },
): Promise<{ id: string }> {
  return enqueueWorkEvent(tx, {
    type: 'work.state_changed',
    workId: input.work.id,
    workIdentifier: input.work.identifier,
    payload: {
      source: input.source ?? 'person',
      stateType: 'CANCELED',
      actorId: input.actorId ?? null,
      resolution: input.resolution,
      reason: input.reason,
      ...(input.duplicateOfId ? { duplicateOfId: input.duplicateOfId } : {}),
    },
    updatedFrom: { revision: input.before.revision, stateId: input.before.stateId },
  });
}
