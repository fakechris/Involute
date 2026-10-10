import type { BugReproducibility } from '@prisma/client';

import { createValidationError } from './errors.js';

/**
 * How often a bug shows up when someone tries (INV-1122): ALWAYS, SOMETIMES or
 * ONCE. For a bug that does not always reproduce, a merged PR with green CI
 * does not prove the fix, so the bug gate (INV-1075) leaves it for a person.
 */
export const REPRODUCIBILITIES = ['ALWAYS', 'SOMETIMES', 'ONCE'] as const satisfies readonly BugReproducibility[];

export const REPRODUCIBILITY_NAMES: Record<BugReproducibility, string> = {
  ALWAYS: 'Always',
  SOMETIMES: 'Sometimes',
  ONCE: 'Once',
};

export const REPRODUCIBILITY_INVALID_MESSAGE =
  'Reproducibility must be ALWAYS (every try), SOMETIMES (some tries) or ONCE (seen once, not reproduced since); null clears it.';

export function isReproducibility(value: unknown): value is BugReproducibility {
  return typeof value === 'string' && (REPRODUCIBILITIES as readonly string[]).includes(value);
}

/** A bug that does not always reproduce: green CI cannot show it is gone. */
export function isIntermittent(value: BugReproducibility | null | undefined): value is 'SOMETIMES' | 'ONCE' {
  return value === 'SOMETIMES' || value === 'ONCE';
}

/**
 * Reads reproducibility from a wire value: undefined keeps the field, null
 * clears it, ALWAYS / SOMETIMES / ONCE (any casing) sets it. Anything else is
 * refused with the reason.
 */
export function parseReproducibility(value: unknown): BugReproducibility | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const upper = typeof value === 'string' ? value.trim().toUpperCase() : value;
  if (!isReproducibility(upper)) throw createValidationError(REPRODUCIBILITY_INVALID_MESSAGE);
  return upper;
}
