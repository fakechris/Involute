import type {
  CommitmentStatus,
  Issue,
  Prisma,
  PrismaClient,
  User,
  WorkAudit,
  WorkClaim,
  WorkEvidence,
  WorkKind,
  WorkRun,
  WorkflowStateType,
} from '@prisma/client';

import { ISSUE_NOT_FOUND_MESSAGE, createNotFoundError } from './errors.js';

type DatabaseClient = PrismaClient | Prisma.TransactionClient;

export const READY_EXCLUDED_STATE_NAMES = ['In Progress', 'In Review', 'Done', 'Canceled'] as const;
export const READY_EXCLUDED_STATE_TYPES: WorkflowStateType[] = ['STARTED', 'COMPLETED', 'CANCELED'];
export const READY_EXCLUDED_LABELS = ['blocked', 'needs-clarification'] as const;
export const READY_PRIORITY_ORDER = [1, 2, 3, 4, 0] as const;
export const DEFAULT_READY_WORK_FIRST = 20;
export const MAX_READY_WORK_FIRST = 200;
export const MAX_CONTEXT_AUDITS = 20;
export const MAX_CONTEXT_RUNS = 10;

export interface ListReadyWorkInput {
  first?: number | null;
  kind?: WorkKind | null;
  priority?: number | null;
  projectId?: string | null;
  repository?: string | null;
  teamKey?: string | null;
}

export interface SearchWorkInput {
  commitmentStatus?: CommitmentStatus | null;
  first?: number | null;
  query?: string | null;
  teamKey?: string | null;
}

export interface WorkContextBundle {
  ancestors: Issue[];
  audits: Array<WorkAudit & { actor: User | null }>;
  blockedBy: Issue[];
  blocks: Issue[];
  claim: (WorkClaim & { actor: User }) | null;
  evidence: WorkEvidence[];
  runs: WorkRun[];
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

  const [ancestors, blockedBy, blocks, audits, claim, runs, evidence] = await Promise.all([
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
      orderBy: [{ createdAt: 'desc' }],
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
    work,
  };
}

export async function searchWork(
  prisma: DatabaseClient,
  input: SearchWorkInput = {},
  readableWhere?: Prisma.IssueWhereInput,
): Promise<Issue[]> {
  const first = clampFirst(input.first);
  const clauses: Prisma.IssueWhereInput[] = [];

  if (readableWhere) {
    clauses.push(readableWhere);
  }

  const query = input.query?.trim();
  if (query) {
    clauses.push({
      OR: [
        { identifier: { contains: query, mode: 'insensitive' } },
        { title: { contains: query, mode: 'insensitive' } },
        { description: { contains: query, mode: 'insensitive' } },
      ],
    });
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
  const where = combineWhere(readableWhere, buildReadyWorkWhere(input));
  const candidates = await prisma.issue.findMany({
    ...(where ? { where } : {}),
    include: {
      labels: true,
      state: true,
    },
    take: MAX_READY_WORK_FIRST + 1,
  });
  const sorted = [...candidates].sort(compareReadyWork);
  const limited = sorted.slice(0, MAX_READY_WORK_FIRST);
  const nodes = limited.slice(0, first);

  return {
    hasNextPage: limited.length > first,
    nodes,
  };
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

function buildReadyWorkWhere(input: ListReadyWorkInput): Prisma.IssueWhereInput {
  const clauses: Prisma.IssueWhereInput[] = [
    { commitmentStatus: 'COMMITTED' },
    { kind: input.kind ?? 'ISSUE' },
    {
      state: {
        is: {
          AND: [
            { type: { notIn: READY_EXCLUDED_STATE_TYPES } },
            { name: { notIn: [...READY_EXCLUDED_STATE_NAMES] } },
          ],
        },
      },
    },
    {
      incomingLinks: {
        none: {
          type: 'BLOCKS',
        },
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

  if (input.repository) {
    clauses.push({ repository: input.repository });
  }

  if (input.projectId) {
    clauses.push({ projectId: input.projectId });
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

  if (input.priority !== undefined && input.priority !== null) {
    clauses.push({ priority: input.priority });
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
