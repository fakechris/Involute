import { randomUUID } from 'node:crypto';
import { PrismaClient, type WorkflowStateType } from '@prisma/client';
import { afterAll, expect, it } from 'vitest';

import { DEFAULT_ADMIN_EMAIL, resetAndSeed } from '../prisma/seed-helpers.js';
import { recordRequestAudit } from './agent-request-service.js';
import { startServer } from './index.js';
import { createIssue, updateIssue } from './issue-service.js';
import { createSession } from './session.js';

const prisma = new PrismaClient();
const HOUR = 3_600_000;
const at = (hours: number) => new Date(Date.UTC(2026, 2, 8, 4) + hours * HOUR);

afterAll(() => prisma.$disconnect());

it('replays stored audit and run data for a shared project, with stable pages and cohort-wide samples', async () => {
  await resetAndSeed(prisma);
  const admin = await prisma.user.findUniqueOrThrow({ where: { email: DEFAULT_ADMIN_EMAIL } });
  const viewer = await prisma.user.create({ data: { name: 'Project viewer', email: 'latency-viewer@example.com', globalRole: 'GUEST' } });
  const team = await prisma.team.create({ data: { key: 'LAT', name: 'Private latency fixture', visibility: 'PRIVATE' } });
  const states = new Map<WorkflowStateType, string>();
  for (const type of ['UNSTARTED', 'STARTED', 'REVIEW', 'COMPLETED'] as const) {
    const state = await prisma.workflowState.create({ data: { teamId: team.id, name: type, type, position: states.size } });
    states.set(type, state.id);
  }
  const actor = { actorId: admin.id, actorKind: 'HUMAN' as const, surface: 'graphql' };
  const repo = 'metrics/shared';
  const project = await createIssue(prisma, { teamId: team.id, kind: 'PROJECT', title: 'Shared', repository: repo }, actor);
  await prisma.workShare.create({ data: { workId: project.id, userId: viewer.id, role: 'VIEWER', createdById: admin.id } });

  async function work(title: string, repository: string, acceptedHour?: number) {
    const issue = await createIssue(prisma, { teamId: team.id, title, repository, stateId: states.get('UNSTARTED') }, actor);
    await updateIssue(prisma, issue.id, { stateId: states.get('STARTED') }, actor);
    if (acceptedHour !== undefined) {
      await updateIssue(prisma, issue.id, { stateId: states.get('REVIEW') }, actor);
      await updateIssue(prisma, issue.id, { stateId: states.get('COMPLETED') }, actor);
      await prisma.workReviewDecision.updateMany({ where: { workId: issue.id }, data: { createdAt: at(acceptedHour) } });
    }
    await prisma.issue.update({ where: { id: issue.id }, data: { createdAt: at(0) } });
    for (const [index, hour] of [0, 1, 2, acceptedHour].entries()) {
      if (hour !== undefined) await prisma.workAudit.updateMany({ where: { workId: issue.id, revision: index + 1 }, data: { createdAt: at(hour) } });
    }
    return issue;
  }

  const delivered = await work('Readable delivery', repo, 4);
  const open = await work('Readable and open at cutoff', repo, 8);
  const missing = await work('No audit history', repo);
  await prisma.workAudit.deleteMany({ where: { workId: missing.id } });
  const imported = await prisma.issue.create({
    data: { identifier: 'LAT-1000', title: 'Imported before auditing', teamId: team.id, repository: repo, stateId: states.get('STARTED')!, createdAt: at(0) },
  });
  const requestAuditId = await prisma.$transaction((tx) => recordRequestAudit(tx, {
    actor, event: 'answered', request: { id: randomUUID(), workId: imported.id },
  }));
  await prisma.workAudit.update({ where: { id: requestAuditId }, data: { createdAt: at(3) } });
  const hidden = await work('Unshared delivery', 'metrics/unshared', 5);
  await prisma.workRun.createMany({
    data: [
      { workId: delivered.id, publicId: 'latency-run-a', startedAt: at(1), endedAt: at(3) },
      { workId: delivered.id, publicId: 'latency-run-b', startedAt: at(2), endedAt: at(4) },
      { workId: imported.id, publicId: 'latency-run-imported', startedAt: at(1), endedAt: at(2) },
    ],
  });

  const session = await createSession(prisma, viewer.id, 3600);
  const adminSession = await createSession(prisma, admin.id, 3600);
  const server = await startServer({ allowAdminFallback: false, prisma, authToken: 'unused-static-token', port: 0 });
  try {
    const query = `query ($start: DateTime!, $end: DateTime!, $after: String, $repository: String, $sample: DeliveryLatencySample) {
      deliveryLatency(teamKey: "LAT", start: $start, end: $end, first: 1, after: $after, repository: $repository, sample: $sample) {
        definitionVersion window { start end }
        coverage { workCount noHistoryCount openEpisodeCount }
        leadTime { sampleCount p50Ms p90Ms emptyReason coverage { acceptedCount missingCount } }
        cycleTime { sampleCount p50Ms }
        reviewWait { sampleCount p50Ms }
        nodes { id title repository state { name type } sampleEpisodeCount noHistory episodes { outcome historyGap ageMs leadTimeMs cycleTimeMs reviewWaitMs } runs { wallClockSumMs wallClockUnionMs humanActualWorkMs agentActualComputeMs } }
        pageInfo { endCursor hasNextPage }
      }
    }`;
    const request = async (after?: string, end = at(8), token: string | null = session.token, repository?: string, sample?: string) => {
      const response = await fetch(`${server.url}/graphql`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { cookie: `involute_session=${token}` } : {}) },
        body: JSON.stringify({ query, variables: { start: at(4).toISOString(), end: end.toISOString(), after, repository, sample } }),
      });
      return await response.json() as {
        data?: { deliveryLatency: {
          definitionVersion: string;
          leadTime: { sampleCount: number };
          cycleTime: { sampleCount: number };
          reviewWait: { sampleCount: number };
          coverage: { openEpisodeCount: number };
          nodes: { id: string; sampleEpisodeCount: number }[];
          pageInfo: { hasNextPage: boolean; endCursor: string };
        } };
        errors?: { message: string }[];
      };
    };

    const expectedIds = [delivered.id, open.id, missing.id, imported.id].sort();
    const nodes = new Map<string, unknown>();
    let after: string | undefined;
    for (const [index, id] of expectedIds.entries()) {
      const body = await request(after);
      expect(body.errors).toBeUndefined();
      const data = body.data!.deliveryLatency;
      expect(data).toMatchObject({
        definitionVersion: '1', window: { start: at(4).toISOString(), end: at(8).toISOString() },
        coverage: { workCount: 4, noHistoryCount: 1, openEpisodeCount: 2 },
        leadTime: { sampleCount: 1, p50Ms: 4 * HOUR, p90Ms: 4 * HOUR, emptyReason: null, coverage: { acceptedCount: 1, missingCount: 0 } },
        cycleTime: { sampleCount: 1, p50Ms: 3 * HOUR }, reviewWait: { sampleCount: 1, p50Ms: 2 * HOUR },
        nodes: [{ id }], pageInfo: { hasNextPage: index < expectedIds.length - 1 },
      });
      nodes.set(id, data.nodes[0]);
      after = data.pageInfo.endCursor;
    }
    expect(nodes.get(delivered.id)).toMatchObject({
      episodes: [{ outcome: 'ACCEPTED', leadTimeMs: 4 * HOUR }],
      runs: { wallClockSumMs: 4 * HOUR, wallClockUnionMs: 3 * HOUR, humanActualWorkMs: null, agentActualComputeMs: null },
    });
    expect(nodes.get(open.id)).toMatchObject({ episodes: [{ outcome: 'OPEN', ageMs: 8 * HOUR, leadTimeMs: null }] });
    expect(nodes.get(missing.id)).toMatchObject({ noHistory: true, episodes: [] });
    expect(nodes.get(imported.id)).toMatchObject({
      noHistory: false, episodes: [{ outcome: 'OPEN', historyGap: true, ageMs: null, leadTimeMs: null, cycleTimeMs: null, reviewWaitMs: null }],
      runs: { wallClockSumMs: HOUR, wallClockUnionMs: HOUR },
    });
    expect(nodes.has(hidden.id)).toBe(false);
    expect((await request(after)).data?.deliveryLatency.nodes).toEqual([]);
    expect((await request(after, at(9))).errors?.[0]?.message).toContain('Invalid delivery latency page cursor');
    expect((await request(undefined, at(8), adminSession.token)).data?.deliveryLatency.leadTime).toMatchObject({ sampleCount: 2, p90Ms: 5 * HOUR });
    expect((await request(undefined, at(8), null)).errors).toBeDefined();

    await work('Second readable delivery', repo, 6);
    for (const [sample, field] of [['LEAD_TIME', 'leadTime'], ['CYCLE_TIME', 'cycleTime'], ['REVIEW_WAIT', 'reviewWait'], ['OPEN', 'coverage']] as const) {
      let cursor: string | undefined;
      let count = 0;
      let itemCount = 0;
      let expected = 0;
      do {
        const body = await request(cursor, at(8), session.token, repo.toUpperCase(), sample);
        expect(body.errors).toBeUndefined();
        const result = body.data!.deliveryLatency;
        expected = field === 'coverage' ? result.coverage.openEpisodeCount : result[field].sampleCount;
        count += result.nodes.reduce((sum, node) => sum + node.sampleEpisodeCount, 0);
        itemCount += result.nodes.length;
        expect(result.nodes.every((node) => node.sampleEpisodeCount > 0)).toBe(true);
        expect(result.leadTime.sampleCount).toBe(2);
        cursor = result.pageInfo.hasNextPage ? result.pageInfo.endCursor : undefined;
      } while (cursor);
      expect(count).toBe(expected);
      expect(itemCount).toBe(2);
    }
    const filtered = await request(undefined, at(8), session.token, repo, 'LEAD_TIME');
    const cursor = filtered.data!.deliveryLatency.pageInfo.endCursor;
    expect((await request(cursor, at(8), session.token, repo, 'OPEN')).errors?.[0]?.message).toContain('Invalid delivery latency page cursor');
    expect((await request(cursor, at(8), session.token, 'metrics/unshared', 'LEAD_TIME')).errors?.[0]?.message).toContain('Invalid delivery latency page cursor');
    expect((await request(undefined, at(8), session.token, 'metrics/unshared')).data?.deliveryLatency.nodes).toEqual([]);
    expect((await request(undefined, at(8), adminSession.token, '__none__')).data?.deliveryLatency.nodes).toEqual([]);
    await prisma.issue.update({ where: { id: hidden.id }, data: { repository: null } });
    expect((await request(undefined, at(8), adminSession.token, '__none__', 'LEAD_TIME')).data?.deliveryLatency.nodes).toMatchObject([{ id: hidden.id, sampleEpisodeCount: 1, title: 'Unshared delivery', repository: null, state: { type: 'COMPLETED' } }]);
  } finally {
    await server.stop();
  }
});
