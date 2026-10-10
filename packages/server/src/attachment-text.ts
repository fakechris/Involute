import { readFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import type { Prisma, PrismaClient } from '@prisma/client';

/**
 * Text of an attachment for search (INV-1117): research reports, postmortems
 * and logs attached to work become findable by work_search. Only plain text
 * formats are read; binaries and anything that is not valid UTF-8 are left
 * out. The text is capped so one huge log cannot bloat the index.
 */
export const MAX_ATTACHMENT_TEXT_CHARS = 100_000;

const TEXT_MIME_TYPES = new Set([
  'text/markdown',
  'text/x-markdown',
  'text/plain',
  'text/x-log',
  'application/json',
]);
const TEXT_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.log', '.json']);

export function isSearchableTextFile(filename: string, mimeType: string): boolean {
  const mime = mimeType.split(';')[0]!.trim().toLowerCase();
  return TEXT_MIME_TYPES.has(mime) || TEXT_EXTENSIONS.has(extname(filename).toLowerCase());
}

/** The searchable text of an upload, or null when it is not a text file. */
export function extractSearchableText(filename: string, mimeType: string, content: Buffer): string | null {
  if (!isSearchableTextFile(filename, mimeType)) return null;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    return null;
  }
  // A NUL byte means binary content (and Postgres text cannot hold it).
  if (text.includes('\u0000')) return null;
  // Cut by code point, so a cap never splits a surrogate pair.
  if (text.length <= MAX_ATTACHMENT_TEXT_CHARS) return text;
  return Array.from(text).slice(0, MAX_ATTACHMENT_TEXT_CHARS).join('');
}

/**
 * Reads text attachments that have no extracted text yet — uploads from
 * before INV-1117 — from the uploads directory. Run by `pnpm search:reindex`.
 * A file that is missing or unreadable is skipped and reported; it stays
 * eligible, so a later run picks it up once the file is restored.
 */
export async function backfillAttachmentText(
  prisma: PrismaClient | Prisma.TransactionClient,
  uploadsDir: string,
): Promise<{ indexed: number; skipped: number }> {
  const pending = await prisma.attachment.findMany({
    where: { textContent: null },
    select: { id: true, filename: true, mimeType: true, url: true },
    orderBy: { createdAt: 'asc' },
  });
  let indexed = 0;
  let skipped = 0;
  for (const attachment of pending) {
    if (!isSearchableTextFile(attachment.filename, attachment.mimeType)) continue;
    let text: string | null;
    try {
      text = extractSearchableText(attachment.filename, attachment.mimeType, readFileSync(join(uploadsDir, basename(attachment.url))));
    } catch (error) {
      console.warn(`[search] attachment ${attachment.id} (${attachment.filename}) not indexed: ${(error as Error).message}`);
      skipped += 1;
      continue;
    }
    if (text === null) {
      skipped += 1;
      continue;
    }
    await prisma.attachment.update({ where: { id: attachment.id }, data: { textContent: text } });
    indexed += 1;
  }
  return { indexed, skipped };
}
