import type { Issue, Prisma } from '@prisma/client';

import { createValidationError, exposeErrorMessages } from './errors.js';

/**
 * The web origins a PROJECT's app is served from (INV-1146). The bug-capture
 * extension asks projectForOrigin which project a page belongs to, so an
 * origin points at one project, and is stored as `scheme://host[:port]`,
 * lowercased, without a default port or a path.
 */
export const WEB_ORIGIN_LIMIT = 20;
export const WEB_ORIGIN_FORMAT_MESSAGE = 'A web origin is an http(s) address such as https://app.example.com.';
export const WEB_ORIGINS_KIND_MESSAGE = 'Only a PROJECT can have web origins.';
export const WEB_ORIGIN_TAKEN_MESSAGE = 'That web origin already belongs to another project.';
export const WEB_ORIGINS_TOO_MANY_MESSAGE = `A project has at most ${WEB_ORIGIN_LIMIT} web origins.`;
exposeErrorMessages([WEB_ORIGIN_FORMAT_MESSAGE, WEB_ORIGINS_KIND_MESSAGE, WEB_ORIGIN_TAKEN_MESSAGE, WEB_ORIGINS_TOO_MANY_MESSAGE]);

/** `scheme://host[:port]` for an http(s) address, or null when it is not one. */
export function normalizeWebOrigin(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname || url.username || url.password) return null;
  return url.origin.toLowerCase();
}

/** The normalized, deduplicated list to store, or a refusal naming the problem. */
export async function validProjectWebOrigins(
  db: Prisma.TransactionClient,
  existing: Pick<Issue, 'id' | 'kind'>,
  input: { webOrigins?: readonly string[] | null; kind?: Issue['kind'] | null },
): Promise<string[]> {
  const origins: string[] = [];
  for (const value of input.webOrigins ?? []) {
    if (typeof value !== 'string') throw createValidationError(WEB_ORIGIN_FORMAT_MESSAGE);
    if (!value.trim()) continue;
    const origin = normalizeWebOrigin(value);
    if (!origin) throw createValidationError(WEB_ORIGIN_FORMAT_MESSAGE);
    if (!origins.includes(origin)) origins.push(origin);
  }
  if (origins.length === 0) return [];
  if ((input.kind ?? existing.kind) !== 'PROJECT') throw createValidationError(WEB_ORIGINS_KIND_MESSAGE);
  if (origins.length > WEB_ORIGIN_LIMIT) throw createValidationError(WEB_ORIGINS_TOO_MANY_MESSAGE);
  const claimed = await db.issue.findFirst({
    where: { id: { not: existing.id }, kind: 'PROJECT', commitmentStatus: { not: 'REJECTED' }, webOrigins: { hasSome: origins } },
    select: { id: true },
  });
  if (claimed) throw createValidationError(WEB_ORIGIN_TAKEN_MESSAGE);
  return origins;
}
