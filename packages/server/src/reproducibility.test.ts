import type { PrismaClient, Team, User } from '@prisma/client';

import { PrismaClient as PrismaClientConstructor } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ADMIN_EMAIL, DEFAULT_TEAM_KEY, seedDatabase } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import { hashAgentToken } from './agent-credentials.ts';
import { startServer, type StartedServer } from './index.ts';
import { createSession } from './session.js';
import { parseReproducibility, REPRODUCIBILITY_INVALID_MESSAGE } from './reproducibility.ts';
import { testParentId } from './test-placement.ts';

loadProjectEnvironment();

const prisma: PrismaClient = new PrismaClientConstructor();
const AGENT_TOKEN = 'inv_agent_reproducibility_test';
const REPO = 'fakechris/Involute';
const DESCRIPTION = '### 1. 目标与架构定位\nx\n\n### 2. 核心功能与交付范围\nx\n\n### 3. 验收标准与验证方案\nx';
let server: StartedServer;

// INV-1122: how often a bug reproduces, written and read on every surface.
describe('reproducibility (INV-1122)', () => {
  let team: Team;
  let human: User;
  let cookie: string;
  let parentId: string;

  beforeAll(async () => { await prisma.$connect(); });
  afterAll(async () => { await prisma.$disconnect(); });
  beforeEach(async () => {
    await prisma.notification.deleteMany();
    await prisma.workClaim.deleteMany();
    await prisma.workLink.deleteMany();
    await prisma.comment.deleteMany();
    await prisma.issue.deleteMany();
    await prisma.workflowState.deleteMany();
    await prisma.team.deleteMany();
    await prisma.issueLabel.deleteMany();
    await prisma.agentCredential.deleteMany();
    await prisma.session.deleteMany();
    await prisma.eventOutboxDelivery.deleteMany();
    await prisma.eventOutbox.deleteMany();
    await prisma.actorAudit.deleteMany();
    await prisma.user.deleteMany();
    await seedDatabase(prisma);
    team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
    human = await prisma.user.findUniqueOrThrow({ where: { email: DEFAULT_ADMIN_EMAIL } });
    const agent = await prisma.user.create({ data: { name: 'Repro agent', email: 'repro@agents.local', actorKind: 'AGENT', ownerId: human.id } });
    await prisma.teamMembership.create({ data: { role: 'EDITOR', teamId: team.id, userId: agent.id } });
    await prisma.agentCredential.create({ data: { name: 'repro', scopes: ['read', 'propose', 'claim', 'report', 'update'], tokenHash: hashAgentToken(AGENT_TOKEN), teamId: team.id, userId: agent.id } });
    const session = await createSession(prisma, human.id, 3600);
    cookie = `involute_session=${session.token}`;
    parentId = await testParentId(prisma, team.id, REPO);
    server = await startServer({ allowAdminFallback: true, prisma, authToken: 'unused-static-token', port: 0 });
  });
  afterEach(async () => { await server.stop(); });

  async function mcp(name: string, args: Record<string, unknown>) {
    const response = await fetch(`${server.url}/mcp`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${AGENT_TOKEN}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    const body = await response.json() as { error?: { message: string }; result?: { isError?: boolean; content: Array<{ text: string }> } };
    if (body.error) return { error: body.error.message };
    const text = body.result!.content[0]!.text;
    if (body.result!.isError) return { error: text };
    return JSON.parse(text);
  }

  async function gql(query: string, variables?: Record<string, unknown>) {
    const response = await fetch(`${server.url}/graphql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ query, variables }),
    });
    return await response.json() as any;
  }

  const fileBug = (args: Record<string, unknown>) => mcp('work_file_bug', {
    team: DEFAULT_TEAM_KEY, repository: REPO, priority: 3, steps_to_reproduce: 'Open it.', acceptance: 'It works.',
    description: DESCRIPTION, parent_id: parentId, ...args,
  });

  it('parses strictly: undefined keeps, null clears, other values are refused', () => {
    expect(parseReproducibility(undefined)).toBeUndefined();
    expect(parseReproducibility(null)).toBeNull();
    expect(parseReproducibility('sometimes')).toBe('SOMETIMES');
    expect(() => parseReproducibility('OFTEN')).toThrow(REPRODUCIBILITY_INVALID_MESSAGE);
    expect(() => parseReproducibility(2)).toThrow(REPRODUCIBILITY_INVALID_MESSAGE);
  });

  it('is written and read through MCP: file_bug, propose and update, with an audit row for each change', async () => {
    const bug = await fileBug({ title: 'Flaky save', reproducibility: 'SOMETIMES' });
    expect(bug.error).toBeUndefined();
    expect(bug.reproducibility).toBe('SOMETIMES');

    const refused = await fileBug({ title: 'Bad value', reproducibility: 'RARELY' });
    expect(refused.error).toMatch(/ALWAYS \(every try\)/);

    const proposed = await mcp('work_propose', { team: DEFAULT_TEAM_KEY, title: 'Crash once', description: DESCRIPTION, parent_id: parentId, reproducibility: 'ONCE' });
    expect(proposed.reproducibility).toBe('ONCE');

    const updated = await mcp('work_update', { id: bug.identifier, expected_revision: bug.revision, reproducibility: 'ALWAYS' });
    expect(updated.error).toBeUndefined();
    expect(updated.reproducibility).toBe('ALWAYS');
    const audit = await prisma.workAudit.findFirstOrThrow({ where: { workId: bug.id, revision: updated.revision } });
    expect((audit.before as { reproducibility: string }).reproducibility).toBe('SOMETIMES');
    expect((audit.after as { reproducibility: string }).reproducibility).toBe('ALWAYS');

    const cleared = await mcp('work_update', { id: bug.identifier, expected_revision: updated.revision, reproducibility: null });
    expect(cleared.reproducibility).toBeNull();

    const context = await mcp('work_get_context', { id: bug.identifier });
    expect(context.work.reproducibility).toBeNull();
  });

  it('is written and read through GraphQL: bugReport and issueUpdate', async () => {
    const reported = await gql(`mutation ($input: BugReportInput!) { bugReport(input: $input) { success message issue { id revision reproducibility } } }`, {
      input: { teamId: team.id, title: 'Sometimes blank', stepsToReproduce: 'Reload a few times.', priority: 3, reproducibility: 'SOMETIMES', parentId },
    });
    expect(reported.data.bugReport.message).toBeNull();
    const issue = reported.data.bugReport.issue;
    expect(issue.reproducibility).toBe('SOMETIMES');

    const updated = await gql(`mutation ($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success message issue { revision reproducibility } } }`, {
      id: issue.id, input: { expectedRevision: issue.revision, reproducibility: 'ONCE' },
    });
    expect(updated.data.issueUpdate.success).toBe(true);
    expect(updated.data.issueUpdate.issue.reproducibility).toBe('ONCE');

    const invalid = await gql(`mutation ($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`, {
      id: issue.id, input: { reproducibility: 'OFTEN' },
    });
    expect(invalid.errors?.length).toBeGreaterThan(0);
    expect((await prisma.issue.findUniqueOrThrow({ where: { id: issue.id } })).reproducibility).toBe('ONCE');
  });
});
