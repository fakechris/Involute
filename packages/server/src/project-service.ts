import type { PrismaClient, Project } from '@prisma/client';

import { createNotFoundError, createValidationError } from './errors.js';

export interface CreateProjectInput {
  teamId: string;
  name: string;
  description?: string | null;
  color?: string | null;
  status?: string | null;
  targetDate?: string | null;
  leadId?: string | null;
}

export interface UpdateProjectInput {
  name?: string | null;
  description?: string | null;
  color?: string | null;
  status?: string | null;
  targetDate?: string | null;
  leadId?: string | null;
}

export async function createProject(
  prisma: PrismaClient,
  input: CreateProjectInput,
): Promise<Project> {
  const team = await prisma.team.findUnique({
    where: { id: input.teamId },
    select: { id: true },
  });

  if (!team) {
    throw createNotFoundError('Team not found.');
  }

  if (input.leadId) {
    const lead = await prisma.user.findUnique({
      where: { id: input.leadId },
      select: { id: true },
    });
    if (!lead) {
      throw createNotFoundError('Lead user not found.');
    }
  }

  return prisma.project.create({
    data: {
      name: input.name,
      description: input.description ?? null,
      color: input.color ?? '#6366f1',
      status: input.status ?? 'planned',
      targetDate: input.targetDate ? new Date(input.targetDate) : null,
      teamId: input.teamId,
      leadId: input.leadId ?? null,
    },
  });
}

export async function updateProject(
  prisma: PrismaClient,
  id: string,
  input: UpdateProjectInput,
): Promise<Project> {
  const project = await prisma.project.findUnique({
    where: { id },
    select: { id: true },
  });

  if (!project) {
    throw createNotFoundError('Project not found.');
  }

  const data: Record<string, unknown> = {};

  if ('name' in input && input.name) {
    data.name = input.name;
  }
  if ('description' in input) {
    data.description = input.description ?? null;
  }
  if ('color' in input && input.color) {
    data.color = input.color;
  }
  if ('status' in input && input.status) {
    data.status = input.status;
  }
  if ('targetDate' in input) {
    data.targetDate = input.targetDate ? new Date(input.targetDate) : null;
  }
  if ('leadId' in input) {
    if (input.leadId) {
      const lead = await prisma.user.findUnique({
        where: { id: input.leadId },
        select: { id: true },
      });
      if (!lead) {
        throw createNotFoundError('Lead user not found.');
      }
    }
    data.leadId = input.leadId ?? null;
  }

  return prisma.project.update({
    where: { id },
    data,
  });
}

export async function deleteProject(
  prisma: PrismaClient,
  id: string,
): Promise<Pick<Project, 'id'>> {
  const project = await prisma.project.findUnique({
    where: { id },
    select: { id: true },
  });

  if (!project) {
    throw createNotFoundError('Project not found.');
  }

  await prisma.project.delete({ where: { id } });
  return project;
}
