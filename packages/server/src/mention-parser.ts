// Parsing half of INV-558 (B1). Kept free of Prisma so the rules that decide
// "is this an `@` that means something" are testable on their own, and so the
// same rules are reused later by the mention-diff on comment edits.
//
// The rule that matters: an `@` inside code never means a mention. A sidecar
// matching strings in the raw body would fire on `@mia` in a pasted snippet
// and create a ghost request (docs/54 §E1).

// Handles are lowercase; 1-32 chars, starting alphanumeric. Deliberately
// narrower than the mention regex below so a typo resolves to nothing instead
// of to the wrong actor.
export const HANDLE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const MAX_HANDLE_LENGTH = 32;

// The character before `@` must not be one that makes the `@` part of some
// other token: `admin@involute.local` is an email, not a mention of
// `@involute`, and `@@unique` is Prisma syntax.
// The trailing lookahead makes an over-long run fail outright instead of
// truncating: `@` + 40 chars must resolve to nothing, never to the actor
// whose handle happens to be its first 32 characters.
const MENTION_PATTERN = /(^|[^A-Za-z0-9_@.\-/])@([A-Za-z0-9][A-Za-z0-9_-]{0,31})(?![A-Za-z0-9_-])/g;

const FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})(.*)$/;

export function normalizeHandle(value: string): string {
  return value.trim().replace(/^@/, '').toLowerCase();
}

export function isValidHandle(value: string): boolean {
  return HANDLE_PATTERN.test(value);
}

/**
 * Replaces every code region with spaces of the same length, so offsets stay
 * intact and the mention scan simply cannot see inside code. Covers fenced
 * blocks (``` / ~~~, including unterminated ones) and inline code spans.
 */
export function maskCodeRegions(body: string): string {
  const lines = body.split('\n');
  const masked: string[] = [];
  let openFence: string | null = null;

  for (const line of lines) {
    const fence = FENCE_PATTERN.exec(line);
    const fenceRun = fence?.[1] ?? null;
    const fenceInfo = fence?.[2] ?? '';

    if (openFence) {
      masked.push(' '.repeat(line.length));
      // A closing fence must be the same character and at least as long as
      // the opener, with nothing but whitespace after it (CommonMark).
      if (
        fenceRun
        && fenceRun[0] === openFence[0]
        && fenceRun.length >= openFence.length
        && fenceInfo.trim() === ''
      ) {
        openFence = null;
      }
      continue;
    }

    if (fenceRun) {
      openFence = fenceRun;
      masked.push(' '.repeat(line.length));
      continue;
    }

    masked.push(maskInlineCode(line));
  }

  return masked.join('\n');
}

/**
 * CommonMark code spans: a run of N backticks opens, the next run of exactly N
 * backticks closes. An unmatched run is literal text, not code.
 */
function maskInlineCode(line: string): string {
  const characters = [...line];
  let index = 0;

  while (index < characters.length) {
    if (characters[index] !== '`') {
      index += 1;
      continue;
    }

    const openStart = index;
    while (index < characters.length && characters[index] === '`') {
      index += 1;
    }
    const runLength = index - openStart;

    let cursor = index;
    let closeStart = -1;
    while (cursor < characters.length) {
      if (characters[cursor] !== '`') {
        cursor += 1;
        continue;
      }
      const candidateStart = cursor;
      while (cursor < characters.length && characters[cursor] === '`') {
        cursor += 1;
      }
      if (cursor - candidateStart === runLength) {
        closeStart = candidateStart;
        break;
      }
    }

    if (closeStart === -1) {
      // Unmatched opener: the rest of the line is ordinary text.
      break;
    }

    for (let position = openStart; position < closeStart + runLength; position += 1) {
      characters[position] = ' ';
    }
    index = closeStart + runLength;
  }

  return characters.join('');
}

/**
 * Unique lowercase handles mentioned in `body`, in first-appearance order.
 * Purely lexical — it does not know which handles exist.
 */
export function extractMentionHandles(body: string): string[] {
  const scannable = maskCodeRegions(body);
  const handles: string[] = [];
  const seen = new Set<string>();

  MENTION_PATTERN.lastIndex = 0;
  let match = MENTION_PATTERN.exec(scannable);
  while (match) {
    const handle = (match[2] ?? '').toLowerCase();
    if (isValidHandle(handle) && !seen.has(handle)) {
      seen.add(handle);
      handles.push(handle);
    }
    match = MENTION_PATTERN.exec(scannable);
  }

  return handles;
}
