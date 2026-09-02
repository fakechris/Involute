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

  for (const name of DEFAULT_LABEL_NAMES) {
    const existingLabel = await prisma.issueLabel.findFirst({
      where: {
        name,
      },
      select: {
        id: true,
      },
    });

    if (!existingLabel) {
      await prisma.issueLabel.create({
        data: {
          name,
        },
      });
    }
  }

  if (includeDefaultAdmin) {
    const [admin] = await ensureAdminUsers(prisma, [DEFAULT_ADMIN_EMAIL], {
      defaultName: DEFAULT_ADMIN_NAME,
    });
    if (admin) {
      await prisma.teamMembership.upsert({
        where: { teamId_userId: { teamId: team.id, userId: admin.id } },
        create: { role: 'OWNER', teamId: team.id, userId: admin.id },
        update: {},
      });
    }
  }
}
