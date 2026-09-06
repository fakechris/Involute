import { parseIql, type IqlQuery, type IqlTerm } from '@turnkeyai/involute-shared/iql';

import type { IssueSummary } from './types';

const STATE_TYPE_VALUES = ['BACKLOG', 'UNSTARTED', 'STARTED', 'REVIEW', 'COMPLETED', 'CANCELED'];

/**
 * True when the saved-view query uses IQL field syntax (any `field:value`
 * token). Plain text keeps the legacy substring behaviour.
 */
export function looksLikeIql(query: string): boolean {
  try {
    const parsed = parseIql(query);
    return parsed.terms.some((term) => term.field !== null);
  } catch {
    return false;
  }
}

/**
 * Client-side IQL evaluation for saved board/backlog views. Supports the
 * fields the web already has in hand (state, kind, commitment, assignee,
 * label, priority, updated, team, free text). `link:` and `has:` terms need
 * graph joins the client does not load, so they match nothing here; use the
 * API (`issues(query:)`) for full-fidelity filtering.
 */
export function matchesIql(
  query: string,
  issue: IssueSummary,
  viewerId: string | null,
): boolean {
  let parsed: IqlQuery;
  try {
    parsed = parseIql(query);
  } catch {
    return true;
  }

  return parsed.terms.every((term) => matchTerm(term, issue, viewerId));
}

function matchTerm(term: IqlTerm, issue: IssueSummary, viewerId: string | null): boolean {
  const matched = matchPositive(term, issue, viewerId);
  return term.negated ? !matched : matched;
}

function matchPositive(term: IqlTerm, issue: IssueSummary, viewerId: string | null): boolean {
  const values = term.value.split(',').map((value) => value.trim()).filter(Boolean);

  if (term.field === null) {
    const needle = term.value.toLowerCase();
    return [issue.identifier, issue.title, issue.description ?? '']
      .join(' ')
      .toLowerCase()
      .includes(needle);
  }

  switch (term.field) {
    case 'team':
      return values.some((value) => value.toLowerCase() === issue.team.key.toLowerCase());
    case 'state':
      return values.some((value) => value.toLowerCase() === issue.state.name.toLowerCase());
    case 'state-type': {
      const upper = values.map((value) => value.toUpperCase());
      if (!upper.every((value) => STATE_TYPE_VALUES.includes(value))) {
        return false;
      }
      return upper.includes(issue.state.type);
    }
    case 'kind':
      return values.some((value) => value.toUpperCase() === (issue.kind ?? 'ISSUE').toUpperCase());
    case 'commitment':
      return values.some((value) => value.toUpperCase() === (issue.commitmentStatus ?? 'COMMITTED').toUpperCase());
    case 'assignee': {
      const value = values[0]?.toLowerCase() ?? '';
      if (value === 'me') {
        return Boolean(viewerId) && issue.assignee?.id === viewerId;
      }
      if (value === 'none') {
        return issue.assignee === null;
      }
      return issue.assignee?.id === values[0];
    }
    case 'label':
      return values.some((value) =>
        issue.labels.nodes.some((label) => label.name.toLowerCase() === value.toLowerCase()),
      );
    case 'priority': {
      const numeric = Number(values[0]);
      if (!Number.isFinite(numeric)) {
        return false;
      }
      switch (term.op) {
        case 'eq': return issue.priority === numeric;
        case 'neq': return issue.priority !== numeric;
        case 'gt': return issue.priority > numeric;
        case 'gte': return issue.priority >= numeric;
        case 'lt': return issue.priority < numeric;
        case 'lte': return issue.priority <= numeric;
      }
      return false;
    }
    case 'updated': {
      const ms = parseDurationMs(values[0] ?? '');
      if (ms === null) {
        return false;
      }
      const cutoff = Date.now() - ms;
      const updated = new Date(issue.updatedAt).getTime();
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
    case 'link':
    case 'has':
      // Graph-joined data is not loaded client-side.
      return false;
    default:
      return false;
  }
}

function parseDurationMs(value: string): number | null {
  const match = /^(\d+)\s*(s|m|h|d|w)$/i.exec(value.trim());
  if (!match) {
    return null;
  }
  const amount = Number(match[1]);
  const unit = match[2]!.toLowerCase();
  const multipliers: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
  return amount * multipliers[unit]!;
}
