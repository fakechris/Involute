import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PrismaClient } from '@prisma/client';

import { loadProjectEnvironment } from './env.ts';
import { ensureAdminUsers, normalizeAdminEmails } from './admin-helpers.ts';

loadProjectEnvironment();

function assertSafeTestDatabase(): void {
  const databaseUrl = process.env.DATABASE_URL ?? '';
  const nodeEnvironment = process.env.NODE_ENV ?? 'test';
  const isTestRuntime = nodeEnvironment === 'test' || process.env.VITEST === 'true' || process.env.CI === 'true';
  const isLocalDatabase = databaseUrl.includes('127.0.0.1')
    || databaseUrl.includes('localhost')
    || databaseUrl.includes('@db:')
    || databaseUrl.includes('/involute')
    || databaseUrl.includes('_test');

  if (!isTestRuntime || !isLocalDatabase) {
    throw new Error(
      'admin-helpers.test.ts requires a local test runtime and a local/test DATABASE_URL before destructive cleanup runs.',
    );
  }
}

const prisma = new PrismaClient();

describe('admin bootstrap helpers', () => {
  beforeAll(async () => {
    assertSafeTestDatabase();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.session.deleteMany();
    await prisma.teamMembership.deleteMany();
    await prisma.comment.deleteMany();
    await prisma.issue.deleteMany();
    await prisma.workflowState.deleteMany();
    await prisma.team.deleteMany();
    await prisma.issueLabel.deleteMany();
    await prisma.user.deleteMany();
    await prisma.legacyLinearMapping.deleteMany();
  });

  it('normalizes, de-duplicates, and lowercases admin emails', () => {
    expect(normalizeAdminEmails([
      ' Admin@One.Example ',
      'admin@one.example',
      '',
      'SECOND@example.com',
    ])).toEqual([
      'admin@one.example',
      'second@example.com',
    ]);
  });

  it('upserts admins without overwriting an existing display name', async () => {
    const existing = await prisma.user.create({
      data: {
        email: 'owner@example.com',
        globalRole: 'USER',
        name: 'Existing Owner',
      },
    });

    const users = await ensureAdminUsers(prisma, ['owner@example.com', 'new.admin@example.com']);

    expect(users).toHaveLength(2);

    const updatedExisting = await prisma.user.findUniqueOrThrow({
      where: {
        id: existing.id,
      },
    });
    const createdAdmin = await prisma.user.findUniqueOrThrow({
      where: {
        email: 'new.admin@example.com',
      },
    });

    expect(updatedExisting.globalRole).toBe('ADMIN');
    expect(updatedExisting.name).toBe('Existing Owner');
    expect(createdAdmin.globalRole).toBe('ADMIN');
    expect(createdAdmin.name).toBe('New Admin');
  });
});
