/**
 * Pure model for the project timeline (INV-682): what actually happened to
 * each item, placed on a time axis. No planned dates exist, so nothing here
 * extrapolates — open work runs to "now" and stops there.
 */

import type { WorkflowStateType } from '../board/types';
import type { OutlineItem } from './graph-model';

export type HistoryCompleteness = 'FULL' | 'PARTIAL' | 'NONE';

export interface TimelineTransition {
  at: Date;
  stateName: string;
  stateType: WorkflowStateType;
}

export interface TimelineEntry {
  workId: string;
  committedAt: Date | null;
  startedAt: Date | null;
  reviewAt: Date | null;
  completedAt: Date | null;
  canceledAt: Date | null;
  transitions: TimelineTransition[];
  history: HistoryCompleteness;
}

export type TimelineZoom = 'day' | 'week' | 'month';

/** A scale that fits the recorded span: days for about six weeks, weeks for half a year, else months. */
export function defaultZoom(entries: TimelineEntry[], now: Date): TimelineZoom {
  const range = timeRange(entries, now, 'day');
  const days = (range.end.getTime() - range.start.getTime()) / DAY_MS;
  return days <= 45 ? 'day' : days <= 200 ? 'week' : 'month';
}

export const PX_PER_DAY: Record<TimelineZoom, number> = { day: 32, week: 10, month: 3 };
const DAY_MS = 24 * 60 * 60 * 1000;

export interface TimeRange {
  start: Date;
  end: Date;
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/** From the earliest recorded moment to now, padded so edges are not flush. */
export function timeRange(entries: TimelineEntry[], now: Date, zoom: TimelineZoom): TimeRange {
  let earliest = now.getTime();
  for (const entry of entries) {
    for (const candidate of [entry.committedAt, entry.transitions[0]?.at ?? null]) {
      if (candidate && candidate.getTime() < earliest) earliest = candidate.getTime();
    }
  }
  const pad = zoom === 'day' ? 1 : zoom === 'week' ? 3 : 10;
  return {
    start: startOfUtcDay(new Date(earliest - pad * DAY_MS)),
    end: startOfUtcDay(new Date(now.getTime() + (pad + 1) * DAY_MS)),
  };
}

export function xFor(date: Date, range: TimeRange, zoom: TimelineZoom): number {
  return ((date.getTime() - range.start.getTime()) / DAY_MS) * PX_PER_DAY[zoom];
}

export function rangeWidth(range: TimeRange, zoom: TimelineZoom): number {
  return xFor(range.end, range, zoom);
}

export interface Spell {
  stateType: WorkflowStateType;
  stateName: string;
  from: Date;
  /** Null while the item is still in this state. */
  to: Date | null;
}

/** Consecutive stays in each state, the last one open-ended unless it is Done / Canceled. */
export function spellsOf(entry: TimelineEntry): Spell[] {
  return entry.transitions.map((transition, index) => {
    const next = entry.transitions[index + 1];
    return {
      stateType: transition.stateType,
      stateName: transition.stateName,
      from: transition.at,
      to: next ? next.at : null,
    };
  });
}

export interface ContainerSpan {
  from: Date;
  to: Date;
  /** True while any descendant is still open, so the span runs to now. */
  open: boolean;
  done: number;
  total: number;
}

/** What a subtree contributes to its container: first start, last finish, how much is left. */
interface SpanAggregate {
  from: number | null;
  to: number | null;
  open: boolean;
  done: number;
  total: number;
}

const EMPTY_AGGREGATE: SpanAggregate = { from: null, to: null, open: false, done: 0, total: 0 };

/** One leaf's contribution. A leaf without recorded history counts as work but has no dates. */
function aggregateOf(entry: TimelineEntry | undefined): SpanAggregate {
  if (!entry || entry.history === 'NONE') return { ...EMPTY_AGGREGATE, total: 1 };
  const begin = entry.startedAt ?? entry.committedAt ?? entry.transitions[0]?.at ?? null;
  const finish = entry.completedAt ?? entry.canceledAt;
  return {
    from: begin ? begin.getTime() : null,
    to: finish ? finish.getTime() : null,
    open: !finish,
    done: entry.completedAt ? 1 : 0,
    total: 1,
  };
}

/** Two subtrees side by side: the earliest start, the latest finish, how much is left open. */
function mergeAggregates(left: SpanAggregate, right: SpanAggregate): SpanAggregate {
  return {
    from: left.from === null ? right.from : right.from === null ? left.from : Math.min(left.from, right.from),
    to: left.to === null ? right.to : right.to === null ? left.to : Math.max(left.to, right.to),
    open: left.open || right.open,
    done: left.done + right.done,
    total: left.total + right.total,
  };
}

/** A subtree's aggregate as a drawn span: null when nothing in it has dates. */
function spanOf(aggregate: SpanAggregate, now: Date): ContainerSpan | null {
  if (aggregate.from === null) return null;
  const end = aggregate.open ? now.getTime() : aggregate.to ?? now.getTime();
  return {
    from: new Date(aggregate.from),
    to: new Date(Math.max(end, aggregate.from)),
    open: aggregate.open,
    done: aggregate.done,
    total: aggregate.total,
  };
}

/** Container extent from its leaves: first commitment/start to last finish (or now). */
export function containerSpan(item: OutlineItem, entries: Map<string, TimelineEntry>, now: Date): ContainerSpan | null {
  let aggregate = EMPTY_AGGREGATE;
  const visit = (node: OutlineItem) => {
    if (node.children.length > 0) {
      node.children.forEach(visit);
      return;
    }
    aggregate = mergeAggregates(aggregate, aggregateOf(entries.get(node.node.id)));
  };
  visit(item);
  return spanOf(aggregate, now);
}

/**
 * Every container's extent in one pass, bottom-up. `containerSpan` walks a
 * container's whole subtree again per container, which is quadratic in a deep
 * outline; here each leaf is visited once and every container reuses its
 * children's aggregate. Only containers get an extent — a leaf has none of its
 * own to draw, it only feeds the container above it.
 */
export function containerSpans(
  items: OutlineItem[],
  entries: Map<string, TimelineEntry>,
  now: Date,
): Map<string, ContainerSpan | null> {
  const spans = new Map<string, ContainerSpan | null>();
  const visit = (item: OutlineItem): SpanAggregate => {
    if (item.children.length === 0) {
      return aggregateOf(entries.get(item.node.id));
    }
    let aggregate = EMPTY_AGGREGATE;
    for (const child of item.children) aggregate = mergeAggregates(aggregate, visit(child));
    spans.set(item.node.id, spanOf(aggregate, now));
    return aggregate;
  };
  for (const item of items) visit(item);
  return spans;
}

export interface CumulativePoint {
  at: Date;
  scope: number;
  started: number;
  completed: number;
}

/**
 * Scope / started / completed as step series (Linear's project graph, but
 * from recorded events only). Completed counts the current Done spell, so a
 * reopened item leaves the completed line again.
 */
export function cumulativeSeries(entries: TimelineEntry[], range: TimeRange): CumulativePoint[] {
  const events: Array<{ at: number; key: 'scope' | 'started' | 'completed' }> = [];
  for (const entry of entries) {
    if (entry.history === 'NONE') continue;
    const scopeAt = entry.committedAt ?? entry.transitions[0]?.at ?? null;
    if (scopeAt) events.push({ at: scopeAt.getTime(), key: 'scope' });
    if (entry.startedAt) events.push({ at: entry.startedAt.getTime(), key: 'started' });
    if (entry.completedAt) events.push({ at: entry.completedAt.getTime(), key: 'completed' });
  }
  events.sort((left, right) => left.at - right.at);
  const points: CumulativePoint[] = [{ at: range.start, scope: 0, started: 0, completed: 0 }];
  const counts = { scope: 0, started: 0, completed: 0 };
  for (const event of events) {
    counts[event.key] += 1;
    const last = points.at(-1)!;
    if (last.at.getTime() === event.at) Object.assign(last, counts);
    else points.push({ at: new Date(event.at), ...counts });
  }
  points.push({ at: range.end, ...counts });
  return points;
}

export interface Tick {
  at: Date;
  label: string;
  major: boolean;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Axis ticks: days (major on Mondays), weeks starting Monday, or month starts. */
export function axisTicks(range: TimeRange, zoom: TimelineZoom): Tick[] {
  const ticks: Tick[] = [];
  const cursor = new Date(range.start);
  while (cursor.getTime() <= range.end.getTime()) {
    const day = cursor.getUTCDate();
    const month = MONTHS[cursor.getUTCMonth()]!;
    if (zoom === 'day') {
      ticks.push({ at: new Date(cursor), label: String(day), major: cursor.getUTCDay() === 1 || day === 1 });
    } else if (zoom === 'week' && cursor.getUTCDay() === 1) {
      ticks.push({ at: new Date(cursor), label: `${month} ${day}`, major: day <= 7 });
    } else if (zoom === 'month' && day === 1) {
      ticks.push({ at: new Date(cursor), label: `${month} ${cursor.getUTCFullYear()}`, major: cursor.getUTCMonth() === 0 });
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return ticks;
}
