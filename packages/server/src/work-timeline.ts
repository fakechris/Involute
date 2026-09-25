import { Prisma, type PrismaClient, type WorkflowStateType } from '@prisma/client';

type DatabaseClient = PrismaClient | Prisma.TransactionClient;

/**
 * FULL: the audit trail starts at creation, so every transition is known.
 * PARTIAL: auditing began after creation (or missed a write); what is known is
 * shown, and the state before the first audit has no start time.
 * NONE: no audit rows at all (imported / pre-audit work); only the current
 * state is known and no dates are invented for it.
 */
export type HistoryCompleteness = 'FULL' | 'PARTIAL' | 'NONE';

export interface StateTransition {
  at: Date;
  stateId: string;
  stateName: string;
  stateType: WorkflowStateType;
}

export interface WorkTimelineEntry {
  workId: string;
  committedAt: Date | null;
  /** First entry into In Progress, In Review or Done — work had begun by then. */
  startedAt: Date | null;
  reviewAt: Date | null;
  /** Entry into the current Done spell; null once reopened. */
  completedAt: Date | null;
  canceledAt: Date | null;
  transitions: StateTransition[];
  history: HistoryCompleteness;
}

export interface AuditPoint {
  at: Date;
  beforeStateId: string | null;
  afterStateId: string | null;
  afterCommitment: string | null;
  /** True for the row written when the work was created (no `before`). */
  isCreation: boolean;
}

export interface TimelineSubject {
  id: string;
  stateId: string;
  commitmentStatus: string;
  updatedAt: Date;
}

const UNDER_WAY: ReadonlySet<WorkflowStateType> = new Set(['STARTED', 'REVIEW', 'COMPLETED']);

/**
 * Turns one work item's audit rows into its actual path through the workflow
 * (INV-682). Pure: every rule here is unit-tested on its own.
 */
export function deriveTimeline(
  subject: TimelineSubject,
  audits: AuditPoint[],
  states: Map<string, { name: string; type: WorkflowStateType }>,
): WorkTimelineEntry {
  const empty: WorkTimelineEntry = {
    workId: subject.id,
    committedAt: null,
    startedAt: null,
    reviewAt: null,
    completedAt: null,
    canceledAt: null,
    transitions: [],
    history: 'NONE',
  };
  if (audits.length === 0) return empty;

  const ordered = [...audits].sort((left, right) => left.at.getTime() - right.at.getTime());
  const transitions: StateTransition[] = [];
  const push = (at: Date, stateId: string | null) => {
    if (!stateId) return;
    const state = states.get(stateId);
    if (!state) return;
    if (transitions.at(-1)?.stateId === stateId) return;
    transitions.push({ at, stateId, stateName: state.name, stateType: state.type });
  };

  const history: HistoryCompleteness = ordered[0]!.isCreation ? 'FULL' : 'PARTIAL';
  let lastStateId: string | null = null;
  let committedAt: Date | null = null;
  for (const audit of ordered) {
    // A state change the trail missed shows up as a `before` that differs
    // from what we last saw; its time is unknown, so it is not invented.
    if (lastStateId === null && audit.beforeStateId && audit.beforeStateId !== audit.afterStateId) {
      lastStateId = audit.beforeStateId;
    }
    if (audit.afterStateId && audit.afterStateId !== lastStateId) {
      push(audit.at, audit.afterStateId);
      lastStateId = audit.afterStateId;
    }
    if (!committedAt && audit.afterCommitment === 'COMMITTED') committedAt = audit.at;
  }

  let completeness = history;
  // The live row is the truth: if it moved without an audit, record the move
  // at the last write we know of and mark the history incomplete.
  if (subject.stateId !== lastStateId) {
    push(subject.updatedAt, subject.stateId);
    completeness = 'PARTIAL';
  }

  const firstInto = (types: ReadonlySet<WorkflowStateType>) =>
    transitions.find((transition) => types.has(transition.stateType))?.at ?? null;
  const current = transitions.at(-1);
  const currentSpellStart = (type: WorkflowStateType) => {
    if (current?.stateType !== type) return null;
    let index = transitions.length - 1;
    while (index > 0 && transitions[index - 1]!.stateType === type) index -= 1;
    return transitions[index]!.at;
  };

  return {
    workId: subject.id,
    committedAt: committedAt ?? (subject.commitmentStatus === 'COMMITTED' && history === 'FULL' ? ordered[0]!.at : null),
    startedAt: firstInto(UNDER_WAY),
    reviewAt: firstInto(new Set(['REVIEW'])),
    completedAt: currentSpellStart('COMPLETED'),
    canceledAt: currentSpellStart('CANCELED'),
    transitions,
    history: completeness,
  };
}

interface AuditRow {
  workId: string;
  createdAt: Date;
  beforeStateId: string | null;
  afterStateId: string | null;
  afterCommitment: string | null;
  isCreation: boolean;
}

/**
 * Timelines for a set of work items in two reads: their audit rows (only the
 * state and commitment fields pulled out of the JSON snapshots, never the
 * description text) and the workflow states they reference.
 */
export async function loadWorkTimelines(
  prisma: DatabaseClient,
  subjects: TimelineSubject[],
): Promise<WorkTimelineEntry[]> {
  if (subjects.length === 0) return [];
  const ids = subjects.map((subject) => subject.id);
  const rows = await prisma.$queryRaw<AuditRow[]>(Prisma.sql`
    SELECT "workId",
           "createdAt",
           "before"->>'stateId' AS "beforeStateId",
           "after"->>'stateId' AS "afterStateId",
           "after"->>'commitmentStatus' AS "afterCommitment",
           ("before" IS NULL) AS "isCreation"
    FROM "WorkAudit"
    WHERE "workId" IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})
    ORDER BY "workId", "createdAt", "revision"
  `);

  const stateIds = new Set(subjects.map((subject) => subject.stateId));
  for (const row of rows) {
    if (row.afterStateId) stateIds.add(row.afterStateId);
    if (row.beforeStateId) stateIds.add(row.beforeStateId);
  }
  const workflowStates = await prisma.workflowState.findMany({
    where: { id: { in: [...stateIds].filter((id) => /^[0-9a-f-]{36}$/i.test(id)) } },
    select: { id: true, name: true, type: true },
  });
  const states = new Map(workflowStates.map((state) => [state.id, { name: state.name, type: state.type }]));

  const byWork = new Map<string, AuditPoint[]>();
  for (const row of rows) {
    const points = byWork.get(row.workId) ?? [];
    points.push({
      at: row.createdAt,
      beforeStateId: row.beforeStateId,
      afterStateId: row.afterStateId,
      afterCommitment: row.afterCommitment,
      isCreation: row.isCreation,
    });
    byWork.set(row.workId, points);
  }
  return subjects.map((subject) => deriveTimeline(subject, byWork.get(subject.id) ?? [], states));
}
