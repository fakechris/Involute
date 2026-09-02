import { createHash } from 'node:crypto';

import type { Prisma, PrismaClient, WorkIdempotency } from '@prisma/client';

import { createValidationError, WORK_IDEMPOTENCY_CONFLICT_MESSAGE } from './errors.js';
import type { WriteActor } from './work-service.js';

type DatabaseClient = PrismaClient | Prisma.TransactionClient;

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
): Promise<void> {
  await prisma.workIdempotency.update({
    where: { id },
    data: { workId },
  });
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
