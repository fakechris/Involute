// packages/server/src/github-webhook-handler.ts
//
// HTTP handler for /api/webhooks/github
// Receives GitHub webhook payloads, verifies HMAC signature, and dispatches
// events to the dual-track CAS state machine asynchronously.
//
// Design principles (aligned with Linear):
// - Fast 200 OK response after signature verification
// - Background async processing with in-process per-issue serial queue
// - Robust error handling: never return 5xx (GitHub would disable the webhook)
// - TeamKey verification against repo routing table for strict cross-repo isolation

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PrismaClient, WorkflowStateType } from '@prisma/client';

import { extractIssueIdentifiers, findRepoRoute, resolveIssueIdentifierFromPr } from './github-repo-routes.js';
import { applyMonotonicForward, applyProvenanceRollback } from './github-webhook-state-machine.js';

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
}

interface PullRequestPayload {
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
    merge_commit_sha?: string | null;
  };
  repository: {
    full_name: string;
  };
}

function isValidAction(action: string): action is 'opened' | 'reopened' | 'closed' {
  return action === 'opened' || action === 'reopened' || action === 'closed';
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

    request.on('data', (chunk: Buffer) => {
      totalLength += chunk.length;
      if (totalLength > maxBytes) {
        request.destroy();
        reject(new Error('Payload too large'));
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
  if (!url.startsWith('/api/webhooks/github')) {
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
    if (!signature || !verifySignature(rawBody, signature, options.webhookSecret)) {
      response.statusCode = 401;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ error: 'Invalid signature' }));
      return true;
    }

    // Respond 200 immediately — async processing below
    response.statusCode = 200;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ ok: true }));

    // Dispatch to background processing (never throw back to GitHub)
    const eventType = request.headers['x-github-event'] as string | undefined;
    const deliveryGuid = request.headers['x-github-delivery'] as string | undefined;

    if (eventType === 'pull_request') {
      const payload = JSON.parse(rawBody.toString('utf-8')) as PullRequestPayload;
      processGitHubPrEvent(options.prisma, payload).catch((error) => {
        console.error('[github-webhook] Failed to process PR event:', error);
      });
    } else if (eventType === 'create') {
      const payload = JSON.parse(rawBody.toString('utf-8')) as BranchCreatePayload;
      processGitHubCreateEvent(options.prisma, payload, deliveryGuid).catch((error) => {
        console.error('[github-webhook] Failed to process create event:', error);
      });
    }

    return true;
  } catch (error) {
    console.error('[github-webhook] Handler error:', error);
    if (!response.headersSent) {
      response.statusCode = 200; // Always 200 to prevent GitHub from disabling
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ ok: true, warning: 'Processing error logged' }));
    }
    return true;
  }
}

/**
 * Process a GitHub pull_request event through the dual-track CAS state machine.
 */
export async function processGitHubPrEvent(
  prisma: PrismaClient,
  payload: PullRequestPayload,
): Promise<void> {
  const { action, pull_request: pr, repository } = payload;

  if (!isValidAction(action)) {
    return; // We only handle opened, reopened, closed
  }

  // Route lookup
  const route = findRepoRoute(repository.full_name);
  if (!route) {
    console.log(`[github-webhook] No route configured for repository: ${repository.full_name}`);
    return;
  }

  // Extract issue identifier from branch (priority) or title
  const identifier = resolveIssueIdentifierFromPr({
    branch: pr.head.ref,
    title: pr.title,
    route,
  });

  if (!identifier) {
    console.log(`[github-webhook] No issue identifier found in PR #${pr.number} (${pr.title}) on ${repository.full_name}`);
    return;
  }

  // Look up the issue in the database
  const issue = await prisma.issue.findUnique({
    where: { identifier },
    include: { state: true, team: true },
  });

  if (!issue) {
    console.log(`[github-webhook] Issue ${identifier} not found in database`);
    return;
  }

  // P2: Verify issue belongs to the route's teamKey for strict cross-repo isolation
  if (issue.team.key !== route.teamKey) {
    console.log(
      `[github-webhook] Team mismatch: issue ${identifier} belongs to team ${issue.team.key}, but repo route ${repository.full_name} is configured for team ${route.teamKey}`,
    );
    return;
  }

  const prIdStr = String(pr.id);
  const eventTimestamp = pr.updated_at;

  // P1: Execute processing sequentially per issueId
  await enqueueIssueTask(issue.id, async () => {
    if (action === 'opened' || action === 'reopened') {
      const eventSourceKey = `github_pr_${pr.id}_${action}_${eventTimestamp}`;

      await prisma.$transaction(async (tx) => {
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

        await prisma.$transaction(async (tx) => {
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

        await prisma.$transaction(async (tx) => {
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
  prisma: PrismaClient,
  payload: BranchCreatePayload,
  deliveryGuid?: string,
): Promise<void> {
  if (payload.ref_type !== 'branch') {
    return;
  }

  const route = findRepoRoute(payload.repository.full_name);
  if (!route) {
    console.log(`[github-webhook] No route configured for repository: ${payload.repository.full_name}`);
    return;
  }

  const identifiers = extractIssueIdentifiers(payload.ref, route);
  if (identifiers.length === 0) {
    return;
  }

  const identifier = identifiers[0];
  if (!identifier) {
    return;
  }

  const issue = await prisma.issue.findUnique({
    where: { identifier },
    include: { state: true, team: true },
  });

  if (!issue) {
    console.log(`[github-webhook] Issue ${identifier} not found in database`);
    return;
  }

  // P2: Verify issue belongs to the route's teamKey
  if (issue.team.key !== route.teamKey) {
    console.log(
      `[github-webhook] Team mismatch: issue ${identifier} belongs to team ${issue.team.key}, but repo route ${payload.repository.full_name} is configured for team ${route.teamKey}`,
    );
    return;
  }

  const eventSourceKey = `github_branch_${payload.repository.full_name}_${payload.ref}_${deliveryGuid || 'create'}`;

  await enqueueIssueTask(issue.id, async () => {
    await prisma.$transaction(async (tx) => {
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

      if (result.duplicate) {
        console.log(`[github-webhook] Branch create duplicate ignored for ${identifier}`);
        return;
      }

      console.log(`[github-webhook] Branch create ${payload.ref} → ${identifier}: ${result.reason}`);
    });
  });
}
