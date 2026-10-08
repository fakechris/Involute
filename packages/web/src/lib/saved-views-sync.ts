import type { ApolloClient } from '@apollo/client';

import {
  BACKLOG_SAVED_VIEWS_EVENT,
  readSavedBacklogViews,
  writeSavedBacklogViews,
  type SavedBacklogView,
  type SavedBacklogViewsEventDetail,
} from '../backlog/views';
import {
  BOARD_SAVED_VIEWS_EVENT,
  readSavedBoardViews,
  writeSavedBoardViews,
  type SavedBoardView,
  type SavedBoardViewsEventDetail,
} from '../board/views';
import { SAVED_VIEW_DELETE_MUTATION, SAVED_VIEW_UPSERT_MUTATION, SAVED_VIEWS_QUERY } from '../work/queries';

/**
 * Keeps the browser's saved views and the server's in step (INV-1005). The
 * pages keep writing localStorage as before; this layer, started once per
 * team by the app shell, (1) pulls the server's views and migrates local
 * ones the server has not seen, then (2) mirrors every later local change
 * (save, rename, delete) to the server. The server is the source of truth:
 * what it returns replaces the local list, so a view saved on another device
 * shows up here.
 */
type ServerView = { id: string; ownerId: string; name: string; kind: string; visibility: 'PRIVATE' | 'TEAM'; stateJson: string };
type AnyView = SavedBoardView | SavedBacklogView;

export const SAVED_VIEWS_MIGRATED_KEY = (teamKey: string) => `involute.views.migrated.${teamKey}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fromServer(view: ServerView): AnyView {
  let state: unknown = {};
  try { state = JSON.parse(view.stateJson); } catch { /* an unreadable state falls back to defaults in the normalizers */ }
  return { id: view.id, name: view.name, state: state as never, visibility: view.visibility, ownerId: view.ownerId };
}

export function startSavedViewsSync(client: ApolloClient, teamKey: string): () => void {
  let applying = false;
  let known = new Map<string, AnyView>();

  const write = (kind: 'board' | 'backlog', views: AnyView[]) => {
    applying = true;
    try {
      if (kind === 'board') writeSavedBoardViews(teamKey, views as SavedBoardView[]);
      else writeSavedBacklogViews(teamKey, views as SavedBacklogView[]);
    } finally {
      applying = false;
    }
  };

  const upsert = async (kind: 'board' | 'backlog', view: AnyView) => {
    const result = await client.mutate<{ savedViewUpsert: { success: boolean; view: ServerView | null } }>({
      mutation: SAVED_VIEW_UPSERT_MUTATION,
      variables: { input: { ...(UUID.test(view.id) ? { id: view.id } : {}), teamKey, name: view.name, kind, visibility: view.visibility ?? 'PRIVATE', stateJson: JSON.stringify(view.state) } },
    });
    return result.data?.savedViewUpsert.success ? result.data.savedViewUpsert.view : null;
  };

  const pull = async () => {
    const result = await client.query<{ savedViews: ServerView[] }>({ query: SAVED_VIEWS_QUERY, variables: { teamKey }, fetchPolicy: 'network-only' });
    const server = result.data?.savedViews ?? [];
    // One-time migration: local views the server does not have become private server views.
    if (!window.localStorage.getItem(SAVED_VIEWS_MIGRATED_KEY(teamKey))) {
      const have = new Set(server.map((view) => view.id));
      for (const kind of ['board', 'backlog'] as const) {
        const local = kind === 'board' ? readSavedBoardViews(teamKey) : readSavedBacklogViews(teamKey);
        for (const view of local) {
          if (have.has(view.id)) continue;
          const saved = await upsert(kind, view);
          if (saved) server.push(saved);
        }
      }
      window.localStorage.setItem(SAVED_VIEWS_MIGRATED_KEY(teamKey), new Date().toISOString());
    }
    known = new Map(server.map((view) => [view.id, fromServer(view)]));
    write('board', server.filter((view) => view.kind === 'board').map(fromServer));
    write('backlog', server.filter((view) => view.kind === 'backlog').map(fromServer));
  };

  // A local change (the pages write localStorage and fire these events) is mirrored to the server.
  const mirror = (kind: 'board' | 'backlog') => async (event: Event) => {
    if (applying) return;
    const detail = (event as CustomEvent<SavedBoardViewsEventDetail | SavedBacklogViewsEventDetail>).detail;
    if (!detail || detail.teamKey !== teamKey) return;
    const current = detail.views as AnyView[];
    const currentIds = new Set(current.map((view) => view.id));
    const replacements = new Map<string, AnyView>();
    for (const view of current) {
      const before = known.get(view.id);
      if (before && before.name === view.name && (before.visibility ?? 'PRIVATE') === (view.visibility ?? 'PRIVATE') && JSON.stringify(before.state) === JSON.stringify(view.state)) continue;
      const saved = await upsert(kind, view);
      if (saved) {
        known.set(saved.id, fromServer(saved));
        if (saved.id !== view.id) replacements.set(view.id, fromServer(saved));
      }
    }
    for (const [id, before] of known) {
      const sameKind = kind === 'board' ? 'groupBy' in (before.state as object) : !('groupBy' in (before.state as object));
      if (!currentIds.has(id) && sameKind && !replacements.has(id)) {
        await client.mutate({ mutation: SAVED_VIEW_DELETE_MUTATION, variables: { id } });
        known.delete(id);
      }
    }
    // Ids the server assigned replace browser-made ones so later edits update instead of duplicating.
    if (replacements.size > 0) write(kind, current.map((view) => replacements.get(view.id) ?? view));
  };

  const onBoard = mirror('board');
  const onBacklog = mirror('backlog');
  window.addEventListener(BOARD_SAVED_VIEWS_EVENT, onBoard);
  window.addEventListener(BACKLOG_SAVED_VIEWS_EVENT, onBacklog);
  void pull().catch((error: unknown) => { console.error('[saved-views] could not load views from the server; using this browser\'s copy.', error); });
  return () => {
    window.removeEventListener(BOARD_SAVED_VIEWS_EVENT, onBoard);
    window.removeEventListener(BACKLOG_SAVED_VIEWS_EVENT, onBacklog);
  };
}
