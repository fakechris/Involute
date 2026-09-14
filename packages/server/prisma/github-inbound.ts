import { parseArgs } from 'node:util';
import { PrismaClient } from '@prisma/client';
import { loadProjectEnvironment } from './env.js';
import { getGitHubInboundStatus, replayGitHubDelivery, safeErrorCode } from '../src/github-inbound.js';

loadProjectEnvironment();
const prisma = new PrismaClient();
try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { id: { type: 'string' }, reason: { type: 'string' }, 'expected-attempts': { type: 'string' } },
  });
  const command = positionals[0] ?? 'status';
  if (command === 'status' && positionals.length <= 1 && Object.keys(values).length === 0) {
    console.log(JSON.stringify(await getGitHubInboundStatus(prisma), null, 2));
  } else if (command === 'replay' && positionals.length === 1 && values.id && values.reason && /^\d+$/.test(values['expected-attempts'] ?? '')) {
    const receipt = await replayGitHubDelivery(prisma, values.id, values.reason, Number(values['expected-attempts']));
    console.log(JSON.stringify({ id: receipt.id, status: receipt.status, attempts: receipt.attempts }));
  } else {
    console.error('Usage: github:inbound status | replay --id <receipt-uuid> --expected-attempts <N> --reason <text>');
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`GitHub inbound operation failed (${safeErrorCode(error)}). Check command arguments, receipt status and database access.`);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
