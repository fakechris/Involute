// Export the work graph to a directory, or import one (INV-1007):
//   pnpm workgraph:export ./export-2026-10-08
//   pnpm workgraph:import ./export-2026-10-08
// Import is idempotent (existing rows are kept) and preserves ids, audits
// and timestamps. Credentials, sessions, claims and notifications are not
// part of the export; mint new agent credentials after an import.
import { PrismaClient } from '@prisma/client';

import { exportWorkGraph, importWorkGraph } from '../src/workgraph-transfer.ts';
import { loadProjectEnvironment } from './env.ts';

loadProjectEnvironment();
const [command, directory] = process.argv.slice(2);
if (!directory || !['export', 'import'].includes(command ?? '')) {
  console.error('usage: workgraph.ts export|import <directory>');
  process.exit(2);
}
const prisma = new PrismaClient();
try {
  if (command === 'export') {
    const manifest = await exportWorkGraph(prisma, directory);
    for (const table of manifest.tables) console.log(`${table.table}: ${table.rows} rows`);
    console.log(`Exported ${manifest.tables.length} tables to ${directory}`);
  } else {
    const result = await importWorkGraph(prisma, directory);
    for (const table of result.tables) console.log(`${table.table}: ${table.inserted} inserted of ${table.offered}`);
  }
} finally {
  await prisma.$disconnect();
}
