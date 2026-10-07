import type { Issue, Team, WorkflowState } from '@prisma/client';

import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_TEAM_KEY, seedDatabase } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import { findSimilarBugs } from './bug-report.ts';
import type { Embedder } from './embeddings/embedder.ts';
import { readEmbeddingSettings } from './embeddings/embedder.ts';
import { SemanticIndex } from './embeddings/semantic-index.ts';
import { findPossibleDuplicates } from './embeddings/similar-work.ts';
import { startServer, type StartedServer } from './index.ts';
import { searchIssues } from './issue-search.ts';

loadProjectEnvironment();

const prisma = new PrismaClient();
const TEST_AUTH_TOKEN = 'test-auth-token';

// A fake model: each group of words is one direction, so texts sharing a
// group are close in meaning even with no word in common.
const CONCEPTS = [
  ['白屏', '刷新', 'reload'],
  ['重复', '去重', 'duplicate'],
  ['审批', '审核', 'approval'],
  ['录音', '录制', 'record'],
];

function fakeVector(text: string): Float32Array {
  const vector = new Float32Array(CONCEPTS.length + 1);
  vector[CONCEPTS.length] = 0.05;
  CONCEPTS.forEach((words, index) => {
    if (words.some((word) => text.toLowerCase().includes(word))) vector[index] = 1;
  });
  const norm = Math.hypot(...vector);
  return vector.map((value) => value / norm);
}

function fakeEmbedder(overrides: Partial<Embedder> = {}): Embedder & { documentsEmbedded: number } {
  const embedder = {
    model: 'fake-concepts',
    documentsEmbedded: 0,
    async embedQuery(text: string) {
      return fakeVector(text);
    },
    async embedDocuments(texts: string[]) {
      embedder.documentsEmbedded += texts.length;
      return texts.map(fakeVector);
    },
    ...overrides,
  };
  return embedder;
}

describe('Semantic search (INV-927)', () => {
  let team: Team;
  let ready: WorkflowState;
  let done: WorkflowState;
  let sequence = 0;

  async function work(data: Partial<Issue> & { title: string }) {
    sequence += 1;
    return prisma.issue.create({
      data: { identifier: `${DEFAULT_TEAM_KEY}-${sequence}`, teamId: team.id, stateId: ready.id, ...data },
    });
  }

  const identifiers = (hits: Awaited<ReturnType<typeof searchIssues>>) => hits.map((hit) => hit.issue.identifier);

  async function indexed(embedder = fakeEmbedder()) {
    const index = new SemanticIndex(prisma, embedder);
    while ((await index.refresh()) > 0) {
      // embed everything
    }
    return index;
  }

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
    ready = await prisma.workflowState.findFirstOrThrow({ where: { teamId: team.id, type: 'UNSTARTED' } });
    done = await prisma.workflowState.findFirstOrThrow({ where: { teamId: team.id, type: 'COMPLETED' } });
    sequence = 0;
  });

  it('is off unless INVOLUTE_EMBEDDINGS=local', () => {
    expect(readEmbeddingSettings({}).enabled).toBe(false);
    expect(readEmbeddingSettings({ INVOLUTE_EMBEDDINGS: 'local' })).toMatchObject({
      enabled: true,
      model: 'Xenova/multilingual-e5-small',
      allowDownload: false,
    });
  });

  it('finds an item described in other words, marked as found by meaning', async () => {
    const target = await work({ title: '部署后旧页面白屏', description: '懒加载 chunk 失效' });
    await work({ title: 'Unrelated', description: '看板列宽' });
    const index = await indexed();

    expect(await searchIssues(prisma, { query: '发版后要手动刷新' })).toEqual([]);
    const hits = await searchIssues(prisma, { query: '发版后要手动刷新' }, undefined, index);
    expect(identifiers(hits)[0]).toBe(target.identifier);
    expect(hits[0]?.matchedField).toBe('semantic');
  });

  it('ranks an item found both by words and by meaning above one found only one way', async () => {
    const both = await work({ title: '审批流程卡住', stateId: done.id });
    const wordsOnly = await work({ title: '审批 log', description: 'x' });
    await prisma.issue.update({ where: { id: wordsOnly.id }, data: { title: '流程 log' } });
    const meaningOnly = await work({ title: '审核超时' });
    const index = await indexed();

    const hits = await searchIssues(prisma, { query: '审批流程' }, undefined, index);
    expect(identifiers(hits)[0]).toBe(both.identifier);
    expect(identifiers(hits)).toContain(meaningOnly.identifier);
  });

  it('keeps a match by number first', async () => {
    sequence = 41;
    const byNumber = await work({ title: 'Plain title' });
    await work({ title: '白屏', description: 'INV-42 mentioned' });
    const index = await indexed();

    expect(identifiers(await searchIssues(prisma, { query: 'INV-42' }, undefined, index))[0]).toBe(byNumber.identifier);
  });

  it('adds nothing for a query whose best match does not stand out', async () => {
    for (let count = 0; count < 12; count += 1) {
      await work({ title: `Item ${count}`, description: '普通内容' });
    }
    const index = await indexed();

    // No concept in the query: every item is equally (dis)similar.
    expect(await searchIssues(prisma, { query: '周末去哪里玩' }, undefined, index)).toEqual([]);
  });

  it('never returns an unreadable item found by meaning', async () => {
    const hidden = await prisma.team.create({ data: { key: 'HID', name: 'Hidden', visibility: 'PRIVATE' } });
    const hiddenState = await prisma.workflowState.create({ data: { name: 'Ready', type: 'UNSTARTED', teamId: hidden.id, position: 0 } });
    await prisma.issue.create({ data: { identifier: 'HID-1', title: '白屏', teamId: hidden.id, stateId: hiddenState.id } });
    const visible = await work({ title: '页面要 reload' });
    const index = await indexed();

    const hits = await searchIssues(prisma, { query: '刷新' }, { team: { key: DEFAULT_TEAM_KEY } }, index);
    expect(identifiers(hits)).toEqual([visible.identifier]);
  });

  it('answers by keyword alone when the model fails', async () => {
    const keyword = await work({ title: '刷新按钮' });
    const index = await indexed();
    const broken = new SemanticIndex(prisma, fakeEmbedder({
      embedQuery: async () => {
        throw new Error('model unavailable');
      },
    }));
    await broken.load();

    expect(identifiers(await searchIssues(prisma, { query: '刷新' }, undefined, broken))).toEqual([keyword.identifier]);
    expect(index.size).toBe(1);
  });

  it('answers by keyword when the model is still loading', async () => {
    const keyword = await work({ title: '刷新按钮' });
    await work({ title: '白屏' });
    await indexed();
    const slow = new SemanticIndex(prisma, fakeEmbedder({
      embedQuery: () => new Promise(() => {}), // never answers
    }));
    await slow.load();
    expect(slow.size).toBe(2);

    const started = Date.now();
    expect(identifiers(await searchIssues(prisma, { query: '刷新' }, undefined, slow))).toEqual([keyword.identifier]);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('embeds new and reworded items, and skips items that only changed state', async () => {
    const embedder = fakeEmbedder();
    const issue = await work({ title: '录音丢失' });
    const index = await indexed(embedder);
    expect(embedder.documentsEmbedded).toBe(1);

    await prisma.issue.update({ where: { id: issue.id }, data: { stateId: done.id } });
    await index.refresh();
    expect(embedder.documentsEmbedded).toBe(1);

    await prisma.issue.update({ where: { id: issue.id }, data: { title: '审批丢失' } });
    await index.refresh();
    expect(embedder.documentsEmbedded).toBe(2);
    expect(identifiers(await searchIssues(prisma, { query: '审核' }, undefined, index))).toEqual([issue.identifier]);

    // A restart reads the stored vectors instead of embedding again.
    const restarted = new SemanticIndex(prisma, embedder);
    await restarted.refresh();
    expect(embedder.documentsEmbedded).toBe(2);
    expect(restarted.size).toBe(1);
  });

  it('drops the vector of a deleted item, so it no longer takes a top slot', async () => {
    const gone = await work({ title: '白屏 A' });
    const kept = await work({ title: '白屏 B' });
    const index = await indexed();
    await prisma.issue.delete({ where: { id: gone.id } });

    expect(index.nearest(fakeVector('白屏'), 5).map((match) => match.id)).toContain(gone.id);
    expect(await index.prune()).toBe(1);
    expect(index.nearest(fakeVector('白屏'), 5).map((match) => match.id)).toEqual([kept.id]);
  });

  it('gives up on a similarity lookup that does not answer, keeping word matches', async () => {
    const bug = await prisma.issueLabel.upsert({ where: { name: 'Bug' }, create: { name: 'Bug' }, update: {} });
    const wordMatch = await work({ title: 'merge loses rows', labels: { connect: { id: bug.id } } } as never);
    await indexed();
    const stuck = new SemanticIndex(prisma, fakeEmbedder({
      embedDocuments: () => new Promise(() => {}), // never answers
    }));
    await stuck.load();

    const started = Date.now();
    const similar = await findSimilarBugs(prisma, { teamId: team.id, title: 'merge loses rows' }, stuck);
    expect(similar.map((issue) => issue.identifier)).toEqual([wordMatch.identifier]);
    expect(await findPossibleDuplicates(prisma, stuck, wordMatch, undefined)).toEqual([]);
    expect(Date.now() - started).toBeLessThan(6000);
  });

  it('suggests open bugs described in other words', async () => {
    const bug = await prisma.issueLabel.upsert({ where: { name: 'Bug' }, create: { name: 'Bug' }, update: {} });
    const similar = await work({ title: '合并时重复的条目没有去掉', labels: { connect: { id: bug.id } } } as never);
    const index = await indexed();

    const byWords = await findSimilarBugs(prisma, { teamId: team.id, title: 'duplicate rows after merge' });
    expect(byWords).toEqual([]);
    const byMeaning = await findSimilarBugs(prisma, { teamId: team.id, title: 'duplicate rows after merge' }, index);
    expect(byMeaning.map((issue) => issue.identifier)).toEqual([similar.identifier]);
  });

  describe('work_propose', () => {
    let server: StartedServer;

    afterEach(async () => {
      await server.stop();
    });

    it('lists possible duplicates of a proposal', async () => {
      sequence = 900; // clear of the numbers the server gives the proposal
      const existing = await work({ title: '去重：重复的导入记录', repository: 'test/placement' });
      await work({ title: '看板列宽', repository: 'test/placement' });
      const index = await indexed();
      server = await startServer({ allowAdminFallback: true, prisma, authToken: TEST_AUTH_TOKEN, port: 0, semanticIndex: index });

      const response = await fetch(`${server.url}/mcp`, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${TEST_AUTH_TOKEN}` },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'work_propose',
            arguments: {
              team: DEFAULT_TEAM_KEY,
              title: 'Import creates duplicate entries',
              repository: 'test/placement',
              description: '### 1. 目标与架构定位\nx\n\n### 2. 核心功能与交付范围\nx\n\n### 3. 验收标准与验证方案\nx',
            },
          },
        }),
      });
      const body = await response.json() as any;
      expect(body.error).toBeUndefined();
      const result = JSON.parse(body.result.content[0].text);
      expect(result.possible_duplicates.map((item: { identifier: string }) => item.identifier)).toEqual([existing.identifier]);
      expect(result.warning).toContain(`Possible duplicates: ${existing.identifier}`);
    });
  });
});
