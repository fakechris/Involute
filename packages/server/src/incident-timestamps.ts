import type { CommitmentStatus, WorkResolution } from '@prisma/client';

import {
  createValidationError,
  INCIDENT_DETECTED_AFTER_RESOLVED_MESSAGE,
  INCIDENT_IMPACT_AFTER_DETECTED_MESSAGE,
  INCIDENT_IMPACT_AFTER_MITIGATED_MESSAGE,
  INCIDENT_IMPACT_AFTER_RESOLVED_MESSAGE,
  INCIDENT_MITIGATED_AFTER_RESOLVED_MESSAGE,
  INCIDENT_TIME_INVALID_MESSAGE,
  INCIDENT_TIME_REQUIRED_MESSAGE,
} from './errors.js';

/**
 * Incident impact timestamps (INV-1125). They map onto the existing states
 * instead of adding workflow states: investigating = STARTED; fixed = resolvedAt
 * set and In Review (postmortem); Done stays human. Only Type: Incident carries
 * them. Order: impact started ≤ detected ≤ resolved and impact started ≤
 * mitigated ≤ resolved. Detection may come after mitigation (automatic
 * failover), so the two are not ordered against each other.
 */
export const INCIDENT_TIME_FIELDS = ['impactStartedAt', 'detectedAt', 'mitigatedAt', 'resolvedAt'] as const;

export type IncidentTimeField = (typeof INCIDENT_TIME_FIELDS)[number];
export type IncidentTimes = Record<IncidentTimeField, Date | null>;

export const INCIDENT_TIME_LABELS: Record<IncidentTimeField, string> = {
  impactStartedAt: 'impact started',
  detectedAt: 'detected',
  mitigatedAt: 'mitigated',
  resolvedAt: 'resolved',
};

/** MCP argument name for each field. */
export const INCIDENT_TIME_ARGS: Record<IncidentTimeField, string> = {
  impactStartedAt: 'impact_started_at',
  detectedAt: 'detected_at',
  mitigatedAt: 'mitigated_at',
  resolvedAt: 'resolved_at',
};

/**
 * Reads one timestamp from a wire value: undefined keeps the field, null clears
 * it, a Date or ISO string sets it. Anything else is refused with the reason.
 */
export function parseIncidentTime(value: unknown): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const date = value instanceof Date ? value : typeof value === 'string' && value.trim() ? new Date(value.trim()) : null;
  if (!date || Number.isNaN(date.getTime())) throw createValidationError(INCIDENT_TIME_INVALID_MESSAGE);
  return date;
}

/** The timestamps a write mentions, parsed; fields it leaves out are absent. */
export function readIncidentTimes(input: Partial<Record<IncidentTimeField, unknown>>): Partial<IncidentTimes> {
  const times: Partial<IncidentTimes> = {};
  for (const field of INCIDENT_TIME_FIELDS) {
    const value = parseIncidentTime(input[field]);
    if (value !== undefined) times[field] = value;
  }
  return times;
}

const ORDER_RULES: Array<[IncidentTimeField, IncidentTimeField, string]> = [
  ['impactStartedAt', 'detectedAt', INCIDENT_IMPACT_AFTER_DETECTED_MESSAGE],
  ['impactStartedAt', 'mitigatedAt', INCIDENT_IMPACT_AFTER_MITIGATED_MESSAGE],
  ['impactStartedAt', 'resolvedAt', INCIDENT_IMPACT_AFTER_RESOLVED_MESSAGE],
  ['detectedAt', 'resolvedAt', INCIDENT_DETECTED_AFTER_RESOLVED_MESSAGE],
  ['mitigatedAt', 'resolvedAt', INCIDENT_MITIGATED_AFTER_RESOLVED_MESSAGE],
];

/** Why these timestamps are out of order, or null when they are fine. */
export function incidentTimeOrderProblem(times: IncidentTimes): string | null {
  for (const [earlier, later, message] of ORDER_RULES) {
    const first = times[earlier];
    const second = times[later];
    if (first && second && first.getTime() > second.getTime()) return message;
  }
  return null;
}

/**
 * Merges a write into the stored timestamps and refuses what cannot stand:
 * clearing impact started / detected, or an order violation. Returns the
 * fields to write.
 */
export function mergeIncidentTimes(current: IncidentTimes, input: Partial<IncidentTimes>): { next: IncidentTimes; changed: Partial<IncidentTimes> } {
  const next = { ...current };
  const changed: Partial<IncidentTimes> = {};
  for (const field of INCIDENT_TIME_FIELDS) {
    if (!(field in input)) continue;
    const value = input[field] ?? null;
    if (value === null && (field === 'impactStartedAt' || field === 'detectedAt')) {
      throw createValidationError(INCIDENT_TIME_REQUIRED_MESSAGE);
    }
    next[field] = value;
    changed[field] = value;
  }
  const problem = incidentTimeOrderProblem(next);
  if (problem) throw createValidationError(problem);
  return { next, changed };
}

export interface IncidentDurations {
  /** When impact began: impactStartedAt, else detectedAt, else when it was declared. */
  impactStartedAt: Date;
  /** Impact start → detection. */
  timeToDetectMs: number | null;
  /** Impact start → mitigation; a missing mitigatedAt counts as resolvedAt. */
  timeToMitigateMs: number | null;
  /** Impact start → resolution (the MTTR term). */
  timeToResolveMs: number | null;
  /** Impact so far: to resolvedAt, or to `now` while unresolved. */
  impactMs: number;
  ongoing: boolean;
}

/**
 * Durations for one incident, the basis of MTTR / MTTM (INV-1129). Pure:
 * pass the row's timestamps and createdAt.
 */
export function incidentDurations(
  work: Partial<IncidentTimes> & { createdAt: Date },
  now: Date = new Date(),
): IncidentDurations {
  const start = work.impactStartedAt ?? work.detectedAt ?? work.createdAt;
  const since = (date: Date | null | undefined) => (date ? Math.max(0, date.getTime() - start.getTime()) : null);
  const resolved = work.resolvedAt ?? null;
  return {
    impactStartedAt: start,
    timeToDetectMs: since(work.detectedAt),
    timeToMitigateMs: since(work.mitigatedAt ?? resolved),
    timeToResolveMs: since(resolved),
    impactMs: since(resolved ?? now) ?? 0,
    ongoing: !resolved,
  };
}

/**
 * Whether an incident counts in incident metrics: a declined (rejected)
 * incident, one closed as a duplicate or invalid, or one marked DUPLICATE_OF
 * another does not (INV-1125 / INV-1129).
 */
export function countsInIncidentMetrics(work: {
  commitmentStatus: CommitmentStatus;
  resolution: WorkResolution | null;
  duplicateOf?: boolean;
}): boolean {
  if (work.commitmentStatus === 'REJECTED') return false;
  if (work.resolution === 'DUPLICATE' || work.resolution === 'INVALID') return false;
  return !work.duplicateOf;
}
