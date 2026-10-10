import { PrismaClient as PrismaClientConstructor } from '@prisma/client';
import type { Issue, PrismaClient, Team, User, WorkflowState } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ADMIN_EMAIL, DEFAULT_TEAM_KEY, resetAndSeed } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import type { GraphQLContext } from './auth.ts';
import { startServer } from './index.ts';
import { createIssue, updateIssue } from './issue-service.ts';
import { callMcpTool } from './mcp-tools.ts';
import { testParentId } from './test-placement.ts';
import {
  loadWorkTimeline,
  starTimelineEntry,
  TIMELINE_ENTRY_NOT_FOUND_MESSAGE,
  unstarTimelineEntry,
  workTimelineFor,
} from './work-activity-timeline.ts';
import { writeActorFromViewer } from './work-service.ts';

loadProjectEnvironment();

const prisma: PrismaClient = new PrismaClientConstructor();

const at = (minute: number) => new Date(Date.UTC(2026, 9, 9, 8, minute));

// INV-1116: the issue page shows what actually happened — audit changes, runs,
// evidence and comments in real time order, with actors — and any entry can be
// starred as a key event, through the web app and MCP alike.
describe('issue timeline (INV-1116)', () => {
  let team: Team;
  let admin: User;
  let agent: User;
  let viewerOnly: User;
  let outsider: User;
  let ready: WorkflowState;
  let started: WorkflowState;
  let work: Issue;

  const human = (viewer: User): GraphQLContext => ({ prisma, viewer, authMode: 'session', isTrustedSystem: false });
  const asAgent = (viewer: User): GraphQLContext => ({ prisma, viewer, authMode: 'agent-token', agentScopes: ['read', 'propose'], agentTeamId: team.id, isTrustedSystem: false });

  beforeAll(async () => { await prisma.$connect(); });
  afterAll(async () => { await resetAndSeed(prisma); await prisma.$disconnect(); });
  beforeEach(async () => {
    await resetAndSeed(prisma);
    team = await prisma.team.update({ where: { key: DEFAULT_TEAM_KEY }, data: { visibility: 'PRIVATE' } });
    admin = await prisma.user.findUniqueOrThrow({ where: { email: DEFAULT_ADMIN_EMAIL } });
    agent = await prisma.user.create({ data: { name: 'Builder', email: 'builder@agents.local', actorKind: 'AGENT', ownerId: admin.id } });
    viewerOnly = await prisma.user.create({ data: { name: 'Viewer', email: 'viewer@timeline.test', actorKind: 'HUMAN' } });
    outsider = await prisma.user.create({ data: { name: 'Outsider', email: 'outsider@timeline.test', actorKind: 'HUMAN' } });
    await prisma.teamMembership.createMany({ data: [
      { teamId: team.id, userId: admin.id, role: 'EDITOR' },
      { teamId: team.id, userId: agent.id, role: 'EDITOR' },
      { teamId: team.id, userId: viewerOnly.id, role: 'VIEWER' },
    ], skipDuplicates: true });
    ready = await prisma.workflowState.findFirstOrThrow({ where: { teamId: team.id, type: 'UNSTARTED' } });
    started = await prisma.workflowState.findFirstOrThrow({ where: { teamId: team.id, type: 'STARTED' } });

    // A work item with a state change, an assignment, a run, evidence and a
    // comment — written in one order, dated so they interleave.
    const parentId = await testParentId(prisma, team.id);
    work = await createIssue(prisma, { teamId: team.id, title: 'Timeline subject', parentId, repository: 'test/placement', stateId: ready.id }, writeActorFromViewer(admin));
    work = await updateIssue(prisma, work.id, { assigneeId: agent.id, priority: 2 }, writeActorFromViewer(admin));
    work = await updateIssue(prisma, work.id, { stateId: started.id }, writeActorFromViewer(agent, 'mcp'));
    const audits = await prisma.workAudit.findMany({ where: { workId: work.id }, orderBy: { revision: 'asc' } });
    expect(audits).toHaveLength(3);
    await prisma.workAudit.update({ where: { id: audits[0]!.id }, data: { createdAt: at(0) } });
    await prisma.workAudit.update({ where: { id: audits[1]!.id }, data: { createdAt: at(2) } });
    await prisma.workAudit.update({ where: { id: audits[2]!.id }, data: { createdAt: at(4) } });
    const run = await prisma.workRun.create({ data: { publicId: 'RUN-TL1', workId: work.id, actorId: agent.id, status: 'COMPLETED', phase: 'verify', summary: 'All green', startedAt: at(3), endedAt: at(7) } });
    await prisma.workEvidence.create({ data: { workId: work.id, runId: run.id, actorId: agent.id, kind: 'PR', url: 'https://github.com/test/placement/pull/9', summary: 'The fix', createdAt: at(6) } });
    await prisma.comment.create({ data: { issueId: work.id, userId: admin.id, body: 'Looks right', createdAt: at(5) } });
  });

  it('merges audits, runs, evidence and comments in real time order, each with its actor', async () => {
    const timeline = await workTimelineFor(human(admin), work.identifier);
    expect(timeline.truncated).toBe(false);
    expect(timeline.entries.map((entry) => [entry.kind, entry.at.toISOString(), entry.actor?.name])).toEqual([
      ['CREATED', at(0).toISOString(), admin.name],
      ['ASSIGNEE', at(2).toISOString(), admin.name],
      ['RUN_STARTED', at(3).toISOString(), 'Builder'],
      ['STATE', at(4).toISOString(), 'Builder'],
      ['COMMENT', at(5).toISOString(), admin.name],
      ['EVIDENCE', at(6).toISOString(), 'Builder'],
      ['RUN_ENDED', at(7).toISOString(), 'Builder'],
    ]);
    const [created, assigned, , moved, comment, evidence, ended] = timeline.entries;
    expect(created!.summary).toBe(`Created in ${ready.name}`);
    expect(assigned!.summary).toBe('Assigned to Builder; Priority No priority → High');
    expect(assigned!.changes).toEqual([
      { field: 'assignee', from: null, to: 'Builder' },
      { field: 'priority', from: 'No priority', to: 'High' },
    ]);
    expect(moved!.summary).toBe(`Moved from ${ready.name} to ${started.name}`);
    expect(moved!.actorKind).toBe('AGENT');
    expect(comment!.detail).toBe('Looks right');
    expect(evidence!.url).toBe('https://github.com/test/placement/pull/9');
    expect(ended!.summary).toBe('Run RUN-TL1 completed (verify)');
    expect(ended!.detail).toBe('All green');
    expect(new Set(timeline.entries.map((entry) => entry.key)).size).toBe(timeline.entries.length);
  });

  it('shows nothing to a person who cannot read the work, and never names work they cannot read', async () => {
    await expect(workTimelineFor(human(outsider), work.identifier)).rejects.toThrow();
    await expect(callMcpTool(human(outsider), 'work_timeline', { work_id: work.identifier }, true)).rejects.toThrow();
    // Moved under a parent in a team the reader cannot see.
    const hidden = await prisma.team.create({ data: { key: 'HID', name: 'Hidden', visibility: 'PRIVATE' } });
    const secret = await prisma.issue.create({ data: { identifier: 'HID-1', title: 'Secret parent', teamId: hidden.id, stateId: (await prisma.workflowState.create({ data: { name: 'Todo', type: 'UNSTARTED', teamId: hidden.id, position: 0 } })).id, kind: 'MILESTONE' } });
    const before = await prisma.workAudit.findFirstOrThrow({ where: { workId: work.id }, orderBy: { revision: 'desc' } });
    await prisma.workAudit.create({ data: { workId: work.id, revision: work.revision + 1, actorKind: 'HUMAN', actorId: admin.id, before: before.after ?? {}, after: { ...(before.after as object), parentId: secret.id }, createdAt: at(8) } });
    const asViewer = await workTimelineFor(human(viewerOnly), work.identifier);
    const moved = asViewer.entries.at(-1)!;
    expect(moved.kind).toBe('PARENT');
    expect(JSON.stringify(moved)).not.toContain('HID-1');
    expect(moved.summary).toBe('Moved under a work item you cannot see');
  });

  it('stars and unstars over MCP and GraphQL, keeps who did it, and filters to key events', async () => {
    const listed = (await callMcpTool(asAgent(agent), 'work_timeline', { work_id: work.identifier }, true)) as { entries: Array<{ key: string; kind: string; starred: boolean }> };
    const stateKey = listed.entries.find((entry) => entry.kind === 'STATE')!.key;
    const commentKey = listed.entries.find((entry) => entry.kind === 'COMMENT')!.key;

    // MCP: the grouped tool's star action.
    const starred = (await callMcpTool(asAgent(agent), 'work_timeline', { action: 'star', work_id: work.identifier, entry_key: stateKey }, false)) as Record<string, unknown>;
    expect(starred).toMatchObject({ entry_key: stateKey, starred: true, starred_by: 'Builder' });
    // Idempotent: the first star stands.
    await callMcpTool(asAgent(agent), 'work_timeline', { action: 'star', work_id: work.identifier, entry_key: stateKey }, false);
    expect(await prisma.workTimelineStar.count({ where: { workId: work.id, unstarredAt: null } })).toBe(1);

    // GraphQL as a person (the web app's path).
    const server = await startServer({ allowAdminFallback: true, authToken: 'timeline-token', port: 0, prisma });
    const gql = async (query: string, variables: Record<string, unknown>) => {
      const response = await fetch(`${server.url}/graphql`, { method: 'POST', headers: { authorization: 'Bearer timeline-token', 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }) });
      const body = (await response.json()) as { data?: Record<string, any>; errors?: unknown };
      expect(body.errors).toBeUndefined();
      return body.data!;
    };
    try {
      const star = await gql('mutation ($input: IssueTimelineStarInput!) { issueTimelineStar(input: $input) { success message entryKey starred starredBy { name } } }', { input: { issueId: work.id, entryKey: commentKey } });
      expect(star.issueTimelineStar).toMatchObject({ success: true, entryKey: commentKey, starred: true, starredBy: { name: admin.name } });
      const keyEvents = await gql('query ($id: String!) { issueTimeline(issueId: $id, starredOnly: true) { entries { key kind starred starredBy { name } } } }', { id: work.identifier });
      expect(keyEvents.issueTimeline.entries.map((entry: { kind: string }) => entry.kind)).toEqual(['STATE', 'COMMENT']);

      const unstar = await gql('mutation ($input: IssueTimelineStarInput!) { issueTimelineUnstar(input: $input) { success starred } }', { input: { issueId: work.identifier, entryKey: stateKey } });
      expect(unstar.issueTimelineUnstar).toEqual({ success: true, starred: false });
      const refused = await gql('mutation ($input: IssueTimelineStarInput!) { issueTimelineStar(input: $input) { success message } }', { input: { issueId: work.id, entryKey: 'audit:00000000-0000-4000-8000-000000000000' } });
      expect(refused.issueTimelineStar).toEqual({ success: false, message: TIMELINE_ENTRY_NOT_FOUND_MESSAGE });
    } finally {
      await server.stop();
    }

    // MCP sees the person's change; the unstar is on record, not deleted.
    const keyEvents = (await callMcpTool(asAgent(agent), 'work_timeline', { work_id: work.identifier, starred_only: true }, true)) as { entries: Array<{ key: string; starred_by: string }> };
    expect(keyEvents.entries).toEqual([expect.objectContaining({ key: commentKey, starred_by: admin.name })]);
    const history = await prisma.workTimelineStar.findMany({ where: { workId: work.id, entryKey: stateKey } });
    expect(history).toEqual([expect.objectContaining({ starredById: agent.id, unstarredById: admin.id })]);
    expect(history[0]!.unstarredAt).toBeInstanceOf(Date);

    // Re-starring after an unstar makes a new record; INV-1126 reads starred entries from server code.
    await starTimelineEntry(human(admin), work.id, stateKey);
    const forPostmortem = await loadWorkTimeline(prisma, work.id, { starredOnly: true });
    expect(forPostmortem.entries.map((entry) => entry.key)).toEqual([stateKey, commentKey]);
    expect(await prisma.workTimelineStar.count({ where: { workId: work.id, entryKey: stateKey } })).toBe(2);
  });

  it('needs write access to star, refuses unknown entries, and lets a vanished entry be unstarred', async () => {
    const { entries } = await loadWorkTimeline(prisma, work.id);
    const commentEntry = entries.find((entry) => entry.kind === 'COMMENT')!;
    await expect(starTimelineEntry(human(viewerOnly), work.id, commentEntry.key)).rejects.toThrow();
    await expect(starTimelineEntry(human(outsider), work.id, commentEntry.key)).rejects.toThrow();
    await expect(starTimelineEntry(human(admin), work.id, 'comment:nope')).rejects.toThrow(TIMELINE_ENTRY_NOT_FOUND_MESSAGE);
    await expect(callMcpTool(asAgent(agent), 'work_timeline', { action: 'star', work_id: work.id, entry_key: commentEntry.key }, true)).rejects.toThrow(/read-only/);

    await starTimelineEntry(human(admin), work.id, commentEntry.key);
    await prisma.comment.delete({ where: { id: commentEntry.sourceId } });
    expect((await loadWorkTimeline(prisma, work.id, { starredOnly: true })).entries).toEqual([]);
    expect(await unstarTimelineEntry(human(admin), work.id, commentEntry.key)).toMatchObject({ removed: true });
    expect(await unstarTimelineEntry(human(admin), work.id, commentEntry.key)).toMatchObject({ removed: false });
  });
});
