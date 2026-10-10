import { PrismaClient } from '@prisma/client';
import type { User } from '@prisma/client';
import { parse } from 'graphql';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// The extension's own documents and capture assembly (INV-1147), imported from
// its source so the gate below and the extension cannot drift apart.
import { OPERATIONS, type OperationName } from '../../extension/src/api/operations.ts';
import { assembleCapture } from '../../extension/src/lib/capture.ts';
import { DEFAULT_ADMIN_EMAIL, DEFAULT_TEAM_KEY, resetAndSeed } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import { createExtensionToken, extensionOperationAllowed } from './extension-tokens.ts';
import { startServer, type StartedServer } from './index.ts';
import { createIssue } from './issue-service.ts';

loadProjectEnvironment();

const prisma = new PrismaClient();
const REPOSITORY = 'acme/capture-app';
const ORIGIN = 'https://capture-app.example.com';
// A 1×1 PNG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/** Realistic variables for each document, as the side panel sends them. */
function variablesFor(name: OperationName, ids: { teamId: string; teamKey: string; projectIdentifier: string }): Record<string, unknown> {
  switch (name) {
    case 'Viewer':
    case 'Teams':
      return {};
    case 'ProjectForOrigin':
      return { origin: ORIGIN };
    case 'TeamProjects':
      return { teamKey: ids.teamKey };
    case 'PlacementOptions':
      return { repository: REPOSITORY };
    case 'SimilarBugs':
      return { teamId: ids.teamId, title: 'Save button does nothing' };
    case 'UploadScreenshot':
      return { input: { filename: 'screenshot.png', mimeType: 'image/png', content: PNG } };
    case 'ReportBug':
      return {
        input: {
          teamId: ids.teamId,
          title: 'Save button does nothing',
          stepsToReproduce: '1. Open the board\n2. Click Save',
          priority: 2,
          parentId: ids.projectIdentifier,
          capture: { url: `${ORIGIN}/board`, element: { selector: '#save', text: 'Save', box: { x: 0, y: 0, width: 10, height: 10 }, styles: {} } },
        },
      };
  }
}

describe('the Capture extension’s GraphQL documents (INV-1147)', () => {
  let person: User;
  let server: StartedServer;
  let token: string;
  let ids: { teamId: string; teamKey: string; projectIdentifier: string };

  async function run(name: OperationName, variables: Record<string, unknown>) {
    const response = await fetch(`${server.url}/graphql`, {
      body: JSON.stringify({ query: OPERATIONS[name], operationName: name, variables }),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      method: 'POST',
    });
    return (await response.json()) as { data?: Record<string, any>; errors?: Array<{ message: string }> };
  }

  beforeAll(async () => { await prisma.$connect(); });
  beforeEach(async () => {
    await resetAndSeed(prisma);
    await prisma.extensionToken.deleteMany();
    person = await prisma.user.findUniqueOrThrow({ where: { email: DEFAULT_ADMIN_EMAIL } });
    const team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
    const project = await createIssue(prisma, { teamId: team.id, kind: 'PROJECT', title: 'Capture app', repository: REPOSITORY });
    await prisma.issue.update({ where: { id: project.id }, data: { webOrigins: [ORIGIN] } });
    await createIssue(prisma, { teamId: team.id, kind: 'MILESTONE', title: 'M1', repository: REPOSITORY, parentId: project.id });
    ids = { teamId: team.id, teamKey: team.key, projectIdentifier: project.identifier };
    token = (await createExtensionToken(prisma, person, {})).token;
    server = await startServer({ allowAdminFallback: false, authToken: 'extension-operations-test', port: 0, prisma });
  });
  afterEach(async () => { await server.stop(); });
  afterAll(async () => { await prisma.extensionToken.deleteMany(); await resetAndSeed(prisma); await prisma.$disconnect(); });

  it('every document passes the extension-token gate with its real variables', () => {
    for (const name of Object.keys(OPERATIONS) as OperationName[]) {
      const document = parse(OPERATIONS[name]);
      expect(extensionOperationAllowed(document, name, variablesFor(name, ids)), name).toBe(true);
    }
  });

  // Running them through the server also validates them against the real schema.
  it('each one runs with an extension token, end to end through the server', async () => {
    for (const name of Object.keys(OPERATIONS) as OperationName[]) {
      if (name === 'ReportBug') continue;
      const result = await run(name, variablesFor(name, ids));
      expect(result.errors, name).toBeUndefined();
    }
    const project = (await run('ProjectForOrigin', { origin: ORIGIN })).data!.projectForOrigin;
    expect(project).toMatchObject({ identifier: ids.projectIdentifier, repository: REPOSITORY, team: { key: ids.teamKey } });
    const placements = (await run('PlacementOptions', { repository: REPOSITORY })).data!;
    expect(placements.milestones.nodes.map((node: { title: string }) => node.title)).toEqual(['M1']);
  });

  it('files a bug the way the panel does: upload, then report with the assembled, redacted capture', async () => {
    const upload = (await run('UploadScreenshot', variablesFor('UploadScreenshot', ids))).data!.fileUpload;
    expect(upload.success).toBe(true);
    const capture = assembleCapture({
      page: { url: `${ORIGIN}/board?token=s3cr3t-t0ken`, title: 'Board', viewport: { width: 1280, height: 720, dpr: 2 }, userAgent: 'Chrome/140', colorScheme: 'light', appVersion: 'abc1234' },
      recorder: { consoleErrors: [{ level: 'error', message: 'failed for jane@example.com', time: Date.now() }], failedRequests: [{ method: 'POST', url: `${ORIGIN}/api/save`, status: 500, durationMs: 12 }] },
      element: { selector: '#save', text: 'Save', box: { x: 20, y: 40, width: 120, height: 48 }, styles: { color: 'rgb(0, 0, 0)' } },
      screenshotAttachmentId: upload.attachment.id,
    });
    const reported = await run('ReportBug', {
      input: { teamId: ids.teamId, title: 'Save button does nothing', stepsToReproduce: '1. Open the board', priority: 2, parentId: ids.projectIdentifier, capture },
    });
    expect(reported.errors).toBeUndefined();
    expect(reported.data!.bugReport).toMatchObject({ success: true, message: null });
    const bug = await prisma.issue.findUniqueOrThrow({ where: { id: reported.data!.bugReport.issue.id }, include: { attachments: true } });
    expect(bug.attachments.map((attachment) => attachment.id)).toEqual([upload.attachment.id]);
    expect(bug.description).toContain('### Environment');
    expect(bug.description).toContain('#save');
    expect(JSON.stringify(bug)).not.toContain('s3cr3t-t0ken');
    expect(JSON.stringify(bug)).not.toContain('jane@example.com');
  });
});
