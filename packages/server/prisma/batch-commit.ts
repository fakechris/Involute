import { PrismaClient } from '@prisma/client';

import { commitWork } from '../src/claim-service.ts';
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
  const repoFilter = readFlag(args, 'repo');
  const teamKeyFilter = readFlag(args, 'team');
  const ownerEmail = readFlag(args, 'owner');
  const commitAll = hasFlag(args, 'all');

  const whereClause: import('@prisma/client').Prisma.IssueWhereInput = {
    commitmentStatus: 'CANDIDATE',
  };

  if (repoFilter) {
    whereClause.repository = repoFilter;
  }
  if (teamKeyFilter) {
    whereClause.team = { key: teamKeyFilter };
  }

  const candidates = await prisma.issue.findMany({
    where: whereClause,
    select: {
      id: true,
      identifier: true,
      title: true,
      kind: true,
      repository: true,
      revision: true,
      acceptance: true,
      assigneeId: true,
      teamId: true,
    },
    orderBy: { createdAt: 'asc' },
  });

  if (candidates.length === 0) {
    console.log('No matching candidate work items found to commit.');
    return;
  }

  // Find human admin or designated human owner
  const adminUser = ownerEmail
    ? await prisma.user.findUnique({ where: { email: ownerEmail } })
    : await prisma.user.findFirst({
        where: { actorKind: 'HUMAN', globalRole: 'ADMIN' },
      });

  if (!adminUser) {
    throw new Error('No human admin user found in database to act as commitment owner.');
  }

  const actor = writeActorFromViewer(adminUser, 'cli');
  console.log(`Found ${candidates.length} candidate(s) to commit on behalf of human owner: ${adminUser.name ?? adminUser.email} (${adminUser.id})`);

  const committedList: string[] = [];
  const errors: { identifier: string; error: string }[] = [];

  for (const candidate of candidates) {
    try {
      const acceptance =
        candidate.acceptance && candidate.acceptance.trim() !== ''
          ? candidate.acceptance.trim()
          : `Accepted and committed for execution: ${candidate.title}`;

      // Ensure assignee belongs to team
      let assigneeId = candidate.assigneeId;
      if (!assigneeId) {
        const teamMember = await prisma.teamMembership.findFirst({
          where: {
            teamId: candidate.teamId,
            user: { actorKind: 'HUMAN' },
          },
          select: { userId: true },
        });
        assigneeId = teamMember?.userId ?? adminUser.id;
      }

      await commitWork(
        prisma,
        candidate.id,
        {
          expectedRevision: candidate.revision,
          acceptance,
          assigneeId,
        },
        actor,
      );
      committedList.push(candidate.identifier);
      console.log(`✓ Committed [${candidate.identifier}] (${candidate.kind}): ${candidate.title}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push({ identifier: candidate.identifier, error: msg });
      console.error(`✗ Failed to commit [${candidate.identifier}]: ${msg}`);
    }
  }

  console.log('\n=== Batch Commit Summary ===');
  console.log(`Successfully committed: ${committedList.length}`);
  if (errors.length > 0) {
    console.log(`Failed / Skipped: ${errors.length}`);
    for (const e of errors) {
      console.log(`  - ${e.identifier}: ${e.error}`);
    }
  }
}

main()
  .catch((err) => {
    console.error('Batch commit failed:');
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
