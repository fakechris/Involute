/**
 * Agent trust level (INV-1490, docs/autonomy-policy.md §2.4 and §7).
 *
 * A clamp on the autonomy resolver, not a policy scope: however open a
 * project is, an agent only goes as far as its trust level. New agents start
 * at OBSERVE. A person promotes or demotes with a reason; the page shows the
 * last 30 days' numbers next to the button so the decision is made on data,
 * and the server suggests, never raises, a level.
 */
import { Prisma, type AgentTrustLevel, type PrismaClient } from '@prisma/client';

import { POLICY_AUDIT } from './autonomy-policy.js';
import { recordActorAudit } from './actor-lifecycle.js';
import { createValidationError } from './errors.js';
import { BUG_LABEL_NAME } from './bug-report.js';

type DatabaseClient = PrismaClient | Prisma.TransactionClient;

export const AGENT_TRUST_LEVELS: readonly AgentTrustLevel[] = ['OBSERVE', 'L1', 'L2', 'L3'];
export const AGENT_TRUST_REASON_REQUIRED_MESSAGE = 'Changing an agent’s trust level needs a reason (1–2000 characters); the audit row shows it to the next person.';
export const AGENT_TRUST_LEVEL_INVALID_MESSAGE = 'Trust level must be OBSERVE, L1, L2 or L3 (docs/autonomy-policy.md §2.4).';
export const AGENT_TRUST_AGENT_ONLY_MESSAGE = 'Only an AGENT actor has a trust level.';

export const TRUST_LEVEL_DESCRIPTIONS: Record<AgentTrustLevel, { en: string; zh: string }> = {
  OBSERVE: { en: 'Claims and runs work; no gate opens for its proposals or deliveries whatever the project allows.', zh: '可以认领和执行，但不论项目多开放，它的提案和交付都不会自动通过任何门。' },
  L1: { en: 'Its qualifying bug / improvement candidates may be committed and verification-only amendments accepted, where the project allows L1.', zh: '在允许 L1 的项目里，它提出的合格 bug / improvement 候选可自动承诺，只改 verification 的修约可自动接受。' },
  L2: { en: 'L1, plus its CLEAR deliveries may move to Done where the project allows L2.', zh: '在 L1 之上，在允许 L2 的项目里它评级 CLEAR 的交付可自动 Done。' },
  L3: { en: 'L2, plus it may be dispatched by intake and delegate to other agents where the project allows L3.', zh: '在 L2 之上，在允许 L3 的项目里可被收单派发、可向其他 agent 委派。' },
};

/** What a trust level lets the agent do, as a read-only expansion (never configured one by one). */
export function allowedAt(level: AgentTrustLevel): { claimWork: boolean; fileBugs: boolean; autoCommit: boolean; autoAccept: boolean; delegate: boolean } {
  const rank = AGENT_TRUST_LEVELS.indexOf(level);
  return { claimWork: true, fileBugs: true, autoCommit: rank >= 1, autoAccept: rank >= 2, delegate: rank >= 3 };
}

export interface AgentTrustMetrics {
  windowDays: number;
  deliveries: number;
  bugsFiled: number;
  falseReports: number;
  falseReportRate: number | null;
  reopens: number;
  overrides: number;
  overridesLastWeek: number;
}

const FALSE_REPORT_RESOLUTIONS = ['INVALID', 'CANNOT_REPRODUCE', 'DUPLICATE'] as const;
const DAY = 86_400_000;

/**
 * The last 30 days of one agent: completed runs, bugs it filed and how many
 * were closed as invalid / cannot reproduce / duplicate (the /bugs
 * false-report rule, INV-1118), reopens of work it delivered (INV-1120), and
 * policy overrides on its work (people undoing an automatic decision; written
 * by INV-1491 / INV-1492 as WorkAudit rows whose reason starts with
 * `policy.override`).
 */
export async function loadAgentTrustMetrics(prisma: DatabaseClient, actorId: string, now = new Date(), windowDays = 30): Promise<AgentTrustMetrics> {
  const since = new Date(now.getTime() - windowDays * DAY);
  const weekAgo = new Date(now.getTime() - 7 * DAY);
  const [deliveries, filed, falseReports, deliveredIds] = await Promise.all([
    prisma.workRun.count({ where: { actorId, status: 'COMPLETED', endedAt: { gte: since } } }),
    prisma.workAudit.findMany({
      where: { actorId, before: { equals: Prisma.DbNull }, createdAt: { gte: since }, work: { labels: { some: { name: { equals: BUG_LABEL_NAME, mode: 'insensitive' } } } } },
      select: { workId: true },
      distinct: ['workId'],
    }),
    prisma.issue.count({
      where: {
        resolution: { in: [...FALSE_REPORT_RESOLUTIONS] },
        labels: { some: { name: { equals: BUG_LABEL_NAME, mode: 'insensitive' } } },
        audits: { some: { actorId, before: { equals: Prisma.DbNull } } },
        updatedAt: { gte: since },
      },
    }),
    prisma.workRun.findMany({ where: { actorId, status: 'COMPLETED' }, select: { workId: true }, distinct: ['workId'] }),
  ]);
  const workIds = deliveredIds.map((run) => run.workId);
  const [reopens, overrides, overridesLastWeek] = workIds.length
    ? await Promise.all([
      prisma.workReopen.count({ where: { workId: { in: workIds }, createdAt: { gte: since } } }),
      prisma.workAudit.count({ where: { workId: { in: workIds }, reason: { startsWith: POLICY_AUDIT.override }, createdAt: { gte: since } } }),
      prisma.workAudit.count({ where: { workId: { in: workIds }, reason: { startsWith: POLICY_AUDIT.override }, createdAt: { gte: weekAgo } } }),
    ])
    : [0, 0, 0];
  const bugsFiled = filed.length;
  return {
    windowDays,
    deliveries,
    bugsFiled,
    falseReports,
    falseReportRate: bugsFiled ? Math.round((falseReports / bugsFiled) * 1000) / 10 : null,
    reopens,
    overrides,
    overridesLastWeek,
  };
}

/**
 * Advice shown next to the Promote button (docs/autonomy-policy.md §7): a
 * raise is suggested after 30 clean days with real deliveries; a warning
 * after three overrides in a week. Never applied by the server.
 */
export function adviseTrust(level: AgentTrustLevel, metrics: AgentTrustMetrics): { suggestedLevel: AgentTrustLevel | null; warning: string | null } {
  const warning = metrics.overridesLastWeek >= 3 ? `${metrics.overridesLastWeek} automatic decisions on this agent’s work were undone this week; consider a lower level.` : null;
  const rank = AGENT_TRUST_LEVELS.indexOf(level);
  const clean = metrics.deliveries >= 5 && metrics.overrides === 0 && metrics.reopens === 0 && metrics.falseReports === 0;
  const suggestedLevel = !warning && clean && rank < AGENT_TRUST_LEVELS.length - 1 ? AGENT_TRUST_LEVELS[rank + 1]! : null;
  return { suggestedLevel, warning };
}

export async function readAgentTrust(prisma: DatabaseClient, actorId: string) {
  return prisma.agentTrust.findUnique({ where: { actorId }, include: { actor: { select: { actorKind: true } } } });
}

/** Writes the trust level with its reason; audited on the actor (ActorAudit `policy.changed`). Permission is the caller's job. */
export async function setAgentTrust(prisma: PrismaClient, input: { actorId: string; level: AgentTrustLevel; reason: string | null | undefined }, byActorId: string | null) {
  if (!AGENT_TRUST_LEVELS.includes(input.level)) throw createValidationError(AGENT_TRUST_LEVEL_INVALID_MESSAGE);
  const reason = input.reason?.trim() ?? '';
  if (!reason || reason.length > 2_000) throw createValidationError(AGENT_TRUST_REASON_REQUIRED_MESSAGE);
  const actor = await prisma.user.findUnique({ where: { id: input.actorId }, select: { actorKind: true } });
  if (!actor || actor.actorKind !== 'AGENT') throw createValidationError(AGENT_TRUST_AGENT_ONLY_MESSAGE);
  return prisma.$transaction(async (tx) => {
    const previous = await tx.agentTrust.findUnique({ where: { actorId: input.actorId } });
    const saved = await tx.agentTrust.upsert({
      where: { actorId: input.actorId },
      create: { actorId: input.actorId, level: input.level, setById: byActorId, reason },
      update: { level: input.level, setById: byActorId, reason },
    });
    await recordActorAudit(tx, {
      action: POLICY_AUDIT.changed,
      subjectId: input.actorId,
      byActorId,
      reason,
      before: previous ? { trust: previous.level } : null,
      after: { trust: saved.level },
    });
    return saved;
  });
}

/** A new agent starts at OBSERVE; the row makes that visible and auditable (INV-1490). */
export async function ensureAgentTrustRow(db: DatabaseClient, actorId: string): Promise<void> {
  await db.agentTrust.upsert({ where: { actorId }, create: { actorId, level: 'OBSERVE', reason: 'New agent: observes until a person promotes it (INV-1490).' }, update: {} });
}
