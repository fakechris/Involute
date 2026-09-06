import type { Issue, Prisma, WorkLinkType, WorkflowStateType } from '@prisma/client';

import { GraphQLError } from 'graphql';

import {
  describeIql,
  IqlParseError,
  parseIql,
  type IqlComparisonOp,
  type IqlQuery,
  type IqlTerm,
} from '@turnkeyai/involute-shared';

import { IQL_PARSE_ERROR_PREFIX } from './errors.js';

type DatabaseWork = Issue & {
  assignee: { actorKind: string; id: string } | null;
  labels: Array<{ name: string }>;
  state: { type: WorkflowStateType; name: string } | null;
};

const WORKFLOW_STATE_TYPES: readonly WorkflowStateType[] = [
  'BACKLOG',
  'UNSTARTED',
  'STARTED',
  'REVIEW',
  'COMPLETED',
  'CANCELED',
];

const WORK_KINDS = ['ISSUE', 'PROJECT', 'MILESTONE', 'DECISION', 'EPIC'] as const;
const COMMITMENT_STATUSES = ['CANDIDATE', 'COMMITTED', 'REJECTED'] as const;

const LINK_TYPE_ALIASES: Record<string, WorkLinkType> = {
  'blocked-by': 'BLOCKS',
  blocks: 'BLOCKS',
  contains: 'CONTAINS',
  derived_from: 'DERIVED_FROM',
  discovered_during: 'DISCOVERED_DURING',
  related_to: 'RELATED_TO',
  duplicate_of: 'DUPLICATE_OF',
};

export interface IqlCompileContext {
  /** Resolves `assignee:me`; null turns the term into a no-match filter. */
  viewerId: string | null;
}

/** Throws an IQL_PARSE GraphQLError that the error masker exposes verbatim. */
export function iqlParseGraphQLError(message: string): GraphQLError {
  return new GraphQLError(`${IQL_PARSE_ERROR_PREFIX} ${message}`, {
    extensions: { code: 'IQL_PARSE' },
  });
}

/** Throws IqlParseError-style GraphQLError-exposed failures on bad syntax. */
export function parseIqlOrThrow(query: string): IqlQuery {
  try {
    return parseIql(query);
  } catch (error) {
    if (error instanceof IqlParseError) {
      throw iqlParseGraphQLError(error.message);
    }
    throw error;
  }
}

function durationToMs(value: string, term: IqlTerm): number {
  const match = /^(\d+)\s*(s|m|h|d|w)$/i.exec(value.trim());
  if (!match) {
    throw iqlParseGraphQLError(`updated:${term.op === 'eq' ? '' : term.op === 'neq' ? '!=' : ''}${value} needs a duration like 30d, 2h, 1w.`,
    );
  }
  const amount = Number(match[1]);
  const unit = match[2]!.toLowerCase();
  const multipliers: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
  return amount * multipliers[unit]!;
}

function buildDateTimeClause(
  op: IqlComparisonOp,
  cutoff: Date,
): Prisma.DateTimeFilter | undefined {
  switch (op) {
    case 'gt':
      return { gt: cutoff };
    case 'gte':
      return { gte: cutoff };
    case 'lt':
      return { lt: cutoff };
    case 'lte':
      return { lte: cutoff };
    case 'neq':
      return { not: cutoff };
    default:
      return undefined;
  }
}

function buildNumberClause(op: IqlComparisonOp, value: number): Prisma.IntFilter | undefined {
  switch (op) {
    case 'gt':
      return { gt: value };
    case 'gte':
      return { gte: value };
    case 'lt':
      return { lt: value };
    case 'lte':
      return { lte: value };
    case 'neq':
      return { not: value };
    default:
      return undefined;
  }
}

/**
 * Compile one IQL term into a Prisma clause. Terms combine with AND; a
 * negated term contributes `NOT: { ... }`.
 */
function compileTerm(term: IqlTerm, context: IqlCompileContext): Prisma.IssueWhereInput {
  const include = !term.negated;
  const clauseFor = (clause: Prisma.IssueWhereInput): Prisma.IssueWhereInput =>
    include ? clause : { NOT: clause };

  if (term.field === null) {
    const text = { contains: term.value, mode: 'insensitive' as const };
    return clauseFor({ OR: [{ title: text }, { description: text }] });
  }

  const values = term.value.split(',').map((value) => value.trim()).filter(Boolean);
  const listContains = (candidate: string): boolean => values.includes(candidate.toLowerCase());

  switch (term.field) {
    case 'team':
      return clauseFor(values.length > 1 ? { team: { key: { in: values } } } : { team: { is: { key: values[0] ?? '' } } });
    case 'state':
      return clauseFor(
        values.length > 1
          ? { state: { is: { name: { in: values } } } }
          : { state: { is: { name: { equals: values[0] ?? '' } } } },
      );
    case 'state-type': {
      const upper = values.map((value) => value.toUpperCase());
      const valid = upper.every((value) => (WORKFLOW_STATE_TYPES as readonly string[]).includes(value));
      if (!valid) {
        throw iqlParseGraphQLError(`state-type must be one of ${WORKFLOW_STATE_TYPES.join(', ')}.`,
        );
      }
      return clauseFor({ state: { is: { type: { in: upper as WorkflowStateType[] } } } });
    }
    case 'kind': {
      const upper = values.map((value) => value.toUpperCase());
      if (!upper.every((value) => (WORK_KINDS as readonly string[]).includes(value))) {
        throw iqlParseGraphQLError(`kind must be one of ${WORK_KINDS.join(', ')}.`);
      }
      return clauseFor({ kind: { in: upper as (typeof WORK_KINDS)[number][] } });
    }
    case 'commitment': {
      const upper = values.map((value) => value.toUpperCase());
      if (!upper.every((value) => (COMMITMENT_STATUSES as readonly string[]).includes(value))) {
        throw iqlParseGraphQLError(`commitment must be one of ${COMMITMENT_STATUSES.join(', ')}.`,
        );
      }
      return clauseFor({ commitmentStatus: { in: upper as (typeof COMMITMENT_STATUSES)[number][] } });
    }
    case 'assignee': {
      const value = values[0] ?? '';
      if (value.toLowerCase() === 'me') {
        if (!context.viewerId) {
          // Anonymous `me` matches nothing rather than everything.
          return include ? { id: { in: [] } } : {};
        }
        return clauseFor({ assigneeId: context.viewerId });
      }
      if (value.toLowerCase() === 'none') {
        return clauseFor({ assigneeId: null });
      }
      return clauseFor({ assigneeId: value });
    }
    case 'label':
      return clauseFor(values.length > 1
        ? { labels: { some: { name: { in: values } } } }
        : { labels: { some: { name: { equals: values[0] ?? '' } } } });
    case 'priority': {
      const numeric = Number(values[0]);
      if (!Number.isFinite(numeric)) {
        throw iqlParseGraphQLError(`priority needs a number.`);
      }
      if (term.op === 'eq') {
        return clauseFor({ priority: { equals: numeric } });
      }
      const clause = buildNumberClause(term.op, numeric);
      return clause ? clauseFor({ priority: clause }) : {};
    }
    case 'updated': {
      // `updated:>30d` = updated within the last 30 days (cutoff = now-30d).
      const ms = durationToMs(values[0] ?? '', term);
      const cutoff = new Date(Date.now() - ms);
      const clause = buildDateTimeClause(term.op, cutoff);
      return clause ? clauseFor({ updatedAt: clause }) : {};
    }
    case 'link': {
      const [rawType, target] = term.value.split(':').map((part) => part?.trim());
      if (!rawType || !target) {
        throw iqlParseGraphQLError(`link needs link:<type>:<identifier|none>, e.g. link:blocked-by:none.`,
        );
      }
      const linkType = LINK_TYPE_ALIASES[rawType.toLowerCase()];
      if (!linkType) {
        throw iqlParseGraphQLError(`unknown link type "${rawType}".`);
      }
      if (target.toLowerCase() === 'none') {
        return clauseFor({
          incomingLinks: {
            none: {
              type: linkType,
              from: { state: { type: { in: ['BACKLOG', 'UNSTARTED', 'STARTED', 'REVIEW'] as WorkflowStateType[] } } },
            },
          },
        });
      }
      return clauseFor({
        incomingLinks: {
          some: { type: linkType, from: { identifier: { equals: target } } },
        },
      });
    }
    case 'has': {
      const value = values[0]?.toLowerCase() ?? '';
      switch (value) {
        case 'contract':
          return clauseFor({
            OR: [
              { outcome: { not: null } },
              { scope: { not: null } },
              { constraints: { not: null } },
              { acceptance: { not: null } },
              { verification: { not: null } },
            ],
          });
        case 'claim':
          return clauseFor({ claim: { isNot: null } });
        case 'run':
          return clauseFor({ runs: { some: {} } });
        case 'evidence':
          return clauseFor({ evidence: { some: {} } });
        default:
          throw iqlParseGraphQLError(`has must be one of contract, claim, run, evidence.`);
      }
    }
    default:
      throw iqlParseGraphQLError(`unknown field "${term.field}".`);
  }
}

export function compileIqlToIssueWhere(
  query: IqlQuery,
  context: IqlCompileContext,
): Prisma.IssueWhereInput | undefined {
  if (query.terms.length === 0) {
    return undefined;
  }
  return {
    AND: query.terms.map((term) => compileTerm(term, context)),
  };
}

/**
 * In-memory predicate with the same semantics as compileIqlToIssueWhere, used
 * for webhook subscription filters where the work row is already in hand.
 */
export function compileIqlPredicate(
  query: IqlQuery,
  context: IqlCompileContext,
): (work: DatabaseWork) => boolean {
  return (work) => query.terms.every((term) => matchTerm(term, work, context));
}

function matchTerm(term: IqlTerm, work: DatabaseWork, context: IqlCompileContext): boolean {
  const matched = matchPositive(term, work, context);
  return term.negated ? !matched : matched;
}

function matchPositive(term: IqlTerm, work: DatabaseWork, context: IqlCompileContext): boolean {
  if (term.field === null) {
    const needle = term.value.toLowerCase();
    return (
      work.title.toLowerCase().includes(needle) ||
      (work.description ?? '').toLowerCase().includes(needle)
    );
  }

  const values = term.value.split(',').map((value) => value.trim());
  const listContains = (candidate: string): boolean => values.some((value) => value.toLowerCase() === candidate.toLowerCase());

  switch (term.field) {
    case 'team':
      return listContains(work.identifier.split('-')[0] ?? '');
    case 'state':
      return values.some((value) => value.toLowerCase() === work.state?.name.toLowerCase());
    case 'state-type':
      return values.some((value) => value.toUpperCase() === work.state?.type);
    case 'kind':
      return values.some((value) => value.toUpperCase() === work.kind);
    case 'commitment':
      return values.some((value) => value.toUpperCase() === work.commitmentStatus);
    case 'assignee': {
      const value = values[0]?.toLowerCase() ?? '';
      if (value === 'me') {
        return Boolean(context.viewerId) && work.assignee?.id === context.viewerId;
      }
      if (value === 'none') {
        return work.assigneeId === null;
      }
      return work.assigneeId === values[0];
    }
    case 'label':
      return values.some((value) => work.labels.some((label) => label.name.toLowerCase() === value.toLowerCase()));
    case 'priority': {
      const numeric = Number(values[0]);
      if (!Number.isFinite(numeric)) return false;
      switch (term.op) {
        case 'eq': return work.priority === numeric;
        case 'neq': return work.priority !== numeric;
        case 'gt': return work.priority > numeric;
        case 'gte': return work.priority >= numeric;
        case 'lt': return work.priority < numeric;
        case 'lte': return work.priority <= numeric;
      }
      return false;
    }
    case 'updated': {
      const ms = durationToMs(values[0] ?? '', term);
      const cutoff = new Date(Date.now() - ms).getTime();
      const updated = work.updatedAt.getTime();
      switch (term.op) {
        case 'eq': return updated === cutoff;
        case 'neq': return updated !== cutoff;
        case 'gt': return updated > cutoff;
        case 'gte': return updated >= cutoff;
        case 'lt': return updated < cutoff;
        case 'lte': return updated <= cutoff;
      }
      return false;
    }
    case 'link': {
      const [rawType, target] = term.value.split(':').map((part) => part?.trim());
      if (!rawType || !target) return false;
      const linkType = LINK_TYPE_ALIASES[rawType.toLowerCase()];
      if (!linkType) return false;
      void linkType;
      // Predicate evaluation has no link graph loaded; only the cheap
      // identifier-driven `blocked-by`-style checks would be possible, so
      // links simply don't match here unless the caller preloaded them.
      return false;
    }
    case 'has': {
      const value = values[0]?.toLowerCase() ?? '';
      switch (value) {
        case 'contract':
          return [work.outcome, work.scope, work.constraints, work.acceptance, work.verification]
            .some((field) => field !== null && field !== undefined);
        case 'claim':
        case 'run':
        case 'evidence':
          // Relation presence checks are not supported in the in-memory
          // predicate; webhook filters should avoid `has:` for relations.
          return false;
        default:
          return false;
      }
    }
    default:
      return false;
  }
}

export function describeIqlQuery(query: IqlQuery): string {
  return describeIql(query);
}
