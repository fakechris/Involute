import { isViewUuid, newViewId } from './view-id';

/**
 * Whose saved views this browser shows (INV-1194). The board and backlog keep
 * a copy of the signed-in person's views in localStorage; keyed by team alone,
 * the next person to sign in on the same browser saw the last one's private
 * views. The copy is now keyed by account as well, and the account is only
 * known once the server has said who is signed in: until then (and when signed
 * out) nothing is read or stored.
 *
 * Copies written before this change (`involute.board.savedViews.<team>`) say
 * nothing about whose they are, and since the server sync never ran they are
 * everyone's only copy. The first account to sign in on this browser takes all
 * of them into its own copy and the old key is removed, so no later account
 * sees them. On a browser shared before this change that first account may
 * receive views someone else saved — a one-time caveat chosen over losing them.
 */
let account: string | null = null;

/**
 * Views saved before the account is known (token sign-in asks the server who
 * is signed in after the page has loaded, INV-2157). They are kept in memory,
 * added to the account's copy once it is known, and handed to the server sync
 * as unsaved views so they are not lost when the account's copy is reloaded.
 */
type PendingView = { id?: unknown };

/**
 * Early views not yet on the server, per account, team and kind (INV-2157). The
 * sync reads and clears it; it is written when the account becomes known, before
 * any request, so a reload in between does not lose the upload.
 */
export const SAVED_VIEWS_RETRY_KEY = (accountId: string, teamKey: string, kind: 'board' | 'backlog') => `involute.views.retry.${accountId}.${teamKey}.${kind}`;
const pending = new Map<string, PendingView[]>();
const unsynced = new Map<string, PendingView[]>();
const pendingKey = (kind: 'board' | 'backlog', teamKey: string) => `${kind}.${teamKey}`;

export function readPendingSavedViews(kind: 'board' | 'backlog', teamKey: string): unknown[] {
  return pending.get(pendingKey(kind, teamKey)) ?? [];
}

export function writePendingSavedViews(kind: 'board' | 'backlog', teamKey: string, views: PendingView[]): void {
  pending.set(pendingKey(kind, teamKey), views);
}

/** The views saved before this account was known, for the server sync to upload once. */
export function takeUnsyncedSavedViews(kind: 'board' | 'backlog', teamKey: string, accountId: string): unknown[] {
  const key = `${accountId}.${pendingKey(kind, teamKey)}`;
  const views = unsynced.get(key) ?? [];
  unsynced.delete(key);
  return views;
}

export const SAVED_VIEWS_ACCOUNT_EVENT = 'involute:saved-views-account';

const LEGACY_SAVED_VIEWS_KEY = /^involute\.(board|backlog)\.savedViews\.([^.]+)$/;
const LEGACY_MIGRATED_KEY = /^involute\.views\.migrated\.[^.]+$/;

export function getSavedViewsAccount(): string | null {
  return account;
}

/** The localStorage key for this account's copy, or null when nobody is signed in. */
export function savedViewsStorageKey(kind: 'board' | 'backlog', teamKey: string): string | null {
  return account ? `involute.${kind}.savedViews.${account}.${teamKey}` : null;
}

export function setSavedViewsAccount(next: string | null): void {
  if (next === account) return;
  account = next;
  unsynced.clear();
  if (typeof window === 'undefined') return;
  if (next) {
    adoptLegacySavedViews(next);
    adoptPendingSavedViews(next);
  }
  pending.clear();
  window.dispatchEvent(new CustomEvent<string | null>(SAVED_VIEWS_ACCOUNT_EVENT, { detail: next }));
}

function adoptPendingSavedViews(accountId: string): void {
  for (const [key, saved] of pending) {
    if (saved.length === 0) continue;
    // A fixed UUID per view (INV-2157): a retried upload then updates the row the
    // server already has instead of adding a duplicate.
    const views = saved.map((view) => (isViewUuid(view?.id) ? view : { ...view, id: newViewId() }));
    unsynced.set(`${accountId}.${key}`, views);
    const [kind, teamKey] = key.split('.') as ['board' | 'backlog', string];
    const target = `involute.${key.replace('.', '.savedViews.' + accountId + '.')}`;
    try {
      // Persist the upload before any request, so a reload before the first sync keeps it.
      const retryKey = SAVED_VIEWS_RETRY_KEY(accountId, teamKey, kind);
      let queued: unknown = [];
      try { queued = JSON.parse(window.localStorage.getItem(retryKey) ?? '[]'); } catch { queued = []; }
      const earlier = Array.isArray(queued) ? (queued as PendingView[]) : [];
      const viewIds = new Set(views.map((view) => view.id));
      window.localStorage.setItem(retryKey, JSON.stringify([...earlier.filter((view) => !viewIds.has(view?.id)), ...views]));
      let existing: unknown = [];
      try { existing = JSON.parse(window.localStorage.getItem(target) ?? '[]'); } catch { existing = []; }
      const current = Array.isArray(existing) ? (existing as PendingView[]) : [];
      const ids = new Set(views.map((view) => view.id));
      window.localStorage.setItem(target, JSON.stringify([...views, ...current.filter((view) => !ids.has(view?.id))]));
    } catch {
      // Ignore storage failures in restricted browser contexts.
    }
  }
}

function adoptLegacySavedViews(accountId: string): void {
  try {
    const keys = Array.from({ length: window.localStorage.length }, (_, index) => window.localStorage.key(index)).filter((key): key is string => key !== null);
    for (const key of keys) {
      if (LEGACY_MIGRATED_KEY.test(key)) { window.localStorage.removeItem(key); continue; }
      const match = LEGACY_SAVED_VIEWS_KEY.exec(key);
      if (!match) continue;
      let entries: unknown = [];
      try { entries = JSON.parse(window.localStorage.getItem(key) ?? '[]'); } catch { entries = []; }
      const legacy = Array.isArray(entries) ? entries : [];
      const target = `involute.${match[1]}.savedViews.${accountId}.${match[2]}`;
      if (legacy.length > 0) {
        let existing: unknown = [];
        try { existing = JSON.parse(window.localStorage.getItem(target) ?? '[]'); } catch { existing = []; }
        const current = Array.isArray(existing) ? existing : [];
        const ids = new Set(current.map((entry: { id?: unknown } | null) => entry?.id));
        window.localStorage.setItem(target, JSON.stringify([...current, ...legacy.filter((entry: { id?: unknown } | null) => !ids.has(entry?.id))]));
      }
      window.localStorage.removeItem(key);
    }
  } catch {
    // Ignore storage failures in restricted browser contexts.
  }
}
