import type { Issue, IssueLabel, Prisma, PrismaClient, WorkEvidence, WorkRun } from '@prisma/client';
import type { SemanticIndex } from './embeddings/semantic-index.js';
import { findSimilarByMeaning, SIMILAR_BUG_SIMILARITY } from './embeddings/similar-work.js';

import { placeNewWork } from './claim-service.js';
import {
  BUG_REPORT_PRIORITY_REQUIRED_MESSAGE,
  BUG_REPORT_STEPS_REQUIRED_MESSAGE,
  createValidationError,
} from './errors.js';
import { enqueueWorkEvent } from './event-outbox.js';
import { snapshotContract } from './evidence-contract.js';
import { nextRunPublicId } from './run-service-shared.js';
import { createIssueInTransaction } from './issue-service.js';
import { projectWorkNotifications } from './notification-service.js';
import { currentTriager } from './bug-triage.js';
import type { WriteActor } from './work-service.js';
import { parseSeverity } from './severity.js';
import { parseReproducibility } from './reproducibility.js';
import { CAPTURE_MESSAGES, environmentSection, parseBugCapture, type BugCapture } from './bug-capture.js';
import { parseFoundInSha } from './found-in.js';

type DatabaseClient = PrismaClient | Prisma.TransactionClient;

export const BUG_LABEL_NAME = 'Bug';
export const BUG_REPORT_SOURCE = 'bug-report';

export interface BugReportInput {
  teamId: string;
  title: string;
  description?: string | null;
  stepsToReproduce?: string | null;
  priority?: number | null;
  /** Optional impact, SEV1–SEV3 (INV-1115); the SLA still follows priority. */
  severity?: string | null;
  /** Optional ALWAYS / SOMETIMES / ONCE (INV-1122); SOMETIMES and ONCE are never auto-accepted. */
  reproducibility?: string | null;
  /** Optional deploy SHA the bug was found in (INV-1121); the web app defaults it to the running build. */
  foundInSha?: string | null;
  /** Where the bug belongs (id or identifier). Without it the report goes to triage as a candidate. */
  parentId?: string | null;
  repository?: string | null;
  labelIds?: string[] | null;
  /** Browser environment from the capture extension (INV-1146); validated by parseBugCapture. */
  capture?: unknown;
}

/** Type: Bug — the existing "bug" label under any casing (INV-749). */
export async function findOrCreateBugLabel(prisma: DatabaseClient): Promise<IssueLabel> {
  const find = () => prisma.issueLabel.findFirst({ where: { name: { equals: BUG_LABEL_NAME, mode: 'insensitive' } } });
  const existing = await find();
  if (existing) return existing;
  // ON CONFLICT DO NOTHING: a concurrent first report may win the create.
  await prisma.issueLabel.createMany({ data: [{ name: BUG_LABEL_NAME }], skipDuplicates: true });
  const created = await find();
  if (!created) throw new Error('Failed to resolve the bug label.');
  return created;
}

export function composeDescription(description: string | null | undefined, steps: string, capture?: BugCapture | null): string {
  const body = description?.trim();
  const environment = capture ? environmentSection(capture) : '';
  return `${body ? `${body}\n\n` : ''}### Steps to reproduce\n\n${steps}${environment ? `\n\n${environment}` : ''}`;
}

/**
 * A human bug report (Bug route v1, INV-748/749). It always carries Type: Bug,
 * a priority and steps to reproduce. With a parent it is committed and placed
 * like any created work; "not sure where" sends it to triage as a candidate,
 * which a person places when committing. Either way the team is notified.
 */
export async function reportBug(prisma: PrismaClient, input: BugReportInput, actor: WriteActor): Promise<Issue> {
  if (!input.priority || input.priority < 1 || input.priority > 4) throw createValidationError(BUG_REPORT_PRIORITY_REQUIRED_MESSAGE);
  const steps = input.stepsToReproduce?.trim();
  if (!steps) throw createValidationError(BUG_REPORT_STEPS_REQUIRED_MESSAGE);
  const severity = parseSeverity(input.severity) ?? null;
  const reproducibility = parseReproducibility(input.reproducibility) ?? null;
  const capture = parseBugCapture(input.capture);
  const foundInSha = parseFoundInSha(input.foundInSha) ?? null;
  // Outside the transaction: a failed INSERT would poison it.
  const bugLabel = await findOrCreateBugLabel(prisma);
  const labelIds = [...new Set([bugLabel.id, ...(input.labelIds ?? [])])];

  return prisma.$transaction(async (transaction) => {
    const screenshot = capture?.screenshotAttachmentId
      ? await claimableScreenshot(transaction, capture.screenshotAttachmentId, actor)
      : null;
    if (capture && screenshot) capture.screenshotUrl = screenshot.url;
    const base = {
      description: composeDescription(input.description, steps, capture),
      kind: 'ISSUE' as const,
      labelIds,
      priority: input.priority ?? null,
      severity,
      reproducibility,
      capture: capture ? (JSON.parse(JSON.stringify(capture)) as Prisma.InputJsonValue) : null,
      foundInSha,
      repository: input.repository ?? null,
      source: BUG_REPORT_SOURCE,
      teamId: input.teamId,
      title: input.title,
    };
    const triage = !input.parentId?.trim();
    // Zero-bug (INV-750): a placed bug is committed to be fixed, so it starts
    // in Ready rather than the backlog.
    const ready = triage
      ? null
      : await transaction.workflowState.findFirst({
          where: { teamId: input.teamId, type: 'UNSTARTED' },
          orderBy: { position: 'asc' },
          select: { id: true },
        });
    const issue = await createIssueInTransaction(
      transaction,
      triage
        ? { ...base, commitmentStatus: 'CANDIDATE' }
        : await placeNewWork(transaction, { ...base, parentId: input.parentId!.trim(), ...(ready ? { stateId: ready.id } : {}) }),
      actor,
    );
    if (screenshot) {
      // The screenshot becomes the bug's file, readable by whoever reads the bug.
      await transaction.attachment.update({ where: { id: screenshot.id }, data: { issueId: issue.id } });
    }
    await announceBug(transaction, issue, { triage });
    return issue;
  });
}

/**
 * The capture's screenshot (INV-1146): an upload by the reporter that is not yet
 * attached to anything, so a report cannot pull in someone else's file.
 */
async function claimableScreenshot(transaction: Prisma.TransactionClient, id: string, actor: WriteActor): Promise<{ id: string; url: string }> {
  const attachment = /^[0-9a-f-]{36}$/i.test(id)
    ? await transaction.attachment.findUnique({ where: { id }, select: { id: true, url: true, uploaderId: true, issueId: true, commentId: true } })
    : null;
  if (!attachment || attachment.issueId || attachment.commentId || !actor.actorId || attachment.uploaderId !== actor.actorId) {
    throw createValidationError(CAPTURE_MESSAGES.screenshot);
  }
  return { id: attachment.id, url: attachment.url };
}

const CJK = /[\u3400-\u9fff]/;

/** Words of a title worth matching: latin words of 3+ letters, and CJK bigrams. */
export function titleTerms(title: string): string[] {
  const terms = new Set<string>();
  for (const run of title.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (CJK.test(run)) {
      for (let index = 0; index + 1 < run.length; index += 1) terms.add(run.slice(index, index + 2));
    } else if (run.length >= 3) {
      terms.add(run);
    }
  }
  return [...terms].slice(0, 12);
}

/**
 * Open bugs whose titles share words with `title`, best match first — shown
 * while someone reports a bug so a duplicate is noticed before it is filed.
 */
export async function findSimilarBugs(
  prisma: DatabaseClient,
  input: { teamId: string; title: string; limit?: number; readableWhere?: Prisma.IssueWhereInput | null },
  semantic?: SemanticIndex | null,
): Promise<Issue[]> {
  const limit = input.limit ?? 5;
  const openBugs: Prisma.IssueWhereInput = {
    AND: [
      {
        teamId: input.teamId,
        commitmentStatus: { in: ['COMMITTED', 'CANDIDATE'] },
        state: { type: { notIn: ['COMPLETED', 'CANCELED'] } },
        labels: { some: { name: { equals: BUG_LABEL_NAME, mode: 'insensitive' } } },
      },
      ...(input.readableWhere ? [input.readableWhere] : []),
    ],
  };
  const terms = titleTerms(input.title);
  const candidates = terms.length === 0 ? [] : await prisma.issue.findMany({
    where: { AND: [openBugs, { OR: terms.map((term) => ({ title: { contains: term, mode: 'insensitive' as const } })) }] },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  const score = (issue: Issue) => {
    const title = issue.title.toLowerCase();
    return terms.filter((term) => title.includes(term)).length;
  };
  const byWords = candidates
    .map((issue) => ({ issue, score: score(issue) }))
    .sort((left, right) => right.score - left.score)
    .map((entry) => entry.issue);
  if (!semantic || input.title.trim().length === 0) {
    return byWords.slice(0, limit);
  }
  // Bugs described in other words (INV-927) come first; word matches fill in.
  const byMeaning = await findSimilarByMeaning(prisma, semantic, input.title, openBugs, SIMILAR_BUG_SIMILARITY, limit);
  const meaningIds = byMeaning.map((item) => item.id);
  const meaningIssues = meaningIds.length === 0
    ? []
    : await prisma.issue.findMany({ where: { id: { in: meaningIds } } });
  const ordered = meaningIds
    .map((id) => meaningIssues.find((issue) => issue.id === id))
    .filter((issue): issue is Issue => Boolean(issue));
  for (const issue of byWords) {
    if (!ordered.some((existing) => existing.id === issue.id)) ordered.push(issue);
  }
  return ordered.slice(0, limit);
}

/**
 * Tell the team a bug arrived (INV-749/750/751): the bug.reported outbox event,
 * and an Inbox notification — to this week's triager for triage, otherwise to
 * the team's humans. Shared by human reports and agent-filed bugs.
 */
export async function announceBug(transaction: Prisma.TransactionClient, issue: Issue, options: { triage: boolean }): Promise<void> {
  const payload = {
    identifier: issue.identifier,
    priority: issue.priority,
    severity: issue.severity,
    repository: issue.repository,
    title: issue.title,
    triage: options.triage,
  };
  const event = await enqueueWorkEvent(transaction, {
    payload,
    type: 'bug.reported',
    workId: issue.id,
    workIdentifier: issue.identifier,
  });
  const team = await transaction.team.findUniqueOrThrow({ where: { id: issue.teamId }, select: { triageRotation: true } });
  const triager = options.triage ? currentTriager(team.triageRotation, new Date()) : null;
  if (triager) {
    await transaction.notification.createMany({
      data: [{ payload, sourceEventId: event.id, teamId: issue.teamId, type: 'bug.reported', userId: triager, workId: issue.id }],
      skipDuplicates: true,
    });
  } else {
    await projectWorkNotifications(transaction, { eventId: event.id, payload, type: 'bug.reported', work: issue });
  }
}

const FULL_SHA = /^[a-f0-9]{40}$/;

export interface FixedBugEvidenceInput {
  commitSha?: string | null;
  pullRequestNumber?: number | null;
  evidenceUrl?: string | null;
  summary?: string | null;
}

export function hasFixedBugEvidence(input: FixedBugEvidenceInput): boolean {
  return Boolean(input.commitSha || input.pullRequestNumber || input.evidenceUrl);
}

/** Checked before the bug is filed: a refused run must not leave a committed bug without one. */
export function validateFixedBugEvidence(input: FixedBugEvidenceInput): void {
  if (input.commitSha && !FULL_SHA.test(input.commitSha)) throw createValidationError('commit_sha must be a lowercase full 40-character Git SHA');
  if (input.pullRequestNumber != null && (!Number.isSafeInteger(input.pullRequestNumber) || input.pullRequestNumber < 1)) throw createValidationError('pr_number must be a positive integer');
}

/**
 * A bug the agent fixed before filing it (AGENTS.md §7, INV-997): the filing
 * goes straight to Review, so there is no lease to report a run under and
 * nothing to attach evidence to. Record the completed run and its evidence
 * here, in the same shape reportRun + attachEvidence would have left, so the
 * reviewer sees the fix and verification can run on it.
 */
export async function recordFixedBugRun(
  prisma: DatabaseClient,
  input: { workId: string } & FixedBugEvidenceInput,
  actor: WriteActor,
): Promise<{ run: WorkRun; evidence: WorkEvidence[] }> {
  if (!actor.actorId) throw createValidationError('Recording a fixed bug needs an acting user.');
  validateFixedBugEvidence(input);
  const work = await prisma.issue.findUniqueOrThrow({ where: { id: input.workId } });
  const frozen = snapshotContract(work);
  const run = await prisma.workRun.create({
    data: {
      actorId: actor.actorId,
      baseRevision: work.revision,
      contractRevision: frozen.contractRevision,
      acceptanceDigest: frozen.acceptanceDigest,
      contractSnapshot: JSON.parse(JSON.stringify(frozen.contractSnapshot)),
      repository: work.repository,
      commitSha: input.commitSha ?? null,
      pullRequestNumber: input.pullRequestNumber ?? null,
      externalUrl: input.evidenceUrl ?? null,
      phase: 'fixed-on-filing',
      publicId: await nextRunPublicId(prisma),
      status: 'COMPLETED',
      summary: input.summary ?? 'Fixed before filing; see the attached evidence.',
      workId: work.id,
      endedAt: new Date(),
    },
  });
  const urls: Array<{ kind: 'PR' | 'ARTIFACT'; url: string }> = [];
  if (input.pullRequestNumber && work.repository) urls.push({ kind: 'PR', url: `https://github.com/${work.repository}/pull/${input.pullRequestNumber}` });
  if (input.evidenceUrl) urls.push({ kind: /\/pull\/\d+/.test(input.evidenceUrl) && !urls.length ? 'PR' : 'ARTIFACT', url: input.evidenceUrl });
  const evidence: WorkEvidence[] = [];
  for (const item of urls) {
    const row = await prisma.workEvidence.create({
      data: { kind: item.kind, url: item.url, runId: run.id, workId: work.id, actorId: actor.actorId, summary: input.summary ?? null, verificationNextAt: item.kind === 'PR' ? new Date() : null },
    });
    evidence.push(row);
    await enqueueWorkEvent(prisma, {
      payload: { evidenceId: row.id, kind: row.kind, url: row.url, summary: row.summary, runId: run.id, actorId: actor.actorId },
      type: 'artifact.attached',
      workId: work.id,
      workIdentifier: work.identifier,
    });
  }
  const completed = await enqueueWorkEvent(prisma, {
    payload: { runId: run.id, publicId: run.publicId, status: run.status, phase: run.phase, summary: run.summary, externalUrl: run.externalUrl },
    type: 'run.completed',
    workId: work.id,
    workIdentifier: work.identifier,
  });
  // The reviewer learns a fix is waiting, as after any completed run.
  await projectWorkNotifications(prisma, {
    eventId: completed.id,
    payload: { externalUrl: run.externalUrl, phase: run.phase, publicId: run.publicId, summary: run.summary },
    type: 'run.completed',
    work,
  });
  return { run, evidence };
}
