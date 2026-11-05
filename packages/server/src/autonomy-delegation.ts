/**
 * L3 Hands-off (INV-1493, docs/autonomy-policy.md §3.1 L3 and §5; decision
 * INV-1497 superseding INV-571).
 *
 * Three things a policy at L3 adds, all as ledger rows Involute keeps while
 * the runtime does the work (INV-478):
 *
 * 1. Intake dispatch — a candidate the team's intake rule matches is committed
 *    by the Autonomy Gate (INV-1491) and then handed to an agent trusted at L3
 *    on that team as an AgentRequest in its agent_inbox.
 * 2. Explicit, budgeted, bounded agent→agent delegation — only through
 *    `agent_request(action: 'delegate')`; never by @mention. Every request in
 *    a chain carries the root request id, a hop count under MAX_HANDOFF_HOPS
 *    and a budget deducted from its parent; a cycle, an exhausted budget or a
 *    policy below L3 is refused with the reason.
 * 3. The completion reply — when an L3 item reaches Done, one comment from a
 *    workspace template tells the filer what happened; one notification.
 */
import type { ActorKind, AgentRequest, Comment, GlobalRole, Issue, Prisma, PrismaClient } from '@prisma/client';

import { CHAIN_TOTAL_MS, MAX_HANDOFF_HOPS } from './agent-request-handoff.js';
import { createAgentRequest, DEFAULT_REQUEST_DEADLINE_MS } from './agent-request-service.js';
import { AUTONOMY_GATE_ACTOR, isAutoDecisionReason } from './autonomy-gate.js';
import { POLICY_AUDIT, decide, evaluatePredicate, type AutonomyFacts, type Predicate } from './autonomy-policy.js';
import { factsForWork, loadAutonomyFor, readActivePolicy, type AutonomyView } from './autonomy-service.js';
import { createValidationError, createNotFoundError } from './errors.js';
import { describeHandoff, handoffJson, type HandoffCard } from './agent-request-handoff-card.js';
import { requestNeedInfo, resolveActorRef } from './need-info-service.js';
import { ensureServiceActor } from './service-actors.js';
import { WORKSPACE_SETTINGS_ID } from './workspace-access.js';

type DatabaseClient = PrismaClient | Prisma.TransactionClient;

export const DELEGATE_AGENTS_ONLY_MESSAGE = 'Only an agent delegates to an agent; a person asks with a comment or a needinfo.';
export const DELEGATE_TARGET_MESSAGE = 'Delegate to another AGENT actor that can act on this team; not to yourself, a person or a service.';
export const DELEGATE_BUDGET_MESSAGE = 'A delegation carries a positive budget (budget_units, 1–100000) deducted from the chain it belongs to.';
export const DELEGATE_ROOT_MESSAGE = 'A delegation needs a root: a request addressed to you on this work, or a commit the autonomy policy made (INV-571 / INV-1497).';
export const DELEGATE_CYCLE_MESSAGE = 'Refused: that agent is already in this delegation chain (a cycle never converges).';
export const DELEGATE_HOPS_MESSAGE = `Refused: this chain already has ${MAX_HANDOFF_HOPS} hops; a person takes it from here.`;
export const DELEGATE_BUDGET_EXHAUSTED_MESSAGE = 'Refused: the chain’s budget is exhausted; the work owner has been asked to add budget or stop (needinfo).';
/** Budget a policy-dispatched chain starts with, in units the paying principal defines. */
export const DEFAULT_DISPATCH_BUDGET = 100;

export interface DelegateInput {
  by: { actorId: string; actorKind: ActorKind; globalRole?: GlobalRole | null };
  workId: string;
  target: string;
  body: string;
  budgetUnits: number;
  idempotencyKey?: string | null;
  /** The hand-off card (INV-1583), already parsed. */
  handoff?: HandoffCard | null;
}

export interface DelegateResult { request: AgentRequest; comment: Comment; rootRequestId: string; hopCount: number; budgetUnits: number }

/** Thrown inside the delegation transaction so the needinfo to the owner is written outside it (a rolled-back ask would be no ask). */
class BudgetExhausted extends Error {
  constructor(readonly work: Issue, readonly parent: AgentRequest | null) { super(DELEGATE_BUDGET_EXHAUSTED_MESSAGE); }
}

/** All requests of one chain: the root and everything that names it. */
async function chainOf(db: DatabaseClient, rootRequestId: string) {
  return db.agentRequest.findMany({ where: { OR: [{ id: rootRequestId }, { rootRequestId }] }, select: { id: true, targetActorId: true, requestedByActorId: true, hopCount: true, budgetUnits: true, chainDeadlineAt: true, createdAt: true } });
}

/**
 * Explicit agent→agent delegation (INV-1497). The caller must hold a request
 * on this work (its parent) or the work must have been committed by the
 * policy (then this request is the root). Budget comes out of the parent.
 */
export async function delegateToAgent(prisma: PrismaClient, input: DelegateInput, now = new Date()): Promise<DelegateResult> {
  if (input.by.actorKind !== 'AGENT') throw createValidationError(DELEGATE_AGENTS_ONLY_MESSAGE);
  const budget = Math.floor(input.budgetUnits);
  if (!Number.isFinite(budget) || budget < 1 || budget > 100_000) throw createValidationError(DELEGATE_BUDGET_MESSAGE);
  const body = input.body.trim();
  if (!body) throw createValidationError('Say what you are delegating.');

  try {
    return await delegateInTransaction(prisma, input, budget, body, now);
  } catch (error) {
    if (error instanceof BudgetExhausted) {
      await askOwnerForBudget(prisma, error.work, input.by, error.parent, now);
      throw createValidationError(DELEGATE_BUDGET_EXHAUSTED_MESSAGE);
    }
    throw error;
  }
}

async function delegateInTransaction(prisma: PrismaClient, input: DelegateInput, budget: number, body: string, now: Date): Promise<DelegateResult> {
  return prisma.$transaction(async (tx) => {
    if (input.idempotencyKey) {
      const existing = await tx.agentRequest.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
      if (existing) return { request: existing, comment: await tx.comment.findUniqueOrThrow({ where: { id: existing.rootCommentId } }), rootRequestId: existing.rootRequestId ?? existing.id, hopCount: existing.hopCount, budgetUnits: existing.budgetUnits ?? 0 };
    }
    const work = await tx.issue.findUnique({ where: { id: input.workId } });
    if (!work) throw createNotFoundError('Work not found.');
    if (work.commitmentStatus !== 'COMMITTED') throw createValidationError('Delegate on committed work only.');
    const target = await resolveActorRef(tx, input.target);
    if (!target || target.actorKind !== 'AGENT' || target.id === input.by.actorId) throw createValidationError(DELEGATE_TARGET_MESSAGE);
    const credential = await tx.agentCredential.findFirst({ where: { userId: target.id, teamId: work.teamId, revokedAt: null }, select: { id: true } });
    if (!credential) throw createValidationError(DELEGATE_TARGET_MESSAGE);

    // The parent: a live request addressed to the caller on this work.
    const parent = await tx.agentRequest.findFirst({ where: { workId: work.id, targetActorId: input.by.actorId, state: { in: ['SUBMITTED', 'WORKING', 'INPUT_REQUIRED'] } }, orderBy: { createdAt: 'desc' } });
    let rootRequestId: string | null = null;
    let hopCount = 0;
    let remaining = budget;
    let chainDeadlineAt = new Date(now.getTime() + CHAIN_TOTAL_MS);
    if (parent) {
      rootRequestId = parent.rootRequestId ?? parent.id;
      hopCount = parent.hopCount + 1;
      chainDeadlineAt = parent.chainDeadlineAt ?? chainDeadlineAt;
      if (parent.budgetUnits !== null) remaining = parent.budgetUnits;
    } else {
      // No parent: the root must be the policy's own commit, else a person heads the chain (INV-571).
      const policyCommit = await tx.workAudit.findFirst({ where: { workId: work.id, reason: { startsWith: `${POLICY_AUDIT.autoDecision}: candidate_commit` } }, select: { id: true } });
      if (!policyCommit) throw createValidationError(DELEGATE_ROOT_MESSAGE);
    }
    if (hopCount >= MAX_HANDOFF_HOPS) throw createValidationError(DELEGATE_HOPS_MESSAGE);
    if (rootRequestId) {
      const chain = await chainOf(tx, rootRequestId);
      if (chain.some((entry) => entry.targetActorId === target.id || entry.requestedByActorId === target.id)) throw createValidationError(DELEGATE_CYCLE_MESSAGE);
    }

    // The policy gate, with the chain's facts.
    const view = await loadAutonomyFor(tx, work, { id: input.by.actorId, actorKind: 'AGENT' }, now);
    const facts: AutonomyFacts = { ...(await factsForWork(tx, work)), hops: hopCount, budget_remaining: remaining };
    const decision = decide(view, 'agent_delegation', facts);
    if (decision.decider !== 'auto') {
      if (remaining <= 0 && view.gates.agent_delegation.decider === 'auto') throw new BudgetExhausted(work, parent);
      throw createValidationError(`Refused: ${decision.reason} Delegation needs L3 for you on this item (now L${view.level}, ${view.source}).`);
    }
    const spend = Math.min(budget, remaining);
    if (spend <= 0) throw new BudgetExhausted(work, parent);
    if (parent && parent.budgetUnits !== null) await tx.agentRequest.update({ where: { id: parent.id }, data: { budgetUnits: parent.budgetUnits - spend } });

    const card = input.handoff ? `\n\n${describeHandoff(input.handoff)}` : '';
    const comment = await tx.comment.create({ data: { body: `**Delegated to ${target.handle ? `@${target.handle}` : target.name}** (hop ${hopCount + 1}/${MAX_HANDOFF_HOPS}, budget ${spend}): ${body}${card}`, issueId: work.id, userId: input.by.actorId } });
    const request = await createAgentRequest(tx, {
      body,
      deadlineAt: new Date(Math.min(now.getTime() + DEFAULT_REQUEST_DEADLINE_MS, chainDeadlineAt.getTime())),
      idempotencyKey: input.idempotencyKey ?? null,
      payingPrincipal: parent?.payingPrincipal ?? work.assigneeId ?? null,
      requestedByActorId: input.by.actorId,
      rootCommentId: comment.id,
      targetActorId: target.id,
      workId: work.id,
    }, now);
    const linked = await tx.agentRequest.update({ where: { id: request.id }, data: { rootRequestId: rootRequestId ?? request.id, hopCount, chainDeadlineAt, budgetUnits: spend, ...(input.handoff ? { handoff: handoffJson(input.handoff) } : {}) } });
    return { request: linked, comment, rootRequestId: rootRequestId ?? request.id, hopCount, budgetUnits: spend };
  });
}

/** Budget exhausted (§3.1 spend_budget): the owner is asked, in Needs you, to add budget or stop. Idempotent per chain. */
async function askOwnerForBudget(prisma: PrismaClient, work: Issue, by: DelegateInput['by'], parent: AgentRequest | null, now: Date): Promise<void> {
  if (!work.assigneeId) return;
  await requestNeedInfo(prisma, {
    by: { actorId: by.actorId, actorKind: by.actorKind, globalRole: by.globalRole ?? 'USER' },
    idempotencyKey: `budget:${parent?.rootRequestId ?? parent?.id ?? work.id}`,
    question: `Budget exhausted on this delegation chain${parent ? ` (root ${parent.rootRequestId ?? parent.id})` : ''}: add budget by delegating again with budget_units, or stop the chain.`,
    target: work.assigneeId,
    workId: work.id,
  }, now).catch(() => undefined);
}

/**
 * Intake dispatch (§3.1 L3): after the Autonomy Gate committed a candidate at
 * L3 whose team intake rule matches, hand it to an agent trusted at L3 on the
 * team. Returns what happened, for the commit's audit reason.
 */
export async function dispatchByIntake(prisma: PrismaClient, work: Issue, view: AutonomyView, facts: AutonomyFacts, now = new Date()): Promise<string> {
  if (view.level !== 3) return '';
  const team = await readActivePolicy(prisma, { scope: 'TEAM', scopeId: work.teamId });
  const intake = team?.intake as Predicate | null | undefined;
  if (!intake || !evaluatePredicate(intake, facts)) return '';
  const candidates = await prisma.agentTrust.findMany({
    where: { level: 'L3', actor: { deactivatedAt: null, agentCredentials: { some: { teamId: work.teamId, revokedAt: null } } } },
    include: { actor: { select: { id: true, handle: true, name: true } } },
    orderBy: { actorId: 'asc' },
  });
  const target = candidates[0]?.actor;
  if (!target) return '; intake matched but no agent is trusted at L3 on this team — stays in Ready for a person';
  const gate = await ensureServiceActor(prisma, AUTONOMY_GATE_ACTOR);
  const comment = await prisma.comment.create({ data: { body: `**Dispatched to ${target.handle ? `@${target.handle}` : target.name}** under the team's L3 intake rule (budget ${DEFAULT_DISPATCH_BUDGET}). Claim it, deliver it, and reply on this item when it is Done.`, issueId: work.id, userId: gate.actorId } });
  const request = await createAgentRequest(prisma, {
    body: `Deliver ${work.identifier}: ${work.title}`,
    deadlineAt: new Date(now.getTime() + DEFAULT_REQUEST_DEADLINE_MS),
    idempotencyKey: `intake:${work.id}`,
    payingPrincipal: work.assigneeId ?? null,
    requestedByActorId: gate.actorId,
    rootCommentId: comment.id,
    targetActorId: target.id,
    workId: work.id,
  }, now);
  await prisma.agentRequest.update({ where: { id: request.id }, data: { rootRequestId: request.id, hopCount: 0, chainDeadlineAt: new Date(now.getTime() + CHAIN_TOTAL_MS), budgetUnits: DEFAULT_DISPATCH_BUDGET } });
  return `; dispatched to ${target.handle ? `@${target.handle}` : target.name} (request ${request.id})`;
}

export const DEFAULT_COMPLETION_REPLY = [
  '**Done under the team’s hands-off policy (L3).**',
  '',
  '- What changed: {summary}',
  '- Evidence: {evidence}',
  '- Verified by: {verification}',
  '- Follow-ups: {followups}',
  '',
  'Returned to a person? Use Return to Review on this item; it counts as an override of the policy.',
].join('\n');

/**
 * Completion reply (§4): when an item whose effective level is L3 reaches
 * Done, the Autonomy Gate posts one comment from the workspace template and
 * the filer gets one notification. Never posted twice for the same item.
 */
export async function postCompletionReply(prisma: DatabaseClient, work: Issue, run: { id: string; actorId: string | null; summary: string | null; externalUrl: string | null; pullRequestNumber: number | null } | null): Promise<Comment | null> {
  const view = await loadAutonomyFor(prisma, work, run?.actorId ? { id: run.actorId, actorKind: 'AGENT' } : null);
  if (view.level !== 3) return null;
  const gate = await ensureServiceActor(prisma, AUTONOMY_GATE_ACTOR);
  const marker = `<!-- policy.completion_reply:${work.id} -->`;
  const already = await prisma.comment.findFirst({ where: { issueId: work.id, userId: gate.actorId, body: { contains: marker } }, select: { id: true } });
  if (already) return null;
  const workspace = await readActivePolicy(prisma, { scope: 'WORKSPACE', scopeId: WORKSPACE_SETTINGS_ID });
  const template = workspace?.completionReply?.trim() || DEFAULT_COMPLETION_REPLY;
  const evidence = await prisma.workEvidence.findMany({ where: { workId: work.id, retractedAt: null }, select: { url: true }, take: 5 });
  const decision = await prisma.workReviewDecision.findFirst({ where: { workId: work.id, decision: 'ACCEPTED' }, orderBy: { createdAt: 'desc' }, select: { reason: true } });
  const followups = (await prisma.workLink.findMany({ where: { toId: work.id, type: 'DISCOVERED_DURING' }, select: { from: { select: { identifier: true } } }, take: 10 })).map((link) => link.from.identifier);
  const body = template
    .replace('{identifier}', work.identifier)
    .replace('{title}', work.title)
    .replace('{summary}', run?.summary?.trim() || '(no run summary)')
    .replace('{evidence}', evidence.length ? evidence.map((item) => item.url).join(', ') : run?.externalUrl ?? '(none)')
    .replace('{verification}', decision?.reason && isAutoDecisionReason(decision.reason) ? 'the policy, on GitHub’s confirmation' : 'a person')
    .replace('{followups}', followups.length ? followups.join(', ') : 'none');
  const comment = await prisma.comment.create({ data: { body: `${body}\n\n${marker}`, issueId: work.id, userId: gate.actorId } });
  // One notification, to whoever filed it (not the gate), unless they already hear as owner.
  const filer = await prisma.workAudit.findFirst({ where: { workId: work.id }, orderBy: [{ revision: 'asc' }, { createdAt: 'asc' }], select: { actorId: true, actor: { select: { actorKind: true } } } });
  if (filer?.actorId && filer.actor?.actorKind === 'HUMAN' && filer.actorId !== work.assigneeId) {
    await prisma.notification.create({ data: { type: 'policy.completed', userId: filer.actorId, teamId: work.teamId, workId: work.id, payload: { identifier: work.identifier, title: work.title, commentId: comment.id } } });
  }
  return comment;
}
