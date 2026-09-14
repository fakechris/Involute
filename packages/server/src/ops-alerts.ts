import type { Prisma, PrismaClient } from '@prisma/client';

export type OpsAlertKind =
  | 'event.dead_letter'
  | 'webhook.disabled'
  | 'github_sync.dead_letter'
  | 'github_inbound.dead_letter'
  | 'github_inbound.payload_conflict'
  | 'github.pr_unverified_reference';

export interface OpsAlert {
  details: Record<string, unknown>;
  kind: OpsAlertKind;
  summary: string;
}

/**
 * Ops alerts are best-effort and must never break the path that produced
 * them: an in-app notification for human administrators, plus an optional
 * fire-and-forget POST to OPS_WEBHOOK_URL for teams that route alerts into
 * chat or paging. Delivery failures are logged, not retried — outbox-grade
 * guarantees would turn alert storms into incident amplifiers.
 */
export async function emitOpsAlert(
  prisma: Pick<PrismaClient, 'user' | 'notification'>,
  alert: OpsAlert,
  opsWebhookUrl: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  try {
    const admins = await prisma.user.findMany({
      select: { id: true },
      take: 10,
      where: { actorKind: 'HUMAN', globalRole: 'ADMIN' },
    });
    if (admins.length > 0) {
      await prisma.notification.createMany({
        data: admins.map((admin) => ({
          payload: alert.details as Prisma.InputJsonValue,
          type: `ops.${alert.kind}`,
          userId: admin.id,
        })),
        skipDuplicates: true,
      });
    }
  } catch {
    console.error(`Failed to record ops notification for ${alert.kind}.`);
  }

  await deliverOpsAlert(alert, opsWebhookUrl, fetchImpl);
}

export interface DeferredOpsAlert {
  alert: OpsAlert;
  url: string | null;
}

/** HTTP delivery is separate so callers can defer it until after a DB commit. */
export async function deliverOpsAlert(
  alert: OpsAlert,
  opsWebhookUrl: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (!opsWebhookUrl) {
    return;
  }
  try {
    await fetchImpl(opsWebhookUrl, {
      body: JSON.stringify({ ...alert, occurred_at: new Date().toISOString() }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    console.error(`Failed to deliver ops alert ${alert.kind}.`);
  }
}
