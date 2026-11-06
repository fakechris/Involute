import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Secrets Involute keeps in its own database (INV-1677: GitHub App keys,
 * webhook secrets, team tokens) are sealed with AES-256-GCM under one key,
 * INVOLUTE_SECRET_KEY — the only secret the server's environment carries for
 * them. Losing the key loses the sealed values (reconnect), never other data.
 */

export const SECRET_KEY_MISSING_MESSAGE =
  'INVOLUTE_SECRET_KEY is not set, so Involute cannot store this secret. An operator sets it once in the server environment (any long random string); see docs/github-connection.md.';
export const SECRET_UNREADABLE_MESSAGE =
  'A stored secret could not be decrypted: INVOLUTE_SECRET_KEY changed or the value is damaged. Reconnect to store it again.';

const VERSION = 'v1';

function keyFrom(raw: string | undefined): Buffer {
  const value = raw?.trim();
  if (!value) throw new Error(SECRET_KEY_MISSING_MESSAGE);
  // Any string works: hashing gives the 32 bytes AES-256 needs.
  return createHash('sha256').update(value).digest();
}

export function hasSecretKey(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.INVOLUTE_SECRET_KEY?.trim());
}

export function sealSecret(plain: string, env: NodeJS.ProcessEnv = process.env): string {
  const key = keyFrom(env.INVOLUTE_SECRET_KEY);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join(':');
}

export function openSecret(sealed: string, env: NodeJS.ProcessEnv = process.env): string {
  const key = keyFrom(env.INVOLUTE_SECRET_KEY);
  const [version, iv, tag, body] = sealed.split(':');
  if (version !== VERSION || !iv || !tag || body === undefined) throw new Error(SECRET_UNREADABLE_MESSAGE);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    throw new Error(SECRET_UNREADABLE_MESSAGE);
  }
}
