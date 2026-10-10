import type { Issue, PrismaClient, Team, User } from '@prisma/client';

import { PrismaClient as PrismaClientConstructor } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_ADMIN_EMAIL, DEFAULT_TEAM_KEY, seedDatabase } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import { hashAgentToken } from './agent-credentials.ts';
import { startServer, type StartedServer } from './index.ts';
import { createSession } from './session.js';
import { FOUND_IN_SHA_INVALID_MESSAGE, parseFoundInSha } from './found-in.ts';
import { bugsFixedBetween, BUGS_FIXED_SHA_INVALID_MESSAGE } from './bugs-fixed-between.ts';
import type { GitHubVerifierOptions } from './github-evidence-verifier.ts';
import { updateIssue } from './issue-service.ts';
import { loadWorkTimeline } from './work-activity-timeline.ts';
import { writeActorFromViewer } from './work-service.ts';
import { testParentId } from './test-placement.ts';

loadProjectEnvironment();

const prisma: PrismaClient = new PrismaClientConstructor();
const AGENT_TOKEN = 'inv_agent_found_in_test';
const REPO = 'fakechris/Involute';
const DESCRIPTION = '### 1. 目标与架构定位\nx\n\n### 2. 核心功能与交付范围\nx\n\n### 3. 验收标准与验证方案\nx';
const sha = (digit: string) => digit.repeat(40);
let server: StartedServer;

// INV-1121: a bug's found-in deploy SHA, and the bugs fixed between two deploys.
describe('found-in SHA and bugs fixed between deploys (INV-1121)', () => {
  let team: Team;
  let human: User;
  let cookie: string;
  let parentId: string;

  beforeAll(async () => { await prisma.$connect(); });
  afterAll(async () => { await prisma.$disconnect(); });
  beforeEach(async () => {
    await prisma.notification.deleteMany();
    await prisma.workClaim.deleteMany();
    await prisma.workLink.deleteMany();
    await prisma.comment.deleteMany();
    await prisma.issue.deleteMany();
    await prisma.workflowState.deleteMany();
    await prisma.team.deleteMany();
    await prisma.issueLabel.deleteMany();
    await prisma.agentCredential.deleteMany();
    await prisma.session.deleteMany();
    await prisma.eventOutboxDelivery.deleteMany();
    await prisma.eventOutbox.deleteMany();
    await prisma.actorAudit.deleteMany();
    await prisma.user.deleteMany();
    await seedDatabase(prisma);
    team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
    human = await prisma.user.findUniqueOrThrow({ where: { email: DEFAULT_ADMIN_EMAIL } });
    const agent = await prisma.user.create({ data: { name: 'Found-in agent', email: 'found-in@agents.local', actorKind: 'AGENT', ownerId: human.id } });
    await prisma.teamMembership.create({ data: { role: 'EDITOR', teamId: team.id, userId: agent.id } });
    await prisma.agentCredential.create({ data: { name: 'found-in', scopes: ['read', 'propose', 'claim', 'report', 'update'], tokenHash: hashAgentToken(AGENT_TOKEN), teamId: team.id, userId: agent.id } });
    const session = await createSession(prisma, human.id, 3600);
    cookie = `involute_session=${session.token}`;
    parentId = await testParentId(prisma, team.id, REPO);
    server = await startServer({ allowAdminFallback: true, prisma, authToken: 'unused-static-token', port: 0 });
  });
  afterEach(async () => {
    await server.stop();
    vi.unstubAllEnvs();
  });

  async function mcp(name: string, args: Record<string, unknown>) {
    const response = await fetch(`${server.url}/mcp`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${AGENT_TOKEN}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    const body = await response.json() as { error?: { message: string }; result?: { isError?: boolean; content: Array<{ text: string }> } };
    if (body.error) return { error: body.error.message };
    const text = body.result!.content[0]!.text;
    if (body.result!.isError) return { error: text };
    return JSON.parse(text);
  }

  async function gql(query: string, variables?: Record<string, unknown>) {
    const response = await fetch(`${server.url}/graphql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ query, variables }),
    });
    return await response.json() as any;
  }

  const fileBug = (args: Record<string, unknown>) => mcp('work_file_bug', {
    team: DEFAULT_TEAM_KEY, repository: REPO, priority: 3, steps_to_reproduce: 'Open it.', acceptance: 'It works.',
    description: DESCRIPTION, parent_id: parentId, ...args,
  });

  it('parses strictly: undefined keeps, null or blank clears, 7–40 hex (any case, sha- prefix) sets', () => {
    expect(parseFoundInSha(undefined)).toBeUndefined();
    expect(parseFoundInSha(null)).toBeNull();
    expect(parseFoundInSha('  ')).toBeNull();
    expect(parseFoundInSha('sha-ABCDEF123456')).toBe('abcdef123456');
    expect(parseFoundInSha(sha('a'))).toBe(sha('a'));
    expect(() => parseFoundInSha('abc12')).toThrow(FOUND_IN_SHA_INVALID_MESSAGE);
    expect(() => parseFoundInSha('xyz1234')).toThrow(FOUND_IN_SHA_INVALID_MESSAGE);
    expect(() => parseFoundInSha(`${sha('a')}0`)).toThrow(FOUND_IN_SHA_INVALID_MESSAGE);
    expect(() => parseFoundInSha(1234567)).toThrow(FOUND_IN_SHA_INVALID_MESSAGE);
  });

  it('is written and read through MCP: file_bug, propose and update, with an audit row for each change', async () => {
    const bug = await fileBug({ title: 'Blank page', found_in_sha: '8b2d065ABC12' });
    expect(bug.error).toBeUndefined();
    expect(bug.foundInSha).toBe('8b2d065abc12');

    const refused = await fileBug({ title: 'Bad sha', found_in_sha: 'v1.2.3' });
    expect(refused.error).toMatch(/7 to 40 hexadecimal/);

    const proposed = await mcp('work_propose', { team: DEFAULT_TEAM_KEY, title: 'Crash', description: DESCRIPTION, parent_id: parentId, labels: ['bug'], priority: 3, steps_to_reproduce: 'Click.', acceptance: 'No crash.', found_in_sha: sha('c') });
    expect(proposed.error).toBeUndefined();
    expect(proposed.foundInSha).toBe(sha('c'));

    const updated = await mcp('work_update', { id: bug.identifier, expected_revision: bug.revision, found_in_sha: sha('d') });
    expect(updated.error).toBeUndefined();
    expect(updated.foundInSha).toBe(sha('d'));
    const audit = await prisma.workAudit.findFirstOrThrow({ where: { workId: bug.id, revision: updated.revision } });
    expect((audit.before as { foundInSha: string }).foundInSha).toBe('8b2d065abc12');
    expect((audit.after as { foundInSha: string }).foundInSha).toBe(sha('d'));

    const cleared = await mcp('work_update', { id: bug.identifier, expected_revision: updated.revision, found_in_sha: null });
    expect(cleared.foundInSha).toBeNull();
    const context = await mcp('work_get_context', { id: bug.identifier });
    expect(context.work.foundInSha).toBeNull();
  });

  it('is written and read through GraphQL: bugReport and issueUpdate; serverBuild names the running build', async () => {
    vi.stubEnv('INVOLUTE_BUILD_SHA', sha('e'));
    const build = await gql('{ serverBuild { buildSha serverVersion } }');
    expect(build.data.serverBuild.buildSha).toBe(sha('e'));

    const reported = await gql(`mutation ($input: BugReportInput!) { bugReport(input: $input) { success message issue { id revision foundInSha } } }`, {
      input: { teamId: team.id, title: 'Save fails', stepsToReproduce: 'Save.', priority: 3, foundInSha: sha('e'), parentId },
    });
    expect(reported.data.bugReport.message).toBeNull();
    const issue = reported.data.bugReport.issue;
    expect(issue.foundInSha).toBe(sha('e'));

    const updated = await gql(`mutation ($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success message issue { revision foundInSha } } }`, {
      id: issue.id, input: { expectedRevision: issue.revision, foundInSha: '1234567' },
    });
    expect(updated.data.issueUpdate.success).toBe(true);
    expect(updated.data.issueUpdate.issue.foundInSha).toBe('1234567');

    const invalid = await gql(`mutation ($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success message } }`, {
      id: issue.id, input: { foundInSha: 'not-a-sha' },
    });
    expect(invalid.errors?.[0]?.message ?? invalid.data?.issueUpdate?.message).toMatch(/7 to 40 hexadecimal/);
    expect((await prisma.issue.findUniqueOrThrow({ where: { id: issue.id } })).foundInSha).toBe('1234567');
  });

  it('labels found-in changes on the issue timeline', async () => {
    const bug = await fileBug({ title: 'Timeline' });
    await updateIssue(prisma, bug.id, { foundInSha: sha('a') }, writeActorFromViewer(human));
    await updateIssue(prisma, bug.id, { foundInSha: sha('b') }, writeActorFromViewer(human));
    await updateIssue(prisma, bug.id, { foundInSha: null }, writeActorFromViewer(human));
    const entries = (await loadWorkTimeline(prisma, bug.id)).entries.filter((entry) => entry.changes.some((change) => change.field === 'found in'));
    expect(entries.map((entry) => entry.summary)).toEqual(['Found in aaaaaaaaaaaa', 'Found in aaaaaaaaaaaa → bbbbbbbbbbbb', 'Found-in cleared']);
  });

  describe('bugs fixed between two deploy SHAs', () => {
    const FROM = '1111111';
    const TO = '9999999';
    let inRange: Issue;
    let viaEvidence: Issue;
    let outOfRange: Issue;
    let notABug: Issue;

    async function merged(issue: Issue, mergeCommitSha: string, prNumber: number) {
      await prisma.webhookEventLog.create({ data: { issueId: issue.id, eventSourceKey: `pr_${prNumber}_merged`, eventType: 'pull_request.merged', payload: { prNumber, mergeCommitSha } } });
    }

    beforeEach(async () => {
      inRange = await prisma.issue.findUniqueOrThrow({ where: { id: (await fileBug({ title: 'Fixed by merge' })).id } });
      viaEvidence = await prisma.issue.findUniqueOrThrow({ where: { id: (await fileBug({ title: 'Fixed by verified PR' })).id } });
      outOfRange = await prisma.issue.findUniqueOrThrow({ where: { id: (await fileBug({ title: 'Fixed earlier' })).id } });
      const feature = await mcp('work_propose', { team: DEFAULT_TEAM_KEY, title: 'A feature', description: DESCRIPTION, parent_id: parentId, repository: REPO });
      notABug = await prisma.issue.findUniqueOrThrow({ where: { id: feature.id } });
      await merged(inRange, sha('b'), 11);
      await merged(outOfRange, sha('0'), 9);
      await merged(notABug, sha('b'), 12);
      const evidence = await prisma.workEvidence.create({ data: { workId: viaEvidence.id, kind: 'PR', url: `https://github.com/${REPO}/pull/13` } });
      await prisma.evidenceVerification.create({ data: {
        evidenceId: evidence.id, verifierId: 'github', verifierVersion: '1', status: 'VERIFIED', repository: REPO, commitSha: sha('a'),
        resultDigest: 'x', result: { source: { prNumber: 13, headSha: sha('a'), merged: true } },
      } });
      // A FAILED verification is not a fix.
      await prisma.evidenceVerification.create({ data: {
        evidenceId: evidence.id, verifierId: 'github', verifierVersion: '1', status: 'FAILED', repository: REPO, commitSha: sha('c'), resultDigest: 'y', result: {},
      } });
    });

    function github(compare: (path: string) => Response): GitHubVerifierOptions & { calls: string[] } {
      const calls: string[] = [];
      return {
        calls,
        repositories: new Set([REPO]),
        installationToken: async () => 'token',
        fetch: (async (url: string | URL) => {
          const path = String(url).replace('https://api.github.com', '');
          calls.push(path);
          return compare(path);
        }) as typeof fetch,
      };
    }
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

    it('lists the bugs whose GitHub-reported fix lies in from...to, in deploy order, and nothing else', async () => {
      const options = github(() => json({ status: 'ahead', total_commits: 3, commits: [{ sha: sha('a') }, { sha: sha('c') }, { sha: sha('b') }] }));
      const result = await bugsFixedBetween(prisma, { repository: REPO, fromSha: `sha-${FROM}`, toSha: TO }, undefined, options);
      expect(options.calls[0]).toBe(`/repos/${REPO}/compare/${FROM}...${TO}?per_page=100&page=1`);
      expect(result).toMatchObject({ known: true, failureCode: null, compareStatus: 'ahead', commitCount: 3, fromSha: FROM, toSha: TO });
      expect(result.bugs.map((bug) => [bug.issue.identifier, bug.fixSha, bug.prNumber, bug.source])).toEqual([
        [viaEvidence.identifier, sha('a'), 13, 'VERIFIED_EVIDENCE'],
        [inRange.identifier, sha('b'), 11, 'MERGE_EVENT'],
      ]);
    });

    it('reads every page of a long range', async () => {
      const page1 = Array.from({ length: 100 }, (_, index) => ({ sha: index.toString(16).padStart(40, 'f') }));
      const options = github((path) => path.endsWith('page=1')
        ? json({ status: 'ahead', total_commits: 101, commits: page1 })
        : json({ status: 'ahead', total_commits: 101, commits: [{ sha: sha('b') }] }));
      const result = await bugsFixedBetween(prisma, { repository: REPO, fromSha: FROM, toSha: TO }, undefined, options);
      expect(options.calls).toHaveLength(2);
      expect(result.commitCount).toBe(101);
      expect(result.bugs.map((bug) => bug.issue.identifier)).toEqual([inRange.identifier]);
    });

    it('says "unknown", never an empty success, for an unknown SHA, a reversed or too long range and GitHub failures', async () => {
      const cases: Array<[Response, string]> = [
        [json({ message: 'Not Found' }, 404), 'UNKNOWN_SHA'],
        [json({ status: 'behind', total_commits: 0, commits: [] }), 'RANGE_REVERSED'],
        [json({ status: 'ahead', total_commits: 5000, commits: [] }), 'RANGE_TOO_LARGE'],
        [json({ message: 'rate limited' }, 429), 'RATE_OR_PERMISSION_LIMIT'],
        [json({ message: 'boom' }, 500), 'HTTP_500'],
      ];
      for (const [response, code] of cases) {
        const result = await bugsFixedBetween(prisma, { repository: REPO, fromSha: FROM, toSha: TO }, undefined, github(() => response));
        expect(result).toMatchObject({ known: false, failureCode: code, bugs: [], commitCount: null });
        expect(result.message).toBeTruthy();
      }
      const unconfigured = await bugsFixedBetween(prisma, { repository: REPO, fromSha: FROM, toSha: TO }, undefined, { ...github(() => json({})), repositories: new Set() });
      expect(unconfigured).toMatchObject({ known: false, failureCode: 'SOURCE_NOT_ALLOWED' });
    });

    it('an identical range is a known, empty range', async () => {
      const result = await bugsFixedBetween(prisma, { repository: REPO, fromSha: FROM, toSha: FROM }, undefined, github(() => json({ status: 'identical', total_commits: 0, commits: [] })));
      expect(result).toMatchObject({ known: true, commitCount: 0, bugs: [] });
    });

    it('refuses malformed SHAs, and GraphQL reports an unconfigured verifier as unknown', async () => {
      await expect(bugsFixedBetween(prisma, { repository: REPO, fromSha: 'v1.0', toSha: TO }, undefined, github(() => json({})))).rejects.toThrow(BUGS_FIXED_SHA_INVALID_MESSAGE);
      vi.stubEnv('GITHUB_VERIFICATION_REPOSITORIES', '');
      const response = await gql(`query ($repository: String!, $from: String!, $to: String!) { bugsFixedBetween(repository: $repository, fromSha: $from, toSha: $to) { known failureCode message bugs { fixSha } } }`, { repository: REPO, from: FROM, to: TO });
      expect(response.data.bugsFixedBetween).toMatchObject({ known: false, failureCode: 'SOURCE_NOT_ALLOWED', bugs: [] });
    });
  });
});
