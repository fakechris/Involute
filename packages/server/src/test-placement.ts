import type { PrismaClient } from '@prisma/client';

import { createIssue } from './issue-service.js';

const TEST_REPOSITORY = 'test/placement';

/**
 * Committed work needs a parent (norm v1, INV-718/719). Test fixtures that
 * propose and commit work place it under this team's committed test milestone,
 * created on first use after each database reset.
 */
export async function testParentId(
  prisma: PrismaClient,
  teamId: string,
  repository: string = TEST_REPOSITORY,
): Promise<string> {
  const existing = await prisma.issue.findFirst({
    where: { teamId, kind: 'MILESTONE', repository, commitmentStatus: 'COMMITTED', title: 'Test milestone' },
    select: { id: true },
  });
  if (existing) return existing.id;
  const project =
    (await prisma.issue.findFirst({ where: { teamId, kind: 'PROJECT', repository, commitmentStatus: 'COMMITTED' } })) ??
    (await createIssue(prisma, { teamId, kind: 'PROJECT', title: repository, repository }));
  const milestone = await createIssue(prisma, {
    teamId,
    kind: 'MILESTONE',
    title: 'Test milestone',
    repository,
    parentId: project.id,
  });
  return milestone.id;
}
