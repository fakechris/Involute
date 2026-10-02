import type { WorkSearchHit } from './types';

/** How a search hit matched: "in comment", or "related" when found by meaning alone (INV-927). */
export function matchLabel(field: WorkSearchHit['matchedField']): string {
  return field === 'semantic' ? 'related' : `in ${field}`;
}
