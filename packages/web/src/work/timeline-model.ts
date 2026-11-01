/**
 * Pure model for the project timeline (INV-682): what actually happened to
 * each item, placed on a time axis. No planned dates exist, so nothing here
 * extrapolates — open work runs to "now" and stops there.
 *
 * The fact window (INV-1446) is a lens on a period of recorded facts, never a
 * plan: it picks the days the reader is looking at and never invents a date
 * the audit trail does not contain.
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

// ---------------------------------------------------------------------------
// Fact window (INV-1446)
// ---------------------------------------------------------------------------

/** The UTC days a reader is looking at, both ends inclusive. */
export interface FactWindow {
  from: Date;
  to: Date;
}

/** A `YYYY-MM-DD` UTC day, or null when the text is not a day. */
export function parseDay(value: string | null | undefined): Date | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  // Rejects 2026-02-31 and friends, which Date.UTC would roll over silently.
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date;
}

/** The `YYYY-MM-DD` form of a UTC day, for the URL. */
export function formatDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * The window the URL asks for, or null when the reader wants everything.
 * A window never reaches past today: there is no recorded fact in the future
 * to look at, and showing one would be a plan, not a fact.
 */
export function parseFactWindow(from: string | null, to: string | null, now: Date): FactWindow | null {
  const start = parseDay(from);
  const end = parseDay(to);
  if (!start && !end) return null;
  const today = startOfUtcDay(now);
  const resolvedTo = end && end.getTime() < today.getTime() ? end : today;
  const resolvedFrom = start ?? resolvedTo;
  if (resolvedFrom.getTime() > resolvedTo.getTime()) return null;
  return { from: resolvedFrom, to: resolvedTo };
}

/** The axis range of a window: its first day up to the day after its last. */
export function windowRange(window: FactWindow): TimeRange {
  return { start: window.from, end: new Date(window.to.getTime() + DAY_MS) };
}

/** The last instant of a window, exclusive. */
function windowEnd(window: FactWindow): number {
  return window.to.getTime() + DAY_MS;
}

/**
 * Every dated fact about an item: its state changes plus the milestone
 * stamps the server derives from them. The commitment is not a state change,
 * so it has to be asked for separately.
 */
export function factMoments(entry: TimelineEntry): number[] {
  const moments = entry.transitions.map((transition) => transition.at.getTime());
  for (const stamp of [entry.committedAt, entry.startedAt, entry.reviewAt, entry.completedAt, entry.canceledAt]) {
    if (stamp) moments.push(stamp.getTime());
  }
  return moments;
}

/** True when the item recorded something inside the window. */
export function entryInWindow(entry: TimelineEntry | undefined, window: FactWindow): boolean {
  if (!entry) return false;
  const start = window.from.getTime();
  const end = windowEnd(window);
  return factMoments(entry).some((at) => at >= start && at < end);
}

/** A spell with the part outside the window trimmed off. */
export interface DrawnSpell extends Spell {
  /** The left edge of the bar. */
  start: Date;
  /** The right edge of the bar, or null while the spell is still open. */
  end: Date | null;
  /** True when the moment that opened the spell falls inside the window. */
  beganInWindow: boolean;
}

/**
 * The spells of an item as they read inside a window: bars are trimmed to
 * the window, and a spell that opened before it keeps running to the window's
 * end — the item really was in that state for the whole period.
 */
export function spellsForWindow(entry: TimelineEntry, window: FactWindow | null): DrawnSpell[] {
  if (!window) {
    return spellsOf(entry).map((spell) => ({ ...spell, start: spell.from, end: spell.to, beganInWindow: true }));
  }
  const start = window.from.getTime();
  const end = windowEnd(window);
  return spellsOf(entry)
    .map((spell) => {
      const from = spell.from.getTime();
      const to = spell.to ? spell.to.getTime() : end;
      return {
        ...spell,
        start: new Date(Math.max(from, start)),
        end: new Date(Math.min(to, end)),
        beganInWindow: from >= start && from < end,
      };
    })
    .filter((spell) => spell.start.getTime() < end && spell.end.getTime() > start);
}

/** The day after a window's last day, exclusive. */
export function windowEndExclusive(window: FactWindow): Date {
  return new Date(window.to.getTime() + DAY_MS);
}

/**
 * The part of the window that predates every recorded fact. Nothing is drawn
 * there: the reader is told the history does not reach that far.
 */
export function coverageGap(entries: TimelineEntry[], window: FactWindow): { from: Date; to: Date } | null {
  let earliest: number | null = null;
  for (const entry of entries) {
    const first = entry.committedAt ?? entry.transitions[0]?.at ?? null;
    if (!first) continue;
    const at = first.getTime();
    if (earliest === null || at < earliest) earliest = at;
  }
  // The window opens before the history does: the stretch in between has no facts.
  if (earliest === null || earliest <= window.from.getTime()) return null;
  return { from: window.from, to: new Date(earliest) };
}

/**
 * The progress series inside a window. The first point carries what was
 * already true when the window opened: a window is a lens on a project that
 * was already running, so the scope line does not restart at zero.
 */
export function cumulativeSeriesInWindow(entries: TimelineEntry[], window: FactWindow): CumulativePoint[] {
  const start = window.from.getTime();
  const end = windowEnd(window);
  const events: Array<{ at: number; key: 'scope' | 'started' | 'completed' }> = [];
  for (const entry of entries) {
    if (entry.history === 'NONE') continue;
    const scopeAt = entry.committedAt ?? entry.transitions[0]?.at ?? null;
    if (scopeAt) events.push({ at: scopeAt.getTime(), key: 'scope' });
    if (entry.startedAt) events.push({ at: entry.startedAt.getTime(), key: 'started' });
    if (entry.completedAt) events.push({ at: entry.completedAt.getTime(), key: 'completed' });
  }
  events.sort((left, right) => left.at - right.at);
  const counts = { scope: 0, started: 0, completed: 0 };
  // What was already true when the window opened.
  for (const event of events) {
    if (event.at >= start) break;
    counts[event.key] += 1;
  }
  const points: CumulativePoint[] = [{ at: window.from, ...counts }];
  for (const event of events) {
    if (event.at < start) continue;
    if (event.at >= end) break;
    counts[event.key] += 1;
    const last = points.at(-1)!;
    if (last.at.getTime() === event.at) Object.assign(last, counts);
    else points.push({ at: new Date(event.at), ...counts });
  }
  points.push({ at: new Date(end), ...counts });
  return points;
}

/**
 * The outline as it reads inside a window: an item stays when it recorded
 * something in that window, and a container stays when one of its children
 * does. Items with nothing in the window drop out of the tree entirely.
 */
export function filterOutlineByWindow(
  items: OutlineItem[],
  entries: Map<string, TimelineEntry>,
  window: FactWindow,
): OutlineItem[] {
  const keep = (item: OutlineItem): OutlineItem | null => {
    const children = item.children.map(keep).filter((child): child is OutlineItem => child !== null);
    const self = entryInWindow(entries.get(item.node.id), window);
    if (!self && children.length === 0) return null;
    return { ...item, children };
  };
  return items.map(keep).filter((item): item is OutlineItem => item !== null);
}

/** The scale that fits a window, so a short window is not squeezed into month ticks. */
export function zoomForWindow(window: FactWindow): TimelineZoom {
  const days = (window.to.getTime() - window.from.getTime()) / DAY_MS + 1;
  return days <= 45 ? 'day' : days <= 200 ? 'week' : 'month';
}

export type WindowPreset = 'all' | '7d' | '30d' | 'month' | 'custom';

export const WINDOW_PRESETS: ReadonlyArray<{ id: WindowPreset; label: string }> = [
  { id: 'all', label: 'All time' },
  { id: '7d', label: 'Last 7 days' },
  { id: '30d', label: 'Last 30 days' },
  { id: 'month', label: 'This month' },
  { id: 'custom', label: 'Custom' },
];

/** The window a preset stands for, or null for "all time". */
export function windowForPreset(preset: WindowPreset, now: Date): FactWindow | null {
  if (preset === 'all' || preset === 'custom') return null;
  const today = startOfUtcDay(now);
  if (preset === '7d') return { from: new Date(today.getTime() - 6 * DAY_MS), to: today };
  if (preset === '30d') return { from: new Date(today.getTime() - 29 * DAY_MS), to: today };
  return { from: new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1)), to: today };
}

/** The preset a window matches, so a shared link reopens on the same control. */
export function presetForWindow(window: FactWindow | null, now: Date): WindowPreset {
  if (!window) return 'all';
  for (const preset of ['7d', '30d', 'month'] as const) {
    const candidate = windowForPreset(preset, now);
    if (candidate && candidate.from.getTime() === window.from.getTime() && candidate.to.getTime() === window.to.getTime()) {
      return preset;
    }
  }
  return 'custom';
}
