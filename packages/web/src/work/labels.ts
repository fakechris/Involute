/**
 * The Type label group (Bug route v1, INV-748/749): Bug, Feature and
 * Improvement, matched case-insensitively; an item carries at most one.
 * The server enforces it; the UI swaps instead of stacking.
 */
const TYPE_KEYS: ReadonlySet<string> = new Set(['bug', 'feature', 'improvement']);

export function isTypeLabel(name: string): boolean {
  return TYPE_KEYS.has(name.trim().toLowerCase());
}

/** Label ids after turning `labelId` on or off, dropping any other Type when a Type is turned on. */
export function toggleLabelId(
  current: string[],
  labelId: string,
  checked: boolean,
  labels: Array<{ id: string; name: string }>,
): string[] {
  if (!checked) return current.filter((id) => id !== labelId);
  const label = labels.find((candidate) => candidate.id === labelId);
  const kept = label && isTypeLabel(label.name)
    ? current.filter((id) => {
        const other = labels.find((candidate) => candidate.id === id);
        return !other || !isTypeLabel(other.name);
      })
    : current;
  return kept.includes(labelId) ? kept : [...kept, labelId];
}
