const MAX_SLUG_LENGTH = 40;

/**
 * Harness-issued branch name for a claimed work item. The agent never invents
 * branch names containing issue identifiers — it uses this value verbatim, so
 * the webhook's branch-first resolution and the traceability guard always see
 * a reference the system itself produced.
 *
 * Format: feat/<identifier-lower>[-<ascii-slug>]. Non-ASCII titles (e.g.
 * Chinese) slugify to nothing and fall back to the bare identifier form.
 * The lowercase identifier still matches the webhook identifierPattern
 * ((?:INV|inv)-[0-9]+ word-boundary anchored).
 */
export function suggestedBranchName(identifier: string, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/, '');
  const base = `feat/${identifier.toLowerCase()}`;
  return slug ? `${base}-${slug}` : base;
}
