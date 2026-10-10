import type { WorkSearchHit } from './types';

/**
 * How a search hit matched: "in comment", "in run" (a run summary, INV-935),
 * "in postmortem.md" (an attached file, INV-1117), or "related" when found by
 * meaning alone (INV-927). The file name is set only when the snippet came
 * from that file, so a hit whose strongest field is elsewhere (say the title)
 * but whose snippet is from a file reads "in title · postmortem.md".
 */
export function matchLabel(hit: Pick<WorkSearchHit, 'matchedField' | 'attachmentFilename'>): string {
  if (hit.matchedField === 'semantic') return 'related';
  const file = hit.attachmentFilename;
  if (hit.matchedField === 'attachment') return `in ${file ?? 'attachment'}`;
  return file ? `in ${hit.matchedField} · ${file}` : `in ${hit.matchedField}`;
}
