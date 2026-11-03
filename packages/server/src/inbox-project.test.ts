import type { PrismaClient, Team, User } from '@prisma/client';
import { PrismaClient as PrismaClientConstructor } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ADMIN_EMAIL, DEFAULT_TEAM_KEY, resetAndSeed } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import { hashAgentToken } from './agent-credentials.ts';
import { inboxProjectUnknownMessage } from './inbox-project.ts';
import { startServer, type StartedServer } from './index.ts';
import { createIssue } from './issue-service.ts';
import { testParentId } from './test-placement.ts';
import { writeActorFromViewer } from './work-service.ts';

// INV-1545: one agent identity works in several projects; each session reads
// and clears its own project's notifications.
loadProjectEnvironment();
const prisma: PrismaClient = new PrismaClientConstructor();
const AGENT_TOKEN = 'inv_agent_inbox_project_test';

describe('agent_inbox by project (INV-1545)', () => {
  let team: Team;
  let human: User;
  let agent: User;
  let server: StartedServer;
  let alpha: { id: string; identifier: string };
  let beta: { id: string; identifier: string };

  beforeAll(async () => { await prisma.$connect(); });
  afterAll(async () => { await resetAndSeed(prisma); await prisma.$disconnect(); });
  beforeEach(async () => {
    await resetAndSeed(prisma);
    team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
    human = await prisma.user.findUniqueOrThrow({ where: { email: DEFAULT_ADMIN_EMAIL } });
    agent = await prisma.user.create({ data: { name: 'Shared', email: 'shared@agents.local', actorKind: 'AGENT', ownerId: human.id } });
    await prisma.teamMembership.create({ data: { role: 'EDITOR', teamId: team.id, userId: agent.id } });
    await prisma.agentCredential.create({ data: { name: 'shared', scopes: ['read', 'propose', 'update', 'claim', 'report'], tokenHash: hashAgentToken(AGENT_TOKEN), teamId: team.id, userId: agent.id } });
    const actor = writeActorFromViewer(human, 'test');
    const alphaParent = await testParentId(prisma, team.id, 'acme/alpha');
    const betaParent = await testParentId(prisma, team.id, 'acme/beta');
    await prisma.issue.updateMany({ where: { kind: 'PROJECT', repository: 'acme/beta' }, data: { alias: 'BETA' } });
    alpha = await createIssue(prisma, { teamId: team.id, title: 'Alpha work', parentId: alphaParent, repository: 'acme/alpha', commitmentStatus: 'COMMITTED' }, actor);
    beta = await createIssue(prisma, { teamId: team.id, title: 'Beta work', parentId: betaParent, repository: 'acme/beta', commitmentStatus: 'COMMITTED' }, actor);
    for (const work of [alpha, alpha, beta]) {
      await prisma.notification.create({ data: { userId: agent.id, teamId: team.id, type: 'work.committed', workId: work.id } });
    }
    server = await startServer({ allowAdminFallback: true, prisma, authToken: 'unused-static-token', port: 0 });
  });
  afterEach(async () => { await server.stop(); });

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

  const identifiers = (inbox: { notifications: Array<{ work_identifier: string }> }) => inbox.notifications.map((row) => row.work_identifier).sort();

  it('returns only the named project, by repository or alias, and keeps everything without a filter', async () => {
    expect(identifiers(await callTool('agent_inbox', {}))).toEqual([alpha.identifier, alpha.identifier, beta.identifier].sort());
    expect(identifiers(await callTool('agent_inbox', { repository: 'acme/alpha' }))).toEqual([alpha.identifier, alpha.identifier]);
    expect(identifiers(await callTool('agent_inbox', { repository: 'beta' }))).toEqual([beta.identifier]);
    expect((await callTool('agent_inbox', { repository: 'NOPE' })).error).toContain(inboxProjectUnknownMessage('NOPE'));
  });

  it('acks one project without touching the other', async () => {
    const mine = await callTool('agent_inbox', { repository: 'acme/alpha' });
    const after = await callTool('agent_inbox', { repository: 'acme/alpha', ack: mine.notifications.map((row: { id: string }) => row.id) });
    expect(after.notifications).toEqual([]);
    expect(identifiers(await callTool('agent_inbox', { repository: 'acme/beta' }))).toEqual([beta.identifier]);
  });

  it('reminds a call about one project of that project, with the total beside it', async () => {
    const result = await callTool('work_get_context', { id: beta.identifier, section: 'comments' });
    expect(result.unread_decisions).toMatchObject({ count: 1, repository: 'acme/beta', total: 3 });
    expect(result.unread_decisions.latest.map((row: { identifier: string }) => row.identifier)).toEqual([beta.identifier]);

    // A call that names no work keeps the whole count.
    const plain = await callTool('protocol_get_guide', {});
    expect(plain.unread_decisions).toMatchObject({ count: 3 });
    expect(plain.unread_decisions.total).toBeUndefined();
  });
});
