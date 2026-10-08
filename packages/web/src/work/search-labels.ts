import type { WorkSearchHit } from './types';

/** How a search hit matched: "in comment", "in run" (a run summary, INV-935), or "related" when found by meaning alone (INV-927). */
export function matchLabel(field: WorkSearchHit['matchedField']): string {
  return field === 'semantic' ? 'related' : `in ${field}`;
}
