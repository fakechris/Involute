import type { Prisma, PrismaClient, WorkflowStateType } from '@prisma/client';

import { createValidationError, exposeErrorMessages } from './errors.js';
import { LATENCY_DEFINITION_VERSION, latencyPercentiles, replayDeliveryLatency, runWallClock, type LatencySnapshot, type LatencyWindow } from './latency-metrics.js';

const BATCH_SIZE = 100;
const UUID = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
const INVALID_WINDOW = 'Choose a delivery latency window with start before end.';
const INVALID_FIRST = 'Choose first between 1 and 100.';
const INVALID_CURSOR = 'Invalid delivery latency page cursor.';

exposeErrorMessages([INVALID_WINDOW, INVALID_FIRST, INVALID_CURSOR]);

function readSnapshot(value: Prisma.JsonValue, states: ReadonlyMap<string, WorkflowStateType>): LatencySnapshot {
  const row = value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const stateId = typeof row.stateId === 'string' ? row.stateId : null;
  const status = row.commitmentStatus;
  return {
    stateId,
    stateType: stateId === null ? null : states.get(stateId) ?? null,
    commitmentStatus: status === 'COMMITTED' || status === 'CANDIDATE' || status === 'REJECTED' ? status : null,
  };
}

interface LatencyQuery extends LatencyWindow {
  teamKey: string;
  first: number;
  after?: string | null;
}

export async function loadDeliveryLatency(prisma: PrismaClient, readable: Prisma.IssueWhereInput, input: LatencyQuery) {
  const { start, end, teamKey, first, after } = input;
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start >= end) {
    throw createValidationError(INVALID_WINDOW);
  }
  if (!Number.isInteger(first) || first < 1 || first > 100) throw createValidationError(INVALID_FIRST);
  const cursorScope = JSON.stringify([teamKey, start.toISOString(), end.toISOString()]);
  let pageAfter = '';
  if (after != null) {
    try {
      const cursor = JSON.parse(Buffer.from(after, 'base64url').toString('utf8'));
      if (cursor.scope !== cursorScope || typeof cursor.id !== 'string' || !UUID.test(cursor.id)) throw new Error();
      pageAfter = cursor.id;
    } catch {
      throw createValidationError(INVALID_CURSOR);
    }
  }

  const scope: Prisma.IssueWhereInput = { AND: [readable, { team: { key: teamKey }, kind: 'ISSUE', createdAt: { lt: end } }] };
  const stateRows = await prisma.workflowState.findMany({ where: { team: { key: teamKey } }, select: { id: true, type: true } });
  const states = new Map(stateRows.map(({ id, type }) => [id, type]));
  const page: { id: string; identifier: string; replay: ReturnType<typeof replayDeliveryLatency> }[] = [];
  const coverage = { workCount: 0, noHistoryCount: 0, openEpisodeCount: 0, closedWithoutAcceptanceCount: 0, unknownEpisodeCount: 0 };
  const lead: number[] = [];
  const cycle: number[] = [];
  const review: number[] = [];
  let acceptedCount = 0;
  let batchAfter: string | undefined;
  for (;;) {
    const batch = await prisma.issue.findMany({
      where: { AND: [scope, ...(batchAfter ? [{ id: { gt: batchAfter } }] : [])] },
      orderBy: { id: 'asc' },
      take: BATCH_SIZE,
      select: {
        id: true,
        identifier: true,
        audits: { where: { createdAt: { lt: end } }, select: { id: true, revision: true, createdAt: true, before: true, after: true } },
        reviewDecisions: { where: { decision: 'ACCEPTED', createdAt: { lt: end } }, select: { fromRevision: true, toRevision: true } },
      },
    });
    for (const { id, identifier, audits, reviewDecisions } of batch) {
      const acceptances = new Set(reviewDecisions.map(({ fromRevision, toRevision }) => `${fromRevision}:${toRevision}`));
      const replay = replayDeliveryLatency(audits.map((audit) => {
        const before = audit.before === null ? null : readSnapshot(audit.before, states);
        const beforeRevision = audit.before !== null && typeof audit.before === 'object' && !Array.isArray(audit.before) ? audit.before.revision : null;
        return {
          ...audit, before, after: readSnapshot(audit.after, states), beforeRevision: typeof beforeRevision === 'number' ? beforeRevision : null,
          accepted: typeof beforeRevision === 'number' && acceptances.has(`${beforeRevision}:${audit.revision}`),
        };
      }), end);
      if (!replay.noHistory && replay.episodes.length === 0) continue;
      coverage.workCount++;
      if (replay.noHistory) coverage.noHistoryCount++;
      for (const episode of replay.episodes) {
        if (episode.outcome === 'OPEN') coverage.openEpisodeCount++;
        if (episode.outcome === 'CLOSED') coverage.closedWithoutAcceptanceCount++;
        if (episode.outcome === 'UNKNOWN') coverage.unknownEpisodeCount++;
        if (episode.acceptedAt === null || episode.acceptedAt < start) continue;
        acceptedCount++;
        if (episode.leadTimeMs !== null) lead.push(episode.leadTimeMs);
        if (episode.cycleTimeMs !== null) cycle.push(episode.cycleTimeMs);
        if (episode.reviewWaitMs !== null) review.push(episode.reviewWaitMs);
      }
      if (id > pageAfter && page.length <= first) page.push({ id, identifier, replay });
    }
    if (batch.length < BATCH_SIZE) break;
    batchAfter = batch.at(-1)!.id;
  }

  const currentPage = page.slice(0, first);
  const runRows = currentPage.length === 0 ? [] : await prisma.workRun.findMany({
    where: { workId: { in: currentPage.map(({ id }) => id) }, work: scope, startedAt: { lt: end } },
    select: { workId: true, id: true, startedAt: true, endedAt: true },
  });
  const runs = new Map<string, typeof runRows>();
  for (const run of runRows) {
    const group = runs.get(run.workId);
    if (group) group.push(run);
    else runs.set(run.workId, [run]);
  }
  const last = currentPage.at(-1);
  const window = { start, end };
  return {
    definitionVersion: LATENCY_DEFINITION_VERSION,
    window,
    coverage,
    leadTime: latencyPercentiles(lead, acceptedCount, window),
    cycleTime: latencyPercentiles(cycle, acceptedCount, window),
    reviewWait: latencyPercentiles(review, acceptedCount, window),
    nodes: currentPage.map(({ id, identifier, replay }) => ({ id, identifier, ...replay, runs: runWallClock(runs.get(id) ?? [], end) })),
    pageInfo: {
      hasNextPage: page.length > first,
      endCursor: last ? Buffer.from(JSON.stringify({ id: last.id, scope: cursorScope })).toString('base64url') : null,
    },
  };
}
