import { useApolloClient } from '@apollo/client/react';
import { useEffect, useMemo, useState } from 'react';

import { readLocalStorageValue } from '../lib/storage';
import { BOARD_COLUMN_ISSUES_QUERY } from './queries';
import type { BoardPageQueryVariables, IssueSummary } from './types';

/**
 * A column's own Load more (INV-1539).
 *
 * The board loads its 200 most recently changed items across every state. A
 * column that holds older work used to load "more" by asking for the board's
 * next 200, which might hold none of its items — the person clicked again and
 * again for each card. Now a column asks for its own state under the board's
 * filters, all that remain at once (up to the server's page of 200).
 *
 * How far each column is opened is remembered (by state id, which is unique
 * across teams), so a refetch, a return to the page or a reload shows the same
 * cards instead of falling back to the first page.
 */

/** The most items the server returns in one page. */
export const COLUMN_PAGE_SIZE = 200;

const STORAGE_KEY = 'involute:column-loads';

/** stateId → how many of that state's items the column shows (most recent first). */
export type ColumnLoads = Record<string, number>;

export function readColumnLoads(): ColumnLoads {
  try {
    const parsed = JSON.parse(readLocalStorageValue(STORAGE_KEY) ?? '{}') as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, number] => typeof entry[1] === 'number' && entry[1] > 0,
      ),
    );
  } catch {
    return {};
  }
}

export function writeColumnLoads(loads: ColumnLoads): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(loads));
  } catch {
    // Storage full or blocked: the column still opens for this visit.
  }
}

/**
 * How many items the column should show after one Load more: what it shows
 * now plus everything not loaded, at most one server page more.
 */
export function nextColumnLoad(shown: number, unloaded: number): number {
  return shown + Math.min(unloaded, COLUMN_PAGE_SIZE);
}

/** The board's query narrowed to one state, `first` items from `after`. */
export function columnVariables(
  board: BoardPageQueryVariables,
  stateId: string,
  first: number,
  after?: string | null,
): BoardPageQueryVariables {
  return {
    ...board,
    first,
    ...(after ? { after } : {}),
    filter: { ...board.filter, stateIds: [stateId] },
  };
}

interface ColumnIssuesData {
  issues: { nodes: IssueSummary[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
}

/**
 * The items of every opened column. Asked again whenever the board's own
 * result changes (a save, a refetch, a return to the page), so the opened
 * columns follow the same data instead of keeping what they first saw.
 */
export function useColumnIssues(
  loads: ColumnLoads,
  board: BoardPageQueryVariables,
  refreshKey: unknown,
  enabled: boolean,
): { issues: IssueSummary[]; loading: ReadonlySet<string> } {
  const client = useApolloClient();
  const [byState, setByState] = useState<Record<string, IssueSummary[]>>({});
  const [loading, setLoading] = useState<ReadonlySet<string>>(new Set());
  const loadsKey = JSON.stringify(loads);
  const boardKey = JSON.stringify(board);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const entries = Object.entries(JSON.parse(loadsKey) as ColumnLoads);
    const boardVariables = JSON.parse(boardKey) as BoardPageQueryVariables;
    if (entries.length > 0) setLoading(new Set(entries.map(([stateId]) => stateId)));

    async function loadColumn(stateId: string, wanted: number): Promise<IssueSummary[]> {
      const nodes: IssueSummary[] = [];
      let after: string | null = null;
      while (nodes.length < wanted) {
        const result: { data?: ColumnIssuesData | undefined } = await client.query<ColumnIssuesData, BoardPageQueryVariables>({
          query: BOARD_COLUMN_ISSUES_QUERY,
          variables: columnVariables(boardVariables, stateId, Math.min(COLUMN_PAGE_SIZE, wanted - nodes.length), after),
          fetchPolicy: 'network-only',
        });
        const page = result.data?.issues;
        if (!page) break;
        nodes.push(...page.nodes);
        if (!page.pageInfo.hasNextPage || !page.pageInfo.endCursor) break;
        after = page.pageInfo.endCursor;
      }
      return nodes;
    }

    for (const [stateId, wanted] of entries) {
      loadColumn(stateId, wanted)
        .then((nodes) => {
          if (cancelled) return;
          setByState((current) => ({ ...current, [stateId]: nodes }));
        })
        .catch(() => undefined)
        .finally(() => {
          if (cancelled) return;
          setLoading((current) => {
            const next = new Set(current);
            next.delete(stateId);
            return next;
          });
        });
    }
    // A column closed (team changed, storage cleared) drops its items.
    setByState((current) => {
      const kept = Object.entries(current).filter(([stateId]) => entries.some(([id]) => id === stateId));
      return kept.length === Object.keys(current).length ? current : Object.fromEntries(kept);
    });
    return () => {
      cancelled = true;
    };
  }, [client, loadsKey, boardKey, refreshKey, enabled]);

  const issues = useMemo(() => Object.values(byState).flat(), [byState]);
  return { issues, loading };
}

/** The board's items followed by the opened columns' items it does not hold yet. */
export function withColumnIssues(boardIssues: IssueSummary[], columnIssues: IssueSummary[]): IssueSummary[] {
  if (columnIssues.length === 0) return boardIssues;
  const seen = new Set(boardIssues.map((issue) => issue.id));
  const extra = columnIssues.filter((issue) => {
    if (seen.has(issue.id)) return false;
    seen.add(issue.id);
    return true;
  });
  return extra.length ? [...boardIssues, ...extra] : boardIssues;
}
