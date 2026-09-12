# GitHub inbound operations

`POST /api/webhooks/github` verifies the raw-body HMAC and saves supported
`create` and `pull_request` deliveries before acknowledging them. Configure
`GITHUB_WEBHOOK_SECRET` to enable intake and the in-process consumer. PR watermark
reconciliation continues independently; receipts also recover branch-only events.

| HTTP | Meaning |
| --- | --- |
| 200 with `receipt_id` | Receipt transaction committed, or identical delivery already exists. Processing may still be pending. |
| 200 with `ok` only | Signed event type is ignored, including `ping`. |
| 400 | Invalid JSON, required headers, or supported-event envelope. |
| 401 | Missing or invalid signature. |
| 409 | Delivery ID reused with different bytes, event type, or repository; original receipt preserved and operator alert attempted. |
| 413 | Body exceeds 5 MiB. |
| 503 | Durable storage unavailable; receipt acceptance was not confirmed. |

If the client loses the response after commit, redelivering the same delivery ID
and original bytes returns the existing receipt. Operators must arrange failed
delivery redelivery; a 503 alone does not schedule a GitHub retry.

For Compose installations, pass these variables to the **server container** in
an override; editing the host `.env` alone does not add container variables:

```yaml
services:
  server:
    environment:
      GITHUB_WEBHOOK_SECRET: ${GITHUB_WEBHOOK_SECRET:?required}
      GITHUB_INBOUND_RETENTION_DAYS: ${GITHUB_INBOUND_RETENTION_DAYS:-30}
```

## Processing and recovery

The consumer runs on startup and every five seconds, claiming up to 20 eligible
receipts per cycle. A conditional database update grants a fresh 60-second lease
token. Expired leases can be reclaimed after process termination. Business changes,
event deduplication, transition outbox records and `PROCESSED` completion share a
transaction with a 20-second timeout. The token and lease deadline are checked
again before completion. Both notification writes and external alert requests run after the transaction.

Failures enter `RETRY` with exponential backoff and jitter (starting near five
seconds, capped at five minutes). Three processing failures since the last manual
replay quarantine a receipt as `DEAD`. Other eligible receipts remain processable.
Lease expirations have `EXPIRED` attempt records and do not consume that failure
budget. Existing lifecycle CAS rules still decide whether each event changes work. Branch
create has no provider timestamp, so it does not advance the PR event-time
watermark; rank CAS still prevents it from moving work backward.

Use the operator shell with the intended instance's `DATABASE_URL` supplied by
its secret environment. Never put database credentials in issue descriptions.

```sh
pnpm --filter @turnkeyai/involute-server github:inbound status
pnpm --filter @turnkeyai/involute-server github:inbound replay \
  --id <receipt-uuid> --expected-attempts <N> --reason 'configuration repaired'
```

Status prints counts by state, the oldest pending/retrying/processing receipt and
up to 20 dead receipts with error codes and lifetime attempt counts. Monitor the
oldest `receivedAt`, retry and dead counts; a growing age with no progress warrants
checking consumer logs and database connectivity. Output omits payloads and
signatures. `ops.github_inbound.dead_letter` notifications go to human admins and
optionally `OPS_WEBHOOK_URL`; alert delivery is best effort.

Replay requires `DEAD`, retained payload and the exact observed attempt count.
A stale command fails without modifying the receipt. Replay preserves attempt
history and appends an `InboundGitHubReplay` record containing the reason, previous
attempt count, timestamp and `operator-cli` source. Database access is the CLI's
authorization boundary; use an audited operator session to identify its caller.

## Retention and deployment

`GITHUB_INBOUND_RETENTION_DAYS` defaults to 30; invalid values fall back to 30 with
a warning. A daily sweep clears payloads only from completed receipts older than
the configured age. Receipt identity, hash and attempt/replay history remain as
deduplication tombstones. Pending, retrying and dead payloads are retained for
recovery. No signature or full private PR payload is printed by ingress errors.

Apply migration `20260912000000_github_inbound_receipts` before starting the new
server. It adds three tables and an enum without changing existing rows. A rolling
upgrade can still lose deliveries accepted by an old instance: route ingress only
to upgraded instances when relying on durable acknowledgement.

For rollback, retain the tables and a compatible consumer until pending/retry
receipts and active leases are drained or explicitly reconciled. An old server
does not consume this queue. Do not drop receipts or assume PR reconciliation
recovers branch-only events. Graceful shutdown waits for the active consumer;
abrupt shutdown relies on lease recovery.

## Verification

Run tests only against a dedicated database whose name ends in `_test`, with
matching `DATABASE_URL` and `TEST_DATABASE_URL` and `NODE_ENV=test`:

```sh
pnpm --filter @turnkeyai/involute-server test \
  github-inbound.test.ts github-webhook.test.ts github-sync.test.ts
```

The suite covers durable acknowledgement, rejection paths, concurrent consumers,
atomic rollback, expired ownership, poison isolation, audited replay, retention
and real child-process termination followed by recovery.
