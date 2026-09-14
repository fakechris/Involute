import { readFile, stat, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { PrismaClient } from '@prisma/client';
import { loadProjectEnvironment } from './env.js';
import { applyGraphMigration, previewGraphMigration, rollbackGraphMigration, type GraphMigrationRequest } from '../src/graph-migration.js';

loadProjectEnvironment();
const prisma = new PrismaClient();
async function readJson(path: string) {
  if ((await stat(path)).size > 4 * 1024 * 1024) throw new Error('Migration input exceeds 4 MiB.');
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}
try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    request: { type: 'string' }, plan: { type: 'string' }, out: { type: 'string' },
    receipt: { type: 'string' }, 'actor-id': { type: 'string' },
  } });
  const command = positionals[0];
  const allowed: Record<string, string[]> = { preview: ['request', 'out'], apply: ['plan', 'actor-id'], rollback: ['receipt', 'actor-id'], status: ['receipt'] };
  if (positionals.length !== 1 || !command || !allowed[command] || Object.keys(values).some(key => !allowed[command]!.includes(key))) throw new Error('Invalid command or options.');
  if (command === 'preview' && values.request && values.out) {
    const plan = await previewGraphMigration(prisma, await readJson(values.request) as GraphMigrationRequest);
    await writeFile(values.out, JSON.stringify(plan, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ mode: 'preview', entries: plan.entries.length, writes: 0, output: values.out }));
  } else if (command === 'status' && values.receipt) {
    const receipt = await prisma.workGraphMigration.findUniqueOrThrow({ where: { id: values.receipt },
      select: { id: true, planHash: true, teamId: true, actorId: true, status: true, createdAt: true, rolledBackAt: true } });
    console.log(JSON.stringify(receipt));
  } else if ((command === 'apply' && values.plan) || (command === 'rollback' && values.receipt)) {
    if (!values['actor-id']) throw new Error('A human administrator actor ID is required.');
    const user = await prisma.user.findUniqueOrThrow({ where: { id: values['actor-id'] } });
    if (user.actorKind !== 'HUMAN' || user.globalRole !== 'ADMIN') throw new Error('Migration requires a human administrator.');
    const actor = { actorId: user.id, actorKind: user.actorKind, surface: 'operator-cli' };
    const receipt = command === 'apply'
      ? await applyGraphMigration(prisma, await readJson(values.plan!), actor)
      : await rollbackGraphMigration(prisma, values.receipt!, actor);
    console.log(JSON.stringify({ id: receipt.id, status: receipt.status, planHash: receipt.planHash }));
  } else throw new Error('Missing required options.');
} catch {
  console.error('Graph migration failed. Check command, input schema, administrator, preview freshness and database access. No raw payload or database URL is logged.');
  process.exitCode = 1;
} finally { await prisma.$disconnect(); }
