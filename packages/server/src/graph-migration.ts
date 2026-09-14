import { createHash } from 'node:crypto';
import { WorkKind, type Prisma, type PrismaClient } from '@prisma/client';
import { assertContainsEndpoints, lockWorkGraph } from './graph-integrity.js';
import { createValidationError } from './errors.js';
import { INTERNAL_WRITE_ACTOR, recordWorkAudit, selectIssueSnapshot, type WriteActor } from './work-service.js';

interface Structure { parentId: string | null; kind: WorkKind; repository: string | null }
interface NodeSnapshot extends Structure { id: string; teamId: string; revision: number }
interface EdgeSnapshot { id: string; fromId: string; toId: string; actorId: string | null; createdAt: string }
interface Snapshot { nodes: NodeSnapshot[]; edges: EdgeSnapshot[] }
interface Entry { id: string; expectedRevision: number; to: Structure }
export interface GraphMigrationRequest { teamId: string; reason: string; entries: Entry[] }
interface Plan extends GraphMigrationRequest { version: 1; before: Snapshot }
type Request = GraphMigrationRequest;

/** Read-only coherent snapshot: no advisory lock or write is needed in repeatable-read. */
export async function previewGraphMigration(prisma: PrismaClient, input: Request): Promise<Plan> {
  const request = parseRequest(input);
  return prisma.$transaction(async tx => {
    const before = await snapshot(tx, request.teamId);
    validateProjection(before, request);
    return { version: 1, ...request, before };
  }, { isolationLevel: 'RepeatableRead' });
}

export async function applyGraphMigration(prisma: PrismaClient, input: unknown, actor: WriteActor = INTERNAL_WRITE_ACTOR) {
  const plan = parsePlan(input);
  const planHash = digest(plan);
  return prisma.$transaction(async tx => {
    await lockWorkGraph(tx, plan.teamId);
    const prior = await tx.workGraphMigration.findUnique({ where: { planHash } });
    if (prior) return prior; // Never repeat a committed or subsequently rolled-back plan.
    const current = await snapshot(tx, plan.teamId);
    if (digest(current) !== digest(plan.before)) throw createValidationError('Graph migration preview is stale. Generate a new preview.');
    validateProjection(current, plan);
    for (const entry of plan.entries) {
      const before = await tx.issue.findUniqueOrThrow({ where: { id: entry.id } });
      await tx.workLink.deleteMany({ where: { toId: entry.id, type: 'CONTAINS' } });
      const changed = await tx.issue.updateMany({
        where: { id: entry.id, teamId: plan.teamId, revision: entry.expectedRevision },
        data: { ...entry.to, revision: { increment: 1 } },
      });
      if (changed.count !== 1) throw createValidationError('Graph migration revision conflict.');
      if (entry.to.parentId) await tx.workLink.create({ data: {
        fromId: entry.to.parentId, toId: entry.id, type: 'CONTAINS', actorId: actor.actorId ?? null,
      } });
      const after = await tx.issue.findUniqueOrThrow({ where: { id: entry.id } });
      await recordWorkAudit(tx, { actor: { ...actor, reason: plan.reason, surface: 'graph-migration' },
        before: selectIssueSnapshot(before), after: selectIssueSnapshot(after), workId: entry.id });
    }
    const after = await snapshot(tx, plan.teamId);
    return tx.workGraphMigration.create({ data: {
      planHash, teamId: plan.teamId, actorId: actor.actorId ?? null, reason: plan.reason,
      plan: json(plan), before: json(current), after: json(after),
    } });
  }, { timeout: 30_000 });
}

/** Restore only the recorded structural fields/edges, never workflow or execution history. */
export async function rollbackGraphMigration(prisma: PrismaClient, receiptId: string, actor: WriteActor = INTERNAL_WRITE_ACTOR) {
  id(receiptId);
  return prisma.$transaction(async tx => {
    const hint = await tx.workGraphMigration.findUniqueOrThrow({ where: { id: receiptId } });
    await lockWorkGraph(tx, hint.teamId);
    const receipt = await tx.workGraphMigration.findUniqueOrThrow({ where: { id: receiptId } });
    if (receipt.status === 'ROLLED_BACK') return receipt;
    if (receipt.status !== 'APPLIED') throw createValidationError('Unsupported migration receipt state.');
    const current = await snapshot(tx, receipt.teamId);
    if (digest(current) !== digest(parseSnapshot(receipt.after))) {
      throw createValidationError('Graph changed after migration; rollback would overwrite newer work.');
    }
    const beforeGraph = parseSnapshot(receipt.before);
    const plan = parsePlan(receipt.plan);
    for (const entry of plan.entries) {
      const original = beforeGraph.nodes.find(node => node.id === entry.id)!;
      const before = await tx.issue.findUniqueOrThrow({ where: { id: entry.id } });
      await tx.workLink.deleteMany({ where: { toId: entry.id, type: 'CONTAINS' } });
      const changed = await tx.issue.updateMany({ where: { id: entry.id, revision: before.revision }, data: {
        parentId: original.parentId, kind: original.kind, repository: original.repository, revision: { increment: 1 },
      } });
      if (changed.count !== 1) throw createValidationError('Graph rollback revision conflict.');
      const edges = beforeGraph.edges.filter(edge => edge.toId === entry.id);
      if (edges.length) await tx.workLink.createMany({ data: edges.map(edge => ({ ...edge, type: 'CONTAINS', createdAt: new Date(edge.createdAt) })) });
      const after = await tx.issue.findUniqueOrThrow({ where: { id: entry.id } });
      await recordWorkAudit(tx, { actor: { ...actor, reason: `Rollback ${receipt.id}: ${receipt.reason}`, surface: 'graph-migration-rollback' },
        before: selectIssueSnapshot(before), after: selectIssueSnapshot(after), workId: entry.id });
    }
    return tx.workGraphMigration.update({ where: { id: receipt.id }, data: { status: 'ROLLED_BACK', rolledBackAt: new Date() } });
  }, { timeout: 30_000 });
}

async function snapshot(tx: Prisma.TransactionClient, teamId: string): Promise<Snapshot> {
  const nodes = await tx.issue.findMany({ where: { teamId }, orderBy: { id: 'asc' }, select: {
    id: true, teamId: true, parentId: true, kind: true, repository: true, revision: true,
  } });
  const edges = await tx.workLink.findMany({ where: { type: 'CONTAINS', OR: [{ from: { teamId } }, { to: { teamId } }] },
    orderBy: { id: 'asc' }, select: { id: true, fromId: true, toId: true, actorId: true, createdAt: true } });
  return { nodes, edges: edges.map(edge => ({ ...edge, createdAt: edge.createdAt.toISOString() })) };
}

function validateProjection(before: Snapshot, request: Request): void {
  const ids = new Set(request.entries.map(entry => entry.id));
  if (ids.size !== request.entries.length) throw createValidationError('Duplicate migration entry.');
  const nodes = new Map(before.nodes.map(node => [node.id, { ...node }]));
  for (const entry of request.entries) {
    const original = nodes.get(entry.id);
    if (!original || original.teamId !== request.teamId || original.revision !== entry.expectedRevision) throw createValidationError('Invalid migration node or revision.');
    nodes.set(entry.id, { ...original, ...entry.to });
  }
  const edges = before.edges.filter(edge => !ids.has(edge.toId)).map(edge => ({ fromId: edge.fromId, toId: edge.toId }));
  for (const node of nodes.values()) if (node.parentId) edges.push({ fromId: node.parentId, toId: node.id });
  for (const id of ids) {
    const incoming = new Set(edges.filter(edge => edge.toId === id).map(edge => edge.fromId));
    if (incoming.size > 1) throw createValidationError('Projected graph has multiple parents.');
    for (const edge of edges.filter(edge => edge.fromId === id || edge.toId === id)) {
      const parent = nodes.get(edge.fromId); const child = nodes.get(edge.toId);
      if (!parent || !child) throw createValidationError('Migration cannot repair cross-team or missing endpoints.');
      assertContainsEndpoints(parent, child);
    }
    const seen = new Set<string>(); const queue = [id];
    while (queue.length) {
      const next = queue.pop()!;
      if (seen.has(next)) continue;
      seen.add(next);
      for (const edge of edges.filter(edge => edge.fromId === next)) {
        if (edge.toId === id) throw createValidationError('Projected hierarchy contains a cycle.');
        queue.push(edge.toId);
      }
    }
  }
}

function digest(value: unknown): string {
  const canonical = (v: any): any => Array.isArray(v) ? v.map(canonical)
    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(key => [key, canonical(v[key])])) : v;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
function json(value: unknown): Prisma.InputJsonValue { return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue; }

function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw createValidationError('Expected a migration object.');
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some(key => !keys.includes(key)) || keys.some(key => !(key in result))) throw createValidationError('Unexpected or missing migration fields.');
  return result;
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw createValidationError('Expected UUID.');
  return value;
}
function revision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw createValidationError('Expected positive revision.');
  return value;
}
function parseStructure(value: unknown): Structure {
  const v = object(value, ['parentId', 'kind', 'repository']);
  if (!Object.values(WorkKind).includes(v.kind as WorkKind) || (v.repository !== null && typeof v.repository !== 'string')) throw createValidationError('Invalid kind or repository.');
  return { parentId: v.parentId === null ? null : id(v.parentId), kind: v.kind as WorkKind, repository: v.repository as string | null };
}
function parseRequest(value: unknown): Request {
  const v = object(value, ['teamId', 'reason', 'entries']);
  if (typeof v.reason !== 'string' || !v.reason.trim() || v.reason.length > 2000 || !Array.isArray(v.entries) || !v.entries.length || v.entries.length > 100) throw createValidationError('A reason and 1–100 entries are required.');
  return { teamId: id(v.teamId), reason: v.reason.trim(), entries: v.entries.map(value => {
    const e = object(value, ['id', 'expectedRevision', 'to']);
    return { id: id(e.id), expectedRevision: revision(e.expectedRevision), to: parseStructure(e.to) };
  }) };
}
function parseSnapshot(value: unknown): Snapshot {
  const v = object(value, ['nodes', 'edges']);
  if (!Array.isArray(v.nodes) || !Array.isArray(v.edges)) throw createValidationError('Invalid graph snapshot.');
  return { nodes: v.nodes.map(value => {
    const n = object(value, ['id', 'teamId', 'revision', 'parentId', 'kind', 'repository']);
    return { id: id(n.id), teamId: id(n.teamId), revision: revision(n.revision), ...parseStructure({ parentId: n.parentId, kind: n.kind, repository: n.repository }) };
  }), edges: v.edges.map(value => {
    const e = object(value, ['id', 'fromId', 'toId', 'actorId', 'createdAt']);
    if (typeof e.createdAt !== 'string' || !Number.isFinite(Date.parse(e.createdAt))) throw createValidationError('Invalid edge timestamp.');
    return { id: id(e.id), fromId: id(e.fromId), toId: id(e.toId), actorId: e.actorId === null ? null : id(e.actorId), createdAt: e.createdAt };
  }) };
}
function parsePlan(value: unknown): Plan {
  const v = object(value, ['version', 'teamId', 'reason', 'entries', 'before']);
  if (v.version !== 1) throw createValidationError('Unsupported migration version.');
  return { version: 1, ...parseRequest({ teamId: v.teamId, reason: v.reason, entries: v.entries }), before: parseSnapshot(v.before) };
}
