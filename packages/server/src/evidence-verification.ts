import { randomUUID } from 'node:crypto';
import type { Issue, Prisma, PrismaClient, WorkRun } from '@prisma/client';
import { digest, snapshotContract, VERIFICATION_MAX_AGE_MS } from './evidence-contract.js';
import { configuredGitHubVerifier, verifyGitHubEvidence, type GitHubVerifierOptions, type VerificationObservation } from './github-evidence-verifier.js';

type DatabaseClient = PrismaClient | Prisma.TransactionClient;
const VERIFIER_ID = 'github-app';
const VERIFIER_VERSION = '1';
const RETRY_MS = 5 * 60_000;
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

/** Called while holding the issue row lock, after network IO has finished. */
export async function assessVerifiedEvidence(tx: DatabaseClient, work: Issue, run: WorkRun | null) {
  const reasons: string[] = [];
  const current = snapshotContract(work);
  if (!current.acceptance) reasons.push('acceptance has no structured required criteria');
  if (!run || run.status !== 'COMPLETED' || !run.claimSnapshotId || !run.commitSha || !run.pullRequestNumber) reasons.push('completed execution binding is missing');
  if (run && (run.contractRevision !== current.contractRevision || run.acceptanceDigest !== current.acceptanceDigest || run.repository !== work.repository)) reasons.push('execution contract is stale');
  if (!run) return { eligible: false, reasons, covered: [] as string[] };
  const latest = await tx.workRun.findFirst({ where: { workId: work.id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
  if (latest?.id !== run.id) reasons.push('a newer execution attempt exists');
  const claim = await tx.workClaim.findUnique({ where: { workId: work.id } });
  if (claim && (claim.id !== run.claimSnapshotId || claim.actorId !== run.actorId)) reasons.push('execution lease was superseded');
  const rejected = await tx.workReviewDecision.findFirst({ where: { workId: work.id, decision: 'REJECTED', createdAt: { gte: run.startedAt } } });
  if (rejected) reasons.push('human rejected this execution');
  const evidence = await tx.workEvidence.findMany({
    where: { workId: work.id, runId: run.id, kind: { in: ['PR', 'TEST'] } },
    include: { verifications: { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 1 } },
  });
  const covered = new Set<string>();
  if (!evidence.length) reasons.push('no verified execution evidence');
  for (const item of evidence) {
    const result = item.verifications[0];
    const observation = result?.result as { covered?: unknown; source?: { prNumber?: unknown } } | undefined;
    if (!result || result.status !== 'VERIFIED' || result.verifierId !== VERIFIER_ID || result.verifierVersion !== VERIFIER_VERSION ||
        result.runId !== run.id || result.repository !== run.repository || result.commitSha !== run.commitSha ||
        observation?.source?.prNumber !== run.pullRequestNumber ||
        result.contractRevision !== current.contractRevision || result.acceptanceDigest !== current.acceptanceDigest ||
        Date.now() - result.observedAt.getTime() > VERIFICATION_MAX_AGE_MS || result.observedAt.getTime() > Date.now()) {
      reasons.push(`evidence ${item.id} is unverified, failed, unavailable or stale`);
      continue;
    }
    if (Array.isArray(observation?.covered)) for (const id of observation.covered) if (typeof id === 'string') covered.add(id);
  }
  for (const item of current.acceptance?.criteria ?? []) if (item.required && !covered.has(item.id)) reasons.push(`missing required acceptance ${item.id}`);
  return { eligible: reasons.length === 0, reasons, covered: [...covered].sort() };
}

/** Internal worker/DB operator entry, deliberately absent from GraphQL/MCP mutations. */
export async function verifyEvidence(prisma: PrismaClient, evidenceId: string, options: GitHubVerifierOptions = configuredGitHubVerifier()) {
  const evidence = await prisma.workEvidence.findUniqueOrThrow({ where: { id: evidenceId }, include: { run: true, work: true } });
  // Migration does not turn historical declarations into verification requests.
  if (!evidence.verificationNextAt) throw new Error('EVIDENCE_NOT_REQUESTED');
  const leaseId = randomUUID();
  const claimed = await prisma.workEvidence.updateMany({ where: { id: evidence.id,
    OR: [{ verificationLeaseUntil: null }, { verificationLeaseUntil: { lt: new Date() } }] },
    data: { verificationLeaseId: leaseId, verificationLeaseUntil: new Date(Date.now() + 5 * 60_000) } });
  if (claimed.count !== 1) throw new Error('VERIFICATION_BUSY');
  try {
    const run = evidence.run;
    const contract = snapshotContract(evidence.work);
    const binding = {
      evidenceId: evidence.id, verifierId: VERIFIER_ID, verifierVersion: VERIFIER_VERSION,
      repository: run?.repository ?? null, commitSha: run?.commitSha ?? null, runId: run?.id ?? null,
      contractRevision: run?.contractRevision ?? null, acceptanceDigest: run?.acceptanceDigest ?? null,
    };
    const unavailable: VerificationObservation = { status: 'UNAVAILABLE', failureCode: 'EXECUTION_NOT_BOUND',
      externalRunId: null, checks: [], covered: [], source: {} };
    await prisma.evidenceVerification.create({ data: { ...binding, status: 'PENDING', resultDigest: digest({ status: 'PENDING' }), result: { status: 'PENDING' } } });
    const observed = run?.repository && run.commitSha && run.pullRequestNumber && contract.acceptance && run.contractRevision === contract.contractRevision
      ? await verifyGitHubEvidence({ url: evidence.url, repository: run.repository, commitSha: run.commitSha,
          pullRequestNumber: run.pullRequestNumber, acceptance: contract.acceptance }, options)
      : unavailable;

    return await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "Issue" WHERE id = ${evidence.workId}::uuid FOR UPDATE`;
      const owned = await tx.workEvidence.updateMany({ where: { id: evidence.id, verificationLeaseId: leaseId,
        verificationLeaseUntil: { gt: new Date() } }, data: { verificationNextAt: new Date(Date.now() + RETRY_MS) } });
      if (owned.count !== 1) throw new Error('VERIFICATION_LEASE_LOST');
      const fresh = await tx.issue.findUniqueOrThrow({ where: { id: evidence.workId } });
      const freshRun = run ? await tx.workRun.findUnique({ where: { id: run.id } }) : null;
      const current = snapshotContract(fresh);
      const stale = !freshRun || current.contractRevision !== binding.contractRevision || current.acceptanceDigest !== binding.acceptanceDigest ||
        freshRun.commitSha !== binding.commitSha || freshRun.pullRequestNumber !== run?.pullRequestNumber || freshRun.repository !== binding.repository;
      const observation = stale ? { ...observed, status: 'STALE' as const, failureCode: 'EXECUTION_CHANGED', covered: [] } : observed;
      const result = await tx.evidenceVerification.create({ data: { ...binding, status: observation.status,
        failureCode: observation.failureCode, externalRunId: observation.externalRunId, observedAt: new Date(),
        resultDigest: digest(observation), result: json(observation) } });
      const { tryAutoAccept } = await import('./auto-accept-gate.js');
      await tryAutoAccept(tx, fresh.id, { runId: run?.id ?? null });
      return result;
    });
  } finally {
    await prisma.workEvidence.updateMany({ where: { id: evidence.id, verificationLeaseId: leaseId },
      data: { verificationLeaseId: null, verificationLeaseUntil: null } });
  }
}

/** Durable due-time queue with per-evidence leases; observations never accept work. */
export function startEvidenceVerifier(prisma: PrismaClient) {
  let stopped = false;
  let running: Promise<void> | null = null;
  const tick = () => {
    if (stopped || running) return;
    running = (async () => {
      const due = await prisma.workEvidence.findMany({ where: { verificationNextAt: { lte: new Date() },
        work: { commitmentStatus: 'COMMITTED', state: { type: { in: ['STARTED', 'REVIEW'] } } } },
        orderBy: [{ verificationNextAt: 'asc' }, { id: 'asc' }], take: 10, select: { id: true } });
      for (const item of due) {
        if (stopped) break;
        try { await verifyEvidence(prisma, item.id); } catch { console.error('[evidence-verifier] verification attempt unavailable'); }
      }
    })().catch(() => { console.error('[evidence-verifier] queue unavailable'); }).finally(() => { running = null; });
  };
  const timer = setInterval(tick, 30_000);
  timer.unref();
  tick();
  return async () => { stopped = true; clearInterval(timer); await running; };
}
