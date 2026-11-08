import { parseIql, type IqlTerm } from '@turnkeyai/involute-shared/iql';

import { isWorkIdentifier } from '../work/work-reference';

/** The identifier in `neighbourhood:INV-1739`, if the query has that term (INV-1758). */
export function neighbourhoodIdentifierOf(query: string): string | null {
  try {
    const term = parseIql(query).terms.find((item) => item.field === 'neighbourhood' && !item.negated);
    const value = term?.value.split(',')[0]?.trim().toUpperCase() ?? '';
    return isWorkIdentifier(value) ? value : null;
  } catch {
    return null;
  }
}

const OP_TEXT = { eq: '', neq: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=' } as const;

function quoteIqlValue(value: string): string {
  if (value === '' || /[\s"]/.test(value)) return `"${value.replaceAll('"', '')}"`;
  return value;
}

function formatIqlTerm(term: IqlTerm): string {
  const neg = term.negated ? '-' : '';
  if (term.field === null) return `${neg}${quoteIqlValue(term.value)}`;
  return `${neg}${term.field}:${OP_TEXT[term.op]}${quoteIqlValue(term.value)}`;
}

/** Drop the neighbourhood chip's term, leaving the rest of the query. */
export function withoutNeighbourhoodTerm(query: string): string {
  try {
    let dropped = false;
    const kept = parseIql(query).terms.filter((term) => {
      if (!dropped && term.field === 'neighbourhood' && !term.negated) {
        dropped = true;
        return false;
      }
      return true;
    });
    return kept.map(formatIqlTerm).join(' ');
  } catch {
    return query
      .replace(/(^|\s)-?neighbourhood:(?:"[^"]+"|'[^']+'|\S+)/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
}

/**
 * True when the saved-view query uses IQL field syntax (any `field:value`
 * token). Plain text keeps the legacy substring behaviour.
 *
 * The board hands the query to the server and keeps its answer (INV-1470):
 * the server searches the bodies, the parent, the project and the repository,
 * so a second search in the browser would only drop what the server matched.
 */
export function looksLikeIql(query: string): boolean {
  try {
    const parsed = parseIql(query);
    return parsed.terms.some((term) => term.field !== null);
  } catch {
    return false;
  }
}
