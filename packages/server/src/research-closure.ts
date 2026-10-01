import type { Issue, Prisma, PrismaClient } from '@prisma/client';

import { validateAgentDescription } from './claim-service.js';
import {
  createValidationError,
  RESEARCH_CLOSE_CLAIMED_MESSAGE,
  RESEARCH_CLOSE_NOT_COMMITTED_MESSAGE,
  RESEARCH_CLOSE_NOT_ISSUE_MESSAGE,
} from './errors.js';
import type { WriteActor } from './work-service.js';

type DatabaseClient = PrismaClient | Prisma.TransactionClient;

/**
 * The one exception to "agents stop at In Review" (INV-912). A research item's
 * deliverable is the item itself — its findings, sources and links — and work it
 * leads to is proposed separately, so once a person has committed it there is
 * nothing left for a person to accept. Everything else keeps the human gate:
 * other Types, MILESTONE/PROJECT/EPIC/DECISION, CANCELED, and uncommitted work.
 */
export const RESEARCH_CLOSE_REASON = 'research closed by agent (Type: Research)';

/** Source marker for a research candidate proposed with initial_state DONE; committing it lands in Done. */
export const INITIAL_DONE_MARKER = 'initial_state=DONE';

export function hasInitialDoneMarker(source: string | null | undefined): boolean {
  return Boolean(source?.includes(INITIAL_DONE_MARKER));
}

/**
 * Refuses, with the reason, an agent moving `work` (already known to carry
 * Type: Research) into Done. The caller decides that the transition is an agent
 * closing research; this states what has to be true for that to be allowed.
 */
export async function assertAgentMayCloseResearch(
  prisma: DatabaseClient,
  work: Issue,
  actor: WriteActor,
  now: Date = new Date(),
): Promise<void> {
  if (work.kind !== 'ISSUE') throw createValidationError(RESEARCH_CLOSE_NOT_ISSUE_MESSAGE);
  if (work.commitmentStatus !== 'COMMITTED') throw createValidationError(RESEARCH_CLOSE_NOT_COMMITTED_MESSAGE);
  const claim = await prisma.workClaim.findUnique({ where: { workId: work.id }, select: { actorId: true, leaseUntil: true } });
  if (claim && claim.leaseUntil > now && claim.actorId !== actor.actorId) {
    throw createValidationError(RESEARCH_CLOSE_CLAIMED_MESSAGE);
  }
  // The record is the deliverable, so it has to be one: the three-section description.
  validateAgentDescription(work.description, actor);
}
