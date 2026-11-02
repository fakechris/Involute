import type { FieldDefinition, PrismaClient, Team, User } from '@prisma/client';
import { PrismaClient as PrismaClientConstructor } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ADMIN_EMAIL, DEFAULT_TEAM_KEY, resetAndSeed } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import { hashAgentToken } from './agent-credentials.ts';
import { reportBug } from './bug-report.ts';
import { commitWork, proposeWork } from './claim-service.ts';
import {
  FIELD_AUDIT, FIELD_LIMITS, deactivateFieldDefinition, definitionApplies, mergeByScope, resolveDefinitionsFor, setFieldDefinition, validateAttributes,
} from './field-definitions.ts';
import { startServer, type StartedServer } from './index.ts';
import { createIssue, updateIssue } from './issue-service.ts';
import { createSession } from './session.js';
import { writeActorFromViewer } from './work-service.ts';
import { WORKSPACE_SETTINGS_ID } from './workspace-access.ts';

// INV-1503 / decision INV-1501: field definitions and Issue.attributes (docs/field-definitions.md).
loadProjectEnvironment();
const prisma: PrismaClient = new PrismaClientConstructor();
const DESCRIPTION = ['### 1. 目标与架构定位', 'x', '### 2. 核心功能与交付范围', 'x', '### 3. 验收标准与验证方案', 'x'].join('\n');

function definition(overrides: Partial<FieldDefinition>): FieldDefinition {
  return {
    id: overrides.key ?? 'id', scope: 'TEAM', scopeId: 'team', key: 'risk', label: 'Risk', description: null, type: 'TEXT', options: null,
    appliesTo: { kinds: ['ISSUE'], types: 'any' }, required: false, defaultValue: null, searchable: false, active: true, version: 1, reason: 'r',
    createdById: null, createdAt: new Date(), ...overrides,
  } as FieldDefinition;
}

describe('validateAttributes (pure)', () => {
  const risk = definition({ key: 'risk', type: 'ENUM', options: [{ value: 'low', label: 'Low' }, { value: 'high', label: 'High' }, { value: 'old', label: 'Old', archived: true }] });
  const tags = definition({ key: 'tags', type: 'MULTI_ENUM', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] });
  const points = definition({ key: 'points', type: 'NUMBER' });
  const flag = definition({ key: 'flag', type: 'BOOLEAN' });
  const due = definition({ key: 'due', type: 'DATE' });
  const note = definition({ key: 'note', type: 'TEXT' });
  const link = definition({ key: 'link', type: 'URL' });
  const owner = definition({ key: 'owner', type: 'USER_REF' });
  const related = definition({ key: 'related', type: 'WORK_REF' });
  const all = [risk, tags, points, flag, due, note, link, owner, related];

  it('accepts each type and normalises dates and multi-enum duplicates', () => {
    const result = validateAttributes(all, {}, {
      risk: 'low', tags: ['a', 'a', 'b'], points: 3.5, flag: false, due: '2026-11-02', note: 'hi', link: 'https://example.com/x',
      owner: '00000000-0000-4000-8000-000000000000', related: 'INV-1',
    }, 'committed');
    expect(result.attributes).toMatchObject({ risk: 'low', tags: ['a', 'b'], points: 3.5, flag: false, due: '2026-11-02T00:00:00.000Z' });
    expect(result.refs.work).toEqual([{ key: 'related', value: 'INV-1' }]);
    expect(result.refs.user).toHaveLength(1);
  });

  it('refuses an unknown key, a wrong type, an option outside the list, an archived option and oversize values', () => {
    expect(() => validateAttributes(all, {}, { nope: 1 }, 'candidate')).toThrow(/"nope" is not defined/);
    expect(() => validateAttributes(all, {}, { points: '3' }, 'candidate')).toThrow(/"points": expects a finite number/);
    expect(() => validateAttributes(all, {}, { points: Number.NaN }, 'candidate')).toThrow(/finite number/);
    expect(() => validateAttributes(all, {}, { flag: 'yes' }, 'candidate')).toThrow(/true or false/);
    expect(() => validateAttributes(all, {}, { due: 'tomorrow' }, 'candidate')).toThrow(/ISO date/);
    expect(() => validateAttributes(all, {}, { risk: 'medium' }, 'candidate')).toThrow(/"medium" is not one of its options \(low, high\)/);
    expect(() => validateAttributes(all, {}, { risk: 'old' }, 'candidate')).toThrow(/archived/);
    expect(() => validateAttributes(all, {}, { tags: 'a' }, 'candidate')).toThrow(/list of option values/);
    expect(() => validateAttributes(all, {}, { note: 'x'.repeat(FIELD_LIMITS.textLength + 1) }, 'candidate')).toThrow(/at most 2000/);
    expect(() => validateAttributes(all, {}, { link: 'ftp://example.com' }, 'candidate')).toThrow(/http\(s\) URL/);
    expect(() => validateAttributes(all, {}, { owner: 'bob' }, 'candidate')).toThrow(/user id/);
    expect(() => validateAttributes(all, {}, ['risk'] as unknown as Record<string, unknown>, 'candidate')).toThrow(/must be an object/);
  });

  it('merges a partial update and clears a key with null', () => {
    const result = validateAttributes(all, { risk: 'low', points: 1 }, { points: null, flag: true }, 'committed');
    expect(result.attributes).toEqual({ risk: 'low', flag: true });
    expect(result.changed.sort()).toEqual(['flag', 'points']);
  });

  it('required: a candidate gets a warning, committed work is refused, a default fills it', () => {
    const needed = definition({ key: 'customer', label: 'Customer', type: 'TEXT', required: true });
    expect(validateAttributes([needed], {}, {}, 'candidate').missingRequired).toEqual(['customer']);
    expect(() => validateAttributes([needed], {}, {}, 'committed')).toThrow(/Fill the required field "Customer" \(customer\)/);
    const withDefault = definition({ key: 'customer', type: 'TEXT', required: true, defaultValue: 'internal' });
    expect(validateAttributes([withDefault], {}, {}, 'committed').attributes).toEqual({ customer: 'internal' });
  });

  it('applies by Kind × Type and lets the nearest scope win', () => {
    const bugOnly = definition({ appliesTo: { kinds: ['ISSUE'], types: ['bug'] } });
    expect(definitionApplies(bugOnly, { kind: 'ISSUE', typeName: 'bug' })).toBe(true);
    expect(definitionApplies(bugOnly, { kind: 'ISSUE', typeName: 'feature' })).toBe(false);
    expect(definitionApplies(bugOnly, { kind: 'ISSUE', typeName: null })).toBe(false);
    expect(definitionApplies(bugOnly, { kind: 'EPIC', typeName: 'bug' })).toBe(false);
    const merged = mergeByScope({
      workspace: [definition({ key: 'risk', label: 'Workspace' }), definition({ key: 'area', label: 'Area' })],
      team: [definition({ key: 'risk', label: 'Team' })],
      project: [definition({ key: 'risk', label: 'Project' })],
    });
    expect(merged.map((item) => `${item.key}:${item.label}`)).toEqual(['area:Area', 'risk:Project']);
  });
});

describe('field definitions in the database', () => {
  let admin: User;
  let team: Team;
  let projectId: string;
  let milestoneId: string;
  const human = () => writeActorFromViewer(admin, 'test');

  beforeAll(async () => { await prisma.$connect(); });
  afterAll(async () => { await resetAndSeed(prisma); await prisma.$disconnect(); });
  beforeEach(async () => {
    await resetAndSeed(prisma);
    admin = await prisma.user.findUniqueOrThrow({ where: { email: DEFAULT_ADMIN_EMAIL } });
    team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
    await prisma.teamMembership.upsert({ where: { teamId_userId: { teamId: team.id, userId: admin.id } }, update: {}, create: { role: 'OWNER', teamId: team.id, userId: admin.id } });
    const project = await createIssue(prisma, { teamId: team.id, title: 'P', kind: 'PROJECT', repository: 'test/fields', commitmentStatus: 'COMMITTED' }, human());
    projectId = project.id;
    milestoneId = (await createIssue(prisma, { teamId: team.id, title: 'M', kind: 'MILESTONE', parentId: project.id, repository: 'test/fields', commitmentStatus: 'COMMITTED', acceptance: 'a' }, human())).id;
  });

  const define = (overrides: Partial<Parameters<typeof setFieldDefinition>[1]> = {}) => setFieldDefinition(prisma, {
    scope: 'TEAM', scopeId: team.id, key: 'risk', label: 'Risk', type: 'ENUM', options: [{ value: 'low', label: 'Low' }, { value: 'high', label: 'High' }],
    appliesTo: { kinds: ['ISSUE'], types: 'any' }, reason: 'track risk', ...overrides,
  }, admin.id);

  it('versions a definition, audits it, keeps the type, and enforces the per-scope cap', async () => {
    const startedAt = new Date();
    const first = await define();
    const second = await define({ label: 'Delivery risk' });
    expect(second.version).toBe(2);
    expect((await prisma.fieldDefinition.findUniqueOrThrow({ where: { id: first.id } })).active).toBe(false);
    expect(await prisma.opsAudit.count({ where: { action: FIELD_AUDIT.changed, createdAt: { gte: startedAt } } })).toBe(2);
    await expect(define({ type: 'TEXT', options: null })).rejects.toThrow(/type cannot change/);
    await expect(define({ key: 'Bad Key' })).rejects.toThrow(/snake_case/);
    await expect(define({ key: 'many', options: Array.from({ length: FIELD_LIMITS.enumOptions + 1 }, (_, index) => ({ value: `v${index}`, label: `${index}` })) })).rejects.toThrow(/at most 50 options/);
    await expect(define({ key: 'nokind', appliesTo: { kinds: [] } })).rejects.toThrow(/appliesTo.kinds/);
    await expect(define({ key: 'reasonless', reason: ' ' })).rejects.toThrow(/needs a reason/);
    for (let index = 1; index < FIELD_LIMITS.activePerScope; index += 1) await define({ key: `f${index}`, type: 'TEXT', options: null });
    await expect(define({ key: 'one_more', type: 'TEXT', options: null })).rejects.toThrow(/already has 30 active fields/);
    // Changing an existing key is not a new field.
    expect((await define({ label: 'Still fine' })).version).toBe(3);
  });

  it('resolves project → team → workspace for an item, filtered by Kind × Type', async () => {
    await setFieldDefinition(prisma, { scope: 'WORKSPACE', scopeId: WORKSPACE_SETTINGS_ID, key: 'area', label: 'Area', type: 'TEXT', appliesTo: { kinds: ['ISSUE'] }, reason: 'w' }, admin.id);
    await define({ label: 'Team risk' });
    await setFieldDefinition(prisma, { scope: 'PROJECT', scopeId: projectId, key: 'risk', label: 'Project risk', type: 'TEXT', appliesTo: { kinds: ['ISSUE'] }, reason: 'p' }, admin.id);
    await setFieldDefinition(prisma, { scope: 'TEAM', scopeId: team.id, key: 'repro_env', label: 'Env', type: 'TEXT', appliesTo: { kinds: ['ISSUE'], types: ['bug'] }, reason: 'b' }, admin.id);
    const subject = { teamId: team.id, kind: 'ISSUE' as const, parentId: milestoneId, typeName: null };
    expect((await resolveDefinitionsFor(prisma, subject)).map((item) => `${item.key}:${item.label}`)).toEqual(['area:Area', 'risk:Project risk']);
    expect((await resolveDefinitionsFor(prisma, { ...subject, typeName: 'bug' })).map((item) => item.key)).toEqual(['area', 'repro_env', 'risk']);
    expect(await resolveDefinitionsFor(prisma, { ...subject, kind: 'EPIC' })).toEqual([]);
  });

  it('createIssue and updateIssue write, merge, clear and audit attributes; a bad value is refused', async () => {
    await define();
    await define({ key: 'points', label: 'Points', type: 'NUMBER', options: null });
    const created = await createIssue(prisma, { teamId: team.id, title: 'W', parentId: milestoneId, repository: 'test/fields', acceptance: 'a', attributes: { risk: 'low' } }, human());
    expect(created.attributes).toEqual({ risk: 'low' });
    await expect(createIssue(prisma, { teamId: team.id, title: 'W2', parentId: milestoneId, repository: 'test/fields', acceptance: 'a', attributes: { risk: 'none' } }, human())).rejects.toThrow(/not one of its options/);
    const updated = await updateIssue(prisma, created.id, { attributes: { points: 5, risk: null }, expectedRevision: created.revision }, human());
    expect(updated.attributes).toEqual({ points: 5 });
    const audit = await prisma.workAudit.findFirstOrThrow({ where: { workId: created.id, revision: updated.revision } });
    expect((audit.before as { attributes: unknown }).attributes).toEqual({ risk: 'low' });
    expect((audit.after as { attributes: unknown }).attributes).toEqual({ points: 5 });
    await expect(updateIssue(prisma, created.id, { attributes: { points: 'five' } }, human())).rejects.toThrow(/finite number/);
    // An update that does not touch attributes is not checked against them.
    expect((await updateIssue(prisma, created.id, { title: 'Renamed' }, human())).title).toBe('Renamed');
  });

  it('a deactivated field keeps its values and is no longer writable; reactivating brings it back', async () => {
    await define();
    const created = await createIssue(prisma, { teamId: team.id, title: 'W', parentId: milestoneId, repository: 'test/fields', acceptance: 'a', attributes: { risk: 'high' } }, human());
    await deactivateFieldDefinition(prisma, { scope: 'TEAM', scopeId: team.id, key: 'risk', reason: 'retire' }, admin.id);
    expect((await prisma.issue.findUniqueOrThrow({ where: { id: created.id } })).attributes).toEqual({ risk: 'high' });
    await expect(updateIssue(prisma, created.id, { attributes: { risk: 'low' } }, human())).rejects.toThrow(/not defined/);
    await define();
    expect((await updateIssue(prisma, created.id, { attributes: { risk: 'low' } }, human())).attributes).toEqual({ risk: 'low' });
  });

  it('references: WORK_REF on the same team stored as its id, USER_REF a team member', async () => {
    await define({ key: 'related', label: 'Related', type: 'WORK_REF', options: null });
    await define({ key: 'reviewer', label: 'Reviewer', type: 'USER_REF', options: null });
    const target = await createIssue(prisma, { teamId: team.id, title: 'T', parentId: milestoneId, repository: 'test/fields', acceptance: 'a' }, human());
    const created = await createIssue(prisma, { teamId: team.id, title: 'W', parentId: milestoneId, repository: 'test/fields', acceptance: 'a', attributes: { related: target.identifier, reviewer: admin.id } }, human());
    expect(created.attributes).toEqual({ related: target.id, reviewer: admin.id });
    await expect(updateIssue(prisma, created.id, { attributes: { related: 'INV-999999' } }, human())).rejects.toThrow(/was not found/);
    const stranger = await prisma.user.create({ data: { name: 'S', email: `s-${Date.now()}@example.com`, actorKind: 'HUMAN' } });
    await expect(updateIssue(prisma, created.id, { attributes: { reviewer: stranger.id } }, human())).rejects.toThrow(/member of the team/);
  });

  it('propose leaves a required field empty; commit refuses until it is filled; a bug report must carry it', async () => {
    await define({ key: 'customer', label: 'Customer', type: 'TEXT', options: null, required: true });
    const agentUser = await prisma.user.create({ data: { name: 'bot', email: `bot-${Date.now()}@agents.test`, actorKind: 'AGENT', ownerId: admin.id } });
    const candidate = await proposeWork(prisma, { teamId: team.id, title: 'Needs a customer', description: DESCRIPTION, acceptance: 'a', parentId: milestoneId }, writeActorFromViewer(agentUser, 'mcp'));
    expect(candidate.commitmentStatus).toBe('CANDIDATE');
    expect(candidate.attributes).toEqual({});
    await expect(commitWork(prisma, candidate.id, { expectedRevision: candidate.revision, assigneeId: admin.id }, human())).rejects.toThrow(/Fill the required field "Customer"/);
    const fresh = await prisma.issue.findUniqueOrThrow({ where: { id: candidate.id } });
    const committed = await commitWork(prisma, candidate.id, { expectedRevision: fresh.revision, assigneeId: admin.id, attributes: { customer: 'Acme' } }, human());
    expect(committed.commitmentStatus).toBe('COMMITTED');
    expect(committed.attributes).toEqual({ customer: 'Acme' });

    // A placed bug report is committed at once, so it must carry the field.
    await expect(reportBug(prisma, { teamId: team.id, title: 'Broken', stepsToReproduce: '1. open', priority: 2, parentId: milestoneId }, human())).rejects.toThrow(/required field "Customer"/);
    const bug = await reportBug(prisma, { teamId: team.id, title: 'Broken', stepsToReproduce: '1. open', priority: 2, parentId: milestoneId, attributes: { customer: 'Acme' } }, human());
    expect(bug.attributes).toEqual({ customer: 'Acme' });
  });

  it('stores attributes under a GIN index', async () => {
    const rows = await prisma.$queryRaw<Array<{ indexdef: string }>>`SELECT indexdef FROM pg_indexes WHERE tablename = 'Issue' AND indexname = 'Issue_attributes_gin'`;
    expect(rows[0]?.indexdef).toMatch(/USING gin \(attributes jsonb_path_ops\)/);
  });
});

const AGENT_TOKEN = 'inv_agent_field_definitions_test';
const SET_MUTATION = /* GraphQL */ `
  mutation SetField($input: FieldDefinitionSetInput!) {
    fieldDefinitionSet(input: $input) { success message definition { key version type options { value } appliesTo { kinds types } } }
  }
`;
const ISSUE_QUERY = /* GraphQL */ `
  query Item($id: String!) { issue(id: $id) { id attributes fieldDefinitions { key label type required } } }
`;

describe('field definitions over GraphQL and MCP', () => {
  let team: Team;
  let human: User;
  let milestoneId: string;
  let server: StartedServer;

  beforeAll(async () => { await prisma.$connect(); });
  afterAll(async () => { await resetAndSeed(prisma); await prisma.$disconnect(); });
  beforeEach(async () => {
    await resetAndSeed(prisma);
    team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
    human = await prisma.user.findUniqueOrThrow({ where: { email: DEFAULT_ADMIN_EMAIL } });
    await prisma.teamMembership.upsert({ where: { teamId_userId: { teamId: team.id, userId: human.id } }, update: {}, create: { role: 'OWNER', teamId: team.id, userId: human.id } });
    const agent = await prisma.user.create({ data: { name: 'Fielder', email: 'fielder@agents.local', actorKind: 'AGENT', ownerId: human.id } });
    await prisma.teamMembership.create({ data: { role: 'EDITOR', teamId: team.id, userId: agent.id } });
    await prisma.agentCredential.create({ data: { name: 'fielder', scopes: ['read', 'propose', 'update', 'claim', 'report'], tokenHash: hashAgentToken(AGENT_TOKEN), teamId: team.id, userId: agent.id } });
    const actor = writeActorFromViewer(human, 'test');
    const project = await createIssue(prisma, { teamId: team.id, title: 'P', kind: 'PROJECT', repository: 'test/fields', commitmentStatus: 'COMMITTED' }, actor);
    milestoneId = (await createIssue(prisma, { teamId: team.id, title: 'M', kind: 'MILESTONE', parentId: project.id, repository: 'test/fields', commitmentStatus: 'COMMITTED', acceptance: 'a' }, actor)).id;
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

  async function graphql(query: string, variables: Record<string, unknown>, userId?: string) {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    headers.cookie = `involute_session=${(await createSession(prisma, userId ?? human.id, 3600)).token}`;
    const response = await fetch(`${server.url}/graphql`, { method: 'POST', headers, body: JSON.stringify({ query, variables }) });
    return (await response.json() as { data: Record<string, any>; errors?: Array<{ message: string }> });
  }

  const riskInput = { scope: 'TEAM', scopeId: '', key: 'risk', label: 'Risk', type: 'ENUM', options: [{ value: 'low' }, { value: 'high' }], appliesTo: { kinds: ['ISSUE'] }, reason: 'track risk' };

  it('a team Owner defines a field over GraphQL; a team Member is refused', async () => {
    const set = await graphql(SET_MUTATION, { input: { ...riskInput, scopeId: team.id } });
    expect(set.errors).toBeUndefined();
    expect(set.data.fieldDefinitionSet).toMatchObject({ success: true, definition: { key: 'risk', version: 1, type: 'ENUM', options: [{ value: 'low' }, { value: 'high' }], appliesTo: { kinds: ['ISSUE'], types: ['any'] } } });
    // A team Member (not Owner, not Admin) cannot define fields.
    const member = await prisma.user.create({ data: { name: 'Member', email: `member-${Date.now()}@example.com`, actorKind: 'HUMAN' } });
    await prisma.teamMembership.create({ data: { role: 'EDITOR', teamId: team.id, userId: member.id } });
    const refused = await graphql(SET_MUTATION, { input: { ...riskInput, key: 'other', scopeId: team.id } }, member.id);
    expect(refused.errors?.[0]?.message).toMatch(/do not have access to manage this team/);
    expect(await prisma.fieldDefinition.count({ where: { key: 'other' } })).toBe(0);
  });

  it('an agent writes values through MCP, reads them in work_get_context and the issue page query, and lists the team fields', async () => {
    await graphql(SET_MUTATION, { input: { ...riskInput, scopeId: team.id } });
    await graphql(SET_MUTATION, { input: { ...riskInput, scopeId: team.id, key: 'customer', label: 'Customer', type: 'TEXT', options: null, required: true } });
    const proposed = await callTool('work_propose', { team: DEFAULT_TEAM_KEY, title: 'Risky change', description: DESCRIPTION, acceptance: 'a', parent_id: milestoneId, attributes: { risk: 'high' } });
    expect(proposed.error).toBeUndefined();
    expect(proposed.attributes).toEqual({ risk: 'high' });
    expect(proposed.warning).toMatch(/Required fields still empty: customer \(Customer\)/);
    expect((await callTool('work_propose', { team: DEFAULT_TEAM_KEY, title: 'Bad', description: DESCRIPTION, acceptance: 'a', parent_id: milestoneId, attributes: { risk: 'medium' } })).error).toMatch(/not one of its options/);

    const updated = await callTool('work_update', { id: proposed.id, expected_revision: proposed.revision, attributes: { customer: 'Acme', risk: null } });
    expect(updated.error).toBeUndefined();
    const context = await callTool('work_get_context', { id: proposed.identifier });
    expect(context.attributes).toEqual({ customer: 'Acme' });
    expect(context.field_definitions.map((item: { key: string }) => item.key)).toEqual(['customer', 'risk']);

    const read = await graphql(ISSUE_QUERY, { id: proposed.id });
    expect(read.data.issue).toMatchObject({ attributes: { customer: 'Acme' }, fieldDefinitions: [{ key: 'customer', required: true, type: 'TEXT' }, { key: 'risk', type: 'ENUM' }] });

    const catalog = await callTool('work_catalog', { kind: 'fields', team_id: DEFAULT_TEAM_KEY });
    expect(catalog.team.map((item: { key: string }) => item.key)).toEqual(['customer', 'risk']);
    expect(catalog.workspace).toEqual([]);
  });

  it('an agent may write attributes on committed work (they are not contract fields)', async () => {
    await graphql(SET_MUTATION, { input: { ...riskInput, scopeId: team.id } });
    const work = await createIssue(prisma, { teamId: team.id, title: 'Committed', parentId: milestoneId, repository: 'test/fields', acceptance: 'a', assigneeId: human.id }, writeActorFromViewer(human, 'test'));
    const updated = await callTool('work_update', { id: work.id, expected_revision: work.revision, attributes: { risk: 'low' } });
    expect(updated.error).toBeUndefined();
    expect((await prisma.issue.findUniqueOrThrow({ where: { id: work.id } })).attributes).toEqual({ risk: 'low' });
  });
});
