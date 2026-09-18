import { PrismaClient as PrismaClientConstructor } from '@prisma/client';
import type { PrismaClient, User } from '@prisma/client';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_TEAM_KEY, resetAndSeed } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import { answerAgentRequest, claimAgentRequest } from './agent-request-service.ts';
import { claimWork, commitWork, proposeWork } from './claim-service.ts';
import {
  RECEIPT_ACTOR_MISMATCH_MESSAGE,
  RECEIPT_ALREADY_ATTACHED_MESSAGE,
  attachDecisionReceipt,
} from './decision-receipt.ts';
import { createComment } from './issue-service.ts';
import { RUN_RECEIPT_NEEDS_AUDIT_MESSAGE, reportRun } from './run-service-report.ts';

loadProjectEnvironment();

const prisma = new PrismaClientConstructor();

const DESCRIPTION = [
  '### 1. 目标与架构定位', '回执测试夹具。',
  '### 2. 核心功能与交付范围', '仅测试。',
  '### 3. 验收标准与验证方案', 'vitest 通过。',
].join('\n');

describe('decision receipts (INV-588)', () => {
  beforeAll(async () => { await prisma.$connect(); });
  afterAll(async () => { await resetAndSeed(prisma); await prisma.$disconnect(); });
  beforeEach(async () => { await resetAndSeed(prisma); });

  it('a proposal and its receipt land in one transaction, identity copied from the audit', async () => {
    const { mia, team } = await agentAndTeam(prisma);

    const created = await proposeWork(
      prisma,
      {
        description: DESCRIPTION,
        receipt: {
          evidence: [{ kind: 'commit', ref: 'abc123', version: 'abc123' }],
          inputs: [{ kind: 'comment', ref: 'c-1', excerpt: 'please split this' }],
          reasoning: 'The scope was two features; I split them.',
          runtime: 'claude-code 2.1',
        },
        teamId: team.id,
        title: 'Split the migration',
      },
      { actorId: mia.id, actorKind: 'AGENT', sessionId: 'sess-42', surface: 'test' },
    );

    const audit = await prisma.workAudit.findFirstOrThrow({ where: { workId: created.id }, include: { receipt: true } });
    const receipt = audit.receipt!;

    expect(receipt.actorId).toBe(mia.id);          // from the audit
    expect(receipt.sessionId).toBe('sess-42');     // from the audit
    expect(receipt.contractRevision).toBe(created.revision);
    expect(receipt.runtime).toBe('claude-code 2.1');
    expect(receipt.reasoning).toContain('I split them');
  });

  it('marks references preserved only when they pin what was seen', async () => {
    const { mia, team } = await agentAndTeam(prisma);

    const created = await proposeWork(prisma, {
      description: DESCRIPTION,
      receipt: {
        evidence: [
          { kind: 'url', ref: 'https://example.test/doc' },                       // bare pointer
          { kind: 'commit', ref: 'abc123', version: 'abc123' },                   // pinned
          { kind: 'file', ref: 'src/a.ts', digest: 'sha256:deadbeef' },           // digested
          { kind: 'comment', ref: 'c-9', excerpt: 'the text as it was' },         // frozen
        ],
        reasoning: 'r',
      },
      teamId: team.id,
      title: 'Refs',
    }, { actorId: mia.id, actorKind: 'AGENT', surface: 'test' });

    const receipt = await prisma.decisionReceipt.findFirstOrThrow({ where: { actorId: mia.id } });
    const evidence = receipt.evidence as Array<{ ref: string; preserved: boolean }>;

    expect(evidence.map((e) => [e.ref, e.preserved])).toEqual([
      ['https://example.test/doc', false],
      ['abc123', true],
      ['src/a.ts', true],
      ['c-9', true],
    ]);
    expect(created.id).toBeTruthy();
  });

  it('rejects a self-reported actor that disagrees with the audit, and rolls back the write', async () => {
    const { mia, team } = await agentAndTeam(prisma);
    const impostor = await prisma.user.findFirstOrThrow({ where: { actorKind: 'HUMAN' } });

    await expect(proposeWork(prisma, {
      description: DESCRIPTION,
      receipt: { actorId: impostor.id, reasoning: 'I am someone else' },
      teamId: team.id,
      title: 'Forged',
    }, { actorId: mia.id, actorKind: 'AGENT', surface: 'test' })).rejects.toThrow(RECEIPT_ACTOR_MISMATCH_MESSAGE);

    // Same transaction: the proposal did not land either.
    await expect(prisma.issue.count({ where: { title: 'Forged' } })).resolves.toBe(0);
    await expect(prisma.decisionReceipt.count()).resolves.toBe(0);
  });

  it('requires reasoning', async () => {
    const { mia, team } = await agentAndTeam(prisma);

    await expect(proposeWork(prisma, {
      description: DESCRIPTION,
      receipt: { reasoning: '   ' },
      teamId: team.id,
      title: 'Empty',
    }, { actorId: mia.id, actorKind: 'AGENT', surface: 'test' })).rejects.toThrow(/reasoning/i);
  });

  it('is immutable: a second receipt on the same audit is refused', async () => {
    const { mia, team } = await agentAndTeam(prisma);
    const created = await proposeWork(prisma, {
      description: DESCRIPTION, receipt: { reasoning: 'first' }, teamId: team.id, title: 'Once',
    }, { actorId: mia.id, actorKind: 'AGENT', surface: 'test' });
    const audit = await prisma.workAudit.findFirstOrThrow({ where: { workId: created.id } });

    await expect(attachDecisionReceipt(prisma, { auditId: audit.id, receipt: { reasoning: 'second' } }))
      .rejects.toThrow(RECEIPT_ALREADY_ATTACHED_MESSAGE);
  });

  it('cannot be attached to an anonymous legacy write', async () => {
    const { team } = await agentAndTeam(prisma);
    const state = await prisma.workflowState.findFirstOrThrow({ where: { name: 'Ready', teamId: team.id } });
    const issue = await prisma.issue.create({ data: { identifier: 'INV-930', stateId: state.id, teamId: team.id, title: 'Legacy' } });
    const audit = await prisma.workAudit.create({
      data: { actorKind: 'SERVICE', after: {}, revision: 1, surface: 'internal', workId: issue.id },
    });

    await expect(attachDecisionReceipt(prisma, { auditId: audit.id, receipt: { reasoning: 'x' } }))
      .rejects.toThrow(/no actor/);
  });

  it('binds to its own audit row even when a newer audit for the work exists (the race)', async () => {
    const { mia, team } = await agentAndTeam(prisma);
    const human = await prisma.user.findFirstOrThrow({ where: { actorKind: 'HUMAN' } });
    const state = await prisma.workflowState.findFirstOrThrow({ where: { name: 'Ready', teamId: team.id } });
    const issue = await prisma.issue.create({ data: { identifier: 'INV-932', stateId: state.id, teamId: team.id, title: 'Race' } });
    await createComment(prisma, { body: '@mia why?', issueId: issue.id }, human.id);
    const request = await prisma.agentRequest.findFirstOrThrow({ where: { targetActorId: mia.id } });
    const held = await claimAgentRequest(prisma, { actorId: mia.id, id: request.id, sessionId: 'sess-a' });

    // Another execution's audit lands with a *later* timestamp than ours will
    // have — the exact situation "attach to the latest audit" got wrong.
    const intruder = await prisma.workAudit.create({
      data: {
        actorId: human.id, actorKind: 'HUMAN', after: {}, createdAt: new Date(Date.now() + 60_000),
        revision: 1, sessionId: 'sess-someone-else', surface: 'test', workId: issue.id,
      },
    });

    await answerAgentRequest(prisma, {
      actorId: mia.id, body: 'Mine.', claimToken: held.claimToken, id: request.id,
      receipt: { reasoning: 'my own reasoning' }, sessionId: 'sess-a',
    });

    const receipt = await prisma.decisionReceipt.findFirstOrThrow({ where: { reasoning: 'my own reasoning' } });
    const own = await prisma.workAudit.findFirstOrThrow({ where: { sourceMessageId: request.id, surface: 'agent_request.answered' } });
    expect(receipt.auditId).toBe(own.id);
    expect(receipt.auditId).not.toBe(intruder.id);
    expect(receipt.actorId).toBe(mia.id);
    expect(receipt.sessionId).toBe('sess-a');
  });

  it('an answer carries its receipt on the answered audit, with the claim generation', async () => {
    const { mia, team } = await agentAndTeam(prisma);
    const human = await prisma.user.findFirstOrThrow({ where: { actorKind: 'HUMAN' } });
    const state = await prisma.workflowState.findFirstOrThrow({ where: { name: 'Ready', teamId: team.id } });
    const issue = await prisma.issue.create({ data: { identifier: 'INV-931', stateId: state.id, teamId: team.id, title: 'Ask' } });
    await createComment(prisma, { body: '@mia why?', issueId: issue.id }, human.id);
    const request = await prisma.agentRequest.findFirstOrThrow({ where: { targetActorId: mia.id } });

    const held = await claimAgentRequest(prisma, { actorId: mia.id, id: request.id, sessionId: 'sess-7' });
    await answerAgentRequest(prisma, {
      actorId: mia.id,
      body: 'Because of the receipt.',
      claimToken: held.claimToken,
      id: request.id,
      receipt: { reasoning: 'I read the thread and the PR.', inputs: [{ kind: 'work', ref: issue.id, version: String(issue.revision) }] },
      sessionId: 'sess-7',
    });

    const audit = await prisma.workAudit.findFirstOrThrow({
      where: { sourceMessageId: request.id, surface: 'agent_request.answered' },
      include: { receipt: true },
    });
    expect(audit.claimGeneration).toBe(held.request.claimGeneration);
    expect(audit.receipt?.actorId).toBe(mia.id);
    expect(audit.receipt?.sessionId).toBe('sess-7');
    expect(audit.receipt?.reasoning).toContain('the thread');
  });
});

describe('receipts on run_report (INV-588)', () => {
  beforeEach(async () => { await resetAndSeed(prisma); });

  it('a completing report carries its receipt on the review-transition audit', async () => {
    const { mia, team } = await agentAndTeam(prisma);
    const created = await proposeWork(prisma, { description: DESCRIPTION, teamId: team.id, title: 'Run me' },
      { actorId: mia.id, actorKind: 'AGENT', surface: 'test' });
    // Commit through the real human gate (moves it to Ready), then claim.
    const admin = await prisma.user.findFirstOrThrow({ where: { actorKind: 'HUMAN' } });
    await commitWork(prisma, created.id, { acceptance: 'Tests pass and the receipt is attached.', assigneeId: admin.id, expectedRevision: created.revision }, { actorId: admin.id, actorKind: 'HUMAN', surface: 'test' });
    await claimWork(prisma, created.id, {}, { actorId: mia.id, actorKind: 'AGENT', surface: 'test' });

    const { work } = await reportRun(prisma, {
      receipt: { reasoning: 'Tests green; moving to review.', evidence: [{ kind: 'commit', ref: 'a'.repeat(40), version: 'a'.repeat(40) }] },
      status: 'completed',
      summary: 'done',
      workId: created.id,
    }, { actorId: mia.id, actorKind: 'AGENT', sessionId: 'sess-r', surface: 'test' });

    const audit = await prisma.workAudit.findFirstOrThrow({
      where: { workId: work.id }, orderBy: { createdAt: 'desc' }, include: { receipt: true },
    });
    expect(audit.receipt?.actorId).toBe(mia.id);
    expect(audit.receipt?.sessionId).toBe('sess-r');
    expect(audit.receipt?.reasoning).toContain('moving to review');
  });

  it('refuses a receipt on a report that audited nothing, and does not pin it to an older audit', async () => {
    const { mia, team } = await agentAndTeam(prisma);
    const created = await proposeWork(prisma, { description: DESCRIPTION, teamId: team.id, title: 'Phase only' },
      { actorId: mia.id, actorKind: 'AGENT', surface: 'test' });
    // Commit through the real human gate (moves it to Ready), then claim.
    const admin = await prisma.user.findFirstOrThrow({ where: { actorKind: 'HUMAN' } });
    await commitWork(prisma, created.id, { acceptance: 'Tests pass and the receipt is attached.', assigneeId: admin.id, expectedRevision: created.revision }, { actorId: admin.id, actorKind: 'HUMAN', surface: 'test' });
    await claimWork(prisma, created.id, {}, { actorId: mia.id, actorKind: 'AGENT', surface: 'test' });

    // First running report moves Ready → In Progress (audited, no receipt).
    await reportRun(prisma, { phase: 'starting', status: 'running', workId: created.id },
      { actorId: mia.id, actorKind: 'AGENT', surface: 'test' });

    // Second one changes nothing audited: a receipt has no row to explain.
    await expect(reportRun(prisma, {
      phase: 'investigating',
      receipt: { reasoning: 'just thinking' },
      status: 'running',
      workId: created.id,
    }, { actorId: mia.id, actorKind: 'AGENT', surface: 'test' })).rejects.toThrow(RUN_RECEIPT_NEEDS_AUDIT_MESSAGE);

    // The creation audit did not silently pick up a receipt it does not explain.
    await expect(prisma.decisionReceipt.count()).resolves.toBe(0);
  });
});

async function agentAndTeam(client: PrismaClient): Promise<{ mia: User; team: { id: string } }> {
  const admin = await client.user.findFirstOrThrow({ where: { actorKind: 'HUMAN' } });
  const mia = await client.user.create({
    data: { actorKind: 'AGENT', email: 'mia@agents.test.local', handle: 'mia', name: 'Mia', ownerId: admin.id },
  });
  const team = await client.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
  return { mia, team };
}
