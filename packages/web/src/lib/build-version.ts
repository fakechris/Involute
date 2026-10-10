/**
 * The build's source version for `<meta name="involute-version">` (INV-1146),
 * so a bug captured from a page says which build it happened on. Docker builds
 * pass INVOLUTE_BUILD_SHA (the Dockerfile's build argument, also reported by
 * the server's protocol info); anything else is "dev".
 */
export const INVOLUTE_VERSION_PLACEHOLDER = '__INVOLUTE_VERSION__';

export function involuteVersion(sha: string | undefined): string {
  const value = (sha ?? '').trim().toLowerCase();
  return /^[0-9a-f]{7,40}$/.test(value) ? value : 'dev';
}

export function withInvoluteVersion(html: string, sha: string | undefined): string {
  return html.replace(INVOLUTE_VERSION_PLACEHOLDER, involuteVersion(sha));
}
