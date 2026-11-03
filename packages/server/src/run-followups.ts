import type { Prisma } from '@prisma/client';

import { createValidationError } from './errors.js';
import type { DatabaseClient } from './run-service-shared.js';

/**
 * What a completed run leaves behind (INV-1231).
 *
 * A run that completes says either which work it led to — items already
 * proposed or filed, each linked DISCOVERED_DURING to the work the run
 * finished — or why there is none. Before this, what was left over sat in the
 * summary's prose, or became candidates nobody tied back, and a reviewer had to
 * piece it together.
 *
 * The answer is frozen on the run with the rest of what it reported. Clients
 * written before the rule get a warning until RUN_FOLLOWUPS_REQUIRED_FROM;
 * after that a completed report without it is refused.
 */

/** Until this instant a completed run without followups is accepted with a warning. */
export const RUN_FOLLOWUPS_REQUIRED_FROM = new Date('2026-11-17T00:00:00.000Z');

let requiredFrom = RUN_FOLLOWUPS_REQUIRED_FROM;

export function followupsRequired(now: Date = new Date()): boolean {
  return now.getTime() >= requiredFrom.getTime();
}

/** Test hook: move the end of the transition (null restores it). */
export function setFollowupsRequiredFromForTests(date: Date | null): void {
  requiredFrom = date ?? RUN_FOLLOWUPS_REQUIRED_FROM;
}

export const RUN_FOLLOWUPS_MISSING_MESSAGE =
  'A completed run says what it leaves behind: followups { work_ids: ["INV-123", ...] } for the work it led to (propose or file it first), or followups { none_reason: "..." } when there is none.';

export const RUN_FOLLOWUPS_WARNING = `${RUN_FOLLOWUPS_MISSING_MESSAGE} Until ${RUN_FOLLOWUPS_REQUIRED_FROM.toISOString().slice(0, 10)} a completed run without it is accepted with this warning; after that it is refused.`;

export const RUN_FOLLOWUPS_BOTH_MESSAGE = 'followups takes work_ids or none_reason, not both.';
export const RUN_FOLLOWUPS_EMPTY_MESSAGE =
  'followups needs work_ids with at least one item, or a none_reason saying why nothing is left.';
export const RUN_FOLLOWUPS_REASON_BLANK_MESSAGE = 'followups.none_reason cannot be blank: say why nothing is left.';
export const RUN_FOLLOWUPS_NOT_COMPLETED_MESSAGE = 'followups are given with status: completed, when the run says what it leaves behind.';
export const RUN_FOLLOWUPS_SELF_MESSAGE = 'A run cannot list the work it completes as its own follow-up.';

export function runFollowupsUnreadableMessage(reference: string): string {
  return `followups.work_ids: ${reference} is not a work item you can read.`;
}

/** As a client writes it. */
export interface FollowupsInput {
  workIds?: readonly string[] | null | undefined;
  noneReason?: string | null | undefined;
}

/** As the run stores it. */
export type RunFollowups =
  | { workIds: string[]; identifiers: string[] }
  | { noneReason: string };

/**
 * Checks the shape and names every follow-up, refusing the first one that does
 * not exist or that the reporter may not read (both read the same, so a
 * reference does not reveal whether hidden work exists).
 */
export async function resolveFollowups(
  prisma: DatabaseClient,
  input: FollowupsInput,
  options: { workId: string; canRead: (workId: string) => Promise<boolean> },
): Promise<RunFollowups> {
  const workIds = input.workIds ?? null;
  const noneReason = input.noneReason ?? null;
  if (workIds && workIds.length > 0 && noneReason != null) throw createValidationError(RUN_FOLLOWUPS_BOTH_MESSAGE);
  if (noneReason != null) {
    const reason = noneReason.trim();
    if (!reason) throw createValidationError(RUN_FOLLOWUPS_REASON_BLANK_MESSAGE);
    return { noneReason: reason };
  }
  if (!workIds || workIds.length === 0) throw createValidationError(RUN_FOLLOWUPS_EMPTY_MESSAGE);

  const resolved: { id: string; identifier: string }[] = [];
  for (const raw of workIds) {
    const reference = raw.trim();
    const work = await findFollowup(prisma, reference);
    if (!work || !(await options.canRead(work.id))) throw createValidationError(runFollowupsUnreadableMessage(reference));
    if (work.id === options.workId) throw createValidationError(RUN_FOLLOWUPS_SELF_MESSAGE);
    if (!resolved.some((item) => item.id === work.id)) resolved.push(work);
  }
  return { workIds: resolved.map((item) => item.id), identifiers: resolved.map((item) => item.identifier) };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function findFollowup(prisma: DatabaseClient, reference: string): Promise<{ id: string; identifier: string } | null> {
  if (!reference) return null;
  return prisma.issue.findFirst({
    where: UUID_PATTERN.test(reference) ? { id: reference } : { identifier: reference.toUpperCase() },
    select: { id: true, identifier: true },
  });
}

/**
 * Each follow-up DISCOVERED_DURING the completed work; a link that already
 * exists is left as it is.
 */
export async function linkFollowups(
  prisma: DatabaseClient,
  followups: RunFollowups,
  workId: string,
  actorId: string | null,
): Promise<void> {
  if (!('workIds' in followups) || followups.workIds.length === 0) return;
  await prisma.workLink.createMany({
    data: followups.workIds.map((fromId) => ({ fromId, toId: workId, type: 'DISCOVERED_DURING' as const, actorId })),
    skipDuplicates: true,
  });
}

/** The stored value, for the run row. */
export function followupsJson(followups: RunFollowups): Prisma.InputJsonValue {
  return followups as unknown as Prisma.InputJsonValue;
}

/** What a run row's followups column holds, read back. */
export function readRunFollowups(value: unknown): { identifiers: string[]; noneReason: string | null } | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (typeof record.noneReason === 'string') return { identifiers: [], noneReason: record.noneReason };
  if (Array.isArray(record.identifiers)) {
    return { identifiers: record.identifiers.filter((entry): entry is string => typeof entry === 'string'), noneReason: null };
  }
  return null;
}
