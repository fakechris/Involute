import type { Connection } from './types';

/**
 * Accepting the token from /extension/connect (INV-1147). The page sends it
 * with chrome.runtime.sendMessage; Chrome fills sender.origin from the tab
 * itself, so a page on any other origin — even one externally_connectable
 * matches, like another localhost port — cannot plant a token or read one.
 */
export const DEFAULT_SERVER = 'https://involute.lumenopen.com';

/** scheme://host[:port] of an http(s) URL, or null. */
export function normalizeOrigin(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

export type ConnectDecision = { accept: true; connection: Connection } | { accept: false; reason: string };

export function decideConnect(message: unknown, senderOrigin: string | undefined, configuredServer: string): ConnectDecision {
  const server = normalizeOrigin(configuredServer);
  if (!server) return { accept: false, reason: 'No server is configured.' };
  if (!senderOrigin || normalizeOrigin(senderOrigin) !== server) return { accept: false, reason: 'The message did not come from the configured server.' };
  if (!message || typeof message !== 'object') return { accept: false, reason: 'Not a message.' };
  const raw = message as Record<string, unknown>;
  if (raw.type !== 'involute.connect') return { accept: false, reason: 'Unknown message.' };
  if (typeof raw.token !== 'string' || !raw.token.startsWith('inv_ext_')) return { accept: false, reason: 'Not an extension token.' };
  if (normalizeOrigin(typeof raw.server === 'string' ? raw.server : null) !== server) return { accept: false, reason: 'The token is for another server.' };
  const person = raw.person as Record<string, unknown> | null | undefined;
  if (!person || typeof person !== 'object' || typeof person.id !== 'string') return { accept: false, reason: 'No person.' };
  if (typeof raw.expiresAt !== 'string' || Number.isNaN(Date.parse(raw.expiresAt))) return { accept: false, reason: 'No expiry.' };
  return {
    accept: true,
    connection: {
      token: raw.token,
      server,
      person: {
        id: person.id,
        name: typeof person.name === 'string' ? person.name : null,
        email: typeof person.email === 'string' ? person.email : null,
      },
      expiresAt: raw.expiresAt,
    },
  };
}

/** A connection that has expired is treated as absent. */
export function isLive(connection: Connection | null | undefined, now = Date.now()): connection is Connection {
  return Boolean(connection && Date.parse(connection.expiresAt) > now);
}

/**
 * Match pattern for exactly one origin, port included (`http://127.0.0.1:4301/*`):
 * a pattern without a port would match every port on that host.
 */
export function originPattern(origin: string): string {
  const url = new URL(origin);
  return `${url.protocol}//${url.host}/*`;
}

/** Content-script match pattern for an origin (registerContentScripts). */
export function recorderPatterns(origins: readonly string[]): string[] {
  return [...new Set(origins.map((origin) => originPattern(origin)))];
}
