import type { Issue, Team, User, WorkflowState } from '@prisma/client';

import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ADMIN_EMAIL, DEFAULT_TEAM_KEY, seedDatabase } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import { startServer, type StartedServer } from './index.ts';
import { parseSearchQuery, searchIssues } from './issue-search.ts';
import { createSession } from './session.js';

loadProjectEnvironment();

const prisma = new PrismaClient();
const TEST_AUTH_TOKEN = 'test-auth-token';

describe('Free-text search (INV-925)', () => {
  let team: Team;
  let admin: User;
  let ready: WorkflowState;
  let done: WorkflowState;
  let sequence = 0;

  async function work(data: Partial<Issue> & { title: string }) {
    sequence += 1;
    return prisma.issue.create({
      data: { identifier: `${DEFAULT_TEAM_KEY}-${sequence}`, teamId: team.id, stateId: ready.id, ...data },
    });
  }

  async function comment(issue: Issue, body: string) {
    return prisma.comment.create({ data: { issueId: issue.id, userId: admin.id, body } });
  }

  const identifiers = (hits: Awaited<ReturnType<typeof searchIssues>>) => hits.map((hit) => hit.issue.identifier);

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
    admin = await prisma.user.findUniqueOrThrow({ where: { email: DEFAULT_ADMIN_EMAIL } });
    ready = await prisma.workflowState.findFirstOrThrow({ where: { teamId: team.id, type: 'UNSTARTED' } });
    done = await prisma.workflowState.findFirstOrThrow({ where: { teamId: team.id, type: 'COMPLETED' } });
    sequence = 900;
  });

  it('parses words, quoted phrases and identifiers', () => {
    expect(parseSearchQuery('候选  审批 候选')).toEqual({ terms: ['候选', '审批'], identifier: null });
    expect(parseSearchQuery('"board drag" 卡片').terms).toEqual(['board drag', '卡片']);
    expect(parseSearchQuery('inv925').identifier).toEqual({ prefix: 'INV', number: '925' });
    expect(parseSearchQuery('INV-925').identifier).toEqual({ prefix: 'INV', number: '925' });
    expect(parseSearchQuery('925').identifier).toEqual({ prefix: null, number: '925' });
    expect(parseSearchQuery('   ').terms).toEqual([]);
  });

  it('finds a two-character word in the description, a contract field and a comment', async () => {
    const inDescription = await work({ title: 'A', description: '这里写着候选的事' });
    const inAcceptance = await work({ title: 'B', acceptance: '人工审批通过即可' });
    const inScope = await work({ title: 'C', scope: '只改看板' });
    const inComment = await work({ title: 'D' });
    await comment(inComment, '评论里提到溯源');
    await work({ title: 'unrelated' });

    expect(identifiers(await searchIssues(prisma, { query: '候选' }))).toEqual([inDescription.identifier]);
    expect(identifiers(await searchIssues(prisma, { query: '审批' }))).toEqual([inAcceptance.identifier]);
    expect(identifiers(await searchIssues(prisma, { query: '看板' }))).toEqual([inScope.identifier]);

    const [hit] = await searchIssues(prisma, { query: '溯源' });
    expect(hit?.issue.identifier).toBe(inComment.identifier);
    expect(hit?.matchedField).toBe('comment');
    expect(hit?.snippet).toContain('溯源');
    expect(hit?.commentId).not.toBeNull();
  });

  it('requires every word but not that they are adjacent', async () => {
    const both = await work({ title: '候选队列', description: '提交后进入人工的审批流程' });
    await work({ title: '只有候选' });
    await work({ title: '只有审批' });

    expect(identifiers(await searchIssues(prisma, { query: '候选 审批' }))).toEqual([both.identifier]);
    // A quoted phrase stays together, so the same words apart do not match it.
    expect(await searchIssues(prisma, { query: '"候选 审批"' })).toEqual([]);
  });

  it('puts the item first for INV-925, inv925 and 925, but not INV-1925', async () => {
    sequence = 924;
    const target = await work({ title: 'Unified search' });
    sequence = 1924;
    await work({ title: 'Mentions INV-925 and 925 in its title' });

    for (const query of ['INV-925', 'inv925', 'inv 925', '925']) {
      expect(identifiers(await searchIssues(prisma, { query }))[0], query).toBe(target.identifier);
    }
  });

  it('ranks a title hit above a description hit above a comment-only hit', async () => {
    const commentOnly = await work({ title: 'Third' });
    await comment(commentOnly, 'the parser drops aborted turns');
    const descriptionOnly = await work({ title: 'Second', description: 'parser notes' });
    const titleHit = await work({ title: 'Parser rewrite', stateId: done.id });

    expect(identifiers(await searchIssues(prisma, { query: 'parser' }))).toEqual([
      titleHit.identifier,
      descriptionOnly.identifier,
      commentOnly.identifier,
    ]);
  });

  it('keeps an old title match when newer items only mention the word elsewhere', async () => {
    const old = await work({ title: 'Parser rewrite' });
    await prisma.issue.update({ where: { id: old.id }, data: { updatedAt: new Date('2020-01-01') } });
    for (let index = 0; index < 3; index += 1) {
      await work({ title: `Newer ${index}`, description: 'mentions the parser' });
    }

    const hits = await searchIssues(prisma, { query: 'parser', recallLimit: 2 });
    expect(identifiers(hits)[0]).toBe(old.identifier);
  });

  it('matches LIKE wildcards literally', async () => {
    const percent = await work({ title: 'Coverage at 100% now' });
    await work({ title: 'Coverage at 1000 now' });

    expect(identifiers(await searchIssues(prisma, { query: '100%' }))).toEqual([percent.identifier]);
    expect(await searchIssues(prisma, { query: '_' })).toEqual([]);
  });

  describe('over HTTP', () => {
    let server: StartedServer;

    beforeEach(async () => {
      server = await startServer({ allowAdminFallback: true, prisma, authToken: TEST_AUTH_TOKEN, port: 0 });
    });

    afterEach(async () => {
      await server.stop();
    });

    async function graphql(query: string, variables: Record<string, unknown>, cookie?: string) {
      const response = await fetch(`${server.url}/graphql`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(cookie ? { cookie } : { authorization: `Bearer ${TEST_AUTH_TOKEN}` }),
        },
        body: JSON.stringify({ query, variables }),
      });
      const body = await response.json() as any;
      expect(body.errors).toBeUndefined();
      return body.data;
    }

    async function workSearch(args: Record<string, unknown>) {
      const response = await fetch(`${server.url}/mcp`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          authorization: `Bearer ${TEST_AUTH_TOKEN}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'search',
          method: 'tools/call',
          params: { name: 'work_search', arguments: args },
        }),
      });
      const body = await response.json() as any;
      expect(body.error).toBeUndefined();
      return JSON.parse(body.result.content[0].text) as Array<{ identifier: string; match?: { field: string } }>;
    }

    const SEARCH = /* GraphQL */ `
      query Search($query: String!, $iql: String) {
        search(query: $query, iql: $iql) { issue { identifier state { type } } matchedField snippet commentId }
      }
    `;

    it('returns the same items, in the same order, as MCP work_search', async () => {
      const first = await work({ title: '看板拖拽' });
      const second = await work({ title: 'Other', description: '拖拽后卡片消失' });
      await comment(await work({ title: 'Third' }), '拖拽 bug');

      const web = await graphql(SEARCH, { query: '拖拽' });
      const mcp = await workSearch({ query: '拖拽' });

      expect(web.search.map((hit: any) => hit.issue.identifier)).toEqual(mcp.map((item) => item.identifier));
      expect(web.search[0].issue.identifier).toBe(first.identifier);
      expect(web.search[1].issue.identifier).toBe(second.identifier);
      expect(mcp[2]?.match?.field).toBe('comment');

      const filtered = await graphql(SEARCH, { query: '拖拽', iql: 'state-type:COMPLETED' });
      expect(filtered.search).toEqual([]);
    });

    it('never returns items or comments from a team the viewer cannot read', async () => {
      const hidden = await prisma.team.create({ data: { key: 'HID', name: 'Hidden', visibility: 'PRIVATE' } });
      const hiddenState = await prisma.workflowState.create({
        data: { name: 'Ready', type: 'UNSTARTED', teamId: hidden.id, position: 0 },
      });
      const secret = await prisma.issue.create({
        data: { identifier: 'HID-1', title: '机密 roadmap', teamId: hidden.id, stateId: hiddenState.id },
      });
      await comment(secret, '机密评论');
      const visible = await work({ title: '公开 roadmap' });

      const member = await prisma.user.create({ data: { email: 'member@search.test', name: 'Member' } });
      await prisma.teamMembership.create({ data: { teamId: team.id, userId: member.id, role: 'EDITOR' } });
      const session = await createSession(prisma, member.id, 3600);
      const cookie = `involute_session=${session.token}`;

      const roadmap = await graphql(SEARCH, { query: 'roadmap' }, cookie);
      expect(roadmap.search.map((hit: any) => hit.issue.identifier)).toEqual([visible.identifier]);
      expect((await graphql(SEARCH, { query: '机密' }, cookie)).search).toEqual([]);
      expect((await graphql(SEARCH, { query: 'HID-1' }, cookie)).search).toEqual([]);
    });
  });
});
