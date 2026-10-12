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
  if (typeof window === 'undefined') return;
  if (next) adoptLegacySavedViews(next);
  window.dispatchEvent(new CustomEvent<string | null>(SAVED_VIEWS_ACCOUNT_EVENT, { detail: next }));
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
