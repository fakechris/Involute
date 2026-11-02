import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ADMIN_EMAIL, DEFAULT_TEAM_KEY, resetAndSeed } from '../prisma/seed-helpers.js';
import { loadProjectEnvironment } from '../prisma/env.js';
import { issueAgentCredential } from './agent-credentials.js';
import { setAgentTrust } from './agent-trust.js';
import { AUTONOMY_GATE_ACTOR, loadHandledForYou } from './autonomy-gate.js';
import { observeLabelFor, setWorkflowPolicy } from './autonomy-service.js';
import { proposeWork } from './claim-service.js';
import { proposeContractAmendment, reopenContractAmendment } from './contract-amendment.js';
import { createIssue } from './issue-service.js';
import { uncommitWork } from './work-uncommit.js';
import { writeActorFromViewer } from './work-service.js';
import { WORKSPACE_SETTINGS_ID } from './workspace-access.js';

// INV-1491: the first gates a policy may open — candidate_commit and
// contract_amendment at L1 — and the undo that counts as an override.
loadProjectEnvironment();
const prisma = new PrismaClient();

beforeEach(async () => { await resetAndSeed(prisma); });
afterAll(async () => { await resetAndSeed(prisma); await prisma.$disconnect(); });

const DESCRIPTION = ['### 1. 目标与架构定位', 'x', '### 2. 核心功能与交付范围', 'x', '### 3. 验收标准与验证方案', 'x', '', '### Steps to reproduce', '1. open the page'].join('\n');

async function fixture(level: 0 | 1 | 2 = 1) {
  const admin = await prisma.user.findUniqueOrThrow({ where: { email: DEFAULT_ADMIN_EMAIL } });
  const team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
  const issued = await issueAgentCredential(prisma, { email: `gate-${Date.now()}@agents.involute.local`, name: 'Gatey', ownerId: admin.id, teamKey: team.key, scopes: ['read', 'propose'], issuedById: admin.id });
  const agent = await prisma.user.findUniqueOrThrow({ where: { id: issued.credential.userId } });
  await setAgentTrust(prisma, { actorId: agent.id, level: 'L2', reason: 'test' }, admin.id);
  const human = writeActorFromViewer(admin, 'test');
  const project = await createIssue(prisma, { teamId: team.id, title: 'P', kind: 'PROJECT', repository: 'test/gate', commitmentStatus: 'COMMITTED' }, human);
  if (level > 0) {
    await setWorkflowPolicy(prisma, { scope: 'WORKSPACE', scopeId: WORKSPACE_SETTINGS_ID, level, reason: 'c' }, admin.id);
    await setWorkflowPolicy(prisma, { scope: 'TEAM', scopeId: team.id, level, reason: 't' }, admin.id);
  }
  const agentActor = writeActorFromViewer(agent, 'mcp');
  const propose = (title: string, extra: Record<string, unknown> = {}) => proposeWork(prisma, {
    teamId: team.id, title, description: DESCRIPTION, acceptance: 'Fixed and covered by a test.', parentId: project.id, priority: 2, labels: ['improvement'], ...extra,
  } as Parameters<typeof proposeWork>[1], agentActor);
  return { admin, team, agent, human, agentActor, project, propose };
}

describe('Autonomy Gate at L1 (INV-1491)', () => {
  it('L0: an agent proposal stays a candidate exactly as before', async () => {
    const { propose } = await fixture(0);
    const work = await propose('Improve the thing');
    expect(work.commitmentStatus).toBe('CANDIDATE');
    expect(await observeLabelFor(prisma, { kind: 'CANDIDATE_COMMIT', subjectId: work.id, workId: work.id })).toBeNull();
  });

  it('L1: a qualifying improvement candidate is committed by the gate with the policy in the audit; the agent owner becomes the human owner', async () => {
    const { admin, agent, propose } = await fixture(1);
    const work = await propose('Improve the thing');
    expect(work.commitmentStatus).toBe('COMMITTED');
    expect(work.assigneeId).toBe(admin.id);
    const audit = await prisma.workAudit.findFirst({ where: { workId: work.id, reason: { startsWith: 'policy.auto_decision' } }, include: { actor: true } });
    expect(audit?.actor?.handle).toBe(AUTONOMY_GATE_ACTOR.handle);
    expect(audit?.actorKind).toBe('SERVICE');
    expect(audit?.reason).toMatch(/^policy\.auto_decision: candidate_commit by team policy v1 \(L1\) — matched: type improvement.*priority 2/);
    // The proposing agent hears the same event a person's commit emits.
    const notified = await prisma.notification.findFirst({ where: { workId: work.id, userId: agent.id, type: 'work.committed' } });
    expect(notified).not.toBeNull();
    const handled = await loadHandledForYou(prisma, {});
    expect(handled.map((item) => [item.gate, item.workId, item.policyVersion, item.undone, item.reversible])).toEqual([['candidate_commit', work.id, 1, false, true]]);
  });

  it('L1: a feature, an Urgent item or a candidate without acceptance stays with a person, and Needs you says why', async () => {
    const { propose } = await fixture(1);
    const feature = await propose('New screen', { labels: ['feature'] });
    const urgent = await propose('Urgent fix', { priority: 1 });
    expect(feature.commitmentStatus).toBe('CANDIDATE');
    expect(urgent.commitmentStatus).toBe('CANDIDATE');
    expect(await observeLabelFor(prisma, { kind: 'CANDIDATE_COMMIT', subjectId: feature.id, workId: feature.id })).toBe('Escalated: candidate_commit condition not met.');
  });

  it('a new agent at OBSERVE is clamped: its qualifying proposal stays a candidate even in an L1 team', async () => {
    const { admin, agent, propose } = await fixture(1);
    await setAgentTrust(prisma, { actorId: agent.id, level: 'OBSERVE', reason: 'back to start' }, admin.id);
    expect((await propose('Improve the thing')).commitmentStatus).toBe('CANDIDATE');
  });

  it('observe mode labels but never commits', async () => {
    const { admin, team, propose } = await fixture(1);
    await setWorkflowPolicy(prisma, { scope: 'TEAM', scopeId: team.id, level: 1, observeDays: 7, reason: 'watch' }, admin.id);
    const work = await propose('Improve the thing');
    expect(work.commitmentStatus).toBe('CANDIDATE');
    expect(await observeLabelFor(prisma, { kind: 'CANDIDATE_COMMIT', subjectId: work.id, workId: work.id })).toMatch(/^Would be handled under L1/);
  });

  it('Return to candidates on an auto-committed item writes a policy.override audit and shows as returned', async () => {
    const { human, propose } = await fixture(1);
    const work = await propose('Improve the thing');
    const restored = await uncommitWork(prisma, work.id, { expectedRevision: work.revision }, human);
    expect(restored.commitmentStatus).toBe('CANDIDATE');
    const override = await prisma.workAudit.findFirst({ where: { workId: work.id, reason: { startsWith: 'policy.override' } } });
    expect(override?.reason).toContain('returned to candidates');
    const handled = await loadHandledForYou(prisma, {});
    expect(handled[0]).toMatchObject({ workId: work.id, undone: true, reversible: false });
  });

  it('L1: a verification-only amendment is accepted by the gate; one touching acceptance waits; Return to me reverts and reopens it', async () => {
    const { human, agentActor, propose } = await fixture(1);
    const work = await propose('Improve the thing');
    expect(work.commitmentStatus).toBe('COMMITTED');
    const onlyVerification = await proposeContractAmendment(prisma, { workId: work.id, changes: { verification: 'pnpm test exit 0' }, reason: 'name the command' }, agentActor);
    expect(onlyVerification.status).toBe('ACCEPTED');
    expect((await prisma.issue.findUniqueOrThrow({ where: { id: work.id } })).verification).toBe('pnpm test exit 0');
    expect(onlyVerification.decisionNote).toMatch(/^policy\.auto_decision: contract_amendment by team policy v1/);

    const touchesAcceptance = await proposeContractAmendment(prisma, { workId: work.id, changes: { acceptance: 'Looser.' }, reason: 'relax' }, agentActor);
    expect(touchesAcceptance.status).toBe('PENDING');
    expect(await observeLabelFor(prisma, { kind: 'CONTRACT_AMENDMENT', subjectId: touchesAcceptance.id, workId: work.id })).toBe('Escalated: contract_amendment condition not met.');

    const reopened = await reopenContractAmendment(prisma, { amendmentId: onlyVerification.id, reason: 'I want to read it first' }, human);
    expect(reopened.amendment.status).toBe('PENDING');
    expect(reopened.work.verification).toBeNull();
    const override = await prisma.workAudit.findFirst({ where: { workId: work.id, reason: { startsWith: 'policy.override' } } });
    expect(override?.reason).toContain('amendment returned to a person');
    await expect(reopenContractAmendment(prisma, { amendmentId: touchesAcceptance.id, reason: 'x' }, human)).rejects.toThrow(/Only an amendment the Autonomy Gate accepted/);
  });
});
