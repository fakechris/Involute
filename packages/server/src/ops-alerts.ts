import type { Prisma, PrismaClient } from '@prisma/client';

export type OpsAlertKind = 'event.dead_letter' | 'webhook.disabled' | 'github_sync.dead_letter';

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
  prisma: PrismaClient,
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
  } catch (error) {
    console.error(`Failed to record ops notification for ${alert.kind}.`);
    console.error(error);
  }

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
  } catch (error) {
    console.error(`Failed to deliver ops alert ${alert.kind} to ${opsWebhookUrl}.`);
    console.error(error);
  }
}
