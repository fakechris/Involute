import type { PrismaClient, WorkflowStateType } from '@prisma/client';

import { ensureAdminUsers } from './admin-helpers.ts';
import {
  DEFAULT_ADMIN_EMAIL,
  DEFAULT_ADMIN_NAME,
  DEFAULT_LABEL_NAMES,
  DEFAULT_TEAM_KEY,
  DEFAULT_TEAM_NAME,
  DEFAULT_WORKFLOW_STATE_NAMES,
} from './constants.ts';

export {
  DEFAULT_ADMIN_EMAIL,
  DEFAULT_ADMIN_NAME,
  DEFAULT_LABEL_NAMES,
  DEFAULT_TEAM_KEY,
  DEFAULT_TEAM_NAME,
  DEFAULT_WORKFLOW_STATE_NAMES,
};

export interface SeedDatabaseOptions {
  includeDefaultAdmin?: boolean;
}

export async function seedDatabase(
  prisma: PrismaClient,
  options: SeedDatabaseOptions = {},
): Promise<void> {
  const includeDefaultAdmin = options.includeDefaultAdmin ?? true;
  const team = await prisma.team.upsert({
    where: {
      key: DEFAULT_TEAM_KEY,
    },
    create: {
      key: DEFAULT_TEAM_KEY,
      name: DEFAULT_TEAM_NAME,
    },
    update: {
      name: DEFAULT_TEAM_NAME,
    },
  });

  for (const name of DEFAULT_WORKFLOW_STATE_NAMES) {
    const typeByName: Record<(typeof DEFAULT_WORKFLOW_STATE_NAMES)[number], WorkflowStateType> = {
      Backlog: 'BACKLOG',
      Ready: 'UNSTARTED',
      'In Progress': 'STARTED',
      'In Review': 'REVIEW',
      Done: 'COMPLETED',
      Canceled: 'CANCELED',
    };
    const position = DEFAULT_WORKFLOW_STATE_NAMES.indexOf(name);
    await prisma.workflowState.upsert({
      where: {
        teamId_name: {
          teamId: team.id,
          name,
        },
      },
      create: {
        name,
        position,
        teamId: team.id,
        type: typeByName[name],
      },
      update: { position, type: typeByName[name] },
    });
  }

  // Upsert rather than check-then-create: `name` is unique, so a read followed
  // by a write loses the race against a concurrent seed and dies on the
  // constraint instead of being the no-op it is meant to be.
  for (const name of DEFAULT_LABEL_NAMES) {
    await prisma.issueLabel.upsert({
      where: { name },
      create: { name },
      update: {},
    });
  }

  if (includeDefaultAdmin) {
    const [admin] = await ensureAdminUsers(prisma, [DEFAULT_ADMIN_EMAIL], {
      defaultName: DEFAULT_ADMIN_NAME,
    });
    if (admin) {
      await prisma.teamMembership.upsert({
        where: { teamId_userId: { teamId: team.id, userId: admin.id } },
        create: { role: 'OWNER', teamId: team.id, userId: admin.id },
        update: { role: 'OWNER' },
      });
    }
  }
}

/**
 * Wipes every table and re-seeds, for test setup.
 *
 * One TRUNCATE instead of a chain of cascading `deleteMany` calls: the chain
 * gets slow enough on a loaded test database to intermittently trip vitest's
 * 10s hook timeout, and it has to be kept in FK order by hand.
 *
 * Refuses to run against anything but a `_test` database — the same guard
 * `src/test-setup.ts` applies, repeated here because this helper is destructive
 * on its own.
 */
export async function truncateAndSeed(prisma: PrismaClient): Promise<void> {
  const [database] = await prisma.$queryRaw<Array<{ current_database: string }>>`
    SELECT current_database()
  `;
  const name = database?.current_database ?? '';

  if (!name.endsWith('_test') && process.env.ALLOW_TESTS_ON_PROD_DB !== 'true') {
    throw new Error(`[SECURITY FATAL] Refusing to truncate non-test database '${name}'.`);
  }

  const tables = await prisma.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
  `;

  if (tables.length > 0) {
    const list = tables.map((table) => `"public"."${table.tablename}"`).join(', ');
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
  }

  await seedDatabase(prisma);
}
