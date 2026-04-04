import type { PrismaClient } from '@prisma/client';

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

export async function seedDatabase(prisma: PrismaClient): Promise<void> {
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
    await prisma.workflowState.upsert({
      where: {
        teamId_name: {
          teamId: team.id,
          name,
        },
      },
      create: {
        name,
        teamId: team.id,
      },
      update: {},
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

  await prisma.user.upsert({
    where: {
      email: DEFAULT_ADMIN_EMAIL,
    },
    create: {
      email: DEFAULT_ADMIN_EMAIL,
      name: DEFAULT_ADMIN_NAME,
    },
    update: {
      name: DEFAULT_ADMIN_NAME,
    },
  });
}
