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
  return capCodePoints(text, MAX_ATTACHMENT_TEXT_CHARS);
}

/**
 * The first `limit` code points of `text`. Walks at most `limit` code points
 * (never the whole string, which may be a 50 MiB log) and cuts by UTF-16
 * index, so a surrogate pair is never split.
 */
function capCodePoints(text: string, limit: number): string {
  // UTF-16 length bounds the code point count from above.
  if (text.length <= limit) return text;
  let end = 0;
  let count = 0;
  while (count < limit && end < text.length) {
    const unit = text.charCodeAt(end);
    const pair = unit >= 0xd800 && unit <= 0xdbff && end + 1 < text.length;
    end += pair ? 2 : 1;
    count += 1;
  }
  return text.slice(0, end);
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
  options: { pageSize?: number } = {},
): Promise<{ indexed: number; skipped: number }> {
  const pageSize = options.pageSize ?? 100;
  // Only text candidates: binaries keep a null text forever and must not be reloaded on every run.
  // startsWith also covers a parameter such as `text/plain; charset=utf-8`.
  const textCandidate: Prisma.AttachmentWhereInput = {
    textContent: null,
    OR: [
      ...[...TEXT_MIME_TYPES].map((mime) => ({ mimeType: { startsWith: mime, mode: 'insensitive' as const } })),
      ...[...TEXT_EXTENSIONS].map((extension) => ({ filename: { endsWith: extension, mode: 'insensitive' as const } })),
    ],
  };
  let indexed = 0;
  let skipped = 0;
  // Keyset paging on id: rows filled in this run leave the filter, so a
  // Prisma cursor (which skips the cursor row) could skip a pending one.
  let after: string | null = null;
  for (;;) {
    const page: Array<{ id: string; filename: string; mimeType: string; url: string }> = await prisma.attachment.findMany({
      where: after ? { AND: [textCandidate, { id: { gt: after } }] } : textCandidate,
      select: { id: true, filename: true, mimeType: true, url: true },
      orderBy: { id: 'asc' },
      take: pageSize,
    });
    if (page.length === 0) break;
    after = page[page.length - 1]!.id;
    for (const attachment of page) {
      if (await backfillOne(prisma, uploadsDir, attachment)) indexed += 1;
      else skipped += 1;
    }
  }
  return { indexed, skipped };
}

async function backfillOne(
  prisma: PrismaClient | Prisma.TransactionClient,
  uploadsDir: string,
  attachment: { id: string; filename: string; mimeType: string; url: string },
): Promise<boolean> {
  let text: string | null;
  try {
    text = extractSearchableText(attachment.filename, attachment.mimeType, readFileSync(join(uploadsDir, basename(attachment.url))));
  } catch (error) {
    console.warn(`[search] attachment ${attachment.id} (${attachment.filename}) not indexed: ${(error as Error).message}`);
    return false;
  }
  if (text === null) return false;
  await prisma.attachment.update({ where: { id: attachment.id }, data: { textContent: text } });
  return true;
}
