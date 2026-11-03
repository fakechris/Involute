import { createValidationError } from './errors.js';
import type { DatabaseClient } from './run-service-shared.js';

/**
 * A project to read the inbox for (INV-1545).
 *
 * Agent tokens are issued per kind of agent, not per project, so one agent
 * identity works in several projects at once and shares one inbox. A session
 * reads — and clears — only its own project's notifications by naming the
 * project: its repository (`fakechris/Involute`), its reference alias (`LUM`)
 * or its PROJECT item (`INV-79`).
 */
export async function resolveInboxRepository(prisma: DatabaseClient, value: string): Promise<string> {
  const reference = value.trim();
  if (!reference) throw createValidationError(inboxProjectUnknownMessage(value));
  if (reference.includes('/')) return reference;
  const project = await prisma.issue.findFirst({
    where: {
      kind: 'PROJECT',
      repository: { not: null },
      OR: [{ alias: reference.toUpperCase() }, { identifier: reference.toUpperCase() }],
    },
    select: { repository: true },
  });
  if (!project?.repository) throw createValidationError(inboxProjectUnknownMessage(reference));
  return project.repository;
}

export function inboxProjectUnknownMessage(value: string): string {
  return `repository: "${value}" names no project. Give its repository (owner/name), its reference alias or its PROJECT item.`;
}

/** The project of the work a tool call is about, for the unread reminder; null when it names none. */
export async function repositoryOfCall(prisma: DatabaseClient, args: Record<string, unknown>): Promise<string | null> {
  const raw = [args.work_id, args.id].find((value): value is string => typeof value === 'string' && value.trim().length > 0);
  if (!raw) return null;
  const reference = raw.trim();
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(reference);
  const work = await prisma.issue.findFirst({
    where: uuid ? { id: reference } : { identifier: reference.toUpperCase() },
    select: { repository: true },
  });
  return work?.repository ?? null;
}
