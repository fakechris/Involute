import type { Prisma, PrismaClient } from '@prisma/client';

import { ensureAutoAcceptActor } from './auto-accept-gate.js';
import { lockWorkGraph } from './graph-integrity.js';
import { configuredGitHubVerifier, verifyBugFix, type BugFixObservation, type GitHubVerifierOptions } from './github-evidence-verifier.js';
import { reviewWorkInTransaction } from './run-service-review.js';
import { isIntermittent } from './reproducibility.js';
import { autoDecisionReason } from './autonomy-gate.js';
import { BUILT_IN_LOCKS, decide, evaluatePredicate, type AutonomyFacts } from './autonomy-policy.js';
import { factsForWork, loadAutonomyFor, type AutonomyView } from './autonomy-service.js';

/**
 * The Auto-Accept Gate for bugs (INV-1075). A bug in a PROJECT that turned
 * this on (autoAcceptBugs) and sits in Review is accepted when GitHub itself
 * confirms the fix: the run's PR merged with its head, or its commit on the
 * default branch, and the commit's checks green. The decision is recorded as
 * the SERVICE actor "Auto-Accept Gate", never as the agent; what the agent
 * wrote in summaries counts for nothing. Everything else stays for a person,
 * with the reason recorded where /in-review shows it. A bug that reproduces
 * only SOMETIMES or ONCE is always left for a person (INV-1122): green CI on
 * the fix cannot show an intermittent bug is gone.
 */
export const BUG_GATE_SOURCE = 'bug-gate';
/** A work whose last check failed is looked at again after this long. */
export const BUG_GATE_RETRY_MS = 10 * 60_000;
/** GitHub is asked about at most this many bugs per sweep; the longest-unchecked go first. */
export const BUG_GATE_BATCH = 50;

const BUG_LABEL = { some: { name: { equals: 'bug', mode: 'insensitive' as const } } };

/** Shown on /in-review for a SOMETIMES / ONCE bug (INV-1122). */
export function intermittentReason(reproducibility: 'SOMETIMES' | 'ONCE'): string {
  const how = reproducibility === 'ONCE' ? 'was seen only once' : 'reproduces only sometimes';
  return `the bug ${how}; a merged fix with green CI cannot prove it gone, so a person accepts it (${reproducibility})`;
}

function reasonFor(observation: BugFixObservation): string {
  const code = observation.failureCode ?? 'UNKNOWN';
  const human: Record<string, string> = {
    VERIFIER_NOT_CONFIGURED: 'GitHub verification is not configured for this repository',
    SOURCE_NOT_ALLOWED: 'this repository is not on the verifier allow-list',
    EXECUTION_NOT_BOUND: 'the run has no commit sha',
    PR_NOT_MERGED: 'the pull request is not merged',
    HEAD_CHANGED: 'the pull request head no longer matches the run',
    PR_MISMATCH: 'the pull request does not belong to this repository',
    COMMIT_NOT_ON_DEFAULT_BRANCH: 'the fix commit is not on the default branch',
    NO_CHECKS: 'the fix commit has no CI checks',
    NO_PASSING_CHECK: 'no CI check passed on the fix commit',
    CHECK_FAILED: 'a CI check failed on the fix commit',
    CHECK_PENDING: 'CI checks are still running',
    RATE_OR_PERMISSION_LIMIT: 'GitHub rate limit or permission refused',
  };
  return `${human[code] ?? 'GitHub could not confirm the fix'} (${code})`;
}

/**
 * Why the autonomy policy keeps an item with a person (INV-1492), shown on
 * /in-review beside the GitHub codes.
 */
export const POLICY_SKIP_CODES = {
  level: 'POLICY_LEVEL_TOO_LOW',
  trust: 'AGENT_TRUST_TOO_LOW',
  locked: 'LOCKED_GATE',
} as const;

interface PolicyCheck { view: AutonomyView; facts: AutonomyFacts; allowed: boolean; reason: string | null }

/** The item's resolved `review_accept` gate for the agent that delivered it, before GitHub is asked. */
async function policyCheck(prisma: PrismaClient, work: { id: string; teamId: string; kind: string; parentId: string | null; priority: number; severity: string | null; reproducibility: string | null; source: string | null; description: string | null; acceptance: string | null }, deliveredBy: { id: string; actorKind: string } | null): Promise<PolicyCheck> {
  const view = await loadAutonomyFor(prisma, work, deliveredBy);
  const facts = await factsForWork(prisma, work);
  const gate = view.gates.review_accept;
  if (gate.decider !== 'auto') {
    const why = view.source === 'agent_trust'
      ? `the delivering agent's trust level (${view.agentTrust ?? 'OBSERVE'}) keeps acceptance with a person (${POLICY_SKIP_CODES.trust})`
      : `the autonomy level here is L${view.level}; automatic acceptance starts at L2 (${POLICY_SKIP_CODES.level})`;
    return { view, facts, allowed: false, reason: why };
  }
  const lock = BUILT_IN_LOCKS.find((entry) => entry.gate === 'review_accept' && evaluatePredicate(entry.when, facts));
  if (lock) return { view, facts, allowed: false, reason: `${lock.reason} (${POLICY_SKIP_CODES.locked})` };
  if (view.observing) return { view, facts, allowed: false, reason: `the policy is observing: L${view.requested} would accept this once turned on (${POLICY_SKIP_CODES.level})` };
  return { view, facts, allowed: true, reason: null };
}

export async function sweepBugAutoAccept(
  prisma: PrismaClient,
  options: GitHubVerifierOptions = configuredGitHubVerifier(),
  now = new Date(),
): Promise<{ accepted: number; skipped: number }> {
  // Two doors into the gate (INV-1075 → INV-1492): the legacy per-project
  // switch for Type: Bug, and the autonomy policy (L2+) for any Type.
  // A repository name is only unique within a team: the switch covers that team's bugs.
  const projects = await prisma.issue.findMany({
    where: { kind: 'PROJECT', autoAcceptBugs: true, commitmentStatus: 'COMMITTED', repository: { not: null } },
    select: { repository: true, teamId: true },
  });
  const policyTeams = await prisma.workflowPolicy.findMany({ where: { active: true, level: { gte: 2 }, scope: { in: ['TEAM', 'PROJECT'] } }, select: { scope: true, scopeId: true } });
  const teamIds = new Set<string>(policyTeams.filter((row) => row.scope === 'TEAM').map((row) => row.scopeId));
  const projectIds = policyTeams.filter((row) => row.scope === 'PROJECT').map((row) => row.scopeId);
  if (projectIds.length) for (const project of await prisma.issue.findMany({ where: { id: { in: projectIds } }, select: { teamId: true } })) teamIds.add(project.teamId);
  if (projects.length === 0 && teamIds.size === 0) return { accepted: 0, skipped: 0 };

  const reviewWhere = { commitmentStatus: 'COMMITTED' as const, kind: 'ISSUE' as const, deliveryRootId: null, supersededById: null, state: { type: 'REVIEW' as const } };
  const inReview = await prisma.issue.findMany({
    where: {
      OR: [
        ...(projects.length ? [{ AND: [{ OR: projects.map((project) => ({ teamId: project.teamId, repository: project.repository! })) }, { labels: BUG_LABEL }] }] : []),
        ...(teamIds.size ? [{ teamId: { in: [...teamIds] } }] : []),
      ],
      ...reviewWhere,
    },
    select: { id: true, teamId: true, kind: true, parentId: true, priority: true, severity: true, reproducibility: true, source: true, description: true, acceptance: true, repository: true, labels: { select: { name: true } } },
  });
  const legacyKey = new Set(projects.map((project) => `${project.teamId}|${project.repository}`));
  // Longest-unchecked first, recently checked left out, so bugs that wait for a
  // person can never crowd out the rest (never checked sorts first).
  const lastChecked = new Map<string, number>();
  for (const row of await prisma.workAutoAcceptEvaluation.groupBy({
    by: ['workId'],
    where: { workId: { in: inReview.map((item) => item.id) }, signals: { path: ['source'], equals: BUG_GATE_SOURCE } },
    _max: { createdAt: true },
  })) lastChecked.set(row.workId, row._max.createdAt?.getTime() ?? 0);
  const candidates = inReview
    .filter((item) => now.getTime() - (lastChecked.get(item.id) ?? 0) >= BUG_GATE_RETRY_MS)
    .sort((a, b) => (lastChecked.get(a.id) ?? 0) - (lastChecked.get(b.id) ?? 0))
    .slice(0, BUG_GATE_BATCH);

  let accepted = 0;
  let skipped = 0;
  const gate = await ensureAutoAcceptActor(prisma);
  for (const work of candidates) {
    const { id, reproducibility } = work;
    const run = await prisma.workRun.findFirst({ where: { workId: id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], include: { actor: { select: { id: true, actorKind: true } } } });
    // Which door: the legacy switch covers this team's bugs in that repository; everything else is policy.
    const isBug = work.labels.some((label) => label.name.toLowerCase() === 'bug');
    const legacy = isBug && legacyKey.has(`${work.teamId}|${work.repository}`);
    let policy: PolicyCheck | null = null;
    if (!legacy) {
      policy = await policyCheck(prisma, work, run?.actor ?? null);
      if (!policy.allowed) {
        skipped += await record(prisma, id, run?.id ?? null, gate.id, now, [policy.reason!], null);
        continue;
      }
    }
    // Intermittent: GitHub is not asked, whatever it would say.
    if (isIntermittent(reproducibility)) {
      skipped += await record(prisma, id, run?.id ?? null, gate.id, now, [intermittentReason(reproducibility)], null);
      continue;
    }
    if (!run || run.status !== 'COMPLETED' || !run.commitSha || !run.repository) {
      skipped += await record(prisma, id, run?.id ?? null, gate.id, now, ['the latest run is not a completed run with a commit sha'], null);
      continue;
    }
    // The gate decides a run once. Accepted before and back in Review means a
    // person moved it back: from then on it is theirs, as is a returned run.
    const acceptedBefore = await prisma.workAutoAcceptEvaluation.findFirst({
      where: { workId: id, runId: run.id, outcome: 'ACCEPTED', signals: { path: ['source'], equals: BUG_GATE_SOURCE } },
    });
    const returned = acceptedBefore ?? await prisma.workReviewDecision.findFirst({ where: { workId: id, decision: 'REJECTED', createdAt: { gte: run.startedAt } } });
    if (returned) {
      skipped += await record(prisma, id, run.id, gate.id, now, ['a person returned this run; it waits for a person'], null);
      continue;
    }

    const observation = await verifyBugFix({ repository: run.repository, commitSha: run.commitSha, pullRequestNumber: run.pullRequestNumber }, options);
    if (observation.status !== 'VERIFIED') {
      skipped += await record(prisma, id, run.id, gate.id, now, [reasonFor(observation)], observation);
      continue;
    }

    const where = observation.source.mode === 'pr'
      ? `PR #${String(observation.source.prNumber)} merged`
      : `commit ${run.commitSha.slice(0, 12)} on ${String(observation.source.defaultBranch)}`;
    const confirmed = `GitHub confirms ${where}; ${observation.checks.length} CI check(s) green.`;
    let reason = `Auto-accepted: ${confirmed}`;
    if (policy) {
      // GitHub's facts complete the condition; the policy decides, and the audit names it (INV-1492).
      const facts: AutonomyFacts = { ...policy.facts, auto_accept_grade: 'CLEAR', pr_merged: true, checks: 'green' };
      const decision = decide(policy.view, 'review_accept', facts);
      if (decision.decider !== 'auto') {
        skipped += await record(prisma, id, run.id, gate.id, now, [decision.reason], observation);
        continue;
      }
      reason = `${autoDecisionReason(policy.view, 'review_accept', facts)}; ${confirmed}`;
    }
    const done = await prisma.$transaction(async (tx) => {
      // Same lock order as every other writer: the team graph, then the row.
      const { teamId } = await tx.issue.findUniqueOrThrow({ where: { id }, select: { teamId: true } });
      await lockWorkGraph(tx, teamId);
      await tx.$queryRaw`SELECT id FROM "Issue" WHERE id = ${id}::uuid FOR UPDATE`;
      const fresh = await tx.issue.findUniqueOrThrow({ where: { id }, include: { state: true } });
      const latest = await tx.workRun.findFirst({ where: { workId: id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
      // A person or a new run got there first, or marked it intermittent meanwhile: leave it.
      if (fresh.state.type !== 'REVIEW' || latest?.id !== run.id || isIntermittent(fresh.reproducibility)) return false;
      const { decision } = await reviewWorkInTransaction(tx, id, { decision: 'ACCEPTED', expectedRevision: fresh.revision, runId: run.id, reason },
        { actorId: gate.id, actorKind: 'SERVICE', surface: 'auto-accept-gate', reason });
      await persist(tx, id, run.id, gate.id, 'ACCEPTED', 'CLEAR', [reason], observation, decision.id);
      return true;
    });
    if (done) accepted += 1;
  }
  return { accepted, skipped };
}

async function record(
  prisma: PrismaClient,
  workId: string,
  runId: string | null,
  actorId: string,
  now: Date,
  reasons: string[],
  observation: BugFixObservation | null,
): Promise<number> {
  // Same reason as last time within the retry window: nothing new to say.
  const last = await prisma.workAutoAcceptEvaluation.findFirst({
    where: { workId, signals: { path: ['source'], equals: BUG_GATE_SOURCE } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
  if (last && last.runId === runId && last.reasons.join('|') === reasons.join('|') && now.getTime() - last.createdAt.getTime() < BUG_GATE_RETRY_MS) return 1;
  await persist(prisma, workId, runId, actorId, 'SKIPPED', observation?.status === 'FAILED' ? 'INSUFFICIENT' : 'LIKELY', reasons, observation, null);
  return 1;
}

async function persist(
  db: PrismaClient | Prisma.TransactionClient,
  workId: string,
  runId: string | null,
  actorId: string,
  outcome: 'ACCEPTED' | 'SKIPPED',
  tier: 'CLEAR' | 'LIKELY' | 'INSUFFICIENT',
  reasons: string[],
  observation: BugFixObservation | null,
  decisionId: string | null,
) {
  await db.workAutoAcceptEvaluation.create({
    data: {
      workId, runId, actorId, outcome, tier, reasons, decisionId,
      signals: { source: BUG_GATE_SOURCE, status: observation?.status ?? null, failureCode: observation?.failureCode ?? null, github: observation?.source ?? null, checks: observation?.checks ?? [] } as Prisma.InputJsonValue,
    },
  });
}

/** Every five minutes; off entirely while no PROJECT has turned it on. */
export function startBugAutoAccept(prisma: PrismaClient) {
  const timer = setInterval(() => {
    void sweepBugAutoAccept(prisma).catch((error: unknown) => {
      console.error('Failed to sweep bug auto-accept.');
      console.error(error);
    });
  }, 5 * 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
