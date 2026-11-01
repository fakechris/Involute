import { parseIql } from '@turnkeyai/involute-shared/iql';

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
