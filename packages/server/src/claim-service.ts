import type { ActorKind, Issue, Prisma, PrismaClient, User, WorkClaim, WorkLinkType } from '@prisma/client';

import {
  createNotFoundError,
  createValidationError,
  ISSUE_NOT_FOUND_MESSAGE,
  BUG_COMMIT_PRIORITY_REQUIRED_MESSAGE,
  BUG_NO_BACKLOG_MESSAGE,
  BUG_REJECT_REASON_REQUIRED_MESSAGE,
  ISSUE_CREATE_REQUIRES_PARENT_MESSAGE,
  PARENT_ISSUE_NOT_FOUND_MESSAGE,
  WORK_ALREADY_CLAIMED_MESSAGE,
  WORK_ACCEPT_FORBIDDEN_MESSAGE,
  WORK_CLAIM_REQUIRES_ACTOR_MESSAGE,
  WORK_COMMIT_FORBIDDEN_MESSAGE,
  WORK_REJECT_FORBIDDEN_MESSAGE,
  WORK_COMMIT_REQUIRES_ACCEPTANCE_MESSAGE,
  WORK_COMMIT_REQUIRES_OWNER_MESSAGE,
  WORK_COMMIT_REQUIRES_PARENT_MESSAGE,
  WORK_COMMIT_PARENT_REJECTED_MESSAGE,
  WORK_COMMIT_PARENT_CONFLICT_MESSAGE,
  WORK_NOT_CANDIDATE_MESSAGE,
  WORK_NOT_COMMITTED_MESSAGE,
  WORK_NOT_READY_MESSAGE,
  WORK_OWNER_MUST_BE_HUMAN_MESSAGE,
  WORK_OWNER_MUST_BELONG_TO_TEAM_MESSAGE,
  WORK_READY_STATE_MISSING_MESSAGE,
  WORK_RELATED_NOT_FOUND_MESSAGE,
  WORK_REVISION_CONFLICT_MESSAGE,
  WORK_IDEMPOTENCY_CONFLICT_MESSAGE,
  WORK_IDEMPOTENCY_RESULT_UNAVAILABLE_MESSAGE,
  AGENT_DESCRIPTION_REQUIRED_MESSAGE,
  WORKFLOW_STATE_NOT_FOUND_MESSAGE,
} from './errors.js';
import { findWorkByIdOrIdentifier, isWorkReadyForClaim } from './context-service.js';
import { enqueueWorkEvent } from './event-outbox.js';
import { attachDecisionReceipt, type ReceiptInput } from './decision-receipt.js';
import { createWorkLink } from './link-service.js';
import { isLegalContains } from './graph-integrity.js';
import { createIssueWithAudit, mentionTexts, type CreateIssueInput } from './issue-service.js';
import { linkMentionedWork } from './mention-links.js';
import { findOrCreateLabelIds, isBugWork } from './labels.js';
import {
  completeWorkIdempotency,
  hashIdempotencyRequest,
  isUniqueConstraintError,
  reserveWorkIdempotency,
} from './idempotency.js';
import {
  claimIssueRevision,
  INTERNAL_WRITE_ACTOR,
  recordWorkAudit,
  selectIssueSnapshot,
  type WriteActor,
} from './work-service.js';

type DatabaseClient = PrismaClient | Prisma.TransactionClient;

export const DEFAULT_CLAIM_LEASE_SECONDS = 2 * 60 * 60;

export type WorkPermission = 'propose' | 'commit' | 'reject' | 'claim' | 'update' | 'accept';

export interface ProposeWorkInput {
  /** What the proposer knew and why — attached to the creation audit (INV-588). */
  receipt?: ReceiptInput | null;
  acceptance?: string | null;
  constraints?: string | null;
  description?: string | null;
  idempotencyKey?: string | null;
  initialState?: string | null;
  kind?: Issue['kind'] | null;
  outcome?: string | null;
  parentId?: string | null;
  relatedWorkId?: string | null;
  relatedWorkType?: WorkLinkType | null;
  /** Label names, created when missing (e.g. "research", INV-721). */
  labels?: string[] | null;
  /** Existing work (ids or identifiers) this proposal is blocked by — each becomes X BLOCKS new (INV-720). */
  blockedBy?: string[] | null;
  /** Existing work this proposal blocks — each becomes new BLOCKS X. */
  blocks?: string[] | null;
  repository?: string | null;
  scope?: string | null;
  /** Where the candidate came from: agent / web / cli / import. */
  source?: string | null;
  teamId: string;
  title: string;
  verification?: string | null;
}

export interface CommitWorkInput {
  acceptance?: string | null;
  /** Place the candidate under this parent as part of committing it (INV-719). */
  parentId?: string | null;
  assigneeId?: string | null;
  expectedRevision: number;
  /** 1 (Urgent) to 4 (Low); a bug needs one to be committed, it sets the SLA (INV-750). */
  priority?: number | null;
  idempotencyKey?: string | null;
  outcome?: string | null;
  scope?: string | null;
  stateId?: string | null;
  constraints?: string | null;
  verification?: string | null;
}

export interface ClaimWorkInput {
  idempotencyKey?: string | null;
  leaseSeconds?: number | null;
}

export interface RejectWorkInput {
  expectedRevision: number;
  idempotencyKey?: string | null;
  reason?: string | null;
}

// Commit, reject and accept are the human gates: "agents propose, humans
// commit". They are stated as a capability set per actor kind rather than as
// "is this an AGENT", because the old shape granted them to everything that
// was not literally an AGENT — including SERVICE, which is what
// `writeActorFromViewer` returns for a null viewer. An actor we could not
// identify was therefore *more* privileged than a registered agent (INV-573).
const HUMAN_GATED_PERMISSIONS: readonly WorkPermission[] = ['commit', 'reject', 'accept'];

export function assertActorCan(actorKind: ActorKind | null | undefined, permission: WorkPermission): void {
  if (!HUMAN_GATED_PERMISSIONS.includes(permission)) {
    return;
  }

  if (actorKind === 'HUMAN') {
    return;
  }

  if (permission === 'commit') {
    throw createValidationError(WORK_COMMIT_FORBIDDEN_MESSAGE);
  }

  if (permission === 'reject') {
    throw createValidationError(WORK_REJECT_FORBIDDEN_MESSAGE);
  }

  throw createValidationError(WORK_ACCEPT_FORBIDDEN_MESSAGE);
}

export const STATUS_PREFIX_REGEX = /^\[(已交付|已完成|待办|已解决|已关闭|进行中|done|completed|todo|fixed|in progress)\]\s*/i;

export function sanitizeWorkTitle(title: string): { title: string; warning: string | null } {
  if (STATUS_PREFIX_REGEX.test(title)) {
    const cleaned = title.replace(STATUS_PREFIX_REGEX, '').trim();
    return {
      title: cleaned,
      warning: `Status prefix was automatically removed from title: "${title}" -> "${cleaned}". Do not encode work status into titles; use work_claim and run_report to transition states.`,
    };
  }
  return { title, warning: null };
}

export function validateAgentDescription(
  description: string | null | undefined,
  actor: WriteActor,
): void {
  // Lazy references like "ref docs/..." are strictly forbidden for all surfaces/actors
  if (description && /^ref\s*:?\s*docs\//i.test(description.trim())) {
    throw createValidationError(AGENT_DESCRIPTION_REQUIRED_MESSAGE);
  }

  // Mandatory 3-section Chinese description strictly enforced for AGENT actors
  if (actor.actorKind === 'AGENT') {
    if (!description || description.trim().length === 0) {
      throw createValidationError(AGENT_DESCRIPTION_REQUIRED_MESSAGE);
    }
    const hasSection1 = /1\.\s*目标与架构定位|目标与架构定位/.test(description);
    const hasSection2 = /2\.\s*核心功能与交付范围|核心功能与交付范围/.test(description);
    const hasSection3 = /3\.\s*验收标准与验证方案|验收标准与验证方案/.test(description);

    if (!hasSection1 || !hasSection2 || !hasSection3) {
      throw createValidationError(AGENT_DESCRIPTION_REQUIRED_MESSAGE);
    }
  }
}

export function normalizeInitialStateType(raw: string | null | undefined): 'BACKLOG' | 'UNSTARTED' | 'STARTED' | 'REVIEW' | null {
  if (!raw) return null;
  const s = raw.trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (s === 'COMPLETED' || s === 'DONE' || s === 'CANCELED' || s === 'CANCELLED') {
    throw createValidationError(
      'Candidate initial_state cannot be COMPLETED or CANCELED. Agents stop at In Review; Done is human-gated.',
    );
  }
  if (s === 'BACKLOG') return 'BACKLOG';
  if (s === 'STARTED' || s === 'IN_PROGRESS') return 'STARTED';
  if (s === 'REVIEW' || s === 'IN_REVIEW') return 'REVIEW';
  if (s === 'UNSTARTED' || s === 'READY') return 'UNSTARTED';
  return null;
}

const INHERITING_LINK_TYPES: ReadonlySet<WorkLinkType> = new Set(['DISCOVERED_DURING', 'DERIVED_FROM']);

/**
 * The nearest item at or above `related` that may legally contain a new item
 * of `child.kind` in the same repository — e.g. a fix found while doing an
 * issue lands in that issue's milestone, a decision in its project. Null when
 * nothing up the chain qualifies (cross-repository discovery, unplaced work);
 * the proposal then stays unplaced and the commit gate asks for a parent.
 */
export async function findInheritableParent(
  prisma: Prisma.TransactionClient | PrismaClient,
  related: Issue,
  child: { kind: Issue['kind']; repository: string | null },
): Promise<Issue | null> {
  const seen = new Set<string>();
  let current: Issue | null = related;
  // Start at the related item's parent for peers (an ISSUE found during an
  // ISSUE is its sibling, not its sub-issue); a container itself qualifies.
  if (current.kind === 'ISSUE' || current.kind === child.kind) {
    current = current.parentId ? await prisma.issue.findUnique({ where: { id: current.parentId } }) : null;
  }
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    const repository = child.repository ?? current.repository;
    if (current.repository && current.repository === repository && isLegalContains(current.kind, child.kind)) {
      return current;
    }
    current = current.parentId ? await prisma.issue.findUnique({ where: { id: current.parentId } }) : null;
  }
  return null;
}

/**
 * The commit gate for direct creation (INV-744): work created already
 * committed — the board's Create issue — needs a parent unless it is a
 * PROJECT. Resolves `parentId` given as id or identifier, refuses rejected
 * parents, and inherits the parent's repository so the CONTAINS edge is legal;
 * kind, team and repository legality are checked when the edge is written.
 */
export async function placeNewWork<T extends CreateIssueInput>(prisma: Prisma.TransactionClient | PrismaClient, input: T): Promise<T> {
  if ((input.kind ?? 'ISSUE') === 'PROJECT') return input;
  if (!input.parentId?.trim()) throw createValidationError(ISSUE_CREATE_REQUIRES_PARENT_MESSAGE);
  const parent = await findWorkByIdOrIdentifier(prisma, input.parentId.trim());
  if (!parent || parent.teamId !== input.teamId) throw createNotFoundError(PARENT_ISSUE_NOT_FOUND_MESSAGE);
  if (parent.commitmentStatus === 'REJECTED') throw createValidationError(WORK_COMMIT_PARENT_REJECTED_MESSAGE);
  return { ...input, parentId: parent.id, repository: input.repository ?? parent.repository };
}

export async function proposeWork(
  prisma: PrismaClient,
  input: ProposeWorkInput,
  actor: WriteActor = INTERNAL_WRITE_ACTOR,
): Promise<Issue> {
  assertActorCan(actor.actorKind, 'propose');
  validateAgentDescription(input.description, actor);
  const { title: sanitizedTitle } = sanitizeWorkTitle(input.title);

  return prisma.$transaction(async (transaction) => {
    let idempotencyId: string | null = null;
    if (input.idempotencyKey) {
      const reservation = await reserveWorkIdempotency(transaction, {
        actor,
        key: input.idempotencyKey,
        operation: 'propose',
        requestHash: hashIdempotencyRequest({ ...input, idempotencyKey: null }),
        teamId: input.teamId,
      });
      if (!reservation.created) {
        if (!reservation.record.workId) {
          throw createValidationError(WORK_IDEMPOTENCY_RESULT_UNAVAILABLE_MESSAGE);
        }
        return transaction.issue.findUniqueOrThrow({ where: { id: reservation.record.workId } });
      }
      idempotencyId = reservation.record.id;
    }

    const createInput: import('./issue-service.js').CreateIssueInput = {
      commitmentStatus: 'CANDIDATE',
      teamId: input.teamId,
      title: sanitizedTitle,
    };
    // Default per MCP contract is UNSTARTED (Ready): without an explicit
    // initialState we must not fall through to the team's position-0 state
    // (Backlog for INV), or candidates silently park outside the ready lane.
    const targetType = normalizeInitialStateType(input.initialState) ?? 'UNSTARTED';
    if (targetType) {
      const matchingState = await transaction.workflowState.findFirst({
        where: {
          teamId: input.teamId,
          type: targetType,
        },
        orderBy: { position: 'asc' },
        select: { id: true },
      });
      if (matchingState) {
        createInput.stateId = matchingState.id;
      }
      if (targetType === 'BACKLOG') {
        createInput.source = input.source
          ? `${input.source};initial_state=BACKLOG`
          : 'initial_state=BACKLOG';
      }
    }
    if (input.acceptance !== undefined) createInput.acceptance = input.acceptance;
    if (input.constraints !== undefined) createInput.constraints = input.constraints;
    if (input.description !== undefined) createInput.description = input.description;
    if (input.kind !== undefined && input.kind !== null) createInput.kind = input.kind;
    if (input.outcome !== undefined) createInput.outcome = input.outcome;
    if (input.repository !== undefined) createInput.repository = input.repository;
    if (input.scope !== undefined) createInput.scope = input.scope;
    if (input.source !== undefined && targetType !== 'BACKLOG') createInput.source = input.source;
    if (input.verification !== undefined) createInput.verification = input.verification;

    const relatedType = input.relatedWorkType ?? 'DISCOVERED_DURING';
    let related: Issue | null = null;
    if (input.relatedWorkId) {
      related = await findWorkByIdOrIdentifier(transaction, input.relatedWorkId);
      if (!related) throw createNotFoundError(WORK_RELATED_NOT_FOUND_MESSAGE);
    }

    let parentWork: Issue | null = null;
    if (input.parentId) {
      parentWork = await findWorkByIdOrIdentifier(transaction, input.parentId);
      if (!parentWork) throw createNotFoundError(PARENT_ISSUE_NOT_FOUND_MESSAGE);
    } else if (related && relatedType === 'CONTAINS') {
      parentWork = related;
    } else if (related && INHERITING_LINK_TYPES.has(relatedType)) {
      // Norm v1 (INV-718): work found while doing X, or derived from X,
      // belongs where X belongs unless the proposer says otherwise.
      parentWork = await findInheritableParent(transaction, related, {
        kind: createInput.kind ?? 'ISSUE',
        repository: createInput.repository ?? null,
      });
    }
    if (parentWork) {
      createInput.parentId = parentWork.id;
      // A child without a repository inherits its parent's (CONTAINS needs both).
      if (createInput.repository === undefined || createInput.repository === null) {
        createInput.repository = parentWork.repository;
      }
    }

    if (input.labels && input.labels.length > 0) {
      createInput.labelIds = await findOrCreateLabelIds(transaction, input.labels);
    }
    const { auditId: creationAuditId, issue: created } = await createIssueWithAudit(transaction, createInput, actor, { linkMentions: false });
    if (parentWork) {
      await createWorkLink(transaction, {
        actor,
        fromId: parentWork.id,
        toId: created.id,
        type: 'CONTAINS',
      });
    }
    // The typed relation is recorded even when a parent is also given; before
    // INV-719 a parent silently replaced it.
    if (related && relatedType !== 'CONTAINS') {
      await createWorkLink(transaction, {
        actor,
        fromId: created.id,
        toId: related.id,
        type: relatedType,
      });
    }
    // Declared dependencies (INV-720): "blocked by X" can now be said at
    // proposal time instead of needing a second work_link call.
    for (const [ids, direction] of [[input.blockedBy ?? [], 'blocked-by'], [input.blocks ?? [], 'blocks']] as const) {
      for (const ref of ids) {
        const other = await findWorkByIdOrIdentifier(transaction, ref);
        if (!other) throw createNotFoundError(WORK_RELATED_NOT_FOUND_MESSAGE);
        await createWorkLink(transaction, {
          actor,
          fromId: direction === 'blocked-by' ? other.id : created.id,
          toId: direction === 'blocked-by' ? created.id : other.id,
          type: 'BLOCKS',
        });
      }
    }
    await linkMentionedWork(transaction, { workId: created.id, teamId: created.teamId, texts: mentionTexts(created), actor });
    if (idempotencyId) {
      await completeWorkIdempotency(transaction, idempotencyId, created.id);
    }
    await enqueueWorkEvent(transaction, {
      payload: { title: created.title, actorId: actor.actorId ?? null },
      type: 'work.proposed',
      workId: created.id,
      workIdentifier: created.identifier,
    });
    if (input.receipt) {
      // Same transaction as the write: a proposal and its receipt land
      // together or not at all.
      await attachDecisionReceipt(transaction, {
        auditId: creationAuditId,
        receipt: input.receipt,
      });
    }
    return created;
  });
}

/**
 * Norm v1 (INV-718): committing is where placement is enforced. A candidate may
 * be proposed without a parent, but it becomes committed work only with exactly
 * one CONTAINS parent (PROJECTs excepted). `parentId` places it in the same
 * transaction; the link service applies the hierarchy rules and audits the move.
 */
async function placeForCommit(
  transaction: Prisma.TransactionClient,
  work: Issue,
  parentId: string | null,
  actor: WriteActor,
): Promise<void> {
  if (work.kind === 'PROJECT') return;
  const currentParentId = async () => {
    const current = await transaction.issue.findUniqueOrThrow({ where: { id: work.id }, select: { parentId: true } });
    if (current.parentId) return current.parentId;
    const link = await transaction.workLink.findFirst({ where: { toId: work.id, type: 'CONTAINS' }, select: { fromId: true } });
    return link?.fromId ?? null;
  };
  if (parentId) {
    const parent = await findWorkByIdOrIdentifier(transaction, parentId);
    if (!parent) throw createNotFoundError(PARENT_ISSUE_NOT_FOUND_MESSAGE);
    const existing = await currentParentId();
    if (existing && existing !== parent.id) {
      // Committing is not a move: an already-placed candidate keeps its parent
      // unless someone moves it on purpose (revision-checked parent update).
      throw createValidationError(WORK_COMMIT_PARENT_CONFLICT_MESSAGE);
    }
    if (!existing) {
      // Triaged reports can arrive without a repository (INV-749): placing
      // them takes the parent's, which CONTAINS requires on both ends.
      if (!work.repository?.trim() && parent.repository) {
        await transaction.issue.update({ where: { id: work.id }, data: { repository: parent.repository } });
      }
      await createWorkLink(transaction, { actor, fromId: parent.id, toId: work.id, type: 'CONTAINS' });
    }
  }
  const placedUnder = await currentParentId();
  if (!placedUnder) throw createValidationError(WORK_COMMIT_REQUIRES_PARENT_MESSAGE);
  const parent = await transaction.issue.findUnique({ where: { id: placedUnder }, select: { commitmentStatus: true } });
  if (!parent || parent.commitmentStatus === 'REJECTED') throw createValidationError(WORK_COMMIT_PARENT_REJECTED_MESSAGE);
}

export async function commitWork(
  prisma: PrismaClient,
  id: string,
  input: CommitWorkInput,
  actor: WriteActor = INTERNAL_WRITE_ACTOR,
): Promise<Issue> {
  assertActorCan(actor.actorKind, 'commit');

  return prisma.$transaction(async (transaction) => {
    const existing = await requireWork(transaction, id);

    let commitIdempotencyId: string | null = null;
    if (input.idempotencyKey) {
      const reservation = await reserveWorkIdempotency(transaction, {
        actor,
        key: input.idempotencyKey,
        operation: 'commit',
        requestHash: hashIdempotencyRequest({ ...input, idempotencyKey: null, id }),
        teamId: existing.teamId,
      });
      if (!reservation.created) {
        if (reservation.record.workId !== existing.id) {
          throw createValidationError(WORK_IDEMPOTENCY_CONFLICT_MESSAGE);
        }
        return transaction.issue.findUniqueOrThrow({ where: { id: existing.id } });
      }
      commitIdempotencyId = reservation.record.id;
    }

    if (existing.commitmentStatus !== 'CANDIDATE') {
      throw createValidationError(WORK_NOT_CANDIDATE_MESSAGE);
    }

    if (existing.revision !== input.expectedRevision) {
      throw createValidationError(WORK_REVISION_CONFLICT_MESSAGE);
    }

    await claimIssueRevision(transaction, existing.id, input.expectedRevision);

    const acceptance = nonEmpty(input.acceptance) ?? nonEmpty(existing.acceptance);
    if (!acceptance) {
      throw createValidationError(WORK_COMMIT_REQUIRES_ACCEPTANCE_MESSAGE);
    }

    const assigneeId = input.assigneeId === undefined ? existing.assigneeId : input.assigneeId;
    if (!assigneeId) {
      throw createValidationError(WORK_COMMIT_REQUIRES_OWNER_MESSAGE);
    }

    const owner = await transaction.user.findUnique({
      where: { id: assigneeId },
      select: {
        id: true,
        actorKind: true,
        memberships: {
          where: { teamId: existing.teamId },
          take: 1,
          select: { id: true },
        },
      },
    });

    if (!owner || owner.actorKind !== 'HUMAN') {
      throw createValidationError(WORK_OWNER_MUST_BE_HUMAN_MESSAGE);
    }
    if (owner.memberships.length === 0) {
      throw createValidationError(WORK_OWNER_MUST_BELONG_TO_TEAM_MESSAGE);
    }

    await placeForCommit(transaction, existing, input.parentId ?? null, actor);

    // Zero-bug (INV-748/750): a bug is committed to be fixed, with a priority
    // for its SLA, and never parked in the backlog.
    const isBug = await isBugWork(transaction, existing.id);
    const priority = input.priority ?? existing.priority;
    if (isBug && (!priority || priority < 1 || priority > 4)) {
      throw createValidationError(BUG_COMMIT_PRIORITY_REQUIRED_MESSAGE);
    }

    const readyState = await transaction.workflowState.findFirst({
      where: {
        teamId: existing.teamId,
        type: 'UNSTARTED',
      },
      orderBy: { position: 'asc' },
      select: { id: true },
    });
    if (!readyState) {
      throw createValidationError(WORK_READY_STATE_MISSING_MESSAGE);
    }

    let targetStateId = readyState.id;
    if (input.stateId) {
      const overrideState = await transaction.workflowState.findUnique({
        where: { id: input.stateId },
        select: { id: true, type: true, teamId: true },
      });
      if (!overrideState || overrideState.teamId !== existing.teamId) {
        throw createValidationError(WORKFLOW_STATE_NOT_FOUND_MESSAGE);
      }
      if (overrideState.type === 'COMPLETED' || overrideState.type === 'CANCELED') {
        throw createValidationError('Cannot commit candidate directly to COMPLETED or CANCELED state.');
      }
      if (isBug && overrideState.type === 'BACKLOG') {
        throw createValidationError(BUG_NO_BACKLOG_MESSAGE);
      }
      targetStateId = overrideState.id;
    } else if (existing.stateId) {
      const existingState = await transaction.workflowState.findUnique({
        where: { id: existing.stateId },
        select: { id: true, type: true, teamId: true },
      });
      const isExplicitBacklog =
        existingState?.type === 'BACKLOG' &&
        Boolean(existing.source?.includes('initial_state=BACKLOG'));
      if (
        existingState &&
        existingState.teamId === existing.teamId &&
        (existingState.type === 'STARTED' || existingState.type === 'REVIEW' || (isExplicitBacklog && !isBug))
      ) {
        targetStateId = existingState.id;
      }
    }

    const cleanSource = existing.source?.includes('initial_state=BACKLOG')
      ? existing.source.replace(/;?initial_state=BACKLOG;?/, '').trim() || null
      : existing.source;

    const updated = await transaction.issue.update({
      where: { id: existing.id },
      data: {
        acceptance,
        assigneeId: owner.id,
        commitmentStatus: 'COMMITTED',
        constraints: input.constraints === undefined ? existing.constraints : input.constraints,
        outcome: input.outcome === undefined ? existing.outcome : input.outcome,
        priority,
        scope: input.scope === undefined ? existing.scope : input.scope,
        source: cleanSource,
        stateId: targetStateId,
        verification: input.verification === undefined ? existing.verification : input.verification,
      },
    });

    await recordWorkAudit(transaction, {
      actor,
      after: selectIssueSnapshot(updated),
      before: selectIssueSnapshot(existing),
      workId: existing.id,
    });

    await enqueueWorkEvent(transaction, {
      payload: {
        acceptance: updated.acceptance,
        assigneeId: updated.assigneeId,
        actorId: actor.actorId ?? null,
      },
      type: 'work.committed',
      updatedFrom: { commitmentStatus: existing.commitmentStatus, revision: existing.revision },
      workId: updated.id,
      workIdentifier: updated.identifier,
    });

    if (commitIdempotencyId) {
      await completeWorkIdempotency(transaction, commitIdempotencyId, updated.id);
    }

    return updated;
  });
}

export async function rejectWork(
  prisma: PrismaClient,
  id: string,
  input: RejectWorkInput,
  actor: WriteActor = INTERNAL_WRITE_ACTOR,
): Promise<Issue> {
  assertActorCan(actor.actorKind, 'reject');

  return prisma.$transaction(async (transaction) => {
    const existing = await requireWork(transaction, id);

    let rejectIdempotencyId: string | null = null;
    if (input.idempotencyKey) {
      const reservation = await reserveWorkIdempotency(transaction, {
        actor,
        key: input.idempotencyKey,
        operation: 'reject',
        requestHash: hashIdempotencyRequest({ ...input, idempotencyKey: null, id }),
        teamId: existing.teamId,
      });
      if (!reservation.created) {
        if (reservation.record.workId !== existing.id) {
          throw createValidationError(WORK_IDEMPOTENCY_CONFLICT_MESSAGE);
        }
        return transaction.issue.findUniqueOrThrow({ where: { id: existing.id } });
      }
      rejectIdempotencyId = reservation.record.id;
    }

    if (existing.commitmentStatus !== 'CANDIDATE') {
      throw createValidationError(WORK_NOT_CANDIDATE_MESSAGE);
    }

    if (existing.revision !== input.expectedRevision) {
      throw createValidationError(WORK_REVISION_CONFLICT_MESSAGE);
    }

    await claimIssueRevision(transaction, existing.id, input.expectedRevision);

    const reason = nonEmpty(input.reason);
    if (!reason && (await isBugWork(transaction, existing.id))) {
      throw createValidationError(BUG_REJECT_REASON_REQUIRED_MESSAGE);
    }
    const actorForAudit: WriteActor = { ...actor };
    if (reason) {
      actorForAudit.reason = reason;
    }

    const updated = await transaction.issue.update({
      where: { id: existing.id },
      data: {
        commitmentStatus: 'REJECTED',
      },
    });

    await recordWorkAudit(transaction, {
      actor: actorForAudit,
      after: selectIssueSnapshot(updated),
      before: selectIssueSnapshot(existing),
      workId: existing.id,
    });

    await enqueueWorkEvent(transaction, {
      payload: {
        actorId: actor.actorId ?? null,
        reason,
      },
      type: 'work.rejected',
      updatedFrom: { commitmentStatus: existing.commitmentStatus, revision: existing.revision },
      workId: updated.id,
      workIdentifier: updated.identifier,
    });

    if (rejectIdempotencyId) {
      await completeWorkIdempotency(transaction, rejectIdempotencyId, updated.id);
    }

    return updated;
  });
}

export async function claimWork(
  prisma: PrismaClient,
  id: string,
  input: ClaimWorkInput = {},
  actor: WriteActor = INTERNAL_WRITE_ACTOR,
): Promise<{ claim: WorkClaim; work: Issue }> {
  assertActorCan(actor.actorKind, 'claim');

  if (!actor.actorId) {
    throw createValidationError(WORK_CLAIM_REQUIRES_ACTOR_MESSAGE);
  }

  const result = await prisma.$transaction(async (transaction) => {
    const initial = await requireWork(transaction, id);
    // Same Issue → Claim lock order as run snapshots and verification.
    await transaction.$queryRaw`SELECT id FROM "Issue" WHERE id = ${initial.id}::uuid FOR UPDATE`;
    const work = await requireWork(transaction, initial.id);

    if (work.commitmentStatus !== 'COMMITTED') {
      throw createValidationError(WORK_NOT_COMMITTED_MESSAGE);
    }

    const currentClaim = await transaction.workClaim.findUnique({ where: { workId: work.id } });
    if (currentClaim && currentClaim.leaseUntil > new Date() && currentClaim.actorId !== actor.actorId) {
      throw createValidationError(WORK_ALREADY_CLAIMED_MESSAGE);
    }
    const renewingOwnClaim = Boolean(
      currentClaim && currentClaim.actorId === actor.actorId && currentClaim.leaseUntil > new Date(),
    );
    if (!renewingOwnClaim && !(await isWorkReadyForClaim(transaction, work.id))) {
      throw createValidationError(WORK_NOT_READY_MESSAGE);
    }

    let idempotencyId: string | null = null;
    if (input.idempotencyKey) {
      const reservation = await reserveWorkIdempotency(transaction, {
        actor,
        key: input.idempotencyKey,
        operation: 'claim',
        requestHash: hashIdempotencyRequest({
          leaseSeconds: input.leaseSeconds ?? null,
          workId: work.id,
        }),
        teamId: work.teamId,
      });
      if (!reservation.created) {
        if (reservation.record.workId !== work.id) {
          throw createValidationError(WORK_IDEMPOTENCY_CONFLICT_MESSAGE);
        }
        const existing = await transaction.workClaim.findUnique({
          where: { workId: work.id },
          include: { work: true },
        });
        if (!existing || existing.actorId !== actor.actorId) {
          throw createValidationError(WORK_IDEMPOTENCY_RESULT_UNAVAILABLE_MESSAGE);
        }
        return { claim: existing, work: existing.work };
      }
      idempotencyId = reservation.record.id;
    }

    const leaseUntil = new Date(
      Date.now() + (input.leaseSeconds && input.leaseSeconds > 0
        ? input.leaseSeconds
        : DEFAULT_CLAIM_LEASE_SECONDS) * 1000,
    );
    const claim = await upsertWorkClaim(transaction, {
      actorId: actor.actorId as string,
      conflict: 'throw',
      leaseUntil,
      workId: work.id,
    });

    if (idempotencyId) await completeWorkIdempotency(transaction, idempotencyId, work.id);

    let updatedWork = work;
    const currentState = await transaction.workflowState.findUnique({
      where: { id: work.stateId },
      select: { type: true },
    });
    if (currentState && (currentState.type === 'UNSTARTED' || currentState.type === 'BACKLOG')) {
      const startedState = await transaction.workflowState.findFirst({
        where: { teamId: work.teamId, type: 'STARTED' },
        orderBy: { position: 'asc' },
        select: { id: true },
      });
      if (startedState) {
        updatedWork = await transaction.issue.update({
          where: { id: work.id },
          data: { stateId: startedState.id },
        });
      }
    }

    await enqueueWorkEvent(transaction, {
      payload: {
        actorId: actor.actorId,
        leaseUntil: claim.leaseUntil.toISOString(),
      },
      type: 'work.claimed',
      workId: updatedWork.id,
      workIdentifier: updatedWork.identifier,
    });

    return { claim, work: updatedWork };
  });

  return result;
}

async function upsertWorkClaim(
  prisma: DatabaseClient,
  input: {
    actorId: string;
    conflict: 'throw' | 'skip';
    leaseUntil: Date;
    workId: string;
  },
): Promise<WorkClaim> {
  await prisma.workClaim.deleteMany({
    where: {
      workId: input.workId,
      leaseUntil: { lte: new Date() },
    },
  });

  const existing = await prisma.workClaim.findUnique({
    where: { workId: input.workId },
  });

  if (existing) {
    if (existing.actorId === input.actorId) {
      return prisma.workClaim.update({
        where: { workId: input.workId },
        data: { leaseUntil: input.leaseUntil },
      });
    }

    if (input.conflict === 'skip') {
      return existing;
    }

    throw createValidationError(WORK_ALREADY_CLAIMED_MESSAGE);
  }

  try {
    return await prisma.workClaim.create({
      data: {
        actorId: input.actorId,
        leaseUntil: input.leaseUntil,
        workId: input.workId,
      },
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      const raced = await prisma.workClaim.findUnique({
        where: { workId: input.workId },
      });

      if (raced?.actorId === input.actorId) {
        return prisma.workClaim.update({
          where: { workId: input.workId },
          data: { leaseUntil: input.leaseUntil },
        });
      }

      if (input.conflict === 'skip' && raced) {
        return raced;
      }

      throw createValidationError(WORK_ALREADY_CLAIMED_MESSAGE);
    }

    throw error;
  }
}

async function requireWork(prisma: DatabaseClient, id: string): Promise<Issue> {
  const work = await findWorkByIdOrIdentifier(prisma, id);

  if (!work) {
    throw createNotFoundError(ISSUE_NOT_FOUND_MESSAGE);
  }

  return work;
}

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function isAcceptStateType(type: string): boolean {
  return type === 'COMPLETED' || type === 'CANCELED';
}
