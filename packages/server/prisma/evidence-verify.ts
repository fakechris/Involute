import { PrismaClient } from '@prisma/client';
import { loadProjectEnvironment } from './env.js';
import { verifyEvidence } from '../src/evidence-verification.js';
loadProjectEnvironment();
const prisma = new PrismaClient();
try {
  const [id, extra] = process.argv.slice(2);
  if (!id || extra || !/^[a-f0-9-]{36}$/.test(id)) throw new Error('INVALID_ARGUMENT');
  const result = await verifyEvidence(prisma, id);
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== 'VERIFIED') process.exitCode = 2;
} catch {
  console.error('Evidence verification unavailable. Supply a requested evidence UUID and configured GitHub App credentials.');
  process.exitCode = 1;
} finally { await prisma.$disconnect(); }
