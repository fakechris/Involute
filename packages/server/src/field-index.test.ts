import type { PrismaClient, Team, User } from '@prisma/client';
import { PrismaClient as PrismaClientConstructor } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ADMIN_EMAIL, DEFAULT_TEAM_KEY, resetAndSeed } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import {
  FIELD_AUDIT, countFieldUsage, deactivateFieldDefinition, indexJobFor, indexRowsFor, isStaleDefinition, renameFieldDefinition, runFieldIndexJobs, setFieldDefinition,
} from './field-definitions.ts';
import { startServer, type StartedServer } from './index.ts';
import { createIssue, updateIssue } from './issue-service.ts';
import { createSession } from './session.js';
import { writeActorFromViewer } from './work-service.ts';
import { WORKSPACE_SETTINGS_ID } from './workspace-access.ts';

// INV-1504: FieldValueIndex for searchable fields, its backfill / cleanup job, rename, usage.
loadProjectEnvironment();
const prisma: PrismaClient = new PrismaClientConstructor();

describe('index helpers (pure)', () => {
  it('maps each type to typed rows', () => {
    expect(indexRowsFor({ key: 'n', type: 'NUMBER' }, 3)).toEqual([{ key: 'n', numberValue: 3 }]);
    expect(indexRowsFor({ key: 'd', type: 'DATE' }, '2026-11-02T00:00:00.000Z')).toEqual([{ key: 'd', dateValue: new Date('2026-11-02T00:00:00.000Z') }]);
    expect(indexRowsFor({ key: 'b', type: 'BOOLEAN' }, false)).toEqual([{ key: 'b', textValue: 'false' }]);
    expect(indexRowsFor({ key: 'm', type: 'MULTI_ENUM' }, ['a', 'b'])).toEqual([{ key: 'm', textValue: 'a' }, { key: 'm', textValue: 'b' }]);
    expect(indexRowsFor({ key: 'r', type: 'USER_REF' }, '00000000-0000-4000-8000-000000000000')).toEqual([{ key: 'r', refId: '00000000-0000-4000-8000-000000000000' }]);
    expect(indexRowsFor({ key: 'e', type: 'ENUM' }, 'low')).toEqual([{ key: 'e', textValue: 'low' }]);
    expect(indexRowsFor({ key: 'e', type: 'ENUM' }, null)).toEqual([]);
  });

  it('decides the job from the previous version', () => {
    expect(indexJobFor(null, true)).toBe('BACKFILL');
    expect(indexJobFor(null, false)).toBeNull();
    expect(indexJobFor({ active: true, searchable: true }, true)).toBeNull();
    expect(indexJobFor({ active: true, searchable: true }, false)).toBe('CLEANUP');
    expect(indexJobFor({ active: false, searchable: true }, true)).toBe('BACKFILL');
  });

  it('calls a field stale after 90 days without a write', () => {
    const now = new Date('2026-11-02T00:00:00Z');
    const long = new Date('2026-07-01T00:00:00Z');
    expect(isStaleDefinition({ lastWrittenAt: null }, long, now)).toBe(true);
    expect(isStaleDefinition({ lastWrittenAt: new Date('2026-10-30T00:00:00Z') }, long, now)).toBe(false);
    expect(isStaleDefinition({ lastWrittenAt: null }, new Date('2026-10-01T00:00:00Z'), now)).toBe(false);
  });
});

describe('FieldValueIndex', () => {
  let admin: User;
  let team: Team;
  let milestoneId: string;
  const human = () => writeActorFromViewer(admin, 'test');

  beforeAll(async () => { await prisma.$connect(); });
  afterAll(async () => { await resetAndSeed(prisma); await prisma.$disconnect(); });
  beforeEach(async () => {
    await resetAndSeed(prisma);
    admin = await prisma.user.findUniqueOrThrow({ where: { email: DEFAULT_ADMIN_EMAIL } });
    team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
    await prisma.teamMembership.upsert({ where: { teamId_userId: { teamId: team.id, userId: admin.id } }, update: {}, create: { role: 'OWNER', teamId: team.id, userId: admin.id } });
    const project = await createIssue(prisma, { teamId: team.id, title: 'P', kind: 'PROJECT', repository: 'test/index', commitmentStatus: 'COMMITTED' }, human());
    milestoneId = (await createIssue(prisma, { teamId: team.id, title: 'M', kind: 'MILESTONE', parentId: project.id, repository: 'test/index', commitmentStatus: 'COMMITTED', acceptance: 'a' }, human())).id;
  });

  const define = (overrides: Partial<Parameters<typeof setFieldDefinition>[1]> = {}) => setFieldDefinition(prisma, {
    scope: 'TEAM', scopeId: team.id, key: 'points', label: 'Points', type: 'NUMBER', appliesTo: { kinds: ['ISSUE'] }, reason: 'estimate', ...overrides,
  }, admin.id);
  const item = (title: string, attributes?: Record<string, unknown>) => createIssue(prisma, { teamId: team.id, title, parentId: milestoneId, repository: 'test/index', acceptance: 'a', ...(attributes ? { attributes } : {}) }, human());
  const rows = (key: string) => prisma.fieldValueIndex.findMany({ where: { key }, orderBy: [{ numberValue: 'asc' }, { textValue: 'asc' }] });

  it('writes typed rows with each value of a searchable field, follows updates and clears, and stamps the last write', async () => {
    const before = new Date();
    await define({ searchable: true });
    await define({ key: 'tags', label: 'Tags', type: 'MULTI_ENUM', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], searchable: true });
    await define({ key: 'note', label: 'Note', type: 'TEXT' });
    await runFieldIndexJobs(prisma); // nothing holds a value yet
    const first = await item('One', { points: 3, tags: ['a', 'b'], note: 'not indexed' });
    await item('Two', { points: 5 });
    expect((await rows('points')).map((row) => row.numberValue)).toEqual([3, 5]);
    expect((await rows('tags')).map((row) => row.textValue)).toEqual(['a', 'b']);
    expect(await rows('note')).toEqual([]);
    await updateIssue(prisma, first.id, { attributes: { points: 8, tags: null } }, human());
    expect((await rows('points')).map((row) => row.numberValue)).toEqual([5, 8]);
    expect(await rows('tags')).toEqual([]);
    const points = await prisma.fieldDefinition.findFirstOrThrow({ where: { key: 'points', active: true } });
    expect(points.lastWrittenAt!.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(await countFieldUsage(prisma, points)).toBe(2);
  });

  it('turning searchable on backfills existing values in batches; turning it off cleans them', async () => {
    await define();
    for (const value of [1, 2, 3, 4, 5]) await item(`Item ${value}`, { points: value });
    expect(await rows('points')).toEqual([]);
    const on = await define({ searchable: true });
    expect(on.indexJob).toBe('BACKFILL');
    await runFieldIndexJobs(prisma, 2);
    let state = await prisma.fieldDefinition.findUniqueOrThrow({ where: { id: on.id } });
    expect(state).toMatchObject({ indexJob: 'BACKFILL', indexProcessed: 2 });
    await runFieldIndexJobs(prisma, 2);
    await runFieldIndexJobs(prisma, 2);
    state = await prisma.fieldDefinition.findUniqueOrThrow({ where: { id: on.id } });
    expect(state).toMatchObject({ indexJob: null, indexProcessed: 5 });
    expect((await rows('points')).map((row) => row.numberValue)).toEqual([1, 2, 3, 4, 5]);

    const off = await define({ searchable: false });
    expect(off.indexJob).toBe('CLEANUP');
    await runFieldIndexJobs(prisma);
    expect(await rows('points')).toEqual([]);
    expect((await prisma.fieldDefinition.findUniqueOrThrow({ where: { id: off.id } })).indexJob).toBeNull();
  });

  it('deactivating a searchable field cleans its rows but keeps values; reactivating backfills them', async () => {
    await define({ searchable: true });
    const work = await item('One', { points: 2 });
    await deactivateFieldDefinition(prisma, { scope: 'TEAM', scopeId: team.id, key: 'points', reason: 'retire' }, admin.id);
    await runFieldIndexJobs(prisma);
    expect(await rows('points')).toEqual([]);
    expect((await prisma.issue.findUniqueOrThrow({ where: { id: work.id } })).attributes).toEqual({ points: 2 });
    const back = await define({ searchable: true });
    expect(back.indexJob).toBe('BACKFILL');
    await runFieldIndexJobs(prisma);
    expect((await rows('points')).map((row) => row.numberValue)).toEqual([2]);
  });

  it('leaves an item to a nearer definition of the same key', async () => {
    await define({ searchable: true });
    const project = await prisma.issue.findFirstOrThrow({ where: { kind: 'PROJECT', repository: 'test/index' } });
    await setFieldDefinition(prisma, { scope: 'PROJECT', scopeId: project.id, key: 'points', label: 'Project points', type: 'NUMBER', appliesTo: { kinds: ['ISSUE'] }, reason: 'override', searchable: false }, admin.id);
    await item('Governed by the project', { points: 4 });
    // Workspace backfill must not index an item a nearer, non-searchable definition governs.
    await setFieldDefinition(prisma, { scope: 'WORKSPACE', scopeId: WORKSPACE_SETTINGS_ID, key: 'points', label: 'W points', type: 'NUMBER', appliesTo: { kinds: ['ISSUE'] }, reason: 'w', searchable: true }, admin.id);
    await runFieldIndexJobs(prisma);
    expect(await rows('points')).toEqual([]);
  });

  it('renames a key: values and rows move, the old key is still accepted once, the change is audited', async () => {
    const startedAt = new Date();
    await define({ searchable: true });
    const work = await item('One', { points: 3 });
    const renamed = await renameFieldDefinition(prisma, { scope: 'TEAM', scopeId: team.id, from: 'points', to: 'story_points', reason: 'clearer' }, admin.id);
    expect(renamed).toMatchObject({ key: 'story_points', previousKey: 'points', searchable: true, active: true });
    expect((await prisma.issue.findUniqueOrThrow({ where: { id: work.id } })).attributes).toEqual({ story_points: 3 });
    expect((await rows('story_points')).map((row) => row.numberValue)).toEqual([3]);
    // The old key writes to the new one.
    expect((await updateIssue(prisma, work.id, { attributes: { points: 5 } }, human())).attributes).toEqual({ story_points: 5 });
    await expect(renameFieldDefinition(prisma, { scope: 'TEAM', scopeId: team.id, from: 'story_points', to: 'points', reason: 'back' }, admin.id)).rejects.toThrow(/already used/);
    await expect(renameFieldDefinition(prisma, { scope: 'TEAM', scopeId: team.id, from: 'story_points', to: 'x2', reason: ' ' }, admin.id)).rejects.toThrow(/needs a reason/);
    expect(await prisma.opsAudit.count({ where: { action: FIELD_AUDIT.changed, createdAt: { gte: startedAt }, details: { path: ['renamed', 'to'], equals: 'story_points' } } })).toBe(1);
    // The next version drops the alias.
    const next = await define({ key: 'story_points', label: 'Story points', searchable: true });
    expect(next.previousKey).toBeNull();
    await expect(updateIssue(prisma, work.id, { attributes: { points: 1 } }, human())).rejects.toThrow(/not defined/);
  });
});

const QUERY = /* GraphQL */ `
  query Fields($scope: AutonomyScope!, $scopeId: String!) {
    fieldLimits { activePerScope enumOptions staleDays }
    fieldDefinitions(scope: $scope, scopeId: $scopeId, includeInactive: true) { key active usageCount stale indexJob indexProcessed lastWrittenAt previousKey }
  }
`;
const RENAME = /* GraphQL */ `
  mutation Rename($input: FieldDefinitionRenameInput!) { fieldDefinitionRename(input: $input) { success message definition { key previousKey } } }
`;
const SET = /* GraphQL */ `
  mutation SetField($input: FieldDefinitionSetInput!) { fieldDefinitionSet(input: $input) { success message } }
`;

describe('Fields settings over GraphQL (INV-1504)', () => {
  let team: Team;
  let human: User;
  let server: StartedServer;

  beforeAll(async () => { await prisma.$connect(); });
  afterAll(async () => { await resetAndSeed(prisma); await prisma.$disconnect(); });
  beforeEach(async () => {
    await resetAndSeed(prisma);
    team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
    human = await prisma.user.findUniqueOrThrow({ where: { email: DEFAULT_ADMIN_EMAIL } });
    await prisma.teamMembership.upsert({ where: { teamId_userId: { teamId: team.id, userId: human.id } }, update: {}, create: { role: 'OWNER', teamId: team.id, userId: human.id } });
    server = await startServer({ allowAdminFallback: true, prisma, authToken: 'unused-static-token', port: 0 });
  });
  afterEach(async () => { await server.stop(); });

  async function graphql(query: string, variables: Record<string, unknown>, userId?: string) {
    const session = await createSession(prisma, userId ?? human.id, 3600);
    const response = await fetch(`${server.url}/graphql`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: `involute_session=${session.token}` }, body: JSON.stringify({ query, variables }) });
    return await response.json() as { data: Record<string, any> | null; errors?: Array<{ message: string }> };
  }

  it('lists limits, usage, staleness and retired fields; renames; a Member cannot define a workspace field', async () => {
    const actor = writeActorFromViewer(human, 'test');
    await setFieldDefinition(prisma, { scope: 'TEAM', scopeId: team.id, key: 'risk', label: 'Risk', type: 'TEXT', appliesTo: { kinds: ['ISSUE'] }, reason: 'r' }, human.id);
    await setFieldDefinition(prisma, { scope: 'TEAM', scopeId: team.id, key: 'old', label: 'Old', type: 'TEXT', appliesTo: { kinds: ['ISSUE'] }, reason: 'r' }, human.id);
    await deactivateFieldDefinition(prisma, { scope: 'TEAM', scopeId: team.id, key: 'old', reason: 'gone' }, human.id);
    const project = await createIssue(prisma, { teamId: team.id, title: 'P', kind: 'PROJECT', repository: 'test/gql', commitmentStatus: 'COMMITTED' }, actor);
    await createIssue(prisma, { teamId: team.id, title: 'W', parentId: project.id, repository: 'test/gql', acceptance: 'a', attributes: { risk: 'high' } }, actor);

    const read = await graphql(QUERY, { scope: 'TEAM', scopeId: team.id });
    expect(read.errors).toBeUndefined();
    expect(read.data!.fieldLimits).toEqual({ activePerScope: 30, enumOptions: 50, staleDays: 90 });
    expect(read.data!.fieldDefinitions).toMatchObject([
      { key: 'old', active: false, usageCount: 0, stale: false },
      { key: 'risk', active: true, usageCount: 1, stale: false, indexJob: null },
    ]);

    const renamed = await graphql(RENAME, { input: { scope: 'TEAM', scopeId: team.id, from: 'risk', to: 'delivery_risk', reason: 'clearer' } });
    expect(renamed.data!.fieldDefinitionRename).toMatchObject({ success: true, definition: { key: 'delivery_risk', previousKey: 'risk' } });
    const after = await graphql(QUERY, { scope: 'TEAM', scopeId: team.id });
    expect(after.data!.fieldDefinitions.map((row: { key: string }) => row.key)).toEqual(['delivery_risk', 'old']);

    const member = await prisma.user.create({ data: { name: 'Member', email: `member-${Date.now()}@example.com`, actorKind: 'HUMAN' } });
    await prisma.teamMembership.create({ data: { role: 'EDITOR', teamId: team.id, userId: member.id } });
    const refused = await graphql(SET, { input: { scope: 'WORKSPACE', scopeId: WORKSPACE_SETTINGS_ID, key: 'area', label: 'Area', type: 'TEXT', appliesTo: { kinds: ['ISSUE'] }, reason: 'w' } }, member.id);
    expect(refused.errors?.[0]?.message ?? refused.data?.fieldDefinitionSet?.message).toBeTruthy();
    expect(await prisma.fieldDefinition.count({ where: { key: 'area' } })).toBe(0);
  });
});
