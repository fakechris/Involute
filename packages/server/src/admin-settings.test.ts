import { PrismaClient as PrismaClientConstructor } from '@prisma/client';
import type { Team } from '@prisma/client';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ADMIN_EMAIL, DEFAULT_TEAM_KEY, resetAndSeed } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import {
  assertSettingsAdmin,
  createLabel,
  createWorkflowState,
  deleteLabel,
  deleteWorkflowState,
  listServerFeatures,
  renameLabel,
  setGlobalRole,
  updateWorkflowState,
} from './admin-settings.ts';
import {
  GLOBAL_ROLE_LAST_ADMIN_MESSAGE,
  GLOBAL_ROLE_TARGET_HUMAN_MESSAGE,
  LABEL_NAME_TAKEN_MESSAGE,
  LABEL_PROTECTED_MESSAGE,
  LABEL_TYPE_NAME_RESERVED_MESSAGE,
  SETTINGS_ADMIN_ONLY_MESSAGE,
  WORKFLOW_STATE_IN_USE_MESSAGE,
  WORKFLOW_STATE_LAST_OF_TYPE_MESSAGE,
  WORKFLOW_STATE_NAME_INVALID_MESSAGE,
} from './errors.ts';
import { startServer, type StartedServer } from './index.ts';

loadProjectEnvironment();

const prisma = new PrismaClientConstructor();

// INV-797: settings a person used to change with SQL, env edits or the CLI.
describe('workspace settings (INV-797)', () => {
  let team: Team;

  beforeAll(async () => { await prisma.$connect(); });
  afterAll(async () => { await resetAndSeed(prisma); await prisma.$disconnect(); });
  beforeEach(async () => {
    await resetAndSeed(prisma);
    team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
  });

  it('lets admins, and only admins, change settings', () => {
    const person = (globalRole: 'ADMIN' | 'USER', actorKind: 'HUMAN' | 'AGENT' = 'HUMAN') => ({
      viewer: { actorKind, globalRole, id: 'u' },
    });
    expect(() => assertSettingsAdmin(person('ADMIN'))).not.toThrow();
    expect(() => assertSettingsAdmin({ isTrustedSystem: true })).not.toThrow();
    expect(() => assertSettingsAdmin(person('USER'))).toThrow(SETTINGS_ADMIN_ONLY_MESSAGE);
    expect(() => assertSettingsAdmin(person('ADMIN', 'AGENT'))).toThrow(SETTINGS_ADMIN_ONLY_MESSAGE);
    expect(() => assertSettingsAdmin({ viewer: null })).toThrow(SETTINGS_ADMIN_ONLY_MESSAGE);
  });

  describe('labels', () => {
    it('creates, renames and deletes; names ignore case', async () => {
      const label = await createLabel(prisma, '  frontend ');
      expect(label.name).toBe('frontend');
      await expect(createLabel(prisma, 'Frontend')).rejects.toThrow(LABEL_NAME_TAKEN_MESSAGE);

      const renamed = await renameLabel(prisma, label.id, 'web');
      expect(renamed.name).toBe('web');

      const other = await createLabel(prisma, 'api');
      await expect(renameLabel(prisma, other.id, 'WEB')).rejects.toThrow(LABEL_NAME_TAKEN_MESSAGE);
    });

    it('keeps the Type group and research intact', async () => {
      const existing = async (name: string) =>
        (await prisma.issueLabel.findFirst({ where: { name: { equals: name, mode: 'insensitive' } } })) ?? createLabel(prisma, name);
      const bug = await existing('Bug');
      const research = await existing('research');
      const plain = await createLabel(prisma, 'infra');

      await expect(renameLabel(prisma, bug.id, 'Defect')).rejects.toThrow(LABEL_PROTECTED_MESSAGE);
      await expect(deleteLabel(prisma, research.id)).rejects.toThrow(LABEL_PROTECTED_MESSAGE);
      await expect(renameLabel(prisma, plain.id, 'feature')).rejects.toThrow(LABEL_TYPE_NAME_RESERVED_MESSAGE);
    });

    it('takes a deleted label off the work that carried it', async () => {
      const label = await createLabel(prisma, 'temporary');
      const state = await prisma.workflowState.findFirstOrThrow({ where: { teamId: team.id } });
      const work = await prisma.issue.create({
        data: { identifier: 'INV-9001', labels: { connect: { id: label.id } }, stateId: state.id, teamId: team.id, title: 'labelled' },
      });

      await deleteLabel(prisma, label.id);

      const after = await prisma.issue.findUniqueOrThrow({ where: { id: work.id }, include: { labels: true } });
      expect(after.labels).toEqual([]);
    });
  });

  describe('workflow states', () => {
    it('adds a state after the existing ones, so automation keeps its target state', async () => {
      const firstStarted = await prisma.workflowState.findFirstOrThrow({
        where: { teamId: team.id, type: 'STARTED' },
        orderBy: { position: 'asc' },
      });
      const blocked = await createWorkflowState(prisma, { name: 'Blocked', teamId: team.id, type: 'STARTED' });

      const target = await prisma.workflowState.findFirstOrThrow({
        where: { teamId: team.id, type: 'STARTED' },
        orderBy: { position: 'asc' },
      });
      expect(target.id).toBe(firstStarted.id);
      expect(blocked.position).toBeGreaterThan(firstStarted.position);
      await expect(createWorkflowState(prisma, { name: 'blocked', teamId: team.id, type: 'BACKLOG' }))
        .rejects.toThrow(WORKFLOW_STATE_NAME_INVALID_MESSAGE);
    });

    it('renames and reorders', async () => {
      const review = await prisma.workflowState.findFirstOrThrow({ where: { teamId: team.id, type: 'REVIEW' } });
      const updated = await updateWorkflowState(prisma, review.id, { name: 'Awaiting review', position: 40 });
      expect(updated).toMatchObject({ name: 'Awaiting review', position: 40, type: 'REVIEW' });
      await expect(updateWorkflowState(prisma, review.id, { name: '   ' })).rejects.toThrow(WORKFLOW_STATE_NAME_INVALID_MESSAGE);
    });

    it('refuses to delete a state that holds work or is the last of its type', async () => {
      const review = await prisma.workflowState.findFirstOrThrow({ where: { teamId: team.id, type: 'REVIEW' } });
      await expect(deleteWorkflowState(prisma, review.id)).rejects.toThrow(WORKFLOW_STATE_LAST_OF_TYPE_MESSAGE);

      const extra = await createWorkflowState(prisma, { name: 'Second look', teamId: team.id, type: 'REVIEW' });
      await prisma.issue.create({ data: { identifier: 'INV-9002', stateId: extra.id, teamId: team.id, title: 'held' } });
      await expect(deleteWorkflowState(prisma, extra.id)).rejects.toThrow(WORKFLOW_STATE_IN_USE_MESSAGE);

      await prisma.issue.deleteMany({ where: { stateId: extra.id } });
      await expect(deleteWorkflowState(prisma, extra.id)).resolves.toMatchObject({ id: extra.id });
    });
  });

  describe('admins', () => {
    it('grants and revokes admin for people, audited; never for agents; never the last admin', async () => {
      const admin = await prisma.user.findUniqueOrThrow({ where: { email: DEFAULT_ADMIN_EMAIL } });
      await prisma.user.updateMany({ where: { id: { not: admin.id }, globalRole: 'ADMIN' }, data: { globalRole: 'USER' } });
      const sam = await prisma.user.create({ data: { email: 'sam@test.local', name: 'Sam' } });
      const agent = await prisma.user.create({ data: { actorKind: 'AGENT', email: 'bot@agents.test', handle: 'bot', name: 'Bot' } });

      await expect(setGlobalRole(prisma, { byActorId: admin.id, role: 'USER', userId: admin.id }))
        .rejects.toThrow(GLOBAL_ROLE_LAST_ADMIN_MESSAGE);
      await expect(setGlobalRole(prisma, { byActorId: admin.id, role: 'ADMIN', userId: agent.id }))
        .rejects.toThrow(GLOBAL_ROLE_TARGET_HUMAN_MESSAGE);

      const promoted = await setGlobalRole(prisma, { byActorId: admin.id, reason: 'on call', role: 'ADMIN', userId: sam.id });
      expect(promoted.globalRole).toBe('ADMIN');
      const audit = await prisma.actorAudit.findFirstOrThrow({ where: { subjectId: sam.id, action: 'global_role.set' } });
      expect(audit).toMatchObject({ byActorId: admin.id, reason: 'on call', before: { globalRole: 'USER' }, after: { globalRole: 'ADMIN' } });

      // With two admins, either may step down.
      await expect(setGlobalRole(prisma, { byActorId: sam.id, role: 'USER', userId: admin.id })).resolves.toMatchObject({ globalRole: 'USER' });
    });
  });

  it('reports which features are on without exposing any value', () => {
    const secrets = {
      ADMIN_EMAIL_ALLOWLIST: 'a@x.test,b@x.test',
      EVIDENCE_VERIFIER_ENABLED: 'true',
      GITHUB_TOKEN: 'ghp_secret_token_value',
      GITHUB_WEBHOOK_SECRET: 'whsec_value',
      OPS_WEBHOOK_URL: 'https://hooks.example.test/T0/B0/xyz',
    };
    const features = listServerFeatures(secrets);
    const byKey = Object.fromEntries(features.map((feature) => [feature.key, feature]));

    expect(byKey.githubSync?.enabled).toBe(true);
    expect(byKey.evidenceVerifier?.enabled).toBe(true);
    expect(byKey.emailNotifications?.enabled).toBe(false);
    expect(byKey.adminEmailAllowlist?.detail).toContain('2 addresses');
    const text = JSON.stringify(features);
    for (const value of ['ghp_secret_token_value', 'whsec_value', 'hooks.example.test', 'a@x.test']) {
      expect(text).not.toContain(value);
    }
  });
});

describe('workspace settings over GraphQL (INV-797)', () => {
  let server: StartedServer;

  beforeEach(async () => {
    await resetAndSeed(prisma);
    server = await startServer({ allowAdminFallback: true, authToken: 'test-auth-token', port: 0, prisma });
  });
  afterEach(async () => { await server.stop(); });

  const post = async (query: string, variables?: Record<string, unknown>) => {
    const response = await fetch(`${server.url}/graphql`, {
      body: JSON.stringify({ query, variables }),
      headers: { authorization: 'Bearer test-auth-token', 'content-type': 'application/json' },
      method: 'POST',
    });
    return (await response.json()) as { data?: any; errors?: unknown[] };
  };

  it('serves settings, says why a change was refused, and filters work by state type', async () => {
    const features = await post('{ serverFeatures { key enabled } }');
    expect(features.errors).toBeUndefined();
    expect(features.data.serverFeatures.map((feature: { key: string }) => feature.key)).toContain('githubSync');

    const created = await post('mutation { labelCreate(name: "docs") { success message label { name issueCount } } }');
    expect(created.data.labelCreate).toEqual({ success: true, message: null, label: { name: 'docs', issueCount: 0 } });
    const duplicate = await post('mutation { labelCreate(name: "DOCS") { success message } }');
    expect(duplicate.data.labelCreate).toEqual({ success: false, message: LABEL_NAME_TAKEN_MESSAGE });

    const viewer = await post('{ viewer { emailNotifications } }');
    expect(viewer.data.viewer.emailNotifications).toBe(true);

    const team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
    const review = await prisma.workflowState.findFirstOrThrow({ where: { teamId: team.id, type: 'REVIEW' } });
    await prisma.workflowState.update({ where: { id: review.id }, data: { name: 'Awaiting review' } });
    await prisma.issue.create({ data: { identifier: 'INV-9100', stateId: review.id, teamId: team.id, title: 'in review' } });
    const byType = await post('{ issues(first: 10, filter: { state: { type: { eq: REVIEW } } }) { nodes { identifier } } }');
    expect(byType.errors).toBeUndefined();
    expect(byType.data.issues.nodes).toEqual([{ identifier: 'INV-9100' }]);
  });
});
