import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Prisma, PrismaClient } from '@prisma/client';

/**
 * The whole work graph out of one database and back into another (INV-1007).
 *
 * Export writes one JSON file per table (rows as Postgres returns them, ids
 * and timestamps included) plus a manifest. Import inserts each file in
 * dependency order with ON CONFLICT DO NOTHING, so running it twice changes
 * nothing, and audits keep their original actor and time. Self-references
 * (parent work, thread roots, actor owners) are written in a second pass so
 * row order inside a table does not matter.
 *
 * Not exported: credentials and sessions, claims (leases are transient),
 * notifications, the outbox and inbound deliveries, search vectors (the
 * triggers rebuild them) and embeddings (the indexer rebuilds them).
 */
export const WORKGRAPH_FORMAT = 'involute.workgraph/1';

/** Tables in insert order; `self` names columns pointing back at the same table. */
export const WORKGRAPH_TABLES: ReadonlyArray<{ table: string; self?: string[] }> = [
  { table: 'User', self: ['ownerId', 'successorActorId', 'invitedById'] },
  { table: 'Team' },
  { table: 'TeamMembership' },
  { table: 'WorkflowState' },
  { table: 'IssueLabel' },
  { table: 'Project' },
  { table: 'Cycle' },
  { table: 'WorkspaceSettings' },
  { table: 'Issue', self: ['parentId', 'supersededById', 'deliveryRootId'] },
  { table: '_IssueToIssueLabel' },
  { table: 'WorkLink' },
  { table: 'WorkShare' },
  { table: 'Comment', self: ['parentCommentId'] },
  { table: 'CommentMention' },
  { table: 'Attachment' },
  { table: 'WorkRun' },
  { table: 'WorkEvidence' },
  { table: 'EvidenceVerification' },
  { table: 'WorkReviewDecision' },
  { table: 'WorkAutoAcceptEvaluation' },
  { table: 'WorkAudit' },
  { table: 'ContractAmendment' },
  { table: 'DeliveryPackage' },
  { table: 'DeliveryChangeSet' },
  { table: 'ExecutorDispatch' },
  { table: 'ExecutorEffect' },
  { table: 'ExecutorDeliveryReceipt' },
  { table: 'AgentRequest' },
  { table: 'DecisionReceipt' },
  { table: 'BugSlaAlert' },
  { table: 'SavedView' },
  { table: 'LegacyLinearMapping' },
  { table: 'WorkGraphMigration' },
];

/** Columns never written to the export: secrets, lease state, derived data. */
const EXCLUDED_COLUMNS: Record<string, string[]> = {
  WorkRun: ['executionTokenHash', 'claimId', 'searchVector'],
  Issue: ['searchVector'],
  Comment: ['searchVector'],
  WorkEvidence: ['verificationLeaseId', 'verificationLeaseUntil'],
};

type Row = Record<string, unknown>;

async function tableColumns(prisma: PrismaClient, table: string): Promise<Array<{ name: string; type: string }>> {
  const rows = await prisma.$queryRaw<Array<{ column_name: string; udt_name: string }>>`
    SELECT column_name, udt_name FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = ${table}
     ORDER BY ordinal_position`;
  return rows.map((row) => ({ name: row.column_name, type: row.udt_name }));
}

async function exportableColumns(prisma: PrismaClient, table: string): Promise<string[]> {
  const excluded = new Set(EXCLUDED_COLUMNS[table] ?? []);
  return (await tableColumns(prisma, table)).filter((column) => column.type !== 'tsvector' && !excluded.has(column.name)).map((column) => column.name);
}

const quote = (identifier: string) => `"${identifier.replace(/"/g, '""')}"`;

export interface WorkGraphManifest {
  format: typeof WORKGRAPH_FORMAT;
  exportedAt: string;
  tables: Array<{ table: string; rows: number; columns: string[] }>;
}

export async function exportWorkGraph(prisma: PrismaClient, directory: string): Promise<WorkGraphManifest> {
  await mkdir(directory, { recursive: true });
  const manifest: WorkGraphManifest = { format: WORKGRAPH_FORMAT, exportedAt: new Date().toISOString(), tables: [] };
  for (const { table } of WORKGRAPH_TABLES) {
    const columns = await exportableColumns(prisma, table);
    if (columns.length === 0) continue;
    const select = columns.map(quote).join(', ');
    const rows = await prisma.$queryRawUnsafe<Array<{ row: Row }>>(`SELECT row_to_json(t) AS row FROM (SELECT ${select} FROM ${quote(table)}) t`);
    await writeFile(join(directory, `${table}.json`), JSON.stringify(rows.map((entry) => entry.row), null, 1));
    manifest.tables.push({ table, rows: rows.length, columns });
  }
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

export interface WorkGraphImportResult {
  tables: Array<{ table: string; offered: number; inserted: number }>;
}

/**
 * Inserts what the export holds, skipping rows whose primary or unique key
 * already exists. Self-referencing columns are set in a second statement so
 * a child may precede its parent in the file.
 */
export async function importWorkGraph(prisma: PrismaClient, directory: string): Promise<WorkGraphImportResult> {
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as WorkGraphManifest;
  if (manifest.format !== WORKGRAPH_FORMAT) throw new Error(`Unsupported export format ${manifest.format}; expected ${WORKGRAPH_FORMAT}.`);
  const result: WorkGraphImportResult = { tables: [] };
  for (const { table, self = [] } of WORKGRAPH_TABLES) {
    const entry = manifest.tables.find((candidate) => candidate.table === table);
    if (!entry) continue;
    const rows = JSON.parse(await readFile(join(directory, `${table}.json`), 'utf8')) as Row[];
    if (rows.length === 0) { result.tables.push({ table, offered: 0, inserted: 0 }); continue; }
    const present = new Set((await tableColumns(prisma, table)).map((column) => column.name));
    const columns = entry.columns.filter((column) => present.has(column));
    const firstPass = columns.filter((column) => !self.includes(column));
    const json = (data: Row[]) => JSON.stringify(data);
    const stripped = rows.map((row) => Object.fromEntries(firstPass.map((column) => [column, row[column]])));
    const inserted = await prisma.$transaction(async (tx) => {
      // json_populate_recordset gives every column its real type (uuid, enum, timestamp, jsonb).
      const count = await tx.$executeRawUnsafe(
        `INSERT INTO ${quote(table)} (${firstPass.map(quote).join(', ')})
           SELECT ${firstPass.map(quote).join(', ')} FROM json_populate_recordset(NULL::${quote(table)}, $1::json)
           ON CONFLICT DO NOTHING`,
        json(stripped),
      );
      if (self.length > 0 && present.has('id')) {
        const refs = rows.filter((row) => self.some((column) => row[column] != null)).map((row) => Object.fromEntries(['id', ...self].map((column) => [column, row[column]])));
        if (refs.length > 0) {
          await tx.$executeRawUnsafe(
            `UPDATE ${quote(table)} target SET ${self.map((column) => `${quote(column)} = source.${quote(column)}`).join(', ')}
               FROM json_populate_recordset(NULL::${quote(table)}, $1::json) source
              WHERE target.id = source.id`,
            json(refs),
          );
        }
      }
      return count;
    }, { timeout: 120_000 });
    result.tables.push({ table, offered: rows.length, inserted });
  }
  return result;
}

/** Row counts per exported table, for comparing two databases. */
export async function workGraphCounts(prisma: PrismaClient): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const { table } of WORKGRAPH_TABLES) {
    const [row] = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(`SELECT count(*)::bigint AS count FROM ${quote(table)}`);
    counts[table] = Number(row?.count ?? 0);
  }
  return counts;
}

export type { Prisma };
