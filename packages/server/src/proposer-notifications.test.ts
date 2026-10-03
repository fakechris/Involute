import { PrismaClient as PrismaClientConstructor } from '@prisma/client';
import type { Team, User } from '@prisma/client';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ADMIN_EMAIL, DEFAULT_TEAM_KEY, resetAndSeed } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import { commitWork, proposeWork, rejectWork } from './claim-service.ts';
import { callMcpTool, CANDIDATE_DECISION_NOTICE } from './mcp-tools.ts';
import { projectDecisionNotifications } from './notification-service.ts';
import { testParentId } from './test-placement.ts';
import { uncommitWork } from './work-uncommit.ts';

loadProjectEnvironment();

const prisma = new PrismaClientConstructor();

// Agent proposals must carry the three-section description.
const DESCRIPTION = '### 1. 目标与架构定位\n测试\n\n### 2. 核心功能与交付范围\n测试\n\n### 3. 验收标准与验证方案\n测试';

// INV-968: a person decides on a candidate and the agent that proposed it never
// heard. The proposer is subscribed to its own proposal, the way Linear
// subscribes an issue's creator, and reads the decision in agent_inbox.
describe('the proposer hears the decision (INV-968)', () => {
  let team: Team;
  let admin: User;
  let nova: User;

  beforeAll(async () => { await prisma.$connect(); });
  afterAll(async () => { await resetAndSeed(prisma); await prisma.$disconnect(); });
  beforeEach(async () => {
    await resetAndSeed(prisma);
    team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
    admin = await prisma.user.findUniqueOrThrow({ where: { email: DEFAULT_ADMIN_EMAIL } });
    nova = await prisma.user.create({
      data: { actorKind: 'AGENT', email: 'nova@agents.test.local', handle: 'nova', name: 'nova', ownerId: admin.id },
    });
    await prisma.agentCredential.create({
      data: { name: 'nova', scopes: ['read', 'propose'], teamId: team.id, tokenHash: 'h-nova'.padEnd(24, 'x'), userId: nova.id },
    });
  });

  const asAgent = (viewer: User) => ({
    agentScopes: ['read', 'propose'],
    agentTeamId: team.id,
    authMode: 'agent-token' as const,
    isTrustedSystem: false,
    prisma,
    viewer,
  });
  const human = () => ({ actorId: admin.id, actorKind: 'HUMAN' as const, surface: 'test' });

  async function proposeAsNova(title: string) {
    return proposeWork(
      prisma,
      { description: DESCRIPTION, parentId: await testParentId(prisma, team.id), teamId: team.id, title },
      { actorId: nova.id, actorKind: 'AGENT', surface: 'mcp' },
    );
  }

  async function commitAsAdmin(id: string, revision: number) {
    return commitWork(prisma, id, { acceptance: 'it works', assigneeId: admin.id, expectedRevision: revision }, human());
  }

  it('tells the proposing agent its candidate was committed, and not the person who committed it', async () => {
    const candidate = await proposeAsNova('Say when it is committed');
    await commitAsAdmin(candidate.id, candidate.revision);

    const rows = await prisma.notification.findMany({ where: { type: 'work.committed', workId: candidate.id } });
    expect(rows.map((row) => row.userId)).toEqual([nova.id]);
  });

  it('shows the decision in agent_inbox, and notification_mark_read clears it', async () => {
    const candidate = await proposeAsNova('Read it in the inbox');
    await commitAsAdmin(candidate.id, candidate.revision);

    const inbox = (await callMcpTool(asAgent(nova), 'agent_inbox', {}, false)) as {
      notifications: Array<Record<string, unknown>>;
      requests: unknown[];
    };
    expect(inbox.requests).toEqual([]);
    expect(inbox.notifications).toHaveLength(1);
    expect(inbox.notifications[0]).toMatchObject({
      commitment_status: 'COMMITTED',
      decided_by_actor_id: admin.id,
      type: 'work.committed',
      work_identifier: candidate.identifier,
      work_title: 'Read it in the inbox',
    });

    const id = inbox.notifications[0]!.id as string;
    const marked = (await callMcpTool(asAgent(nova), 'notification_mark_read', { id }, false)) as { id: string; read_at: string | null };
    expect(marked.id).toBe(id);
    expect(marked.read_at).toBeTruthy();
    // Marking twice is harmless.
    await expect(callMcpTool(asAgent(nova), 'notification_mark_read', { id }, false)).resolves.toMatchObject({ id });

    const after = (await callMcpTool(asAgent(nova), 'agent_inbox', {}, false)) as { notifications: unknown[] };
    expect(after.notifications).toEqual([]);
  });

  it('refuses to mark another actor\'s notification', async () => {
    const candidate = await proposeAsNova('Not yours');
    await commitAsAdmin(candidate.id, candidate.revision);
    const row = await prisma.notification.findFirstOrThrow({ where: { userId: nova.id } });
    const kai = await prisma.user.create({
      data: { actorKind: 'AGENT', email: 'kai@agents.test.local', handle: 'kai', name: 'kai', ownerId: admin.id },
    });

    await expect(callMcpTool(asAgent(kai), 'notification_mark_read', { id: row.id }, false)).rejects.toThrow('Notification not found.');
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: row.id } })).readAt).toBeNull();
  });

  it('tells the proposer a candidate was declined, with the reason', async () => {
    const candidate = await proposeAsNova('Decline me');
    await rejectWork(prisma, candidate.id, { expectedRevision: candidate.revision, reason: 'Duplicate of INV-1' }, human());

    const row = await prisma.notification.findFirstOrThrow({ where: { type: 'work.rejected', userId: nova.id } });
    expect((row.payload as { reason?: string }).reason).toBe('Duplicate of INV-1');
  });

  it('tells the proposer a commit was undone', async () => {
    const candidate = await proposeAsNova('Undo me');
    const committed = await commitAsAdmin(candidate.id, candidate.revision);
    await uncommitWork(prisma, committed.id, { expectedRevision: committed.revision }, human());

    const types = (await prisma.notification.findMany({ where: { userId: nova.id }, orderBy: { createdAt: 'asc' } })).map((row) => row.type);
    expect(types).toEqual(['work.committed', 'work.uncommitted']);
  });

  it('does not tell a person about their own decision on their own proposal', async () => {
    const candidate = await proposeWork(prisma, { parentId: await testParentId(prisma, team.id), teamId: team.id, title: 'Mine' }, human());
    await commitAsAdmin(candidate.id, candidate.revision);

    expect(await prisma.notification.count({ where: { type: 'work.committed' } })).toBe(0);
  });

  it('projects once per event when replayed', async () => {
    const candidate = await proposeAsNova('Replay');
    const event = await prisma.eventOutbox.create({ data: { payload: {}, type: 'work.committed' } });
    const input = { deciderId: admin.id, eventId: event.id, payload: {}, type: 'work.committed' as const, work: candidate };
    await projectDecisionNotifications(prisma, input);
    await projectDecisionNotifications(prisma, input);

    expect(await prisma.notification.count({ where: { sourceEventId: event.id } })).toBe(1);
  });

  it('says on work_propose where the decision will arrive', async () => {
    const parentId = await testParentId(prisma, team.id);
    const result = (await callMcpTool(asAgent(nova), 'work_propose', {
      description: DESCRIPTION,
      parent_id: parentId,
      team: DEFAULT_TEAM_KEY,
      title: 'Where will I hear back',
    }, false)) as { decision_notice?: string };

    expect(result.decision_notice).toBe(CANDIDATE_DECISION_NOTICE);
  });
});
