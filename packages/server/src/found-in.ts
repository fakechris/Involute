import { createValidationError, exposeErrorMessages } from './errors.js';

/**
 * The deploy a bug was found in (INV-1121). Involute deploys by SHA
 * (INVOLUTE_IMAGE_TAG=sha-…) and has no version numbers (decision INV-1130),
 * so "found in" is a build SHA: 7–40 hex characters, stored lowercase. The fix
 * SHA is never stored; it is derived from merge evidence GitHub reported.
 */
export const FOUND_IN_SHA_PATTERN = /^[0-9a-f]{7,40}$/;

export const FOUND_IN_SHA_INVALID_MESSAGE =
  'Found-in must be a deploy commit SHA: 7 to 40 hexadecimal characters (e.g. the sha-… image tag without "sha-"); null clears it.';

exposeErrorMessages([FOUND_IN_SHA_INVALID_MESSAGE]);

/**
 * Reads a found-in SHA from a wire value: undefined keeps the field, null or
 * an empty string clears it, a 7–40 hex SHA (any casing, an optional "sha-"
 * prefix as in the image tag) sets it. Anything else is refused with the reason.
 */
export function parseFoundInSha(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') throw createValidationError(FOUND_IN_SHA_INVALID_MESSAGE);
  const trimmed = value.trim().toLowerCase().replace(/^sha-/, '');
  if (!trimmed) return null;
  if (!FOUND_IN_SHA_PATTERN.test(trimmed)) throw createValidationError(FOUND_IN_SHA_INVALID_MESSAGE);
  return trimmed;
}
