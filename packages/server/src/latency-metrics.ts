import type { CommitmentStatus, WorkflowStateType } from '@prisma/client';

export const LATENCY_DEFINITION_VERSION = '1';

export interface LatencySnapshot {
  commitmentStatus: CommitmentStatus | null;
  stateId: string | null;
  stateType: WorkflowStateType | null;
}

export interface LatencyAudit {
  id: string;
  revision: number;
  beforeRevision: number | null;
  createdAt: Date;
  before: LatencySnapshot | null;
  after: LatencySnapshot;
  accepted: boolean;
}

export interface LatencyRun {
  id: string;
  startedAt: Date;
  endedAt: Date | null;
}

type EpisodeStart = 'COMMITTED' | 'REOPENED' | 'UNKNOWN';
type EpisodeOutcome = 'ACCEPTED' | 'OPEN' | 'CLOSED' | 'UNKNOWN';
export interface DeliveryEpisode {
  start: EpisodeStart;
  startedAt: Date | null;
  acceptedAt: Date | null;
  outcome: EpisodeOutcome;
  historyGap: boolean;
  leadTimeMs: number | null;
  cycleTimeMs: number | null;
  reviewWaitMs: number | null;
  ageMs: number | null;
}

interface Episode {
  start: EpisodeStart;
  anchor: number | null;
  observedCommitment: boolean;
  firstStarted: number | null;
  reviewSince: number | null;
  reviewTotal: number;
  historyGap: boolean;
}

const terminal = (state: WorkflowStateType | null) => state === 'COMPLETED' || state === 'CANCELED';

function newEpisode(start: EpisodeStart = 'UNKNOWN', anchor: number | null = null): Episode {
  return { start, anchor, observedCommitment: anchor !== null, firstStarted: null, reviewSince: null, reviewTotal: 0, historyGap: false };
}

function finish(episode: Episode, outcome: EpisodeOutcome, at: number): DeliveryEpisode {
  const { start, anchor, firstStarted, reviewSince, historyGap, reviewTotal } = episode;
  const accepted = outcome === 'ACCEPTED';
  return {
    start,
    startedAt: anchor === null ? null : new Date(anchor),
    acceptedAt: accepted ? new Date(at) : null,
    outcome,
    historyGap,
    leadTimeMs: accepted && anchor !== null && !historyGap ? at - anchor : null,
    cycleTimeMs: accepted && firstStarted !== null && !historyGap ? at - firstStarted : null,
    reviewWaitMs: accepted && anchor !== null && !historyGap ? reviewTotal + (reviewSince === null ? 0 : at - reviewSince) : null,
    ageMs: outcome === 'OPEN' && anchor !== null && !historyGap ? at - anchor : null,
  };
}

export function replayDeliveryLatency(audits: readonly LatencyAudit[], end: Date) {
  const endAt = end.getTime();
  const ordered = audits.filter((row) => row.createdAt.getTime() < endAt)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const episodes: DeliveryEpisode[] = [];
  const seen = new Set<string>();
  const recordedRevisions = new Set(ordered.filter(({ revision, beforeRevision }) => revision !== beforeRevision).map(({ revision }) => revision));
  let previous: LatencyAudit | undefined;
  let episode: Episode | undefined;
  for (const row of ordered) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    const { before, after } = row;
    if (previous?.revision === row.revision && previous.after.stateId === after.stateId && previous.after.commitmentStatus === after.commitmentStatus) continue;
    const at = row.createdAt.getTime();
    const creation = before === null && row.revision === 1;
    const committed = after.commitmentStatus === 'COMMITTED';
    const commit = committed && (creation || (before?.commitmentStatus != null && before.commitmentStatus !== 'COMMITTED'));
    const reopen = committed && !commit && terminal(before?.stateType ?? null) && after.stateType !== null && !terminal(after.stateType);
    const transition = creation || (before?.stateId != null && before.stateId !== after.stateId);
    const missingPredecessor = !creation && (row.beforeRevision === null || !recordedRevisions.has(row.beforeRevision));
    if (!transition && before !== null && before.stateId === after.stateId
      && before.commitmentStatus === after.commitmentStatus && !missingPredecessor) continue;
    const gap = missingPredecessor || (previous !== undefined &&
      (previous.after.stateId !== before?.stateId || previous.after.commitmentStatus !== before?.commitmentStatus));
    const unknownState = after.stateType === null || (!creation && before?.stateType == null);
    const wasTerminal = terminal(previous?.after.stateType ?? before?.stateType ?? null);
    previous = row;
    if (reopen) {
      if (episode?.observedCommitment) episodes.push(finish(episode, 'CLOSED', at));
      episode = newEpisode('REOPENED', at);
    } else if (!episode && (commit || episodes.length === 0 || (gap && (!wasTerminal || !terminal(after.stateType))))) {
      episode = newEpisode();
    }
    if (!episode) continue;
    if (!reopen && (gap || unknownState || after.commitmentStatus === null)) episode.historyGap = true;
    if (commit && !episode.observedCommitment) {
      episode.anchor = at;
      episode.start = 'COMMITTED';
    }
    episode.observedCommitment ||= committed || after.commitmentStatus === null;
    if (after.stateType === 'STARTED' && transition && before?.stateType !== 'STARTED') {
      episode.firstStarted ??= at;
    }
    if (transition && before?.stateType !== after.stateType) {
      if (episode.reviewSince !== null && after.stateType !== 'REVIEW') {
        episode.reviewTotal += at - episode.reviewSince;
        episode.reviewSince = null;
      } else if (after.stateType === 'REVIEW') {
        episode.reviewSince ??= at;
      }
    }
    if (committed && row.accepted && transition && before?.stateType !== 'COMPLETED' && after.stateType === 'COMPLETED') {
      episodes.push(finish(episode, 'ACCEPTED', at));
      episode = undefined;
    }
  }
  if (episode?.observedCommitment) {
    const state = previous?.after.stateType ?? null;
    const commitment = previous?.after.commitmentStatus ?? null;
    episodes.push(finish(episode, state === null || commitment === null ? 'UNKNOWN' : terminal(state) || commitment !== 'COMMITTED' ? 'CLOSED' : 'OPEN', endAt));
  }
  return { noHistory: ordered.length === 0, episodes };
}

export function runWallClock(runs: readonly LatencyRun[], end: Date) {
  const endAt = end.getTime();
  const intervals: { start: number; end: number }[] = [];
  const elapsed: { id: string; elapsedMs: number | null }[] = [];
  let unfinishedCount = 0;
  let invalidCount = 0;
  for (const run of [...runs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const start = run.startedAt.getTime();
    const finish = run.endedAt?.getTime();
    if (start >= endAt) continue;
    if (!Number.isFinite(start) || (finish !== undefined && (!Number.isFinite(finish) || finish < start))) {
      invalidCount++;
      elapsed.push({ id: run.id, elapsedMs: null });
    } else if (finish === undefined || finish >= endAt) {
      unfinishedCount++;
      elapsed.push({ id: run.id, elapsedMs: null });
    } else {
      intervals.push({ start, end: finish });
      elapsed.push({ id: run.id, elapsedMs: finish - start });
    }
  }
  intervals.sort((a, b) => a.start - b.start);
  let sum = 0;
  let union = 0;
  let latestEnd = -Infinity;
  for (const interval of intervals) {
    sum += interval.end - interval.start;
    union += Math.max(0, interval.end - Math.max(interval.start, latestEnd));
    latestEnd = Math.max(latestEnd, interval.end);
  }
  return {
    elapsed,
    wallClockSumMs: intervals.length ? sum : null,
    wallClockUnionMs: intervals.length ? union : null,
    finishedCount: intervals.length,
    unfinishedCount,
    invalidCount,
    humanActualWorkMs: null,
    agentActualComputeMs: null,
  };
}

export interface LatencyWindow { start: Date; end: Date }

export function latencyPercentiles(samples: number[], acceptedCount: number, window: LatencyWindow) {
  const ordered = [...samples].sort((a, b) => a - b);
  const sampleCount = ordered.length;
  const nearestRank = (p: number) => ordered[Math.ceil(p * sampleCount) - 1] ?? null;
  return {
    p50Ms: nearestRank(0.5),
    p90Ms: nearestRank(0.9),
    sampleCount,
    emptyReason: sampleCount ? null : acceptedCount ? 'INSUFFICIENT_HISTORY' : 'NO_ACCEPTED_EPISODES',
    coverage: { acceptedCount, missingCount: acceptedCount - sampleCount },
    window,
    definitionVersion: LATENCY_DEFINITION_VERSION,
  };
}
