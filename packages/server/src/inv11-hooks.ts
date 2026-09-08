/**
 * INV-11: wire graded auto-accept after In Review transitions.
 * Patches enqueueWorkEvent so CLEAR evidence can auto-Done after
 * work.review_submitted (COMPLETED → In Review) and artifact.attached
 * (evidence while already In Review). Imported from run-service instead of
 * event-outbox for those call sites.
 */
import type { Prisma, PrismaClient } from '@prisma/client';

import {
  enqueueWorkEvent as originalEnqueue,
  type EnqueueWorkEventInput,
} from './event-outbox.js';

type DatabaseClient = PrismaClient | Prisma.TransactionClient;

const AUTO_ACCEPT_TRIGGER_TYPES = new Set(['work.review_submitted', 'artifact.attached']);

export async function enqueueWorkEvent(
  prisma: DatabaseClient,
  input: EnqueueWorkEventInput,
): Promise<{ id: string }> {
  const result = await originalEnqueue(prisma, input);
  if (!AUTO_ACCEPT_TRIGGER_TYPES.has(input.type)) {
    return result;
  }
  const payload = input.payload as { runId?: unknown };
  const runId = typeof payload?.runId === 'string' ? payload.runId : null;
  const { tryAutoAccept } = await import('./auto-accept-gate.js');
  await tryAutoAccept(prisma, input.workId, { runId });
  return result;
}

export type { EnqueueWorkEventInput };
