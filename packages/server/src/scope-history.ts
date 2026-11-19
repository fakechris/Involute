import type { ActorKind, WorkflowStateType } from '@prisma/client';

export const SCOPE_DEFINITION_VERSION = '1';
export interface ScopeSnapshot {
  parentId: string | null;
  commitmentStatus: string | null;
  stateId: string | null;
  kind: string | null;
}
export interface ScopeAudit {
  id: string;
  workId: string;
  createdAt: Date;
  before: ScopeSnapshot | null;
  after: ScopeSnapshot;
  surface: string | null;
  actorKind: ActorKind;
  actorId: string | null;
  reason: string | null;
}
export interface ScopeWindowInput {
  from: string;
  to: string;
  timeZone?: string | null;
  idealStart?: string | null;
  idealEnd?: string | null;
}
const DAY = 86_400_000;
function dateNumber(date: string): number {
  const n = Date.parse(`${date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(n) || new Date(n).toISOString().slice(0, 10) !== date) throw new Error('Use valid YYYY-MM-DD calendar dates.');
  return n;
}
function nextDate(date: string) { return new Date(dateNumber(date) + DAY).toISOString().slice(0, 10); }
export function localDayStart(date: string, timeZone: string): Date {
  const target = dateNumber(date);
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  let instant = target;
  for (let i = 0; i < 6; i++) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(instant)).map(p => [p.type, p.value]));
    const local = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
    if (local === target) return new Date(instant);
    instant += target - local;
  }
  throw new Error('This calendar day has no unambiguous midnight in the chosen timezone.');
}
export function scopeWindow(input: ScopeWindowInput) {
  const from = dateNumber(input.from), to = dateNumber(input.to);
  if (from > to || (to - from) / DAY >= 366) throw new Error('Choose an inclusive burndown window of 1–366 days, from before or equal to to.');
  const timeZone = input.timeZone ?? 'UTC';
  if (/^[+-]/.test(timeZone)) throw new Error('Choose a valid IANA timezone.');
  try { new Intl.DateTimeFormat('en', { timeZone }).format(); } catch { throw new Error('Choose a valid IANA timezone.'); }
  if (input.idealStart) dateNumber(input.idealStart);
  if (input.idealEnd) dateNumber(input.idealEnd);
  if (input.idealStart && input.idealEnd && input.idealStart >= input.idealEnd) throw new Error('Ideal start must be before ideal end.');
  return { from: input.from, to: input.to, timeZone, start: localDayStart(input.from, timeZone), end: localDayStart(nextDate(input.to), timeZone) };
}
type EventType = 'ADD' | 'REMOVE' | 'COMMIT' | 'UNCOMMIT' | 'COMPLETE' | 'CANCEL' | 'REOPEN';
export interface Gap { start: Date | null; end: Date | null; workId: string; reason: string }
export interface ScopeEvent {
  sequence: number; milestoneId: string; workId: string; identifier: string; type: EventType;
  effectiveAt: Date; recordedAt: Date; backfilled: boolean;
  source: { auditId: string; surface: string | null; actorKind: ActorKind; actorId: string | null; reason: string | null };
}
export function replayMilestoneScope(input: ScopeWindowInput & {
  milestoneId: string;
  works: readonly { id: string; identifier: string }[];
  audits: readonly ScopeAudit[];
  states: ReadonlyMap<string, WorkflowStateType>;
  now: Date;
}) {
  const window = scopeWindow(input);
  const orderedInput = [...input.audits].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  const works = [...input.works].filter(work => {
    const firstAudit = orderedInput.find(a => a.workId === work.id);
    return !firstAudit || firstAudit.before !== null || firstAudit.createdAt < window.end;
  }).sort((a, b) => a.id.localeCompare(b.id));
  const ids = new Set(works.map(w => w.id));
  const audits = [...new Map(input.audits.filter(a => ids.has(a.workId) && a.createdAt < window.end).map(a => [a.id, a])).values()]
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  const current = new Map<string, ScopeSnapshot>();
  const previous = new Map<string, ScopeAudit>();
  const first = new Map<string, Date>();
  const gaps: Gap[] = [];
  const events: ScopeEvent[] = [];
  const frames: { at: Date; scope: number; remaining: number }[] = [];
  const typeOf = (s: ScopeSnapshot | undefined) => s?.stateId ? input.states.get(s.stateId) : undefined;
  const member = (id: string) => {
    const visited = new Set<string>();
    let parent = current.get(id)?.parentId;
    while (parent && !visited.has(parent)) {
      if (parent === input.milestoneId) return true;
      visited.add(parent);
      parent = current.get(parent)?.parentId;
    }
    return false;
  };
  const membership = () => new Set(works.filter(w => current.get(w.id)?.kind === 'ISSUE' && member(w.id)).map(w => w.id));
  const counts = () => {
    const scoped = [...membership()].filter(id => current.get(id)?.commitmentStatus === 'COMMITTED' && typeOf(current.get(id)) !== 'CANCELED');
    return { scope: scoped.length, remaining: scoped.filter(id => typeOf(current.get(id)) !== 'COMPLETED').length };
  };
  for (const audit of audits) {
    const old = current.get(audit.workId);
    const prior = previous.get(audit.workId);
    if (!first.has(audit.workId)) {
      first.set(audit.workId, audit.createdAt);
      if (audit.before !== null) gaps.push({ start: null, end: audit.createdAt, workId: audit.workId, reason: 'MISSING_CREATION' });
    }
    if (old && (!audit.before || ['parentId', 'commitmentStatus', 'stateId'].some(key => old[key as keyof ScopeSnapshot] !== audit.before?.[key as keyof ScopeSnapshot]))) {
      gaps.push({ start: prior!.createdAt, end: audit.createdAt, workId: audit.workId, reason: 'DISCONTINUITY' });
    }
    const beforeMembers = membership();
    current.set(audit.workId, audit.after);
    const afterMembers = membership();
    if (!typeOf(audit.after)) gaps.push({ start: prior?.createdAt ?? audit.createdAt, end: null, workId: audit.workId, reason: 'UNKNOWN_STATE' });
    else for (const gap of gaps) if (gap.workId === audit.workId && gap.reason === 'UNKNOWN_STATE' && gap.end === null) gap.end = audit.createdAt;
    previous.set(audit.workId, audit);
    for (const work of works) {
      const types: EventType[] = [];
      if (!beforeMembers.has(work.id) && afterMembers.has(work.id)) types.push('ADD');
      if (beforeMembers.has(work.id) && !afterMembers.has(work.id)) types.push('REMOVE');
      if (work.id === audit.workId && (beforeMembers.has(work.id) || afterMembers.has(work.id))) {
        if (old?.commitmentStatus !== 'COMMITTED' && audit.after.commitmentStatus === 'COMMITTED') types.push('COMMIT');
        if (old?.commitmentStatus === 'COMMITTED' && audit.after.commitmentStatus !== 'COMMITTED') types.push('UNCOMMIT');
        const beforeType = typeOf(old), afterType = typeOf(audit.after);
        if (beforeType !== afterType) {
          if (afterType === 'COMPLETED') types.push('COMPLETE');
          else if (afterType === 'CANCELED') types.push('CANCEL');
          else if ((beforeType === 'COMPLETED' || beforeType === 'CANCELED') && afterType) types.push('REOPEN');
        }
      }
      for (const type of types) events.push({ sequence: events.length, milestoneId: input.milestoneId, workId: work.id, identifier: work.identifier, type,
        effectiveAt: audit.createdAt, recordedAt: audit.createdAt, backfilled: /migration|import|repair|backfill/i.test(audit.surface ?? ''),
        source: { auditId: audit.id, surface: audit.surface, actorKind: audit.actorKind, actorId: audit.actorId, reason: audit.reason } });
    }
    frames.push({ at: audit.createdAt, ...counts() });
  }
  for (const work of works) if (!first.has(work.id)) gaps.push({ start: null, end: null, workId: work.id, reason: 'NO_HISTORY' });
  const unknownWorkCount = works.filter(w => !first.has(w.id) || !typeOf(current.get(w.id))).length;
  let baseline = works.some(w => !first.has(w.id)) || !works.length ? null : new Date(Math.max(...[...first.values()].map(d => d.getTime())));
  while (baseline !== null) {
    const anchor: Date = baseline;
    const covering = gaps.find(g => (g.start === null || anchor >= g.start) && (g.end === null || anchor < g.end));
    if (!covering) break;
    baseline = covering.end;
  }
  const known = (at: Date) => baseline !== null && at >= baseline && at <= input.now && !gaps.some(g => (g.start === null || at >= g.start) && (g.end === null || at < g.end));
  const atCounts = (at: Date) => [...frames].reverse().find(f => f.at < at) ?? { scope: 0, remaining: 0 };
  const idealStart = input.idealStart && input.idealEnd ? localDayStart(input.idealStart, window.timeZone) : null;
  const idealEnd = input.idealStart && input.idealEnd ? localDayStart(input.idealEnd, window.timeZone) : null;
  const ideal = idealStart && idealEnd && baseline && baseline <= idealStart && known(idealStart) ? { kind: 'REFERENCE' as const, start: idealStart, end: idealEnd } : null;
  const points = [];
  for (let date = input.from; date <= input.to; date = nextDate(date)) {
    const at = localDayStart(nextDate(date), window.timeZone);
    const count = known(at) ? atCounts(at) : null;
    points.push({ date, at, scope: count?.scope ?? null, remaining: count?.remaining ?? null,
      ideal: ideal && at >= ideal.start && at <= ideal.end && at <= input.now ? atCounts(ideal.start).remaining * (ideal.end.getTime() - at.getTime()) / (ideal.end.getTime() - ideal.start.getTime()) : null });
  }
  return { definitionVersion: SCOPE_DEFINITION_VERSION, window, coverage: {
    status: baseline === null ? 'NONE' : baseline <= window.start && !gaps.some(g => (g.start === null || g.start < window.end) && (g.end === null || g.end > window.start)) ? 'FULL' : 'PARTIAL',
    baseline, gaps, memberCount: works.length, unknownWorkCount, backfilledEventCount: events.filter(e => e.backfilled).length,
  }, emptyReason: !works.length ? 'NO_MEMBERS' : !audits.length ? 'NO_HISTORY' : null, ideal, points, events };
}
