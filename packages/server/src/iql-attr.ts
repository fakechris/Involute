/**
 * IQL over field definitions (INV-1505, docs/field-definitions.md §6).
 *
 * `attr.<key>:value` (and lists, `none`, `any`) compiles to JSONB containment
 * on `Issue.attributes`, which the GIN (jsonb_path_ops) index answers.
 * Ranges (`attr.points:>=3`) and `sort:attr.<key>` need a searchable field and
 * read FieldValueIndex; on any other field they are refused with the reason,
 * never answered by a silent sequential scan.
 */
import { Prisma, type FieldDefinition, type FieldType, type PrismaClient } from '@prisma/client';

import { attrKey, isAttrField, readIqlSort, type IqlQuery, type IqlTerm } from '@turnkeyai/involute-shared';

import { compileTerm, iqlParseGraphQLError, type IqlCompileContext } from './iql-compile.js';

type DatabaseClient = PrismaClient | Prisma.TransactionClient;

export interface AttrSort { key: string; direction: 'asc' | 'desc'; column: IndexColumn }
export interface CompiledIql { where: Prisma.IssueWhereInput | undefined; sort: AttrSort | null }
type IndexColumn = 'numberValue' | 'dateValue' | 'textValue' | 'refId';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function searchableHint(key: string): string {
  return `attr.${key}: ranges and sorting need a searchable field; mark "${key}" searchable in its Fields settings (docs/field-definitions.md §6).`;
}

export function indexColumnFor(type: FieldType): IndexColumn {
  if (type === 'NUMBER') return 'numberValue';
  if (type === 'DATE') return 'dateValue';
  if (type === 'WORK_REF' || type === 'USER_REF') return 'refId';
  return 'textValue';
}

async function definitionsFor(prisma: DatabaseClient, key: string): Promise<FieldDefinition[]> {
  const definitions = await prisma.fieldDefinition.findMany({ where: { key, active: true } });
  if (!definitions.length) throw iqlParseGraphQLError(`attr.${key}: no active field definition has this key.`);
  return definitions;
}

/** One stored JSON value per written value, in the shape the validator stores. */
async function jsonValueFor(prisma: DatabaseClient, type: FieldType, raw: string, key: string, context: IqlCompileContext): Promise<unknown> {
  switch (type) {
    case 'NUMBER': {
      const value = Number(raw);
      if (!Number.isFinite(value)) throw iqlParseGraphQLError(`attr.${key} needs a number.`);
      return value;
    }
    case 'BOOLEAN':
      if (raw !== 'true' && raw !== 'false') throw iqlParseGraphQLError(`attr.${key} is true or false.`);
      return raw === 'true';
    case 'DATE': {
      if (Number.isNaN(Date.parse(raw))) throw iqlParseGraphQLError(`attr.${key} needs an ISO date.`);
      return new Date(raw).toISOString();
    }
    case 'MULTI_ENUM':
      return [raw];
    case 'USER_REF':
      if (raw.toLowerCase() === 'me') return context.viewerId ?? '00000000-0000-0000-0000-000000000000';
      return raw;
    case 'WORK_REF': {
      if (UUID.test(raw)) return raw;
      const work = await prisma.issue.findFirst({ where: { identifier: raw.toUpperCase() }, select: { id: true } });
      return work?.id ?? '00000000-0000-0000-0000-000000000000';
    }
    default:
      return raw;
  }
}

async function idsWithKey(prisma: DatabaseClient, key: string): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`SELECT id FROM "Issue" WHERE jsonb_exists(attributes, ${key})`;
  return rows.map((row) => row.id);
}

async function compileAttrTerm(prisma: DatabaseClient, term: IqlTerm, context: IqlCompileContext): Promise<Prisma.IssueWhereInput> {
  const key = attrKey(term.field!);
  const definitions = await definitionsFor(prisma, key);
  const wrap = (clause: Prisma.IssueWhereInput, negate: boolean): Prisma.IssueWhereInput => (negate ? { NOT: clause } : clause);
  const value = term.value.trim();

  if (term.op === 'eq' || term.op === 'neq') {
    const negate = term.negated !== (term.op === 'neq');
    if (value.toLowerCase() === 'none' || value.toLowerCase() === 'any') {
      const present: Prisma.IssueWhereInput = { id: { in: await idsWithKey(prisma, key) } };
      return wrap(present, (value.toLowerCase() === 'none') !== negate);
    }
    // Containment on the GIN index: one JSON object per value and per type the key has.
    const documents: string[] = [];
    for (const raw of value.split(',').map((entry) => entry.trim()).filter(Boolean)) {
      for (const type of new Set(definitions.map((definition) => definition.type))) {
        documents.push(JSON.stringify({ [key]: await jsonValueFor(prisma, type, raw, key, context) }));
      }
    }
    const conditions = documents.map((document) => Prisma.sql`attributes @> ${document}::jsonb`);
    const rows = await prisma.$queryRaw<Array<{ id: string }>>`SELECT id FROM "Issue" WHERE ${Prisma.join(conditions, ' OR ')}`;
    return wrap({ id: { in: rows.map((row) => row.id) } }, negate);
  }

  // Ranges: the typed index only.
  if (definitions.some((definition) => !definition.searchable)) throw iqlParseGraphQLError(searchableHint(key));
  const type = definitions[0]!.type;
  if (definitions.some((definition) => definition.type !== type)) throw iqlParseGraphQLError(`attr.${key} has different types in different scopes; compare it by equality only.`);
  const column = indexColumnFor(type);
  let bound: unknown;
  if (column === 'numberValue') {
    bound = Number(value);
    if (!Number.isFinite(bound as number)) throw iqlParseGraphQLError(`attr.${key} needs a number.`);
  } else if (column === 'dateValue') {
    if (Number.isNaN(Date.parse(value))) throw iqlParseGraphQLError(`attr.${key} needs an ISO date.`);
    bound = new Date(value);
  } else if (column === 'refId') {
    throw iqlParseGraphQLError(`attr.${key} is a reference; compare it by equality.`);
  } else {
    bound = value;
  }
  const operator = { gt: '>', gte: '>=', lt: '<', lte: '<=' }[term.op as 'gt' | 'gte' | 'lt' | 'lte'];
  const rows = await prisma.$queryRaw<Array<{ issueId: string }>>`
    SELECT DISTINCT "issueId" FROM "FieldValueIndex" WHERE key = ${key} AND ${Prisma.raw(`"${column}"`)} ${Prisma.raw(operator)} ${bound}`;
  return wrap({ id: { in: rows.map((row) => row.issueId) } }, term.negated);
}

async function compileSort(prisma: DatabaseClient, term: IqlTerm): Promise<AttrSort> {
  const sort = readIqlSort(term)!;
  const definitions = await definitionsFor(prisma, sort.key);
  if (definitions.some((definition) => !definition.searchable)) throw iqlParseGraphQLError(searchableHint(sort.key));
  return { ...sort, column: indexColumnFor(definitions[0]!.type) };
}

/**
 * Compile a query that may hold `attr.<key>` and `sort:` terms. The where
 * clause combines like `compileIqlToIssueWhere`; `sort` is for list callers
 * that support it (`orderIdsByAttribute`), others refuse it.
 */
export async function compileIqlWhere(prisma: DatabaseClient, query: IqlQuery, context: IqlCompileContext): Promise<CompiledIql> {
  const clauses: Prisma.IssueWhereInput[] = [];
  let sort: AttrSort | null = null;
  for (const term of query.terms) {
    if (term.field === 'sort') {
      if (sort) throw iqlParseGraphQLError('Only one sort term.');
      sort = await compileSort(prisma, term);
    } else if (isAttrField(term.field)) {
      clauses.push(await compileAttrTerm(prisma, term, context));
    } else {
      clauses.push(compileTerm(term, context));
    }
  }
  return { where: clauses.length ? { AND: clauses } : undefined, sort };
}

/** For callers whose order is fixed (ready lists, ranked search): sort is refused, not ignored. */
export function refuseSort(compiled: CompiledIql, where: string): Prisma.IssueWhereInput | undefined {
  if (compiled.sort) throw iqlParseGraphQLError(`sort is not supported in ${where}; use work_search or the issues query.`);
  return compiled.where;
}

/**
 * Order work ids by a searchable field's typed index rows: smallest value per
 * item (a MULTI_ENUM's first option), items without a value last, the given
 * order breaking ties.
 */
export async function orderIdsByAttribute(prisma: DatabaseClient, ids: string[], sort: AttrSort): Promise<string[]> {
  if (!ids.length) return [];
  const rows = await prisma.$queryRaw<Array<{ issueId: string; value: unknown }>>`
    SELECT "issueId", MIN(${Prisma.raw(`"${sort.column}"${sort.column === 'refId' ? '::text' : ''}`)}) AS value
    FROM "FieldValueIndex" WHERE key = ${sort.key} AND "issueId" IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})
    GROUP BY "issueId"`;
  const values = new Map(rows.map((row) => [row.issueId, row.value]));
  const position = new Map(ids.map((id, index) => [id, index]));
  const compare = (left: unknown, right: unknown): number => {
    if (left instanceof Date && right instanceof Date) return left.getTime() - right.getTime();
    if (typeof left === 'number' && typeof right === 'number') return left - right;
    return String(left).localeCompare(String(right));
  };
  return [...ids].sort((left, right) => {
    const a = values.get(left);
    const b = values.get(right);
    if (a === undefined || a === null) return b === undefined || b === null ? position.get(left)! - position.get(right)! : 1;
    if (b === undefined || b === null) return -1;
    const order = compare(a, b);
    if (order !== 0) return sort.direction === 'desc' ? -order : order;
    return position.get(left)! - position.get(right)!;
  });
}

/**
 * For filters evaluated in memory (webhook subscriptions, INV-1525): rewrite
 * each `attr.<key>` value into the form the validator stores — a work
 * identifier becomes its id, `me` the viewer, a date its ISO time, a number
 * or boolean its canonical text — so the in-memory match agrees with search.
 * Unknown keys and unparseable values are left as written (they match nothing).
 */
export async function normalizeAttrTerms(prisma: DatabaseClient, query: IqlQuery, context: IqlCompileContext): Promise<IqlQuery> {
  const terms: IqlTerm[] = [];
  for (const term of query.terms) {
    if (!isAttrField(term.field)) { terms.push(term); continue; }
    const key = attrKey(term.field);
    const raw = term.value.trim();
    const definition = await prisma.fieldDefinition.findFirst({ where: { key, active: true }, orderBy: { createdAt: 'desc' } });
    if (!definition || raw === 'none' || raw === 'any') { terms.push(term); continue; }
    const values: string[] = [];
    for (const entry of raw.split(',').map((part) => part.trim()).filter(Boolean)) {
      try {
        const normalized = await jsonValueFor(prisma, definition.type, entry, key, context);
        values.push(String(Array.isArray(normalized) ? normalized[0] : normalized));
      } catch {
        values.push(entry);
      }
    }
    terms.push({ ...term, value: values.join(',') });
  }
  return { ...query, terms };
}
