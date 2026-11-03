import type { PrismaClient, Team, User } from '@prisma/client';
import { PrismaClient as PrismaClientConstructor } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ADMIN_EMAIL, DEFAULT_TEAM_KEY, resetAndSeed } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import { SAVED_VIEW_INVALID_MESSAGE, SAVED_VIEW_NOT_FOUND_MESSAGE, createNotFoundError, createValidationError, getExposedError } from './errors.ts';
import { setFieldDefinition } from './field-definitions.ts';
import { startServer, type StartedServer } from './index.ts';
import { createIssue } from './issue-service.ts';
import { createSession } from './session.js';
import { writeActorFromViewer } from './work-service.ts';

// INV-1534: a refusal written for people reaches them through GraphQL, even
// when it names the item it is about; unexpected errors stay masked.
loadProjectEnvironment();
const prisma: PrismaClient = new PrismaClientConstructor();

const UPDATE = /* GraphQL */ `
  mutation Update($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success message } }
`;

describe('refusals people can read (INV-1534)', () => {
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

  async function update(id: string, input: Record<string, unknown>) {
    const session = await createSession(prisma, human.id, 3600);
    const response = await fetch(`${server.url}/graphql`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: `involute_session=${session.token}` }, body: JSON.stringify({ query: UPDATE, variables: { id, input } }) });
    return (await response.json() as { data: { issueUpdate: { success: boolean; message: string | null } } }).data.issueUpdate;
  }

  it('moving a delivery unit or its package to Done says which package to accept and where', async () => {
    const actor = writeActorFromViewer(human, 'test');
    const done = await prisma.workflowState.findFirstOrThrow({ where: { teamId: team.id, type: 'COMPLETED' } });
    const project = await createIssue(prisma, { teamId: team.id, title: 'P', kind: 'PROJECT', repository: 'test/refusal', commitmentStatus: 'COMMITTED' }, actor);
    const root = await createIssue(prisma, { teamId: team.id, title: 'Package', parentId: project.id, repository: 'test/refusal', acceptance: 'a' }, actor);
    await prisma.deliveryPackage.create({ data: { workId: root.id, policy: {}, contractDigest: 'x', approvedById: human.id } });
    const unit = await createIssue(prisma, { teamId: team.id, title: 'Unit', parentId: root.id, repository: 'test/refusal', acceptance: 'a' }, actor);
    await prisma.issue.update({ where: { id: unit.id }, data: { deliveryRootId: root.id } });

    expect(await update(unit.id, { stateId: done.id })).toEqual({ success: false, message: `${unit.identifier} is part of delivery package ${root.identifier}: accept ${root.identifier} from In Review; that accepts every implementation unit together.` });
    expect(await update(root.id, { stateId: done.id })).toEqual({ success: false, message: `${root.identifier} is a delivery package: accept it from In Review; that checks every implementation unit together.` });
  });

  it('a field refusal that names the field is shown as written, not as "Unexpected error."', async () => {
    const actor = writeActorFromViewer(human, 'test');
    const project = await createIssue(prisma, { teamId: team.id, title: 'P', kind: 'PROJECT', repository: 'test/refusal', commitmentStatus: 'COMMITTED' }, actor);
    const work = await createIssue(prisma, { teamId: team.id, title: 'W', parentId: project.id, repository: 'test/refusal', acceptance: 'a' }, actor);
    await setFieldDefinition(prisma, { scope: 'TEAM', scopeId: team.id, key: 'risk', label: 'Risk', type: 'ENUM', options: [{ value: 'low', label: 'Low' }], appliesTo: { kinds: ['ISSUE'] }, reason: 'r' }, human.id);
    expect(await update(work.id, { attributes: { risk: 'high' } })).toEqual({ success: false, message: 'Field "risk": "high" is not one of its options (low).' });
  });

  it('a refused saved view says why through GraphQL, with its code (INV-1131)', async () => {
    const session = await createSession(prisma, human.id, 3600);
    const response = await fetch(`${server.url}/graphql`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: `involute_session=${session.token}` }, body: JSON.stringify({
      query: 'mutation($input: SavedViewInput!) { savedViewUpsert(input: $input) { success message } }',
      variables: { input: { teamKey: DEFAULT_TEAM_KEY, name: 'Mine', kind: 'calendar', stateJson: '{}' } },
    }) });
    const body = await response.json() as { data: { savedViewUpsert: { success: boolean; message: string | null } } };
    expect(body.data.savedViewUpsert).toEqual({ success: false, message: SAVED_VIEW_INVALID_MESSAGE });
    expect(getExposedError(createValidationError(SAVED_VIEW_INVALID_MESSAGE))?.extensions.code).toBe('BAD_USER_INPUT');
    expect(getExposedError(createNotFoundError(SAVED_VIEW_NOT_FOUND_MESSAGE))?.extensions.code).toBe('NOT_FOUND');
  });

  it('an unexpected error still masks', async () => {
    expect(getExposedError(new Error('database password is hunter2'))).toBeNull();
  });
});
