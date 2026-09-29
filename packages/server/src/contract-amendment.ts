import {
  CONTRACT_AMENDMENT_AGENTS_ONLY_MESSAGE,
  CONTRACT_AMENDMENT_ALREADY_DECIDED_MESSAGE,
  CONTRACT_AMENDMENT_FIELDS_MESSAGE,
  CONTRACT_AMENDMENT_HUMAN_ONLY_MESSAGE,
  CONTRACT_AMENDMENT_NO_CHANGE_MESSAGE,
  CONTRACT_AMENDMENT_NOT_FOUND_MESSAGE,
  CONTRACT_AMENDMENT_REASON_REQUIRED_MESSAGE,
  CONTRACT_AMENDMENT_REJECT_NOTE_REQUIRED_MESSAGE,
  CONTRACT_AMENDMENT_REQUIRES_COMMITTED_MESSAGE,
  CONTRACT_AMENDMENT_STALE_MESSAGE,
  ISSUE_NOT_FOUND_MESSAGE,
  WORK_COMMIT_REQUIRES_ACCEPTANCE_MESSAGE,
  createNotFoundError,
  createValidationError,
} from './errors.js';
import { enqueueWorkEvent } from './event-outbox.js';
import { lockWorkGraph } from './graph-integrity.js';
import { updateIssue } from './issue-service.js';
import { projectWorkNotifications } from './notification-service.js';
import { recordWorkAudit, selectIssueSnapshot, type WriteActor } from './work-service.js';

import type { ContractAmendment, Issue, Prisma, PrismaClient } from '@prisma/client';

/**
 * Contract amendments (INV-869). A committed contract is human-owned: agents
 * may not rewrite it (issue-service), because the one executing the work must
 * not be able to move its own goalposts. That rule stays. What it lacked was a
 * way for an agent to say "this contract is wrong, here is the fix" other than
 * prose in a run summary that a person then retyped by hand.
 *
 * An amendment is that fix as data: the fields it changes, the values they had
 * when it was proposed, and why. A person accepts or rejects it. Accepting runs
 * the same `updateIssue` a manual edit runs, as that person, so the contract,
 * revision, audit and run-binding hash come out exactly as if they had typed it.
 *
 * Staleness is judged on the fields the amendment touches, not on `revision`:
 * revision moves on every update — the run report that sends the work to Review
 * bumps it — so a revision check would make almost every amendment stale.
 */

export const CONTRACT_FIELDS = ['acceptance', 'constraints', 'outcome', 'scope', 'verification'] as const;
export type ContractField = (typeof CONTRACT_FIELDS)[number];
export type ContractValues = Partial<Record<ContractField, string | null>>;

export interface ContractFieldChange {
  after: string | null;
  before: string | null;
  field: ContractField;
}

function isContractField(key: string): key is ContractField {
  return (CONTRACT_FIELDS as readonly string[]).includes(key);
}

/** Blank and whitespace-only mean "no value", as they do when a person saves the form. */
function normalize(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function parseChanges(raw: unknown): ContractValues {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw createValidationError(CONTRACT_AMENDMENT_FIELDS_MESSAGE);
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length === 0) {
    throw createValidationError(CONTRACT_AMENDMENT_FIELDS_MESSAGE);
  }
  const changes: ContractValues = {};
  for (const [key, value] of entries) {
    if (!isContractField(key) || (value !== null && typeof value !== 'string')) {
      throw createValidationError(CONTRACT_AMENDMENT_FIELDS_MESSAGE);
    }
    changes[key] = normalize(value);
  }
  return changes;
}

function storedValues(json: Prisma.JsonValue): ContractValues {
  return (json ?? {}) as ContractValues;
}

/** The fields an amendment changes, each with the value it replaces and the value it proposes. */
export function amendmentChanges(amendment: Pick<ContractAmendment, 'before' | 'changes'>): ContractFieldChange[] {
  const before = storedValues(amendment.before);
  const changes = storedValues(amendment.changes);
  return CONTRACT_FIELDS.filter((field) => field in changes).map((field) => ({
    after: changes[field] ?? null,
    before: before[field] ?? null,
    field,
  }));
}

/** True when a field the amendment touches no longer holds the value it was proposed against. */
export function isAmendmentStale(amendment: Pick<ContractAmendment, 'before'>, work: Pick<Issue, ContractField>): boolean {
  const before = storedValues(amendment.before);
  return (Object.keys(before) as ContractField[]).some((field) => normalize(work[field]) !== (before[field] ?? null));
}

export async function proposeContractAmendment(
  prisma: PrismaClient,
  input: { changes: unknown; reason: string; workId: string },
  actor: WriteActor,
): Promise<ContractAmendment> {
  const proposedById = actor.actorId;
  if (actor.actorKind === 'HUMAN' || !proposedById) {
    throw createValidationError(CONTRACT_AMENDMENT_AGENTS_ONLY_MESSAGE);
  }
  const requested = parseChanges(input.changes);
  const reason = input.reason?.trim();
  if (!reason) {
    throw createValidationError(CONTRACT_AMENDMENT_REASON_REQUIRED_MESSAGE);
  }
  if ('acceptance' in requested && !requested.acceptance) {
    throw createValidationError(WORK_COMMIT_REQUIRES_ACCEPTANCE_MESSAGE);
  }

  return prisma.$transaction(async (tx) => {
    const hint = await tx.issue.findUnique({ where: { id: input.workId }, select: { teamId: true } });
    if (!hint) throw createNotFoundError(ISSUE_NOT_FOUND_MESSAGE);
    await lockWorkGraph(tx, hint.teamId);
    const work = await tx.issue.findUniqueOrThrow({ where: { id: input.workId } });
    if (work.commitmentStatus !== 'COMMITTED') {
      throw createValidationError(CONTRACT_AMENDMENT_REQUIRES_COMMITTED_MESSAGE);
    }

    const changes: ContractValues = {};
    const before: ContractValues = {};
    for (const field of CONTRACT_FIELDS) {
      if (!(field in requested)) continue;
      const current = normalize(work[field]);
      if (requested[field] === current) continue;
      changes[field] = requested[field] ?? null;
      before[field] = current;
    }
    if (Object.keys(changes).length === 0) {
      throw createValidationError(CONTRACT_AMENDMENT_NO_CHANGE_MESSAGE);
    }

    // One open amendment per item: the newest proposal is the agent's current view.
    await tx.contractAmendment.updateMany({
      where: { status: 'PENDING', workId: work.id },
      data: { decidedAt: new Date(), status: 'SUPERSEDED' },
    });
    const amendment = await tx.contractAmendment.create({
      data: {
        baseRevision: work.revision,
        before,
        changes,
        proposedById,
        reason,
        workId: work.id,
      },
    });

    const fields = Object.keys(changes);
    const snapshot = selectIssueSnapshot(work);
    await recordWorkAudit(tx, {
      actor: {
        ...actor,
        reason: `contract amendment proposed (${fields.join(', ')}): ${reason}`,
        sourceMessageId: amendment.id,
      },
      after: snapshot,
      before: snapshot,
      workId: work.id,
    });
    const payload = { amendmentId: amendment.id, fields, proposedByActorId: proposedById, reason };
    const event = await enqueueWorkEvent(tx, {
      payload,
      type: 'contract.amendment_proposed',
      workId: work.id,
      workIdentifier: work.identifier,
    });
    await projectWorkNotifications(tx, { eventId: event.id, payload, type: 'contract.amendment_proposed', work });

    return amendment;
  });
}

async function loadPendingForDecision(
  tx: Prisma.TransactionClient,
  amendmentId: string,
): Promise<{ amendment: ContractAmendment; work: Issue }> {
  const found = await tx.contractAmendment.findUnique({ where: { id: amendmentId }, select: { workId: true } });
  if (!found) throw createNotFoundError(CONTRACT_AMENDMENT_NOT_FOUND_MESSAGE);
  const hint = await tx.issue.findUniqueOrThrow({ where: { id: found.workId }, select: { teamId: true } });
  await lockWorkGraph(tx, hint.teamId);
  const amendment = await tx.contractAmendment.findUniqueOrThrow({ where: { id: amendmentId } });
  if (amendment.status !== 'PENDING') {
    throw createValidationError(CONTRACT_AMENDMENT_ALREADY_DECIDED_MESSAGE);
  }
  const work = await tx.issue.findUniqueOrThrow({ where: { id: amendment.workId } });
  return { amendment, work };
}

async function settle(
  tx: Prisma.TransactionClient,
  amendment: ContractAmendment,
  decision: { decidedById: string; note: string | null; status: 'ACCEPTED' | 'REJECTED' },
): Promise<ContractAmendment> {
  // CAS on status: two people deciding at once must not both win.
  const moved = await tx.contractAmendment.updateMany({
    where: { id: amendment.id, status: 'PENDING' },
    data: {
      decidedAt: new Date(),
      decidedById: decision.decidedById,
      decisionNote: decision.note,
      status: decision.status,
    },
  });
  if (moved.count !== 1) {
    throw createValidationError(CONTRACT_AMENDMENT_ALREADY_DECIDED_MESSAGE);
  }
  return tx.contractAmendment.findUniqueOrThrow({ where: { id: amendment.id } });
}

export async function acceptContractAmendment(
  prisma: PrismaClient,
  input: { amendmentId: string; note?: string | null },
  actor: WriteActor,
): Promise<{ amendment: ContractAmendment; work: Issue }> {
  const decidedById = actor.actorId;
  if (actor.actorKind !== 'HUMAN' || !decidedById) {
    throw createValidationError(CONTRACT_AMENDMENT_HUMAN_ONLY_MESSAGE);
  }
  const note = normalize(input.note);

  return prisma.$transaction(async (tx) => {
    const { amendment, work } = await loadPendingForDecision(tx, input.amendmentId);
    if (isAmendmentStale(amendment, work)) {
      throw createValidationError(CONTRACT_AMENDMENT_STALE_MESSAGE);
    }
    const settled = await settle(tx, amendment, { decidedById, note, status: 'ACCEPTED' });
    // The same write a person makes from the Contract form, as that person.
    const updated = await updateIssue(tx, work.id, storedValues(amendment.changes), {
      ...actor,
      reason: `contract amendment accepted: ${amendment.reason}${note ? ` (note: ${note})` : ''}`,
      sourceMessageId: amendment.id,
    });
    await enqueueWorkEvent(tx, {
      payload: { amendmentId: amendment.id, decidedByActorId: decidedById, fields: Object.keys(storedValues(amendment.changes)), note },
      type: 'contract.amendment_accepted',
      workId: work.id,
      workIdentifier: work.identifier,
    });
    return { amendment: settled, work: updated };
  });
}

export async function rejectContractAmendment(
  prisma: PrismaClient,
  input: { amendmentId: string; note: string },
  actor: WriteActor,
): Promise<{ amendment: ContractAmendment; work: Issue }> {
  const decidedById = actor.actorId;
  if (actor.actorKind !== 'HUMAN' || !decidedById) {
    throw createValidationError(CONTRACT_AMENDMENT_HUMAN_ONLY_MESSAGE);
  }
  const note = normalize(input.note);
  if (!note) {
    throw createValidationError(CONTRACT_AMENDMENT_REJECT_NOTE_REQUIRED_MESSAGE);
  }

  return prisma.$transaction(async (tx) => {
    const { amendment, work } = await loadPendingForDecision(tx, input.amendmentId);
    const settled = await settle(tx, amendment, { decidedById, note, status: 'REJECTED' });
    const snapshot = selectIssueSnapshot(work);
    await recordWorkAudit(tx, {
      actor: {
        ...actor,
        reason: `contract amendment rejected: ${note}`,
        sourceMessageId: amendment.id,
      },
      after: snapshot,
      before: snapshot,
      workId: work.id,
    });
    await enqueueWorkEvent(tx, {
      payload: { amendmentId: amendment.id, decidedByActorId: decidedById, note },
      type: 'contract.amendment_rejected',
      workId: work.id,
      workIdentifier: work.identifier,
    });
    return { amendment: settled, work };
  });
}
