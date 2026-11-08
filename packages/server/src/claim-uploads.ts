import type { Prisma, PrismaClient } from '@prisma/client';

import { CAPTURE_MESSAGES } from './bug-capture.js';
import { createValidationError } from './errors.js';
import type { WriteActor } from './work-service.js';

type DatabaseClient = PrismaClient | Prisma.TransactionClient;

const UPLOAD_PATH = /\/uploads\/([A-Za-z0-9][A-Za-z0-9._-]*)/g;

/** `/uploads/<name>` paths named in text, including when the text uses an absolute URL. */
export function referencedUploadUrls(text: string | null | undefined): string[] {
  if (!text) return [];
  const urls: string[] = [];
  for (const match of text.matchAll(UPLOAD_PATH)) {
    const name = match[1];
    if (!name) continue;
    const url = `/uploads/${name}`;
    if (!urls.includes(url)) urls.push(url);
  }
  return urls;
}

/**
 * Attach the caller's own unlinked uploads that the text names. Someone else's
 * file, or a file already on other work, is left where it is. No actor is a no-op.
 * Removing the picture from the text later does not delete the file.
 */
export async function claimReferencedUploads(
  prisma: DatabaseClient,
  actor: WriteActor,
  issueId: string,
  text: string | null | undefined,
  commentId?: string | null,
): Promise<number> {
  if (!actor.actorId) return 0;
  const urls = referencedUploadUrls(text);
  if (urls.length === 0) return 0;
  const result = await prisma.attachment.updateMany({
    where: { url: { in: urls }, uploaderId: actor.actorId, issueId: null, commentId: null },
    data: { issueId, ...(commentId ? { commentId } : {}) },
  });
  return result.count;
}

/**
 * Attach uploads the caller names by id. A missing file, someone else's file,
 * or a file already on other work refuses the whole call. A file already on
 * this work is left as it is, so a URL claim and an id claim of the same file
 * do not collide.
 */
export async function claimOwnUnattached(
  prisma: DatabaseClient,
  actor: WriteActor,
  issueId: string,
  ids: readonly string[],
): Promise<number> {
  const unique = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
  if (unique.length === 0) return 0;
  if (!actor.actorId) throw createValidationError(CAPTURE_MESSAGES.screenshot);
  const rows = await prisma.attachment.findMany({
    where: { id: { in: unique } },
    select: { id: true, uploaderId: true, issueId: true, commentId: true },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  const toClaim: string[] = [];
  for (const id of unique) {
    const row = byId.get(id);
    if (!row || row.uploaderId !== actor.actorId) throw createValidationError(CAPTURE_MESSAGES.screenshot);
    if (row.issueId || row.commentId) {
      if (row.issueId === issueId && !row.commentId) continue;
      throw createValidationError(CAPTURE_MESSAGES.screenshot);
    }
    toClaim.push(id);
  }
  if (toClaim.length === 0) return 0;
  const result = await prisma.attachment.updateMany({
    where: { id: { in: toClaim }, uploaderId: actor.actorId, issueId: null, commentId: null },
    data: { issueId },
  });
  if (result.count !== toClaim.length) throw createValidationError(CAPTURE_MESSAGES.screenshot);
  return result.count;
}
