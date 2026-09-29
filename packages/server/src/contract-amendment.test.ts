import { PrismaClient as PrismaClientConstructor } from '@prisma/client';
import type { Issue, PrismaClient, User } from '@prisma/client';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_TEAM_KEY, resetAndSeed } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import {
  acceptContractAmendment,
  amendmentChanges,
  proposeContractAmendment,
  rejectContractAmendment,
} from './contract-amendment.ts';
import {
  CONTRACT_AMENDMENT_AGENTS_ONLY_MESSAGE,
  CONTRACT_AMENDMENT_ALREADY_DECIDED_MESSAGE,
  CONTRACT_AMENDMENT_FIELDS_MESSAGE,
  CONTRACT_AMENDMENT_HUMAN_ONLY_MESSAGE,
  CONTRACT_AMENDMENT_NO_CHANGE_MESSAGE,
  CONTRACT_AMENDMENT_REASON_REQUIRED_MESSAGE,
  CONTRACT_AMENDMENT_REJECT_NOTE_REQUIRED_MESSAGE,
  CONTRACT_AMENDMENT_REQUIRES_COMMITTED_MESSAGE,
  CONTRACT_AMENDMENT_STALE_MESSAGE,
  WORK_COMMIT_REQUIRES_ACCEPTANCE_MESSAGE,
} from './errors.ts';
import { updateIssue } from './issue-service.ts';
import type { WriteActor } from './work-service.ts';

loadProjectEnvironment();

const prisma = new PrismaClientConstructor();

/**
 * INV-869. Agents still cannot rewrite a committed contract; they propose the
 * change, and a person's one click applies it exactly as a manual edit would.
 */
describe('contract amendments (INV-869)', () => {
  beforeAll(async () => { await prisma.$connect(); });
  afterAll(async () => { await resetAndSeed(prisma); await prisma.$disconnect(); });
  beforeEach(async () => { await resetAndSeed(prisma); });

  it('an agent proposes; the amendment records the old and new values, audits, emits and notifies the owner', async () => {
    const { admin, agent, work } = await fixture(prisma);

    const amendment = await proposeContractAmendment(prisma, {
      changes: { acceptance: '  research notes live in research/  ', scope: work.scope },
      reason: 'The contract predates the research-out-of-repo rule.',
      workId: work.id,
    }, asAgent(agent));

    expect(amendment.status).toBe('PENDING');
    // An unchanged field is dropped; values are trimmed like the form does.
    expect(amendmentChanges(amendment)).toEqual([
      { after: 'research notes live in research/', before: 'docs/research committed', field: 'acceptance' },
    ]);
    expect(amendment.baseRevision).toBe(work.revision);

    const audit = await prisma.workAudit.findFirstOrThrow({ where: { sourceMessageId: amendment.id } });
    expect(audit.actorId).toBe(agent.id);
    expect(audit.reason).toContain('research-out-of-repo');
    await expect(prisma.eventOutbox.count({ where: { type: 'contract.amendment_proposed' } })).resolves.toBe(1);
    const notification = await prisma.notification.findFirstOrThrow({ where: { type: 'contract.amendment_proposed' } });
    expect(notification.userId).toBe(admin.id);
    expect(notification.workId).toBe(work.id);

    // The contract itself is untouched until a person decides.
    const unchanged = await prisma.issue.findUniqueOrThrow({ where: { id: work.id } });
    expect(unchanged.acceptance).toBe('docs/research committed');
  });

  it('refuses people, non-contract fields, missing reasons, candidates, no-ops and empty acceptance', async () => {
    const { admin, agent, candidate, work } = await fixture(prisma);
    const propose = (changes: unknown, reason = 'why', workId = work.id, actor: WriteActor = asAgent(agent)) =>
      proposeContractAmendment(prisma, { changes, reason, workId }, actor);

    await expect(propose({ acceptance: 'x' }, 'why', work.id, asPerson(admin))).rejects.toThrow(CONTRACT_AMENDMENT_AGENTS_ONLY_MESSAGE);
    await expect(propose({ title: 'x' })).rejects.toThrow(CONTRACT_AMENDMENT_FIELDS_MESSAGE);
    await expect(propose({ acceptance: 42 })).rejects.toThrow(CONTRACT_AMENDMENT_FIELDS_MESSAGE);
    await expect(propose({})).rejects.toThrow(CONTRACT_AMENDMENT_FIELDS_MESSAGE);
    await expect(propose({ acceptance: 'x' }, '   ')).rejects.toThrow(CONTRACT_AMENDMENT_REASON_REQUIRED_MESSAGE);
    await expect(propose({ acceptance: '' })).rejects.toThrow(WORK_COMMIT_REQUIRES_ACCEPTANCE_MESSAGE);
    await expect(propose({ acceptance: 'docs/research committed ' })).rejects.toThrow(CONTRACT_AMENDMENT_NO_CHANGE_MESSAGE);
    await expect(propose({ acceptance: 'x' }, 'why', candidate.id)).rejects.toThrow(CONTRACT_AMENDMENT_REQUIRES_COMMITTED_MESSAGE);
    await expect(prisma.contractAmendment.count()).resolves.toBe(0);
  });

  it('a newer proposal supersedes the open one', async () => {
    const { agent, work } = await fixture(prisma);
    const first = await proposeContractAmendment(prisma, { changes: { acceptance: 'one' }, reason: 'r1', workId: work.id }, asAgent(agent));
    const second = await proposeContractAmendment(prisma, { changes: { acceptance: 'two' }, reason: 'r2', workId: work.id }, asAgent(agent));

    await expect(prisma.contractAmendment.findUniqueOrThrow({ where: { id: first.id } })).resolves.toMatchObject({ status: 'SUPERSEDED' });
    await expect(prisma.contractAmendment.count({ where: { status: 'PENDING', workId: work.id } })).resolves.toBe(1);
    expect(second.status).toBe('PENDING');
  });

  it('accepting applies the same fields, revision and audit as a manual edit by that person', async () => {
    const { admin, agent, work } = await fixture(prisma);
    const twin = await prisma.issue.create({ data: { ...committedData(work), identifier: 'INV-991', title: 'Twin' } });

    const amendment = await proposeContractAmendment(prisma, {
      changes: { acceptance: 'new acceptance', verification: null },
      reason: 'wrong rule',
      workId: work.id,
    }, asAgent(agent));
    const { amendment: decided, work: accepted } = await acceptContractAmendment(prisma, { amendmentId: amendment.id }, asPerson(admin));
    const manual = await updateIssue(prisma, twin.id, { acceptance: 'new acceptance', verification: null }, asPerson(admin));

    expect(decided).toMatchObject({ decidedById: admin.id, status: 'ACCEPTED' });
    for (const field of ['acceptance', 'constraints', 'outcome', 'scope', 'verification'] as const) {
      expect(accepted[field]).toBe(manual[field]);
    }
    expect(accepted.revision - work.revision).toBe(manual.revision - twin.revision);

    const [acceptAudit] = await prisma.workAudit.findMany({ where: { workId: work.id, actorId: admin.id } });
    const [manualAudit] = await prisma.workAudit.findMany({ where: { workId: twin.id, actorId: admin.id } });
    expect(acceptAudit!.actorKind).toBe('HUMAN');
    expect(acceptAudit!.revision).toBe(accepted.revision);
    expect((acceptAudit!.after as Record<string, unknown>).acceptance).toBe((manualAudit!.after as Record<string, unknown>).acceptance);
    expect(acceptAudit!.reason).toContain('contract amendment accepted: wrong rule');
    await expect(prisma.eventOutbox.count({ where: { type: 'contract.amendment_accepted' } })).resolves.toBe(1);
  });

  it('an unrelated update in between does not make it stale; a change to an amended field does', async () => {
    const { admin, agent, work } = await fixture(prisma);
    const review = await prisma.workflowState.findFirstOrThrow({ where: { name: 'In Review', teamId: work.teamId } });

    const amendment = await proposeContractAmendment(prisma, { changes: { acceptance: 'fixed' }, reason: 'r', workId: work.id }, asAgent(agent));
    // What usually happens next: the run is reported and the work moves to Review, bumping revision.
    await updateIssue(prisma, work.id, { stateId: review.id, description: 'progress' }, asAgent(agent));
    await expect(acceptContractAmendment(prisma, { amendmentId: amendment.id }, asPerson(admin))).resolves.toBeTruthy();

    const second = await proposeContractAmendment(prisma, { changes: { scope: 'narrower' }, reason: 'r', workId: work.id }, asAgent(agent));
    await updateIssue(prisma, work.id, { scope: 'a person changed it' }, asPerson(admin));
    await expect(acceptContractAmendment(prisma, { amendmentId: second.id }, asPerson(admin))).rejects.toThrow(CONTRACT_AMENDMENT_STALE_MESSAGE);
    const after = await prisma.issue.findUniqueOrThrow({ where: { id: work.id } });
    expect(after.scope).toBe('a person changed it');
    await expect(prisma.contractAmendment.findUniqueOrThrow({ where: { id: second.id } })).resolves.toMatchObject({ status: 'PENDING' });
  });

  it('only a person decides; rejecting needs a note and leaves the contract alone; a decision is final', async () => {
    const { admin, agent, work } = await fixture(prisma);
    const amendment = await proposeContractAmendment(prisma, { changes: { acceptance: 'x' }, reason: 'r', workId: work.id }, asAgent(agent));

    await expect(acceptContractAmendment(prisma, { amendmentId: amendment.id }, asAgent(agent))).rejects.toThrow(CONTRACT_AMENDMENT_HUMAN_ONLY_MESSAGE);
    await expect(rejectContractAmendment(prisma, { amendmentId: amendment.id, note: 'no' }, asAgent(agent))).rejects.toThrow(CONTRACT_AMENDMENT_HUMAN_ONLY_MESSAGE);
    await expect(rejectContractAmendment(prisma, { amendmentId: amendment.id, note: ' ' }, asPerson(admin))).rejects.toThrow(CONTRACT_AMENDMENT_REJECT_NOTE_REQUIRED_MESSAGE);

    const { amendment: rejected } = await rejectContractAmendment(prisma, { amendmentId: amendment.id, note: 'the rule still holds' }, asPerson(admin));
    expect(rejected).toMatchObject({ decisionNote: 'the rule still holds', status: 'REJECTED' });
    await expect(prisma.issue.findUniqueOrThrow({ where: { id: work.id } })).resolves.toMatchObject({ acceptance: 'docs/research committed' });
    await expect(prisma.eventOutbox.count({ where: { type: 'contract.amendment_rejected' } })).resolves.toBe(1);

    await expect(acceptContractAmendment(prisma, { amendmentId: amendment.id }, asPerson(admin))).rejects.toThrow(CONTRACT_AMENDMENT_ALREADY_DECIDED_MESSAGE);
  });

  it('two people accepting at once: one wins, the contract is written once', async () => {
    const { admin, agent, work } = await fixture(prisma);
    const other = await prisma.user.create({ data: { actorKind: 'HUMAN', email: 'bo@example.test', name: 'Bo' } });
    const amendment = await proposeContractAmendment(prisma, { changes: { acceptance: 'once' }, reason: 'r', workId: work.id }, asAgent(agent));

    const results = await Promise.allSettled([
      acceptContractAmendment(prisma, { amendmentId: amendment.id }, asPerson(admin)),
      acceptContractAmendment(prisma, { amendmentId: amendment.id }, asPerson(other)),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const after = await prisma.issue.findUniqueOrThrow({ where: { id: work.id } });
    expect(after.revision).toBe(work.revision + 1);
  });

  it('the guard still refuses a direct rewrite and points agents at the amendment tool', async () => {
    const { agent, work } = await fixture(prisma);
    await expect(updateIssue(prisma, work.id, { acceptance: 'agent rewrote it' }, asAgent(agent)))
      .rejects.toThrow(/Agents cannot rewrite committed contract fields\. Propose the change with work_propose_amendment/);
  });
});

describe('contract amendments end to end: MCP proposal, GraphQL decision (INV-869)', () => {
  beforeEach(async () => { await resetAndSeed(prisma); });

  it('an agent proposes through MCP; the owner sees it on the issue and accepts; the agent reads the outcome', async () => {
    const { callMcpTool } = await import('./mcp-tools.ts');
    const { startServer } = await import('./index.ts');
    const { SESSION_COOKIE_NAME, createSession } = await import('./session.ts');
    const { admin, agent, work } = await fixture(prisma);
    await prisma.teamMembership.create({ data: { role: 'EDITOR', teamId: work.teamId, userId: agent.id } });
    const agentContext = (scopes: string[]) => ({
      agentScopes: scopes,
      agentTeamId: work.teamId,
      authMode: 'agent-token' as const,
      isTrustedSystem: false,
      prisma,
      viewer: agent,
    });

    await expect(callMcpTool(agentContext(['read', 'update']), 'work_propose_amendment',
      { id: work.identifier, changes: { acceptance: 'x' }, reason: 'r' }, false)).rejects.toThrow();
    const proposed = (await callMcpTool(agentContext(['read', 'propose']), 'work_propose_amendment', {
      id: work.identifier,
      changes: { acceptance: 'notes in research/, pointer file present' },
      reason: 'INV-831 moved research out of the repo after this contract was written.',
    }, false)) as { amendment_id: string; changes: unknown[]; status: string };
    expect(proposed.status).toBe('PENDING');
    expect(proposed.changes).toHaveLength(1);

    const server = await startServer({ allowAdminFallback: true, authToken: 'test-auth-token', port: 0, prisma });
    try {
      const gql = async (userId: string, query: string, variables: unknown) => {
        const cookie = `${SESSION_COOKIE_NAME}=${(await createSession(prisma, userId)).token}`;
        const response = await fetch(`${server.url}/graphql`, {
          method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ query, variables }),
        });
        return response.json() as Promise<{ data?: any; errors?: Array<{ message: string }> }>;
      };

      const page = await gql(admin.id, 'query($id: String!) { issue(id: $id) { pendingContractAmendment { id stale proposedByClaimant changes { field before after } proposedBy { id } } } }', { id: work.id });
      expect(page.errors).toBeUndefined();
      expect(page.data.issue.pendingContractAmendment).toMatchObject({
        changes: [{ after: 'notes in research/, pointer file present', before: 'docs/research committed', field: 'acceptance' }],
        id: proposed.amendment_id,
        proposedBy: { id: agent.id },
        proposedByClaimant: false,
        stale: false,
      });

      const mutation = 'mutation($i: ContractAmendmentAcceptInput!) { contractAmendmentAccept(input: $i) { success message issue { acceptance } } }';
      const byAgent = await gql(agent.id, mutation, { i: { amendmentId: proposed.amendment_id } });
      expect(byAgent.data?.contractAmendmentAccept?.success ?? false).toBe(false);
      const accepted = await gql(admin.id, mutation, { i: { amendmentId: proposed.amendment_id, note: 'right' } });
      expect(accepted.data.contractAmendmentAccept).toMatchObject({
        issue: { acceptance: 'notes in research/, pointer file present' },
        message: null,
        success: true,
      });

      const context = (await callMcpTool(agentContext(['read']), 'work_get_context', { id: work.identifier }, false)) as {
        contractAmendments: Array<{ decisionNote: string | null; status: string }>;
      };
      expect(context.contractAmendments[0]).toMatchObject({ decisionNote: 'right', status: 'ACCEPTED' });
    } finally {
      await server.stop();
    }
  });
});

function asAgent(agent: User) {
  return { actorId: agent.id, actorKind: 'AGENT' as const, surface: 'test' };
}

function asPerson(person: User) {
  return { actorId: person.id, actorKind: 'HUMAN' as const, surface: 'test' };
}

function committedData(work: Issue) {
  return {
    acceptance: work.acceptance,
    assigneeId: work.assigneeId,
    commitmentStatus: 'COMMITTED' as const,
    scope: work.scope,
    stateId: work.stateId,
    teamId: work.teamId,
    verification: work.verification,
  };
}

async function fixture(client: PrismaClient): Promise<{ admin: User; agent: User; candidate: Issue; work: Issue }> {
  const admin = await client.user.findFirstOrThrow({ where: { actorKind: 'HUMAN', globalRole: 'ADMIN' } });
  const team = await client.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
  const state = await client.workflowState.findFirstOrThrow({ where: { name: 'In Progress', teamId: team.id } });
  const agent = await client.user.create({ data: { actorKind: 'AGENT', email: 'mia@agents.test.local', handle: 'mia', name: 'Mia', ownerId: admin.id } });
  const work = await client.issue.create({
    data: {
      acceptance: 'docs/research committed',
      assigneeId: admin.id,
      commitmentStatus: 'COMMITTED',
      identifier: 'INV-990',
      scope: 'read-only research',
      stateId: state.id,
      teamId: team.id,
      title: 'Research with an outdated contract',
      verification: 'docs-lint exits 0',
    },
  });
  const candidate = await client.issue.create({
    data: { acceptance: 'a', commitmentStatus: 'CANDIDATE', identifier: 'INV-992', stateId: state.id, teamId: team.id, title: 'Candidate' },
  });
  return { admin, agent, candidate, work };
}
