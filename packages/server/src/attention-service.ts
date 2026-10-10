import type { Issue, Prisma, PrismaClient, User } from '@prisma/client';

import { BUG_LABEL_NAME } from './bug-report.js';
import { currentTriager } from './bug-triage.js';
import { isAmendmentStale } from './contract-amendment.js';
import { createValidationError } from './errors.js';
import { WEBHOOK_AUTO_DISABLE_THRESHOLD } from './event-outbox.js';
import { loadReviewWaits } from './review-wait.js';

type DatabaseClient = PrismaClient | Prisma.TransactionClient;

/**
 * What a person is waiting to decide (INV-1091). Every kind is derived from
 * the live state of the thing being decided — never from notification rows
 * a person has to clear — so an item disappears for everyone the moment the
 * decision is made, and the count always equals the list.
 */
export const ATTENTION_KINDS = [
  'CONTRACT_AMENDMENT',
  'WORK_REVIEW',
  'CANDIDATE_COMMIT',
  'DELIVERY_CHANGE',
  'AGENT_REQUEST',
  'DECISION_REQUESTED',
  'OPS',
] as const;
export type AttentionKind = (typeof ATTENTION_KINDS)[number];

/** The decisions the item can take in place; the web queue maps each to an existing mutation. */
export type AttentionAction =
  | 'ACCEPT'
  | 'ANSWER'
  | 'APPROVE'
  | 'COMMIT'
  | 'DECLINE'
  | 'OPEN'
  | 'REJECT'
  | 'REPLY'
  | 'RESPOND'
  | 'RETURN';

export interface AttentionItem {
  /** Stable across requests: `<kind>:<subjectId>`. */
  id: string;
  kind: AttentionKind;
  /** The row that is decided: the work, amendment, change set, request, run or ops object. */
  subjectId: string;
  workId: string | null;
  /** When the wait for this decision began. */
  since: Date;
  reason: string;
  actions: AttentionAction[];
  /** Nearest EPIC or MILESTONE above the work, else its PROJECT; null when unplaced or not work. */
  groupId: string | null;
  /** Waited longer than its kind allows (INV-1094). */
  overdue: boolean;
  /** Work that BLOCKS this one and is not finished: decide it after them. */
  waitingOnIds: string[];
  /** Everything that blocked this work is finished: the decision is ready now (INV-1053 → INV-1054). */
  unblocked: boolean;
}

const HOUR = 60 * 60_000;
/** How long each kind may wait before it is marked overdue and leads the digest (INV-1094). */
export const ATTENTION_OVERDUE_MS: Record<AttentionKind, number> = {
  AGENT_REQUEST: 4 * HOUR,
  CANDIDATE_COMMIT: 72 * HOUR,
  CONTRACT_AMENDMENT: 24 * HOUR,
  DECISION_REQUESTED: 4 * HOUR,
  DELIVERY_CHANGE: 24 * HOUR,
  OPS: 24 * HOUR,
  WORK_REVIEW: 72 * HOUR,
};

export interface AttentionSummary {
  total: number;
  byKind: Array<{ kind: AttentionKind; count: number; oldestSince: Date | null }>;
}

export interface AttentionFilter {
  kinds?: AttentionKind[] | null | undefined;
  teamKey?: string | null | undefined;
}

/** Each kind is read up to this many rows; past it the queue is not the problem. */
const KIND_LIMIT = 500;
const GROUP_KINDS = new Set(['EPIC', 'MILESTONE']);
const MAX_ANCESTOR_DEPTH = 10;
const BUG_WHERE: Prisma.IssueWhereInput = {
  labels: { some: { name: { equals: BUG_LABEL_NAME, mode: 'insensitive' } } },
};
const ACTIVE_RUN_STATUSES = ['QUEUED', 'RUNNING', 'BLOCKED'] as const;

type Viewer = Pick<User, 'actorKind' | 'globalRole' | 'id'>;

export interface Scope {
  now: Date;
  viewer: Viewer;
  /** Readability (team membership and project shares); undefined = no restriction. */
  readable: Prisma.IssueWhereInput | undefined;
  teamKey: string | null;
  /** The work the viewer is answerable for: the human-gate rule of resolveHumanRecipients. */
  responsible: Prisma.IssueWhereInput;
  triagerTeamIds: string[];
  rotationTeamIds: string[];
}

/**
 * The loader that reads each kind from live state (INV-1095).
 * human-surface.test.ts checks every kind has one and a test that sees it
 * appear and go once decided.
 */
export const ATTENTION_LOADERS: Record<AttentionKind, (prisma: DatabaseClient, scope: Scope) => Promise<AttentionItem[]>> = {
  AGENT_REQUEST: agentRequests,
  CANDIDATE_COMMIT: candidates,
  CONTRACT_AMENDMENT: amendments,
  DECISION_REQUESTED: decisionRequests,
  DELIVERY_CHANGE: deliveryChanges,
  OPS: opsItems,
  WORK_REVIEW: reviews,
};

export async function loadAttention(
  prisma: DatabaseClient,
  viewer: Viewer | null,
  readable: Prisma.IssueWhereInput | undefined,
  filter: AttentionFilter = {},
  now = new Date(),
): Promise<AttentionItem[]> {
  // Only people decide; an agent's decisions reach it through agent_inbox.
  if (!viewer || viewer.actorKind !== 'HUMAN') return [];
  const scope = await buildScope(prisma, viewer, readable, filter.teamKey ?? null, now);
  const wanted = new Set<AttentionKind>(filter.kinds?.length ? filter.kinds : ATTENTION_KINDS);
  const lists = await Promise.all(ATTENTION_KINDS.filter((kind) => wanted.has(kind)).map((kind) => ATTENTION_LOADERS[kind](prisma, scope)));
  const items = lists.flat();
  await assignGroups(prisma, items);
  await assignBlockers(prisma, items);
  for (const entry of items) entry.overdue = now.getTime() - entry.since.getTime() >= ATTENTION_OVERDUE_MS[entry.kind];
  // Longest wait first: the oldest decision is the one most likely forgotten.
  return items.sort((a, b) => a.since.getTime() - b.since.getTime() || a.id.localeCompare(b.id));
}

export function summarizeAttention(items: AttentionItem[]): AttentionSummary {
  const byKind = ATTENTION_KINDS.map((kind) => {
    const ofKind = items.filter((item) => item.kind === kind);
    const oldest = ofKind.reduce<Date | null>((min, item) => (!min || item.since < min ? item.since : min), null);
    return { count: ofKind.length, kind, oldestSince: oldest };
  });
  return { byKind, total: items.length };
}

/**
 * One page of the queue. The cursor is the position (since, id) of the last
 * item seen, not an index: items vanish as they are decided, and the next
 * page must not skip the ones that slid up.
 */
export function pageAttention(items: AttentionItem[], first: number, after: string | null) {
  let start = 0;
  if (after) {
    const cursor = decodeCursor(after);
    start = items.findIndex((entry) => entry.since.getTime() > cursor.since || (entry.since.getTime() === cursor.since && entry.id > cursor.id));
    if (start === -1) start = items.length;
  }
  const nodes = items.slice(start, start + first);
  const last = nodes.at(-1);
  return {
    nodes,
    pageInfo: { endCursor: last ? encodeCursor(last) : null, hasNextPage: start + first < items.length },
  };
}

function encodeCursor(entry: AttentionItem): string {
  return Buffer.from(JSON.stringify({ id: entry.id, since: entry.since.getTime() })).toString('base64url');
}

function decodeCursor(value: string): { id: string; since: number } {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as { id?: unknown; since?: unknown };
    if (typeof parsed.id === 'string' && typeof parsed.since === 'number') return { id: parsed.id, since: parsed.since };
  } catch {
    // Fall through to the refusal below.
  }
  throw createValidationError('Invalid attention cursor.');
}

async function buildScope(
  prisma: DatabaseClient,
  viewer: Viewer,
  readable: Prisma.IssueWhereInput | undefined,
  teamKey: string | null,
  now: Date,
): Promise<Scope> {
  const memberships = await prisma.teamMembership.findMany({
    where: { userId: viewer.id },
    select: { role: true, teamId: true },
  });
  const ownedTeamIds = memberships.filter((membership) => membership.role === 'OWNER').map((membership) => membership.teamId);
  // A team with a triage rotation sends its bug candidates to this week's triager (INV-750).
  const rotationTeams = await prisma.team.findMany({
    where: { id: { in: memberships.map((membership) => membership.teamId) } },
    select: { id: true, triageRotation: true },
  });
  const rotationTeamIds: string[] = [];
  const triagerTeamIds: string[] = [];
  for (const team of rotationTeams) {
    const triager = currentTriager(team.triageRotation, now);
    if (!triager) continue;
    rotationTeamIds.push(team.id);
    if (triager === viewer.id) triagerTeamIds.push(team.id);
  }
  return {
    now,
    readable,
    responsible: {
      OR: [
        { assigneeId: viewer.id },
        {
          AND: [
            { OR: [{ assigneeId: null }, { assignee: { is: { actorKind: { not: 'HUMAN' } } } }] },
            { teamId: { in: ownedTeamIds } },
          ],
        },
      ],
    },
    rotationTeamIds,
    teamKey,
    triagerTeamIds,
    viewer,
  };
}

/** Work the viewer can read, in the filtered team, not superseded and not snoozed. */
function visibleWork(scope: Scope, ...where: Prisma.IssueWhereInput[]): Prisma.IssueWhereInput {
  return {
    AND: [
      scope.readable ?? {},
      scope.teamKey ? { team: { is: { key: scope.teamKey } } } : {},
      { supersededById: null },
      { OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: scope.now } }] },
      ...where,
    ],
  };
}

async function candidates(prisma: DatabaseClient, scope: Scope): Promise<AttentionItem[]> {
  const decider: Prisma.IssueWhereInput = {
    OR: [
      { AND: [BUG_WHERE, { teamId: { in: scope.triagerTeamIds } }] },
      { AND: [scope.responsible, { NOT: { AND: [BUG_WHERE, { teamId: { in: scope.rotationTeamIds } }] } }] },
    ],
  };
  const rows = await prisma.issue.findMany({
    where: visibleWork(
      scope,
      { commitmentStatus: 'CANDIDATE' },
      // Work with a pending delivery change is decided there first; commit refuses it.
      { deliveryChanges: { none: { status: 'PENDING' } } },
      decider,
    ),
    select: { createdAt: true, id: true, labels: { select: { name: true } } },
    orderBy: { createdAt: 'asc' },
    take: KIND_LIMIT,
  });
  return rows.map((row) => {
    const isBug = row.labels.some((label) => label.name.toLowerCase() === BUG_LABEL_NAME.toLowerCase());
    return item('CANDIDATE_COMMIT', row.id, row.id, row.createdAt, isBug ? 'Bug waiting for triage' : 'Proposed work waiting to be committed or declined', ['COMMIT', 'REJECT']);
  });
}

async function reviews(prisma: DatabaseClient, scope: Scope): Promise<AttentionItem[]> {
  const rows = await prisma.issue.findMany({
    where: visibleWork(
      scope,
      { commitmentStatus: 'COMMITTED', state: { type: 'REVIEW' } },
      // Implementation units are accepted with their delivery package, at the root.
      { deliveryRootId: null },
      scope.responsible,
    ),
    select: { id: true },
    take: KIND_LIMIT,
  });
  const waits = await loadReviewWaits(prisma, rows.map((row) => row.id), scope.now);
  return rows.flatMap((row) => {
    const wait = waits.get(row.id);
    if (!wait) return [];
    return [item('WORK_REVIEW', row.id, row.id, wait.since, wait.overdue ? 'Fixed bug waiting past its review clock' : 'Finished work waiting for your review', ['ACCEPT', 'RETURN'])];
  });
}

async function amendments(prisma: DatabaseClient, scope: Scope): Promise<AttentionItem[]> {
  const rows = await prisma.contractAmendment.findMany({
    where: { status: 'PENDING', work: visibleWork(scope, { commitmentStatus: 'COMMITTED' }, scope.responsible) },
    include: { work: true },
    orderBy: { createdAt: 'asc' },
    take: KIND_LIMIT,
  });
  return rows.map((row) => {
    // The contract moved since the proposal: accepting is refused, declining still closes it.
    if (isAmendmentStale(row, row.work)) {
      return item('CONTRACT_AMENDMENT', row.id, row.workId, row.createdAt, 'Contract change is out of date: the contract was edited after it was proposed', ['REJECT']);
    }
    return item('CONTRACT_AMENDMENT', row.id, row.workId, row.createdAt, `Contract change proposed: ${row.reason}`, ['ACCEPT', 'REJECT']);
  });
}

async function deliveryChanges(prisma: DatabaseClient, scope: Scope): Promise<AttentionItem[]> {
  const rows = await prisma.deliveryChangeSet.findMany({
    where: { status: 'PENDING', work: visibleWork(scope, scope.responsible) },
    select: { createdAt: true, id: true, reason: true, workId: true },
    orderBy: { createdAt: 'asc' },
    take: KIND_LIMIT,
  });
  return rows.map((row) => item('DELIVERY_CHANGE', row.id, row.workId, row.createdAt, `Delivery change proposed: ${row.reason}`, ['APPROVE', 'DECLINE']));
}

async function agentRequests(prisma: DatabaseClient, scope: Scope): Promise<AttentionItem[]> {
  const rows = await prisma.agentRequest.findMany({
    where: {
      canceledAt: null,
      work: visibleWork(scope),
      OR: [
        // The agent asked back: the person who asked must reply.
        { requestedByActorId: scope.viewer.id, state: 'INPUT_REQUIRED' },
        // A request handed to this person: they answer it.
        { targetActorId: scope.viewer.id, state: { in: ['SUBMITTED', 'WORKING'] } },
      ],
    },
    select: { body: true, createdAt: true, id: true, needInfo: true, requestedByActor: { select: { name: true } }, state: true, updatedAt: true, workId: true },
    orderBy: { createdAt: 'asc' },
    take: KIND_LIMIT,
  });
  return rows.map((row) => {
    if (row.state === 'INPUT_REQUIRED') {
      return item('AGENT_REQUEST', row.id, row.workId, row.updatedAt, row.needInfo ? 'Your needinfo was asked back: reply before it can be answered' : 'An agent needs more from you before it can answer', ['REPLY']);
    }
    // A needinfo (INV-1119): any comment of yours on the work answers it too.
    if (row.needInfo) {
      const question = row.body.length > 140 ? `${row.body.slice(0, 139)}…` : row.body;
      return item('AGENT_REQUEST', row.id, row.workId, row.createdAt, `${row.requestedByActor.name} needs information from you: ${question}`, ['ANSWER']);
    }
    return item('AGENT_REQUEST', row.id, row.workId, row.createdAt, 'A question was handed to you to answer', ['ANSWER']);
  });
}

/**
 * A run that asked for a decision and is still going, with no word from a
 * person on the work since. The request lives only in the outbox event and
 * the notification it projected, so the notification is where it is read
 * from; whether it is still open is decided by the run and the comments.
 */
async function decisionRequests(prisma: DatabaseClient, scope: Scope): Promise<AttentionItem[]> {
  const notifications = await prisma.notification.findMany({
    where: { type: 'decision.requested', userId: scope.viewer.id, work: { is: visibleWork(scope, { state: { type: { notIn: ['COMPLETED', 'CANCELED'] } } }) } },
    select: { createdAt: true, payload: true, workId: true },
    orderBy: { createdAt: 'desc' },
    take: KIND_LIMIT,
  });
  const latestByWork = new Map<string, (typeof notifications)[number]>();
  for (const notification of notifications) {
    if (notification.workId && !latestByWork.has(notification.workId)) latestByWork.set(notification.workId, notification);
  }
  const open = [...latestByWork.entries()].flatMap(([workId, notification]) => {
    const payload = (notification.payload ?? {}) as { publicId?: unknown; summary?: unknown };
    return typeof payload.publicId === 'string' ? [{ notification, publicId: payload.publicId, summary: payload.summary, workId }] : [];
  });
  if (open.length === 0) return [];
  // Two reads for all of them: the runs still going, and people's comments since the oldest request.
  const [runs, comments] = await Promise.all([
    prisma.workRun.findMany({
      where: { publicId: { in: open.map((entry) => entry.publicId) }, status: { in: [...ACTIVE_RUN_STATUSES] } },
      select: { id: true, publicId: true, workId: true },
    }),
    prisma.comment.findMany({
      where: {
        createdAt: { gt: new Date(Math.min(...open.map((entry) => entry.notification.createdAt.getTime()))) },
        issueId: { in: open.map((entry) => entry.workId) },
        user: { actorKind: 'HUMAN' },
      },
      select: { createdAt: true, issueId: true },
    }),
  ]);
  const runByPublicId = new Map(runs.map((run) => [run.publicId, run]));
  const items: AttentionItem[] = [];
  for (const entry of open) {
    const run = runByPublicId.get(entry.publicId);
    if (!run || run.workId !== entry.workId) continue;
    const answered = comments.some((comment) => comment.issueId === entry.workId && comment.createdAt > entry.notification.createdAt);
    if (answered) continue;
    const summary = typeof entry.summary === 'string' && entry.summary.trim() ? `: ${entry.summary.trim()}` : '';
    items.push(item('DECISION_REQUESTED', run.id, entry.workId, entry.notification.createdAt, `An agent asked for a decision${summary}`, ['RESPOND']));
  }
  return items;
}

async function opsItems(prisma: DatabaseClient, scope: Scope): Promise<AttentionItem[]> {
  // Operations belong to administrators and to no team.
  if (scope.viewer.globalRole !== 'ADMIN' || scope.teamKey) return [];
  const [webhooks, deadLetters] = await Promise.all([
    prisma.webhookSubscription.findMany({
      // Switched off by the failure threshold, not by a person.
      where: { consecutiveFailures: { gte: WEBHOOK_AUTO_DISABLE_THRESHOLD }, enabled: false },
      select: { id: true, label: true, updatedAt: true, url: true },
      orderBy: { updatedAt: 'asc' },
      take: KIND_LIMIT,
    }),
    prisma.syncDeadLetter.findMany({
      select: { createdAt: true, id: true, itemRef: true, repository: true },
      orderBy: { createdAt: 'asc' },
      take: KIND_LIMIT,
    }),
  ]);
  return [
    ...webhooks.map((webhook) => item('OPS', webhook.id, null, webhook.updatedAt, `Webhook ${webhook.label ?? webhook.url} was switched off after repeated delivery failures`, ['OPEN'])),
    ...deadLetters.map((letter) => item('OPS', letter.id, null, letter.createdAt, `GitHub sync gave up on ${letter.repository} ${letter.itemRef}`, ['OPEN'])),
  ];
}

function item(
  kind: AttentionKind,
  subjectId: string,
  workId: string | null,
  since: Date,
  reason: string,
  actions: AttentionAction[],
): AttentionItem {
  return { actions, groupId: null, id: `${kind}:${subjectId}`, kind, overdue: false, reason, since, subjectId, unblocked: false, waitingOnIds: [], workId };
}

/** Fill waitingOnIds / unblocked from BLOCKS links into each item's work, in one read. */
async function assignBlockers(prisma: DatabaseClient, items: AttentionItem[]): Promise<void> {
  const workIds = [...new Set(items.flatMap((entry) => (entry.workId ? [entry.workId] : [])))];
  if (workIds.length === 0) return;
  const links = await prisma.workLink.findMany({
    where: { toId: { in: workIds }, type: 'BLOCKS' },
    select: { from: { select: { id: true, state: { select: { type: true } } } }, toId: true },
  });
  const blockers = new Map<string, Array<{ id: string; done: boolean }>>();
  for (const link of links) {
    const done = link.from.state.type === 'COMPLETED' || link.from.state.type === 'CANCELED';
    blockers.set(link.toId, [...(blockers.get(link.toId) ?? []), { done, id: link.from.id }]);
  }
  for (const entry of items) {
    const of = entry.workId ? blockers.get(entry.workId) ?? [] : [];
    entry.waitingOnIds = of.filter((blocker) => !blocker.done).map((blocker) => blocker.id);
    entry.unblocked = of.length > 0 && entry.waitingOnIds.length === 0;
  }
}

/** Fill groupId by walking parents, one query per level for the whole page. */
async function assignGroups(prisma: DatabaseClient, items: AttentionItem[]): Promise<void> {
  const workIds = [...new Set(items.flatMap((entry) => (entry.workId ? [entry.workId] : [])))];
  if (workIds.length === 0) return;
  const nodes = new Map<string, Pick<Issue, 'id' | 'kind' | 'parentId'>>();
  let frontier = workIds;
  for (let depth = 0; depth <= MAX_ANCESTOR_DEPTH && frontier.length > 0; depth += 1) {
    const rows = await prisma.issue.findMany({ where: { id: { in: frontier } }, select: { id: true, kind: true, parentId: true } });
    for (const row of rows) nodes.set(row.id, row);
    frontier = [...new Set(rows.flatMap((row) => (row.parentId && !nodes.has(row.parentId) ? [row.parentId] : [])))];
  }
  const groupOf = (workId: string): string | null => {
    let project: string | null = null;
    let current = nodes.get(workId)?.parentId ?? null;
    for (let depth = 0; current && depth <= MAX_ANCESTOR_DEPTH; depth += 1) {
      const node = nodes.get(current);
      if (!node) break;
      if (GROUP_KINDS.has(node.kind)) return node.id;
      if (node.kind === 'PROJECT') project ??= node.id;
      current = node.parentId;
    }
    return project;
  };
  for (const entry of items) {
    if (entry.workId) entry.groupId = groupOf(entry.workId);
  }
}
