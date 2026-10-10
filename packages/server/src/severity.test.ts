import type { PrismaClient, Team, User } from '@prisma/client';

import { PrismaClient as PrismaClientConstructor } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ADMIN_EMAIL, DEFAULT_TEAM_KEY, seedDatabase } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import { hashAgentToken } from './agent-credentials.ts';
import { startServer, type StartedServer } from './index.ts';
import { createSession } from './session.js';
import { parseSeverity, SEVERITY_INVALID_MESSAGE } from './severity.ts';
import { testParentId } from './test-placement.ts';

loadProjectEnvironment();

const prisma: PrismaClient = new PrismaClientConstructor();
const AGENT_TOKEN = 'inv_agent_severity_test';
const REPO = 'fakechris/Involute';
const DESCRIPTION = '### 1. 目标与架构定位\nx\n\n### 2. 核心功能与交付范围\nx\n\n### 3. 验收标准与验证方案\nx';
let server: StartedServer;

// INV-1115: severity (impact) is a field of its own, apart from priority.
describe('severity (INV-1115)', () => {
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
    const agent = await prisma.user.create({ data: { name: 'Sev agent', email: 'sev@agents.local', actorKind: 'AGENT', ownerId: human.id } });
    await prisma.teamMembership.create({ data: { role: 'EDITOR', teamId: team.id, userId: agent.id } });
    await prisma.agentCredential.create({ data: { name: 'sev', scopes: ['read', 'propose', 'claim', 'report', 'update'], tokenHash: hashAgentToken(AGENT_TOKEN), teamId: team.id, userId: agent.id } });
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

  it('parses severity strictly: undefined keeps, null clears, other values are refused', () => {
    expect(parseSeverity(undefined)).toBeUndefined();
    expect(parseSeverity(null)).toBeNull();
    expect(parseSeverity('sev2')).toBe('SEV2');
    expect(() => parseSeverity('SEV4')).toThrow(SEVERITY_INVALID_MESSAGE);
    expect(() => parseSeverity(1)).toThrow(SEVERITY_INVALID_MESSAGE);
  });

  it('is written and read through MCP: file_bug, propose and update, with an audit row for each change', async () => {
    const bug = await fileBug({ title: 'Board blank', severity: 'SEV2' });
    expect(bug.error).toBeUndefined();
    expect(bug.severity).toBe('SEV2');

    const refused = await fileBug({ title: 'Bad severity', severity: 'SEV9' });
    expect(refused.error).toMatch(/SEV1 \(Critical\)/);

    const proposed = await mcp('work_propose', { team: DEFAULT_TEAM_KEY, title: 'Slow search', description: DESCRIPTION, parent_id: parentId, severity: 'SEV3' });
    expect(proposed.severity).toBe('SEV3');

    const updated = await mcp('work_update', { id: bug.identifier, expected_revision: bug.revision, severity: 'SEV1' });
    expect(updated.error).toBeUndefined();
    expect(updated.severity).toBe('SEV1');
    const audit = await prisma.workAudit.findFirstOrThrow({ where: { workId: bug.id, revision: updated.revision } });
    expect((audit.before as { severity: string }).severity).toBe('SEV2');
    expect((audit.after as { severity: string }).severity).toBe('SEV1');

    const cleared = await mcp('work_update', { id: bug.identifier, expected_revision: updated.revision, severity: null });
    expect(cleared.severity).toBeNull();

    const badUpdate = await mcp('work_update', { id: bug.identifier, expected_revision: cleared.revision, severity: 'critical' });
    expect(badUpdate.error).toMatch(/SEV1 \(Critical\)/);

    // Severity never moves the SLA: priority alone sets it.
    const context = await mcp('work_get_context', { id: bug.identifier });
    expect(context.work.severity).toBeNull();
  });

  it('is written and read through GraphQL: bugReport and issueUpdate', async () => {
    const reported = await gql(`mutation ($input: BugReportInput!) { bugReport(input: $input) { success message issue { id identifier revision severity bugSla { budgetHours } } } }`, {
      input: { teamId: team.id, title: 'Crash on save', stepsToReproduce: 'Save.', priority: 2, severity: 'SEV1', parentId },
    });
    expect(reported.data.bugReport.message).toBeNull();
    const issue = reported.data.bugReport.issue;
    expect(issue.severity).toBe('SEV1');

    const updated = await gql(`mutation ($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success message issue { revision severity bugSla { budgetHours } } } }`, {
      id: issue.id, input: { expectedRevision: issue.revision, severity: 'SEV3' },
    });
    expect(updated.data.issueUpdate.success).toBe(true);
    expect(updated.data.issueUpdate.issue.severity).toBe('SEV3');
    // SLA stays the priority's (High = 48h), whatever the severity.
    expect(updated.data.issueUpdate.issue.bugSla.budgetHours).toBe(issue.bugSla.budgetHours);
    expect(issue.bugSla.budgetHours).toBe(48);

    const invalid = await gql(`mutation ($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`, {
      id: issue.id, input: { severity: 'SEV4' },
    });
    // GraphQL's enum refuses it before the resolver runs; the stored value stays.
    expect(invalid.errors?.length).toBeGreaterThan(0);
    expect((await prisma.issue.findUniqueOrThrow({ where: { id: issue.id } })).severity).toBe('SEV3');
  });

  it('filters with IQL severity: and counts bugs by severity in bugSummary', async () => {
    await fileBug({ title: 'One', severity: 'SEV1' });
    await fileBug({ title: 'Two', severity: 'SEV1' });
    await fileBug({ title: 'Three', severity: 'SEV3' });
    await fileBug({ title: 'Four' });

    const titles = async (query: string) => {
      const result = await gql(`query ($q: String) { issues(first: 50, query: $q) { nodes { title } } }`, { q: `label:bug ${query}` });
      if (result.errors) return result.errors[0].message as string;
      return (result.data.issues.nodes as Array<{ title: string }>).map((node) => node.title).sort();
    };
    expect(await titles('severity:sev1')).toEqual(['One', 'Two']);
    expect(await titles('severity:SEV1,SEV3')).toEqual(['One', 'Three', 'Two']);
    expect(await titles('severity:none')).toEqual(['Four']);
    expect(await titles('-severity:sev1')).toEqual(['Four', 'Three']);
    expect(await titles('severity:sev7')).toMatch(/severity must be/);

    const search = await mcp('work_search', { filter: 'label:bug severity:sev3' });
    const items = (search.items ?? search.nodes ?? search) as Array<{ title: string }>;
    expect(items.map((item) => item.title)).toEqual(['Three']);

    const summary = await gql(`query { bugSummary { bySeverity { severity count } } }`);
    expect(summary.data.bugSummary.bySeverity).toEqual([
      { severity: 'SEV1', count: 2 },
      { severity: 'SEV3', count: 1 },
      { severity: null, count: 1 },
    ]);
  });
});
