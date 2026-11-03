import type { PrismaClient, Team, User } from '@prisma/client';
import { PrismaClient as PrismaClientConstructor } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ADMIN_EMAIL, DEFAULT_TEAM_KEY, resetAndSeed } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import { hashAgentToken } from './agent-credentials.ts';
import { startServer, type StartedServer } from './index.ts';
import { createIssue } from './issue-service.ts';
import {
  RUN_FOLLOWUPS_BOTH_MESSAGE,
  RUN_FOLLOWUPS_MISSING_MESSAGE,
  RUN_FOLLOWUPS_NOT_COMPLETED_MESSAGE,
  RUN_FOLLOWUPS_REASON_BLANK_MESSAGE,
  RUN_FOLLOWUPS_SELF_MESSAGE,
  RUN_FOLLOWUPS_WARNING,
  runFollowupsUnreadableMessage,
  setFollowupsRequiredFromForTests,
} from './run-followups.ts';
import { createSession } from './session.js';
import { createTeamWithDefaultStates } from './team-lifecycle.ts';
import { testParentId } from './test-placement.ts';
import { writeActorFromViewer } from './work-service.ts';

// INV-1231: a completed run says what it leaves behind.
loadProjectEnvironment();
const prisma: PrismaClient = new PrismaClientConstructor();
const AGENT_TOKEN = 'inv_agent_run_followups_test';

describe('run followups (INV-1231)', () => {
  let team: Team;
  let human: User;
  let parentId: string;
  let server: StartedServer;

  beforeAll(async () => { await prisma.$connect(); });
  afterAll(async () => { await resetAndSeed(prisma); await prisma.$disconnect(); });
  beforeEach(async () => {
    await resetAndSeed(prisma);
    team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
    human = await prisma.user.findUniqueOrThrow({ where: { email: DEFAULT_ADMIN_EMAIL } });
    await prisma.teamMembership.upsert({ where: { teamId_userId: { teamId: team.id, userId: human.id } }, update: {}, create: { role: 'OWNER', teamId: team.id, userId: human.id } });
    const agent = await prisma.user.create({ data: { name: 'Runner', email: 'runner@agents.local', actorKind: 'AGENT', ownerId: human.id } });
    await prisma.teamMembership.create({ data: { role: 'EDITOR', teamId: team.id, userId: agent.id } });
    await prisma.agentCredential.create({ data: { name: 'runner', scopes: ['read', 'propose', 'update', 'claim', 'report'], tokenHash: hashAgentToken(AGENT_TOKEN), teamId: team.id, userId: agent.id } });
    parentId = await testParentId(prisma, team.id, 'fakechris/Involute');
    server = await startServer({ allowAdminFallback: true, prisma, authToken: 'unused-static-token', port: 0 });
  });
  afterEach(async () => {
    setFollowupsRequiredFromForTests(null);
    await server.stop();
  });

  async function callTool(name: string, args: Record<string, unknown>) {
    const response = await fetch(`${server.url}/mcp`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${AGENT_TOKEN}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    const body = await response.json() as { error?: { message: string }; result?: { isError?: boolean; content: Array<{ text: string }> } };
    if (body.error) return { error: body.error.message };
    const text = body.result!.content[0]!.text;
    return body.result!.isError ? { error: text } : JSON.parse(text);
  }

  async function work(title: string, teamId = team.id, parent = parentId) {
    const ready = await prisma.workflowState.findFirstOrThrow({ where: { teamId, type: 'UNSTARTED' } });
    return createIssue(prisma, { teamId, title, parentId: parent, repository: 'fakechris/Involute', acceptance: 'done', commitmentStatus: 'COMMITTED', stateId: ready.id, assigneeId: human.id }, writeActorFromViewer(human, 'test'));
  }

  async function claimed(title = 'Main work') {
    const item = await work(title);
    const claim = await callTool('work_claim', { id: item.identifier });
    if (!claim.claim_token) throw new Error(`claim failed: ${JSON.stringify(claim)}`);
    return { item, token: claim.claim_token as string };
  }

  const complete = (identifier: string, token: string, extra: Record<string, unknown> = {}) =>
    callTool('run_report', { work_id: identifier, claim_token: token, status: 'completed', summary: 'Done', ...extra });

  it('links the work a run led to, freezes it on the run, and does not link twice', async () => {
    const { item, token } = await claimed();
    const followup = await work('Left over');
    // Already linked before the run says so: kept as one link.
    await prisma.workLink.create({ data: { fromId: followup.id, toId: item.id, type: 'DISCOVERED_DURING' } });

    const result = await complete(item.identifier, token, { followups: { work_ids: [followup.identifier.toLowerCase(), followup.id] } });
    expect(result.error).toBeUndefined();
    expect(result.warning).toBeUndefined();
    expect(result.run.followups).toEqual({ workIds: [followup.id], identifiers: [followup.identifier] });
    expect(await prisma.workLink.count({ where: { fromId: followup.id, toId: item.id, type: 'DISCOVERED_DURING' } })).toBe(1);

    // The reviewer sees it with the run.
    const runs = await callTool('work_get_context', { id: item.identifier, section: 'runs' });
    expect(JSON.stringify(runs)).toContain(followup.identifier);
    const session = await createSession(prisma, human.id, 3600);
    const response = await fetch(`${server.url}/graphql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `involute_session=${session.token}` },
      body: JSON.stringify({ query: `query($id: String!) { workContext(id: $id) { runs { status followups { identifiers noneReason } } } }`, variables: { id: item.id } }),
    });
    const body = await response.json() as { data?: { workContext: { runs: Array<{ status: string; followups: unknown }> } }; errors?: unknown };
    expect(body.errors).toBeUndefined();
    expect(body.data!.workContext.runs[0]).toEqual({ status: 'COMPLETED', followups: { identifiers: [followup.identifier], noneReason: null } });
  });

  it('takes a reason when nothing is left, and refuses a blank one', async () => {
    const { item, token } = await claimed();
    expect((await complete(item.identifier, token, { followups: { none_reason: '   ' } })).error).toContain(RUN_FOLLOWUPS_REASON_BLANK_MESSAGE);
    const result = await complete(item.identifier, token, { followups: { none_reason: ' Nothing else came up. ' } });
    expect(result.run.followups).toEqual({ noneReason: 'Nothing else came up.' });
  });

  it('refuses both answers at once, the work itself, and names a follow-up it cannot read', async () => {
    const { item, token } = await claimed();
    const other = await work('Other');
    expect((await complete(item.identifier, token, { followups: { work_ids: [other.identifier], none_reason: 'none' } })).error).toContain(RUN_FOLLOWUPS_BOTH_MESSAGE);
    expect((await complete(item.identifier, token, { followups: { work_ids: [item.identifier] } })).error).toContain(RUN_FOLLOWUPS_SELF_MESSAGE);
    expect((await complete(item.identifier, token, { followups: { work_ids: [other.identifier, 'INV-999999'] } })).error).toContain(runFollowupsUnreadableMessage('INV-999999'));

    const hiddenTeam = await createTeamWithDefaultStates(prisma, { key: 'HID', name: 'Hidden' });
    const hiddenParent = await testParentId(prisma, hiddenTeam.id, 'fakechris/Involute');
    const hidden = await work('Hidden', hiddenTeam.id, hiddenParent);
    expect((await complete(item.identifier, token, { followups: { work_ids: [hidden.identifier] } })).error).toContain(runFollowupsUnreadableMessage(hidden.identifier));
    // Nothing was written by the refusals.
    expect(await prisma.workRun.count({ where: { workId: item.id, status: 'COMPLETED' } })).toBe(0);
  });

  it('gives followups only with a completed run', async () => {
    const { item, token } = await claimed();
    const result = await callTool('run_report', { work_id: item.identifier, claim_token: token, status: 'running', followups: { none_reason: 'early' } });
    expect(result.error).toContain(RUN_FOLLOWUPS_NOT_COMPLETED_MESSAGE);
  });

  it('warns a completed run without followups during the transition, and refuses it after', async () => {
    const first = await claimed('First');
    const warned = await complete(first.item.identifier, first.token);
    expect(warned.error).toBeUndefined();
    expect(warned.warning).toContain(RUN_FOLLOWUPS_WARNING);
    expect(warned.run.status).toBe('COMPLETED');

    setFollowupsRequiredFromForTests(new Date(Date.now() - 1000));
    const second = await claimed('Second');
    const refused = await complete(second.item.identifier, second.token);
    expect(refused.error).toContain(RUN_FOLLOWUPS_MISSING_MESSAGE);
  });
});
