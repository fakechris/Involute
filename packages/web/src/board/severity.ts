import type { IssueSeverity } from './types';

/**
 * Severity says how bad the effect is; priority says what goes first and sets a
 * bug's SLA (INV-1115). Definitions: docs/severity.md — unsure, pick the higher.
 */
export const SEVERITY_OPTIONS: ReadonlyArray<{ value: IssueSeverity; label: string; description: string }> = [
  { value: 'SEV1', label: 'SEV1 Critical', description: 'Outage, data loss or security exposure; no workaround.' },
  { value: 'SEV2', label: 'SEV2 Major', description: 'A core flow broken or badly degraded; painful workaround.' },
  { value: 'SEV3', label: 'SEV3 Minor', description: 'Limited impact; a workaround exists.' },
];

export function severityLabel(severity: IssueSeverity | null | undefined): string {
  if (!severity) return 'No severity';
  return SEVERITY_OPTIONS.find((option) => option.value === severity)?.label ?? severity;
}
