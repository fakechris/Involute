import type {
  Issue,
  Prisma,
  PrismaClient,
  WorkEvidenceKind,
  WorkRun,
  WorkRunStatus,
  WorkReviewDecisionKind,
} from '@prisma/client';

import { findWorkByIdOrIdentifier } from './context-service.js';
import {
  createNotFoundError,
  createValidationError,
  ISSUE_NOT_FOUND_MESSAGE,
  WORK_EVIDENCE_KIND_INVALID_MESSAGE,
  WORK_RUN_STATUS_INVALID_MESSAGE,
} from './errors.js';

export type DatabaseClient = PrismaClient | Prisma.TransactionClient;

export const TERMINAL_RUN_STATUSES: WorkRunStatus[] = ['COMPLETED', 'FAILED'];
export const ALLOWED_RUN_TRANSITIONS: Record<WorkRunStatus, readonly WorkRunStatus[]> = {
  QUEUED: ['RUNNING', 'BLOCKED', 'COMPLETED', 'FAILED'],
  RUNNING: ['BLOCKED', 'COMPLETED', 'FAILED'],
  BLOCKED: ['RUNNING', 'COMPLETED', 'FAILED'],
  COMPLETED: [],
  FAILED: [],
};

export interface ReportRunInput {
  decisionRequested?: boolean | null;
  externalUrl?: string | null;
  idempotencyKey?: string | null;
  phase?: string | null;
  runId?: string | null;
  status?: string | null;
  summary?: string | null;
  workId: string;
}

export interface AttachEvidenceInput {
  idempotencyKey?: string | null;
  kind: string;
  runId?: string | null;
  summary?: string | null;
  url: string;
  workId: string;
}

export interface ReviewWorkInput {
  decision: WorkReviewDecisionKind;
  expectedRevision: number;
  idempotencyKey?: string | null;
  reason?: string | null;
  runId?: string | null;
}

export async function nextRunPublicId(prisma: DatabaseClient): Promise<string> {
  const sequence = await prisma.appSequence.upsert({
    where: { name: 'work_run' },
    create: { name: 'work_run', value: 1 },
    update: { value: { increment: 1 } },
  });

  return `RUN-${sequence.value}`;
}

export async function findRun(
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

export async function requireWork(prisma: DatabaseClient, id: string): Promise<Issue> {
  const work = await findWorkByIdOrIdentifier(prisma, id);
  if (!work) {
    throw createNotFoundError(ISSUE_NOT_FOUND_MESSAGE);
  }
  return work;
}

export function parseRunStatus(value: string | null | undefined): WorkRunStatus | null {
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

export function parseEvidenceKind(value: string): WorkEvidenceKind {
  const normalized = value.trim().toUpperCase();
  const allowed: WorkEvidenceKind[] = ['PR', 'TEST', 'LOG', 'SCREENSHOT', 'ARTIFACT', 'DECISION'];
  if (!allowed.includes(normalized as WorkEvidenceKind)) {
    throw createValidationError(WORK_EVIDENCE_KIND_INVALID_MESSAGE);
  }
  return normalized as WorkEvidenceKind;
}

export function eventTypeForRun(
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
