import type { PrismaClient, Team, User } from '@prisma/client';

import { PrismaClient as PrismaClientConstructor } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ADMIN_EMAIL, DEFAULT_TEAM_KEY, seedDatabase } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import { startServer, type StartedServer } from './index.ts';
import { hashAgentToken } from './agent-credentials.ts';
import { testParentId } from './test-placement.ts';

loadProjectEnvironment();

const prisma: PrismaClient = new PrismaClientConstructor();
const AGENT_TOKEN = 'inv_agent_fixed_bug_test';
let server: StartedServer;

describe('a bug fixed before filing (INV-997)', () => {
  let team: Team;
  let human: User;
  let agent: User;

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
    await prisma.actorAudit.deleteMany();
    await prisma.user.deleteMany();
    await prisma.legacyLinearMapping.deleteMany();
    await seedDatabase(prisma);
    team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
    human = await prisma.user.findUniqueOrThrow({ where: { email: DEFAULT_ADMIN_EMAIL } });
    agent = await prisma.user.create({ data: { name: 'Fixer', email: 'fixer@agents.local', actorKind: 'AGENT', ownerId: human.id } });
    await prisma.teamMembership.create({ data: { role: 'EDITOR', teamId: team.id, userId: agent.id } });
    await prisma.agentCredential.create({ data: { name: 'fixer', scopes: ['read', 'propose', 'claim', 'report'], tokenHash: hashAgentToken(AGENT_TOKEN), teamId: team.id, userId: agent.id } });
    server = await startServer({ allowAdminFallback: true, prisma, authToken: 'unused-static-token', port: 0 });
  });
  afterEach(async () => {
    await server.stop();
  });

  async function fileBug(args: Record<string, unknown>) {
    const response = await fetch(`${server.url}/mcp`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${AGENT_TOKEN}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'work_file_bug', arguments: {
        team: DEFAULT_TEAM_KEY,
        title: 'Search dropped two-character words',
        repository: 'fakechris/Involute',
        priority: 3,
        steps_to_reproduce: 'Search 工单; nothing is found.',
        acceptance: 'Two-character words are found.',
        parent_id: await testParentId(prisma, team.id, 'fakechris/Involute'),
        description: '### 1. 目标与架构定位\nx\n\n### 2. 核心功能与交付范围\nx\n\n### 3. 验收标准与验证方案\nx',
        ...args,
      } } }),
    });
    const body = await response.json() as { error?: { message: string }; result?: { content: Array<{ text: string }> } };
    return body.error ? { error: body.error.message } : JSON.parse(body.result!.content[0]!.text);
  }

  it('records the completed run and its evidence, and tells the reviewer', async () => {
    const result = await fileBug({ initial_state: 'REVIEW', commit_sha: 'a'.repeat(40), pr_number: 175, summary: 'Escaped the wildcard; test added.' });
    expect(result.commitmentStatus).toBe('COMMITTED');
    expect(result.run.public_id).toMatch(/^RUN-\d+$/);
    expect(result.evidence).toEqual([expect.objectContaining({ kind: 'PR', url: 'https://github.com/fakechris/Involute/pull/175' })]);
    expect(result.warning).toContain('fix recorded');

    const work = await prisma.issue.findUniqueOrThrow({ where: { id: result.id }, include: { state: true, runs: true, evidence: true } });
    expect(work.state.type).toBe('REVIEW');
    expect(work.runs).toHaveLength(1);
    expect(work.runs[0]).toMatchObject({ status: 'COMPLETED', commitSha: 'a'.repeat(40), pullRequestNumber: 175, actorId: agent.id, summary: 'Escaped the wildcard; test added.' });
    expect(work.evidence.map((row) => row.kind)).toEqual(['PR']);
    expect(await prisma.notification.count({ where: { userId: human.id, type: 'run.completed', workId: work.id } })).toBe(1);
    expect((await prisma.eventOutbox.findMany({ select: { type: true } })).map((row) => row.type)).toEqual(expect.arrayContaining(['run.completed', 'artifact.attached', 'work.committed']));
  });

  it('refuses a Review filing without evidence, and evidence without Review', async () => {
    expect((await fileBug({ initial_state: 'REVIEW' })).error).toContain('needs its evidence');
    expect((await fileBug({ commit_sha: 'b'.repeat(40) })).error).toContain('pass initial_state REVIEW');
    expect((await fileBug({ initial_state: 'REVIEW', commit_sha: 'short' })).error).toContain('40-character');
    expect(await prisma.issue.count({ where: { title: 'Search dropped two-character words' } })).toBe(0);
  });

  it('accepts a URL alone and still works without a repository-derived PR link', async () => {
    const result = await fileBug({ initial_state: 'REVIEW', evidence_url: 'https://ci.example/run/9' });
    expect(result.evidence).toEqual([expect.objectContaining({ kind: 'ARTIFACT', url: 'https://ci.example/run/9' })]);
  });
});
