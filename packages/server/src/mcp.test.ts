import type { PrismaClient, Team, User, WorkflowState } from '@prisma/client';

import { PrismaClient as PrismaClientConstructor } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ADMIN_EMAIL, DEFAULT_TEAM_KEY, seedDatabase } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import { startServer, type StartedServer } from './index.ts';
import { READ_ONLY_MCP_TOOLS, WRITE_MCP_TOOLS } from './mcp-tools.ts';
import { hashAgentToken } from './agent-credentials.ts';
import { createGraphQLContext } from './auth.ts';
import { searchWorkPage } from './work-search-page.ts';
import type { SemanticIndex } from './embeddings/semantic-index.ts';
import { testParentId } from './test-placement.ts';

loadProjectEnvironment();

const prisma = new PrismaClientConstructor();
const TEST_AUTH_TOKEN = 'test-auth-token';

let server: StartedServer;

describe('Involute MCP', () => {
  let team: Team;
  let viewer: User;
  let ready: WorkflowState;

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.comment.deleteMany();
    await prisma.issue.deleteMany();
    await prisma.workflowState.deleteMany();
    await prisma.team.deleteMany();
    await prisma.issueLabel.deleteMany();
    // ActorAudit references users with Restrict (INV-586/604): it goes first.
    await prisma.actorAudit.deleteMany();
    await prisma.user.deleteMany();
    await prisma.legacyLinearMapping.deleteMany();
    await seedDatabase(prisma);

    team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
    viewer = await prisma.user.findUniqueOrThrow({ where: { email: DEFAULT_ADMIN_EMAIL } });
    ready = await prisma.workflowState.findFirstOrThrow({
      where: { teamId: team.id, name: 'Ready' },
    });
    server = await startServer({
      allowAdminFallback: true,
      prisma,
      authToken: TEST_AUTH_TOKEN,
      port: 0,
    });
  });

  afterEach(async () => {
    await server.stop();
  });

  it('rejects unauthenticated calls and hides write tools on the readonly endpoint', async () => {
    const unauthenticated = await mcpRpc('/mcp', { method: 'tools/list', id: 1 }, false);
    expect(unauthenticated.status).toBe(401);

    const allTools = await mcpRpc('/mcp', { method: 'tools/list', id: 2 });
    expect(allTools.status).toBe(200);
    const names = (allTools.body.result.tools as Array<{ name: string }>).map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining([...READ_ONLY_MCP_TOOLS, ...WRITE_MCP_TOOLS]));

    const readonlyTools = await mcpRpc('/mcp/readonly', { method: 'tools/list', id: 3 });
    const readonlyNames = (readonlyTools.body.result.tools as Array<{ name: string }>).map(
      (tool) => tool.name,
    );
    expect(readonlyNames).toEqual([...READ_ONLY_MCP_TOOLS]);

    const blocked = await mcpRpc('/mcp/readonly', {
      id: 4,
      method: 'tools/call',
      params: {
        name: 'work_propose',
        arguments: { team: DEFAULT_TEAM_KEY, title: 'should fail' },
      },
    });
    expect(blocked.body.error.message).toContain('read-only');
  });

  it('advertises tool annotations and serves the protocol guide on the readonly endpoint', async () => {
    const listed = await mcpRpc('/mcp/readonly', { method: 'tools/list', id: 'ann-1' });
    const tools = listed.body.result.tools as Array<{
      name: string;
      annotations?: { readOnlyHint?: boolean; idempotentHint?: boolean };
    }>;
    const search = tools.find((tool) => tool.name === 'work_search');
    expect(search?.annotations?.readOnlyHint).toBe(true);

    const guide = await mcpRpc('/mcp/readonly', {
      id: 'ann-2',
      method: 'tools/call',
      params: { name: 'protocol_get_guide', arguments: {} },
    });
    expect(guide.status).toBe(200);
    const guideText = JSON.stringify(guide.body.result);
    expect(guideText).toContain('Run complete is not work accepted');
    expect(guideText).toContain('involute-signature');
  });

  it('accepts revocable team-scoped agent tokens only on MCP', async () => {
    const token = 'inv_agent_test-credential';
    const agent = await prisma.user.create({
      data: { actorKind: 'AGENT', email: 'mcp-agent@example.com', name: 'MCP Agent' },
    });
    await prisma.teamMembership.create({
      data: { role: 'EDITOR', teamId: team.id, userId: agent.id },
    });
    const credential = await prisma.agentCredential.create({
      data: { name: 'test', tokenHash: hashAgentToken(token), userId: agent.id },
    });

    const mcpResponse = await mcpRpcWithToken('/mcp/readonly', {
      id: 'agent-tools',
      method: 'tools/list',
    }, token);
    expect(mcpResponse.status).toBe(200);
    expect(mcpResponse.body.result.tools).toHaveLength(READ_ONLY_MCP_TOOLS.length);

    const graphqlResponse = await fetch(`${server.url}/graphql`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query: '{ viewer { id } }' }),
    });
    expect((await graphqlResponse.json()).errors[0].message).toBe('Not authenticated');

    const prefixLookalike = await createGraphQLContext({
      authToken: TEST_AUTH_TOKEN,
      prisma,
      request: new Request(`${server.url}/mcp-evil`, {
        headers: { authorization: `Bearer ${token}` },
      }),
    });
    expect(prefixLookalike.authMode).toBe('none');

    await prisma.agentCredential.update({
      where: { id: credential.id },
      data: { revokedAt: new Date() },
    });
    expect((await mcpRpcWithToken('/mcp/readonly', {
      id: 'revoked-agent',
      method: 'tools/list',
    }, token)).status).toBe(401);
  });

  it('confines agent tokens to their granted scopes', async () => {
    const token = 'inv_agent_scoped-credential';
    const agent = await prisma.user.create({
      data: { actorKind: 'AGENT', email: 'scoped-agent@example.com', name: 'Scoped Agent' },
    });
    await prisma.teamMembership.create({
      data: { role: 'EDITOR', teamId: team.id, userId: agent.id },
    });
    await prisma.agentCredential.create({
      data: { name: 'read-only-agent', scopes: ['read'], tokenHash: hashAgentToken(token), userId: agent.id },
    });

    const allowed = await mcpRpcWithToken('/mcp', {
      id: 'scoped-search',
      method: 'tools/call',
      params: { name: 'work_search', arguments: { query: 'nothing' } },
    }, token);
    expect(allowed.body.error).toBeUndefined();

    const denied = await mcpRpcWithToken('/mcp', {
      id: 'scoped-propose',
      method: 'tools/call',
      params: { name: 'work_propose', arguments: { team: DEFAULT_TEAM_KEY, title: 'no scope' } },
    }, token);
    expect(denied.body.error.message).toContain('lacks required scope: propose');
  });

  it('keeps a suggested priority on a non-bug proposal and refuses one out of range (INV-936)', async () => {
    const proposed = await callTool('work_propose', {
      team: DEFAULT_TEAM_KEY,
      title: 'Low priority follow-up',
      repository: 'test/placement',
      labels: ['improvement'],
      priority: 4,
    });
    expect(proposed).toMatchObject({ commitmentStatus: 'CANDIDATE', priority: 4 });

    const refused = await mcpRpc('/mcp', {
      id: 'bad-priority',
      method: 'tools/call',
      params: { name: 'work_propose', arguments: { team: DEFAULT_TEAM_KEY, title: 'Bad priority', repository: 'test/placement', priority: 9 } },
    });
    expect(JSON.stringify(refused.body)).toContain('Priority must be 0 (none)');
  });

  it('runs search → context → propose → commit → claim without marking work done', async () => {
    await prisma.issue.create({
      data: {
        identifier: 'INV-100',
        title: 'Existing MCP search hit',
        teamId: team.id,
        stateId: ready.id,
      },
    });

    const search = await callTool('work_search', { query: 'MCP search' });
    expect(JSON.stringify(search)).toContain('INV-100');

    const proposed = await callTool('work_propose', {
      team: DEFAULT_TEAM_KEY,
      title: 'Ignore aborted turns in parser',
      repository: 'test/placement',
      idempotency_key: 'mcp-parser-1',
    });
    expect(proposed.commitmentStatus).toBe('CANDIDATE');
    // No parent yet: the proposal says so, and committing it is refused (INV-719).
    expect(proposed.warning).toContain('no parent');

    const replay = await callTool('work_propose', {
      team: DEFAULT_TEAM_KEY,
      title: 'Ignore aborted turns in parser',
      repository: 'test/placement',
      idempotency_key: 'mcp-parser-1',
    });
    expect(replay.identifier).toBe(proposed.identifier);

    const readyBefore = await callTool('work_list_ready', {});
    expect(readyIdentifiers(readyBefore)).not.toContain(proposed.identifier);

    const context = await callTool('work_get_context', { id: proposed.identifier });
    expect(context.work.identifier).toBe(proposed.identifier);

    const refused = await mcpRpc('/mcp', {
      id: 'commit-without-parent',
      method: 'tools/call',
      params: {
        name: 'work_commit',
        arguments: {
          id: proposed.identifier,
          expected_revision: proposed.revision,
          acceptance: 'Aborted turns are omitted from extracted issues',
          assignee_id: viewer.id,
        },
      },
    });
    expect(JSON.stringify(refused.body)).toContain('requires a parent');

    const committed = await callTool('work_commit', {
      id: proposed.identifier,
      expected_revision: proposed.revision,
      acceptance: 'Aborted turns are omitted from extracted issues',
      assignee_id: viewer.id,
      parent_id: await testParentId(prisma, team.id),
    });
    expect(committed.commitmentStatus).toBe('COMMITTED');
    expect(committed.parentId).toBe(await testParentId(prisma, team.id));

    const claimed = await callTool('work_claim', { id: committed.identifier });
    expect(claimed.claim.actorId).toBe(viewer.id);
    expect(claimed.work.assigneeId).toBe(viewer.id);

    const readyAfter = await callTool('work_list_ready', {});
    expect(readyIdentifiers(readyAfter)).not.toContain(committed.identifier);
    expect(claimed.work.commitmentStatus).toBe('COMMITTED');
  });

  it('shares project scope semantics between MCP and GraphQL Ready queries', async () => {
    const root = await prisma.issue.create({ data: {
      identifier: 'SCOPE-100', title: 'Project root', kind: 'PROJECT',
      teamId: team.id, stateId: ready.id, assigneeId: viewer.id,
      acceptance: 'reviewed', repository: 'scope/repo',
    } });
    await prisma.issue.create({ data: {
      identifier: 'SCOPE-101', title: 'First leaf', priority: 1,
      teamId: team.id, stateId: ready.id, assigneeId: viewer.id,
      acceptance: 'reviewed', repository: 'scope/repo',
    } });
    const selectors = [
      { mcp: { repository: root.repository }, graphql: { repository: root.repository } },
      { mcp: { project_id: root.id }, graphql: { projectId: root.id } },
      { mcp: { project_id: root.identifier }, graphql: { projectId: root.identifier } },
    ];
    for (const selector of selectors) {
      const mcp = await callTool('work_list_ready', { ...selector.mcp, first: 1 });
      expect(readyIdentifiers(mcp)).toEqual(['SCOPE-101']);
      expect(mcp.hasNextPage).toBe(true);
      const response = await fetch(`${server.url}/graphql`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${TEST_AUTH_TOKEN}` },
        body: JSON.stringify({
          query: `query ScopeReady($filter: ReadyWorkFilter) {
            readyWork(filter: $filter) { nodes { identifier } pageInfo { hasNextPage } }
          }`,
          variables: { filter: { ...selector.graphql, first: 1 } },
        }),
      });
      const body = await response.json() as {
        errors?: unknown;
        data: { readyWork: { nodes: Array<{ identifier: string }>; pageInfo: { hasNextPage: boolean } } };
      };
      expect(body.errors).toBeUndefined();
      expect(readyIdentifiers(body.data.readyWork)).toEqual(readyIdentifiers(mcp));
      expect(body.data.readyWork.pageInfo.hasNextPage).toBe(mcp.hasNextPage);
    }
    const badSelector = await mcpRpc('/mcp/readonly', {
      id: 'unknown-project', method: 'tools/call',
      params: { name: 'work_list_ready', arguments: { project_id: 'UNKNOWN-PROJECT' } },
    });
    expect(badSelector.body.error.message).toContain('Project scope not found');
  });

  it('rejects invalid related-work types and missing evidence run IDs at runtime', async () => {
    const invalidType = await mcpRpc('/mcp', {
      id: 'invalid-related-type',
      method: 'tools/call',
      params: {
        name: 'work_propose',
        arguments: { team: DEFAULT_TEAM_KEY, title: 'Invalid relation', related_work_type: 'NOT_A_LINK' },
      },
    });
    expect(invalidType.body.error.message).toContain('related_work_type');

    const existing = await prisma.issue.create({
      data: { identifier: 'INV-101', stateId: ready.id, teamId: team.id, title: 'Evidence target' },
    });
    const missingRun = await mcpRpc('/mcp', {
      id: 'missing-run',
      method: 'tools/call',
      params: {
        name: 'evidence_attach',
        arguments: { work_id: existing.id, kind: 'test', url: 'https://example.test/report' },
      },
    });
    expect(missingRun.body.error.message).toContain('run_id');
  });

  it('binds an agent run but never accepts caller-supplied verification records', async () => {
    const token = 'inv_agent_verification-test';
    const agent = await prisma.user.create({ data: { actorKind: 'AGENT', email: 'verifier-client@example.com', name: 'Client' } });
    await prisma.teamMembership.create({ data: { role: 'EDITOR', teamId: team.id, userId: agent.id } });
    await prisma.agentCredential.create({ data: { name: 'client', tokenHash: hashAgentToken(token), teamId: team.id, userId: agent.id } });
    const work = await prisma.issue.create({ data: { identifier: 'INV-103', title: 'Bound run', stateId: ready.id,
      teamId: team.id, assigneeId: viewer.id, commitmentStatus: 'COMMITTED', acceptance: 'human review', repository: 'example/project' } });
    const invoke = async (name: string, args: Record<string, unknown>) => {
      const response = await mcpRpcWithToken('/mcp', { id: name, method: 'tools/call', params: { name, arguments: args } }, token);
      expect(response.body.error).toBeUndefined();
      return JSON.parse(response.body.result.content[0].text);
    };
    const claim = await invoke('work_claim', { id: work.id });
    expect(JSON.stringify(claim)).not.toContain('executionTokenHash');
    await invoke('run_report', { work_id: work.id, claim_token: claim.claim_token, status: 'running', commit_sha: 'a'.repeat(40), pr_number: 4 });
    const run = await prisma.workRun.findFirstOrThrow({ where: { workId: work.id } });
    expect(run).toMatchObject({ commitSha: 'a'.repeat(40), pullRequestNumber: 4, repository: 'example/project' });
    expect(run.contractRevision).toHaveLength(64);
    await invoke('evidence_attach', { work_id: work.id, claim_token: claim.claim_token, run_id: run.id, kind: 'test', url: 'https://github.com/example/project/actions/runs/8',
      summary: 'status=VERIFIED', status: 'VERIFIED', verifications: [{ status: 'VERIFIED', verifierId: 'github-app' }] });
    expect(await prisma.evidenceVerification.count()).toBe(0);
    expect(await prisma.workEvidence.count({ where: { workId: work.id } })).toBe(1);
    const denied = await mcpRpcWithToken('/mcp', { id: 'forge', method: 'tools/call',
      params: { name: 'evidence_verify', arguments: { work_id: work.id, status: 'VERIFIED' } } }, token);
    expect(denied.body.error).toBeDefined();
    const graph = await fetch(`${server.url}/graphql`, { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TEST_AUTH_TOKEN}` },
      body: JSON.stringify({ query: 'mutation { evidenceVerificationCreate(status: "VERIFIED") { id } }' }) });
    expect((await graph.json()).errors).toBeDefined();
    expect(await prisma.evidenceVerification.count()).toBe(0);
  });

  it('moves existing work with revision checks and repairs a reversed BLOCKS edge', async () => {
    const oldParent = await testParentId(prisma, team.id);
    const parent = await prisma.issue.create({ data: {
      identifier: 'INV-950', title: 'Destination', kind: 'MILESTONE',
      teamId: team.id, stateId: ready.id, repository: (await prisma.issue.findUniqueOrThrow({ where: { id: oldParent } })).repository,
    } });
    const child = await prisma.issue.create({ data: {
      identifier: 'INV-951', title: 'Implementation', kind: 'ISSUE', parentId: oldParent,
      teamId: team.id, stateId: ready.id, repository: parent.repository,
    } });
    await prisma.workLink.create({ data: { fromId: oldParent, toId: child.id, type: 'CONTAINS' } });
    const moved = await callTool('work_update', { id: child.identifier, parent_id: parent.identifier, expected_revision: child.revision });
    expect(moved.parentId).toBe(parent.id);
    expect(await prisma.workLink.findMany({ where: { toId: child.id, type: 'CONTAINS' } })).toMatchObject([{ fromId: parent.id }]);
    const stale = await mcpRpc('/mcp', { id: 'stale-parent', method: 'tools/call', params: {
      name: 'work_update', arguments: { id: child.id, parent_id: oldParent, expected_revision: child.revision },
    } });
    expect(stale.body.error).toBeDefined();
    expect((await prisma.issue.findUniqueOrThrow({ where: { id: child.id } })).parentId).toBe(parent.id);
    const link = await callTool('work_link', { from_id: parent.id, to_id: child.id, type: 'BLOCKS' });
    const cycle = await mcpRpc('/mcp', { id: 'cycle', method: 'tools/call', params: {
      name: 'work_link', arguments: { from_id: child.id, to_id: parent.id, type: 'BLOCKS' },
    } });
    expect(cycle.body.error).toBeDefined();
    expect(await callTool('work_unlink', { from_id: parent.identifier, to_id: child.identifier, type: 'BLOCKS' })).toMatchObject({ removed: true, id: link.id });
    expect(await callTool('work_unlink', { from_id: parent.identifier, to_id: child.identifier, type: 'BLOCKS' })).toMatchObject({ removed: false });
    await callTool('work_link', { from_id: child.id, to_id: parent.id, type: 'BLOCKS' });
    const concurrent = await Promise.all([1, 2].map(() => callTool('work_unlink', { from_id: child.id, to_id: parent.id, type: 'BLOCKS' })));
    expect(concurrent.map((result) => result.removed).sort()).toEqual([false, true]);
    expect(await prisma.workAudit.findFirst({ where: { workId: parent.id, reason: { contains: link.id } } })).toMatchObject({ surface: 'mcp' });
    const orphan = await mcpRpc('/mcp', { id: 'orphan', method: 'tools/call', params: {
      name: 'work_unlink', arguments: { from_id: parent.id, to_id: child.id, type: 'CONTAINS' },
    } });
    expect(orphan.body.error).toBeDefined();
    expect(await prisma.workLink.count({ where: { toId: child.id, type: 'CONTAINS' } })).toBe(1);
  });

  it('enforces agent scopes, endpoint access and repository constraints for graph edits', async () => {
    const agent = await prisma.user.create({ data: { name: 'Graph agent', email: 'graph-agent@test.local', actorKind: 'AGENT', ownerId: viewer.id, globalRole: 'USER' } });
    const token = 'inv_agent_graph_edit_test';
    const credential = await prisma.agentCredential.create({ data: { name: 'graph', tokenHash: hashAgentToken(token), teamId: team.id, userId: agent.id, scopes: ['read', 'update', 'link'] } });
    const parentId = await testParentId(prisma, team.id);
    const child = await prisma.issue.create({ data: { identifier: 'INV-952', title: 'Child', kind: 'ISSUE', teamId: team.id, stateId: ready.id, repository: 'test/placement' } });
    const invoke = (name: string, args: Record<string, unknown>) => mcpRpcWithToken('/mcp', { id: name, method: 'tools/call', params: { name, arguments: args } }, token);
    const moved = await invoke('work_update', { id: child.id, parent_id: parentId, expected_revision: child.revision });
    expect(moved.body.error).toBeUndefined();
    const revision = JSON.parse(moved.body.result.content[0].text).revision;
    const foreignRepo = await prisma.issue.create({ data: { identifier: 'INV-953', title: 'Other repo', kind: 'MILESTONE', teamId: team.id, stateId: ready.id, repository: 'other/repo' } });
    expect((await invoke('work_update', { id: child.id, parent_id: foreignRepo.id, expected_revision: revision })).body.error).toBeDefined();
    const otherTeam = await prisma.team.create({ data: { key: 'FOREIGN', name: 'Private', visibility: 'PRIVATE' } });
    const otherState = await prisma.workflowState.create({ data: { name: 'Ready', type: 'UNSTARTED', position: 0, teamId: otherTeam.id } });
    const foreign = await prisma.issue.create({ data: { identifier: 'FOREIGN-1', title: 'Private parent', kind: 'PROJECT', teamId: otherTeam.id, stateId: otherState.id, repository: 'test/placement' } });
    expect((await invoke('work_update', { id: child.id, parent_id: foreign.id, expected_revision: revision })).body.error).toBeDefined();
    await prisma.workLink.create({ data: { fromId: child.id, toId: foreign.id, type: 'RELATED_TO' } });
    expect((await invoke('work_unlink', { from_id: child.id, to_id: foreign.id, type: 'RELATED_TO' })).body.error).toBeDefined();
    expect(await prisma.workLink.count({ where: { fromId: child.id, toId: foreign.id } })).toBe(1);
    await prisma.agentCredential.update({ where: { id: credential.id }, data: { scopes: ['read'] } });
    const denied = await invoke('work_unlink', { from_id: parentId, to_id: child.id, type: 'BLOCKS' });
    expect(denied.body.error.message).toContain('scope');
  });

  it('supports updating work state via work_update and rejects COMPLETED/CANCELED', async () => {
    const candidate = await prisma.issue.create({
      data: {
        identifier: 'INV-102',
        stateId: ready.id,
        teamId: team.id,
        title: 'State transition target',
        commitmentStatus: 'COMMITTED',
      },
    });

    const inProgressState = await prisma.workflowState.findFirstOrThrow({
      where: { teamId: team.id, type: 'STARTED' },
    });

    const updated = await callTool('work_update', {
      id: candidate.id,
      expected_revision: candidate.revision,
      state: 'IN_PROGRESS',
    });
    expect(updated.stateId).toBe(inProgressState.id);

    const illegal = await mcpRpc('/mcp', {
      id: 'illegal-state',
      method: 'tools/call',
      params: {
        name: 'work_update',
        arguments: {
          id: candidate.id,
          expected_revision: updated.revision,
          state: 'COMPLETED',
        },
      },
    });
    expect(illegal.body.error.message).toContain('COMPLETED');
  });
  it('edits routine metadata and clears fields explicitly through the shared issue service', async () => {
    const issue = await prisma.issue.create({ data: { identifier: 'INV-9950', title: 'Metadata', teamId: team.id, stateId: ready.id, description: 'Clear this', commitmentStatus: 'CANDIDATE' } });
    const label = await prisma.issueLabel.findUniqueOrThrow({ where: { name: 'needs-clarification' } });
    const updated = await callTool('work_update', { id: issue.id, expected_revision: issue.revision, description: null, label_ids: [label.id] });
    expect(updated.description).toBeNull();
    const labeled = await prisma.issue.findUniqueOrThrow({ where: { id: issue.id }, include: { labels: true } });
    expect(labeled.labels.map((entry) => entry.id)).toEqual([label.id]);
    await callTool('work_update', { id: issue.id, expected_revision: updated.revision, label_ids: [] });
    expect((await prisma.issue.findUniqueOrThrow({ where: { id: issue.id }, include: { labels: true } })).labels).toHaveLength(0);
  });

  it('exhausts 50 original comments and 20 runs without omission or duplication', async () => {
    const issue = await prisma.issue.create({ data: { identifier: 'INV-9951', title: 'Paged history', teamId: team.id, stateId: ready.id } });
    await prisma.comment.createMany({ data: Array.from({ length: 50 }, (_, i) => ({ issueId: issue.id, userId: viewer.id, body: `Original comment ${i}` })) });
    await prisma.workRun.createMany({ data: Array.from({ length: 20 }, (_, i) => ({ workId: issue.id, publicId: `RUN-PAGE-${i}` })) });
    for (const [section, total] of [['comments', 50], ['runs', 20]] as const) {
      const ids: string[] = [];
      let after: string | undefined;
      for (;;) {
        const page = await callTool('work_read_page', { id: issue.id, section, first: 7, ...(after ? { after } : {}) });
        ids.push(...page.nodes.map((row: { id: string }) => row.id));
        if (!page.pageInfo.hasNextPage) break;
        after = page.pageInfo.endCursor;
      }
      expect(ids).toHaveLength(total);
      expect(new Set(ids).size).toBe(total);
    }
    const context = await callTool('work_get_context', { id: issue.id });
    expect(context.pages.comments.pageInfo.hasNextPage).toBe(true);
    expect(context.pages.runs.pageInfo.hasNextPage).toBe(true);
  });

  it('appends comments idempotently with the authenticated author', async () => {
    const issue = await prisma.issue.create({ data: { identifier: 'INV-9952', title: 'Comments', teamId: team.id, stateId: ready.id } });
    const input = { work_id: issue.id, body: 'Clarification resolved', idempotency_key: 'same-comment' };
    const first = await callTool('work_comment', input);
    const replay = await callTool('work_comment', input);
    expect(replay.id).toBe(first.id);
    expect(first.userId).toBe(viewer.id);
    expect(await prisma.comment.count({ where: { issueId: issue.id } })).toBe(1);
    const changed = await mcpRpc('/mcp', { id: 'changed-comment', method: 'tools/call', params: { name: 'work_comment', arguments: { ...input, body: 'Different content' } } });
    expect(changed.body.error).toBeDefined();
  });

  it('continues partially filled semantic pages and declares the shared recall boundary', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 60; i++) {
      const row = await prisma.issue.create({ data: { identifier: `SEM-${i}`, title: `Unrelated lexical wording ${i}`, teamId: team.id, stateId: ready.id } });
      ids.push(row.id);
    }
    const context = await createGraphQLContext({ prisma, authToken: TEST_AUTH_TOKEN, allowAdminFallback: true,
      request: new Request(`${server.url}/mcp`, { headers: { authorization: `Bearer ${TEST_AUTH_TOKEN}` } }),
    });
    context.semanticIndex = { search: async () => ids.map((id, i) => ({ id, similarity: 1 - i / 100 })) } as unknown as SemanticIndex;
    const returned: string[] = [];
    let after: string | null = null;
    for (;;) {
      const page = await searchWorkPage(context, { query: 'Meaningonlyneedle', first: 50 }, after);
      returned.push(...page.nodes.map((node) => node.id));
      expect(page.recall.semantic.exhaustive).toBe(false);
      expect(page.recall.semantic.candidateLimit).toBe(60);
      if (!page.pageInfo.hasNextPage) break;
      after = page.pageInfo.endCursor;
    }
    expect(returned).toHaveLength(60);
    expect(new Set(returned).size).toBe(60);
  });

  it('rechecks current team access when continuing an agent search', async () => {
    const token = 'inv_agent_paging-access';
    const agent = await prisma.user.create({ data: { name: 'Paging agent', email: 'paging-agent@example.com', actorKind: 'AGENT' } });
    const credential = await prisma.agentCredential.create({ data: { name: 'paging', userId: agent.id, teamId: team.id, tokenHash: hashAgentToken(token), scopes: ['read'] } });
    await prisma.issue.createMany({ data: Array.from({ length: 3 }, (_, i) => ({ identifier: `ACCESS-${i}`, title: `Accesspaginationneedle ${i}`, teamId: team.id, stateId: ready.id })) });
    const args = { query: 'Accesspaginationneedle', paginate: true, first: 1 };
    const fetchPage = async (arguments_: Record<string, unknown>) => {
      const response = await mcpRpcWithToken('/mcp', { id: 'page-access', method: 'tools/call', params: { name: 'work_search', arguments: arguments_ } }, token);
      expect(response.body.error).toBeUndefined();
      return JSON.parse(response.body.result.content[0].text);
    };
    const first = await fetchPage(args);
    expect(first.nodes).toHaveLength(1);
    const other = await prisma.team.create({ data: { key: 'CUR', name: 'Cursor other team', visibility: 'PRIVATE' } });
    await prisma.agentCredential.update({ where: { id: credential.id }, data: { teamId: other.id } });
    const next = await fetchPage({ ...args, after: first.pageInfo.endCursor });
    expect(next.nodes).toHaveLength(0);
    expect(next.pageInfo.hasNextPage).toBe(false);
  });

  it('binds continuation to query and actor and refuses expired cursors', async () => {
    await prisma.issue.createMany({ data: Array.from({ length: 3 }, (_, i) => ({ identifier: `CURSOR-${i}`, title: `Cursorboundaryneedle ${i}`, teamId: team.id, stateId: ready.id })) });
    const args = { query: 'Cursorboundaryneedle', paginate: true, first: 1 };
    const page = await callTool('work_search', args);
    const after = page.pageInfo.endCursor;
    expect(after).toBeTruthy();
    const rejected = async (arguments_: Record<string, unknown>) => {
      const response = await mcpRpc('/mcp', { id: 'bad-cursor', method: 'tools/call', params: { name: 'work_search', arguments: arguments_ } });
      expect(response.body.error.message).toContain('Cursor expired or belongs');
    };
    await rejected({ ...args, after, query: 'another query' });
    await prisma.workSearchCursor.update({ where: { id: after }, data: { actorKey: 'another-principal' } });
    await rejected({ ...args, after });
    const fresh = await callTool('work_search', args);
    await prisma.workSearchCursor.update({ where: { id: fresh.pageInfo.endCursor }, data: { expiresAt: new Date(0) } });
    await rejected({ ...args, after: fresh.pageInfo.endCursor });
  });

  it('pages actor catalogs including credential-bound agents and omits secrets', async () => {
    const agent = await prisma.user.create({ data: { name: 'Bound catalog agent', email: 'bound-catalog@example.com', actorKind: 'AGENT' } });
    await prisma.agentCredential.create({ data: { name: 'catalog', userId: agent.id, teamId: team.id, tokenHash: hashAgentToken('inv_agent_catalog') } });
    const page = await callTool('work_catalog', { kind: 'actors', team_id: team.id });
    expect(page.nodes.map((row: { id: string }) => row.id)).toContain(agent.id);
    expect(JSON.stringify(page)).not.toContain('tokenHash');
    expect(JSON.stringify(page)).not.toContain('inv_agent_catalog');
    const caps = await callTool('work_catalog', { kind: 'capabilities' });
    expect(caps.tools.find((tool: { name: string }) => tool.name === 'work_comment').scope).toBe('update');
  });

  it('enumerates 300 search and ready matches beyond the old 200-item limit', async () => {
    await prisma.issue.createMany({ data: Array.from({ length: 300 }, (_, i) => ({ identifier: `PAGE-${i}`, title: `Exhaustivepaginationneedle ${i}`, teamId: team.id, stateId: ready.id, assigneeId: viewer.id, acceptance: 'Enumerate all records', repository: 'fixture/pagination' })) });
    for (const name of ['work_search', 'work_list_ready']) {
      const ids: string[] = [];
      let after: string | undefined;
      for (;;) {
        const page = await callTool(name, { repository: 'fixture/pagination', first: 80, ...(name === 'work_search' ? { query: 'Exhaustivepaginationneedle', paginate: true } : {}), ...(after ? { after } : {}) });
        ids.push(...page.nodes.map((row: { id: string }) => row.id));
        if (!page.pageInfo.hasNextPage) break;
        after = page.pageInfo.endCursor;
      }
      expect(ids).toHaveLength(300);
      expect(new Set(ids).size).toBe(300);
    }
  });

});

function readyIdentifiers(result: { nodes?: Array<{ identifier: string }> }): string[] {
  return result.nodes?.map((issue) => issue.identifier) ?? [];
}

async function callTool(name: string, args: Record<string, unknown>): Promise<any> {
  const response = await mcpRpc('/mcp', {
    id: name,
    method: 'tools/call',
    params: { name, arguments: args },
  });
  expect(response.status).toBe(200);
  expect(response.body.error).toBeUndefined();
  return JSON.parse(response.body.result.content[0].text);
}

async function mcpRpc(
  path: string,
  message: { id: number | string; method: string; params?: unknown },
  authenticated = true,
): Promise<{ body: any; status: number }> {
  const response = await fetch(`${server.url}${path}`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      ...(authenticated ? { authorization: `Bearer ${TEST_AUTH_TOKEN}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', ...message }),
  });

  return {
    body: await response.json(),
    status: response.status,
  };
}

async function mcpRpcWithToken(
  path: string,
  message: { id: number | string; method: string; params?: unknown },
  token: string,
): Promise<{ body: any; status: number }> {
  const response = await fetch(`${server.url}${path}`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', ...message }),
  });
  return { body: await response.json(), status: response.status };
}
