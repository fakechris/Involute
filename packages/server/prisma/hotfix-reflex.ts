import { PrismaClient, type Prisma } from '@prisma/client';

import { commitWork, proposeWork } from '../src/claim-service.ts';
import { findWorkByIdOrIdentifier } from '../src/context-service.ts';
import { writeActorFromViewer } from '../src/work-service.ts';
import { loadProjectEnvironment } from './env.ts';

loadProjectEnvironment();

const prisma = new PrismaClient();

function readFlag(args: string[], name: string): string | null {
  const index = args.indexOf(`--${name}`);
  if (index === -1) {
    return null;
  }
  return args[index + 1] ?? null;
}

const hasFlag = (args: string[], name: string) => args.includes(`--${name}`);

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const title = readFlag(args, 'title');
  const parentArg = readFlag(args, 'parent');
  const teamKey = readFlag(args, 'team') ?? 'INV';
  const repo = readFlag(args, 'repo') ?? 'fakechris/Involute';
  const customDesc = readFlag(args, 'desc');
  const autoCommit = hasFlag(args, 'commit');

  if (!title || title.trim() === '') {
    console.error(`
[Involute Hotfix Reflex] Error: Missing required --title argument.

Usage:
  pnpm hotfix:reflex --title "Fix memory leak in link query" [--parent <INV-xxx>] [--commit]

Options:
  --title   Description of the fix (required)
  --parent  Parent issue or milestone identifier/UUID (e.g. INV-2)
  --team    Team key (default: INV)
  --repo    Repository (default: fakechris/Involute)
  --desc    Custom detailed description
  --commit  Immediately commit the candidate on behalf of human admin
`);
    process.exit(1);
  }

  const team = await prisma.team.findUnique({
    where: { key: teamKey },
  });

  if (!team) {
    console.error(`[Involute Hotfix Reflex] Error: Team with key "${teamKey}" not found.`);
    process.exit(1);
  }

  // Resolve parent work item
  let parentItem = null;
  if (parentArg) {
    parentItem = await findWorkByIdOrIdentifier(prisma, parentArg);
    if (!parentItem) {
      console.warn(`[Involute Hotfix Reflex] Warning: Specified parent "${parentArg}" not found, falling back to root project.`);
    }
  }

  if (!parentItem) {
    // Find root project for repo or team
    parentItem = await prisma.issue.findFirst({
      where: {
        teamId: team.id,
        repository: repo,
        kind: 'PROJECT',
      },
    });
  }

  const description =
    customDesc ??
    `### 1. 目标与架构定位
即时热修与计划外工作（Unplanned Hotfix）。在开发或排查过程中发现超出当前任务范围的问题，就地修复并自动闭环登记至 Involute，杜绝幽灵修复。

### 2. 核心功能与交付范围
${title.trim()}

### 3. 验收标准与验证方案
相关修改通过本地自动化测试与 TypeScript 类型检查，验证无功能回归。`;

  const candidate = await proposeWork(prisma, {
    acceptance: 'Fix verified by automated tests and typecheck; no regression.',
    description,
    kind: 'ISSUE',
    outcome: `Hotfix resolved: ${title.trim()}`,
    parentId: parentItem ? parentItem.id : null,
    relatedWorkId: parentItem ? parentItem.id : null,
    relatedWorkType: parentItem ? 'DISCOVERED_DURING' : null,
    repository: repo,
    scope: 'hotfix',
    source: 'hotfix-reflex',
    teamId: team.id,
    title: title.trim(),
    verification: 'Automated test suite and typecheck pass cleanly.',
  });

  console.log(`\n✓ Successfully created Involute Hotfix Item: [${candidate.identifier}] (${candidate.id})`);
  console.log(`  Title: ${candidate.title}`);
  if (parentItem) {
    console.log(`  Parent / Discovered During: [${parentItem.identifier}] ${parentItem.title}`);
  }

  if (autoCommit) {
    const adminUser = await prisma.user.findFirst({
      where: { actorKind: 'HUMAN', globalRole: 'ADMIN' },
    });

    if (adminUser) {
      const committed = await commitWork(
        prisma,
        candidate.id,
        {
          acceptance: 'Committed hotfix for execution.',
          assigneeId: adminUser.id,
          expectedRevision: candidate.revision,
        },
        writeActorFromViewer(adminUser, 'cli'),
      );
      console.log(`  Status: COMMITTED (assigned to ${adminUser.name ?? adminUser.email})`);
    } else {
      console.log(`  Status: CANDIDATE (awaiting commitment)`);
    }
  } else {
    console.log(`  Status: CANDIDATE (awaiting commitment at http://100.114.30.43:4201/candidates)`);
  }

  console.log(`\n👉 You can now safely commit your git changes using:`);
  console.log(`   git commit -m "fix: [${candidate.identifier}] ${title.trim()}"\n`);
}

main()
  .catch((err) => {
    console.error('[Involute Hotfix Reflex] Fatal error:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
