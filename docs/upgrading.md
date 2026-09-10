# Upgrading

Upgrades run `prisma migrate deploy` automatically (compose `server-init`, AIO
entrypoint). This page lists checkpoints: releases where you must act between
pull and start. Scan top-down when skipping versions.

| Release | Checkpoint |
|---|---|
| Wave 1–3 kernel hardening (internal research memo) | Additive migrations only: `Notification` table, `WebhookSubscription.createdById` + `filterQuery`, `Issue.snoozedUntil`/`source`, `EventOutboxDelivery.nextAttemptAt`, `User.notificationPrefs`. No action needed beyond a normal `migrate deploy`. Webhook **retry semantics changed**: failures back off (1m → 5m → 30m → 2h → 10h, 5 attempts); 4xx (except 408/429) is not retried; payloads gained `event`/`event_id`/`delivery_id`/`occurred_at` and headers `involute-event-id`/`involute-attempt` — receiver dedupe should key on `event_id`, not `involute-delivery`. `GET /ready` now exists for orchestrators; keep `/health` for liveness. |

## Conventions

- **Additive migrations** (new table, nullable column) never need a checkpoint
  entry unless they change observable behavior (webhook payloads, error codes).
- **Breaking migrations** (column type changes, data backfills, removals) must
  land with an upgrade step here and a `server-init` compatible path.
- **Env removals/renames** are breaking: document the replacement and keep a
  one-release legacy alias when practical (see `ADMIN_EMAIL_ALLOWLIST`).

## Webhook receiver checklist (payload v2)

1. Dedupe on `event_id` (stable across retries); use `delivery_id` to
   distinguish individual POST attempts.
2. Verify `involute-signature: sha256=<hex>` over the **raw** request body with
   your subscription secret (shown once at create/rotate).
3. Expect retries no sooner than ~1 minute; a 4xx reply (except 408/429)
   stops retries and counts as exhausted for that subscription.
4. Subscriptions that exhaust every delivery ten times in a row are disabled
   automatically; the creator (or instance admins) receives an in-app
   notification of type `webhook.disabled`.
