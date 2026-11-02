import type { PrismaClient, Team, User } from '@prisma/client';
import { PrismaClient as PrismaClientConstructor } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ADMIN_EMAIL, DEFAULT_TEAM_KEY, resetAndSeed } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import { hashAgentToken, issueAgentCredential } from './agent-credentials.ts';
import { setAgentTrust } from './agent-trust.ts';
import { readAutonomySettings, setWorkflowPolicy } from './autonomy-service.ts';
import { proposeWork } from './claim-service.ts';
import { listReadyWork, searchWork } from './context-service.ts';
import {
  IMPORTED_EXTRA_KEY, ensureImportedExtraDefinition, fieldKeyFromName, mapImportedFields, runFieldIndexJobs, setFieldDefinition,
} from './field-definitions.ts';
import { compileIqlWhere } from './iql-attr.ts';
import { compileIqlPredicate, parseIqlOrThrow } from './iql-compile.ts';
import { startServer, type StartedServer } from './index.ts';
import { createIssue } from './issue-service.ts';
import { createSession } from './session.js';
import { writeActorFromViewer } from './work-service.ts';
import { WORKSPACE_SETTINGS_ID } from './workspace-access.ts';

// INV-1505: field definitions in IQL, autonomy conditions, MCP descriptions and import mapping.
loadProjectEnvironment();
const prisma: PrismaClient = new PrismaClientConstructor();
const DESCRIPTION = ['### 1. 目标与架构定位', 'x', '### 2. 核心功能与交付范围', 'x', '### 3. 验收标准与验证方案', 'x', '', '### Steps to reproduce', '1. open'].join('\n');

let admin: User;
let team: Team;
let projectId: string;
const human = () => writeActorFromViewer(admin, 'test');

async function setup() {
  await resetAndSeed(prisma);
  admin = await prisma.user.findUniqueOrThrow({ where: { email: DEFAULT_ADMIN_EMAIL } });
  team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
  await prisma.teamMembership.upsert({ where: { teamId_userId: { teamId: team.id, userId: admin.id } }, update: {}, create: { role: 'OWNER', teamId: team.id, userId: admin.id } });
  projectId = (await createIssue(prisma, { teamId: team.id, title: 'P', kind: 'PROJECT', repository: 'test/consumers', commitmentStatus: 'COMMITTED' }, human())).id;
}

const define = (overrides: Partial<Parameters<typeof setFieldDefinition>[1]>) => setFieldDefinition(prisma, {
  scope: 'TEAM', scopeId: team.id, key: 'risk', label: 'Risk', type: 'ENUM', options: [{ value: 'low', label: 'Low' }, { value: 'high', label: 'High' }],
  appliesTo: { kinds: ['ISSUE'] }, reason: 'r', ...overrides,
}, admin.id);
const item = (title: string, attributes: Record<string, unknown>) => createIssue(prisma, { teamId: team.id, title, parentId: projectId, repository: 'test/consumers', acceptance: 'a', attributes }, human());
const titlesFor = async (iql: string) => {
  const { where } = await compileIqlWhere(prisma, parseIqlOrThrow(iql), { viewerId: admin.id });
  return (await prisma.issue.findMany({ where: { AND: [where ?? {}, { kind: 'ISSUE' }] }, orderBy: { title: 'asc' } })).map((row) => row.title);
};

describe('IQL attr.<key> (INV-1505)', () => {
  beforeAll(async () => { await prisma.$connect(); });
  afterAll(async () => { await resetAndSeed(prisma); await prisma.$disconnect(); });
  beforeEach(setup);

  it('equality, lists, none / any and negation through JSONB containment', async () => {
    await define({});
    await define({ key: 'tags', label: 'Tags', type: 'MULTI_ENUM', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] });
    await define({ key: 'points', label: 'Points', type: 'NUMBER', options: null });
    await item('A low', { risk: 'low', tags: ['a'], points: 3 });
    await item('B high', { risk: 'high', tags: ['a', 'b'], points: 5 });
    await item('C unset', {});
    expect(await titlesFor('attr.risk:low')).toEqual(['A low']);
    expect(await titlesFor('attr.risk:low,high')).toEqual(['A low', 'B high']);
    expect(await titlesFor('attr.risk:!=low')).toEqual(['B high', 'C unset']);
    expect(await titlesFor('-attr.risk:high')).toEqual(['A low', 'C unset']);
    expect(await titlesFor('attr.risk:none')).toEqual(['C unset']);
    expect(await titlesFor('attr.risk:any')).toEqual(['A low', 'B high']);
    expect(await titlesFor('attr.tags:b')).toEqual(['B high']);
    expect(await titlesFor('attr.points:5')).toEqual(['B high']);
    await expect(titlesFor('attr.missing:x')).rejects.toThrow(/no active field definition/);
    await expect(titlesFor('attr.points:five')).rejects.toThrow(/needs a number/);
  });

  it('the equality lookup can use the GIN index', async () => {
    const plan = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
      return tx.$queryRawUnsafe<Array<{ 'QUERY PLAN': string }>>(`EXPLAIN SELECT id FROM "Issue" WHERE attributes @> '{"risk":"low"}'::jsonb`);
    });
    expect(plan.map((row) => row['QUERY PLAN']).join('\n')).toContain('Issue_attributes_gin');
  });

  it('ranges and sort use the typed index on searchable fields and are refused on others', async () => {
    await define({ key: 'points', label: 'Points', type: 'NUMBER', options: null, searchable: true });
    await define({ key: 'note', label: 'Note', type: 'TEXT', options: null });
    await item('A', { points: 8, note: 'x' });
    await item('B', { points: 2 });
    await item('C', { points: 5 });
    await item('D', {});
    await runFieldIndexJobs(prisma);
    expect(await titlesFor('attr.points:>=5')).toEqual(['A', 'C']);
    expect(await titlesFor('attr.points:<5')).toEqual(['B']);
    await expect(titlesFor('attr.note:>a')).rejects.toThrow(/mark "note" searchable/);
    await expect(titlesFor('sort:attr.note')).rejects.toThrow(/mark "note" searchable/);

    const sorted = await searchWork(prisma, { iql: 'kind:ISSUE sort:attr.points', first: 10 });
    expect(sorted.map((row) => row.title)).toEqual(['B', 'C', 'A', 'D']);
    const descending = await searchWork(prisma, { iql: 'kind:ISSUE sort:attr.points:desc', first: 2 });
    expect(descending.map((row) => row.title)).toEqual(['A', 'C']);
    await expect(listReadyWork(prisma, { iql: 'sort:attr.points' })).rejects.toThrow(/not supported in ready lists/);
  });

  it('webhook filters match attributes in memory', async () => {
    await define({});
    const work = await item('A', { risk: 'low' });
    const row = await prisma.issue.findUniqueOrThrow({ where: { id: work.id }, include: { assignee: true, labels: true, state: true } });
    expect(compileIqlPredicate(parseIqlOrThrow('attr.risk:low'), { viewerId: null })(row)).toBe(true);
    expect(compileIqlPredicate(parseIqlOrThrow('attr.risk:high'), { viewerId: null })(row)).toBe(false);
    expect(compileIqlPredicate(parseIqlOrThrow('attr.risk:none'), { viewerId: null })(row)).toBe(false);
  });
});

describe('autonomy conditions on attr.<key> (INV-1505)', () => {
  beforeAll(async () => { await prisma.$connect(); });
  afterAll(async () => { await resetAndSeed(prisma); await prisma.$disconnect(); });
  beforeEach(setup);

  it('refuses a non-searchable field, lists searchable ones, and an L1 intake rule on attr.risk commits only low-risk candidates', async () => {
    await define({});
    await setWorkflowPolicy(prisma, { scope: 'WORKSPACE', scopeId: WORKSPACE_SETTINGS_ID, level: 1, reason: 'c' }, admin.id);
    const gates = { candidate_commit: { decider: 'auto' as const, condition: { field: 'attr.risk', eq: 'low' } } };
    await expect(setWorkflowPolicy(prisma, { scope: 'TEAM', scopeId: team.id, level: 1, gates, reason: 't' }, admin.id)).rejects.toThrow(/attr\.risk is not a searchable field/);
    await define({ searchable: true });
    expect((await readAutonomySettings(prisma, { scope: 'TEAM', scopeId: team.id })).conditionFields).toContain('attr.risk');
    await setWorkflowPolicy(prisma, { scope: 'TEAM', scopeId: team.id, level: 1, gates, reason: 't' }, admin.id);

    const issued = await issueAgentCredential(prisma, { email: `attr-${Date.now()}@agents.involute.local`, name: 'Attr', ownerId: admin.id, teamKey: team.key, scopes: ['read', 'propose'], issuedById: admin.id });
    const agent = await prisma.user.findUniqueOrThrow({ where: { id: issued.credential.userId } });
    await setAgentTrust(prisma, { actorId: agent.id, level: 'L2', reason: 'test' }, admin.id);
    const propose = (title: string, risk: string) => proposeWork(prisma, {
      teamId: team.id, title, description: DESCRIPTION, acceptance: 'Fixed.', parentId: projectId, priority: 2, labels: ['improvement'], attributes: { risk },
    }, writeActorFromViewer(agent, 'mcp'));
    expect((await propose('Low risk', 'low')).commitmentStatus).toBe('COMMITTED');
    expect((await propose('High risk', 'high')).commitmentStatus).toBe('CANDIDATE');
    const audit = await prisma.workAudit.findFirst({ where: { reason: { startsWith: 'policy.auto_decision' } } });
    expect(audit?.reason).toContain('attr.risk low');
  });
});

describe('import mapping (INV-1505)', () => {
  beforeAll(async () => { await prisma.$connect(); });
  afterAll(async () => { await resetAndSeed(prisma); await prisma.$disconnect(); });
  beforeEach(setup);

  it('maps source fields by key, coerces simple types, and keeps the rest as imported_extra text', async () => {
    expect(fieldKeyFromName('Customer Tier')).toBe('customer_tier');
    expect(fieldKeyFromName('影响模块')).toBe('f_');
    const tier = await define({ key: 'customer_tier', label: 'Tier', options: [{ value: 'gold', label: 'Gold' }] });
    const points = await define({ key: 'story_points', label: 'Points', type: 'NUMBER', options: null });
    const mapped = mapImportedFields([tier, points], [
      { name: 'Customer Tier', value: 'gold' },
      { name: 'Story Points', value: '5' },
      { name: 'Customer Tier ', value: 'platinum' },
      { name: '影响模块', value: ['支付', '账单'] },
      { name: 'Empty', value: '' },
    ]);
    expect(mapped.attributes).toEqual({ customer_tier: 'gold', story_points: 5 });
    expect(mapped.extra).toBe('Customer Tier : platinum\n影响模块: 支付, 账单');

    const extra = await ensureImportedExtraDefinition(prisma, team.id);
    expect(extra).toMatchObject({ key: IMPORTED_EXTRA_KEY, type: 'TEXT', scope: 'TEAM' });
    expect((await ensureImportedExtraDefinition(prisma, team.id))?.id).toBe(extra!.id);
  });
});

const AGENT_TOKEN = 'inv_agent_field_consumers_test';

describe('GraphQL and MCP surfaces (INV-1505)', () => {
  let server: StartedServer;
  beforeAll(async () => { await prisma.$connect(); });
  afterAll(async () => { await resetAndSeed(prisma); await prisma.$disconnect(); });
  beforeEach(async () => {
    await setup();
    const agent = await prisma.user.create({ data: { name: 'Lister', email: 'lister@agents.local', actorKind: 'AGENT', ownerId: admin.id } });
    await prisma.teamMembership.create({ data: { role: 'EDITOR', teamId: team.id, userId: agent.id } });
    await prisma.agentCredential.create({ data: { name: 'lister', scopes: ['read', 'propose'], tokenHash: hashAgentToken(AGENT_TOKEN), teamId: team.id, userId: agent.id } });
    server = await startServer({ allowAdminFallback: true, prisma, authToken: 'unused-static-token', port: 0 });
  });
  afterEach(async () => { await server.stop(); });

  it('tools/list names the team required fields in the attributes description', async () => {
    await define({ key: 'customer', label: 'Customer', type: 'TEXT', options: null, required: true, appliesTo: { kinds: ['ISSUE'], types: ['bug'] } });
    const response = await fetch(`${server.url}/mcp`, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${AGENT_TOKEN}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    const body = await response.json() as { result: { tools: Array<{ name: string; inputSchema: { properties: Record<string, { description?: string }> } }> } };
    const described = body.result.tools.filter((tool) => tool.inputSchema.properties.attributes?.description?.includes('Required fields for your team: customer (TEXT; ISSUE of Type bug)'));
    expect(described.length).toBeGreaterThan(0);
  });

  it('issues(query) sorts by a searchable field and pages by position; applicableFieldDefinitions follows Kind × Type', async () => {
    await define({ key: 'points', label: 'Points', type: 'NUMBER', options: null, searchable: true });
    await define({ key: 'env', label: 'Env', type: 'TEXT', options: null, appliesTo: { kinds: ['ISSUE'], types: ['bug'] }, required: true });
    for (const [title, points] of [['A', 3], ['B', 1], ['C', 2]] as const) await item(title, { points });
    const session = await createSession(prisma, admin.id, 3600);
    const gql = async (query: string, variables: Record<string, unknown>) => (await (await fetch(`${server.url}/graphql`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: `involute_session=${session.token}` }, body: JSON.stringify({ query, variables }) })).json()) as { data: any; errors?: unknown };
    const page = `query Page($after: String) { issues(first: 2, after: $after, query: "kind:ISSUE sort:attr.points") { nodes { title } pageInfo { endCursor hasNextPage } } }`;
    const first = await gql(page, {});
    expect(first.errors).toBeUndefined();
    expect(first.data.issues.nodes.map((node: { title: string }) => node.title)).toEqual(['B', 'C']);
    const second = await gql(page, { after: first.data.issues.pageInfo.endCursor });
    expect(second.data.issues.nodes.map((node: { title: string }) => node.title)).toEqual(['A']);
    expect(second.data.issues.pageInfo.hasNextPage).toBe(false);

    const applicable = `query A($teamId: String!, $parentId: String, $kind: WorkKind!, $type: String) { applicableFieldDefinitions(teamId: $teamId, parentId: $parentId, kind: $kind, type: $type) { key required } }`;
    expect((await gql(applicable, { teamId: team.id, parentId: projectId, kind: 'ISSUE', type: 'bug' })).data.applicableFieldDefinitions).toEqual([{ key: 'env', required: true }, { key: 'points', required: false }]);
    expect((await gql(applicable, { teamId: team.id, kind: 'ISSUE', type: 'feature' })).data.applicableFieldDefinitions).toEqual([{ key: 'points', required: false }]);
  });
});
