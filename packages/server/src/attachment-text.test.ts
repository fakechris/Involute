import type { Team, User } from '@prisma/client';

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ADMIN_EMAIL, DEFAULT_TEAM_KEY, seedDatabase } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import { backfillAttachmentText, extractSearchableText, MAX_ATTACHMENT_TEXT_CHARS } from './attachment-text.ts';

loadProjectEnvironment();

const prisma = new PrismaClient();

// INV-1117: which uploads are read as text for search, and how much of them.
describe('extractSearchableText (INV-1117)', () => {
  const text = (value: string) => Buffer.from(value, 'utf8');

  it('reads markdown, plain text, logs and JSON by MIME type or extension', () => {
    expect(extractSearchableText('report.md', 'text/markdown', text('# 复盘'))).toBe('# 复盘');
    expect(extractSearchableText('notes.txt', 'text/plain', text('plain'))).toBe('plain');
    expect(extractSearchableText('build.log', 'application/octet-stream', text('ERROR boot'))).toBe('ERROR boot');
    expect(extractSearchableText('data.json', 'application/json', text('{"a":1}'))).toBe('{"a":1}');
    expect(extractSearchableText('README', 'text/x-markdown', text('x'))).toBe('x');
  });

  it('ignores binaries, files that are not valid UTF-8, and text types it does not index', () => {
    expect(extractSearchableText('logo.png', 'image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
    expect(extractSearchableText('study.pdf', 'application/pdf', text('%PDF-1.7'))).toBeNull();
    expect(extractSearchableText('fake.md', 'text/markdown', Buffer.from([0xff, 0xfe, 0x00, 0x41]))).toBeNull();
    expect(extractSearchableText('nul.txt', 'text/plain', Buffer.from('a\u0000b'))).toBeNull();
    expect(extractSearchableText('page.html', 'text/html', text('<p>x</p>'))).toBeNull();
  });

  it('caps the text at a fixed length', () => {
    const long = 'a'.repeat(MAX_ATTACHMENT_TEXT_CHARS + 10);
    expect(extractSearchableText('big.txt', 'text/plain', text(long))).toHaveLength(MAX_ATTACHMENT_TEXT_CHARS);
  });
});

describe('backfillAttachmentText (INV-1117)', () => {
  let team: Team;
  let admin: User;
  let uploadsDir: string;

  beforeAll(async () => {
    await prisma.$connect();
    uploadsDir = await mkdtemp(join(tmpdir(), 'involute-attachment-text-'));
  });
  afterAll(async () => {
    await rm(uploadsDir, { force: true, recursive: true });
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await prisma.attachment.deleteMany();
    await prisma.comment.deleteMany();
    await prisma.issue.deleteMany();
    await prisma.workflowState.deleteMany();
    await prisma.team.deleteMany();
    await prisma.actorAudit.deleteMany();
    await prisma.user.deleteMany();
    await seedDatabase(prisma);
    team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
    admin = await prisma.user.findUniqueOrThrow({ where: { email: DEFAULT_ADMIN_EMAIL } });
  });

  it('reads text attachments uploaded before INV-1117 from disk, skips binaries and missing files, and can run again', async () => {
    const state = await prisma.workflowState.findFirstOrThrow({ where: { teamId: team.id } });
    const issue = await prisma.issue.create({ data: { identifier: `${DEFAULT_TEAM_KEY}-7001`, teamId: team.id, stateId: state.id, title: 'Study' } });
    const record = (filename: string, mimeType: string, stored: string) =>
      prisma.attachment.create({ data: { issueId: issue.id, uploaderId: admin.id, filename, mimeType, size: 1, url: `/uploads/${stored}` } });
    await writeFile(join(uploadsDir, 'a.md'), '# 竞品调研\n\n结论在此。');
    await writeFile(join(uploadsDir, 'b.png'), Buffer.from([0x89, 0x50]));
    const report = await record('study.md', 'text/markdown', 'a.md');
    const image = await record('logo.png', 'image/png', 'b.png');
    const missing = await record('gone.md', 'text/markdown', 'gone.md');

    expect(await backfillAttachmentText(prisma, uploadsDir)).toEqual({ indexed: 1, skipped: 1 });
    expect((await prisma.attachment.findUniqueOrThrow({ where: { id: report.id } })).textContent).toBe('# 竞品调研\n\n结论在此。');
    expect((await prisma.attachment.findUniqueOrThrow({ where: { id: image.id } })).textContent).toBeNull();
    expect((await prisma.attachment.findUniqueOrThrow({ where: { id: missing.id } })).textContent).toBeNull();
    const [row] = await prisma.$queryRaw<Array<{ indexed: boolean }>>`
      SELECT "searchVector" IS NOT NULL AS indexed FROM "Attachment" WHERE id = ${report.id}::uuid
    `;
    expect(row?.indexed).toBe(true);

    // Already-read files are not read again.
    expect(await backfillAttachmentText(prisma, uploadsDir)).toEqual({ indexed: 0, skipped: 1 });
  });
});
