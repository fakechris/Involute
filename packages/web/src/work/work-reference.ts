/**
 * Work references in prose (INV-1466).
 *
 * Involute's descriptions, comments and run summaries are full of references
 * to other work items ("see INV-1446", "decided in INV-683"). Those
 * references are what a reader clicks through, so the app turns them into
 * links — but only the ones that really point at a work item.
 *
 * Two rules shape the matcher:
 *
 * - **The prefix is data.** `INV-1446` is the common form, but a project can
 *   carry an alias (`LUM-398` means `INV-398`, INV-459) and other teams use
 *   their own keys. So the shape is "letters, a dash, digits" — never the
 *   literal "INV".
 * - **Nothing is guessed.** The matcher only finds candidates; the server
 *   decides whether one is a work item. `UTF-8` and `ISO-8601` match the
 *   shape and still end up as plain words.
 */

/** A candidate reference and where it sits in the text. */
export interface WorkReferenceMatch {
  /** The reference as written, e.g. `INV-1446`. */
  reference: string;
  /** Offset of the reference in the text. */
  start: number;
  /** Offset just past the reference in the text. */
  end: number;
}

/**
 * `PREFIX-NUMBER`: a letter prefix of 1–10 characters, a dash and digits.
 *
 * The boundaries keep it away from the things that only look like
 * references: `CVE-2021-1234` (a longer dash chain), `INV-1446a` (a word
 * continues), `x-INV-1446` (a longer dash chain) and `INV-1446-1447`.
 */
const WORK_REFERENCE_PATTERN = /(?<![A-Za-z0-9_-])([A-Za-z]{1,10})-(\d{1,9})(?![A-Za-z0-9_-])/g;

/**
 * The candidates in `text`, in the order they appear. The same reference may
 * appear more than once; the caller decides what to do with the repeats.
 */
export function findWorkReferences(text: string): WorkReferenceMatch[] {
  const matches: WorkReferenceMatch[] = [];
  if (!text) return matches;
  for (const match of text.matchAll(WORK_REFERENCE_PATTERN)) {
    const start = match.index ?? 0;
    const reference = match[0];
    matches.push({ reference, start, end: start + reference.length });
  }
  return matches;
}

/** The key a reference is stored under: case does not matter to a reader. */
export function workReferenceKey(reference: string): string {
  return reference.trim().toUpperCase();
}

/**
 * Whether `text` is a work identifier and nothing else (`INV-1446`, any
 * casing), e.g. a `?issue=` value. Parsing identifiers happens here only
 * (INV-1536, design guard): a page that needs one asks this module.
 */
export function isWorkIdentifier(text: string): boolean {
  return /^[A-Za-z]{1,10}-\d{1,9}$/.test(text);
}

/** `"INV-12 Title words"` → `{ reference: "INV-12", rest: "Title words" }`; null when it does not start with one. */
export function splitLeadingReference(text: string): { reference: string; rest: string } | null {
  const match = /^([A-Za-z]{1,10}-\d{1,9})\s+([\s\S]+)$/.exec(text);
  return match ? { reference: match[1]!, rest: match[2]! } : null;
}
