import type { PrismaClient, Team, User } from '@prisma/client';

import { PrismaClient as PrismaClientConstructor } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ADMIN_EMAIL, DEFAULT_TEAM_KEY, seedDatabase } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import { startServer, type StartedServer } from './index.ts';
import { hashAgentToken } from './agent-credentials.ts';
import { createSession } from './session.js';
import { testParentId } from './test-placement.ts';
import { isIncidentWork } from './labels.ts';
import { INCIDENT_DEFAULT_ACCEPTANCE } from './incident.ts';

loadProjectEnvironment();

const prisma: PrismaClient = new PrismaClientConstructor();
const AGENT_TOKEN = 'inv_agent_incident_test';
const IMPACT = '### 1. 目标与架构定位\n看板白屏\n\n### 2. 核心功能与交付范围\n所有用户无法打开看板\n\n### 3. 验收标准与验证方案\n看板恢复';
let server: StartedServer;

const INCIDENT_DECLARE_MUTATION = /* GraphQL */ `
  mutation IncidentDeclare($input: WorkProposeInput!) {
    workPropose(input: $input) {
      success
      message
      issue { id identifier severity commitmentStatus source acceptance assignee { id } state { type } labels { nodes { name } } }
    }
  }
`;

// INV-1123: Type: Incident, committed when declared with parent, severity and impact.
describe('Type: Incident (INV-1123)', () => {
  let team: Team;
  let human: User;
  let teammate: User;
  let parentId: string;

  beforeAll(async () => { await prisma.$connect(); });
  afterAll(async () => { await prisma.$disconnect(); });
  beforeEach(async () => {
    await prisma.notification.deleteMany();
    await prisma.eventOutboxDelivery.deleteMany();
    await prisma.eventOutbox.deleteMany();
    await prisma.workLink.deleteMany();
    await prisma.comment.deleteMany();
    await prisma.issue.deleteMany();
    await prisma.workflowState.deleteMany();
    await prisma.team.deleteMany();
    await prisma.issueLabel.deleteMany();
    await prisma.agentCredential.deleteMany();
    await prisma.session.deleteMany();
    await prisma.actorAudit.deleteMany();
    await prisma.user.deleteMany();
    await seedDatabase(prisma);
    team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
    human = await prisma.user.findUniqueOrThrow({ where: { email: DEFAULT_ADMIN_EMAIL } });
    teammate = await prisma.user.create({ data: { name: 'Teammate', email: 'teammate@example.com', actorKind: 'HUMAN' } });
    await prisma.teamMembership.create({ data: { role: 'EDITOR', teamId: team.id, userId: teammate.id } });
    await prisma.teamMembership.upsert({ where: { teamId_userId: { teamId: team.id, userId: human.id } }, update: {}, create: { role: 'OWNER', teamId: team.id, userId: human.id } });
    const agent = await prisma.user.create({ data: { name: 'Watcher', email: 'watcher@agents.local', actorKind: 'AGENT', ownerId: human.id } });
    await prisma.teamMembership.create({ data: { role: 'EDITOR', teamId: team.id, userId: agent.id } });
    await prisma.agentCredential.create({ data: { name: 'watcher', scopes: ['read', 'propose', 'claim', 'report'], tokenHash: hashAgentToken(AGENT_TOKEN), teamId: team.id, userId: agent.id } });
    parentId = await testParentId(prisma, team.id, 'fakechris/Involute');
    server = await startServer({ allowAdminFallback: true, prisma, authToken: 'unused-static-token', port: 0 });
  });
  afterEach(async () => { await server.stop(); });

  async function callTool(name: string, args: Record<string, unknown>) {
    const response = await fetch(`${server.url}/mcp`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${AGENT_TOKEN}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { team: DEFAULT_TEAM_KEY, ...args } } }),
    });
    const body = await response.json() as { error?: { message: string }; result?: { isError?: boolean; content: Array<{ text: string }> } };
    if (body.error) return { error: body.error.message };
    const text = body.result!.content[0]!.text;
    return body.result!.isError ? { error: text } : JSON.parse(text);
  }

  const declare = (args: Record<string, unknown>) =>
    callTool('work_propose', { title: 'Board is blank for everyone', severity: 'SEV1', description: IMPACT, parent_id: parentId, ...args, labels: ['incident', ...((args.labels as string[] | undefined) ?? [])] });

  it('commits a complete declaration In Progress, owned by the agent\'s human, and tells the team', async () => {
    const created = await declare({ labels: ['ops'] });
    expect(created.error).toBeUndefined();
    const issue = await prisma.issue.findUniqueOrThrow({ where: { id: created.id }, include: { labels: true, state: true } });
    expect(issue).toMatchObject({ commitmentStatus: 'COMMITTED', assigneeId: human.id, severity: 'SEV1', parentId, acceptance: INCIDENT_DEFAULT_ACCEPTANCE });
    expect(issue.state.type).toBe('STARTED');
    expect(issue.labels.map((label) => label.name.toLowerCase()).sort()).toEqual(['incident', 'ops']);
    expect(await isIncidentWork(prisma, issue.id)).toBe(true);
    expect(created.warning).toContain('Incident Lead');

    const events = await prisma.eventOutbox.findMany({ select: { type: true, payload: true } });
    const ofIssue = events.filter((event) => (event.payload as { work?: { id?: string } }).work?.id === issue.id);
    expect(ofIssue.map((event) => event.type).sort()).toEqual(['incident.declared', 'work.committed']);
    expect(ofIssue.find((event) => event.type === 'incident.declared')!.payload).toMatchObject({ data: { severity: 'SEV1', identifier: issue.identifier } });
    const notified = await prisma.notification.findMany({ where: { workId: issue.id, type: 'incident.declared' }, select: { userId: true } });
    expect(notified.map((row) => row.userId).sort()).toEqual([human.id, teammate.id].sort());
  });

  it('refuses a declaration missing a parent, a severity or an impact statement, saying why', async () => {
    expect((await declare({ parent_id: undefined })).error).toMatch(/parent_id/);
    expect((await declare({ severity: undefined })).error).toMatch(/severity/i);
    expect((await declare({ description: undefined })).error).toMatch(/impact/i);
    expect(await prisma.issue.count({ where: { title: 'Board is blank for everyone' } })).toBe(0);
  });

  it('matches the label in any casing, inherits a parent from related work, and refuses a second Type', async () => {
    const proposed = await callTool('work_propose', { title: 'Search returns nothing', labels: ['Incident'], severity: 'SEV2', description: IMPACT, parent_id: parentId });
    expect(proposed.commitmentStatus).toBe('COMMITTED');
    expect(proposed.warning).toContain('Incident declared');
    const inherited = await callTool('work_propose', { title: 'Exports fail too', labels: ['incident'], severity: 'SEV3', description: IMPACT, related_work_id: proposed.identifier, related_work_type: 'DISCOVERED_DURING' });
    expect(inherited.commitmentStatus).toBe('COMMITTED');
    expect(inherited.parentId).toBe(parentId);
    expect((await declare({ title: 'Also a bug', labels: ['bug'] })).error).toMatch(/at most one Type/);
    expect((await declare({ title: 'Also a feature', labels: ['feature'] })).error).toMatch(/at most one Type/);
  });

  it('lets a person declare one through workPropose, refusing with a message when incomplete', async () => {
    const session = await createSession(prisma, human.id, 3600);
    const post = async (input: Record<string, unknown>) => {
      const response = await fetch(`${server.url}/graphql`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: `involute_session=${session.token}` },
        body: JSON.stringify({ query: INCIDENT_DECLARE_MUTATION, variables: { input: { teamId: team.id, title: 'Login fails', labels: ['incident'], source: 'incident-report', ...input } } }),
      });
      return (await response.json() as { data: { workPropose: { success: boolean; message: string | null; issue: Record<string, any> | null } } }).data.workPropose;
    };
    const missing = await post({ description: 'Nobody can sign in.', parentId });
    expect(missing).toMatchObject({ success: false, issue: null, message: expect.stringMatching(/severity/i) });

    const declared = await post({ description: 'Nobody can sign in.', severity: 'SEV2', parentId, acceptance: 'Sign-in works again.' });
    expect(declared.success).toBe(true);
    expect(declared.issue).toMatchObject({ severity: 'SEV2', commitmentStatus: 'COMMITTED', source: 'incident-report', acceptance: 'Sign-in works again.', assignee: { id: human.id }, state: { type: 'STARTED' } });
    expect(declared.issue!.labels.nodes.map((label: { name: string }) => label.name)).toEqual(['incident']);
    // The person who declared it is not told; the rest of the team is.
    const notified = await prisma.notification.findMany({ where: { workId: declared.issue!.id, type: 'incident.declared' }, select: { userId: true } });
    expect(notified.map((row) => row.userId)).toEqual([teammate.id]);
  });
});
