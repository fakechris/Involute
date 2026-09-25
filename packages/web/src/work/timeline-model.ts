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

/** Container extent from its leaves: first commitment/start to last finish (or now). */
export function containerSpan(item: OutlineItem, entries: Map<string, TimelineEntry>, now: Date): ContainerSpan | null {
  let from: number | null = null;
  let to: number | null = null;
  let open = false;
  let done = 0;
  let total = 0;
  const visit = (node: OutlineItem) => {
    if (node.children.length > 0) {
      node.children.forEach(visit);
      return;
    }
    total += 1;
    const entry = entries.get(node.node.id);
    if (!entry || entry.history === 'NONE') return;
    const begin = entry.startedAt ?? entry.committedAt ?? entry.transitions[0]?.at ?? null;
    if (begin && (from === null || begin.getTime() < from)) from = begin.getTime();
    const finish = entry.completedAt ?? entry.canceledAt;
    if (entry.completedAt) done += 1;
    if (finish) {
      if (to === null || finish.getTime() > to) to = finish.getTime();
    } else {
      open = true;
    }
  };
  visit(item);
  if (from === null) return null;
  const end = open ? now.getTime() : to ?? now.getTime();
  return { from: new Date(from), to: new Date(Math.max(end, from)), open, done, total };
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
