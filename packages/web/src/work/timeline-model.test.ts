import { describe, expect, it } from 'vitest';

import type { WorkflowStateType } from '../board/types';
import { buildOutline, type GraphNode } from './graph-model';
import {
  axisTicks,
  defaultZoom,
  containerSpan,
  cumulativeSeries,
  PX_PER_DAY,
  rangeWidth,
  spellsOf,
  timeRange,
  xFor,
  type TimelineEntry,
} from './timeline-model';

const day = (n: number) => new Date(Date.UTC(2026, 8, n));
const now = day(20);

function entry(workId: string, steps: Array<[number, WorkflowStateType]>, extra: Partial<TimelineEntry> = {}): TimelineEntry {
  const transitions = steps.map(([n, stateType]) => ({ at: day(n), stateType, stateName: stateType }));
  const firstInto = (types: WorkflowStateType[]) => transitions.find((t) => types.includes(t.stateType))?.at ?? null;
  const last = transitions.at(-1);
  return {
    workId,
    committedAt: transitions[0]?.at ?? null,
    startedAt: firstInto(['STARTED', 'REVIEW', 'COMPLETED']),
    reviewAt: firstInto(['REVIEW']),
    completedAt: last?.stateType === 'COMPLETED' ? last.at : null,
    canceledAt: last?.stateType === 'CANCELED' ? last.at : null,
    transitions,
    history: 'FULL',
    ...extra,
  };
}

function node(id: string, kind: GraphNode['kind'] = 'ISSUE'): GraphNode {
  return { id, identifier: id, title: id, kind, commitmentStatus: 'COMMITTED', stateName: 'x', stateType: 'UNSTARTED', assigneeName: null, external: false };
}

describe('time axis', () => {
  it('spans the earliest event to just after now, padded per zoom', () => {
    const range = timeRange([entry('a', [[5, 'UNSTARTED']]), entry('b', [[8, 'STARTED']])], now, 'day');
    expect(range.start).toEqual(day(4));
    expect(range.end).toEqual(day(22));
    expect(xFor(day(6), range, 'day')).toBe(2 * PX_PER_DAY.day);
    expect(rangeWidth(range, 'week')).toBe(18 * PX_PER_DAY.week);
  });

  it('marks Mondays as major day ticks and lists week and month starts', () => {
    const range = { start: day(1), end: day(30) };
    const dayTicks = axisTicks(range, 'day');
    expect(dayTicks).toHaveLength(30);
    expect(dayTicks.find((tick) => tick.at.getTime() === day(7).getTime())!.major).toBe(true); // 2026-09-07 is a Monday
    expect(axisTicks(range, 'week').map((tick) => tick.label)).toEqual(['Sep 7', 'Sep 14', 'Sep 21', 'Sep 28']);
    expect(axisTicks({ start: day(1), end: new Date(Date.UTC(2026, 10, 2)) }, 'month').map((tick) => tick.label)).toEqual([
      'Sep 2026',
      'Oct 2026',
      'Nov 2026',
    ]);
  });
});

describe('defaultZoom', () => {
  it('picks days, weeks or months from the recorded span', () => {
    expect(defaultZoom([entry('a', [[1, 'STARTED']])], now)).toBe('day');
    expect(defaultZoom([entry('a', [[1, 'STARTED']])], new Date(Date.UTC(2026, 11, 1)))).toBe('week');
    expect(defaultZoom([entry('a', [[1, 'STARTED']])], new Date(Date.UTC(2027, 8, 1)))).toBe('month');
  });
});

describe('spellsOf', () => {
  it('splits an item into stays per state, the current one open-ended', () => {
    const spells = spellsOf(entry('a', [[1, 'UNSTARTED'], [3, 'STARTED'], [6, 'REVIEW']]));
    expect(spells.map((spell) => [spell.stateType, spell.from.getUTCDate(), spell.to?.getUTCDate() ?? null])).toEqual([
      ['UNSTARTED', 1, 3],
      ['STARTED', 3, 6],
      ['REVIEW', 6, null],
    ]);
  });
});

describe('containerSpan', () => {
  const outline = buildOutline(
    [node('m', 'MILESTONE'), node('a'), node('b'), node('c')],
    [
      { id: '1', type: 'CONTAINS', fromId: 'm', toId: 'a' },
      { id: '2', type: 'CONTAINS', fromId: 'm', toId: 'b' },
      { id: '3', type: 'CONTAINS', fromId: 'm', toId: 'c' },
    ],
    'm',
  );
  const milestone = outline.roots[0]!;

  it('runs from the first start to now while any leaf is open', () => {
    const entries = new Map([
      ['a', entry('a', [[2, 'UNSTARTED'], [4, 'STARTED'], [9, 'COMPLETED']])],
      ['b', entry('b', [[3, 'STARTED']])],
      ['c', entry('c', [], { history: 'NONE' })],
    ]);
    expect(containerSpan(milestone, entries, now)).toEqual({ from: day(3), to: now, open: true, done: 1, total: 3 });
  });

  it('ends at the last finish once every leaf is closed', () => {
    const entries = new Map([
      ['a', entry('a', [[4, 'STARTED'], [9, 'COMPLETED']])],
      ['b', entry('b', [[5, 'STARTED'], [11, 'CANCELED']])],
      ['c', entry('c', [[6, 'STARTED'], [10, 'COMPLETED']])],
    ]);
    expect(containerSpan(milestone, entries, now)).toMatchObject({ from: day(4), to: day(11), open: false, done: 2 });
  });

  it('is null when no leaf has recorded history', () => {
    expect(containerSpan(milestone, new Map(), now)).toBeNull();
  });
});

describe('cumulativeSeries', () => {
  it('steps scope, started and completed from recorded events only', () => {
    const range = { start: day(1), end: day(20) };
    const series = cumulativeSeries(
      [
        entry('a', [[2, 'UNSTARTED'], [4, 'STARTED'], [9, 'COMPLETED']]),
        entry('b', [[2, 'UNSTARTED'], [5, 'STARTED'], [7, 'COMPLETED'], [8, 'STARTED']]),
        entry('c', [], { history: 'NONE' }),
      ],
      range,
    );
    const at = (n: number) => series.filter((point) => point.at.getTime() <= day(n).getTime()).at(-1)!;
    expect(at(3)).toMatchObject({ scope: 2, started: 0, completed: 0 });
    expect(at(6)).toMatchObject({ scope: 2, started: 2, completed: 0 });
    // b was done on the 7th but reopened, so only a counts as completed.
    expect(at(10)).toMatchObject({ scope: 2, started: 2, completed: 1 });
    expect(series.at(-1)!.at).toEqual(day(20));
  });
});
