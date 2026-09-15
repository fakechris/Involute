import { createAgentRequest } from './agent-request-service.js';

import type { Comment, Prisma, PrismaClient } from '@prisma/client';
import type { ResolvedMention } from './mention-service.js';

type DatabaseClient = PrismaClient | Prisma.TransactionClient;

export interface OpenAgentRequestsInput {
  comment: Comment;
  mentions: ResolvedMention[];
  workId: string;
}

/**
 * Opens one ledger row per mentioned agent, in the comment's transaction.
 *
 * **Only a human may open a request.** An agent mentioning another agent posts
 * an ordinary comment and nothing more: agent↔agent questions are the echo risk
 * docs/54 §C names, and the first version deliberately keeps a human at the
 * head of every chain. When that opens up it will be via an explicit delegation
 * action carrying a root request id, a budget and a hop limit — not by
 * loosening this check.
 *
 * Returns request ids by target actorId, so `agent.mentioned` can tell the
 * consumer which row to claim.
 */
export async function openAgentRequestsForMentions(
  db: DatabaseClient,
  input: OpenAgentRequestsInput,
): Promise<Map<string, string>> {
  const requestIdByActorId = new Map<string, string>();

  if (input.mentions.length === 0) {
    return requestIdByActorId;
  }

  const author = await db.user.findUnique({
    where: { id: input.comment.userId },
    select: { actorKind: true },
  });

  if (author?.actorKind !== 'HUMAN') {
    return requestIdByActorId;
  }

  for (const mention of input.mentions) {
    const request = await createAgentRequest(db, {
      body: input.comment.body,
      // A replayed comment write lands one request, not two.
      idempotencyKey: `mention:${input.comment.id}:${mention.actorId}`,
      requestedByActorId: input.comment.userId,
      // Every comment is its own thread root until INV-561 adds parents.
      rootCommentId: input.comment.id,
      targetActorId: mention.actorId,
      workId: input.workId,
    }, input.comment.createdAt);

    requestIdByActorId.set(mention.actorId, request.id);
  }

  return requestIdByActorId;
}
