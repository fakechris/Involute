import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';
import type { Attachment, Prisma, PrismaClient } from '@prisma/client';

import { extractSearchableText, isSearchableTextFile } from './attachment-text.js';
import { createValidationError, UPLOAD_TOO_LARGE_MESSAGE } from './errors.js';

const defaultUploadsDirectory = resolve(fileURLToPath(import.meta.url), '../../uploads');

export function getUploadsDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.INVOLUTE_UPLOADS_DIR?.trim();
  return configured ? resolve(configured) : defaultUploadsDirectory;
}

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

export const UPLOAD_ENCODINGS = ['utf-8', 'base64'] as const;
export type UploadEncoding = (typeof UPLOAD_ENCODINGS)[number];

export const UPLOAD_MODES = ['create', 'overwrite', 'append', 'delete'] as const;
export type UploadMode = (typeof UPLOAD_MODES)[number];

const EXTENSION_MIME_TYPES: Record<string, string> = {
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.txt': 'text/plain',
  '.log': 'text/x-log',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.xml': 'application/xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
};

export function inferMimeType(filename: string): string {
  const ext = extname(filename).toLowerCase();
  return EXTENSION_MIME_TYPES[ext] ?? 'application/octet-stream';
}

function isTextLikeUpload(filename: string, mimeType: string): boolean {
  const mime = mimeType.split(';')[0]!.trim().toLowerCase();
  return (
    isSearchableTextFile(filename, mimeType) ||
    mime.startsWith('text/') ||
    mime === 'application/json' ||
    mime === 'application/xml' ||
    mime.endsWith('+json') ||
    mime.endsWith('+xml')
  );
}

/**
 * When `encoding` is omitted on a text file, detect whether `content` was
 * passed as plain UTF-8 text or as Base64-encoded UTF-8 text (INV-1273).
 */
function shouldAutoDecodeAsUtf8(content: string, filename: string, mimeType: string): boolean {
  if (!isTextLikeUpload(filename, mimeType)) return false;
  const compact = content.replace(/[\r\n]+/g, '');
  if (compact.length === 0) return true;
  const isCanonicalBase64 = compact.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(compact);
  if (!isCanonicalBase64) return true;
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(compact, 'base64'));
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(decoded)) return true;
    return false;
  } catch {
    return true;
  }
}

export function decodeUploadContent(
  content: string,
  encoding: string | null | undefined,
  filename: string,
  mimeType: string,
): Buffer {
  const normalized = encoding?.trim().toLowerCase() || null;
  if (normalized === 'utf-8' || normalized === 'utf8') {
    return Buffer.from(content, 'utf8');
  }
  if (normalized === 'base64') {
    return Buffer.from(content, 'base64');
  }
  if (normalized !== null) {
    throw createValidationError('encoding must be "utf-8" or "base64".');
  }
  if (shouldAutoDecodeAsUtf8(content, filename, mimeType)) {
    return Buffer.from(content, 'utf8');
  }
  return Buffer.from(content, 'base64');
}

function normalizeUploadMode(mode: string | null | undefined): UploadMode {
  const normalized = (mode?.trim().toLowerCase() || 'create') as UploadMode;
  if (!(UPLOAD_MODES as readonly string[]).includes(normalized)) {
    throw createValidationError('mode must be one of create, overwrite, append, or delete.');
  }
  return normalized;
}

async function findTargetAttachment(
  prisma: PrismaClient | Prisma.TransactionClient,
  input: {
    attachmentId?: string | null;
    issueId?: string | null;
    filename?: string | null;
    mode: UploadMode;
  },
): Promise<Attachment | null> {
  const trimmedId = input.attachmentId?.trim() || null;
  if (trimmedId) {
    const existing = await prisma.attachment.findUnique({ where: { id: trimmedId } });
    if (!existing) {
      throw createValidationError('Attachment not found.');
    }
    if (input.issueId && existing.issueId !== input.issueId) {
      throw createValidationError('Attachment does not belong to that work item.');
    }
    return existing;
  }
  if (!input.issueId) {
    throw createValidationError(`mode "${input.mode}" requires work_id (issueId) or attachment_id (attachmentId).`);
  }
  const trimmedFilename = input.filename?.trim() || null;
  if (!trimmedFilename) {
    throw createValidationError(`mode "${input.mode}" requires filename or attachment_id.`);
  }
  return prisma.attachment.findFirst({
    where: { issueId: input.issueId, filename: trimmedFilename },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
}

function readExistingAttachmentBytes(existing: Attachment, uploadsDir: string): Buffer {
  const diskName = basename(existing.url);
  if (diskName) {
    const diskPath = join(uploadsDir, diskName);
    if (existsSync(diskPath)) {
      return readFileSync(diskPath);
    }
  }
  if (existing.textContent !== null && existing.textContent !== undefined) {
    return Buffer.from(existing.textContent, 'utf8');
  }
  return Buffer.alloc(0);
}

/**
 * Stores or updates one upload on disk and records it (INV-1003, INV-1273):
 * used by the web editor's fileUpload and by the agent's work_attach_file.
 * Files never live in git or an image — only here and in the Attachment row
 * that governs who may read them (uploader, admins, readers of the linked
 * work). Text files also keep their text for search (INV-1117).
 */
export async function storeUpload(
  prisma: PrismaClient | Prisma.TransactionClient,
  input: {
    filename?: string | null;
    mimeType?: string | null;
    content?: string | null;
    encoding?: string | null;
    mode?: string | null;
    attachmentId?: string | null;
    uploaderId: string;
    issueId?: string | null;
    commentId?: string | null;
  },
): Promise<Attachment> {
  const mode = normalizeUploadMode(input.mode);
  const uploadsDir = getUploadsDirectory();
  if (!existsSync(uploadsDir)) mkdirSync(uploadsDir, { recursive: true });

  if (mode === 'delete') {
    const existing = await findTargetAttachment(prisma, {
      attachmentId: input.attachmentId ?? null,
      issueId: input.issueId ?? null,
      filename: input.filename ?? null,
      mode,
    });
    if (!existing) {
      throw createValidationError('Attachment not found.');
    }
    const deleted = await prisma.attachment.delete({ where: { id: existing.id } });
    const diskName = basename(existing.url);
    if (diskName) {
      try {
        unlinkSync(join(uploadsDir, diskName));
      } catch {
        // Ignore missing disk file so DB state can still be cleaned up.
      }
    }
    return deleted;
  }

  const existing =
    mode === 'overwrite' || mode === 'append'
      ? await findTargetAttachment(prisma, {
          attachmentId: input.attachmentId ?? null,
          issueId: input.issueId ?? null,
          filename: input.filename ?? null,
          mode,
        })
      : null;

  const filename = input.filename?.trim() || existing?.filename || '';
  if (!filename) {
    throw createValidationError('filename is required.');
  }
  const mimeType = input.mimeType?.trim() || existing?.mimeType || inferMimeType(filename);
  if (input.content === undefined || input.content === null) {
    throw createValidationError('content is required.');
  }

  const chunkBuffer = decodeUploadContent(input.content, input.encoding, filename, mimeType);
  if (chunkBuffer.length > MAX_UPLOAD_BYTES) throw createValidationError(UPLOAD_TOO_LARGE_MESSAGE);

  if (existing && (mode === 'overwrite' || mode === 'append')) {
    const finalBuffer =
      mode === 'append'
        ? Buffer.concat([readExistingAttachmentBytes(existing, uploadsDir), chunkBuffer])
        : chunkBuffer;
    if (finalBuffer.length > MAX_UPLOAD_BYTES) throw createValidationError(UPLOAD_TOO_LARGE_MESSAGE);
    const requestedExt = extname(filename).toLowerCase();
    const ext = /^\.[a-z0-9]{1,10}$/.test(requestedExt) ? requestedExt : '';
    const diskName = basename(existing.url) || `${randomUUID()}${ext}`;
    const filePath = join(uploadsDir, diskName);
    writeFileSync(filePath, finalBuffer);
    return prisma.attachment.update({
      where: { id: existing.id },
      data: {
        filename,
        mimeType,
        size: finalBuffer.length,
        url: `/uploads/${diskName}`,
        textContent: extractSearchableText(filename, mimeType, finalBuffer),
      },
    });
  }

  const requestedExt = extname(filename).toLowerCase();
  const ext = /^\.[a-z0-9]{1,10}$/.test(requestedExt) ? requestedExt : '';
  const storedName = `${randomUUID()}${ext}`;
  const filePath = join(uploadsDir, storedName);
  writeFileSync(filePath, chunkBuffer);
  try {
    return await prisma.attachment.create({
      data: {
        filename,
        mimeType,
        size: chunkBuffer.length,
        url: `/uploads/${storedName}`,
        uploaderId: input.uploaderId,
        issueId: input.issueId ?? null,
        commentId: input.commentId ?? null,
        textContent: extractSearchableText(filename, mimeType, chunkBuffer),
      },
    });
  } catch (error) {
    try { unlinkSync(filePath); } catch { /* the DB write already failed; do not mask it */ }
    throw error;
  }
}
