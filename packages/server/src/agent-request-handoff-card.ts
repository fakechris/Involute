import { Prisma, type PrismaClient } from '@prisma/client';

import { createValidationError } from './errors.js';

/**
 * The hand-off card a delegation carries (INV-1583).
 *
 * A delegation used to be a sentence: "write the tests". The receiving agent
 * had to guess what it was allowed to do with the repository and what counted
 * as done; the reviewer could not tell afterwards whether it had gone further
 * than asked. The card says, in fields rather than prose: where to start
 * (base commit), what to read (inputs), how far to go (allowed actions) and
 * what done means (acceptance). What the executor then reports is compared
 * with the allowed actions, and anything beyond them is written on the
 * request for the person and the delegator to see.
 */

export const HANDOFF_ACTIONS = ['read', 'edit', 'push', 'pr', 'merge', 'release'] as const;
export type HandoffAction = (typeof HANDOFF_ACTIONS)[number];

export interface HandoffCard {
  baseCommit: string | null;
  inputs: string[];
  allowedActions: HandoffAction[] | null;
  acceptance: string | null;
  /** Allowed actions the executor's reports went beyond, in the order seen. */
  exceededActions: HandoffAction[];
}

export interface HandoffInput {
  baseCommit?: string | null | undefined;
  inputs?: readonly string[] | null | undefined;
  allowedActions?: readonly string[] | null | undefined;
  acceptance?: string | null | undefined;
}

export const HANDOFF_COMMIT_MESSAGE = 'handoff.base_commit is a Git SHA, 7 to 40 hex characters.';
export const HANDOFF_INPUTS_MESSAGE = 'handoff.inputs lists links, attachment names or INV references, each a non-empty line.';
export function handoffActionsMessage(bad: string): string {
  return `handoff.allowed_actions: "${bad}" is not one of ${HANDOFF_ACTIONS.join(', ')}.`;
}

const SHA_PATTERN = /^[0-9a-f]{7,40}$/i;

/** Checks a card as a client wrote it; null when nothing was given. */
export function parseHandoff(input: HandoffInput | null | undefined): HandoffCard | null {
  if (!input) return null;
  const baseCommit = input.baseCommit?.trim() || null;
  if (baseCommit && !SHA_PATTERN.test(baseCommit)) throw createValidationError(HANDOFF_COMMIT_MESSAGE);
  const inputs = (input.inputs ?? []).map((line) => (typeof line === 'string' ? line.trim() : ''));
  if (inputs.some((line) => !line)) throw createValidationError(HANDOFF_INPUTS_MESSAGE);
  let allowedActions: HandoffAction[] | null = null;
  if (input.allowedActions) {
    allowedActions = [];
    for (const raw of input.allowedActions) {
      const action = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
      if (!(HANDOFF_ACTIONS as readonly string[]).includes(action)) throw createValidationError(handoffActionsMessage(String(raw)));
      if (!allowedActions.includes(action as HandoffAction)) allowedActions.push(action as HandoffAction);
    }
  }
  const acceptance = input.acceptance?.trim() || null;
  if (!baseCommit && inputs.length === 0 && !allowedActions && !acceptance) return null;
  return { baseCommit, inputs, allowedActions, acceptance, exceededActions: [] };
}

export function handoffJson(card: HandoffCard): Prisma.InputJsonValue {
  return card as unknown as Prisma.InputJsonValue;
}

/** The stored card, read back; null when the request carries none. */
export function readHandoff(value: unknown): HandoffCard | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const strings = (list: unknown) => (Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : []);
  const actions = (list: unknown) => strings(list).filter((item): item is HandoffAction => (HANDOFF_ACTIONS as readonly string[]).includes(item));
  return {
    baseCommit: typeof record.baseCommit === 'string' ? record.baseCommit : null,
    inputs: strings(record.inputs),
    allowedActions: Array.isArray(record.allowedActions) ? actions(record.allowedActions) : null,
    acceptance: typeof record.acceptance === 'string' ? record.acceptance : null,
    exceededActions: actions(record.exceededActions),
  };
}

/** The card as the hand-off comment and the inbox show it. */
export function describeHandoff(card: HandoffCard): string {
  const lines: string[] = [];
  if (card.baseCommit) lines.push(`base commit ${card.baseCommit}`);
  if (card.inputs.length) lines.push(`inputs: ${card.inputs.join('; ')}`);
  if (card.allowedActions) lines.push(`allowed: ${card.allowedActions.join(', ') || 'nothing'}`);
  if (card.acceptance) lines.push(`acceptance: ${card.acceptance}`);
  return lines.join(' · ');
}

/**
 * What a run report claims to have done, in the card's terms: a commit SHA
 * means the executor pushed, a PR number means it opened a pull request.
 * Merging and releasing are not reported through run_report, so they are
 * not judged here.
 */
export function actionsOfReport(report: { commitSha?: string | null | undefined; pullRequestNumber?: number | null | undefined }): HandoffAction[] {
  const actions: HandoffAction[] = [];
  if (report.commitSha) actions.push('push');
  if (report.pullRequestNumber) actions.push('pr');
  return actions;
}

export function handoffExceededMessage(request: { id: string }, beyond: HandoffAction[]): string {
  return `This report goes beyond what delegation ${request.id} allowed (${beyond.join(', ')}); the request now says so. Stop at the allowed actions, or ask the delegator to widen them.`;
}

/**
 * After a run report: if the reporter holds a live delegation on this work
 * whose card limits what may be done, note what the report went beyond on
 * the request and say so. Nothing is refused — the work was already done —
 * but the record shows it.
 */
export async function noteReportBeyondHandoff(
  db: { agentRequest: Pick<PrismaClient['agentRequest'], 'findFirst' | 'update'> },
  input: { workId: string; actorId: string; commitSha?: string | null | undefined; pullRequestNumber?: number | null | undefined },
): Promise<string | null> {
  const request = await db.agentRequest.findFirst({
    where: { workId: input.workId, targetActorId: input.actorId, state: { in: ['SUBMITTED', 'WORKING', 'INPUT_REQUIRED'] }, handoff: { not: Prisma.DbNull } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, handoff: true },
  });
  const card = request ? readHandoff(request.handoff) : null;
  if (!request || !card || !card.allowedActions) return null;
  const beyond = actionsOfReport(input).filter((action) => !card.allowedActions!.includes(action));
  if (beyond.length === 0) return null;
  const exceededActions = [...card.exceededActions, ...beyond.filter((action) => !card.exceededActions.includes(action))];
  await db.agentRequest.update({ where: { id: request.id }, data: { handoff: handoffJson({ ...card, exceededActions }) } });
  return handoffExceededMessage(request, beyond);
}
