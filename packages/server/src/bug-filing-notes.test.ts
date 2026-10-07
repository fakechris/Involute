import type { PrismaClient, Team, User } from '@prisma/client';

import { PrismaClient as PrismaClientConstructor } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ADMIN_EMAIL, DEFAULT_TEAM_KEY, seedDatabase } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import { startServer, type StartedServer } from './index.ts';
import { hashAgentToken } from './agent-credentials.ts';
import { SemanticIndex } from './embeddings/semantic-index.ts';
import type { Embedder } from './embeddings/embedder.ts';
import { testParentId } from './test-placement.ts';

loadProjectEnvironment();

const prisma: PrismaClient = new PrismaClientConstructor();
const AGENT_TOKEN = 'inv_agent_bug_notes_test';
let server: StartedServer;

// One direction per concept: texts sharing a concept are close in meaning.
const CONCEPTS = [['白屏', 'reload'], ['重复', 'duplicate'], ['录音', 'record']];
function fakeVector(text: string): Float32Array {
  const vector = new Float32Array(CONCEPTS.length + 1);
  vector[CONCEPTS.length] = 0.05;
  CONCEPTS.forEach((words, index) => {
    if (words.some((word) => text.toLowerCase().includes(word))) vector[index] = 1;
  });
  const norm = Math.hypot(...vector);
  return vector.map((value) => value / norm);
}
const embedder: Embedder = {
  model: 'fake-concepts',
  async embedQuery(text) { return fakeVector(text); },
  async embedDocuments(texts) { return texts.map(fakeVector); },
};

// INV-1000: a filed bug says where it landed and what it may duplicate.
describe('work_file_bug placement and duplicates (INV-1000)', () => {
  let team: Team;
  let human: User;
  let index: SemanticIndex;

  beforeAll(async () => { await prisma.$connect(); });
  afterAll(async () => { await prisma.$disconnect(); });
  beforeEach(async () => {
    await prisma.issueEmbedding.deleteMany();
    await prisma.comment.deleteMany();
    await prisma.issue.deleteMany();
    await prisma.workflowState.deleteMany();
    await prisma.team.deleteMany();
    await prisma.issueLabel.deleteMany();
    await prisma.actorAudit.deleteMany();
    await prisma.user.deleteMany();
    await prisma.legacyLinearMapping.deleteMany();
    await seedDatabase(prisma);
    team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
    human = await prisma.user.findUniqueOrThrow({ where: { email: DEFAULT_ADMIN_EMAIL } });
    const agent = await prisma.user.create({ data: { name: 'Filer', email: 'filer@agents.local', actorKind: 'AGENT', ownerId: human.id } });
    await prisma.teamMembership.create({ data: { role: 'EDITOR', teamId: team.id, userId: agent.id } });
    await prisma.agentCredential.create({ data: { name: 'filer', scopes: ['read', 'propose', 'claim', 'report'], tokenHash: hashAgentToken(AGENT_TOKEN), teamId: team.id, userId: agent.id } });
    index = new SemanticIndex(prisma, embedder);
    server = await startServer({ allowAdminFallback: true, prisma, authToken: 'unused-static-token', port: 0, semanticIndex: index });
  });
  afterEach(async () => { await server.stop(); });

  async function fileBug(args: Record<string, unknown>) {
    const response = await fetch(`${server.url}/mcp`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${AGENT_TOKEN}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'work_file_bug', arguments: {
        team: DEFAULT_TEAM_KEY,
        repository: 'fakechris/Involute',
        priority: 3,
        steps_to_reproduce: 'Open the page.',
        acceptance: 'It works.',
        description: '### 1. 目标与架构定位\nx\n\n### 2. 核心功能与交付范围\nx\n\n### 3. 验收标准与验证方案\nx',
        ...args,
      } } }),
    });
    const body = await response.json() as { error?: { message: string }; result?: { content: Array<{ text: string }> } };
    return body.error ? { error: body.error.message } : JSON.parse(body.result!.content[0]!.text);
  }

  it('lists possible duplicates of an existing bug and says where it was placed', async () => {
    const parentId = await testParentId(prisma, team.id, 'fakechris/Involute');
    const existing = await fileBug({ title: 'Board goes blank (白屏) after reload', parent_id: parentId });
    expect(existing.possible_duplicates).toBeUndefined();
    await index.refresh();

    const again = await fileBug({ title: 'Reload shows a white screen', parent_id: parentId, labels: ['search'] });
    expect(again.possible_duplicates?.map((item: { identifier: string }) => item.identifier)).toEqual([existing.identifier]);
    expect(again.warning).toContain('Possible duplicates');
    expect(again.warning).not.toContain('No parent_id given');
    const parent = await prisma.issue.findUniqueOrThrow({ where: { id: parentId } });
    expect(again.placed_under).toEqual({ identifier: parent.identifier, kind: parent.kind, title: parent.title });
    const labels = await prisma.issue.findUniqueOrThrow({ where: { id: again.id }, include: { labels: true } });
    expect(labels.labels.map((label) => label.name.toLowerCase()).sort()).toEqual(['bug', 'search']);
  });

  it('explains an inherited placement and refuses a second Type label', async () => {
    const parentId = await testParentId(prisma, team.id, 'fakechris/Involute');
    const related = await fileBug({ title: 'Recording stops (录音) at ten minutes', parent_id: parentId });
    const inherited = await fileBug({ title: 'Export is empty', related_work_id: related.identifier });
    expect(inherited.warning).toContain(`No parent_id given: placed under`);
    expect(inherited.placed_under?.identifier).toBe((await prisma.issue.findUniqueOrThrow({ where: { id: parentId } })).identifier);

    const twoTypes = await fileBug({ title: 'Also a feature', parent_id: parentId, labels: ['feature'] });
    expect(twoTypes.error).toMatch(/Type/i);
  });
});
