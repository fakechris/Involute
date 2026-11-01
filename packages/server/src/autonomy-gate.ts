/**
 * Autonomy Gate (INV-1491, docs/autonomy-policy.md §3.1 L1): the service
 * actor that commits a qualifying candidate or accepts a verification-only
 * amendment when the item's resolved policy says `auto` and the condition
 * holds. It never decides anything else; a miss is a person's decision, and
 * the Needs you row says why ("Escalated: …").
 *
 * Every automatic decision is a WorkAudit row whose reason starts with
 * `policy.auto_decision` (policy scope / version and the matched facts), so
 * the timeline reads "Auto-committed by policy …", Handled for you lists it,
 * and a person's undo is counted as `policy.override` against the policy and
 * the agent (INV-1490 metrics).
 */
import type { Issue, Prisma, PrismaClient } from '@prisma/client';

import { amendmentChanges } from './contract-amendment.js';
import { POLICY_AUDIT, decide, describeFacts, type AutonomyFacts, type Gate } from './autonomy-policy.js';
import { factsForWork, loadAutonomyFor, type AutonomyView } from './autonomy-service.js';
import { ensureServiceActor, type ServiceActorSpec } from './service-actors.js';
import type { WriteActor } from './work-service.js';

type DatabaseClient = PrismaClient | Prisma.TransactionClient;

export const AUTONOMY_GATE_ACTOR: ServiceActorSpec = {
  description: 'Commits candidates and accepts amendments a team’s autonomy policy allows (docs/autonomy-policy.md, INV-1491).',
  email: 'autonomy-gate@services.involute.local',
  handle: 'autonomy-gate',
  name: 'Autonomy Gate',
  surface: 'autonomy-gate',
};

/** The reason prefix of an automatic decision, e.g. `policy.auto_decision: candidate_commit by team policy v3 — matched: type bug, priority 2`. */
export function autoDecisionReason(view: AutonomyView, gate: Gate, facts: AutonomyFacts): string {
  const version = view.requestedBy === 'project' ? view.versions.project : view.requestedBy === 'team' ? view.versions.team : view.versions.workspace;
  const matched = describeFacts(view.gates[gate].condition, facts);
  return `${POLICY_AUDIT.autoDecision}: ${gate} by ${view.requestedBy} policy v${version ?? 0} (L${view.level})${matched ? ` — matched: ${matched}` : ''}`;
}

export function isAutoDecisionReason(reason: string | null | undefined): boolean {
  return Boolean(reason?.startsWith(POLICY_AUDIT.autoDecision));
}

async function gateActor(prisma: DatabaseClient): Promise<WriteActor> {
  const actor = await ensureServiceActor(prisma, AUTONOMY_GATE_ACTOR);
  return { actorId: actor.actorId, actorKind: 'SERVICE', surface: AUTONOMY_GATE_ACTOR.surface };
}

export interface GateOutcome { decided: boolean; reason: string }

/**
 * After an agent proposes a candidate: commit it when the policy for the
 * proposing agent says so. Owner = the agent's accountable human. Any refusal
 * from the ordinary commit rules (parent, acceptance, owner on the team, bug
 * priority) leaves the candidate for a person, with the reason.
 */
export async function tryAutoCommit(prisma: PrismaClient, work: Issue, proposer: { id: string; actorKind: string }): Promise<GateOutcome> {
  if (work.commitmentStatus !== 'CANDIDATE' || proposer.actorKind !== 'AGENT') return { decided: false, reason: 'not a candidate proposed by an agent' };
  const view = await loadAutonomyFor(prisma, work, proposer);
  const facts = await factsForWork(prisma, work);
  const decision = decide(view, 'candidate_commit', facts);
  if (decision.decider !== 'auto') return { decided: false, reason: decision.reason };
  const agent = await prisma.user.findUnique({ where: { id: proposer.id }, select: { ownerId: true } });
  if (!agent?.ownerId) return { decided: false, reason: 'Escalated: the proposing agent has no accountable owner to commit under.' };
  const { commitWork } = await import('./claim-service.js');
  const actor = { ...(await gateActor(prisma)), reason: autoDecisionReason(view, 'candidate_commit', facts) };
  try {
    await commitWork(prisma, work.id, { assigneeId: agent.ownerId, expectedRevision: work.revision }, actor);
    return { decided: true, reason: actor.reason! };
  } catch (error) {
    return { decided: false, reason: `Escalated: automatic commit refused — ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** After an agent proposes an amendment: accept it when the policy says so (L1: verification only). */
export async function tryAutoAcceptAmendment(prisma: PrismaClient, amendmentId: string): Promise<GateOutcome> {
  const amendment = await prisma.contractAmendment.findUnique({ where: { id: amendmentId }, include: { work: true, proposedBy: { select: { id: true, actorKind: true } } } });
  if (!amendment || amendment.status !== 'PENDING') return { decided: false, reason: 'no pending amendment' };
  const view = await loadAutonomyFor(prisma, amendment.work, amendment.proposedBy);
  const facts = await factsForWork(prisma, amendment.work);
  facts.amendment_fields = amendmentChanges(amendment).map((change) => change.field);
  const decision = decide(view, 'contract_amendment', facts);
  if (decision.decider !== 'auto') return { decided: false, reason: decision.reason };
  const { acceptContractAmendment } = await import('./contract-amendment.js');
  const actor = { ...(await gateActor(prisma)), reason: autoDecisionReason(view, 'contract_amendment', facts) };
  try {
    await acceptContractAmendment(prisma, { amendmentId, note: actor.reason }, actor);
    return { decided: true, reason: actor.reason! };
  } catch (error) {
    return { decided: false, reason: `Escalated: automatic acceptance refused — ${error instanceof Error ? error.message : String(error)}` };
  }
}

export interface HandledItem {
  id: string;
  gate: Gate;
  workId: string;
  reason: string;
  at: Date;
  policyVersion: number | null;
  amendmentId: string | null;
  /** A person already reversed it (a later `policy.override` audit on the item). */
  undone: boolean;
  /** The item is still where the gate put it: a candidate commit can be returned while no claim or run exists. */
  reversible: boolean;
}

/**
 * Handled for you (docs/autonomy-policy.md §4): the automatic decisions of
 * the last `days` on work the viewer may read, newest first.
 */
export async function loadHandledForYou(prisma: DatabaseClient, readable: Prisma.IssueWhereInput, days = 7, now = new Date()): Promise<HandledItem[]> {
  const since = new Date(now.getTime() - days * 86_400_000);
  const rows = await prisma.workAudit.findMany({
    where: { reason: { startsWith: POLICY_AUDIT.autoDecision }, createdAt: { gte: since }, work: readable },
    orderBy: { createdAt: 'desc' },
    take: 200,
    select: { id: true, workId: true, reason: true, createdAt: true, sourceMessageId: true, work: { select: { commitmentStatus: true, claim: { select: { id: true } }, runs: { select: { id: true }, take: 1 } } } },
  });
  if (!rows.length) return [];
  const overrides = await prisma.workAudit.findMany({
    where: { workId: { in: rows.map((row) => row.workId) }, reason: { startsWith: POLICY_AUDIT.override }, createdAt: { gte: since } },
    select: { workId: true, createdAt: true },
  });
  return rows.map((row) => {
    const gate: Gate = row.reason!.includes('contract_amendment') ? 'contract_amendment' : row.reason!.includes('review_accept') ? 'review_accept' : 'candidate_commit';
    const version = /policy v(\d+)/.exec(row.reason!)?.[1];
    const undone = overrides.some((override) => override.workId === row.workId && override.createdAt > row.createdAt);
    const reversible = !undone && (gate === 'contract_amendment' || gate === 'review_accept' || (row.work.commitmentStatus === 'COMMITTED' && !row.work.claim && row.work.runs.length === 0));
    return {
      id: row.id,
      gate,
      workId: row.workId,
      reason: row.reason!,
      at: row.createdAt,
      policyVersion: version ? Number(version) : null,
      amendmentId: gate === 'contract_amendment' ? row.sourceMessageId : null,
      undone,
      reversible,
    };
  });
}
