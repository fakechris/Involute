import type {
  ContractAmendment,
  CommitmentStatus,
  Issue,
  Prisma,
  PrismaClient,
  User,
  WorkAudit,
  WorkClaim,
  WorkEvidence,
  EvidenceVerification,
  WorkKind,
  WorkRun,
  WorkReviewDecision,
  WorkflowStateType,
} from '@prisma/client';

import {
  ISSUE_NOT_FOUND_MESSAGE,
  WORK_NOT_READY_ACCEPTANCE_MESSAGE,
  WORK_NOT_READY_BLOCKED_MESSAGE,
  WORK_NOT_READY_LABEL_MESSAGE,
  WORK_NOT_READY_MESSAGE,
  WORK_NOT_READY_OWNER_MESSAGE,
  WORK_NOT_READY_STATE_MESSAGE,
  createNotFoundError,
} from './errors.js';
import { resolveProjectScope } from './project-scope.js';
import { compileIqlToIssueWhere, parseIqlOrThrow } from './iql-compile.js';
import type { SemanticIndex } from './embeddings/semantic-index.js';
import { searchIssues, type SearchField } from './issue-search.js';

type DatabaseClient = PrismaClient | Prisma.TransactionClient;

/**
 * An incoming BLOCKS link whose blocker still holds the work back: committed
 * and neither Done nor Canceled. The ready queue excludes work with any such
 * link, and the board shows the same set as the card's blocked marker (INV-679).
 */
export const OPEN_BLOCKER_LINK_WHERE = {
  type: 'BLOCKS',
  from: {
    commitmentStatus: 'COMMITTED',
    state: { type: { notIn: ['COMPLETED', 'CANCELED'] } },
  },
} satisfies Prisma.WorkLinkWhereInput;

export const READY_EXCLUDED_STATE_NAMES = ['In Progress', 'In Review', 'Done', 'Canceled'] as const;
export const READY_EXCLUDED_STATE_TYPES: WorkflowStateType[] = ['STARTED', 'REVIEW', 'COMPLETED', 'CANCELED'];
export const READY_EXCLUDED_LABELS = ['blocked', 'needs-clarification'] as const;
export const READY_PRIORITY_ORDER = [1, 2, 3, 4, 0] as const;
export const DEFAULT_READY_WORK_FIRST = 20;
export const MAX_READY_WORK_FIRST = 200;
export const MAX_CONTEXT_AUDITS = 20;
export const MAX_CONTEXT_RUNS = 10;

export interface ListReadyWorkInput {
  first?: number | null;
  /** IQL filter string (see packages/shared/src/iql.ts). */
  iql?: string | null;
  kind?: WorkKind | null;
  priority?: number | null;
  projectId?: string | null;
  repository?: string | null;
  teamKey?: string | null;
  /** Resolves `assignee:me` in IQL terms; set by the calling surface. */
  viewerId?: string | null;
}

export interface SearchWorkInput {
  commitmentStatus?: CommitmentStatus | null;
  first?: number | null;
  /** IQL filter string; the plain `query` stays free-text search. */
  iql?: string | null;
  query?: string | null;
  /** Only work in this project (its repository, e.g. fakechris/Involute). */
  repository?: string | null;
  teamKey?: string | null;
  /** Resolves `assignee:me` in IQL terms; set by the calling surface. */
  viewerId?: string | null;
}

export interface WorkContextBundle {
  ancestors: Issue[];
  audits: Array<WorkAudit & { actor: User | null }>;
  blockedBy: Issue[];
  blocks: Issue[];
  claim: (WorkClaim & { actor: User }) | null;
  evidence: Array<WorkEvidence & { verifications: EvidenceVerification[] }>;
  runs: WorkRun[];
  reviewDecisions: Array<WorkReviewDecision & { reviewer: User }>;
  /** Proposed changes to the committed contract and what a person decided (INV-869), newest first. */
  contractAmendments: ContractAmendment[];
  work: Issue;
}

export async function findWorkByIdOrIdentifier(
  prisma: DatabaseClient,
  id: string,
): Promise<Issue | null> {
  try {
    const byId = await prisma.issue.findUnique({
      where: { id },
    });

    if (byId) {
      return byId;
    }
  } catch {
    // Non-UUID identifiers fall through to the business-key lookup.
  }

  return prisma.issue.findUnique({
    where: { identifier: id },
  });
}

export async function getWorkContext(
  prisma: DatabaseClient,
  id: string,
): Promise<WorkContextBundle> {
  const work = await findWorkByIdOrIdentifier(prisma, id);

  if (!work) {
    throw createNotFoundError(ISSUE_NOT_FOUND_MESSAGE);
  }

  const [ancestors, blockedBy, blocks, audits, claim, runs, evidence, reviewDecisions, contractAmendments] = await Promise.all([
    loadAncestors(prisma, work),
    loadLinkedIssues(prisma, work.id, 'BLOCKS', 'incoming'),
    loadLinkedIssues(prisma, work.id, 'BLOCKS', 'outgoing'),
    prisma.workAudit.findMany({
      where: { workId: work.id },
      include: { actor: true },
      orderBy: [{ createdAt: 'desc' }, { revision: 'desc' }],
      take: MAX_CONTEXT_AUDITS,
    }),
    prisma.workClaim.findUnique({
      where: { workId: work.id },
      include: { actor: true },
    }),
    prisma.workRun.findMany({
      where: { workId: work.id },
      orderBy: [{ createdAt: 'desc' }],
      take: MAX_CONTEXT_RUNS,
    }),
    prisma.workEvidence.findMany({
      where: { workId: work.id },
      include: { verifications: { orderBy: { createdAt: 'desc' }, take: 10 } },
      orderBy: [{ createdAt: 'desc' }],
      take: MAX_CONTEXT_RUNS,
    }),
    prisma.workReviewDecision.findMany({
      where: { workId: work.id },
      include: { reviewer: true, run: true },
      orderBy: { createdAt: 'desc' },
      take: MAX_CONTEXT_RUNS,
    }),
    prisma.contractAmendment.findMany({
      where: { workId: work.id },
      orderBy: { createdAt: 'desc' },
      take: MAX_CONTEXT_RUNS,
    }),
  ]);

  return {
    ancestors,
    audits,
    blockedBy,
    blocks,
    claim,
    evidence,
    runs,
    reviewDecisions,
    contractAmendments,
    work,
  };
}

export interface SearchWorkMatch {
  field: SearchField;
  snippet: string | null;
  commentId: string | null;
}

export async function searchWork(
  prisma: DatabaseClient,
  input: SearchWorkInput = {},
  readableWhere?: Prisma.IssueWhereInput,
  semantic?: SemanticIndex | null,
): Promise<Array<Issue & { match?: SearchWorkMatch }>> {
  const first = clampFirst(input.first);
  const clauses: Prisma.IssueWhereInput[] = [];

  if (input.iql?.trim()) {
    const parsed = parseIqlOrThrow(input.iql);
    const compiled = compileIqlToIssueWhere(parsed, { viewerId: input.viewerId ?? null });
    if (compiled) {
      clauses.push(compiled);
    }
  }

  if (input.teamKey) {
    clauses.push({
      team: {
        is: {
          key: input.teamKey,
        },
      },
    });
  }

  if (input.commitmentStatus) {
    clauses.push({ commitmentStatus: input.commitmentStatus });
  }

  if (input.repository) {
    clauses.push({ repository: input.repository });
  }

  // Free text goes through the same ranked search as the web (INV-925).
  const query = input.query?.trim();
  if (query) {
    const hits = await searchIssues(
      prisma,
      { query, first, where: clauses.length > 0 ? { AND: clauses } : null },
      readableWhere,
      semantic,
    );
    return hits.map(({ issue: { state: _state, ...issue }, matchedField, snippet, commentId }) => ({
      ...issue,
      match: { field: matchedField, snippet, commentId },
    }));
  }

  if (readableWhere) {
    clauses.push(readableWhere);
  }

  return prisma.issue.findMany({
    ...(clauses.length > 0 ? { where: { AND: clauses } } : {}),
    orderBy: [{ updatedAt: 'desc' }, { identifier: 'asc' }],
    take: first,
  });
}

export async function listReadyWork(
  prisma: DatabaseClient,
  input: ListReadyWorkInput = {},
  readableWhere?: Prisma.IssueWhereInput,
): Promise<{ hasNextPage: boolean; nodes: Issue[] }> {
  const first = clampFirst(input.first);
  const iqlWhere = input.iql?.trim()
    ? compileIqlToIssueWhere(parseIqlOrThrow(input.iql), { viewerId: input.viewerId ?? null })
    : undefined;
  const scope = await resolveProjectScope(prisma, input, readableWhere);
  const baseWhere: Prisma.IssueWhereInput = {
    AND: [readableWhere ?? {}, iqlWhere ?? {}, scope?.where ?? {}, buildReadyWorkWhere(input)],
  };
  const priorities: Array<number | 'other'> = input.priority !== undefined && input.priority !== null
    ? [input.priority]
    : [...READY_PRIORITY_ORDER, 'other'];
  const ordered: Issue[] = [];

  for (const priority of priorities) {
    const remaining = first + 1 - ordered.length;
    if (remaining <= 0) break;
    const priorityWhere: Prisma.IssueWhereInput = priority === 'other'
      ? { priority: { notIn: [...READY_PRIORITY_ORDER] } }
      : { priority };
    const batch = await prisma.issue.findMany({
      where: combineWhere(baseWhere, priorityWhere),
      orderBy: [{ updatedAt: 'desc' }, { identifier: 'asc' }],
      take: remaining,
    });
    ordered.push(...batch);
  }
  const nodes = ordered.slice(0, first);

  return {
    hasNextPage: ordered.length > first,
    nodes,
  };
}

export async function isWorkReadyForClaim(
  prisma: DatabaseClient,
  workId: string,
): Promise<boolean> {
  return Boolean(await prisma.issue.findFirst({
    where: combineWhere({ id: workId }, buildReadyWorkWhere({}, { allowStarted: true })),
    select: { id: true },
  }));
}

/**
 * The first readiness rule this work fails, as a refusal that says what to do
 * (INV-808). Mirrors buildReadyWorkWhere; the generic message is the fallback
 * if the two ever drift apart.
 */
export async function explainWorkNotReady(prisma: DatabaseClient, workId: string): Promise<string> {
  const work = await prisma.issue.findUnique({
    where: { id: workId },
    select: {
      acceptance: true,
      assignee: { select: { actorKind: true } },
      labels: { select: { name: true } },
      state: { select: { type: true } },
    },
  });
  if (!work) return WORK_NOT_READY_MESSAGE;
  if (work.state.type !== 'UNSTARTED' && work.state.type !== 'STARTED') return WORK_NOT_READY_STATE_MESSAGE;
  if (work.acceptance === null) return WORK_NOT_READY_ACCEPTANCE_MESSAGE;
  if (work.assignee?.actorKind !== 'HUMAN') return WORK_NOT_READY_OWNER_MESSAGE;
  if (await prisma.workLink.count({ where: { toId: workId, ...OPEN_BLOCKER_LINK_WHERE } })) return WORK_NOT_READY_BLOCKED_MESSAGE;
  if (work.labels.some((label) => (READY_EXCLUDED_LABELS as readonly string[]).includes(label.name))) return WORK_NOT_READY_LABEL_MESSAGE;
  return WORK_NOT_READY_MESSAGE;
}

export function compareReadyWork(
  left: Pick<Issue, 'identifier' | 'priority' | 'updatedAt'>,
  right: Pick<Issue, 'identifier' | 'priority' | 'updatedAt'>,
): number {
  const leftRank = readyPriorityRank(left.priority);
  const rightRank = readyPriorityRank(right.priority);

  if (leftRank !== rightRank) {
    return leftRank - rightRank;
  }

  const updatedDelta = right.updatedAt.getTime() - left.updatedAt.getTime();

  if (updatedDelta !== 0) {
    return updatedDelta;
  }

  return left.identifier.localeCompare(right.identifier);
}

function buildReadyWorkWhere(input: ListReadyWorkInput, options?: { allowStarted?: boolean }): Prisma.IssueWhereInput {
  const clauses: Prisma.IssueWhereInput[] = [
    { commitmentStatus: 'COMMITTED' },
    { acceptance: { not: null } },
    { assignee: { is: { actorKind: 'HUMAN' } } },
    {
      state: {
        is: {
          type: options?.allowStarted ? { in: ['UNSTARTED', 'STARTED'] } : 'UNSTARTED',
        },
      },
    },
    {
      incomingLinks: {
        none: OPEN_BLOCKER_LINK_WHERE,
      },
    },
    {
      labels: {
        none: {
          name: {
            in: [...READY_EXCLUDED_LABELS],
          },
        },
      },
    },
    {
      OR: [
        { claim: null },
        {
          claim: {
            is: {
              leaseUntil: { lte: new Date() },
            },
          },
        },
      ],
    },
  ];

  if (input.kind) {
    clauses.push({ kind: input.kind });
  }

  if (input.teamKey) {
    clauses.push({
      team: {
        is: {
          key: input.teamKey,
        },
      },
    });
  }

  return { AND: clauses };
}

async function loadAncestors(prisma: DatabaseClient, work: Issue): Promise<Issue[]> {
  const ancestors: Issue[] = [];
  const visited = new Set<string>([work.id]);
  let current = work;

  while (true) {
    const parentId = await resolveContainsParentId(prisma, current);

    if (!parentId || visited.has(parentId)) {
      break;
    }

    const parent = await prisma.issue.findUnique({
      where: { id: parentId },
    });

    if (!parent) {
      break;
    }

    visited.add(parent.id);
    ancestors.push(parent);
    current = parent;
  }

  return ancestors.reverse();
}

async function resolveContainsParentId(
  prisma: DatabaseClient,
  work: Pick<Issue, 'id' | 'parentId'>,
): Promise<string | null> {
  if (work.parentId) {
    return work.parentId;
  }

  const contains = await prisma.workLink.findFirst({
    where: {
      toId: work.id,
      type: 'CONTAINS',
    },
    select: {
      fromId: true,
    },
  });

  return contains?.fromId ?? null;
}

async function loadLinkedIssues(
  prisma: DatabaseClient,
  workId: string,
  type: 'BLOCKS',
  direction: 'incoming' | 'outgoing',
): Promise<Issue[]> {
  const links = await prisma.workLink.findMany({
    where:
      direction === 'incoming'
        ? { toId: workId, type }
        : { fromId: workId, type },
    select: {
      fromId: true,
      toId: true,
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const ids = links.map((link) => (direction === 'incoming' ? link.fromId : link.toId));

  if (ids.length === 0) {
    return [];
  }

  const issues = await prisma.issue.findMany({
    where: {
      id: { in: ids },
    },
  });
  const issuesById = new Map(issues.map((issue) => [issue.id, issue]));

  return ids
    .map((id) => issuesById.get(id))
    .filter((issue): issue is Issue => Boolean(issue));
}

function readyPriorityRank(priority: number): number {
  const index = READY_PRIORITY_ORDER.indexOf(priority as (typeof READY_PRIORITY_ORDER)[number]);
  return index === -1 ? READY_PRIORITY_ORDER.length : index;
}

function clampFirst(first: number | null | undefined): number {
  if (first === undefined || first === null || !Number.isFinite(first) || first < 1) {
    return DEFAULT_READY_WORK_FIRST;
  }

  return Math.min(Math.floor(first), MAX_READY_WORK_FIRST);
}

function combineWhere(
  left: Prisma.IssueWhereInput | undefined,
  right: Prisma.IssueWhereInput,
): Prisma.IssueWhereInput {
  if (!left) {
    return right;
  }

  return {
    AND: [left, right],
  };
}
