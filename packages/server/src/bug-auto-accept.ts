import type { Prisma, PrismaClient } from '@prisma/client';

import { ensureAutoAcceptActor } from './auto-accept-gate.js';
import { configuredGitHubVerifier, verifyBugFix, type BugFixObservation, type GitHubVerifierOptions } from './github-evidence-verifier.js';
import { reviewWorkInTransaction } from './run-service-review.js';

/**
 * The Auto-Accept Gate for bugs (INV-1075). A bug in a PROJECT that turned
 * this on (autoAcceptBugs) and sits in Review is accepted when GitHub itself
 * confirms the fix: the run's PR merged with its head, or its commit on the
 * default branch, and the commit's checks green. The decision is recorded as
 * the SERVICE actor "Auto-Accept Gate", never as the agent; what the agent
 * wrote in summaries counts for nothing. Everything else stays for a person,
 * with the reason recorded where /in-review shows it.
 */
export const BUG_GATE_SOURCE = 'bug-gate';
/** A work whose last check failed is looked at again after this long. */
export const BUG_GATE_RETRY_MS = 10 * 60_000;

const BUG_LABEL = { some: { name: { equals: 'bug', mode: 'insensitive' as const } } };

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

export async function sweepBugAutoAccept(
  prisma: PrismaClient,
  options: GitHubVerifierOptions = configuredGitHubVerifier(),
  now = new Date(),
): Promise<{ accepted: number; skipped: number }> {
  const projects = await prisma.issue.findMany({
    where: { kind: 'PROJECT', autoAcceptBugs: true, commitmentStatus: 'COMMITTED', repository: { not: null } },
    select: { repository: true },
  });
  const repositories = [...new Set(projects.map((project) => project.repository!))];
  if (repositories.length === 0) return { accepted: 0, skipped: 0 };

  const candidates = await prisma.issue.findMany({
    where: {
      commitmentStatus: 'COMMITTED',
      kind: 'ISSUE',
      repository: { in: repositories },
      deliveryRootId: null,
      supersededById: null,
      state: { type: 'REVIEW' },
      labels: BUG_LABEL,
    },
    select: { id: true },
    take: 50,
  });

  let accepted = 0;
  let skipped = 0;
  const gate = await ensureAutoAcceptActor(prisma);
  for (const { id } of candidates) {
    const run = await prisma.workRun.findFirst({ where: { workId: id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
    if (!run || run.status !== 'COMPLETED' || !run.commitSha || !run.repository) {
      skipped += await record(prisma, id, run?.id ?? null, gate.id, now, ['the latest run is not a completed run with a commit sha'], null);
      continue;
    }
    const recent = await prisma.workAutoAcceptEvaluation.findFirst({
      where: { workId: id, runId: run.id, signals: { path: ['source'], equals: BUG_GATE_SOURCE }, createdAt: { gt: new Date(now.getTime() - BUG_GATE_RETRY_MS) } },
    });
    if (recent) continue;
    const returned = await prisma.workReviewDecision.findFirst({ where: { workId: id, decision: 'REJECTED', createdAt: { gte: run.startedAt } } });
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
    const reason = `Auto-accepted: GitHub confirms ${where}; ${observation.checks.length} CI check(s) green.`;
    const done = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Issue" WHERE id = ${id}::uuid FOR UPDATE`;
      const fresh = await tx.issue.findUniqueOrThrow({ where: { id }, include: { state: true } });
      const latest = await tx.workRun.findFirst({ where: { workId: id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
      // A person or a new run got there first: leave it.
      if (fresh.state.type !== 'REVIEW' || latest?.id !== run.id) return false;
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
