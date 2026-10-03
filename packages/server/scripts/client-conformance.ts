/** Native-client fixture host. Run only with a dedicated *_test database. */
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { seedDatabase, DEFAULT_ADMIN_EMAIL, DEFAULT_TEAM_KEY } from '../prisma/seed-helpers.js';
import { startServer } from '../src/index.js';
import { issueAgentCredential } from '../src/agent-credentials.js';
import { createIssue } from '../src/issue-service.js';

const database = new URL(process.env.DATABASE_URL ?? '');
if (!database.pathname.endsWith('_test') || !['localhost', '127.0.0.1'].includes(database.hostname)) throw new Error('Use a dedicated loopback *_test database.');
const output = process.env.NATIVE_FIXTURE_PATH;
if (!output || !output.startsWith('/')) throw new Error('Set NATIVE_FIXTURE_PATH to an absolute private path outside the repository.');
if (resolve(output).startsWith(resolve(dirname(fileURLToPath(import.meta.url)), '../../..') + '/')) throw new Error('Fixture credentials must be outside the repository.');
const prisma = new PrismaClient();
if (process.env.NATIVE_REUSE === '1') {
  const fixture = JSON.parse(await readFile(output, 'utf8'));
  const server = await startServer({ prisma, authToken: fixture.authToken, allowAdminFallback: true, semanticIndex: null, port: Number(process.env.NATIVE_PORT ?? 4466) });
  console.log(JSON.stringify({ ready: true, server: server.url, reused: true }));
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => void server.stop().then(() => prisma.$disconnect()).then(() => process.exit(0)));
  await new Promise(() => {});
}
await seedDatabase(prisma);
const human = await prisma.user.findUniqueOrThrow({ where: { email: DEFAULT_ADMIN_EMAIL } });
const team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
const suffix = randomBytes(6).toString('hex');
const repository = `conformance/native-${suffix}`;
const root = await createIssue(prisma, { teamId: team.id, kind: 'PROJECT', title: repository, repository });
const parent = await createIssue(prisma, { teamId: team.id, kind: 'MILESTONE', title: 'Native clients', repository, parentId: root.id });
const clients = {} as Record<string, unknown>;
for (const name of ['codex', 'claude']) clients[name] = await issueAgentCredential(prisma, { name: `${name}-${suffix}`, teamKey: team.key, ownerId: human.id, issuedById: human.id });
const authToken = randomBytes(32).toString('hex');
const server = await startServer({ prisma, authToken, allowAdminFallback: true, semanticIndex: null, port: Number(process.env.NATIVE_PORT ?? 4466) });
await mkdir(dirname(output), { recursive: true, mode: 0o700 });
await writeFile(output, JSON.stringify({ server: server.url, authToken, clients, repository, root, parent, teamId: team.id, ownerId: human.id }), { mode: 0o600 });
await chmod(output, 0o600);
console.log(JSON.stringify({ ready: true, server: server.url, repository, rootId: root.id }));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => void server.stop().then(() => prisma.$disconnect()).then(() => process.exit(0)));
