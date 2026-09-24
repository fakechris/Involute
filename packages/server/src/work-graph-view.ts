import type { Issue, Prisma, PrismaClient, WorkflowState, User, WorkLinkType } from '@prisma/client';

import { resolveProjectScope } from './project-scope.js';

type DatabaseClient = PrismaClient | Prisma.TransactionClient;

/** Upper bound on nodes one graph read returns; beyond it the view says so instead of guessing. */
export const WORK_GRAPH_NODE_LIMIT = 2000;

export type WorkGraphNode = Issue & { state: WorkflowState; assignee: User | null };

export interface WorkGraphEdge {
  id: string;
  type: WorkLinkType;
  fromId: string;
  toId: string;
}

export interface ProjectWorkGraph {
  root: WorkGraphNode | null;
  repository: string | null;
  /** Work inside the project: its CONTAINS subtree, or everything declaring its repository. */
  nodes: WorkGraphNode[];
  /**
   * Readable work outside the project that a project item links to (a BLOCKS
   * edge may cross projects in the same team). Shown, never counted as scope.
   */
  externalNodes: WorkGraphNode[];
  edges: WorkGraphEdge[];
  truncated: boolean;
}

const NODE_INCLUDE = { state: true, assignee: true } as const;

/**
 * One project's work graph for the /graph view (INV-681): every node the
 * project resolves to plus every typed link touching them. Resolution is the
 * same `resolveProjectScope` the ready queue uses, so the picture and the
 * claimable set cannot disagree about what belongs to the project.
 */
export async function loadProjectWorkGraph(
  prisma: DatabaseClient,
  input: { project: string; includeCandidates?: boolean | null },
  readableWhere?: Prisma.IssueWhereInput,
): Promise<ProjectWorkGraph> {
  const project = input.project.trim();
  const scope = await resolveProjectScope(
    prisma,
    project.includes('/') ? { repository: project } : { projectId: project },
    readableWhere,
  );
  if (!scope) {
    return { root: null, repository: null, nodes: [], externalNodes: [], edges: [], truncated: false };
  }

  const commitment: Prisma.IssueWhereInput = input.includeCandidates
    ? { commitmentStatus: { not: 'REJECTED' } }
    : { commitmentStatus: 'COMMITTED' };
  const visible: Prisma.IssueWhereInput = { AND: [readableWhere ?? {}, commitment] };

  const scoped = await prisma.issue.findMany({
    where: { AND: [scope.where, visible] },
    include: NODE_INCLUDE,
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: WORK_GRAPH_NODE_LIMIT + 1,
  });
  const truncated = scoped.length > WORK_GRAPH_NODE_LIMIT;
  const nodes = scoped.slice(0, WORK_GRAPH_NODE_LIMIT);

  // The root always anchors the outline even when it is outside the scope
  // filter (a subtree scope includes it; a repository scope may not).
  let root = scope.rootId ? nodes.find((node) => node.id === scope.rootId) ?? null : null;
  if (scope.rootId && !root) {
    root = await prisma.issue.findFirst({
      where: { AND: [{ id: scope.rootId }, readableWhere ?? {}] },
      include: NODE_INCLUDE,
    });
    if (root) nodes.unshift(root);
  }

  const nodeIds = nodes.map((node) => node.id);
  const links = nodeIds.length
    ? await prisma.workLink.findMany({
        where: { OR: [{ fromId: { in: nodeIds } }, { toId: { in: nodeIds } }] },
        select: { id: true, type: true, fromId: true, toId: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      })
    : [];

  const inScope = new Set(nodeIds);
  const outsideIds = [
    ...new Set(links.flatMap((link) => [link.fromId, link.toId]).filter((id) => !inScope.has(id))),
  ];
  const externalNodes = outsideIds.length
    ? await prisma.issue.findMany({
        where: { AND: [{ id: { in: outsideIds } }, visible] },
        include: NODE_INCLUDE,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      })
    : [];

  // An edge is only returned when both ends are visible to this viewer.
  const known = new Set([...nodeIds, ...externalNodes.map((node) => node.id)]);
  const edges = links.filter((link) => known.has(link.fromId) && known.has(link.toId));

  return { root, repository: scope.repository, nodes, externalNodes, edges, truncated };
}
