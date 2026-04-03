import { PrismaClient, type Team } from '@prisma/client';

import { createIssue } from './issue-service.js';
import {
  CANONICAL_LABEL_NAMES,
  CANONICAL_WORKFLOW_STATE_NAMES,
} from './validation-data-constants.js';

const VALIDATION_EMPTY_TEAM_KEY = 'VAL';
const VALIDATION_EMPTY_TEAM_NAME = 'Validation Empty Board';
const APP_TEAM_KEY = 'APP';
const APP_TEAM_NAME = 'App';
const SON_TEAM_NAME = 'Sonata';
const VALIDATION_PREFIX = 'web-ui-validation';
const SMALL_SCENARIO_TITLES = [
  'Backlog validation card',
  'Ready validation card',
  'In Progress validation card',
  'In Review validation card',
  'Done validation card',
  'Canceled validation card',
] as const;
const MANY_ISSUES_TOTAL = 60;

export interface ValidationDataSetupSummary {
  appTeamId: string;
  emptyTeamId: string;
  invIssueIdentifiers: string[];
  labelsCount: number;
  manyIssueCount: number;
  sonTeamPresent: boolean;
  teams: Array<{
    id: string;
    issueCount: number;
    key: string;
    name: string;
    stateCount: number;
  }>;
}

export async function runValidationDataSetup(
  prisma: PrismaClient,
): Promise<ValidationDataSetupSummary> {
  await ensureCanonicalLabels(prisma);
  await ensureAdminUser(prisma);

  const invTeam = await prisma.team.upsert({
    where: { key: 'INV' },
    create: { key: 'INV', name: 'Involute' },
    update: { name: 'Involute' },
  });

  await ensureCanonicalStates(prisma, invTeam);

  const appTeam = await ensureTeamWithStates(prisma, APP_TEAM_KEY, APP_TEAM_NAME);
  const emptyTeam = await ensureTeamWithStates(
    prisma,
    VALIDATION_EMPTY_TEAM_KEY,
    VALIDATION_EMPTY_TEAM_NAME,
  );

  await ensureUniqueIssuesAcrossStates(prisma, invTeam);
  const manyIssueCount = await ensureManyIssuesScenario(prisma, invTeam);

  const labelsCount = await prisma.issueLabel.count({
    where: {
      name: {
        in: [...CANONICAL_LABEL_NAMES],
      },
    },
  });

  const teams = await prisma.team.findMany({
    include: {
      states: true,
      _count: {
        select: {
          issues: true,
        },
      },
    },
    orderBy: {
      key: 'asc',
    },
  });

  const sonTeamPresent = teams.some((team) => team.key === 'SON');

  await backfillImportedTeamStates(prisma);

  const validationIssues = await prisma.issue.findMany({
    where: {
      teamId: invTeam.id,
      title: {
        startsWith: `${VALIDATION_PREFIX}: `,
      },
    },
    orderBy: {
      identifier: 'asc',
    },
    select: {
      identifier: true,
    },
  });

  return {
    appTeamId: appTeam.id,
    emptyTeamId: emptyTeam.id,
    invIssueIdentifiers: validationIssues.map((issue) => issue.identifier),
    labelsCount,
    manyIssueCount,
    sonTeamPresent,
    teams: teams.map((team) => ({
      id: team.id,
      issueCount: team._count.issues,
      key: team.key,
      name: team.name,
      stateCount: team.states.length,
    })),
  };
}

async function ensureCanonicalStates(prisma: PrismaClient, team: Team): Promise<void> {
  const existingStates = await prisma.workflowState.findMany({
    where: { teamId: team.id },
    select: { id: true, name: true },
  });
  const existingNames = new Set(existingStates.map((state) => state.name));

  for (const stateName of CANONICAL_WORKFLOW_STATE_NAMES) {
    if (existingNames.has(stateName)) {
      continue;
    }

    await prisma.workflowState.create({
      data: {
        name: stateName,
        teamId: team.id,
      },
    });
  }
}

async function ensureTeamWithStates(
  prisma: PrismaClient,
  key: string,
  name: string,
): Promise<Team> {
  const team = await prisma.team.upsert({
    where: { key },
    create: { key, name },
    update: { name },
  });

  await ensureCanonicalStates(prisma, team);

  return team;
}

async function ensureCanonicalLabels(prisma: PrismaClient): Promise<void> {
  for (const labelName of CANONICAL_LABEL_NAMES) {
    await prisma.issueLabel.upsert({
      where: { name: labelName },
      create: { name: labelName },
      update: {},
    });
  }
}

async function ensureAdminUser(prisma: PrismaClient): Promise<void> {
  await prisma.user.upsert({
    where: { email: 'admin@involute.local' },
    create: {
      email: 'admin@involute.local',
      name: 'Admin',
    },
    update: {
      name: 'Admin',
    },
  });
}

async function ensureUniqueIssuesAcrossStates(prisma: PrismaClient, team: Team): Promise<void> {
  const states = await prisma.workflowState.findMany({
    where: { teamId: team.id },
    orderBy: {
      name: 'asc',
    },
  });
  const stateByName = new Map(states.map((state) => [state.name, state] as const));

  for (const title of SMALL_SCENARIO_TITLES) {
    const stateName = title.replace(' validation card', '');
    const state = stateByName.get(stateName);

    if (!state) {
      continue;
    }

    const fullTitle = `${VALIDATION_PREFIX}: ${title}`;
    const existing = await prisma.issue.findFirst({
      where: {
        teamId: team.id,
        title: fullTitle,
      },
      select: { id: true },
    });

    if (existing) {
      continue;
    }

    await createIssue(prisma, {
      teamId: team.id,
      title: fullTitle,
      description: `Seeded for ${state.name} board validation.`,
      stateId: state.id,
    });
  }
}

async function ensureManyIssuesScenario(prisma: PrismaClient, team: Team): Promise<number> {
  const backlogState = await prisma.workflowState.findFirstOrThrow({
    where: {
      teamId: team.id,
      name: 'Backlog',
    },
  });

  const existingCount = await prisma.issue.count({
    where: {
      teamId: team.id,
      title: {
        startsWith: `${VALIDATION_PREFIX}: Many issues `,
      },
    },
  });

  for (let index = existingCount; index < MANY_ISSUES_TOTAL; index += 1) {
    await createIssue(prisma, {
      teamId: team.id,
      title: `${VALIDATION_PREFIX}: Many issues ${String(index + 1).padStart(2, '0')}`,
      description: 'Seeded for board scrolling and performance validation.',
      stateId: backlogState.id,
    });
  }

  return prisma.issue.count({
    where: {
      teamId: team.id,
      title: {
        startsWith: `${VALIDATION_PREFIX}: Many issues `,
      },
    },
  });
}

async function backfillImportedTeamStates(prisma: PrismaClient): Promise<void> {
  const importedTeams = await prisma.team.findMany({
    where: {
      NOT: {
        key: {
          in: ['INV', APP_TEAM_KEY, VALIDATION_EMPTY_TEAM_KEY],
        },
      },
    },
  });

  for (const team of importedTeams) {
    await ensureCanonicalStates(prisma, team);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await import('dotenv').then(({ config }) => {
    config({
      path: new URL('../../../.env', import.meta.url),
    });
  });

  const prisma = new PrismaClient();

  runValidationDataSetup(prisma)
    .then((summary) => {
      console.log(JSON.stringify(summary, null, 2));
    })
    .catch((error: unknown) => {
      console.error('Failed to align validation data.');
      console.error(error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
