import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';

import { buildBlockerIndex, type GraphEdge, type GraphNode, type Outline, type OutlineItem } from '../../work/graph-model';
import {
  axisTicks,
  containerSpans,
  cumulativeSeries,
  rangeWidth,
  spellsOf,
  timeRange,
  xFor,
  type ContainerSpan,
  type TimelineEntry,
  type TimelineZoom,
} from '../../work/timeline-model';
import { StatusIcon } from '../StatusIcon';
import { STATE_TYPE_COLOR } from './graph-colors';
import { Select } from '../controls';

export interface TimelineCycle {
  id: string;
  name: string;
  number: number;
  startsAt: Date;
  endsAt: Date;
}

interface ProjectTimelineProps {
  outline: Outline;
  edges: GraphEdge[];
  byId: Map<string, GraphNode>;
  entries: Map<string, TimelineEntry>;
  cycles: TimelineCycle[];
  zoom: TimelineZoom;
  onZoomChange: (zoom: TimelineZoom) => void;
  onOpen: (id: string) => void;
  now?: Date;
}

const LABEL_WIDTH = 300;
const ROW_HEIGHT = 30;
const CHART_HEIGHT = 96;
const AXIS_HEIGHT = 26;
const AXIS_HEIGHT_WITH_CYCLES = 44;
/** Past this many rows the viewport renders only the rows it can show (INV-1444). */
const VIRTUALIZE_ABOVE = 150;
/** Rows kept above and below the visible window so scrolling does not tear. */
const OVERSCAN = 12;
/** Viewport height used before it has been measured (hidden panel, test renderer). */
const FALLBACK_VIEWPORT_HEIGHT = 1200;

const DAY_FORMAT = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const fmt = (date: Date | null) => (date ? DAY_FORMAT.format(date) : '—');

/** Shared so an unblocked row keeps the same reference across renders. */
const NO_BLOCKERS: GraphNode[] = [];

interface FlatRow {
  item: OutlineItem;
  depth: number;
}

function flatten(items: OutlineItem[], collapsed: Set<string>, depth = 0, out: FlatRow[] = []): FlatRow[] {
  for (const item of items) {
    out.push({ item, depth });
    if (item.children.length && !collapsed.has(item.node.id)) flatten(item.children, collapsed, depth + 1, out);
  }
  return out;
}

/**
 * What actually happened to each item, on a time axis (INV-682). Rows follow
 * the outline; bars are the recorded stays in each state. There are no
 * planned dates, so open work stops at today and nothing is projected.
 */
export function ProjectTimeline({ outline, edges, byId, entries, cycles, zoom, onZoomChange, onOpen, now: nowProp }: ProjectTimelineProps) {
  // One "now" per mount, so the axis does not shift under the reader on every render.
  const [now] = useState(() => nowProp ?? new Date());
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const allEntries = useMemo(() => [...entries.values()], [entries]);
  const range = useMemo(() => timeRange(allEntries, now, zoom), [allEntries, now, zoom]);
  const width = rangeWidth(range, zoom);
  const ticks = useMemo(() => axisTicks(range, zoom), [range, zoom]);
  // Progress counts work items, not the containers that group them.
  const leafEntries = useMemo(() => {
    const leaves: TimelineEntry[] = [];
    const visit = (item: OutlineItem) => {
      if (item.children.length) item.children.forEach(visit);
      else if (item.node.kind !== 'PROJECT' && item.node.kind !== 'MILESTONE') {
        const entry = entries.get(item.node.id);
        if (entry) leaves.push(entry);
      }
    };
    [...outline.roots, ...outline.unplaced].forEach(visit);
    return leaves;
  }, [entries, outline]);
  const series = useMemo(() => cumulativeSeries(leafEntries, range), [leafEntries, range]);
  const rows = useMemo(() => flatten([...outline.roots, ...outline.unplaced], collapsed), [outline, collapsed]);
  const withoutHistory = allEntries.filter((entry) => entry.history === 'NONE').length;

  // One pass over the edges instead of one scan per row (INV-1443).
  const blockersByNode = useMemo(() => buildBlockerIndex(edges, byId), [edges, byId]);
  // Every container's extent in one bottom-up pass (INV-1443).
  const spans = useMemo(() => containerSpans([...outline.roots, ...outline.unplaced], entries, now), [outline, entries, now]);

  const x = useCallback((date: Date) => xFor(date, range, zoom), [range, zoom]);
  const toggle = useCallback(
    (id: string) =>
      setCollapsed((current) => {
        const next = new Set(current);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    [],
  );

  // Only the rows the viewport can show are mounted (INV-1444).
  const viewportRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const virtualize = rows.length > VIRTUALIZE_ABOVE;

  useEffect(() => {
    const element = viewportRef.current;
    if (!element || !virtualize) return;
    const measure = () => setViewportHeight(element.clientHeight);
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [virtualize]);

  const headerHeight = CHART_HEIGHT + (cycles.length ? AXIS_HEIGHT_WITH_CYCLES : AXIS_HEIGHT);
  const visibleRange = useMemo(() => {
    if (!virtualize) return { start: 0, end: rows.length };
    const height = viewportHeight || FALLBACK_VIEWPORT_HEIGHT;
    const maxScroll = Math.max(0, rows.length * ROW_HEIGHT + headerHeight - height);
    const top = Math.min(scrollTop, maxScroll);
    const first = Math.floor((top - headerHeight) / ROW_HEIGHT) - OVERSCAN;
    const last = Math.ceil((top + height - headerHeight) / ROW_HEIGHT) + OVERSCAN;
    const start = Math.max(0, Math.min(first, rows.length));
    const end = Math.max(start, Math.min(last, rows.length));
    return { start, end };
  }, [virtualize, rows.length, scrollTop, viewportHeight, headerHeight]);

  const visibleRows = rows.slice(visibleRange.start, visibleRange.end);
  const topOffset = visibleRange.start * ROW_HEIGHT;
  const bottomOffset = (rows.length - visibleRange.end) * ROW_HEIGHT;

  const maxScope = Math.max(1, ...series.map((point) => point.scope));
  const y = (count: number) => CHART_HEIGHT - 8 - (count / maxScope) * (CHART_HEIGHT - 20);
  const stepPath = (key: 'scope' | 'started' | 'completed') =>
    series
      .map((point, index) => {
        const px = x(point.at);
        const py = y(point[key]);
        if (index === 0) return `M${px},${py}`;
        return `H${px} V${py}`;
      })
      .join(' ');
  const last = series.at(-1)!;
  const handleScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(event.currentTarget.scrollTop);
  }, []);

  return (
    <div
      className="project-timeline"
      style={{
        '--timeline-started': STATE_TYPE_COLOR.STARTED,
        '--timeline-review': STATE_TYPE_COLOR.REVIEW,
        '--timeline-completed': STATE_TYPE_COLOR.COMPLETED,
      } as CSSProperties}
    >
      <div className="dependency-graph__toolbar">
        <div className="graph-options">
          <label>
            Scale
            <Select aria-label="Timeline scale" value={zoom} onChange={(event) => onZoomChange(event.target.value as TimelineZoom)}>
              <option value="day">Days</option>
              <option value="week">Weeks</option>
              <option value="month">Months</option>
            </Select>
          </label>
        </div>
        <div className="dependency-graph__legend" aria-label="Timeline legend">
          <span className="dependency-graph__legend-item"><i className="timeline-swatch timeline-swatch--waiting" />Waiting</span>
          <span className="dependency-graph__legend-item"><i className="timeline-swatch timeline-swatch--started" />In Progress</span>
          <span className="dependency-graph__legend-item"><i className="timeline-swatch timeline-swatch--review" />In Review</span>
          <span className="dependency-graph__legend-item"><i className="timeline-dot timeline-dot--completed" />Done</span>
          {withoutHistory > 0 ? (
            <span className="dependency-graph__legend-item">{withoutHistory} without recorded history</span>
          ) : null}
        </div>
      </div>

      <div
        className="project-timeline__viewport"
        role="region"
        aria-label="Project timeline"
        ref={viewportRef}
        onScroll={handleScroll}
      >
        <div
          className="project-timeline__grid"
          style={{
            gridTemplateColumns: `${LABEL_WIDTH}px ${width}px`,
            // The rows above and below the visible window keep the scrollbar
            // the length of the whole outline (INV-1444).
            '--timeline-row-offset': `${topOffset}px`,
            '--timeline-row-offset-bottom': `${bottomOffset}px`,
          } as CSSProperties}
        >
          {/* Cumulative chart */}
          <div className="project-timeline__label project-timeline__chart-label">
            <strong>Progress</strong>
            <span>
              <i className="timeline-line timeline-line--scope" /> scope {last.scope}
            </span>
            <span>
              <i className="timeline-line timeline-line--started" /> started {last.started}
            </span>
            <span>
              <i className="timeline-line timeline-line--completed" /> done {last.completed}
            </span>
          </div>
          <div className="project-timeline__lane" style={{ height: CHART_HEIGHT }}>
            <svg width={width} height={CHART_HEIGHT} aria-label="Scope, started and done over time" role="img">
              <path d={stepPath('scope')} className="timeline-series timeline-series--scope" />
              <path d={stepPath('started')} className="timeline-series timeline-series--started" />
              <path d={stepPath('completed')} className="timeline-series timeline-series--completed" />
            </svg>
          </div>

          {/* Axis + cycles */}
          <div className="project-timeline__label project-timeline__axis-label">Item</div>
          <div className="project-timeline__lane project-timeline__axis" style={{ height: cycles.length ? AXIS_HEIGHT_WITH_CYCLES : AXIS_HEIGHT }}>
            {cycles.map((cycle) => {
              const left = Math.max(0, x(cycle.startsAt));
              const right = Math.min(width, x(cycle.endsAt));
              if (right <= 0 || left >= width) return null;
              return (
                <span key={cycle.id} className="timeline-cycle" style={{ left, width: right - left }} title={`${cycle.name}: ${fmt(cycle.startsAt)} – ${fmt(cycle.endsAt)}`}>
                  {cycle.name || `Cycle ${cycle.number}`}
                </span>
              );
            })}
            {ticks.filter((tick) => x(tick.at) >= 12).map((tick) => (
              <span key={tick.at.getTime()} className={`timeline-tick${tick.major ? ' timeline-tick--major' : ''}`} style={{ left: x(tick.at) }}>
                {tick.label}
              </span>
            ))}
          </div>

          {topOffset > 0 ? <div className="project-timeline__spacer project-timeline__spacer--top" aria-hidden="true" /> : null}

          {visibleRows.map(({ item, depth }) => {
            const { node } = item;
            const entry = entries.get(node.id);
            const isContainer = item.children.length > 0;
            return (
              <TimelineRow
                key={node.id}
                node={node}
                depth={depth}
                isContainer={isContainer}
                isCollapsed={collapsed.has(node.id)}
                onToggle={toggle}
                onOpen={onOpen}
                blockers={blockersByNode.get(node.id) ?? NO_BLOCKERS}
                entry={entry}
                span={isContainer ? spans.get(node.id) ?? null : null}
                x={x}
                width={width}
                now={now}
              />
            );
          })}

          {bottomOffset > 0 ? <div className="project-timeline__spacer project-timeline__spacer--bottom" aria-hidden="true" /> : null}
        </div>
        <div className="timeline-today" style={{ left: LABEL_WIDTH + x(now) }} aria-hidden="true" title={`Today, ${fmt(now)}`} />
      </div>
    </div>
  );
}

interface TimelineRowProps {
  node: GraphNode;
  depth: number;
  isContainer: boolean;
  isCollapsed: boolean;
  onToggle: (id: string) => void;
  onOpen: (id: string) => void;
  blockers: GraphNode[];
  entry: TimelineEntry | undefined;
  span: ContainerSpan | null;
  x: (date: Date) => number;
  width: number;
  now: Date;
}

/** Rows are memoized: a collapse or a scale change redraws only what changed (INV-1443). */
const TimelineRow = memo(function TimelineRow({ node, depth, isContainer, isCollapsed, onToggle, onOpen, blockers, entry, span, x, width, now }: TimelineRowProps) {
  const summary = entry
    ? `${node.identifier}: started ${fmt(entry.startedAt)}, review ${fmt(entry.reviewAt)}, done ${fmt(entry.completedAt)}`
    : node.identifier;

  let lane: React.ReactNode = null;
  if (isContainer) {
    if (span) {
      const left = x(span.from);
      const right = x(span.to);
      lane = (
        <>
          <span
            className={`timeline-span${span.open ? ' timeline-span--open' : ''}`}
            style={{ left, width: Math.max(2, right - left) }}
            title={`${fmt(span.from)} – ${span.open ? 'today' : fmt(span.to)} · ${span.done}/${span.total} done`}
          >
            <span className="timeline-span__fill" style={{ width: `${span.total ? (span.done / span.total) * 100 : 0}%` }} />
          </span>
          {node.kind === 'MILESTONE' && entry?.completedAt ? (
            <span className="timeline-diamond" style={{ left: x(entry.completedAt) }} title={`${node.identifier} done ${fmt(entry.completedAt)}`} />
          ) : null}
        </>
      );
    }
  } else if (!entry || entry.history === 'NONE') {
    lane = <span className="timeline-nohistory">no recorded history · {node.stateName}</span>;
  } else {
    lane = spellsOf(entry).map((spell) => {
      const left = x(spell.from);
      if (spell.stateType === 'COMPLETED' || spell.stateType === 'CANCELED') {
        return (
          <span
            key={`${spell.stateType}-${spell.from.getTime()}`}
            className={spell.stateType === 'COMPLETED' ? 'timeline-dot' : 'timeline-cancel'}
            style={{ left, background: spell.stateType === 'COMPLETED' ? STATE_TYPE_COLOR.COMPLETED : undefined }}
            title={`${spell.stateName} ${fmt(spell.from)}`}
          />
        );
      }
      const right = x(spell.to ?? now);
      const waiting = spell.stateType === 'BACKLOG' || spell.stateType === 'UNSTARTED';
      return (
        <span
          key={`${spell.stateType}-${spell.from.getTime()}`}
          className={waiting ? 'timeline-bar timeline-bar--waiting' : 'timeline-bar'}
          style={{ left, width: Math.max(3, right - left), background: waiting ? undefined : STATE_TYPE_COLOR[spell.stateType] }}
          title={`${spell.stateName}: ${fmt(spell.from)} – ${spell.to ? fmt(spell.to) : 'now'}`}
        />
      );
    });
  }

  return (
    <>
      <div
        className="project-timeline__label"
        style={{ paddingLeft: 8 + depth * 16, height: ROW_HEIGHT }}
        role="rowheader"
        aria-label={`${node.identifier} ${node.title}`}
      >
        {isContainer ? (
          <button type="button" className="graph-outline__caret" aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} ${node.identifier}`} onClick={() => onToggle(node.id)}>
            {isCollapsed ? '▸' : '▾'}
          </button>
        ) : (
          <span className="graph-outline__caret" aria-hidden="true" />
        )}
        <button type="button" className="graph-outline__open" onClick={() => onOpen(node.id)} aria-label={`Open ${node.identifier}`}>
          <StatusIcon stateName={node.stateName} size={11} />
          <span className="graph-outline__id">{node.identifier}</span>
          <span className="graph-outline__title">{node.title}</span>
        </button>
        {blockers.length > 0 ? (
          <span className="graph-blocked-badge" title={`Blocked by ${blockers.map((blocker) => blocker.identifier).join(', ')}`}>
            Blocked
          </span>
        ) : null}
        {entry?.history === 'PARTIAL' ? (
          <span className="timeline-partial" title="History starts after this item was created; earlier states are not dated.">
            partial
          </span>
        ) : null}
      </div>
      <div className="project-timeline__lane" style={{ height: ROW_HEIGHT, width }} data-work-id={node.id} aria-label={summary}>
        {lane}
      </div>
    </>
  );
});
