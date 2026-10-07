import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_ADMIN_EMAIL, DEFAULT_TEAM_KEY, resetAndSeed } from '../prisma/seed-helpers.js';
import { loadProjectEnvironment } from '../prisma/env.js';
import { relay } from './delivery-relay-fixture.js';
loadProjectEnvironment();
const prisma = new PrismaClient();
const SEED = { teamKey: DEFAULT_TEAM_KEY, humanEmail: DEFAULT_ADMIN_EMAIL };
beforeEach(async () => { await resetAndSeed(prisma); });
afterAll(async () => { await resetAndSeed(prisma); await prisma.$disconnect(); });

// INV-994: see delivery-relay-fixture.ts.
describe('two-unit delivery relay with a local fixture verifier (INV-994)', () => {
  it('releases the second unit once the first unit\'s CI evidence is VERIFIED', async () => {
    const r = await relay(prisma, 'success', SEED);
    expect(r.verification.status).toBe('VERIFIED');
    expect(r.readyB).toBe(true);
  });

  it('keeps the second unit blocked when the first unit\'s check FAILED', async () => {
    const r = await relay(prisma, 'failure', SEED);
    expect(r.verification.status).toBe('FAILED');
    expect(r.readyB).toBe(false);
  });
});
