// INV-1007 round-trip drill against a restored production backup (never production itself):
//   DATABASE_URL=postgresql://…/involute_drill pnpm exec tsx scripts/workgraph-drill.ts <dir>
import { PrismaClient } from '@prisma/client';
import { exportWorkGraph, importWorkGraph, workGraphCounts, WORKGRAPH_TABLES } from '../src/workgraph-transfer.js';

const directory = process.argv[2] ?? '/tmp/workgraph-drill';
const prisma = new PrismaClient();
try {
  const before = await workGraphCounts(prisma);
  const manifest = await exportWorkGraph(prisma, directory);
  console.log(`exported ${manifest.tables.length} tables, ${manifest.tables.reduce((sum, table) => sum + table.rows, 0)} rows`);
  // Tables outside the export that reference exported rows go first (credentials, leases, notifications, outbox…).
  for (const table of ['AgentCredential', 'Session', 'Notification', 'EventOutboxDelivery', 'EventOutbox', 'WebhookSubscription', 'WorkClaim', 'WorkIdempotency', 'IssueEmbedding', 'WorkSearchCursor', 'SemanticAdviceRecord', 'OpsAudit', 'InboundGitHubReplay', 'InboundGitHubAttempt', 'InboundGitHubDelivery', 'WebhookEventLog']) {
    await prisma.$executeRawUnsafe(`DELETE FROM "${table}"`).catch(() => undefined);
  }
  for (const { table } of [...WORKGRAPH_TABLES].reverse()) {
    const present = manifest.tables.some((entry) => entry.table === table);
    if (present) await prisma.$executeRawUnsafe(`DELETE FROM "${table}"`);
  }
  const wiped = await workGraphCounts(prisma);
  console.log(`wiped: Issue=${wiped.Issue} WorkRun=${wiped.WorkRun} WorkAudit=${wiped.WorkAudit}`);
  const imported = await importWorkGraph(prisma, directory);
  const after = await workGraphCounts(prisma);
  const diff = Object.keys(before).filter((table) => before[table] !== after[table]).map((table) => `${table}: ${before[table]} → ${after[table]}`);
  console.log(`imported ${imported.tables.reduce((sum, table) => sum + table.inserted, 0)} rows; count differences: ${diff.length ? diff.join(', ') : 'none'}`);
  const again = await importWorkGraph(prisma, directory);
  console.log(`second import inserted ${again.tables.reduce((sum, table) => sum + table.inserted, 0)} rows`);
  console.log(`Issue=${after.Issue} WorkLink=${after.WorkLink} Comment=${after.Comment} WorkRun=${after.WorkRun} WorkEvidence=${after.WorkEvidence} WorkAudit=${after.WorkAudit}`);
} finally {
  await prisma.$disconnect();
}
