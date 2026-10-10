import { DEFAULT_SERVER, isLive, normalizeOrigin } from './connect';
import type { Connection } from './types';

/** What the extension keeps in chrome.storage.local (INV-1147). */
export interface Settings {
  server: string;
  connection: Connection | null;
  /** Origins (scheme://host[:port]) whose pages run the context recorder. */
  managedOrigins: string[];
}

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(['server', 'connection', 'managedOrigins']);
  const server = normalizeOrigin(typeof stored.server === 'string' ? stored.server : null) ?? DEFAULT_SERVER;
  const connection = stored.connection as Connection | undefined;
  const managedOrigins = Array.isArray(stored.managedOrigins)
    ? (stored.managedOrigins as unknown[]).map((value) => normalizeOrigin(String(value))).filter((value): value is string => Boolean(value))
    : [];
  return {
    server,
    // A connection for another server, or an expired one, is no connection.
    connection: isLive(connection) && connection.server === server ? connection : null,
    managedOrigins: [...new Set(managedOrigins)],
  };
}

export async function saveSettings(patch: Partial<Settings>): Promise<void> {
  await chrome.storage.local.set(patch);
}

/** Public view of the connection: the token never leaves the background. */
export interface ConnectionStatus {
  server: string;
  connected: boolean;
  person: Connection['person'] | null;
  expiresAt: string | null;
  managedOrigins: string[];
}

export function connectionStatus(settings: Settings): ConnectionStatus {
  return {
    server: settings.server,
    connected: Boolean(settings.connection),
    person: settings.connection?.person ?? null,
    expiresAt: settings.connection?.expiresAt ?? null,
    managedOrigins: settings.managedOrigins,
  };
}
