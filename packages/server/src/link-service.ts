import type { Prisma, PrismaClient, WorkLink, WorkLinkType } from '@prisma/client';

import {
  createNotFoundError,
  createValidationError,
  WORK_LINK_CYCLE_MESSAGE,
  WORK_LINK_ENDPOINT_NOT_FOUND_MESSAGE,
  WORK_LINK_NOT_FOUND_MESSAGE,
  WORK_LINK_SELF_REFERENCE_MESSAGE,
  WORK_LINK_TEAM_MISMATCH_MESSAGE,
} from './errors.js';
import { INTERNAL_WRITE_ACTOR, type WriteActor } from './work-service.js';

type DatabaseClient = PrismaClient | Prisma.TransactionClient;

const CYCLE_CHECKED_LINK_TYPES = new Set<WorkLinkType>(['CONTAINS', 'BLOCKS']);

export interface CreateWorkLinkInput {
  actor?: WriteActor | null;
  fromId: string;
  toId: string;
  type: WorkLinkType;
}

export async function createWorkLink(
  prisma: DatabaseClient,
  input: CreateWorkLinkInput,
): Promise<WorkLink> {
  if (isPrismaClient(prisma)) {
    return prisma.$transaction((transaction) => createWorkLink(transaction, input));
  }

  if (input.fromId === input.toId) {
    throw createValidationError(WORK_LINK_SELF_REFERENCE_MESSAGE);
  }

  const [fromIssue, toIssue] = await Promise.all([
    prisma.issue.findUnique({
      where: { id: input.fromId },
      select: { id: true, parentId: true, teamId: true },
    }),
    prisma.issue.findUnique({
      where: { id: input.toId },
      select: { id: true, parentId: true, teamId: true },
    }),
  ]);

  if (!fromIssue || !toIssue) {
    throw createNotFoundError(WORK_LINK_ENDPOINT_NOT_FOUND_MESSAGE);
  }

  if (fromIssue.teamId !== toIssue.teamId) {
    throw createValidationError(WORK_LINK_TEAM_MISMATCH_MESSAGE);
  }

  if (CYCLE_CHECKED_LINK_TYPES.has(input.type)) {
    await assertNoWorkLinkCycle(prisma, input.type, input.fromId, input.toId);
  }

  if (input.type === 'CONTAINS') {
    await prisma.workLink.deleteMany({
      where: {
        toId: input.toId,
        type: 'CONTAINS',
        NOT: {
          fromId: input.fromId,
        },
      },
    });
  }

  const existing = await prisma.workLink.findUnique({
    where: {
      fromId_toId_type: {
        fromId: input.fromId,
        toId: input.toId,
        type: input.type,
      },
    },
  });

  if (existing) {
    if (input.type === 'CONTAINS' && toIssue.parentId !== input.fromId) {
      await prisma.issue.update({
        where: { id: input.toId },
        data: { parentId: input.fromId },
      });
    }

    return existing;
  }

  const actor = input.actor ?? INTERNAL_WRITE_ACTOR;
  const created = await prisma.workLink.create({
    data: {
      actorId: actor.actorId ?? null,
      fromId: input.fromId,
      toId: input.toId,
      type: input.type,
    },
  });

  if (input.type === 'CONTAINS' && toIssue.parentId !== input.fromId) {
    await prisma.issue.update({
      where: { id: input.toId },
      data: { parentId: input.fromId },
    });
  }

  return created;
}

export async function deleteWorkLink(
  prisma: DatabaseClient,
  id: string,
): Promise<Pick<WorkLink, 'id'>> {
  if (isPrismaClient(prisma)) {
    return prisma.$transaction((transaction) => deleteWorkLink(transaction, id));
  }

  const existing = await prisma.workLink.findUnique({
    where: { id },
    select: { id: true, fromId: true, toId: true, type: true },
  });

  if (!existing) {
    throw createNotFoundError(WORK_LINK_NOT_FOUND_MESSAGE);
  }

  await prisma.workLink.delete({
    where: { id },
  });

  if (existing.type === 'CONTAINS') {
    const child = await prisma.issue.findUnique({
      where: { id: existing.toId },
      select: { parentId: true },
    });

    if (child?.parentId === existing.fromId) {
      await prisma.issue.update({
        where: { id: existing.toId },
        data: { parentId: null },
      });
    }
  }

  return { id: existing.id };
}

export async function listIncidentLinks(
  prisma: DatabaseClient,
  workId: string,
  type?: WorkLinkType | null,
): Promise<WorkLink[]> {
  return prisma.workLink.findMany({
    where: {
      ...(type ? { type } : {}),
      OR: [{ fromId: workId }, { toId: workId }],
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
}

export async function syncContainsFromParentId(
  prisma: DatabaseClient,
  childId: string,
  parentId: string | null,
  actor?: WriteActor | null,
): Promise<void> {
  if (parentId) {
    const input: CreateWorkLinkInput = {
      fromId: parentId,
      toId: childId,
      type: 'CONTAINS',
    };

    if (actor !== undefined) {
      input.actor = actor;
    }

    await createWorkLink(prisma, input);
    return;
  }

  await prisma.workLink.deleteMany({
    where: {
      toId: childId,
      type: 'CONTAINS',
    },
  });
}

export async function assertNoWorkLinkCycle(
  prisma: DatabaseClient,
  type: WorkLinkType,
  fromId: string,
  toId: string,
): Promise<void> {
  if (await canReach(prisma, type, toId, fromId)) {
    throw createValidationError(WORK_LINK_CYCLE_MESSAGE);
  }
}

async function canReach(
  prisma: DatabaseClient,
  type: WorkLinkType,
  startId: string,
  targetId: string,
): Promise<boolean> {
  const visited = new Set<string>();
  const queue = [startId];

  while (queue.length > 0) {
    const currentId = queue.shift();

    if (!currentId || visited.has(currentId)) {
      continue;
    }

    if (currentId === targetId) {
      return true;
    }

    visited.add(currentId);

    for (const neighborId of await outgoingNeighborIds(prisma, type, currentId)) {
      if (!visited.has(neighborId)) {
        queue.push(neighborId);
      }
    }
  }

  return false;
}

async function outgoingNeighborIds(
  prisma: DatabaseClient,
  type: WorkLinkType,
  fromId: string,
): Promise<string[]> {
  const links = await prisma.workLink.findMany({
    where: {
      fromId,
      type,
    },
    select: {
      toId: true,
    },
  });
  const neighborIds = new Set(links.map((link) => link.toId));

  if (type === 'CONTAINS') {
    const children = await prisma.issue.findMany({
      where: {
        parentId: fromId,
      },
      select: {
        id: true,
      },
    });

    for (const child of children) {
      neighborIds.add(child.id);
    }
  }

  return [...neighborIds];
}

function isPrismaClient(client: DatabaseClient): client is PrismaClient {
  return '$transaction' in client;
}
