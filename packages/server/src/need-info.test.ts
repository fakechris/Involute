import { PrismaClient } from '@prisma/client';
import type { Issue, Team, User } from '@prisma/client';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ADMIN_EMAIL, DEFAULT_TEAM_KEY, resetAndSeed } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import { answerAgentRequestAsHuman, claimAgentRequest, answerAgentRequest, readAgentInbox } from './agent-request-service.ts';
import { expireOverdueAgentRequests } from './agent-request-expiry.ts';
import { loadAttention } from './attention-service.ts';
import { reportBug } from './bug-report.ts';
import { computeBugSla, loadBugSlas } from './bug-sla.ts';
import { startServer, type StartedServer } from './index.ts';
import { createComment, createIssue } from './issue-service.ts';
import { NEEDINFO_DEADLINE_MS, requestNeedInfo, withdrawNeedInfo } from './need-info-service.ts';

loadProjectEnvironment();
const prisma = new PrismaClient();
const HOUR = 3_600_000;

describe('needinfo (INV-1119)', () => {
  let team: Team;
  let admin: User;
  let reporter: User;
  let agent: User;
  let projectId: string;

  const as = (user: User) => ({ actorId: user.id, actorKind: user.actorKind, globalRole: user.globalRole });

  beforeEach(async () => {
    await resetAndSeed(prisma);
    team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
    admin = await prisma.user.findUniqueOrThrow({ where: { email: DEFAULT_ADMIN_EMAIL } });
    reporter = await prisma.user.create({ data: { actorKind: 'HUMAN', email: 'rita@example.com', name: 'Rita' } });
    await prisma.teamMembership.create({ data: { role: 'EDITOR', teamId: team.id, userId: reporter.id } });
    agent = await prisma.user.create({ data: { actorKind: 'AGENT', email: 'fixer@agents.test.local', handle: 'fixer', name: 'Fixer', ownerId: admin.id } });
    await prisma.agentCredential.create({ data: { name: 'fixer', teamId: team.id, tokenHash: 'needinfo-test-hash', userId: agent.id } });
    projectId = (await createIssue(prisma, { teamId: team.id, kind: 'PROJECT', title: 'acme/app', repository: 'acme/app' })).id;
  });

  afterAll(async () => {
    await resetAndSeed(prisma);
    await prisma.$disconnect();
  });

  async function bugByReporter(): Promise<Issue> {
    return reportBug(prisma, { teamId: team.id, title: 'Crash on save', priority: 1, stepsToReproduce: 'Save twice', parentId: projectId }, { actorId: reporter.id, actorKind: 'HUMAN', surface: 'graphql' });
  }

  it('lets an agent ask a person: it waits in their Needs you, and their comment answers it and tells the agent', async () => {
    const bug = await bugByReporter();
    const { request, comment } = await requestNeedInfo(prisma, { by: as(agent), question: 'Which browser?', target: reporter.email, workId: bug.id });
    expect(request).toMatchObject({ needInfo: true, state: 'SUBMITTED', targetActorId: reporter.id, rootCommentId: comment.id });
    expect(comment).toMatchObject({ userId: agent.id, issueId: bug.id });
    expect(comment.body).toContain('Which browser?');
    expect(await prisma.notification.count({ where: { type: 'needinfo.requested', userId: reporter.id, workId: bug.id } })).toBe(1);

    const queue = await loadAttention(prisma, reporter, undefined, { kinds: ['AGENT_REQUEST'] });
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ subjectId: request.id, actions: ['ANSWER'] });
    expect(queue[0]!.reason).toContain('Fixer needs information from you: Which browser?');

    // An ordinary comment by the target, not a reply through the answer form, clears it.
    const answer = await createComment(prisma, { body: 'Firefox 131.', issueId: bug.id }, reporter.id);
    expect(await prisma.agentRequest.findUniqueOrThrow({ where: { id: request.id } })).toMatchObject({ state: 'COMPLETED', answeredCommentId: answer.id });
    expect(await loadAttention(prisma, reporter, undefined, { kinds: ['AGENT_REQUEST'] })).toHaveLength(0);
    expect(await prisma.notification.findFirstOrThrow({ where: { type: 'needinfo.requested', userId: reporter.id } })).toMatchObject({ resolution: 'answered' });
    expect(await prisma.notification.count({ where: { type: 'needinfo.answered', userId: agent.id, workId: bug.id } })).toBe(1);
    expect(await prisma.eventOutbox.count({ where: { type: 'needinfo.answered' } })).toBe(1);
  });

  it('lets a person ask an agent, which sees it in agent_inbox and answers through agent_request', async () => {
    const bug = await bugByReporter();
    const { request } = await requestNeedInfo(prisma, { by: as(reporter), question: 'Is this a regression?', target: '@fixer', workId: bug.id });
    const inbox = await readAgentInbox(prisma, { actorId: agent.id });
    expect(inbox.items).toEqual([expect.objectContaining({ id: request.id, needInfo: true })]);
    // The notification row is what wakes the agent's push channel (INV-992).
    expect(await prisma.notification.count({ where: { type: 'needinfo.requested', userId: agent.id } })).toBe(1);

    const held = await claimAgentRequest(prisma, { actorId: agent.id, id: request.id });
    await answerAgentRequest(prisma, { actorId: agent.id, body: 'Yes, since 1.4.', claimToken: held.claimToken, id: request.id });
    expect((await prisma.agentRequest.findUniqueOrThrow({ where: { id: request.id } })).state).toBe('COMPLETED');
    expect(await prisma.notification.count({ where: { type: 'needinfo.answered', userId: reporter.id } })).toBe(1);
  });

  it('is answered through the answer form too, and resolves the notification', async () => {
    const bug = await bugByReporter();
    const { request } = await requestNeedInfo(prisma, { by: as(admin), question: 'Repro on staging?', target: reporter.id, workId: bug.id });
    await answerAgentRequestAsHuman(prisma, { body: 'Yes.', by: as(reporter), id: request.id });
    expect(await prisma.notification.findFirstOrThrow({ where: { type: 'needinfo.requested', userId: reporter.id } })).toMatchObject({ resolution: 'answered' });
    expect(await prisma.notification.count({ where: { type: 'needinfo.answered', userId: admin.id } })).toBe(1);
  });

  it('refuses what could never be answered, and a second open needinfo to the same person', async () => {
    const bug = await bugByReporter();
    const outsider = await prisma.user.create({ data: { actorKind: 'HUMAN', email: 'out@example.com', name: 'Out' } });
    const other = await prisma.user.create({ data: { actorKind: 'AGENT', email: 'other@agents.test.local', handle: 'other', name: 'Other' } });
    await prisma.agentCredential.create({ data: { name: 'other', teamId: team.id, tokenHash: 'needinfo-test-hash-2', userId: other.id } });
    const ask = (by: User, target: string, question = 'Q?') => requestNeedInfo(prisma, { by: as(by), question, target, workId: bug.id });

    await expect(ask(admin, reporter.id, '  ')).rejects.toThrow(/needs a question/);
    await expect(ask(admin, 'nobody-here')).rejects.toThrow(/No active person or agent/);
    await expect(ask(admin, admin.id)).rejects.toThrow(/to yourself/);
    await expect(ask(admin, outsider.id)).rejects.toThrow(/cannot write on this team/);
    await expect(ask(agent, '@other')).rejects.toThrow(/One agent cannot raise a needinfo to another/);
    await ask(admin, reporter.id);
    await expect(ask(agent, reporter.id)).rejects.toThrow(/already an open needinfo/);
  });

  it('is withdrawn by whoever raised it, or by an admin with a reason', async () => {
    const bug = await bugByReporter();
    const { request } = await requestNeedInfo(prisma, { by: as(agent), question: 'Logs?', target: reporter.id, workId: bug.id });
    await expect(withdrawNeedInfo(prisma, { by: as(reporter), id: request.id })).rejects.toThrow(/Only whoever raised this needinfo/);
    await expect(withdrawNeedInfo(prisma, { by: as(admin), id: request.id })).rejects.toThrow(/requires a reason/);
    const withdrawn = await withdrawNeedInfo(prisma, { by: as(agent), id: request.id, reason: 'Found them myself' });
    expect(withdrawn).toMatchObject({ state: 'CANCELED' });
    expect(await loadAttention(prisma, reporter, undefined, { kinds: ['AGENT_REQUEST'] })).toHaveLength(0);
    expect(await prisma.notification.findFirstOrThrow({ where: { type: 'needinfo.requested' } })).toMatchObject({ resolution: 'withdrawn' });
    await expect(withdrawNeedInfo(prisma, { by: as(agent), id: request.id })).rejects.toThrow(/already answered, withdrawn or expired/);
  });

  it('lapses at its deadline without being handed to someone else', async () => {
    const bug = await bugByReporter();
    const { request } = await requestNeedInfo(prisma, { by: as(agent), question: 'Still happening?', target: reporter.id, workId: bug.id });
    expect(await expireOverdueAgentRequests(prisma, new Date(Date.now() + NEEDINFO_DEADLINE_MS + HOUR))).toBe(1);
    expect((await prisma.agentRequest.findUniqueOrThrow({ where: { id: request.id } })).state).toBe('FAILED');
    expect(await prisma.agentRequest.count()).toBe(1);
    expect(await prisma.notification.findFirstOrThrow({ where: { type: 'needinfo.requested' } })).toMatchObject({ resolution: 'expired' });
  });

  it('pauses the bug SLA while it waits on the reporter, and resumes it once answered', async () => {
    const bug = await bugByReporter();
    const start = Date.now();
    const before = (await loadBugSlas(prisma, [bug.id], new Date(start + HOUR)))
      .get(bug.id)!;
    expect(before.status).toBe('ON_TRACK');

    const { request } = await requestNeedInfo(prisma, { by: as(agent), question: 'Which file?', target: reporter.id, workId: bug.id });
    const waiting = (await loadBugSlas(prisma, [bug.id], new Date(start + 30 * HOUR))).get(bug.id)!;
    // 30h on an Urgent (24h) bug would be breached; waiting on the reporter it is paused.
    expect(waiting).toMatchObject({ status: 'PAUSED', dueAt: null });
    expect(waiting.elapsedMs).toBeLessThan(HOUR);

    // A needinfo to someone other than the reporter does not stop the clock.
    await requestNeedInfo(prisma, { by: as(reporter), question: 'Can you take it?', target: '@fixer', workId: bug.id });
    await createComment(prisma, { body: 'report.txt', issueId: bug.id }, reporter.id);
    expect((await prisma.agentRequest.findUniqueOrThrow({ where: { id: request.id } })).state).toBe('COMPLETED');
    const resumed = (await loadBugSlas(prisma, [bug.id], new Date(Date.now() + 2 * HOUR))).get(bug.id)!;
    expect(resumed.status).toBe('ON_TRACK');
    expect(resumed.dueAt).not.toBeNull();
  });

  it('subtracts overlapping waits once and leaves breached bugs breached', () => {
    const at = (hours: number) => new Date(Date.UTC(2026, 8, 1) + hours * HOUR);
    const timeline = { committedAt: at(0), transitions: [{ at: at(0), stateId: 's', stateName: 'Ready', stateType: 'UNSTARTED' as const }] };
    const input = { priority: 1, createdAt: at(0), stateType: 'UNSTARTED' as const };
    const closed = computeBugSla(timeline, input, at(20), [{ from: at(2), to: at(8) }, { from: at(5), to: at(10) }]);
    expect(closed).toMatchObject({ status: 'ON_TRACK', elapsedMs: 12 * HOUR });
    expect(computeBugSla(timeline, input, at(40), [{ from: at(30), to: null }])).toMatchObject({ status: 'BREACHED', elapsedMs: 30 * HOUR });
  });
});

describe('mentioning a person (INV-1119)', () => {
  let team: Team;
  let admin: User;
  let issue: Issue;

  beforeEach(async () => {
    await resetAndSeed(prisma);
    team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
    admin = await prisma.user.findUniqueOrThrow({ where: { email: DEFAULT_ADMIN_EMAIL } });
    issue = await createIssue(prisma, { teamId: team.id, kind: 'PROJECT', title: 'acme/app', repository: 'acme/app' });
  });

  it('notifies the person by handle or email name, never the author, and opens no request', async () => {
    const dana = await prisma.user.create({ data: { actorKind: 'HUMAN', email: 'dana@example.com', handle: 'dana', name: 'Dana' } });
    const rita = await prisma.user.create({ data: { actorKind: 'HUMAN', email: 'rita@example.com', name: 'Rita' } });
    const comment = await createComment(prisma, { body: '@dana @rita please look; `@nobody` in code', issueId: issue.id }, admin.id);
    const rows = await prisma.notification.findMany({ where: { type: 'comment.mentioned' }, orderBy: { userId: 'asc' } });
    expect(rows.map((row) => row.userId).sort()).toEqual([dana.id, rita.id].sort());
    expect(rows[0]).toMatchObject({ workId: issue.id, payload: expect.objectContaining({ commentId: comment.id, authorId: admin.id }) });
    expect(await prisma.agentRequest.count()).toBe(0);

    await createComment(prisma, { body: 'note to self @dana', issueId: issue.id }, dana.id);
    expect(await prisma.notification.count({ where: { type: 'comment.mentioned', userId: dana.id } })).toBe(1);
  });

  it('resolves nobody when an email name is ambiguous or an agent holds the handle', async () => {
    await prisma.user.create({ data: { actorKind: 'HUMAN', email: 'sam@a.example', name: 'Sam A' } });
    await prisma.user.create({ data: { actorKind: 'HUMAN', email: 'sam@b.example', name: 'Sam B' } });
    await prisma.user.create({ data: { actorKind: 'HUMAN', email: 'mia@example.com', name: 'Mia Human' } });
    await prisma.user.create({ data: { actorKind: 'AGENT', email: 'mia@agents.test.local', handle: 'mia', name: 'Mia' } });
    await createComment(prisma, { body: '@sam @mia hello', issueId: issue.id }, admin.id);
    expect(await prisma.notification.count({ where: { type: 'comment.mentioned' } })).toBe(0);
  });
});

describe('needinfo through MCP and GraphQL (INV-1119)', () => {
  const TOKEN = 'needinfo-test-token';
  let server: StartedServer;
  let reporter: User;
  let issue: Issue;

  beforeEach(async () => {
    await resetAndSeed(prisma);
    const team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
    reporter = await prisma.user.create({ data: { actorKind: 'HUMAN', email: 'rita@example.com', name: 'Rita' } });
    await prisma.teamMembership.create({ data: { role: 'EDITOR', teamId: team.id, userId: reporter.id } });
    issue = await createIssue(prisma, { teamId: team.id, kind: 'PROJECT', title: 'acme/app', repository: 'acme/app' });
    server = await startServer({ allowAdminFallback: true, authToken: TOKEN, port: 0, prisma });
  });

  afterEach(async () => {
    await server.stop();
  });

  async function post(path: string, body: unknown): Promise<any> {
    const response = await fetch(`${server.url}${path}`, {
      method: 'POST',
      headers: { accept: 'application/json', authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return response.json();
  }

  it('raises with agent_request(action: needinfo) and withdraws with needInfoWithdraw', async () => {
    const rpc = await post('/mcp', {
      id: 1,
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'agent_request', arguments: { action: 'needinfo', question: 'Which version?', target_id: 'rita@example.com', work_id: issue.identifier } },
    });
    const raised = JSON.parse(rpc.result.content[0].text);
    expect(raised).toMatchObject({ state: 'submitted', target_actor_id: reporter.id, work_id: issue.id });

    const refused = await post('/graphql', {
      query: 'mutation($input: NeedInfoRequestInput!) { needInfoRequest(input: $input) { success message } }',
      variables: { input: { question: 'Again?', targetId: reporter.id, workId: issue.id } },
    });
    expect(refused.errors).toBeUndefined();
    expect(refused.data.needInfoRequest).toMatchObject({ success: false, message: expect.stringMatching(/already an open needinfo/) });

    const withdrawn = await post('/graphql', {
      query: 'mutation($id: String!) { needInfoWithdraw(requestId: $id) { success message request { state needInfo } } }',
      variables: { id: raised.id },
    });
    expect(withdrawn.data.needInfoWithdraw).toMatchObject({ success: true, message: null, request: { state: 'canceled', needInfo: true } });
  });

  it('says why the answer form refused, instead of "Unexpected error."', async () => {
    const admin = await prisma.user.findUniqueOrThrow({ where: { email: DEFAULT_ADMIN_EMAIL } });
    const { request } = await requestNeedInfo(prisma, { by: { actorId: admin.id, actorKind: 'HUMAN', globalRole: 'ADMIN' }, question: 'Q?', target: reporter.id, workId: issue.id });
    const refused = await post('/graphql', {
      query: 'mutation($input: AgentRequestAnswerInput!) { agentRequestAnswer(input: $input) { success message } }',
      variables: { input: { body: 'For her', requestId: request.id } },
    });
    expect(refused.errors).toBeUndefined();
    expect(refused.data.agentRequestAnswer).toMatchObject({ success: false, message: expect.stringMatching(/requires an override reason/) });
  });
});
