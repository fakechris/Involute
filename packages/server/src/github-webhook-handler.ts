// packages/server/src/github-webhook-handler.ts
//
// HTTP handler for /api/webhooks/github
// Receives GitHub webhook payloads, verifies HMAC signature, and dispatches
// events through durable receipts to the dual-track CAS state machine.
//
// Design principles (aligned with Linear):
// - Acknowledge only after signature validation and receipt commit
// - Lease-based replay after restarts; business effects and receipt completion are atomic
// - Return a retryable error when durable acceptance fails
// - TeamKey verification against repo routing table for strict cross-repo isolation

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Prisma, PrismaClient, WorkflowStateType, InboundGitHubDelivery } from '@prisma/client';

import { resolveCanonicalIssueRef, resolveRepoRoute } from './github-repo-routes.js';
import { applyMonotonicForward, applyProvenanceRollback } from './github-webhook-state-machine.js';
import { emitOpsAlert, type DeferredOpsAlert, type OpsAlert } from './ops-alerts.js';
import { acceptGitHubDelivery, InboundRequestError, safeErrorCode } from './github-inbound.js';
import { enqueueWorkEvent } from './event-outbox.js';

type DatabaseClient = PrismaClient | Prisma.TransactionClient;
interface GitHubProcessingOptions { deferredAlerts?: DeferredOpsAlert[]; }

export interface GitHubWebhookOptions {
  prisma: PrismaClient;
  /** HMAC secret for GitHub webhook signature verification */
  webhookSecret: string;
}

interface BranchCreatePayload {
  ref: string;
  ref_type: string;
  repository: {
    full_name: string;
  };
  sender?: {
    login?: string;
  };
}

export interface PullRequestPayload {
  action: string;
  pull_request: {
    id: number;
    number: number;
    title: string;
    html_url: string;
    merged: boolean;
    head: {
      ref: string; // branch name
    };
    updated_at: string;
    merge_commit_sha?: string | null | undefined;
  };
  repository: {
    full_name: string;
  };
  sender?: {
    login?: string;
  };
}

function isValidAction(action: string): action is 'opened' | 'reopened' | 'closed' {
  return action === 'opened' || action === 'reopened' || action === 'closed';
}

// Reference checks only fire where the human/agent chooses the reference:
// opened/reopened/edited. synchronize and closed never change it, so alerting
// there would only spam on every push.
function isReferenceCheckAction(action: string): action is 'opened' | 'reopened' | 'edited' {
  return action === 'opened' || action === 'reopened' || action === 'edited';
}

type UnverifiedReferenceReason = 'unknown-identifier' | 'team-mismatch' | 'terminal-issue-reference' | 'project-mismatch';

/**
 * INV-449 traceability guard: the CI lint only regex-matches INV-\d+ offline,
 * so a PR can cite an unrelated or nonexistent issue. Surface that here as a
 * best-effort ops alert (in-app admin notification + optional OPS_WEBHOOK_URL
 * POST); emitOpsAlert swallows its own failures, so processing never breaks.
 */
async function emitUnverifiedReferenceAlert(
  prisma: DatabaseClient,
  input: {
    deferredAlerts?: DeferredOpsAlert[] | undefined;
    repository: string;
    prNumber: number | null;
    prTitle: string | null;
    prUrl: string | null;
    branch: string;
    identifier: string;
    reason: UnverifiedReferenceReason;
    sender?: string | null;
  },
): Promise<void> {
  const ref = input.prNumber ? `PR #${input.prNumber}` : `branch ${input.branch}`;
  const alert: OpsAlert = {
    kind: 'github.pr_unverified_reference',
    summary: `Unverified work reference: ${ref} on ${input.repository} → ${input.identifier} (${input.reason})`,
    details: {
      repository: input.repository, prNumber: input.prNumber, prTitle: input.prTitle,
      prUrl: input.prUrl, branch: input.branch, identifier: input.identifier,
      reason: input.reason, sender: input.sender ?? null,
    },
  };
  const url = process.env.OPS_WEBHOOK_URL?.trim() || null;
  if (input.deferredAlerts) input.deferredAlerts.push({ alert, url });
  else await emitOpsAlert(prisma, alert, url);
}

/**
 * In-process per-issue serial execution queue to preserve event delivery order
 * and prevent concurrent transaction interleaving on the same work item.
 */
const issueProcessingQueues = new Map<string, Promise<void>>();

export function enqueueIssueTask<T>(issueId: string, task: () => Promise<T>): Promise<T> {
  const currentQueue = issueProcessingQueues.get(issueId) ?? Promise.resolve();
  let result: T;
  const nextTask = currentQueue.then(async () => {
    result = await task();
  });

  let stored: Promise<void>;
  const cleanup = () => {
    if (issueProcessingQueues.get(issueId) === stored) {
      issueProcessingQueues.delete(issueId);
    }
  };

  stored = nextTask.then(cleanup, cleanup);
  issueProcessingQueues.set(issueId, stored);
  return nextTask.then(() => result);
}

/**
 * Reads the raw body from an IncomingMessage.
 */
function readRawBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalLength = 0;
    let exceeded = false;

    request.on('data', (chunk: Buffer) => {
      if (exceeded) return;
      totalLength += chunk.length;
      if (totalLength > maxBytes) {
        exceeded = true;
        chunks.length = 0;
        reject(new InboundRequestError(413, 'PAYLOAD_TOO_LARGE'));
        return;
      }
      chunks.push(chunk);
    });

    request.on('end', () => {
      resolve(Buffer.concat(chunks));
    });

    request.on('error', reject);
  });
}

/**
 * Verify the GitHub webhook signature using HMAC-SHA256 with timing-safe comparison.
 */
function verifySignature(rawBody: Buffer, signature: string, secret: string): boolean {
  if (!signature.startsWith('sha256=')) {
    return false;
  }

  const expectedSignature = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');

  const sigBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);

  if (sigBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(sigBuffer, expectedBuffer);
}

/**
 * Handle incoming GitHub webhook request.
 * Returns true if the request was handled (even if rejected), false if not a webhook route.
 */
export async function handleGitHubWebhook(
  options: GitHubWebhookOptions,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<boolean> {
  const url = request.url ?? '';
  if (url.split('?')[0] !== '/api/webhooks/github') {
    return false;
  }

  if (request.method !== 'POST') {
    response.statusCode = 405;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ error: 'Method not allowed' }));
    return true;
  }

  try {
    // Read raw body (max 5MB for webhook payloads)
    const rawBody = await readRawBody(request, 5 * 1024 * 1024);

    // Verify HMAC signature
    const signature = request.headers['x-hub-signature-256'] as string | undefined;
    if (typeof signature !== 'string' || !verifySignature(rawBody, signature, options.webhookSecret)) {
      response.statusCode = 401;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ error: 'Invalid signature' }));
      return true;
    }

    let payload: unknown;
    try { payload = JSON.parse(rawBody.toString('utf-8')); }
    catch { throw new InboundRequestError(400, 'INVALID_JSON'); }
    const eventType = request.headers['x-github-event'];
    if (typeof eventType !== 'string' || !eventType) throw new InboundRequestError(400, 'MISSING_EVENT_TYPE');
    if (eventType !== 'pull_request' && eventType !== 'create') {
      response.statusCode = 200;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ ok: true }));
      return true;
    }
    const deliveryId = request.headers['x-github-delivery'];
    if (typeof deliveryId !== 'string' || !deliveryId.trim() || deliveryId.length > 200) {
      throw new InboundRequestError(400, 'INVALID_DELIVERY_ID');
    }
    const repository = validateGitHubPayload(eventType, payload);
    const receipt = await acceptGitHubDelivery(options.prisma, {
      deliveryId, eventType, repository, payload: payload as Prisma.InputJsonObject, rawBody,
    });
    response.statusCode = 200;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ ok: true, receipt_id: receipt.id }));
    return true;
  } catch (error) {
    const status = error instanceof InboundRequestError ? error.status : 503;
    const code = error instanceof InboundRequestError ? error.code : 'RECEIPT_UNAVAILABLE';
    if (!response.headersSent) {
      response.statusCode = status;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ error: code }));
    }
    if (code === 'DELIVERY_PAYLOAD_CONFLICT') {
      await emitOpsAlert(options.prisma, {
        kind: 'github_inbound.payload_conflict', summary: 'GitHub delivery ID reused with conflicting payload',
        details: { deliveryId: request.headers['x-github-delivery'] ?? null },
      }, process.env.OPS_WEBHOOK_URL?.trim() || null);
    } else if (status === 503) {
      console.error(`[github-inbound] Receipt acceptance failed: ${safeErrorCode(error)}`);
    }
    return true;
  }
}

/**
 * Process a GitHub pull_request event through the dual-track CAS state machine.
 */
export async function processGitHubPrEvent(
  prisma: DatabaseClient,
  payload: PullRequestPayload,
  options: GitHubProcessingOptions = {},
): Promise<void> {
  const { action, pull_request: pr, repository } = payload;

  // `edited` carries no state transition but still re-asserts the reference,
  // so it is checked below even though the CAS machine ignores it.
  if (!isValidAction(action) && !isReferenceCheckAction(action)) {
    return; // We only handle opened, reopened, closed (+ edited for reference checks)
  }

  // Route lookup (graph-derived from PROJECT nodes, static list as fallback)
  const route = await resolveRepoRoute(prisma, repository.full_name);
  if (!route) {
    console.log(`[github-webhook] No route configured for repository: ${repository.full_name}`);
    return;
  }

  // Extract issue identifier from branch (priority) or title; alias prefixes
  // (e.g. LUM-398) canonicalize to the team key with viaAlias set.
  const ref = resolveCanonicalIssueRef({
    branch: pr.head.ref,
    title: pr.title,
    route,
  });

  if (!ref) {
    console.log(`[github-webhook] No issue identifier found in PR #${pr.number} (${pr.title}) on ${repository.full_name}`);
    return;
  }
  const identifier = ref.identifier;

  // Look up the issue in the database
  const issue = await prisma.issue.findUnique({
    where: { identifier },
    include: { state: true, team: true },
  });

  if (!issue) {
    console.log(`[github-webhook] Issue ${identifier} not found in database`);
    if (isReferenceCheckAction(action)) {
      await emitUnverifiedReferenceAlert(prisma, {
      deferredAlerts: options.deferredAlerts,
        repository: repository.full_name,
        prNumber: pr.number,
        prTitle: pr.title,
        prUrl: pr.html_url,
        branch: pr.head.ref,
        identifier,
        reason: 'unknown-identifier',
        sender: payload.sender?.login ?? null,
      });
    }
    return;
  }

  // P2: Verify issue belongs to the route's teamKey for strict cross-repo isolation
  if (issue.team.key !== route.teamKey) {
    console.log(
      `[github-webhook] Team mismatch: issue ${identifier} belongs to team ${issue.team.key}, but repo route ${repository.full_name} is configured for team ${route.teamKey}`,
    );
    if (isReferenceCheckAction(action)) {
      await emitUnverifiedReferenceAlert(prisma, {
      deferredAlerts: options.deferredAlerts,
        repository: repository.full_name,
        prNumber: pr.number,
        prTitle: pr.title,
        prUrl: pr.html_url,
        branch: pr.head.ref,
        identifier,
        reason: 'team-mismatch',
        sender: payload.sender?.login ?? null,
      });
    }
    return;
  }

  // Alias semantics: LUM-398 asserts the issue belongs to the aliased
  // project. A reference via alias to an issue of another repository (or no
  // repository) is a fake membership claim — alert and skip.
  if (
    ref.viaAlias &&
    (issue.repository ?? '').toLowerCase().trim() !== route.repository.toLowerCase().trim()
  ) {
    console.log(
      `[github-webhook] Project mismatch: ${identifier} referenced via alias ${route.alias} on ${repository.full_name}, but issue repository is ${issue.repository ?? 'none'}`,
    );
    if (isReferenceCheckAction(action)) {
      await emitUnverifiedReferenceAlert(prisma, {
      deferredAlerts: options.deferredAlerts,
        repository: repository.full_name,
        prNumber: pr.number,
        prTitle: pr.title,
        prUrl: pr.html_url,
        branch: pr.head.ref,
        identifier,
        reason: 'project-mismatch',
        sender: payload.sender?.login ?? null,
      });
    }
    return;
  }

  // Referencing a Done/Canceled issue in a new PR is a smell (the CAS machine
  // will absorb it as a no-op), but processing continues unchanged.
  if (isReferenceCheckAction(action) && (issue.state.type === 'COMPLETED' || issue.state.type === 'CANCELED')) {
    await emitUnverifiedReferenceAlert(prisma, {
      deferredAlerts: options.deferredAlerts,
      repository: repository.full_name,
      prNumber: pr.number,
      prTitle: pr.title,
      prUrl: pr.html_url,
      branch: pr.head.ref,
      identifier,
      reason: 'terminal-issue-reference',
      sender: payload.sender?.login ?? null,
    });
  }

  if (!isValidAction(action)) {
    return; // edited: reference checks above only, no state transition
  }

  const prIdStr = String(pr.id);
  const eventTimestamp = pr.updated_at;

  // P1: Execute processing sequentially per issueId
  await serializeIssue(prisma, issue.id, async () => {
    if (action === 'opened' || action === 'reopened') {
      const eventSourceKey = `github_pr_${pr.id}_${action}_${eventTimestamp}`;

      await transact(prisma, async (tx) => {
        const result = await applyMonotonicForward(tx, {
          issueId: issue.id,
          teamId: issue.teamId,
          targetStateType: 'REVIEW' as WorkflowStateType,
          eventSourceKey,
          eventType: `pull_request.${action}`,
          sourcePrId: prIdStr,
          eventTimestamp,
          payload: {
            prNumber: pr.number,
            prTitle: pr.title,
            prUrl: pr.html_url,
            branch: pr.head.ref,
          },
        });
        if (result.applied) await enqueueGitHubStateChange(tx, issue, result.newStateType);
        if (result.duplicate) {
          console.log(`[github-webhook] PR #${pr.number} ${action} duplicate ignored for ${identifier}`);
          return;
        }

        // Attach PR evidence if not already recorded
        const existingEvidence = await tx.workEvidence.findFirst({
          where: { workId: issue.id, url: pr.html_url },
        });
        if (!existingEvidence) {
          await tx.workEvidence.create({
            data: {
              workId: issue.id,
              kind: 'PR',
              url: pr.html_url,
              summary: `GitHub PR #${pr.number}: ${pr.title}`,
            },
          });
        }

        console.log(`[github-webhook] PR #${pr.number} ${action} → ${identifier}: ${result.reason}`);
      });
    } else if (action === 'closed') {
      if (pr.merged) {
        const eventSourceKey = `github_pr_${pr.id}_merged_${eventTimestamp}`;

        await transact(prisma, async (tx) => {
          const result = await applyMonotonicForward(tx, {
            issueId: issue.id,
            teamId: issue.teamId,
            targetStateType: 'COMPLETED' as WorkflowStateType,
            eventSourceKey,
            eventType: 'pull_request.merged',
            eventTimestamp,
            payload: {
              prNumber: pr.number,
              prTitle: pr.title,
              prUrl: pr.html_url,
              mergeCommitSha: pr.merge_commit_sha,
            },
          });
          if (result.applied) await enqueueGitHubStateChange(tx, issue, result.newStateType);
          if (result.duplicate) {
            console.log(`[github-webhook] PR #${pr.number} merged duplicate ignored for ${identifier}`);
            return;
          }

          // Always attach/update PR evidence (First-Merge-Wins keeps COMPLETED but records all PRs)
          const summary = `GitHub PR #${pr.number}: ${pr.title} (Merged${pr.merge_commit_sha ? ` in ${pr.merge_commit_sha.slice(0, 7)}` : ''})`;
          const existingEvidence = await tx.workEvidence.findFirst({
            where: { workId: issue.id, url: pr.html_url },
          });
          if (existingEvidence) {
            await tx.workEvidence.update({
              where: { id: existingEvidence.id },
              data: { summary },
            });
          } else {
            await tx.workEvidence.create({
              data: {
                workId: issue.id,
                kind: 'PR',
                url: pr.html_url,
                summary,
              },
            });
          }

          console.log(`[github-webhook] PR #${pr.number} merged → ${identifier}: ${result.reason}`);
        });
      } else {
        const eventSourceKey = `github_pr_${pr.id}_unmerged_${eventTimestamp}`;

        await transact(prisma, async (tx) => {
          const result = await applyProvenanceRollback(tx, {
            issueId: issue.id,
            teamId: issue.teamId,
            prId: prIdStr,
            eventSourceKey,
            eventType: 'pull_request.closed_unmerged',
            eventTimestamp,
            payload: {
              prNumber: pr.number,
              prTitle: pr.title,
              prUrl: pr.html_url,
            },
          });
          if (result.applied) await enqueueGitHubStateChange(tx, issue, result.newStateType);
          if (result.duplicate) {
            console.log(`[github-webhook] PR #${pr.number} unmerged duplicate ignored for ${identifier}`);
            return;
          }

          console.log(`[github-webhook] PR #${pr.number} closed unmerged → ${identifier}: ${result.reason}`);
        });
      }
    }
  });
}

/**
 * Process a GitHub create event (e.g. branch creation) through the dual-track CAS state machine.
 */
export async function processGitHubCreateEvent(
  prisma: DatabaseClient,
  payload: BranchCreatePayload,
  deliveryGuid?: string,
  options: GitHubProcessingOptions = {},
): Promise<void> {
  if (payload.ref_type !== 'branch') {
    return;
  }

  const route = await resolveRepoRoute(prisma, payload.repository.full_name);
  if (!route) {
    console.log(`[github-webhook] No route configured for repository: ${payload.repository.full_name}`);
    return;
  }

  const ref = resolveCanonicalIssueRef({ branch: payload.ref, title: '', route });
  if (!ref) {
    return;
  }
  const identifier = ref.identifier;

  const issue = await prisma.issue.findUnique({
    where: { identifier },
    include: { state: true, team: true },
  });

  if (!issue) {
    console.log(`[github-webhook] Issue ${identifier} not found in database`);
    await emitUnverifiedReferenceAlert(prisma, {
      deferredAlerts: options.deferredAlerts,
      repository: payload.repository.full_name,
      prNumber: null,
      prTitle: null,
      prUrl: null,
      branch: payload.ref,
      identifier,
      reason: 'unknown-identifier',
      sender: payload.sender?.login ?? null,
    });
    return;
  }

  // P2: Verify issue belongs to the route's teamKey
  if (issue.team.key !== route.teamKey) {
    console.log(
      `[github-webhook] Team mismatch: issue ${identifier} belongs to team ${issue.team.key}, but repo route ${payload.repository.full_name} is configured for team ${route.teamKey}`,
    );
    await emitUnverifiedReferenceAlert(prisma, {
      deferredAlerts: options.deferredAlerts,
      repository: payload.repository.full_name,
      prNumber: null,
      prTitle: null,
      prUrl: null,
      branch: payload.ref,
      identifier,
      reason: 'team-mismatch',
      sender: payload.sender?.login ?? null,
    });
    return;
  }

  // Alias semantics on branch create: same project-membership verification
  // as the PR flow.
  if (
    ref.viaAlias &&
    (issue.repository ?? '').toLowerCase().trim() !== route.repository.toLowerCase().trim()
  ) {
    console.log(
      `[github-webhook] Project mismatch: ${identifier} referenced via alias ${route.alias} on ${payload.repository.full_name}, but issue repository is ${issue.repository ?? 'none'}`,
    );
    await emitUnverifiedReferenceAlert(prisma, {
      deferredAlerts: options.deferredAlerts,
      repository: payload.repository.full_name,
      prNumber: null,
      prTitle: null,
      prUrl: null,
      branch: payload.ref,
      identifier,
      reason: 'project-mismatch',
      sender: payload.sender?.login ?? null,
    });
    return;
  }

  const eventSourceKey = `github_branch_${payload.repository.full_name}_${payload.ref}_${deliveryGuid || 'create'}`;

  await serializeIssue(prisma, issue.id, async () => {
    await transact(prisma, async (tx) => {
      const result = await applyMonotonicForward(tx, {
        issueId: issue.id,
        teamId: issue.teamId,
        targetStateType: 'STARTED' as WorkflowStateType,
        eventSourceKey,
        eventType: 'create.branch',
        payload: {
          branch: payload.ref,
          repository: payload.repository.full_name,
        },
      });

      if (result.applied) await enqueueGitHubStateChange(tx, issue, result.newStateType);
      if (result.duplicate) {
        console.log(`[github-webhook] Branch create duplicate ignored for ${identifier}`);
        return;
      }

      console.log(`[github-webhook] Branch create ${payload.ref} → ${identifier}: ${result.reason}`);
    });
  });
}


function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InboundRequestError(400, 'INVALID_PAYLOAD');
  return value as Record<string, unknown>;
}

function textField(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new InboundRequestError(400, 'INVALID_PAYLOAD');
  return value;
}

function validateGitHubPayload(eventType: string, value: unknown): string {
  const payload = object(value);
  const repository = textField(object(payload.repository).full_name);
  if (repository.length > 512) throw new InboundRequestError(400, 'INVALID_PAYLOAD');
  if (eventType === 'create') {
    textField(payload.ref);
    textField(payload.ref_type);
  } else if (eventType === 'pull_request') {
    textField(payload.action);
    const pr = object(payload.pull_request);
    if (!Number.isSafeInteger(pr.id) || (pr.id as number) <= 0 || !Number.isSafeInteger(pr.number) || (pr.number as number) <= 0 || typeof pr.merged !== 'boolean') {
      throw new InboundRequestError(400, 'INVALID_PAYLOAD');
    }
    textField(pr.title);
    textField(pr.html_url);
    textField(object(pr.head).ref);
    if (!Number.isFinite(Date.parse(textField(pr.updated_at)))) throw new InboundRequestError(400, 'INVALID_PAYLOAD');
  } else throw new InboundRequestError(400, 'UNSUPPORTED_EVENT');
  return repository;
}

export async function processStoredGitHubEvent(tx: Prisma.TransactionClient, receipt: InboundGitHubDelivery): Promise<DeferredOpsAlert[]> {
  validateGitHubPayload(receipt.eventType, receipt.payload);
  const deferredAlerts: DeferredOpsAlert[] = [];
  if (receipt.eventType === 'create') {
    await processGitHubCreateEvent(tx, receipt.payload as unknown as BranchCreatePayload, receipt.deliveryId, { deferredAlerts });
  } else {
    await processGitHubPrEvent(tx, receipt.payload as unknown as PullRequestPayload, { deferredAlerts });
  }
  return deferredAlerts;
}

function transact<T>(prisma: DatabaseClient, action: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return '$transaction' in prisma ? prisma.$transaction(action) : action(prisma);
}

function serializeIssue<T>(prisma: DatabaseClient, issueId: string, action: () => Promise<T>): Promise<T> {
  // A leased processor already owns an outer transaction; do not wait in an in-memory queue while holding its locks.
  return '$transaction' in prisma ? enqueueIssueTask(issueId, action) : action();
}

async function enqueueGitHubStateChange(tx: Prisma.TransactionClient, issue: { id: string; identifier: string }, stateType?: string) {
  await enqueueWorkEvent(tx, {
    type: 'work.state_changed', workId: issue.id, workIdentifier: issue.identifier,
    payload: { source: 'github', stateType: stateType ?? null },
  });
}
