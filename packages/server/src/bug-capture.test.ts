import type { Issue, Team, User } from '@prisma/client';

import { PrismaClient as PrismaClientConstructor } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ADMIN_EMAIL, DEFAULT_TEAM_KEY, seedDatabase } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import { CAPTURE_MESSAGES, parseBugCapture } from './bug-capture.js';
import { createIssue } from './issue-service.js';
import { startServer, type StartedServer } from './index.ts';
import { createSession } from './session.js';
import { hashAgentToken } from './agent-credentials.ts';
import { normalizeWebOrigin, WEB_ORIGIN_FORMAT_MESSAGE, WEB_ORIGIN_TAKEN_MESSAGE, WEB_ORIGINS_KIND_MESSAGE } from './web-origins.js';

// INV-1146: a bug report carries the browser environment it happened in, and a
// PROJECT says which web origins its app is served from, so the capture
// extension can route a report to it.

loadProjectEnvironment();

const prisma = new PrismaClientConstructor();
const AGENT_TOKEN = 'inv_agent_bug_capture_test';

const BUG_REPORT = /* GraphQL */ `
  mutation BugReport($input: BugReportInput!) {
    bugReport(input: $input) { success message issue { id description capture attachments { id url } } }
  }
`;
const ISSUE_UPDATE = /* GraphQL */ `
  mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
    issueUpdate(id: $id, input: $input) { success message issue { id webOrigins } }
  }
`;
const PROJECT_FOR_ORIGIN = /* GraphQL */ `
  query ProjectForOrigin($origin: String!) { projectForOrigin(origin: $origin) { id identifier webOrigins } }
`;

const fullCapture = {
  url: 'https://app.example.com/board?view=1',
  title: 'Board | Involute',
  viewport: { width: 1280, height: 720, dpr: 2 },
  userAgent: 'Mozilla/5.0 (Macintosh) Chrome/130',
  colorScheme: 'dark',
  appVersion: '0123456789ab',
  consoleErrors: [{ level: 'error', message: 'TypeError: x is undefined', time: '2026-10-10T08:00:00.000Z' }],
  failedRequests: [{ method: 'post', url: 'https://app.example.com/graphql', status: 500, durationMs: 123.4, body: '{"secret":1}' }],
  element: {
    selector: 'div.card > span.title',
    text: 'Fix the board',
    box: { x: 10, y: 20, width: 200, height: 24 },
    styles: { 'font-size': '14px', color: 'rgb(0, 0, 0)', 'font-family': 'Inter', cursor: 'pointer' },
  },
};

describe('bug capture (INV-1146)', () => {
  describe('parseBugCapture', () => {
    it('cuts lists to 20 entries and long text instead of refusing', () => {
      const capture = parseBugCapture({
        consoleErrors: Array.from({ length: 30 }, (_, index) => ({ level: 'error', message: `${index} ${'x'.repeat(900)}`, time: 1_700_000_000_000 })),
        failedRequests: Array.from({ length: 25 }, () => ({ method: 'GET', url: 'https://a.test/x', status: 404 })),
        element: { selector: 'p', text: 'y'.repeat(400), styles: { color: 'red', 'pointer-events': 'none' } },
      })!;
      expect(capture.consoleErrors).toHaveLength(20);
      expect(capture.consoleErrors![0]!.message.length).toBe(500);
      expect(capture.consoleErrors![0]!.time).toBe(new Date(1_700_000_000_000).toISOString());
      expect(capture.failedRequests).toHaveLength(20);
      expect(capture.element!.text!.length).toBe(200);
      expect(capture.element!.styles).toEqual({ color: 'red' });
    });

    it('refuses wrong types and non-http(s) urls, naming the field', () => {
      expect(() => parseBugCapture('nope')).toThrow(CAPTURE_MESSAGES.shape);
      expect(() => parseBugCapture({ url: 'javascript:alert(1)' })).toThrow(CAPTURE_MESSAGES.url);
      expect(() => parseBugCapture({ viewport: { width: '1280', height: 720 } })).toThrow(CAPTURE_MESSAGES.viewport);
      expect(() => parseBugCapture({ colorScheme: 'sepia' })).toThrow(CAPTURE_MESSAGES.colorScheme);
      expect(() => parseBugCapture({ consoleErrors: 'boom' })).toThrow(CAPTURE_MESSAGES.consoleErrors);
      expect(() => parseBugCapture({ failedRequests: [{ url: 'file:///etc/passwd' }] })).toThrow(CAPTURE_MESSAGES.failedRequests);
      expect(() => parseBugCapture({ element: { selector: 'p', styles: { color: { r: 1 } } } })).toThrow(CAPTURE_MESSAGES.styles);
      expect(parseBugCapture(null)).toBeNull();
    });
  });

  it('normalizes web origins to scheme://host[:port]', () => {
    expect(normalizeWebOrigin(' HTTPS://App.Example.COM:443/board?x=1 ')).toBe('https://app.example.com');
    expect(normalizeWebOrigin('http://localhost:5173/')).toBe('http://localhost:5173');
    expect(normalizeWebOrigin('ftp://example.com')).toBeNull();
    expect(normalizeWebOrigin('example.com')).toBeNull();
  });

  describe('through GraphQL', () => {
    let server: StartedServer;
    let team: Team;
    let human: User;
    let project: Issue;

    beforeAll(async () => {
      await prisma.$connect();
    });

    afterAll(async () => {
      await prisma.$disconnect();
    });

    beforeEach(async () => {
      await prisma.notification.deleteMany();
      await prisma.attachment.deleteMany();
      await prisma.workLink.deleteMany();
      await prisma.comment.deleteMany();
      await prisma.issue.deleteMany();
      await prisma.workflowState.deleteMany();
      await prisma.team.deleteMany();
      await prisma.issueLabel.deleteMany();
      await prisma.session.deleteMany();
      await prisma.eventOutboxDelivery.deleteMany();
      await prisma.eventOutbox.deleteMany();
      await prisma.actorAudit.deleteMany();
      await prisma.user.deleteMany();
      await seedDatabase(prisma);
      team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
      human = await prisma.user.findUniqueOrThrow({ where: { email: DEFAULT_ADMIN_EMAIL } });
      project = await createIssue(prisma, { teamId: team.id, kind: 'PROJECT', title: 'fakechris/Involute', repository: 'fakechris/Involute' });
      await prisma.agentCredential.deleteMany();
      const agent = await prisma.user.create({ data: { name: 'Capture agent', email: 'capture@agents.local', actorKind: 'AGENT', ownerId: human.id } });
      await prisma.agentCredential.create({ data: { name: 'capture', scopes: ['read', 'propose', 'update'], tokenHash: hashAgentToken(AGENT_TOKEN), teamId: team.id, userId: agent.id } });
      server = await startServer({ allowAdminFallback: true, prisma, authToken: 'test-auth-token', port: 0 });
    });

    afterEach(async () => {
      await server.stop();
    });

    async function post(user: User, query: string, variables: Record<string, unknown>) {
      const session = await createSession(prisma, user.id, 3600);
      const response = await fetch(`${server.url}/graphql`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: `involute_session=${session.token}` },
        body: JSON.stringify({ query, variables }),
      });
      const text = await response.text();
      try {
        return JSON.parse(text) as any;
      } catch {
        throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
      }
    }

    const report = (user: User, capture: unknown) => post(user, BUG_REPORT, {
      input: { teamId: team.id, title: 'Card title is cut off', priority: 3, stepsToReproduce: 'Open the board.', parentId: project.id, capture },
    });

    it('stores the capture structured and appends an Environment section', async () => {
      const body = await report(human, fullCapture);
      expect(body.errors).toBeUndefined();
      expect(body.data.bugReport).toMatchObject({ success: true, message: null });
      const issue = body.data.bugReport.issue;
      expect(issue.capture).toMatchObject({
        url: 'https://app.example.com/board?view=1',
        viewport: { width: 1280, height: 720, dpr: 2 },
        colorScheme: 'dark',
        failedRequests: [{ method: 'POST', url: 'https://app.example.com/graphql', status: 500, durationMs: 123.4 }],
        element: { selector: 'div.card > span.title', styles: { 'font-size': '14px', color: 'rgb(0, 0, 0)', 'font-family': 'Inter' } },
      });
      // Bodies and unknown style names are never kept.
      expect(JSON.stringify(issue.capture)).not.toContain('secret');
      expect(issue.capture.element.styles).not.toHaveProperty('cursor');
      const stored = await prisma.issue.findUniqueOrThrow({ where: { id: issue.id } });
      expect(stored.capture).toEqual(issue.capture);

      const description: string = issue.description;
      expect(description.startsWith('### Steps to reproduce\n\nOpen the board.\n\n### Environment\n\n')).toBe(true);
      expect(description).toContain('| Page | [Board \\| Involute](https://app.example.com/board?view=1) |');
      expect(description).toContain('| Viewport | 1280×720 @2x |');
      expect(description).toContain('| Browser | Mozilla/5.0 (Macintosh) Chrome/130 |');
      expect(description).toContain('| Theme | dark |');
      expect(description).toContain('| Version | `0123456789ab` |');
      expect(description).toContain('**Element** `div.card > span.title` — “Fix the board”');
      expect(description).toContain('font-size: 14px');
      expect(description).toContain('**Console errors**\n- error 2026-10-10T08:00:00.000Z: `TypeError: x is undefined`');
      expect(description).toContain('**Failed requests**\n- POST 500 `https://app.example.com/graphql` (123 ms)');
    });

    it('refuses a malformed capture with the reason in message, filing nothing', async () => {
      const body = await report(human, { ...fullCapture, url: 'chrome://settings' });
      expect(body.errors).toBeUndefined();
      expect(body.data.bugReport).toEqual({ success: false, message: CAPTURE_MESSAGES.url, issue: null });
      expect(await prisma.issue.count({ where: { kind: 'ISSUE' } })).toBe(0);
    });

    it('takes the reporter’s own unattached screenshot as the bug’s file, and no one else’s', async () => {
      const mine = await prisma.attachment.create({ data: { filename: 'shot.png', mimeType: 'image/png', size: 1, url: '/uploads/shot.png', uploaderId: human.id } });
      const body = await report(human, { url: 'https://app.example.com/', screenshotAttachmentId: mine.id });
      expect(body.data.bugReport.success).toBe(true);
      expect(body.data.bugReport.issue.capture).toMatchObject({ screenshotAttachmentId: mine.id, screenshotUrl: '/uploads/shot.png' });
      expect(body.data.bugReport.issue.attachments).toEqual([{ id: mine.id, url: '/uploads/shot.png' }]);
      expect(body.data.bugReport.issue.description).toContain('| Screenshot | [screenshot](/uploads/shot.png) |');

      const other = await prisma.user.create({ data: { actorKind: 'HUMAN', email: 'o@humans.test.local', name: 'O' } });
      const theirs = await prisma.attachment.create({ data: { filename: 'o.png', mimeType: 'image/png', size: 1, url: '/uploads/o.png', uploaderId: other.id } });
      const refused = await report(human, { screenshotAttachmentId: theirs.id });
      expect(refused.data.bugReport).toMatchObject({ success: false, message: CAPTURE_MESSAGES.screenshot });
      // Already attached to the first bug: cannot be pulled into another.
      const reused = await report(human, { screenshotAttachmentId: mine.id });
      expect(reused.data.bugReport).toMatchObject({ success: false, message: CAPTURE_MESSAGES.screenshot });
    });

    it('edits a project’s web origins normalized and deduplicated, one project per origin', async () => {
      const saved = await post(human, ISSUE_UPDATE, { id: project.id, input: { webOrigins: ['https://App.Example.com/board', 'https://app.example.com', 'http://localhost:5173/'] } });
      expect(saved.data.issueUpdate).toMatchObject({ success: true, issue: { webOrigins: ['https://app.example.com', 'http://localhost:5173'] } });

      const invalid = await post(human, ISSUE_UPDATE, { id: project.id, input: { webOrigins: ['app.example.com'] } });
      expect(invalid.data.issueUpdate).toMatchObject({ success: false, message: WEB_ORIGIN_FORMAT_MESSAGE });

      const second = await createIssue(prisma, { teamId: team.id, kind: 'PROJECT', title: 'fakechris/lumenbox', repository: 'fakechris/lumenbox' });
      const taken = await post(human, ISSUE_UPDATE, { id: second.id, input: { webOrigins: ['https://APP.example.com:443'] } });
      expect(taken.data.issueUpdate).toMatchObject({ success: false, message: WEB_ORIGIN_TAKEN_MESSAGE });

      const milestone = await createIssue(prisma, { teamId: team.id, kind: 'MILESTONE', title: 'M1', parentId: project.id, repository: 'fakechris/Involute' });
      const notProject = await post(human, ISSUE_UPDATE, { id: milestone.id, input: { webOrigins: ['https://m.example.com'] } });
      expect(notProject.data.issueUpdate).toMatchObject({ success: false, message: WEB_ORIGINS_KIND_MESSAGE });

      const cleared = await post(human, ISSUE_UPDATE, { id: project.id, input: { webOrigins: null } });
      expect(cleared.data.issueUpdate).toMatchObject({ success: true, issue: { webOrigins: [] } });
    });

    it('lets MCP work_update set web origins with the same rules (INV-1146)', async () => {
      async function callTool(name: string, args: Record<string, unknown>) {
        const response = await fetch(`${server.url}/mcp`, {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${AGENT_TOKEN}` },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { team: DEFAULT_TEAM_KEY, ...args } } }),
        });
        const body = await response.json() as { error?: { message: string }; result?: { isError?: boolean; content: Array<{ text: string }> } };
        if (body.error) return { error: body.error.message };
        const text = body.result!.content[0]!.text;
        return body.result!.isError ? { error: text } : JSON.parse(text);
      }
      const updated = await callTool('work_update', { id: project.id, expected_revision: project.revision, web_origins: ['HTTPS://Agent.Example.com/x'] });
      expect(updated.error).toBeUndefined();
      expect((await prisma.issue.findUniqueOrThrow({ where: { id: project.id } })).webOrigins).toEqual(['https://agent.example.com']);
      const refused = await callTool('work_update', { id: project.id, expected_revision: project.revision + 1, web_origins: ['ftp://x.example.com'] });
      expect(refused.error).toContain(WEB_ORIGIN_FORMAT_MESSAGE);
    });

    it('finds the project for a page origin; null for no match or a project the viewer cannot read', async () => {
      await prisma.issue.update({ where: { id: project.id }, data: { webOrigins: ['https://app.example.com'] } });
      const found = await post(human, PROJECT_FOR_ORIGIN, { origin: 'https://APP.example.com/board/INV-1?x=1' });
      expect(found.data.projectForOrigin).toMatchObject({ id: project.id, webOrigins: ['https://app.example.com'] });

      expect((await post(human, PROJECT_FOR_ORIGIN, { origin: 'https://other.example.com' })).data.projectForOrigin).toBeNull();
      expect((await post(human, PROJECT_FOR_ORIGIN, { origin: 'not a url' })).data.projectForOrigin).toBeNull();

      const secret = await prisma.team.create({ data: { key: 'SEC', name: 'Secret', visibility: 'PRIVATE' } });
      await prisma.workflowState.create({ data: { name: 'Ready', type: 'UNSTARTED', position: 0, teamId: secret.id } });
      const hidden = await createIssue(prisma, { teamId: secret.id, kind: 'PROJECT', title: 'secret/app', repository: 'secret/app' });
      await prisma.issue.update({ where: { id: hidden.id }, data: { webOrigins: ['https://secret.example.com'] } });
      const member = await prisma.user.create({ data: { actorKind: 'HUMAN', email: 'm@humans.test.local', name: 'M', globalRole: 'USER' } });
      await prisma.teamMembership.create({ data: { role: 'EDITOR', teamId: team.id, userId: member.id } });
      expect((await post(member, PROJECT_FOR_ORIGIN, { origin: 'https://secret.example.com' })).data.projectForOrigin).toBeNull();
      expect((await post(human, PROJECT_FOR_ORIGIN, { origin: 'https://secret.example.com' })).data.projectForOrigin).toMatchObject({ id: hidden.id });
    });
  });
});
