import type { Issue, Prisma } from '@prisma/client';
import { createValidationError, WORK_LINK_TEAM_MISMATCH_MESSAGE } from './errors.js';

type Node = Pick<Issue, 'id' | 'kind' | 'teamId' | 'repository' | 'parentId'>;

/** All application hierarchy writers acquire this lock before reading graph state. */
export async function lockWorkGraph(tx: Prisma.TransactionClient, teamId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${teamId}, 0))`;
}

export function assertContainsEndpoints(parent: Node, child: Node): void {
  if (parent.teamId !== child.teamId) throw createValidationError(WORK_LINK_TEAM_MISMATCH_MESSAGE);
  const parentRepo = parent.repository;
  const childRepo = child.repository;
  if (!parentRepo?.trim() || !childRepo?.trim()) throw createValidationError('CONTAINS requires an explicit repository on both endpoints.');
  if (parentRepo !== parentRepo.trim() || childRepo !== childRepo.trim()) throw createValidationError('CONTAINS repository values must not have surrounding whitespace.');
  if (parentRepo !== childRepo) throw createValidationError('CONTAINS cannot cross repository boundaries.');
  const legal = (parent.kind === 'PROJECT' && (child.kind === 'MILESTONE' || child.kind === 'DECISION'))
    || (parent.kind === 'MILESTONE' && child.kind === 'ISSUE');
  if (!legal) throw createValidationError('CONTAINS requires PROJECT → MILESTONE → ISSUE, or PROJECT → DECISION.');
}

/** Validate a prospective node against both persisted hierarchy representations. */
export async function assertNodeHierarchy(tx: Prisma.TransactionClient, node: Node, replacingParent = false): Promise<void> {
  const incoming = replacingParent ? [] : await tx.workLink.findMany({
    where: { type: 'CONTAINS', toId: node.id }, select: { fromId: true },
  });
  const parents = new Set(incoming.map(link => link.fromId));
  if (node.parentId) parents.add(node.parentId);
  if (parents.size > 1) throw createValidationError('CONTAINS cannot have multiple parents; use an explicit parent update.');
  for (const id of parents) {
    const parent = await tx.issue.findUnique({ where: { id } });
    if (!parent) throw createValidationError('Hierarchy parent does not exist.');
    assertContainsEndpoints(parent, node);
  }
  const links = await tx.workLink.findMany({ where: { type: 'CONTAINS', fromId: node.id }, select: { toId: true } });
  const children = await tx.issue.findMany({ where: { OR: [
    { parentId: node.id }, { id: { in: links.map(link => link.toId) } },
  ] } });
  for (const child of children) assertContainsEndpoints(node, child);
}

/**
 * Recursively find all descendant node IDs reachable via CONTAINS hierarchy
 * (inspecting both parentId and WorkLink type=CONTAINS).
 */
export async function getContainsDescendantIds(
  tx: Prisma.TransactionClient,
  rootId: string,
): Promise<string[]> {
  const visited = new Set<string>();
  const queue: string[] = [rootId];

  while (queue.length > 0) {
    const currentId = queue.shift()!;
    const links = await tx.workLink.findMany({
      where: { type: 'CONTAINS', fromId: currentId },
      select: { toId: true },
    });
    const children = await tx.issue.findMany({
      where: {
        OR: [
          { parentId: currentId },
          { id: { in: links.map((link) => link.toId) } },
        ],
      },
      select: { id: true },
    });

    for (const child of children) {
      if (!visited.has(child.id) && child.id !== rootId) {
        visited.add(child.id);
        queue.push(child.id);
      }
    }
  }

  return Array.from(visited);
}
