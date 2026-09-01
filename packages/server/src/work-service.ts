import type { ActorKind, Issue, Prisma, PrismaClient, User } from '@prisma/client';

export interface WriteActor {
  actorId?: string | null;
  actorKind: ActorKind;
  reason?: string | null;
  sessionId?: string | null;
  sourceMessageId?: string | null;
  surface?: string | null;
}

export const INTERNAL_WRITE_ACTOR: WriteActor = {
  actorKind: 'SERVICE',
  surface: 'internal',
};

export function writeActorFromViewer(viewer: User | null, surface = 'graphql'): WriteActor {
  return {
    actorId: viewer?.id ?? null,
    actorKind: viewer?.actorKind ?? 'SERVICE',
    surface,
  };
}

type DatabaseClient = PrismaClient | Prisma.TransactionClient;

const ISSUE_SNAPSHOT_SELECT = {
  acceptance: true,
  assigneeId: true,
  commitmentStatus: true,
  constraints: true,
  cycleId: true,
  description: true,
  id: true,
  identifier: true,
  kind: true,
  outcome: true,
  parentId: true,
  priority: true,
  projectId: true,
  repository: true,
  revision: true,
  scope: true,
  stateId: true,
  title: true,
  verification: true,
} as const;

export type IssueSnapshot = Prisma.IssueGetPayload<{ select: typeof ISSUE_SNAPSHOT_SELECT }>;

export function snapshotIssue(issue: IssueSnapshot): Prisma.InputJsonValue {
  return {
    acceptance: issue.acceptance,
    assigneeId: issue.assigneeId,
    commitmentStatus: issue.commitmentStatus,
    constraints: issue.constraints,
    cycleId: issue.cycleId,
    description: issue.description,
    id: issue.id,
    identifier: issue.identifier,
    kind: issue.kind,
    outcome: issue.outcome,
    parentId: issue.parentId,
    priority: issue.priority,
    projectId: issue.projectId,
    repository: issue.repository,
    revision: issue.revision,
    scope: issue.scope,
    stateId: issue.stateId,
    title: issue.title,
    verification: issue.verification,
  };
}

export async function recordWorkAudit(
  prisma: DatabaseClient,
  input: {
    actor?: WriteActor | null;
    after: IssueSnapshot;
    before?: IssueSnapshot | null;
    workId: string;
  },
): Promise<void> {
  const actor = input.actor ?? INTERNAL_WRITE_ACTOR;
  const data: Prisma.WorkAuditUncheckedCreateInput = {
    actorId: actor.actorId ?? null,
    actorKind: actor.actorKind,
    after: snapshotIssue(input.after),
    reason: actor.reason ?? null,
    revision: input.after.revision,
    sessionId: actor.sessionId ?? null,
    sourceMessageId: actor.sourceMessageId ?? null,
    surface: actor.surface ?? null,
    workId: input.workId,
  };

  if (input.before) {
    data.before = snapshotIssue(input.before);
  }

  await prisma.workAudit.create({
    data,
  });
}

export function selectIssueSnapshot(issue: Issue): IssueSnapshot {
  return {
    acceptance: issue.acceptance,
    assigneeId: issue.assigneeId,
    commitmentStatus: issue.commitmentStatus,
    constraints: issue.constraints,
    cycleId: issue.cycleId,
    description: issue.description,
    id: issue.id,
    identifier: issue.identifier,
    kind: issue.kind,
    outcome: issue.outcome,
    parentId: issue.parentId,
    priority: issue.priority,
    projectId: issue.projectId,
    repository: issue.repository,
    revision: issue.revision,
    scope: issue.scope,
    stateId: issue.stateId,
    title: issue.title,
    verification: issue.verification,
  };
}
