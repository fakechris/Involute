import { PrismaClient } from '@prisma/client';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runImportPipeline } from '../src/import-pipeline.ts';

const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  'postgresql://involute:involute@127.0.0.1:5544/involute?schema=public';
const IMPORT_TEAM_KEY = 'E2E';
const IMPORT_TEAM_NAME = 'Imported Acceptance Team';
const IMPORT_LABEL_NAME = 'imported-e2e-label';
const IMPORT_USER_EMAIL = 'imported-e2e@example.com';

async function main(): Promise<void> {
  const command = process.argv[2];

  if (command !== 'seed' && command !== 'cleanup') {
    throw new Error(`Unsupported command: ${command ?? '(missing)'}`);
  }

  const prisma = new PrismaClient({
    datasources: {
      db: {
        url: DATABASE_URL,
      },
    },
  });

  try {
    await prisma.$connect();

    if (command === 'cleanup') {
      await resetImportedBoardAcceptanceData(prisma);
      return;
    }

    const exportDir = await mkdtemp(join(tmpdir(), 'involute-e2e-import-'));

    try {
      await resetImportedBoardAcceptanceData(prisma);
      await writeImportedBoardFixture(exportDir);
      await runImportPipeline(prisma, exportDir);
    } finally {
      await rm(exportDir, { recursive: true, force: true }).catch(() => {});
    }
  } finally {
    await prisma.$disconnect();
  }
}

async function writeImportedBoardFixture(exportDir: string): Promise<void> {
  await mkdir(exportDir, { recursive: true });
  await mkdir(join(exportDir, 'comments'), { recursive: true });

  await writeFile(
    join(exportDir, 'teams.json'),
    JSON.stringify([{ id: 'e2e-import-team', key: IMPORT_TEAM_KEY, name: IMPORT_TEAM_NAME }], null, 2),
  );
  await writeFile(
    join(exportDir, 'workflow_states.json'),
    JSON.stringify(
      [
        { id: 'e2e-state-triage', name: 'Triage', type: 'triage', position: 0, team: { id: 'e2e-import-team' } },
        { id: 'e2e-state-todo', name: 'Todo', type: 'unstarted', position: 1, team: { id: 'e2e-import-team' } },
        { id: 'e2e-state-done', name: 'Done', type: 'completed', position: 2, team: { id: 'e2e-import-team' } },
      ],
      null,
      2,
    ),
  );
  await writeFile(
    join(exportDir, 'labels.json'),
    JSON.stringify([{ id: 'e2e-label-1', name: IMPORT_LABEL_NAME, color: '#2563eb' }], null, 2),
  );
  await writeFile(
    join(exportDir, 'users.json'),
    JSON.stringify(
      [
        {
          id: 'e2e-user-1',
          name: 'Imported E2E User',
          email: IMPORT_USER_EMAIL,
          displayName: 'Imported E2E User',
          active: true,
        },
      ],
      null,
      2,
    ),
  );
  await writeFile(
    join(exportDir, 'issues.json'),
    JSON.stringify(
      [
        {
          id: 'e2e-issue-1',
          identifier: 'E2E-42',
          title: 'Imported triage issue',
          description: 'Fixture issue used for imported board acceptance.',
          priority: 1,
          createdAt: '2024-06-01T10:00:00.000Z',
          updatedAt: '2024-06-01T10:00:00.000Z',
          state: { id: 'e2e-state-triage', name: 'Triage' },
          team: { id: 'e2e-import-team', key: IMPORT_TEAM_KEY },
          assignee: { id: 'e2e-user-1', name: 'Imported E2E User', email: IMPORT_USER_EMAIL },
          labels: { nodes: [{ id: 'e2e-label-1', name: IMPORT_LABEL_NAME }] },
          parent: null,
        },
        {
          id: 'e2e-issue-2',
          identifier: 'E2E-43',
          title: 'Imported todo issue',
          description: null,
          priority: 2,
          createdAt: '2024-06-01T11:00:00.000Z',
          updatedAt: '2024-06-01T11:00:00.000Z',
          state: { id: 'e2e-state-todo', name: 'Todo' },
          team: { id: 'e2e-import-team', key: IMPORT_TEAM_KEY },
          assignee: null,
          labels: { nodes: [] },
          parent: null,
        },
        {
          id: 'e2e-issue-3',
          identifier: 'E2E-44',
          title: 'Imported done issue',
          description: null,
          priority: 3,
          createdAt: '2024-06-01T12:00:00.000Z',
          updatedAt: '2024-06-01T12:00:00.000Z',
          state: { id: 'e2e-state-done', name: 'Done' },
          team: { id: 'e2e-import-team', key: IMPORT_TEAM_KEY },
          assignee: null,
          labels: { nodes: [] },
          parent: null,
        },
      ],
      null,
      2,
    ),
  );
  await writeFile(
    join(exportDir, 'comments', 'e2e-issue-1.json'),
    JSON.stringify(
      [
        {
          id: 'e2e-comment-1',
          body: 'Imported comment from fixture.',
          createdAt: '2024-06-01T10:05:00.000Z',
          updatedAt: '2024-06-01T10:05:00.000Z',
          user: { id: 'e2e-user-1', name: 'Imported E2E User', email: IMPORT_USER_EMAIL },
        },
      ],
      null,
      2,
    ),
  );
}

async function resetImportedBoardAcceptanceData(prisma: PrismaClient): Promise<void> {
  await prisma.legacyLinearMapping.deleteMany({
    where: {
      oldId: {
        startsWith: 'e2e-',
      },
    },
  });
  await prisma.comment.deleteMany({
    where: {
      issue: {
        team: {
          key: IMPORT_TEAM_KEY,
        },
      },
    },
  });
  await prisma.issue.deleteMany({
    where: {
      team: {
        key: IMPORT_TEAM_KEY,
      },
    },
  });
  await prisma.workflowState.deleteMany({
    where: {
      team: {
        key: IMPORT_TEAM_KEY,
      },
    },
  });
  await prisma.team.deleteMany({
    where: {
      key: IMPORT_TEAM_KEY,
    },
  });
  await prisma.issueLabel.deleteMany({
    where: {
      name: IMPORT_LABEL_NAME,
    },
  });
  await prisma.user.deleteMany({
    where: {
      email: IMPORT_USER_EMAIL,
    },
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
