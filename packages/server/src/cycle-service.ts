import type { Cycle, PrismaClient } from '@prisma/client';

import { createNotFoundError, createValidationError } from './errors.js';

export interface CreateCycleInput {
  teamId: string;
  name: string;
  startsAt: string;
  endsAt: string;
}

export interface UpdateCycleInput {
  name?: string | null;
  startsAt?: string | null;
  endsAt?: string | null;
}

export async function createCycle(
  prisma: PrismaClient,
  input: CreateCycleInput,
): Promise<Cycle> {
  const team = await prisma.team.findUnique({
    where: { id: input.teamId },
    select: { id: true },
  });

  if (!team) {
    throw createNotFoundError('Team not found.');
  }

  const startsAt = new Date(input.startsAt);
  const endsAt = new Date(input.endsAt);

  if (endsAt <= startsAt) {
    throw createValidationError('End date must be after start date.');
  }

  const lastCycle = await prisma.cycle.findFirst({
    where: { teamId: input.teamId },
    orderBy: { number: 'desc' },
    select: { number: true },
  });

  const nextNumber = (lastCycle?.number ?? 0) + 1;

  return prisma.cycle.create({
    data: {
      name: input.name,
      number: nextNumber,
      startsAt,
      endsAt,
      teamId: input.teamId,
    },
  });
}

export async function updateCycle(
  prisma: PrismaClient,
  id: string,
  input: UpdateCycleInput,
): Promise<Cycle> {
  const cycle = await prisma.cycle.findUnique({
    where: { id },
    select: { id: true, startsAt: true, endsAt: true },
  });

  if (!cycle) {
    throw createNotFoundError('Cycle not found.');
  }

  const data: Record<string, unknown> = {};

  if ('name' in input && input.name) {
    data.name = input.name;
  }
  if ('startsAt' in input && input.startsAt) {
    data.startsAt = new Date(input.startsAt);
  }
  if ('endsAt' in input && input.endsAt) {
    data.endsAt = new Date(input.endsAt);
  }

  return prisma.cycle.update({
    where: { id },
    data,
  });
}

export async function deleteCycle(
  prisma: PrismaClient,
  id: string,
): Promise<Pick<Cycle, 'id'>> {
  const cycle = await prisma.cycle.findUnique({
    where: { id },
    select: { id: true },
  });

  if (!cycle) {
    throw createNotFoundError('Cycle not found.');
  }

  await prisma.cycle.delete({ where: { id } });
  return cycle;
}
