import type { PrismaClient, Team, User } from '@prisma/client';

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PrismaClient as PrismaClientConstructor } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ADMIN_EMAIL, DEFAULT_TEAM_KEY, seedDatabase } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import { startServer, type StartedServer } from './index.ts';
import { hashAgentToken } from './agent-credentials.ts';
import { testParentId } from './test-placement.ts';

loadProjectEnvironment();

const prisma: PrismaClient = new PrismaClientConstructor();
const AGENT_TOKEN = 'inv_agent_attach_file_test';
let server: StartedServer;

// INV-1003: a research report becomes a private attachment on its work.
describe('work_attach_file (INV-1003)', () => {
  let team: Team;
  let human: User;
  let agent: User;

  let uploadsDir: string;
  beforeAll(async () => {
    await prisma.$connect();
    // Files land in a scratch directory, not the repository's uploads/.
    uploadsDir = await mkdtemp(join(tmpdir(), 'involute-attach-test-'));
    process.env.INVOLUTE_UPLOADS_DIR = uploadsDir;
  });
  afterAll(async () => {
    delete process.env.INVOLUTE_UPLOADS_DIR;
    await rm(uploadsDir, { force: true, recursive: true });
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await prisma.attachment.deleteMany();
    await prisma.comment.deleteMany();
    await prisma.issue.deleteMany();
    await prisma.workflowState.deleteMany();
    await prisma.team.deleteMany();
    await prisma.actorAudit.deleteMany();
    await prisma.user.deleteMany();
    await seedDatabase(prisma);
    team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
    human = await prisma.user.findUniqueOrThrow({ where: { email: DEFAULT_ADMIN_EMAIL } });
    agent = await prisma.user.create({ data: { name: 'Researcher', email: 'researcher@agents.local', actorKind: 'AGENT', ownerId: human.id } });
    await prisma.teamMembership.create({ data: { role: 'EDITOR', teamId: team.id, userId: agent.id } });
    await prisma.agentCredential.create({ data: { name: 'researcher', scopes: ['read', 'propose', 'claim', 'report'], tokenHash: hashAgentToken(AGENT_TOKEN), teamId: team.id, userId: agent.id } });
    server = await startServer({ allowAdminFallback: true, prisma, authToken: 'unused-static-token', port: 0, uploadsDir });
  });
  afterEach(async () => { await server.stop(); });

  async function mcp(name: string, args: Record<string, unknown>) {
    const response = await fetch(`${server.url}/mcp`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${AGENT_TOKEN}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    const body = await response.json() as { error?: { message: string }; result?: { content: Array<{ text: string }> } };
    return body.error ? { error: body.error.message } : JSON.parse(body.result!.content[0]!.text);
  }

  it('stores the file under the work, lists it on the issue and serves it to readers of the work', async () => {
    const parentId = await testParentId(prisma, team.id);
    const work = await prisma.issue.findUniqueOrThrow({ where: { id: parentId } });
    const report = '# Competitor study\n\nLinear ships agent sessions.';
    const result = await mcp('work_attach_file', { work_id: work.identifier, filename: 'linear-study.md', mime_type: 'text/markdown', content: Buffer.from(report).toString('base64') });
    expect(result.url).toMatch(/^\/uploads\/[0-9a-f-]{36}\.md$/);
    expect(result.identifier).toBe(work.identifier);

    const stored = await prisma.attachment.findUniqueOrThrow({ where: { id: result.id } });
    expect(stored).toMatchObject({ issueId: work.id, uploaderId: agent.id, filename: 'linear-study.md', size: Buffer.byteLength(report) });

    // Listed on the work for the issue page's Files section.
    expect((await prisma.attachment.findMany({ where: { issueId: work.id } })).map((file) => file.filename)).toEqual(['linear-study.md']);

    // A trusted token bearer may fetch any recorded upload; nobody gets it anonymously.
    const download = await fetch(`${server.url}${result.url}`, { headers: { authorization: 'Bearer unused-static-token' } });
    expect(download.status).toBe(200);
    expect(await download.text()).toBe(report);
    expect((await fetch(`${server.url}${result.url}`)).status).toBe(401);
  });

  it('refuses a file on work the actor cannot write and a file over the size cap', async () => {
    const outsider = await mcp('work_attach_file', { work_id: 'INV-999999', filename: 'x.md', mime_type: 'text/markdown', content: 'eA==' });
    expect(outsider.error).toBeTruthy();
    const parentId = await testParentId(prisma, team.id);
    const huge = await mcp('work_attach_file', { work_id: parentId, filename: 'big.bin', mime_type: 'application/octet-stream', content: Buffer.alloc(51 * 1024 * 1024).toString('base64') });
    expect(huge.error).toMatch(/size limit/);
  });
});
