import type { IssueSeverity } from '@prisma/client';

import { createValidationError } from './errors.js';

/**
 * Severity says how bad the effect is; priority says what goes first and sets
 * a bug's SLA (INV-1115). The two are independent: nothing here touches the
 * SLA. Definitions: docs/severity.md.
 */
export const SEVERITIES = ['SEV1', 'SEV2', 'SEV3'] as const satisfies readonly IssueSeverity[];

export const SEVERITY_NAMES: Record<IssueSeverity, string> = {
  SEV1: 'Critical',
  SEV2: 'Major',
  SEV3: 'Minor',
};

export const SEVERITY_INVALID_MESSAGE =
  'Severity must be SEV1 (Critical), SEV2 (Major) or SEV3 (Minor); null clears it. Unsure? Pick the higher one (docs/severity.md).';

export function isSeverity(value: unknown): value is IssueSeverity {
  return typeof value === 'string' && (SEVERITIES as readonly string[]).includes(value);
}

/**
 * Reads a severity from a wire value: undefined keeps the field, null clears
 * it, SEV1–SEV3 (any casing) sets it. Anything else is refused with the reason.
 */
export function parseSeverity(value: unknown): IssueSeverity | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const upper = typeof value === 'string' ? value.trim().toUpperCase() : value;
  if (!isSeverity(upper)) throw createValidationError(SEVERITY_INVALID_MESSAGE);
  return upper;
}
