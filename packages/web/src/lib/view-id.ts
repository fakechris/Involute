/**
 * A saved view's id, always a UUID (INV-2157). The server keeps a client-made
 * id only when it is a UUID, so an upload retried after the server already
 * stored the view updates that row instead of adding a second one. Without
 * crypto.randomUUID (a page served over plain http), build one from
 * crypto.getRandomValues, which every browser has.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isViewUuid(id: unknown): id is string {
  return typeof id === 'string' && UUID_PATTERN.test(id);
}

export function newViewId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
