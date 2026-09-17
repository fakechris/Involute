import { createValidationError } from './errors.js';

import type { DecisionReceipt, Prisma, PrismaClient } from '@prisma/client';

type DatabaseClient = PrismaClient | Prisma.TransactionClient;

export const MAX_REASONING_LENGTH = 4_000;
export const MAX_REFERENCES = 50;
export const MAX_EXCERPT_LENGTH = 2_000;

export const RECEIPT_ACTOR_MISMATCH_MESSAGE =
  'Receipt actor does not match the audited write. A receipt is written by the actor that made the write; it cannot name someone else.';
export const RECEIPT_REASONING_REQUIRED_MESSAGE = 'A receipt needs reasoning: what you knew and why you decided.';
export const RECEIPT_ALREADY_ATTACHED_MESSAGE = 'This write already has a receipt; receipts are immutable.';

/**
 * A reference the actor relied on. By id alone this does not preserve "what it
 * saw": comments get edited, files change, URLs die. So a reference carries a
 * version, a digest or a frozen excerpt — and when none was given, it is
 * marked `preserved: false` explicitly, so a reader knows the record is a
 * pointer and not a snapshot.
 */
export interface ReceiptReferenceInput {
  /** What kind of thing: `comment`, `file`, `commit`, `url`, `work`, `run`, `message`. */
  kind: string;
  /** The pointer: an id, path, URL, or identifier. */
  ref: string;
  /** A version, revision, commit sha, or timestamp that pins the pointer. */
  version?: string | null;
  /** Content digest of what was read, if the caller computed one. */
  digest?: string | null;
  /** A short frozen excerpt of what was actually seen. */
  excerpt?: string | null;
}

export interface ReceiptReference extends ReceiptReferenceInput {
  /** True when the reference carries enough (version, digest or excerpt) to reconstruct what was seen. */
  preserved: boolean;
}

/** What the agent supplies. Identity and time are NOT here on purpose. */
export interface ReceiptInput {
  reasoning: string;
  evidence?: ReceiptReferenceInput[] | null;
  inputs?: ReceiptReferenceInput[] | null;
  /** Snapshot of the runtime at the moment of the decision, e.g. `claude-code 2.1`. */
  runtime?: string | null;
  /**
   * Optional self-report of who is writing. It is validated against the
   * audit, never trusted: a mismatch is rejected rather than stored.
   */
  actorId?: string | null;
}

function normalizeReference(input: ReceiptReferenceInput): ReceiptReference {
  const kind = input.kind.trim();
  const ref = input.ref.trim();
  if (!kind || !ref) {
    throw createValidationError('Each receipt reference needs a kind and a ref.');
  }
  const version = input.version?.trim() || null;
  const digest = input.digest?.trim() || null;
  const excerpt = input.excerpt ? input.excerpt.slice(0, MAX_EXCERPT_LENGTH) : null;

  return {
    digest,
    excerpt,
    kind,
    preserved: Boolean(version || digest || excerpt),
    ref,
    version,
  };
}

function normalizeReferences(inputs: ReceiptReferenceInput[] | null | undefined): ReceiptReference[] {
  const list = inputs ?? [];
  if (list.length > MAX_REFERENCES) {
    throw createValidationError(`A receipt may carry at most ${MAX_REFERENCES} references.`);
  }
  return list.map(normalizeReference);
}

/**
 * Attach a receipt to an audited write, in the same transaction as the write.
 *
 * Three rules from the design review, all enforced here:
 * 1. **Identity and time come from the audit**, not the payload. The receipt's
 *    `actorId` and `sessionId` are copied from the audit row; a self-reported
 *    `actorId` that disagrees is rejected, not stored.
 * 2. **References are marked preserved or not.** Nothing is silently a pointer.
 * 3. **Receipts are immutable** and 1:1 with the audit. A second attach to the
 *    same audit fails rather than overwriting.
 */
export async function attachDecisionReceipt(
  db: DatabaseClient,
  input: { auditId: string; receipt: ReceiptInput },
): Promise<DecisionReceipt> {
  const reasoning = input.receipt.reasoning?.trim() ?? '';
  if (!reasoning) {
    throw createValidationError(RECEIPT_REASONING_REQUIRED_MESSAGE);
  }

  const audit = await db.workAudit.findUnique({
    where: { id: input.auditId },
    select: { actorId: true, after: true, id: true, sessionId: true },
  });
  if (!audit) {
    throw createValidationError('Receipt refers to an audit row that does not exist.');
  }
  if (!audit.actorId) {
    // Legacy anonymous writes cannot carry a receipt: there is no one it could
    // be the statement of. This is a feature, not a gap — see actor-model E.
    throw createValidationError('The audited write has no actor; a receipt cannot be attached to an anonymous write.');
  }
  if (input.receipt.actorId && input.receipt.actorId !== audit.actorId) {
    throw createValidationError(RECEIPT_ACTOR_MISMATCH_MESSAGE);
  }

  const existing = await db.decisionReceipt.findUnique({ where: { auditId: audit.id } });
  if (existing) {
    throw createValidationError(RECEIPT_ALREADY_ATTACHED_MESSAGE);
  }

  const snapshot = audit.after as { revision?: number } | null;

  return db.decisionReceipt.create({
    data: {
      actorId: audit.actorId,
      auditId: audit.id,
      contractRevision: snapshot?.revision ?? 0,
      evidence: normalizeReferences(input.receipt.evidence) as unknown as Prisma.InputJsonValue,
      inputs: normalizeReferences(input.receipt.inputs) as unknown as Prisma.InputJsonValue,
      reasoning: reasoning.slice(0, MAX_REASONING_LENGTH),
      runtime: input.receipt.runtime?.trim() || null,
      sessionId: audit.sessionId,
    },
  });
}

/** The most recent audit row for a work item, used to attach a receipt right after a write. */
export async function latestAuditId(db: DatabaseClient, workId: string): Promise<string> {
  const audit = await db.workAudit.findFirstOrThrow({
    where: { workId },
    orderBy: [{ createdAt: 'desc' }, { revision: 'desc' }],
    select: { id: true },
  });
  return audit.id;
}
