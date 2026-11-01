import type { PrismaClient, Team, User, WorkflowState } from '@prisma/client';

import { PrismaClient as PrismaClientConstructor } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ADMIN_EMAIL, DEFAULT_TEAM_KEY, seedDatabase } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import { startServer, type StartedServer } from './index.ts';
import { createSession } from './session.js';

loadProjectEnvironment();

const prisma = new PrismaClientConstructor();
const TEST_AUTH_TOKEN = 'test-auth-token';

let server: StartedServer;

const PREVIEW_QUERY = `
  query($identifiers: [String!]!) {
    issuePreviews(identifiers: $identifiers) {
      reference
      identifier
      title
      stateName
      stateType
      commitmentStatus
      priority
      kind
      repository
      teamKey
      typeLabel
      excerpt
    }
  }
`;

describe('Hover previews for references in prose (INV-1466)', () => {
  let team: Team;
  let viewer: User;
  let startedState: WorkflowState;

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.comment.deleteMany();
    await prisma.issue.deleteMany();
    await prisma.workflowState.deleteMany();
    await prisma.team.deleteMany();
    await prisma.issueLabel.deleteMany();
    // ActorAudit references users with Restrict (INV-586/604): it goes first.
    await prisma.actorAudit.deleteMany();
    await prisma.user.deleteMany();
    await prisma.legacyLinearMapping.deleteMany();
    await seedDatabase(prisma);

    team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
    viewer = await prisma.user.findUniqueOrThrow({ where: { email: DEFAULT_ADMIN_EMAIL } });
    startedState = await prisma.workflowState.findFirstOrThrow({
      where: { teamId: team.id, type: 'STARTED' },
    });

    server = await startServer({
      allowAdminFallback: true,
      prisma,
      authToken: TEST_AUTH_TOKEN,
      port: 0,
    });

    const base = { teamId: team.id, commitmentStatus: 'COMMITTED' as const };
    await prisma.issue.create({
      data: {
        ...base,
        identifier: 'INV-1',
        stateId: startedState.id,
        title: 'Fact window filter for the timeline',
        description: '### 1. 目标与架构定位\n时间轴按已记录事件收窄。',
        priority: 2,
      },
    });
    // The lumenbox project's own item: the alias prefix points at it.
    await prisma.issue.create({
      data: {
        ...base,
        identifier: 'INV-2',
        stateId: startedState.id,
        title: 'Lumenbox work item',
        priority: 3,
        repository: 'fakechris/lumenbox',
      },
    });
    // The project that carries the alias (INV-459, INV-793).
    await prisma.issue.create({
      data: {
        ...base,
        identifier: 'INV-3',
        kind: 'PROJECT',
        stateId: startedState.id,
        title: 'fakechris/lumenbox',
        alias: 'LUM',
        repository: 'fakechris/lumenbox',
      },
    });
    // An item in another repository: the alias does not speak for it.
    await prisma.issue.create({
      data: {
        ...base,
        identifier: 'INV-4',
        stateId: startedState.id,
        title: 'Somebody else’s item',
        priority: 1,
        repository: 'fakechris/other',
      },
    });
  });

  afterEach(async () => {
    await server.stop();
  });

  async function postGraphQL(query: string, variables?: Record<string, unknown>, cookie?: string) {
    const response = await fetch(`${server.url}/graphql`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TEST_AUTH_TOKEN}`,
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify({ query, variables }),
    });
    return { body: (await response.json()) as any, status: response.status };
  }

  it('resolves a reference to the item it names', async () => {
    const result = await postGraphQL(PREVIEW_QUERY, { identifiers: ['INV-1'] });

    expect(result.body.errors).toBeUndefined();
    const previews = result.body.data.issuePreviews as Array<Record<string, unknown>>;
    expect(previews).toHaveLength(1);
    expect(previews[0]).toMatchObject({
      reference: 'INV-1',
      identifier: 'INV-1',
      title: 'Fact window filter for the timeline',
      stateType: 'STARTED',
      commitmentStatus: 'COMMITTED',
      priority: 2,
      kind: 'ISSUE',
      teamKey: DEFAULT_TEAM_KEY,
    });
    // The excerpt is the description without its markdown scaffolding.
    expect(previews[0]!.excerpt).toContain('时间轴按已记录事件收窄');
    expect(previews[0]!.excerpt).not.toContain('###');
  });

  it('reads references in any case and ignores what is not a reference', async () => {
    const result = await postGraphQL(PREVIEW_QUERY, { identifiers: ['inv-1', 'UTF-8', 'ISO-8601', 'not-a-reference'] });

    expect(result.body.errors).toBeUndefined();
    const previews = result.body.data.issuePreviews as Array<Record<string, unknown>>;
    expect(previews.map((preview) => preview.reference)).toEqual(['INV-1']);
  });

  it('resolves a project alias to the item it stands for', async () => {
    const result = await postGraphQL(PREVIEW_QUERY, { identifiers: ['LUM-2'] });

    expect(result.body.errors).toBeUndefined();
    const previews = result.body.data.issuePreviews as Array<Record<string, unknown>>;
    expect(previews).toHaveLength(1);
    // The reference keeps the prefix the reader typed; the item is canonical.
    expect(previews[0]).toMatchObject({ reference: 'LUM-2', identifier: 'INV-2', title: 'Lumenbox work item' });
  });

  it('does not let an alias speak for an item outside its project', async () => {
    const result = await postGraphQL(PREVIEW_QUERY, { identifiers: ['LUM-4'] });

    expect(result.body.errors).toBeUndefined();
    expect(result.body.data.issuePreviews).toEqual([]);
  });

  it('returns nothing for references nobody knows', async () => {
    const result = await postGraphQL(PREVIEW_QUERY, { identifiers: ['INV-9999'] });

    expect(result.body.errors).toBeUndefined();
    expect(result.body.data.issuePreviews).toEqual([]);
  });

  it('hides work the reader may not read', async () => {
    const otherTeam = await prisma.team.create({ data: { key: 'OTH', name: 'Other team' } });
    const otherState = await prisma.workflowState.create({
      data: { teamId: otherTeam.id, name: 'Ready', type: 'UNSTARTED', position: 1 },
    });
    await prisma.issue.create({
      data: {
        teamId: otherTeam.id,
        commitmentStatus: 'COMMITTED',
        identifier: 'OTH-1',
        stateId: otherState.id,
        title: 'Another team’s item',
        priority: 2,
      },
    });

    const reader = await prisma.user.create({
      data: { email: 'reader@example.com', name: 'Reader', globalRole: 'USER' },
    });
    await prisma.teamMembership.create({ data: { teamId: team.id, userId: reader.id, role: 'EDITOR' } });
    const session = await createSession(prisma, reader.id, 60 * 60);
    const cookie = `involute_session=${encodeURIComponent(session.token)}`;

    const result = await postGraphQL(PREVIEW_QUERY, { identifiers: ['INV-1', 'OTH-1'] }, cookie);

    expect(result.body.errors).toBeUndefined();
    const previews = result.body.data.issuePreviews as Array<Record<string, unknown>>;
    expect(previews.map((preview) => preview.reference)).toEqual(['INV-1']);
  });
});
