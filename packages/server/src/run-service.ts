import type { Issue, Prisma, PrismaClient, WorkEvidence, WorkEvidenceKind, WorkRun, WorkRunStatus } from '@prisma/client';

import { findWorkByIdOrIdentifier } from './context-service.js';
import { enqueueWorkEvent } from './event-outbox.js';
import {
  createNotFoundError,
  createValidationError,
  ISSUE_NOT_FOUND_MESSAGE,
  WORK_EVIDENCE_KIND_INVALID_MESSAGE,
  WORK_RUN_NOT_FOUND_MESSAGE,
  WORK_RUN_STATUS_INVALID_MESSAGE,
} from './errors.js';
import type { WriteActor } from './work-service.js';

type DatabaseClient = PrismaClient | Prisma.TransactionClient;

const TERMINAL_RUN_STATUSES: WorkRunStatus[] = ['COMPLETED', 'FAILED'];
const REVIEW_STATE_NAME = 'In Review';
const DONE_STATE_NAMES = new Set(['Done', 'Canceled']);

export interface ReportRunInput {
  decisionRequested?: boolean | null;
  externalUrl?: string | null;
  phase?: string | null;
  runId?: string | null;
  status?: string | null;
  summary?: string | null;
  workId: string;
}

export interface AttachEvidenceInput {
  kind: string;
  runId?: string | null;
  summary?: string | null;
  url: string;
  workId: string;
}

export async function reportRun(
  prisma: PrismaClient,
  input: ReportRunInput,
  actor: WriteActor,
): Promise<{ run: WorkRun; work: Issue }> {
  return prisma.$transaction(async (transaction) => {
    const work = await requireWork(transaction, input.workId);
    const status = parseRunStatus(input.status);
    let run = input.runId ? await findRun(transaction, input.runId, work.id) : null;

    if (input.runId && !run) {
      throw createNotFoundError(WORK_RUN_NOT_FOUND_MESSAGE);
    }

    const isNew = !run;
    if (!run) {
      const publicId = await nextRunPublicId(transaction);
      run = await transaction.workRun.create({
        data: {
          actorId: actor.actorId ?? null,
          externalUrl: input.externalUrl ?? null,
          phase: input.phase ?? null,
          publicId,
          status: status ?? 'RUNNING',
          summary: input.summary ?? null,
          workId: work.id,
          ...(status && TERMINAL_RUN_STATUSES.includes(status) ? { endedAt: new Date() } : {}),
        },
      });
    } else {
      run = await transaction.workRun.update({
        where: { id: run.id },
        data: {
          ...(status ? { status } : {}),
          ...(input.phase !== undefined ? { phase: input.phase } : {}),
          ...(input.summary !== undefined ? { summary: input.summary } : {}),
          ...(input.externalUrl !== undefined ? { externalUrl: input.externalUrl } : {}),
          ...(status && TERMINAL_RUN_STATUSES.includes(status) ? { endedAt: new Date() } : {}),
        },
      });
    }

    const eventType = eventTypeForRun(isNew, run.status, input.decisionRequested);
    if (eventType) {
      await enqueueWorkEvent(transaction, {
        payload: {
          runId: run.id,
          publicId: run.publicId,
          status: run.status,
          phase: run.phase,
          summary: run.summary,
          externalUrl: run.externalUrl,
        },
        type: eventType,
        workId: work.id,
        workIdentifier: work.identifier,
      });
    }

    let nextWork = work;
    if (run.status === 'COMPLETED') {
      nextWork = await moveToInReview(transaction, work);
    }

    return { run, work: nextWork };
  });
}

export async function attachEvidence(
  prisma: PrismaClient,
  input: AttachEvidenceInput,
  actor: WriteActor,
): Promise<{ evidence: WorkEvidence; work: Issue }> {
  const kind = parseEvidenceKind(input.kind);

  return prisma.$transaction(async (transaction) => {
    const work = await requireWork(transaction, input.workId);
    let runId: string | null = null;

    if (input.runId) {
      const run = await findRun(transaction, input.runId, work.id);
      if (!run) {
        throw createNotFoundError(WORK_RUN_NOT_FOUND_MESSAGE);
      }
      runId = run.id;
    }

    const evidence = await transaction.workEvidence.create({
      data: {
        kind,
        runId,
        summary: input.summary ?? null,
        url: input.url,
        workId: work.id,
      },
    });

    await enqueueWorkEvent(transaction, {
      payload: {
        evidenceId: evidence.id,
        kind: evidence.kind,
        url: evidence.url,
        summary: evidence.summary,
        runId: evidence.runId,
        actorId: actor.actorId ?? null,
      },
      type: 'artifact.attached',
      workId: work.id,
      workIdentifier: work.identifier,
    });

    const nextWork = await moveToInReview(transaction, work);
    return { evidence, work: nextWork };
  });
}

async function moveToInReview(prisma: DatabaseClient, work: Issue): Promise<Issue> {
  const currentState = await prisma.workflowState.findUnique({
    where: { id: work.stateId },
    select: { name: true },
  });

  if (!currentState || currentState.name === REVIEW_STATE_NAME || DONE_STATE_NAMES.has(currentState.name)) {
    return work;
  }

  const reviewState = await prisma.workflowState.findFirst({
    where: {
      teamId: work.teamId,
      name: REVIEW_STATE_NAME,
    },
    select: { id: true },
  });

  if (!reviewState) {
    return work;
  }

  return prisma.issue.update({
    where: { id: work.id },
    data: {
      revision: { increment: 1 },
      stateId: reviewState.id,
    },
  });
}

async function nextRunPublicId(prisma: DatabaseClient): Promise<string> {
  const sequence = await prisma.appSequence.upsert({
    where: { name: 'work_run' },
    create: { name: 'work_run', value: 1 },
    update: { value: { increment: 1 } },
  });

  return `RUN-${sequence.value}`;
}

async function findRun(
  prisma: DatabaseClient,
  runId: string,
  workId: string,
): Promise<WorkRun | null> {
  const byPublicId = await prisma.workRun.findFirst({
    where: {
      workId,
      publicId: runId,
    },
  });

  if (byPublicId) {
    return byPublicId;
  }

  try {
    return await prisma.workRun.findFirst({
      where: {
        workId,
        id: runId,
      },
    });
  } catch {
    return null;
  }
}

async function requireWork(prisma: DatabaseClient, id: string): Promise<Issue> {
  const work = await findWorkByIdOrIdentifier(prisma, id);
  if (!work) {
    throw createNotFoundError(ISSUE_NOT_FOUND_MESSAGE);
  }
  return work;
}

function parseRunStatus(value: string | null | undefined): WorkRunStatus | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim().toUpperCase();
  const allowed: WorkRunStatus[] = ['QUEUED', 'RUNNING', 'BLOCKED', 'COMPLETED', 'FAILED'];
  if (!allowed.includes(normalized as WorkRunStatus)) {
    throw createValidationError(WORK_RUN_STATUS_INVALID_MESSAGE);
  }
  return normalized as WorkRunStatus;
}

function parseEvidenceKind(value: string): WorkEvidenceKind {
  const normalized = value.trim().toUpperCase();
  const allowed: WorkEvidenceKind[] = ['PR', 'TEST', 'LOG', 'SCREENSHOT', 'ARTIFACT', 'DECISION'];
  if (!allowed.includes(normalized as WorkEvidenceKind)) {
    throw createValidationError(WORK_EVIDENCE_KIND_INVALID_MESSAGE);
  }
  return normalized as WorkEvidenceKind;
}

function eventTypeForRun(
  isNew: boolean,
  status: WorkRunStatus,
  decisionRequested?: boolean | null,
): 'run.started' | 'run.blocked' | 'run.completed' | 'decision.requested' | null {
  if (decisionRequested) {
    return 'decision.requested';
  }
  if (status === 'COMPLETED') {
    return 'run.completed';
  }
  if (status === 'BLOCKED') {
    return 'run.blocked';
  }
  if (isNew) {
    return 'run.started';
  }
  return null;
}
