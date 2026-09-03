import { createHash } from 'node:crypto';

import type { Prisma, PrismaClient, WorkIdempotency } from '@prisma/client';

import { createValidationError, TEAM_NOT_FOUND_MESSAGE, WORK_IDEMPOTENCY_CONFLICT_MESSAGE } from './errors.js';
import type { WriteActor } from './work-service.js';

type DatabaseClient = PrismaClient | Prisma.TransactionClient;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function idempotencyActorKey(actor: WriteActor): string {
  return actor.actorId ?? `${actor.actorKind.toLowerCase()}:system`;
}

export function hashIdempotencyRequest(value: unknown): string {
  return createHash('sha256').update(stableJson(value), 'utf8').digest('hex');
}

export async function reserveWorkIdempotency(
  prisma: DatabaseClient,
  input: {
    actor: WriteActor;
    key: string;
    operation: string;
    requestHash: string;
    teamId: string;
  },
): Promise<{ created: boolean; record: WorkIdempotency }> {
  const actorKey = idempotencyActorKey(input.actor);
  if (!UUID_PATTERN.test(input.teamId)) {
    throw createValidationError(TEAM_NOT_FOUND_MESSAGE);
  }
  if (input.actor.actorId && !UUID_PATTERN.test(input.actor.actorId)) {
    throw createValidationError(TEAM_NOT_FOUND_MESSAGE);
  }
  const inserted = await prisma.$queryRaw<Array<{ id: string }>>`
    INSERT INTO "WorkIdempotency"
      ("id", "key", "operation", "teamId", "actorKey", "requestHash", "actorId", "createdAt")
    VALUES
      (gen_random_uuid(), ${input.key}, ${input.operation}, ${input.teamId}::uuid,
       ${actorKey}, ${input.requestHash}, ${input.actor.actorId ?? null}::uuid, CURRENT_TIMESTAMP)
    ON CONFLICT ("teamId", "actorKey", "operation", "key") DO NOTHING
    RETURNING "id"
  `;

  const record = await prisma.workIdempotency.findUniqueOrThrow({
    where: {
      work_idempotency_scope: {
        actorKey,
        key: input.key,
        operation: input.operation,
        teamId: input.teamId,
      },
    },
  });

  if (record.requestHash !== input.requestHash) {
    throw createValidationError(WORK_IDEMPOTENCY_CONFLICT_MESSAGE);
  }

  return { created: inserted.length === 1, record };
}

export async function completeWorkIdempotency(
  prisma: DatabaseClient,
  id: string,
  workId: string,
  resultId?: string | null,
): Promise<void> {
  await prisma.workIdempotency.update({
    where: { id },
    data: { workId, ...(resultId ? { resultId } : {}) },
  });
}

export function isUniqueConstraintError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = (error as { code?: string }).code;
  if (code === 'P2002') {
    return true;
  }
  const tag = (error as { [Symbol.toStringTag]?: string })[Symbol.toStringTag];
  return tag === 'PrismaClientKnownRequestError' && code === 'P2002';
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
