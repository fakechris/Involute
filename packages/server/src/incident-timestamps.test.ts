import type { PrismaClient, Team, User } from '@prisma/client';

import { PrismaClient as PrismaClientConstructor } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ADMIN_EMAIL, DEFAULT_TEAM_KEY, resetAndSeed } from '../prisma/seed-helpers.ts';
import { loadProjectEnvironment } from '../prisma/env.ts';
import { startServer, type StartedServer } from './index.ts';
import { hashAgentToken } from './agent-credentials.ts';
import { createSession } from './session.js';
import { testParentId } from './test-placement.ts';
import {
  INCIDENT_IMPACT_AFTER_DETECTED_MESSAGE,
  INCIDENT_MITIGATED_AFTER_RESOLVED_MESSAGE,
  INCIDENT_REVIEW_NEEDS_RESOLVED_MESSAGE,
  INCIDENT_TIME_INVALID_MESSAGE,
  INCIDENT_TIME_REQUIRED_MESSAGE,
  INCIDENT_TIMES_NOT_INCIDENT_MESSAGE,
} from './errors.ts';
import { countsInIncidentMetrics, incidentDurations, incidentTimeOrderProblem } from './incident-timestamps.ts';
import { loadWorkTimeline } from './work-activity-timeline.ts';

loadProjectEnvironment();

const prisma: PrismaClient = new PrismaClientConstructor();
const AGENT_TOKEN = 'inv_agent_incident_times_test';
const IMPACT = '### 1. 目标与架构定位\n看板白屏\n\n### 2. 核心功能与交付范围\n所有用户无法打开看板\n\n### 3. 验收标准与验证方案\n看板恢复';
const t = (hour: number, minute = 0) => new Date(Date.UTC(2026, 9, 9, hour, minute));
const MINUTE = 60_000;

describe('incident timestamp helpers (INV-1125)', () => {
  it('orders impact started first and mitigated / detected no later than resolved', () => {
    const base = { impactStartedAt: t(8), detectedAt: t(9), mitigatedAt: t(10), resolvedAt: t(11) };
    expect(incidentTimeOrderProblem(base)).toBeNull();
    expect(incidentTimeOrderProblem({ ...base, impactStartedAt: t(9, 30) })).toBe(INCIDENT_IMPACT_AFTER_DETECTED_MESSAGE);
    expect(incidentTimeOrderProblem({ ...base, mitigatedAt: t(12) })).toBe(INCIDENT_MITIGATED_AFTER_RESOLVED_MESSAGE);
    // Mitigated before detected is allowed (automatic failover), and missing values are skipped.
    expect(incidentTimeOrderProblem({ ...base, mitigatedAt: t(8, 30) })).toBeNull();
    expect(incidentTimeOrderProblem({ impactStartedAt: t(8), detectedAt: null, mitigatedAt: null, resolvedAt: null })).toBeNull();
  });

  it('counts a missing mitigation as the resolution time, and measures from impact start', () => {
    const resolved = incidentDurations({ createdAt: t(9, 5), impactStartedAt: t(8), detectedAt: t(9), mitigatedAt: null, resolvedAt: t(11) });
    expect(resolved).toMatchObject({ timeToDetectMs: 60 * MINUTE, timeToMitigateMs: 180 * MINUTE, timeToResolveMs: 180 * MINUTE, impactMs: 180 * MINUTE, ongoing: false });
    const mitigated = incidentDurations({ createdAt: t(9, 5), impactStartedAt: t(8), detectedAt: t(9), mitigatedAt: t(9, 30), resolvedAt: t(11) });
    expect(mitigated.timeToMitigateMs).toBe(90 * MINUTE);
    const ongoing = incidentDurations({ createdAt: t(9), impactStartedAt: null, detectedAt: null, mitigatedAt: null, resolvedAt: null }, t(10));
    expect(ongoing).toMatchObject({ impactStartedAt: t(9), timeToResolveMs: null, timeToMitigateMs: null, impactMs: 60 * MINUTE, ongoing: true });
  });

  it('leaves declined, duplicate and invalid incidents out of metrics', () => {
    expect(countsInIncidentMetrics({ commitmentStatus: 'COMMITTED', resolution: null })).toBe(true);
    expect(countsInIncidentMetrics({ commitmentStatus: 'COMMITTED', resolution: 'COMPLETED' })).toBe(true);
    expect(countsInIncidentMetrics({ commitmentStatus: 'REJECTED', resolution: null })).toBe(false);
    expect(countsInIncidentMetrics({ commitmentStatus: 'COMMITTED', resolution: 'DUPLICATE' })).toBe(false);
    expect(countsInIncidentMetrics({ commitmentStatus: 'COMMITTED', resolution: 'INVALID' })).toBe(false);
    expect(countsInIncidentMetrics({ commitmentStatus: 'COMMITTED', resolution: null, duplicateOf: true })).toBe(false);
  });
});

const ISSUE_UPDATE_MUTATION = /* GraphQL */ `
  mutation IncidentTimes($id: String!, $input: IssueUpdateInput!) {
    issueUpdate(id: $id, input: $input) {
      success
      message
      issue { id impactStartedAt detectedAt mitigatedAt resolvedAt state { type } }
    }
  }
`;

describe('incident impact timestamps (INV-1125)', () => {
  let team: Team;
  let human: User;
  let parentId: string;
  let server: StartedServer;

  beforeAll(async () => { await prisma.$connect(); });
  afterAll(async () => { await resetAndSeed(prisma); await prisma.$disconnect(); });
  beforeEach(async () => {
    await resetAndSeed(prisma);
    team = await prisma.team.findUniqueOrThrow({ where: { key: DEFAULT_TEAM_KEY } });
    human = await prisma.user.findUniqueOrThrow({ where: { email: DEFAULT_ADMIN_EMAIL } });
    await prisma.teamMembership.upsert({ where: { teamId_userId: { teamId: team.id, userId: human.id } }, update: {}, create: { role: 'OWNER', teamId: team.id, userId: human.id } });
    const agent = await prisma.user.create({ data: { name: 'Watcher', email: 'watcher@agents.local', actorKind: 'AGENT', ownerId: human.id } });
    await prisma.teamMembership.create({ data: { role: 'EDITOR', teamId: team.id, userId: agent.id } });
    await prisma.agentCredential.create({ data: { name: 'watcher', scopes: ['read', 'propose', 'update', 'claim', 'report'], tokenHash: hashAgentToken(AGENT_TOKEN), teamId: team.id, userId: agent.id } });
    parentId = await testParentId(prisma, team.id, 'fakechris/Involute');
    server = await startServer({ allowAdminFallback: true, prisma, authToken: 'unused-static-token', port: 0 });
  });
  afterEach(async () => { await server.stop(); });

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

  const declare = (args: Record<string, unknown> = {}) =>
    callTool('work_propose', { title: 'Board is blank for everyone', severity: 'SEV1', description: IMPACT, parent_id: parentId, labels: ['incident'], ...args });

  async function graphqlUpdate(id: string, input: Record<string, unknown>) {
    const session = await createSession(prisma, human.id, 3600);
    const response = await fetch(`${server.url}/graphql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `involute_session=${session.token}` },
      body: JSON.stringify({ query: ISSUE_UPDATE_MUTATION, variables: { id, input } }),
    });
    return (await response.json() as { data: { issueUpdate: { success: boolean; message: string | null; issue: Record<string, any> | null } } }).data.issueUpdate;
  }

  it('stamps detected and impact started with the declaration time, or takes them from the declaration', async () => {
    const before = Date.now();
    const plain = await declare();
    expect(plain.error).toBeUndefined();
    const stored = await prisma.issue.findUniqueOrThrow({ where: { id: plain.id } });
    expect(stored.detectedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(stored.impactStartedAt).toEqual(stored.detectedAt);
    expect(stored.mitigatedAt).toBeNull();
    expect(stored.resolvedAt).toBeNull();

    const given = await declare({ title: 'Exports failed overnight', impact_started_at: t(2).toISOString(), detected_at: t(7).toISOString() });
    const row = await prisma.issue.findUniqueOrThrow({ where: { id: given.id }, include: { state: true } });
    expect(row).toMatchObject({ impactStartedAt: t(2), detectedAt: t(7) });
    expect(row.state.type).toBe('STARTED');

    expect((await declare({ title: 'Backwards', impact_started_at: t(9).toISOString(), detected_at: t(7).toISOString() })).error).toBe(INCIDENT_IMPACT_AFTER_DETECTED_MESSAGE);
    expect((await declare({ title: 'Garbled', detected_at: 'yesterday-ish' })).error).toBe(INCIDENT_TIME_INVALID_MESSAGE);
  });

  it('refuses the timestamps on work that is not an incident', async () => {
    const proposed = await callTool('work_propose', { title: 'Plain candidate', description: IMPACT, parent_id: parentId, detected_at: t(7).toISOString() });
    expect(proposed.error).toBe(INCIDENT_TIMES_NOT_INCIDENT_MESSAGE);
    const plain = await callTool('work_propose', { title: 'Plain candidate', description: IMPACT, parent_id: parentId });
    expect((await callTool('work_update', { id: plain.id, expected_revision: plain.revision, resolved_at: t(9).toISOString() })).error).toBe(INCIDENT_TIMES_NOT_INCIDENT_MESSAGE);
    const viaWeb = await graphqlUpdate(plain.id, { resolvedAt: t(9).toISOString() });
    expect(viaWeb).toMatchObject({ success: false, message: INCIDENT_TIMES_NOT_INCIDENT_MESSAGE });
  });

  it('moves and sets the timestamps through MCP and the web, refusing order violations with the reason', async () => {
    const declared = await declare({ impact_started_at: t(8).toISOString(), detected_at: t(9).toISOString() });
    let revision = declared.revision as number;

    const earlier = await callTool('work_update', { id: declared.id, expected_revision: revision, impact_started_at: t(7, 30).toISOString(), mitigated_at: t(9, 45).toISOString() });
    expect(earlier.error).toBeUndefined();
    revision = earlier.revision;
    expect(await prisma.issue.findUniqueOrThrow({ where: { id: declared.id } })).toMatchObject({ impactStartedAt: t(7, 30), mitigatedAt: t(9, 45) });

    expect((await callTool('work_update', { id: declared.id, expected_revision: revision, impact_started_at: t(9, 50).toISOString() })).error).toMatch(/out of order/);
    expect((await callTool('work_update', { id: declared.id, expected_revision: revision, detected_at: null })).error).toBe(INCIDENT_TIME_REQUIRED_MESSAGE);

    const backwards = await graphqlUpdate(declared.id, { resolvedAt: t(9, 40).toISOString() });
    expect(backwards).toMatchObject({ success: false, message: INCIDENT_MITIGATED_AFTER_RESOLVED_MESSAGE });
    const resolved = await graphqlUpdate(declared.id, { resolvedAt: t(11).toISOString() });
    expect(resolved.success).toBe(true);
    expect(resolved.issue).toMatchObject({ impactStartedAt: t(7, 30).toISOString(), detectedAt: t(9).toISOString(), mitigatedAt: t(9, 45).toISOString(), resolvedAt: t(11).toISOString() });
    const cleared = await graphqlUpdate(declared.id, { mitigatedAt: null });
    expect(cleared.issue!.mitigatedAt).toBeNull();

    // Every change is audited with the old value, and the timeline names it.
    const timeline = await loadWorkTimeline(prisma, declared.id);
    const summaries = timeline.entries.map((entry) => entry.summary);
    expect(summaries).toContain('Impact started 2026-10-09 08:00 UTC → 2026-10-09 07:30 UTC; Mitigated at 2026-10-09 09:45 UTC');
    expect(summaries).toContain('Resolved at 2026-10-09 11:00 UTC');
    expect(summaries).toContain('Cleared mitigated time');
  });

  it('lets an incident into In Review only once it is resolved, on every path', async () => {
    const declared = await declare({ impact_started_at: t(8).toISOString(), detected_at: t(9).toISOString() });
    const toReview = await callTool('work_update', { id: declared.id, expected_revision: declared.revision, state: 'REVIEW' });
    expect(toReview.error).toBe(INCIDENT_REVIEW_NEEDS_RESOLVED_MESSAGE);
    const review = await prisma.workflowState.findFirstOrThrow({ where: { teamId: team.id, type: 'REVIEW' } });
    expect(await graphqlUpdate(declared.id, { stateId: review.id })).toMatchObject({ success: false, message: INCIDENT_REVIEW_NEEDS_RESOLVED_MESSAGE });

    // A completed run is refused too until resolvedAt is set.
    const claim = await callTool('work_claim', { id: declared.id });
    expect(claim.error).toBeUndefined();
    const refused = await callTool('run_report', { work_id: declared.id, claim_token: claim.claim_token, status: 'completed', summary: 'Rolled back' });
    expect(refused.error).toBe(INCIDENT_REVIEW_NEEDS_RESOLVED_MESSAGE);
    const current = await prisma.issue.findUniqueOrThrow({ where: { id: declared.id }, include: { state: true } });
    expect(current.state.type).toBe('STARTED');

    const resolved = await callTool('work_update', { id: declared.id, expected_revision: current.revision, resolved_at: t(10).toISOString() });
    expect(resolved.error).toBeUndefined();
    const completed = await callTool('run_report', { work_id: declared.id, claim_token: claim.claim_token, status: 'completed', summary: 'Rolled back' });
    expect(completed.error).toBeUndefined();
    const reviewed = await prisma.issue.findUniqueOrThrow({ where: { id: declared.id }, include: { state: true } });
    expect(reviewed.state.type).toBe('REVIEW');
    // While In Review, resolvedAt cannot be taken away.
    expect(await graphqlUpdate(declared.id, { resolvedAt: null })).toMatchObject({ success: false, message: INCIDENT_REVIEW_NEEDS_RESOLVED_MESSAGE });
  });
});
