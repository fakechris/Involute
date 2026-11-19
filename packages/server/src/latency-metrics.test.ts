import { describe, expect, it } from 'vitest';

import { latencyPercentiles, replayDeliveryLatency, runWallClock, type LatencyAudit, type LatencySnapshot } from './latency-metrics.js';

const HOUR = 3_600_000;
const at = (hours: number) => new Date(Date.UTC(2026, 2, 8, 4) + hours * HOUR);
const snapshot = (stateType: LatencySnapshot['stateType'], commitmentStatus: LatencySnapshot['commitmentStatus'] = 'COMMITTED', stateId = stateType): LatencySnapshot =>
  ({ stateType, stateId, commitmentStatus });
const candidate = snapshot('BACKLOG', 'CANDIDATE');
const todo = snapshot('UNSTARTED');
const started = snapshot('STARTED');
const review = snapshot('REVIEW');
const done = snapshot('COMPLETED');
const audit = (revision: number, hour: number, before: LatencySnapshot | null, after: LatencySnapshot, accepted = false): LatencyAudit =>
  ({ id: String(revision).padStart(3, '0'), revision, beforeRevision: before === null ? null : revision - 1, createdAt: at(hour), before, after, accepted });

describe('delivery latency replay', () => {
  it('distinguishes no history from a known acceptance lacking its start', () => {
    expect(replayDeliveryLatency([], at(10))).toEqual({ noHistory: true, episodes: [] });
    const partial = replayDeliveryLatency([audit(9, 3, review, done, true)], at(10));
    expect(partial).toMatchObject({ noHistory: false, episodes: [{
      start: 'UNKNOWN', outcome: 'ACCEPTED', historyGap: true, acceptedAt: at(3),
      leadTimeMs: null, cycleTimeMs: null, reviewWaitMs: null, ageMs: null,
    }] });
    expect(replayDeliveryLatency([audit(3, 1, null, started)], at(10)).episodes[0])
      .toMatchObject({ outcome: 'OPEN', ageMs: null, historyGap: true });
  });

  it('sums review spells, ignores repeated states, and deterministically orders tied IDs', () => {
    const secondReview = { ...review, stateId: 'second-review' };
    const rows = [
      audit(1, 0, null, candidate), audit(2, 1, candidate, todo), audit(3, 2, todo, started),
      audit(4, 3, started, review), audit(5, 4, review, secondReview), audit(6, 4, secondReview, secondReview),
      audit(7, 5, secondReview, started), audit(8, 6, started, review), audit(9, 7, review, done, true),
    ];
    const result = replayDeliveryLatency(rows, at(10));
    expect(replayDeliveryLatency([...rows].reverse().concat(rows[3], rows[8]), at(10))).toEqual(result);
    expect(result.episodes).toEqual([{
      start: 'COMMITTED', startedAt: at(1), acceptedAt: at(7), outcome: 'ACCEPTED', historyGap: false,
      leadTimeMs: 6 * HOUR, cycleTimeMs: 5 * HOUR, reviewWaitMs: 3 * HOUR, ageMs: null,
    }]);
  });

  it('preserves the first delivery on reopen and reports only age before the new acceptance', () => {
    const rows = [
      audit(1, 0, null, todo), audit(2, 1, todo, started), audit(3, 2, started, review),
      audit(4, 3, review, done, true), audit(5, 4, done, started), audit(6, 5, started, review),
      audit(7, 7, review, done, true),
    ];
    const beforeReopen = replayDeliveryLatency(rows, at(4)).episodes;
    const open = replayDeliveryLatency(rows, at(7)).episodes;
    const delivered = replayDeliveryLatency(rows, at(8)).episodes;
    expect(open).toHaveLength(2);
    expect(open[0]).toEqual(beforeReopen[0]);
    expect(delivered[0]).toEqual(beforeReopen[0]);
    expect(open[1]).toMatchObject({ start: 'REOPENED', outcome: 'OPEN', ageMs: 3 * HOUR,
      leadTimeMs: null, cycleTimeMs: null, reviewWaitMs: null, acceptedAt: null });
    expect(delivered[1]).toMatchObject({ start: 'REOPENED', outcome: 'ACCEPTED', ageMs: null,
      leadTimeMs: 3 * HOUR, cycleTimeMs: 3 * HOUR, reviewWaitMs: 2 * HOUR, acceptedAt: at(7) });
  });

  it('uses the first commitment and observed STARTED entry even when commitment was reversed', () => {
    const candidateStarted = snapshot('STARTED', 'CANDIDATE');
    const rows = [
      audit(1, 0, null, candidateStarted), audit(2, 1, candidateStarted, started),
      audit(3, 2, started, candidateStarted), audit(4, 3, candidateStarted, started),
      audit(5, 4, started, review), audit(6, 7, review, done, true),
    ];
    expect(replayDeliveryLatency(rows, at(8)).episodes).toEqual([{
      start: 'COMMITTED', startedAt: at(1), acceptedAt: at(7), outcome: 'ACCEPTED', historyGap: false,
      leadTimeMs: 6 * HOUR, cycleTimeMs: 7 * HOUR, reviewWaitMs: 3 * HOUR, ageMs: null,
    }]);
  });

  it('does not count Done without an acceptance or invent intervals across a missing audit', () => {
    const rows = [audit(1, 0, null, todo), audit(2, 1, todo, started), audit(4, 3, review, done)];
    expect(replayDeliveryLatency(rows, at(6)).episodes[0])
      .toMatchObject({ outcome: 'CLOSED', acceptedAt: null, historyGap: true, ageMs: null });
    expect(replayDeliveryLatency([rows[0], rows[1], { ...rows[2], accepted: true }], at(6)).episodes[0])
      .toMatchObject({ outcome: 'ACCEPTED', historyGap: true, leadTimeMs: null, cycleTimeMs: null, reviewWaitMs: null });
    expect(replayDeliveryLatency([audit(1, 0, null, todo), audit(2, 1, todo, done, true)], at(6)).episodes[0])
      .toMatchObject({ leadTimeMs: HOUR, cycleTimeMs: null, reviewWaitMs: 0 });
  });

  it('uses elapsed UTC time across local midnight and the DST jump', () => {
    const episode = replayDeliveryLatency([
      audit(1, 0, null, todo), audit(2, 1, todo, started), audit(3, 2, started, review), audit(4, 4, review, done, true),
    ], at(5)).episodes[0]!;
    const display = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    expect(display.format(episode.startedAt!)).toBe('07, 23:00');
    expect(display.format(episode.acceptedAt!)).toBe('08, 04:00');
    expect(episode).toMatchObject({ leadTimeMs: 4 * HOUR, cycleTimeMs: 3 * HOUR, reviewWaitMs: 2 * HOUR });
  });
});

describe('run wall clock and percentiles', () => {
  it('returns elapsed durations, overlap sum and union, not effort', () => {
    const run = (id: string, start: number, end: number | null) => ({ id, startedAt: at(start), endedAt: end === null ? null : at(end) });
    expect(runWallClock([run('c', 5, 6), run('b', 1, 4), run('a', 0, 3), run('d', 2, 1), run('e', 2, null), run('f', 7, 10), run('g', 10, 11)], at(10)))
      .toEqual({
        elapsed: [{ id: 'a', elapsedMs: 3 * HOUR }, { id: 'b', elapsedMs: 3 * HOUR }, { id: 'c', elapsedMs: HOUR },
          { id: 'd', elapsedMs: null }, { id: 'e', elapsedMs: null }, { id: 'f', elapsedMs: null }],
        wallClockSumMs: 7 * HOUR, wallClockUnionMs: 5 * HOUR, finishedCount: 3,
        unfinishedCount: 2, invalidCount: 1, humanActualWorkMs: null, agentActualComputeMs: null,
      });
    expect(runWallClock([], at(10))).toMatchObject({ wallClockSumMs: null, wallClockUnionMs: null, finishedCount: 0 });
  });

  it('uses the fifth and ninth values of ten hand-checkable samples and explains empty samples', () => {
    const window = { start: at(0), end: at(10) };
    const samples = [10, 3, 9, 8, 7, 6, 5, 4, 2, 1];
    expect(latencyPercentiles(samples, 12, window)).toEqual({
      p50Ms: 5, p90Ms: 9, sampleCount: 10, emptyReason: null, coverage: { acceptedCount: 12, missingCount: 2 }, window, definitionVersion: '1',
    });
    expect(latencyPercentiles([], 0, window)).toMatchObject({ p50Ms: null, p90Ms: null, sampleCount: 0, emptyReason: 'NO_ACCEPTED_EPISODES' });
    expect(latencyPercentiles([], 1, window)).toMatchObject({ p50Ms: null, p90Ms: null, sampleCount: 0, emptyReason: 'INSUFFICIENT_HISTORY' });
  });
});
