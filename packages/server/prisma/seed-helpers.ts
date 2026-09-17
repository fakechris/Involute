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
 * Clears the work-graph tables these tests write to, then re-seeds.
 *
 * Deliberately `deleteMany` rather than `TRUNCATE`: truncating takes ACCESS
 * EXCLUSIVE on every table named, which conflicts with any connection sitting
 * `idle in transaction` anywhere in the process and makes the reset queue
 * behind unrelated work. `deleteMany` takes row locks and only contends on the
 * rows it actually touches.
 *
 * Order is FK-safe, children before parents.
 *
 * Refuses to run against anything but a `_test` database — the same guard
 * `src/test-setup.ts` applies, repeated here because this helper is destructive
 * on its own.
 */
export async function resetAndSeed(prisma: PrismaClient): Promise<void> {
  const [database] = await prisma.$queryRaw<Array<{ current_database: string }>>`
    SELECT current_database()
  `;
  const name = database?.current_database ?? '';

  if (!name.endsWith('_test') && process.env.ALLOW_TESTS_ON_PROD_DB !== 'true') {
    throw new Error(`[SECURITY FATAL] Refusing to reset non-test database '${name}'.`);
  }

  // ActorAudit references users with Restrict (INV-586), so it goes first.
  await prisma.actorAudit.deleteMany();
  await prisma.decisionReceipt.deleteMany();
  await prisma.commentMention.deleteMany();
  await prisma.agentRequest.deleteMany();
  await prisma.comment.deleteMany();
  await prisma.eventOutbox.deleteMany();
  await prisma.notification.deleteMany();
  await prisma.workEvidence.deleteMany();
  await prisma.workRun.deleteMany();
  await prisma.issue.deleteMany();
  await prisma.agentCredential.deleteMany();
  await prisma.teamMembership.deleteMany();
  await prisma.workflowState.deleteMany();
  await prisma.team.deleteMany();
  await prisma.issueLabel.deleteMany();
  await prisma.user.deleteMany();
  await prisma.legacyLinearMapping.deleteMany();

  await seedDatabase(prisma);
}
