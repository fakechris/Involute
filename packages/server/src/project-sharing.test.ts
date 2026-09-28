import { PrismaClient as PrismaClientConstructor } from '@prisma/client';
import type { Issue, User } from '@prisma/client';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_TEAM_KEY, resetAndSeed } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import {
  assertCanReadIssue,
  assertCanWriteIssue,
  buildReadableIssueWhere,
  buildReadableTeamWhere,
} from './access-control.ts';
import type { GraphQLContext } from './auth.ts';
import { proposeWork } from './claim-service.ts';
import { TEAM_MANAGE_FORBIDDEN_MESSAGE, TEAM_WRITE_FORBIDDEN_MESSAGE, WORK_SHARE_NOT_PROJECT_MESSAGE } from './errors.ts';
import { startServer, type StartedServer } from './index.ts';
import { removeWorkShare, resolveShareScope, upsertWorkShare } from './project-sharing.ts';
import { SESSION_COOKIE_NAME, createSession } from './session.ts';

loadProjectEnvironment();

const prisma = new PrismaClientConstructor();

const DESCRIPTION = [
  '### 1. 目标与架构定位',
  '分享测试夹具。',
  '### 2. 核心功能与交付范围',
  '仅测试。',
  '### 3. 验收标准与验证方案',
  'vitest 通过。',
].join('\n');

interface Fixture {
  admin: User;
  /** The PROJECT node for the lumenbox repository. */
  project: Issue;
  /** CONTAINED by the project via parentId. */
  child: Issue;
  /** Same repository, not linked to the node: the board's older notion of the project. */
  sibling: Issue;
  /** Another project in the same team; must stay invisible. */
  other: Issue;
  /** A human on no team at all. */
  outsider: User;
  teamId: string;
}

async function buildFixture(): Promise<Fixture> {
  const admin = await prisma.user.findFirstOrThrow({ where: { actorKind: 'HUMAN', globalRole: 'ADMIN' } });
  const team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
  await prisma.team.update({ where: { id: team.id }, data: { visibility: 'PRIVATE' } });
  const by = { actorId: admin.id, actorKind: 'HUMAN' as const, surface: 'test' };

  const project = await proposeWork(prisma, { description: DESCRIPTION, kind: 'PROJECT', teamId: team.id, title: 'lumenbox' }, by);
  await prisma.issue.update({ where: { id: project.id }, data: { repository: 'fakechris/lumenbox' } });
  const child = await proposeWork(prisma, { description: DESCRIPTION, parentId: project.id, teamId: team.id, title: 'Inside the project' }, by);
  const sibling = await proposeWork(prisma, { description: DESCRIPTION, teamId: team.id, title: 'Same repository' }, by);
  await prisma.issue.update({ where: { id: sibling.id }, data: { repository: 'fakechris/lumenbox' } });
  const other = await proposeWork(prisma, { description: DESCRIPTION, teamId: team.id, title: 'Elsewhere in the team' }, by);
  await prisma.issue.update({ where: { id: other.id }, data: { repository: 'fakechris/involute' } });

  const outsider = await prisma.user.create({
    data: { actorKind: 'HUMAN', email: 'outsider@example.invalid', name: 'Outsider' },
  });

  return {
    admin,
    child,
    other,
    outsider,
    project: await prisma.issue.findUniqueOrThrow({ where: { id: project.id } }),
    sibling,
    teamId: team.id,
  };
}

async function contextFor(viewer: User): Promise<GraphQLContext> {
  return {
    authMode: 'session',
    isTrustedSystem: false,
    prisma,
    shareScope: await resolveShareScope(prisma, viewer.id),
    viewer,
  };
}

async function readableIdentifiers(context: GraphQLContext): Promise<string[]> {
  const where = buildReadableIssueWhere(context);
  const rows = await prisma.issue.findMany({ where, select: { identifier: true }, orderBy: { identifier: 'asc' } });
  return rows.map((row) => row.identifier);
}

describe('project sharing (INV-832)', () => {
  let f: Fixture;

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await resetAndSeed(prisma);
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetAndSeed(prisma);
    f = await buildFixture();
  });

  it('an outsider reads nothing in a private team until a project is shared, then exactly the project scope', async () => {
    const before = await contextFor(f.outsider);
    expect(await readableIdentifiers(before)).toEqual([]);
    expect(await prisma.team.findMany({ where: buildReadableTeamWhere(before) })).toHaveLength(0);

    await upsertWorkShare(prisma, {
      actor: { actorId: f.admin.id, actorKind: 'HUMAN', surface: 'test' },
      role: 'VIEWER',
      userId: f.outsider.id,
      workId: f.project.id,
    });

    const after = await contextFor(f.outsider);
    expect(await readableIdentifiers(after)).toEqual(
      [f.project.identifier, f.child.identifier, f.sibling.identifier].sort(),
    );
    // The team is visible so the board can render, but only the team.
    const teams = await prisma.team.findMany({ where: buildReadableTeamWhere(after), select: { id: true } });
    expect(teams.map((team) => team.id)).toEqual([f.teamId]);
    await expect(assertCanReadIssue(prisma, after, f.child.id)).resolves.toBeUndefined();
    await expect(assertCanReadIssue(prisma, after, f.other.id)).rejects.toThrow();
  });

  it('VIEWER may not write; EDITOR may write inside the scope and nowhere else', async () => {
    const actor = { actorId: f.admin.id, actorKind: 'HUMAN' as const, surface: 'test' };
    await upsertWorkShare(prisma, { actor, role: 'VIEWER', userId: f.outsider.id, workId: f.project.id });
    const viewer = await contextFor(f.outsider);
    await expect(assertCanWriteIssue(prisma, viewer, f.child.id)).rejects.toThrow(TEAM_WRITE_FORBIDDEN_MESSAGE);

    await upsertWorkShare(prisma, { actor, role: 'EDITOR', userId: f.outsider.id, workId: f.project.id });
    const editor = await contextFor(f.outsider);
    await expect(assertCanWriteIssue(prisma, editor, f.child.id)).resolves.toBeUndefined();
    await expect(assertCanWriteIssue(prisma, editor, f.sibling.id)).resolves.toBeUndefined();
    await expect(assertCanWriteIssue(prisma, editor, f.other.id)).rejects.toThrow(TEAM_WRITE_FORBIDDEN_MESSAGE);

    // One row per (project, user): the role change updated it in place.
    expect(await prisma.workShare.count({ where: { userId: f.outsider.id } })).toBe(1);
  });

  it('removing the share takes the scope away again, and each change is on the project audit trail', async () => {
    const actor = { actorId: f.admin.id, actorKind: 'HUMAN' as const, surface: 'test' };
    await upsertWorkShare(prisma, { actor, role: 'VIEWER', userId: f.outsider.id, workId: f.project.id });
    await removeWorkShare(prisma, { actor, userId: f.outsider.id, workId: f.project.id });

    expect(await readableIdentifiers(await contextFor(f.outsider))).toEqual([]);
    const audits = await prisma.workAudit.findMany({ where: { workId: f.project.id }, orderBy: { createdAt: 'asc' } });
    const reasons = audits.map((row) => row.reason).filter(Boolean);
    expect(reasons).toEqual([
      'shared with Outsider as VIEWER',
      'share for Outsider removed',
    ]);
  });

  it('only a PROJECT node can be shared', async () => {
    await expect(upsertWorkShare(prisma, {
      actor: { actorId: f.admin.id, actorKind: 'HUMAN', surface: 'test' },
      role: 'VIEWER',
      userId: f.outsider.id,
      workId: f.child.id,
    })).rejects.toThrow(WORK_SHARE_NOT_PROJECT_MESSAGE);
  });

  describe('over GraphQL', () => {
    let server: StartedServer | null = null;

    afterEach(async () => {
      await server?.stop();
      server = null;
    });

    async function graphql(user: User, query: string, variables: Record<string, unknown>) {
      server ??= await startServer({ allowAdminFallback: false, authToken: 'unused-test-token', port: 0, prisma });
      const session = await createSession(prisma, user.id);
      const response = await fetch(`${server.url}/graphql`, {
        body: JSON.stringify({ query, variables }),
        headers: { 'content-type': 'application/json', cookie: `${SESSION_COOKIE_NAME}=${session.token}` },
        method: 'POST',
      });
      return response.json() as Promise<{ data: any; errors?: Array<{ message: string }> }>;
    }

    const UPSERT = `
      mutation Share($workId: String!, $userId: String!, $role: WorkShareRole!) {
        workShareUpsert(workId: $workId, userId: $userId, role: $role) {
          success
          message
          share { role user { id } }
        }
      }
    `;

    it('a team OWNER shares and sees the list; the shared user sees the project and not the shares', async () => {
      const shared = await graphql(f.admin, UPSERT, { role: 'VIEWER', userId: f.outsider.id, workId: f.project.identifier });
      expect(shared.errors).toBeUndefined();
      expect(shared.data.workShareUpsert).toMatchObject({ success: true, share: { role: 'VIEWER', user: { id: f.outsider.id } } });

      const asAdmin = await graphql(f.admin, `query { issue(id: "${f.project.id}") { shares { role user { id } } } }`, {});
      expect(asAdmin.data.issue.shares).toHaveLength(1);

      const asOutsider = await graphql(
        f.outsider,
        `query { issue(id: "${f.project.id}") { identifier shares { role } } other: issue(id: "${f.other.id}") { identifier } }`,
        {},
      );
      expect(asOutsider.data.issue).toMatchObject({ identifier: f.project.identifier, shares: [] });
      expect(asOutsider.data.other).toBeNull();
    });

    it('someone who cannot manage the team cannot share it', async () => {
      const first = await graphql(f.admin, UPSERT, { role: 'EDITOR', userId: f.outsider.id, workId: f.project.identifier });
      expect(first.data.workShareUpsert.success).toBe(true);

      const second = await prisma.user.create({ data: { actorKind: 'HUMAN', email: 'second@example.invalid', name: 'Second' } });
      const denied = await graphql(f.outsider, UPSERT, { role: 'VIEWER', userId: second.id, workId: f.project.identifier });
      // Managing a team is FORBIDDEN, not a soft failure: the error is surfaced, not folded into success=false.
      expect(denied.data).toBeNull();
      expect(denied.errors?.[0]?.message).toBe(TEAM_MANAGE_FORBIDDEN_MESSAGE);
      expect(await prisma.workShare.count({ where: { userId: second.id } })).toBe(0);
    });
  });
});
