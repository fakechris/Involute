import { PrismaClient } from '@prisma/client';
import type { User } from '@prisma/client';
import { parse } from 'graphql';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ADMIN_EMAIL, DEFAULT_TEAM_KEY, resetAndSeed } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import {
  EXTENSION_TOKEN_REFUSED_MESSAGE,
  createExtensionToken,
  extensionOperationAllowed,
  hashExtensionToken,
} from './extension-tokens.ts';
import { startServer, type StartedServer } from './index.ts';
import { createSession, SESSION_COOKIE_NAME } from './session.ts';

loadProjectEnvironment();

const prisma = new PrismaClient();
const AUTH_TOKEN = 'extension-test-token';
let server: StartedServer;

async function gql(query: string, headers: Record<string, string>, variables: Record<string, unknown> = {}, path = '/graphql') {
  const response = await fetch(`${server.url}${path}`, {
    body: JSON.stringify({ query, variables }),
    headers: { 'content-type': 'application/json', ...headers },
    method: 'POST',
  });
  const text = await response.text();
  try {
    return { body: JSON.parse(text) as { data?: Record<string, any>; errors?: Array<{ message: string }> }, status: response.status };
  } catch {
    return { body: { errors: [{ message: text }] }, status: response.status };
  }
}

/**
 * INV-1145. The Capture extension's token is the person, narrowed to filing
 * bugs: issued only by a signed-in person, stored as a hash, refused for
 * everything else, gone the moment it is revoked or expires, and never valid
 * on /mcp.
 */
describe('extension tokens (INV-1145)', () => {
  let person: User;
  let session: string;

  beforeAll(async () => { await prisma.$connect(); });
  beforeEach(async () => {
    await resetAndSeed(prisma);
    await prisma.extensionToken.deleteMany();
    person = await prisma.user.findUniqueOrThrow({ where: { email: DEFAULT_ADMIN_EMAIL } });
    session = `${SESSION_COOKIE_NAME}=${(await createSession(prisma, person.id)).token}`;
    server = await startServer({ allowAdminFallback: false, authToken: AUTH_TOKEN, port: 0, prisma });
  });
  afterEach(async () => { await server.stop(); });
  afterAll(async () => { await prisma.extensionToken.deleteMany(); await resetAndSeed(prisma); await prisma.$disconnect(); });

  it('a signed-in person connects it once: the token is returned once and only its hash is kept', async () => {
    const created = await gql('mutation { extensionTokenCreate(name: "Capture") { success message token extensionToken { id expiresAt } } }', { cookie: session });
    const payload = created.body.data!.extensionTokenCreate;
    expect(payload.success).toBe(true);
    expect(payload.token).toMatch(/^inv_ext_/);
    const stored = await prisma.extensionToken.findUniqueOrThrow({ where: { id: payload.extensionToken.id } });
    expect(stored.tokenHash).toBe(hashExtensionToken(payload.token));
    expect(JSON.stringify(stored)).not.toContain(payload.token);
    // About 90 days.
    expect(stored.expiresAt.getTime() - stored.createdAt.getTime()).toBeGreaterThan(89 * 24 * 3_600_000);

    const listed = await gql('{ extensionTokens { id name } }', { cookie: session });
    expect(listed.body.data!.extensionTokens).toEqual([{ id: stored.id, name: 'Capture' }]);
  });

  it('an agent, or the extension itself, cannot connect another', async () => {
    const agent = await prisma.user.create({ data: { actorKind: 'AGENT', email: 'mia@ext.test', name: 'Mia' } });
    await expect(createExtensionToken(prisma, agent, {})).rejects.toThrow(/signed-in person/);
    const { token } = await createExtensionToken(prisma, person, {});
    const again = await gql('mutation { extensionTokenCreate { success message } }', { authorization: `Bearer ${token}` });
    expect(JSON.stringify(again.body)).toContain(EXTENSION_TOKEN_REFUSED_MESSAGE);
    expect(await prisma.extensionToken.count()).toBe(1);
  });

  it('runs what filing a bug needs, as the person, and refuses everything else', async () => {
    const { token } = await createExtensionToken(prisma, person, {});
    const auth = { authorization: `Bearer ${token}` };

    const viewer = await gql('{ viewer { id email } teams { nodes { id key } } }', auth);
    expect(viewer.body.errors).toBeUndefined();
    expect(viewer.body.data!.viewer.id).toBe(person.id);

    const placement = await gql('query($r: String!) { projects: issues(first: 5, filter: { repository: { eq: $r }, kind: PROJECT }) { nodes { id title } } }', auth, { r: 'x/y' });
    expect(placement.body.errors).toBeUndefined();

    const team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
    for (const refused of [
      // Ordinary work, a write, and a way into other work through a project.
      '{ issues(first: 5) { nodes { id title } } }',
      'query { issues(first: 5, filter: { kind: ISSUE }) { nodes { id } } }',
      `mutation { issueCreate(input: { teamId: "${team.id}", title: "x" }) { success } }`,
      'query { projects: issues(first: 5, filter: { kind: PROJECT }) { nodes { id description } } }',
      'query { projects: issues(first: 5, filter: { kind: PROJECT }) { nodes { children { nodes { title } } } } }',
      '{ extensionTokens { id } }',
    ]) {
      const result = await gql(refused, auth);
      expect(result.body.data ?? null, refused).toBeNull();
      expect(JSON.stringify(result.body.errors), refused).toContain(EXTENSION_TOKEN_REFUSED_MESSAGE);
    }
  });

  it('works on /graphql only, wins over a session cookie, and stops at once when revoked or expired', async () => {
    const { record, token } = await createExtensionToken(prisma, person, {});
    const auth = { authorization: `Bearer ${token}` };

    // Never on MCP.
    const mcp = await fetch(`${server.url}/mcp`, {
      body: JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'tools/list' }),
      headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json', ...auth },
      method: 'POST',
    });
    expect(mcp.status).toBeGreaterThanOrEqual(400);

    // With both, the request is the extension's: the session's wider rights do not apply.
    const both = await gql('{ extensionTokens { id } }', { ...auth, cookie: session });
    expect(JSON.stringify(both.body.errors)).toContain(EXTENSION_TOKEN_REFUSED_MESSAGE);

    const revoked = await gql(`mutation { extensionTokenRevoke(id: "${record.id}") { success } }`, { cookie: session });
    expect(revoked.body.data!.extensionTokenRevoke.success).toBe(true);
    const after = await gql('{ viewer { id } }', auth);
    expect(JSON.stringify(after.body)).toMatch(/Not authenticated|authenticat/i);

    const second = await createExtensionToken(prisma, person, {});
    await prisma.extensionToken.update({ data: { expiresAt: new Date(Date.now() - 1000) }, where: { id: second.record.id } });
    const expired = await gql('{ viewer { id } }', { authorization: `Bearer ${second.token}` });
    expect(expired.body.data?.viewer ?? null).toBeNull();
  });

  it('records the extension as the surface of a bug it files', async () => {
    const { token } = await createExtensionToken(prisma, person, {});
    const team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
    const result = await gql(
      'mutation($input: BugReportInput!) { bugReport(input: $input) { success message issue { id identifier } } }',
      { authorization: `Bearer ${token}` },
      { input: { priority: 3, stepsToReproduce: '1. open', teamId: team.id, title: 'Overlap' } },
    );
    expect(result.body.errors, JSON.stringify(result.body)).toBeUndefined();
    expect(result.body.data!.bugReport.success, JSON.stringify(result.body)).toBe(true);
    const audit = await prisma.workAudit.findFirstOrThrow({ where: { workId: result.body.data!.bugReport.issue.id } });
    expect(audit).toMatchObject({ actorId: person.id, surface: 'extension' });
  });

  it('allows only placement kinds and safe fields in the document itself', () => {
    const ok = parse('query P($f: IssueFilter) { issues(filter: $f) { nodes { id title state { type } } } }');
    expect(extensionOperationAllowed(ok, null, { f: { kind: 'MILESTONE' } })).toBe(true);
    expect(extensionOperationAllowed(ok, null, { f: { kind: 'ISSUE' } })).toBe(false);
    expect(extensionOperationAllowed(parse('{ viewer { ...F } } fragment F on User { id }'), null, {})).toBe(false);
    expect(extensionOperationAllowed(parse('query A { viewer { id } } query B { issues { nodes { id } } }'), 'B', {})).toBe(false);
  });
});
