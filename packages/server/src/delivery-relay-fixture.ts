import type { PrismaClient } from '@prisma/client';
import type { GraphQLContext } from './auth.js';
import { createIssue } from './issue-service.js';
import { testParentId } from './test-placement.js';
import { proposeDeliveryChange, decideDeliveryChange } from './delivery-change-set.js';
import { claimWork } from './claim-service.js';
import { isWorkReadyForClaim } from './context-service.js';
import { reportRun, attachEvidence } from './run-service.js';
import { verifyEvidence } from './evidence-verification.js';
import type { GitHubVerifierOptions } from './github-evidence-verifier.js';
import { writeActorFromViewer } from './work-service.js';

// INV-994 (as amended 2026-10-07): the A→B relay is verified locally with a
// fixture GitHub, not against production. Unit B is released only once unit
// A's CI evidence is VERIFIED; a FAILED check keeps it blocked. Shared by the
// test and scripts/local-delivery-relay.ts.
const repository = 'example/project';
const sha = 'a'.repeat(40);

/** A GitHub that answers for PR #4 and workflow run #8 with the given job conclusion. */
export function fixtureGitHub(conclusion: 'success' | 'failure'): GitHubVerifierOptions {
  return {
    repositories: new Set([repository]),
    installationToken: async () => 'fixture-token',
    fetch: (async (url) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/pulls/4')) return Response.json({ id: 40, number: 4, merged: true, head: { sha }, base: { repo: { full_name: repository } } });
      if (path.endsWith('/actions/runs/8')) return Response.json({ id: 8, event: 'push', workflow_id: 7, run_attempt: 1, status: 'completed', conclusion: 'success', head_sha: sha, repository: { full_name: repository }, updated_at: '2026-10-07T00:00:00Z' });
      if (path.includes('/commits/')) return Response.json([{ id: 40, number: 4, merged_at: '2026-10-07T00:00:00Z', head: { sha }, base: { repo: { full_name: repository } } }]);
      if (path.includes('/attempts/1/jobs')) return Response.json({ total_count: 1, jobs: [{ id: 9, run_id: 8, head_sha: sha, name: 'verify', status: 'completed', conclusion }] });
      throw new Error(`unexpected fixture request: ${path}`);
    }) as typeof fetch,
  };
}

export async function relay(prisma: PrismaClient, conclusion: 'success' | 'failure', seed: { teamKey: string; humanEmail: string }) {
  const team = await prisma.team.findUniqueOrThrow({ where: { key: seed.teamKey } });
  const human = await prisma.user.findUniqueOrThrow({ where: { email: seed.humanEmail } });
  const ready = await prisma.workflowState.findFirstOrThrow({ where: { teamId: team.id, type: 'UNSTARTED' } });
  const agent = await prisma.user.create({ data: { name: 'Relay agent', email: `relay-${conclusion}@fixture.test`, actorKind: 'AGENT', ownerId: human.id } });
  const humanContext: GraphQLContext = { prisma, viewer: human, authMode: 'token', isTrustedSystem: true };
  const agentContext: GraphQLContext = { prisma, viewer: agent, authMode: 'token', isTrustedSystem: true };
  const root = await createIssue(prisma, { teamId: team.id, parentId: await testParentId(prisma, team.id, repository), title: 'Two-unit relay', repository, scope: 'src only', acceptance: 'A done\nB done', assigneeId: human.id, stateId: ready.id, commitmentStatus: 'COMMITTED' });
  const policy = { environments: [], units: [
    { key: 'a', title: 'First', criteria: [0], paths: ['src/'], actions: ['edit', 'test'], dependsOn: [], checks: [{ workflowId: 7, job: 'verify' }] },
    { key: 'b', title: 'Second', criteria: [1], paths: ['src/'], actions: ['edit', 'test'], dependsOn: ['a'] },
  ] };
  const set = await proposeDeliveryChange(agentContext, { workId: root.id, expectedRevision: root.revision, reason: 'Relay', changes: { policy } });
  await decideDeliveryChange(humanContext, { id: set.id, approve: true });
  // Approval created both units (INV-993); B waits for A.
  const a = await prisma.issue.findFirstOrThrow({ where: { deliveryRootId: root.id, deliveryUnitKey: 'a' } });
  const b = await prisma.issue.findFirstOrThrow({ where: { deliveryRootId: root.id, deliveryUnitKey: 'b' } });
  if (await isWorkReadyForClaim(prisma, b.id)) throw new Error('unit B was claimable before unit A delivered');

  const actor = writeActorFromViewer(agent, 'test');
  const claim = await claimWork(prisma, a.id, {}, actor);
  await reportRun(prisma, { workId: a.id, claimToken: claim.claimToken!, status: 'running', commitSha: sha, pullRequestNumber: 4 }, actor);
  const { run } = await reportRun(prisma, { workId: a.id, claimToken: claim.claimToken!, status: 'completed', commitSha: sha, pullRequestNumber: 4, summary: 'A done' }, actor);
  const { evidence } = await attachEvidence(prisma, { workId: a.id, runId: run.id, claimToken: claim.claimToken!, kind: 'TEST', url: `https://github.com/${repository}/actions/runs/8` }, actor);
  // Before the verifier runs, a declaration alone releases nothing.
  if (await isWorkReadyForClaim(prisma, b.id)) throw new Error('unit B was claimable on a bare evidence declaration');
  const verification = await verifyEvidence(prisma, evidence.id, fixtureGitHub(conclusion));
  return { root, a, b, run, evidence, verification, readyB: await isWorkReadyForClaim(prisma, b.id) };
}

