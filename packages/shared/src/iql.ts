/**
 * IQL — the Involute Query Language.
 *
 * One small term-based filter language shared by every surface that selects
 * work: MCP `work_search`/`work_list_ready`, the GraphQL `issues`/`readyWork`
 * `query` argument, the CLI `--query` flag, web saved views, and webhook
 * subscription filters. The parser is dependency-free so it can run in the
 * server, the web bundle, and the CLI.
 *
 * Grammar (v1, deliberately without OR/parentheses):
 *   query   := term*
 *   term    := '-'? ( field_expr | free_text )
 *   field   := 'field' ':' op? value        op ∈ gt|gte|lt|lte|neq (as >, >=, <, <=, !=)
 *   value   := bareword | "quoted string"   (','-separated values become IN)
 *
 * Fields: team, state, state-type, kind, commitment, assignee, label,
 * priority, updated, link, has. Bare words match title/description text.
 */

export class IqlParseError extends Error {
  readonly term: string;
  readonly position: number;

  constructor(message: string, term: string, position: number) {
    super(message);
    this.name = 'IqlParseError';
    this.term = term;
    this.position = position;
  }
}

export type IqlComparisonOp = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte';

export interface IqlTerm {
  /** Field name; null means free-text term. */
  field: string | null;
  op: IqlComparisonOp;
  /** Raw value as written; `a,b,c` lists stay a single string until compile. */
  value: string;
  negated: boolean;
  /** 1-based term index for error messages. */
  index: number;
}

export interface IqlQuery {
  terms: IqlTerm[];
}

export const IQL_FIELDS = [
  'team',
  'state',
  'state-type',
  'kind',
  'commitment',
  'assignee',
  'label',
  'priority',
  'updated',
  'link',
  'has',
] as const;

export type IqlField = (typeof IQL_FIELDS)[number];

const COMPARISON_PREFIXES = ['>=', '<=', '!=', '>', '<'] as const;

/** Tokenize on whitespace, keeping quoted spans together. */
function tokenize(input: string, query: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let sawQuote = false;

  for (const char of input) {
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      sawQuote = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (current || sawQuote) {
        tokens.push(current);
        current = '';
        sawQuote = false;
      }
      continue;
    }
    current += char;
  }
  if (quote) {
    throw new IqlParseError('Unterminated quoted string.', input, query.length);
  }
  if (current || sawQuote) {
    tokens.push(current);
  }
  return tokens;
}

function parseOpAndValue(raw: string): { op: IqlComparisonOp; value: string } {
  for (const prefix of COMPARISON_PREFIXES) {
    if (raw.startsWith(prefix)) {
      return {
        op: prefix === '>=' ? 'gte' : prefix === '<=' ? 'lte' : prefix === '!=' ? 'neq' : prefix === '>' ? 'gt' : 'lt',
        value: raw.slice(prefix.length),
      };
    }
  }
  return { op: 'eq', value: raw };
}

export function parseIql(query: string): IqlQuery {
  const tokens = tokenize(query, query);
  const terms: IqlTerm[] = [];

  tokens.forEach((token, position) => {
    const negated = token.startsWith('-') && token.length > 1 && !/^\d/.test(token.slice(1));
    const body = negated ? token.slice(1) : token;
    const colon = body.indexOf(':');

    if (colon === -1) {
      terms.push({ field: null, op: 'eq', value: body, negated, index: position + 1 });
      return;
    }

    const field = body.slice(0, colon).toLowerCase();
    if (!(IQL_FIELDS as readonly string[]).includes(field)) {
      throw new IqlParseError(
        `Unknown field "${field}". Valid fields: ${IQL_FIELDS.join(', ')}.`,
        token,
        position + 1,
      );
    }
    const { op, value } = parseOpAndValue(body.slice(colon + 1));
    if (!value) {
      throw new IqlParseError(`Field "${field}" requires a value.`, token, position + 1);
    }
    if ((field === 'priority' || field === 'updated') && value.includes(',')) {
      throw new IqlParseError(`Field "${field}" accepts a single value, not a list.`, token, position + 1);
    }
    terms.push({ field, op, value, negated, index: position + 1 });
  });

  return { terms };
}

/** Human-readable re-rendering, e.g. for tool responses and UI chips. */
export function describeIql(query: IqlQuery): string {
  return query.terms
    .map((term) => {
      const prefix = term.negated ? '-' : '';
      if (term.field === null) {
        return `${prefix}${term.value}`;
      }
      const opText = term.op === 'eq' ? '' : term.op === 'neq' ? '!=' : term.op === 'gt' ? '>' : term.op === 'gte' ? '>=' : term.op === 'lt' ? '<' : '<=';
      return `${prefix}${term.field}:${opText}${term.value}`;
    })
    .join(' ');
}

/** Parse + validate in one call for surfaces that only need a validity gate. */
export function assertValidIql(query: string): IqlQuery {
  return parseIql(query);
}
