import { readFileSync } from 'node:fs';

import { PrismaClient } from '@prisma/client';
import { afterAll, expect, it } from 'vitest';

import { resetAndSeed } from '../prisma/seed-helpers.js';
import { createIssue, deleteIssue, updateIssue } from './issue-service.js';

const prisma = new PrismaClient();
afterAll(() => prisma.$disconnect());

it('backfills deletions from undo tombstones exactly as deleteIssue records them (INV-1929)', async () => {
  await resetAndSeed(prisma);
  const team = await prisma.team.findFirstOrThrow();
  const child = await createIssue(prisma, { teamId: team.id, title: 'Child', repository: 'deletion/backfill' });
  const parent = await createIssue(prisma, { teamId: team.id, title: 'Parent', repository: 'deletion/backfill' });
  await updateIssue(prisma, child.id, { title: 'Child, renamed', parentId: parent.id });
  await deleteIssue(prisma, child.id);
  await deleteIssue(prisma, parent.id);
  const pick = (row: Record<string, unknown>) => ({
    workId: row.workId, teamId: row.teamId, identifier: row.identifier, repository: row.repository,
    parentIds: [...row.parentIds as string[]].sort(), audits: row.audits, final: row.final,
    revision: row.revision, actorKind: row.actorKind, actorId: row.actorId,
  });
  const written = (await prisma.workDeletion.findMany({ orderBy: { identifier: 'asc' } })).map(pick);
  expect(written).toHaveLength(2);
  expect(written.find(row => row.workId === child.id)?.parentIds).toEqual([parent.id]);

  await prisma.workDeletion.deleteMany();
  const migration = readFileSync(new URL('../prisma/migrations/20261119140000_work_deletion/migration.sql', import.meta.url), 'utf8');
  await prisma.$executeRawUnsafe(migration.slice(migration.indexOf('INSERT INTO')));
  expect((await prisma.workDeletion.findMany({ orderBy: { identifier: 'asc' } })).map(pick)).toEqual(written);
});
