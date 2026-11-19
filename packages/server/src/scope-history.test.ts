import { describe, expect, it } from 'vitest';
import { localDayStart, replayMilestoneScope, scopeWindow, type ScopeAudit, type ScopeSnapshot } from './scope-history.js';

const at = (day: number, hour = 12) => new Date(Date.UTC(2026, 0, day, hour));
const state = (parentId: string | null = 'm', stateId = 'todo', commitmentStatus = 'COMMITTED', kind = 'ISSUE'): ScopeSnapshot => ({ parentId, stateId, commitmentStatus, kind });
const states = new Map([['todo', 'UNSTARTED'], ['done', 'COMPLETED'], ['cancel', 'CANCELED']] as const);
function audit(id: string, workId: string, day: number, before: ScopeSnapshot | null, after: ScopeSnapshot, surface = 'graphql'): ScopeAudit {
  return { id, workId, createdAt: at(day), before, after, surface, actorKind: 'HUMAN', actorId: 'actor', reason: 'fixture' };
}
function replay(audits: ScopeAudit[], overrides: Partial<Parameters<typeof replayMilestoneScope>[0]> = {}) {
  return replayMilestoneScope({ milestoneId: 'm', works: [...new Set(audits.map(a => a.workId))].map(id => ({ id, identifier: id })), audits, states,
    from: '2026-01-01', to: '2026-01-07', now: at(20), ...overrides });
}
const values = (r: ReturnType<typeof replay>) => r.points.map(p => [p.scope, p.remaining]);

describe('milestone scope replay', () => {
  it('replays add, complete, cancel, reopen, uncommit and remove without rewriting earlier days', () => {
    const a = state(), b = state(null);
    const rows = [audit('a0', 'a', 1, null, a), audit('b0', 'b', 1, null, b), audit('b1', 'b', 2, b, state()),
      audit('a1', 'a', 3, a, state('m', 'done')), audit('b2', 'b', 4, state(), state('m', 'cancel')),
      audit('a2', 'a', 5, state('m', 'done'), a), audit('b3', 'b', 5, state('m', 'cancel'), state()),
      audit('b4', 'b', 6, state(), state('m', 'todo', 'CANDIDATE')), audit('a3', 'a', 7, a, state(null))];
    const result = replay(rows);
    expect(values(result)).toEqual([[1, 1], [2, 2], [2, 1], [1, 0], [2, 2], [1, 1], [0, 0]]);
    expect(result.events.map(e => e.type)).toEqual(expect.arrayContaining(['ADD', 'REMOVE', 'COMMIT', 'UNCOMMIT', 'COMPLETE', 'CANCEL', 'REOPEN']));
    expect(replay(rows)).toEqual(result);
    expect(replay([...rows].reverse())).toEqual(result);
    expect(replay([...rows, rows[0]!])).toEqual(result);
    expect(values(replay(rows.slice(0, -1))).slice(0, 6)).toEqual(values(result).slice(0, 6));
    expect(replay([...rows, audit('future', 'future', 10, null, state())])).toEqual(result);
  });

  it('moves descendants with their epic, excludes containers but counts ISSUE subissues', () => {
    const epic = state('elsewhere', 'todo', 'COMMITTED', 'EPIC');
    const rows = [audit('e0', 'e', 1, null, epic), audit('a0', 'a', 1, null, state('e')), audit('b0', 'b', 1, null, state('a')),
      audit('e1', 'e', 2, epic, { ...epic, parentId: 'm' }), audit('e2', 'e', 4, { ...epic, parentId: 'm' }, epic)];
    const result = replay(rows, { to: '2026-01-04' });
    expect(values(result)).toEqual([[0, 0], [2, 2], [2, 2], [0, 0]]);
    expect(result.events.filter(e => e.source.auditId === 'e1').map(e => [e.workId, e.type])).toEqual([['a', 'ADD'], ['b', 'ADD']]);
  });

  it('flags a late repair at recorded time and nulls the discontinuous interval', () => {
    const result = replay([audit('a0', 'a', 1, null, state()), audit('a1', 'a', 4, state(null), state('m', 'done'), 'graph-migration')]);
    expect(values(result)).toEqual([[null, null], [null, null], [null, null], [1, 0], [1, 0], [1, 0], [1, 0]]);
    expect(result.coverage).toMatchObject({ status: 'PARTIAL', baseline: at(4), backfilledEventCount: 1, gaps: [{ start: at(1), end: at(4), workId: 'a', reason: 'DISCONTINUITY' }] });
    expect(result.events.at(-1)).toMatchObject({ effectiveAt: at(4), recordedAt: at(4), backfilled: true, source: { auditId: 'a1', surface: 'graph-migration', reason: 'fixture' } });
  });

  it('reports no history and partial history without guessing current membership', () => {
    const missing = replay([], { works: [{ id: 'a', identifier: 'a' }] });
    expect(missing.coverage).toMatchObject({ status: 'NONE', baseline: null, unknownWorkCount: 1, gaps: [{ start: null, end: null, workId: 'a', reason: 'NO_HISTORY' }] });
    expect(missing.emptyReason).toBe('NO_HISTORY');
    expect(values(missing)).toEqual(Array(7).fill([null, null]));
    const partial = replay([audit('a1', 'a', 3, state(), state('m', 'done'))]);
    expect(values(partial)).toEqual([[null, null], [null, null], [1, 0], [1, 0], [1, 0], [1, 0], [1, 0]]);
    expect(partial.coverage).toMatchObject({ status: 'PARTIAL', baseline: at(3) });
    expect(replay([]).emptyReason).toBe('NO_MEMBERS');
  });

  it('uses exclusive local day ends, DST days and future nulls', () => {
    const rows = [audit('a0', 'a', 1, null, state()), { ...audit('a1', 'a', 2, state(), state('m', 'done')), createdAt: at(2, 17) }];
    expect(values(replay(rows, { to: '2026-01-03' }))).toEqual([[1, 1], [1, 0], [1, 0]]);
    expect(values(replay(rows, { to: '2026-01-03', timeZone: 'Asia/Shanghai' }))).toEqual([[1, 1], [1, 1], [1, 0]]);
    expect(localDayStart('2026-03-09', 'America/New_York').getTime() - localDayStart('2026-03-08', 'America/New_York').getTime()).toBe(23 * 3600000);
    expect(localDayStart('2026-11-02', 'America/New_York').getTime() - localDayStart('2026-11-01', 'America/New_York').getTime()).toBe(25 * 3600000);
    const dstRows = [
      { ...rows[0]!, createdAt: new Date('2026-03-06T12:00:00Z') },
      { ...rows[1]!, createdAt: new Date('2026-03-08T07:00:00Z') },
    ];
    expect(values(replay(dstRows, { from: '2026-03-07', to: '2026-03-09', timeZone: 'America/New_York', now: new Date('2026-03-11T00:00:00Z') }))).toEqual([[1, 1], [1, 0], [1, 0]]);
    const boundary = { ...rows[1]!, createdAt: at(3, 0) };
    expect(values(replay([rows[0]!, boundary], { to: '2026-01-03', now: at(3, 12) }))).toEqual([[1, 1], [1, 1], [null, null]]);
  });

  it('only draws an explicit ideal reference with a known anchor', () => {
    const rows = [audit('a0', 'a', 1, null, state()), audit('b0', 'b', 1, null, state())];
    const result = replay(rows, { idealStart: '2026-01-02', idealEnd: '2026-01-04' });
    expect(result.ideal?.kind).toBe('REFERENCE');
    expect(result.points.map(p => p.ideal)).toEqual([2, 1, 0, null, null, null, null]);
    expect(replay(rows, { idealStart: '2026-01-02' }).ideal).toBeNull();
    expect(replay(rows, { idealEnd: '2026-01-04' }).ideal).toBeNull();
    expect(replay(rows, { idealStart: '2026-01-01', idealEnd: '2026-01-04' }).ideal).toBeNull();
  });

  it('opens unknown-state gaps until the next mapped observation', () => {
    const result = replay([audit('a0', 'a', 1, null, state()), audit('a1', 'a', 3, state(), state('m', 'missing')),
      audit('a2', 'a', 5, state('m', 'missing'), state())]);
    expect(values(result)).toEqual([[null, null], [null, null], [null, null], [null, null], [1, 1], [1, 1], [1, 1]]);
  });

  it('rejects invalid dates, window lengths, zones and reversed ideal dates', () => {
    for (const patch of [{ from: '2026-02-30' }, { to: '2025-01-01' }, { to: '2027-01-02' }, { timeZone: 'not/a-zone' }, { idealStart: '2026-01-03', idealEnd: '2026-01-02' }]) {
      expect(() => scopeWindow({ from: '2026-01-01', to: '2026-01-07', ...patch })).toThrow();
    }
  });
});
