// Runs the INV-994 two-unit relay against DATABASE_URL (a local database, never
// production) and prints the ids it created, once with a passing and once
// with a failing fixture CI:  pnpm exec tsx scripts/local-delivery-relay.ts
import { PrismaClient } from '@prisma/client';
import { loadProjectEnvironment } from '../prisma/env.js';
import { DEFAULT_ADMIN_EMAIL, DEFAULT_TEAM_KEY } from '../prisma/seed-helpers.js';
import { relay } from '../src/delivery-relay-fixture.js';

loadProjectEnvironment();
const prisma = new PrismaClient();
try {
  for (const conclusion of ['success', 'failure'] as const) {
    const r = await relay(prisma, conclusion, { teamKey: process.env.RELAY_TEAM_KEY ?? DEFAULT_TEAM_KEY, humanEmail: process.env.RELAY_HUMAN_EMAIL ?? DEFAULT_ADMIN_EMAIL });
    console.log(`[INV-994 relay] ci=${conclusion} verification=${r.verification.status} unitB_ready=${r.readyB} root=${r.root.identifier} a=${r.a.identifier} b=${r.b.identifier} run=${r.run.publicId} evidence=${r.evidence.id} verification_id=${r.verification.id}`);
  }
} finally {
  await prisma.$disconnect();
}
