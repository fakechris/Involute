import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultUploadsDirectory = resolve(fileURLToPath(import.meta.url), '../../uploads');

export function getUploadsDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.INVOLUTE_UPLOADS_DIR?.trim();
  return configured ? resolve(configured) : defaultUploadsDirectory;
}

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { Attachment, Prisma, PrismaClient } from '@prisma/client';

import { extractSearchableText } from './attachment-text.js';
import { createValidationError, UPLOAD_TOO_LARGE_MESSAGE } from './errors.js';

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/**
 * Stores one upload on disk and records it (INV-1003): used by the web
 * editor's fileUpload and by the agent's work_attach_file. Files never live in
 * git or an image — only here and in the Attachment row that governs who may
 * read them (uploader, admins, readers of the linked work). Text files also
 * keep their text for search (INV-1117).
 */
export async function storeUpload(
  prisma: PrismaClient | Prisma.TransactionClient,
  input: { filename: string; mimeType: string; content: string; uploaderId: string; issueId?: string | null; commentId?: string | null },
): Promise<Attachment> {
  const buffer = Buffer.from(input.content, 'base64');
  if (buffer.length > MAX_UPLOAD_BYTES) throw createValidationError(UPLOAD_TOO_LARGE_MESSAGE);
  const uploadsDir = getUploadsDirectory();
  if (!existsSync(uploadsDir)) mkdirSync(uploadsDir, { recursive: true });
  const requestedExt = extname(input.filename).toLowerCase();
  const ext = /^\.[a-z0-9]{1,10}$/.test(requestedExt) ? requestedExt : '';
  const storedName = `${randomUUID()}${ext}`;
  const filePath = join(uploadsDir, storedName);
  writeFileSync(filePath, buffer);
  try {
    return await prisma.attachment.create({
      data: { filename: input.filename, mimeType: input.mimeType, size: buffer.length, url: `/uploads/${storedName}`, uploaderId: input.uploaderId, issueId: input.issueId ?? null, commentId: input.commentId ?? null, textContent: extractSearchableText(input.filename, input.mimeType, buffer) },
    });
  } catch (error) {
    try { unlinkSync(filePath); } catch { /* the DB write already failed; do not mask it */ }
    throw error;
  }
}
