import { useMemo, useState } from 'react';

import type { UserSummary } from '../board/types';

/**
 * `@` completion for the comment composer.
 *
 * Without it there is no way to discover who is mentionable: the handle has to
 * be resolvable server-side (INV-558), so a typo silently resolves to nothing
 * and the question is never delivered. The list is the same agent directory the
 * server resolves against, so what you can pick is exactly what will resolve.
 */
export interface MentionQuery {
  /** Characters typed after the `@`, lowercased. */
  term: string;
  /** Index of the `@` itself. */
  start: number;
}

// Mirrors the server's mention scanner: an `@` preceded by a word character,
// `.`, `-`, `/` or another `@` is not a mention, so it must not open the menu
// either (an email address is the common case).
const TRIGGER = /(^|[^A-Za-z0-9_@.\-/])@([A-Za-z0-9_-]{0,32})$/;

export function findMentionQuery(value: string, caret: number): MentionQuery | null {
  const upToCaret = value.slice(0, caret);
  const match = TRIGGER.exec(upToCaret);

  if (!match) {
    return null;
  }

  const term = match[2] ?? '';

  return { start: caret - term.length - 1, term: term.toLowerCase() };
}

export function applyMention(
  value: string,
  query: MentionQuery,
  handle: string,
  caret: number,
): { caret: number; value: string } {
  const next = `${value.slice(0, query.start)}@${handle} ${value.slice(caret)}`;

  return { caret: query.start + handle.length + 2, value: next };
}

export function useMentionSuggest(agents: UserSummary[]) {
  const [query, setQuery] = useState<MentionQuery | null>(null);
  const [highlighted, setHighlighted] = useState(0);

  const matches = useMemo(() => {
    if (!query) {
      return [];
    }

    return agents
      .filter((agent) => {
        if (!agent.handle) {
          return false;
        }
        if (!query.term) {
          return true;
        }
        return (
          agent.handle.includes(query.term)
          || (agent.name ?? '').toLowerCase().includes(query.term)
        );
      })
      .slice(0, 8);
  }, [agents, query]);

  return {
    close: () => setQuery(null),
    highlighted: matches.length === 0 ? 0 : Math.min(highlighted, matches.length - 1),
    matches,
    query,
    setHighlighted,
    setQuery: (next: MentionQuery | null) => {
      setQuery(next);
      setHighlighted(0);
    },
  };
}
