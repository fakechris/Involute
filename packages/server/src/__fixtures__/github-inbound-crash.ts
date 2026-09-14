// Child-process fault fixture: only an explicitly selected test database is allowed.
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PrismaClient, type Prisma } from '@prisma/client';
import { claimGitHubDelivery, processClaimedGitHubDelivery } from '../github-inbound.js';
import { handleGitHubWebhook, processStoredGitHubEvent } from '../github-webhook-handler.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (process.env.NODE_ENV !== 'test' || !databaseUrl || databaseUrl !== process.env.DATABASE_URL || !new URL(databaseUrl).pathname.endsWith('_test')) {
  throw new Error('Crash fixture requires an explicit matching test database');
}
const prisma = new PrismaClient();
const hold = () => new Promise<never>(() => { setInterval(() => {}, 1_000); });
const stage = process.argv[2];
if (stage === 'before-commit' || stage === 'after-commit') {
  const client = new Proxy(prisma, { get(target, property, receiver) {
    if (property !== '$transaction') return Reflect.get(target, property, receiver);
    return async (action: (tx: Prisma.TransactionClient) => Promise<unknown>) => {
      const value = await prisma.$transaction(async tx => {
        const result = await action(tx);
        if (stage === 'before-commit') { process.send?.({ stage }); await hold(); }
        return result;
      });
      process.send?.({ stage });
      await hold();
      return value;
    };
  } });
  const server = createServer((req, res) => { void handleGitHubWebhook({ prisma: client, webhookSecret: 'crash-secret' }, req, res); });
  server.listen(0, '127.0.0.1', () => {
    const body = process.argv[3]!;
    void fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/webhooks/github`, {
      method: 'POST', body, headers: { 'x-github-event': 'create', 'x-github-delivery': 'crash-intake',
        'x-hub-signature-256': `sha256=${createHmac('sha256', 'crash-secret').update(body).digest('hex')}` },
    }).then(response => process.send?.({ unexpectedAck: response.status }));
  });
  await hold();
}
const receipt = await claimGitHubDelivery(prisma);
if (!receipt) throw new Error('No receipt to claim');
if (process.argv[2] === 'claimed') {
  process.send?.({ stage: 'claimed', id: receipt.id });
  await hold();
} else if (process.argv[2] === 'applied') {
  await processClaimedGitHubDelivery(prisma, receipt, async (tx, current) => {
    await processStoredGitHubEvent(tx, current);
    process.send?.({ stage: 'applied', id: current.id });
    return hold();
  });
} else throw new Error('Unknown crash stage');
