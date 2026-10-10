import type { ActorKind, Prisma, PrismaClient, User, WorkTimelineStar } from '@prisma/client';

import { assertCanReadIssue, assertCanWriteIssue, buildReadableIssueWhere } from './access-control.js';
import { requireAuthentication, type GraphQLContext } from './auth.js';
import { findWorkByIdOrIdentifier } from './context-service.js';
import {
  createNotFoundError,
  createValidationError,
  ISSUE_NOT_FOUND_MESSAGE,
  TIMELINE_ENTRY_KEY_REQUIRED_MESSAGE,
  TIMELINE_ENTRY_NOT_FOUND_MESSAGE,
} from './errors.js';

export { TIMELINE_ENTRY_KEY_REQUIRED_MESSAGE, TIMELINE_ENTRY_NOT_FOUND_MESSAGE };

type DatabaseClient = PrismaClient | Prisma.TransactionClient;

/**
 * The issue timeline (INV-1116): one time-ordered list projected from what the
 * server already records — WorkAudit rows (state, assignee, priority, placement
 * and field changes), runs (started / ended), evidence (attached / retracted)
 * and comments — each with the actor who did it. Nothing here is stored except
 * stars: a person or agent may mark any entry as a key event, which is what a
 * postmortem draft (INV-1126) reads back with `loadWorkTimeline(…, { starredOnly: true })`.
 *
 * Entries are addressed by a stable key derived from their source row, so a
 * star survives re-projection: `audit:<id>`, `run:<id>:started`,
 * `run:<id>:ended`, `evidence:<id>`, `evidence:<id>:retracted`, `comment:<id>`,
 * `needinfo:<id>`, `needinfo:<id>:closed`.
 */
export const TIMELINE_ENTRY_KINDS = [
  'CREATED',
  'STATE',
  'COMMITMENT',
  'ASSIGNEE',
  'PRIORITY',
  'PARENT',
  'FIELDS',
  'RUN_STARTED',
  'RUN_ENDED',
  'EVIDENCE',
  'EVIDENCE_RETRACTED',
  // A needinfo (INV-1119) raised, and how it closed.
  'NEEDINFO',
  'COMMENT',
] as const;
export type TimelineEntryKind = (typeof TIMELINE_ENTRY_KINDS)[number];

export interface TimelineChange {
  field: string;
  /** Display value before; null when empty or when the field is long text (description, contract). */
  from: string | null;
  to: string | null;
}

export interface TimelineStarInfo {
  starredAt: Date;
  starredBy: User;
}

export interface TimelineEntry {
  key: string;
  kind: TimelineEntryKind;
  at: Date;
  actor: User | null;
  actorKind: ActorKind | null;
  /** One line a person can read, e.g. "Moved from Ready to In Progress". */
  summary: string;
  /** Comment body, run summary, evidence summary or audit reason. */
  detail: string | null;
  url: string | null;
  changes: TimelineChange[];
  /** Work revision an audit entry recorded; null for other sources. */
  revision: number | null;
  /** Id of the audit, run, evidence or comment row the entry comes from. */
  sourceId: string;
  star: TimelineStarInfo | null;
}

export interface WorkTimeline {
  workId: string;
  identifier: string;
  entries: TimelineEntry[];
  /** True when a source had more rows than the timeline reads (TIMELINE_SOURCE_LIMIT each). */
  truncated: boolean;
}

export const TIMELINE_SOURCE_LIMIT = 1000;

const PRIORITY_NAMES: Record<number, string> = { 0: 'No priority', 1: 'Urgent', 2: 'High', 3: 'Medium', 4: 'Low' };
// INV-1115: impact, apart from priority.
const SEVERITY_NAMES: Record<string, string> = { SEV1: 'SEV1 Critical', SEV2: 'SEV2 Major', SEV3: 'SEV3 Minor' };
const LONG_TEXT_FIELDS = new Set(['description', 'acceptance', 'scope', 'verification', 'outcome', 'constraints']);
// Audit snapshot fields the timeline reports, in the order changes are listed.
const REPORTED_FIELDS = [
  'stateId',
  'commitmentStatus',
  'assigneeId',
  'priority',
  'severity',
  'impactStartedAt',
  'detectedAt',
  'mitigatedAt',
  'resolvedAt',
  'parentId',
  'title',
  'kind',
  'repository',
  'cycleId',
  'supersededById',
  'description',
  'outcome',
  'scope',
  'constraints',
  'acceptance',
  'verification',
] as const;
const FIELD_LABELS: Record<string, string> = {
  stateId: 'state',
  commitmentStatus: 'commitment',
  assigneeId: 'assignee',
  parentId: 'parent',
  cycleId: 'cycle',
  supersededById: 'superseded by',
  // INV-1125: incident impact timestamps.
  impactStartedAt: 'impact started',
  detectedAt: 'detected',
  mitigatedAt: 'mitigated',
  resolvedAt: 'resolved',
};
const TIME_FIELDS = new Set(['impactStartedAt', 'detectedAt', 'mitigatedAt', 'resolvedAt']);

/** "2026-10-09 14:30 UTC": audit snapshots keep these as ISO strings. */
function displayTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

type Snapshot = Record<string, unknown>;

interface Lookups {
  states: Map<string, string>;
  users: Map<string, User>;
  /** Parent / superseding work the reader may see: id → identifier. */
  readableWork: Map<string, string>;
  cycles: Map<string, string>;
}

function asSnapshot(value: unknown): Snapshot | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Snapshot) : null;
}

function display(field: string, value: unknown, lookups: Lookups): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (LONG_TEXT_FIELDS.has(field)) return null;
  const text = String(value);
  if (TIME_FIELDS.has(field)) return displayTime(text);
  switch (field) {
    case 'stateId':
      return lookups.states.get(text) ?? 'an unknown state';
    case 'assigneeId': {
      const user = lookups.users.get(text);
      return user ? (user.name ?? user.email ?? 'someone') : 'someone';
    }
    case 'priority':
      return PRIORITY_NAMES[Number(value)] ?? text;
    case 'severity':
      return SEVERITY_NAMES[text] ?? text;
    case 'parentId':
    case 'supersededById':
      // Never name work the reader cannot read.
      return lookups.readableWork.get(text) ?? 'a work item you cannot see';
    case 'cycleId':
      return lookups.cycles.get(text) ?? 'a cycle';
    default:
      return text;
  }
}

function changePhrase(change: TimelineChange, rawFrom: unknown, rawTo: unknown): string {
  switch (change.field) {
    case 'state':
      return change.from ? `Moved from ${change.from} to ${change.to ?? 'no state'}` : `Moved to ${change.to ?? 'no state'}`;
    case 'commitment':
      if (rawTo === 'COMMITTED') return 'Committed';
      if (rawTo === 'REJECTED') return 'Declined';
      if (rawTo === 'CANDIDATE') return 'Returned to candidates';
      return `Commitment changed to ${change.to ?? 'none'}`;
    case 'assignee':
      return change.to ? `Assigned to ${change.to}` : 'Unassigned';
    case 'priority':
      return `Priority ${change.from ?? 'No priority'} → ${change.to ?? 'No priority'}`;
    case 'severity':
      if (!change.to) return 'Severity cleared';
      return change.from ? `Severity ${change.from} → ${change.to}` : `Severity set to ${change.to}`;
    case 'parent':
      return change.to ? `Moved under ${change.to}` : 'Removed from its parent';
    case 'impact started':
    case 'detected':
    case 'mitigated':
    case 'resolved':
      if (!change.to) return `Cleared ${change.field} time`;
      return change.from ? `${capitalize(change.field)} ${change.from} → ${change.to}` : `${capitalize(change.field)} at ${change.to}`;
    default:
      if (LONG_TEXT_FIELDS.has(change.field)) return rawFrom ? `Edited ${change.field}` : `Set ${change.field}`;
      return change.to ? `${capitalize(change.field)} set to ${change.to}` : `Cleared ${change.field}`;
  }
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const KIND_FOR_FIELD: Record<string, TimelineEntryKind> = {
  stateId: 'STATE',
  commitmentStatus: 'COMMITMENT',
  assigneeId: 'ASSIGNEE',
  priority: 'PRIORITY',
  severity: 'PRIORITY',
  parentId: 'PARENT',
};

/** One audit row as a timeline entry; null when the row changed nothing the timeline reports. */
export function auditEntry(
  audit: { id: string; createdAt: Date; revision: number; actorKind: ActorKind; actor: User | null; reason: string | null; before: unknown; after: unknown },
  lookups: Lookups,
): Omit<TimelineEntry, 'star'> | null {
  const before = asSnapshot(audit.before);
  const after = asSnapshot(audit.after) ?? {};
  const base = {
    key: `audit:${audit.id}`,
    at: audit.createdAt,
    actor: audit.actor,
    actorKind: audit.actorKind,
    detail: audit.reason,
    url: null,
    revision: audit.revision,
    sourceId: audit.id,
  };
  if (!before) {
    const state = display('stateId', after.stateId, lookups);
    const candidate = after.commitmentStatus === 'CANDIDATE';
    return {
      ...base,
      kind: 'CREATED',
      summary: `Created${candidate ? ' as a candidate' : ''}${state ? ` in ${state}` : ''}`,
      changes: [],
    };
  }
  const changes: TimelineChange[] = [];
  const phrases: string[] = [];
  let kind: TimelineEntryKind | null = null;
  for (const field of REPORTED_FIELDS) {
    const rawFrom = before[field] ?? null;
    const rawTo = after[field] ?? null;
    if (JSON.stringify(rawFrom) === JSON.stringify(rawTo)) continue;
    const change: TimelineChange = { field: FIELD_LABELS[field] ?? field, from: display(field, rawFrom, lookups), to: display(field, rawTo, lookups) };
    changes.push(change);
    phrases.push(changePhrase(change, rawFrom, rawTo));
    kind ??= KIND_FOR_FIELD[field] ?? null;
  }
  if (changes.length === 0) return null;
  return { ...base, kind: kind ?? 'FIELDS', summary: phrases.join('; '), changes };
}

const NEEDINFO_CLOSED: Record<string, string> = {
  COMPLETED: '{target} answered the needinfo',
  CANCELED: 'Needinfo for {target} withdrawn',
  FAILED: 'Needinfo for {target} lapsed without an answer',
};

const RUN_ENDED_WORDS: Record<string, string> = { COMPLETED: 'completed', FAILED: 'failed', BLOCKED: 'blocked', RUNNING: 'stopped', QUEUED: 'stopped' };

/**
 * The timeline of one work item, oldest first. No authorization here: callers
 * check read access first (`workTimelineFor` does). `readable` restricts which
 * linked work items may be named in entries, as getWorkContext does.
 */
export async function loadWorkTimeline(
  prisma: DatabaseClient,
  workId: string,
  options: { starredOnly?: boolean; readable?: Prisma.IssueWhereInput } = {},
): Promise<WorkTimeline> {
  const work = await prisma.issue.findUnique({ where: { id: workId }, select: { id: true, identifier: true, teamId: true } });
  if (!work) throw createNotFoundError(ISSUE_NOT_FOUND_MESSAGE);
  const take = TIMELINE_SOURCE_LIMIT + 1;
  const [audits, runs, evidence, comments, stars, needInfos] = await Promise.all([
    prisma.workAudit.findMany({ where: { workId }, include: { actor: true }, orderBy: [{ createdAt: 'asc' }, { revision: 'asc' }, { id: 'asc' }], take }),
    prisma.workRun.findMany({ where: { workId }, include: { actor: true }, orderBy: [{ startedAt: 'asc' }, { id: 'asc' }], take }),
    prisma.workEvidence.findMany({ where: { workId }, include: { actor: true, retractedBy: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take }),
    prisma.comment.findMany({ where: { issueId: workId }, include: { user: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take }),
    activeStars(prisma, workId),
    prisma.agentRequest.findMany({
      where: { needInfo: true, workId },
      include: { requestedByActor: true, targetActor: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take,
    }),
  ]);
  const truncated = [audits, runs, evidence, comments, needInfos].some((rows) => rows.length > TIMELINE_SOURCE_LIMIT);
  for (const rows of [audits, runs, evidence, comments, needInfos]) rows.splice(TIMELINE_SOURCE_LIMIT);

  const lookups = await buildLookups(prisma, audits.map((audit) => [asSnapshot(audit.before), asSnapshot(audit.after)]).flat(), options.readable);
  const entries: Array<Omit<TimelineEntry, 'star'>> = [];
  for (const audit of audits) {
    const entry = auditEntry(audit, lookups);
    if (entry) entries.push(entry);
  }
  for (const run of runs) {
    entries.push({
      key: `run:${run.id}:started`,
      kind: 'RUN_STARTED',
      at: run.startedAt,
      actor: run.actor,
      actorKind: run.actor?.actorKind ?? null,
      summary: `Run ${run.publicId} started`,
      detail: null,
      url: null,
      changes: [],
      revision: null,
      sourceId: run.id,
    });
    if (run.endedAt) {
      entries.push({
        key: `run:${run.id}:ended`,
        kind: 'RUN_ENDED',
        at: run.endedAt,
        actor: run.actor,
        actorKind: run.actor?.actorKind ?? null,
        summary: `Run ${run.publicId} ${RUN_ENDED_WORDS[run.status] ?? run.status.toLowerCase()}${run.phase ? ` (${run.phase})` : ''}`,
        detail: run.summary,
        url: run.externalUrl ?? (run.pullRequestNumber && run.repository ? `https://github.com/${run.repository}/pull/${run.pullRequestNumber}` : null),
        changes: [],
        revision: null,
        sourceId: run.id,
      });
    }
  }
  for (const item of evidence) {
    entries.push({
      key: `evidence:${item.id}`,
      kind: 'EVIDENCE',
      at: item.createdAt,
      actor: item.actor,
      actorKind: item.actor?.actorKind ?? null,
      summary: `Attached ${item.kind.toLowerCase()} evidence`,
      detail: item.summary,
      url: item.url,
      changes: [],
      revision: null,
      sourceId: item.id,
    });
    if (item.retractedAt) {
      entries.push({
        key: `evidence:${item.id}:retracted`,
        kind: 'EVIDENCE_RETRACTED',
        at: item.retractedAt,
        actor: item.retractedBy,
        actorKind: item.retractedBy?.actorKind ?? null,
        summary: `Retracted ${item.kind.toLowerCase()} evidence`,
        detail: item.retractReason,
        url: item.url,
        changes: [],
        revision: null,
        sourceId: item.id,
      });
    }
  }
  for (const request of needInfos) {
    const target = request.targetActor.name ?? request.targetActor.email ?? 'someone';
    entries.push({
      key: `needinfo:${request.id}`,
      kind: 'NEEDINFO',
      at: request.createdAt,
      actor: request.requestedByActor,
      actorKind: request.requestedByActor.actorKind,
      summary: `Asked ${target} for information`,
      detail: request.body,
      url: null,
      changes: [],
      revision: null,
      sourceId: request.id,
    });
    const closed = NEEDINFO_CLOSED[request.state];
    if (closed) {
      // A closed request is not written again, so updatedAt is when it closed.
      const byTarget = request.state === 'COMPLETED' || request.state === 'FAILED';
      const actor = byTarget ? request.targetActor : request.state === 'CANCELED' ? request.requestedByActor : null;
      entries.push({
        key: `needinfo:${request.id}:closed`,
        kind: 'NEEDINFO',
        at: request.canceledAt ?? request.updatedAt,
        actor,
        actorKind: actor?.actorKind ?? null,
        summary: closed.replace('{target}', target),
        detail: request.state === 'FAILED' ? request.failureReason : null,
        url: null,
        changes: [],
        revision: null,
        sourceId: request.id,
      });
    }
  }
  for (const comment of comments) {
    entries.push({
      key: `comment:${comment.id}`,
      kind: 'COMMENT',
      at: comment.createdAt,
      actor: comment.user,
      actorKind: comment.user.actorKind,
      summary: comment.parentCommentId ? 'Replied' : 'Commented',
      detail: comment.body,
      url: null,
      changes: [],
      revision: null,
      sourceId: comment.id,
    });
  }

  const order = (entry: Omit<TimelineEntry, 'star'>) => TIMELINE_ENTRY_KINDS.indexOf(entry.kind);
  entries.sort((left, right) =>
    left.at.getTime() - right.at.getTime()
    || (left.revision ?? 0) - (right.revision ?? 0)
    || order(left) - order(right)
    || left.key.localeCompare(right.key));

  const starByKey = new Map(stars.map((star) => [star.entryKey, star]));
  const projected = entries.map((entry): TimelineEntry => {
    const star = starByKey.get(entry.key);
    return { ...entry, star: star ? { starredAt: star.starredAt, starredBy: star.starredBy } : null };
  });
  return {
    workId: work.id,
    identifier: work.identifier,
    entries: options.starredOnly ? projected.filter((entry) => entry.star) : projected,
    truncated,
  };
}

function activeStars(prisma: DatabaseClient, workId: string) {
  return prisma.workTimelineStar.findMany({ where: { workId, unstarredAt: null }, include: { starredBy: true }, orderBy: { starredAt: 'asc' } });
}

async function buildLookups(prisma: DatabaseClient, snapshots: Array<Snapshot | null>, readable: Prisma.IssueWhereInput | undefined): Promise<Lookups> {
  const ids = (field: string) => [...new Set(snapshots.map((snapshot) => snapshot?.[field]).filter((value): value is string => typeof value === 'string' && value.length > 0))];
  const workIds = [...new Set([...ids('parentId'), ...ids('supersededById')])];
  const [states, users, work, cycles] = await Promise.all([
    prisma.workflowState.findMany({ where: { id: { in: ids('stateId') } }, select: { id: true, name: true } }),
    prisma.user.findMany({ where: { id: { in: ids('assigneeId') } } }),
    prisma.issue.findMany({ where: { AND: [{ id: { in: workIds } }, readable ?? {}] }, select: { id: true, identifier: true } }),
    prisma.cycle.findMany({ where: { id: { in: ids('cycleId') } }, select: { id: true, name: true, number: true } }),
  ]);
  return {
    states: new Map(states.map((state) => [state.id, state.name])),
    users: new Map(users.map((user) => [user.id, user])),
    readableWork: new Map(work.map((item) => [item.id, item.identifier])),
    cycles: new Map(cycles.map((cycle) => [cycle.id, cycle.name || `Cycle ${cycle.number}`])),
  };
}

async function readableWorkFor(context: GraphQLContext, idOrIdentifier: string) {
  requireAuthentication(context);
  const work = await findWorkByIdOrIdentifier(context.prisma, idOrIdentifier);
  if (!work) throw createNotFoundError(ISSUE_NOT_FOUND_MESSAGE);
  await assertCanReadIssue(context.prisma, context, work.id);
  return work;
}

/** The timeline as the viewer may read it (GraphQL workTimeline, MCP work_timeline). */
export async function workTimelineFor(context: GraphQLContext, idOrIdentifier: string, options: { starredOnly?: boolean } = {}): Promise<WorkTimeline> {
  const work = await readableWorkFor(context, idOrIdentifier);
  const readable = buildReadableIssueWhere(context);
  return loadWorkTimeline(context.prisma, work.id, { ...options, ...(readable ? { readable } : {}) });
}

async function writableEntry(context: GraphQLContext, idOrIdentifier: string, entryKey: string, requireEntry: boolean) {
  const viewer = requireAuthentication(context);
  const key = entryKey?.trim() ?? '';
  if (!key) throw createValidationError(TIMELINE_ENTRY_KEY_REQUIRED_MESSAGE);
  const work = await readableWorkFor(context, idOrIdentifier);
  await assertCanWriteIssue(context.prisma, context, work.id);
  if (requireEntry) {
    const timeline = await loadWorkTimeline(context.prisma, work.id);
    if (!timeline.entries.some((item) => item.key === key)) throw createNotFoundError(TIMELINE_ENTRY_NOT_FOUND_MESSAGE);
  }
  return { viewer, work, key };
}

/**
 * Mark an entry as a key event. Needs write access to the work. Starring an
 * entry that is already starred keeps the first star (idempotent).
 */
export async function starTimelineEntry(context: GraphQLContext, idOrIdentifier: string, entryKey: string): Promise<{ workId: string; entryKey: string; star: WorkTimelineStar & { starredBy: User } }> {
  const { viewer, work, key } = await writableEntry(context, idOrIdentifier, entryKey, true);
  const existing = await context.prisma.workTimelineStar.findFirst({ where: { workId: work.id, entryKey: key, unstarredAt: null }, include: { starredBy: true } });
  if (existing) return { workId: work.id, entryKey: key, star: existing };
  try {
    const star = await context.prisma.workTimelineStar.create({ data: { workId: work.id, entryKey: key, starredById: viewer.id }, include: { starredBy: true } });
    return { workId: work.id, entryKey: key, star };
  } catch (error) {
    // A concurrent star won the partial unique index; theirs stands.
    const winner = await context.prisma.workTimelineStar.findFirst({ where: { workId: work.id, entryKey: key, unstarredAt: null }, include: { starredBy: true } });
    if (winner) return { workId: work.id, entryKey: key, star: winner };
    throw error;
  }
}

/** Remove the star. The row stays with who unstarred it and when; unstarring an unstarred entry is a no-op (removed: false). */
export async function unstarTimelineEntry(context: GraphQLContext, idOrIdentifier: string, entryKey: string): Promise<{ workId: string; entryKey: string; removed: boolean }> {
  // An entry whose source is gone (a deleted comment) can still be unstarred.
  const { viewer, work, key } = await writableEntry(context, idOrIdentifier, entryKey, false);
  const result = await context.prisma.workTimelineStar.updateMany({
    where: { workId: work.id, entryKey: key, unstarredAt: null },
    data: { unstarredAt: new Date(), unstarredById: viewer.id },
  });
  return { workId: work.id, entryKey: key, removed: result.count > 0 };
}
