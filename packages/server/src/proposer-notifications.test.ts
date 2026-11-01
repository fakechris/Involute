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
      { acceptance: '通知可达且可清。', description: DESCRIPTION, parentId: await testParentId(prisma, team.id), teamId: team.id, title },
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
    await rejectWork(prisma, candidate.id, { expectedRevision: candidate.revision, resolution: 'WONT_DO', reason: 'Duplicate of INV-1' }, human());

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

  it('says on work_propose where the decision will arrive and warns not to cache status (INV-1246)', async () => {
    const parentId = await testParentId(prisma, team.id);
    const result = (await callMcpTool(asAgent(nova), 'work_propose', {
      acceptance: '决定通知可达。',
      description: DESCRIPTION,
      parent_id: parentId,
      team: DEFAULT_TEAM_KEY,
      title: 'Where will I hear back',
    }, false)) as { decision_notice?: string };

    expect(result.decision_notice).toBe(CANDIDATE_DECISION_NOTICE);
    expect(result.decision_notice).toContain('it may be decided at any time without you being told; do not cache its status');
  });

  it('piggybacks unread_decisions on non-inbox MCP tool responses when unread notifications exist, without marking them read (INV-1245)', async () => {
    // 0 unread: no unread_decisions field on any tool response
    const cleanGet = (await callMcpTool(asAgent(nova), 'work_list_ready', { team_key: DEFAULT_TEAM_KEY }, false)) as Record<string, unknown>;
    expect(cleanGet.unread_decisions).toBeUndefined();

    // Propose 4 candidates as nova and commit them as admin
    const c1 = await proposeAsNova('Batch candidate 1');
    const c2 = await proposeAsNova('Batch candidate 2');
    const c3 = await proposeAsNova('Batch candidate 3');
    const c4 = await proposeAsNova('Batch candidate 4');
    await commitAsAdmin(c1.id, c1.revision);
    await commitAsAdmin(c2.id, c2.revision);
    await commitAsAdmin(c3.id, c3.revision);
    await commitAsAdmin(c4.id, c4.revision);

    // Every non-inbox tool response on /mcp carries unread_decisions (count=4, latest=3 in descending order)
    // Legacy array work_search preserves Array.isArray / .length while attaching unread_decisions
    const searchRes = (await callMcpTool(asAgent(nova), 'work_search', { query: 'Batch candidate' }, false)) as Array<{
      identifier: string;
    }> & {
      unread_decisions?: { count: number; latest: Array<{ identifier: string; type: string; at: string }>; hint: string };
    };
    expect(Array.isArray(searchRes)).toBe(true);
    expect(searchRes.length).toBeGreaterThanOrEqual(4);
    expect(searchRes.unread_decisions).toBeDefined();
    expect(searchRes.unread_decisions?.count).toBe(4);
    expect(searchRes.unread_decisions?.latest).toHaveLength(3);
    expect(searchRes.unread_decisions?.latest.map((item) => item.identifier)).toEqual([
      c4.identifier,
      c3.identifier,
      c2.identifier,
    ]);
    expect(searchRes.unread_decisions?.latest.every((item) => item.type === 'work.committed')).toBe(true);
    expect(searchRes.unread_decisions?.hint).toContain('Read agent_inbox');

    const paginatedSearchRes = (await callMcpTool(asAgent(nova), 'work_search', { query: 'Batch candidate', paginate: true }, false)) as {
      nodes: Array<{ identifier: string }>;
      unread_decisions?: { count: number };
    };
    expect(paginatedSearchRes.nodes.length).toBeGreaterThanOrEqual(4);
    expect(paginatedSearchRes.unread_decisions?.count).toBe(4);

    const contextRes = (await callMcpTool(asAgent(nova), 'work_get_context', { id: c1.identifier }, false)) as {
      unread_decisions?: { count: number };
    };
    expect(contextRes.unread_decisions?.count).toBe(4);

    const commentRes = (await callMcpTool({ ...asAgent(nova), agentScopes: ['read', 'propose', 'update'] }, 'work_comment', { work_id: c1.identifier, body: 'Checking status' }, false)) as {
      unread_decisions?: { count: number };
    };
    expect(commentRes.unread_decisions?.count).toBe(4);

    // /mcp/readonly does not piggyback unread_decisions
    const readonlyContext = (await callMcpTool(asAgent(nova), 'work_get_context', { id: c1.identifier }, true)) as {
      unread_decisions?: unknown;
    };
    expect(readonlyContext.unread_decisions).toBeUndefined();

    // Piggybacking does not mark notifications read (readAt remains null)
    const unreadInDb = await prisma.notification.count({ where: { userId: nova.id, readAt: null } });
    expect(unreadInDb).toBe(4);

    // Calling agent_inbox itself does not attach unread_decisions, and its count matches
    const inboxRes = (await callMcpTool(asAgent(nova), 'agent_inbox', {}, false)) as {
      notifications: Array<{ id: string }>;
      unread_decisions?: unknown;
    };
    expect(inboxRes.unread_decisions).toBeUndefined();
    expect(inboxRes.notifications).toHaveLength(4);

    // Acking all notifications via agent_inbox(ack: [...]) clears unread_decisions on subsequent calls
    const ackedInbox = (await callMcpTool(asAgent(nova), 'agent_inbox', {
      ack: inboxRes.notifications.map((n) => n.id),
    }, false)) as { notifications: unknown[] };
    expect(ackedInbox.notifications).toEqual([]);

    const afterAck = (await callMcpTool(asAgent(nova), 'work_get_context', { id: c1.identifier }, false)) as {
      unread_decisions?: unknown;
    };
    expect(afterAck.unread_decisions).toBeUndefined();
  });

  it('excludes unreadable work items from unread_decisions count and latest (INV-1245)', async () => {
    const privateTeam = await prisma.team.create({
      data: { key: 'SEC', name: 'Secret Team', visibility: 'PRIVATE' },
    });
    const privateState = await prisma.workflowState.create({
      data: { name: 'Ready', position: 1, teamId: privateTeam.id, type: 'UNSTARTED' },
    });
    const secretIssue = await prisma.issue.create({
      data: {
        commitmentStatus: 'COMMITTED',
        identifier: 'SEC-1',
        stateId: privateState.id,
        teamId: privateTeam.id,
        title: 'Secret committed work',
      },
    });
    // Create an unscoped notification pointing to a private team's work item that nova (bound to DEFAULT_TEAM_KEY) cannot read
    await prisma.notification.create({
      data: {
        payload: { decision: 'committed' },
        teamId: null,
        type: 'work.committed',
        userId: nova.id,
        workId: secretIssue.id,
      },
    });

    // Neither agent_inbox nor unread_decisions exposes or counts the unreadable work item
    const inbox = (await callMcpTool(asAgent(nova), 'agent_inbox', {}, false)) as {
      notifications: Array<{ work_identifier: string | null }>;
    };
    expect(inbox.notifications).toEqual([]);

    const ready = (await callMcpTool(asAgent(nova), 'work_list_ready', { team_key: DEFAULT_TEAM_KEY }, false)) as {
      unread_decisions?: unknown;
    };
    expect(ready.unread_decisions).toBeUndefined();
  });
});
