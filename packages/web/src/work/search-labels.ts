import type { WorkSearchHit } from './types';

/**
 * How a search hit matched: "in comment", "in run" (a run summary, INV-935),
 * "in postmortem.md" (an attached file, INV-1117), or "related" when found by
 * meaning alone (INV-927).
 */
export function matchLabel(hit: Pick<WorkSearchHit, 'matchedField' | 'attachmentFilename'>): string {
  if (hit.matchedField === 'semantic') return 'related';
  if (hit.matchedField === 'attachment' && hit.attachmentFilename) return `in ${hit.attachmentFilename}`;
  return `in ${hit.matchedField}`;
}
