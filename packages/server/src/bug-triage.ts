import { Prisma, type PrismaClient } from '@prisma/client';

import { createValidationError, TRIAGE_ROTATION_INVALID_MESSAGE } from './errors.js';

type DatabaseClient = PrismaClient | Prisma.TransactionClient;

const WEEK = 7 * 24 * 60 * 60 * 1000;

export interface TriageRotation {
  userIds: string[];
  /** The Monday (or any instant) the first person's week begins. */
  startsAt: string;
}

export function parseRotation(value: Prisma.JsonValue | null | undefined): TriageRotation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { userIds, startsAt } = value as Record<string, unknown>;
  if (!Array.isArray(userIds) || typeof startsAt !== 'string' || Number.isNaN(Date.parse(startsAt))) return null;
  const ids = userIds.filter((id): id is string => typeof id === 'string');
  return ids.length > 0 ? { userIds: ids, startsAt } : null;
}

/**
 * This week's triager (Bug route v1, INV-750): the rotation advances one
 * person per week from `startsAt`, wrapping around. Before the start date the
 * first person is on duty. Null when no rotation is configured.
 */
export function currentTriager(value: Prisma.JsonValue | null | undefined, now: Date): string | null {
  const rotation = parseRotation(value);
  if (!rotation) return null;
  const weeks = Math.floor((now.getTime() - Date.parse(rotation.startsAt)) / WEEK);
  const index = ((Math.max(0, weeks) % rotation.userIds.length) + rotation.userIds.length) % rotation.userIds.length;
  return rotation.userIds[index] ?? null;
}

/** Replace a team's rotation; members must be humans on the team. An empty list clears it. */
export async function setTriageRotation(
  prisma: DatabaseClient,
  input: { teamId: string; userIds: string[]; startsAt?: string | null },
): Promise<TriageRotation | null> {
  const userIds = [...new Set(input.userIds)];
  if (userIds.length === 0) {
    await prisma.team.update({ where: { id: input.teamId }, data: { triageRotation: Prisma.DbNull } });
    return null;
  }
  const startsAt = input.startsAt ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(startsAt))) throw createValidationError(TRIAGE_ROTATION_INVALID_MESSAGE);
  const members = await prisma.teamMembership.findMany({
    where: { teamId: input.teamId, userId: { in: userIds }, user: { actorKind: 'HUMAN' } },
    select: { userId: true },
  });
  if (members.length !== userIds.length) throw createValidationError(TRIAGE_ROTATION_INVALID_MESSAGE);
  const rotation: TriageRotation = { userIds, startsAt: new Date(startsAt).toISOString() };
  await prisma.team.update({ where: { id: input.teamId }, data: { triageRotation: rotation as unknown as Prisma.InputJsonValue } });
  return rotation;
}
