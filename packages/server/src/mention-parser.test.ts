import { describe, expect, it } from 'vitest';

import { extractMentionHandles, isValidHandle, maskCodeRegions, normalizeHandle } from './mention-parser.ts';

describe('mention parser (INV-558)', () => {
  it('extracts a plain mention', () => {
    expect(extractMentionHandles('hey @mia, what was your reasoning?')).toEqual(['mia']);
  });

  it('lowercases and de-duplicates, keeping first-appearance order', () => {
    expect(extractMentionHandles('@Bob then @mia then @BOB')).toEqual(['bob', 'mia']);
  });

  it('ignores mentions inside a fenced code block (A2)', () => {
    const body = [
      'ask @mia about this:',
      '```ts',
      'const owner = "@mia";',
      '```',
      'and also @bob',
    ].join('\n');

    expect(extractMentionHandles(body)).toEqual(['mia', 'bob']);
  });

  it('ignores mentions inside a tilde fence and an unterminated fence', () => {
    expect(extractMentionHandles('~~~\n@mia\n~~~')).toEqual([]);
    expect(extractMentionHandles('```\n@mia\nstill open')).toEqual([]);
  });

  it('does not let an info string close the block it opened', () => {
    expect(extractMentionHandles('```js\n@mia\n```\n@bob')).toEqual(['bob']);
  });

  it('ignores mentions inside inline code spans', () => {
    expect(extractMentionHandles('run `grep @mia` then ping @bob')).toEqual(['bob']);
  });

  it('treats an unmatched backtick as literal text, not as code', () => {
    expect(extractMentionHandles('a ` b @mia')).toEqual(['mia']);
  });

  it('honours multi-backtick code span fences', () => {
    expect(extractMentionHandles('``a `@mia` b`` @bob')).toEqual(['bob']);
  });

  it('does not treat an email address as a mention', () => {
    expect(extractMentionHandles('mail admin@involute.local now')).toEqual([]);
  });

  it('does not treat a doubled @ as a mention', () => {
    expect(extractMentionHandles('prisma uses @@unique here')).toEqual([]);
  });

  it('stops the handle at punctuation', () => {
    expect(extractMentionHandles('(@mia) @bob. @kai-2, @x_y!')).toEqual(['mia', 'bob', 'kai-2', 'x_y']);
  });

  it('matches a mention at the very start and end of the body', () => {
    expect(extractMentionHandles('@mia')).toEqual(['mia']);
  });

  it('rejects an over-long handle', () => {
    const tooLong = 'a'.repeat(33);
    expect(extractMentionHandles(`@${tooLong}`)).toEqual([]);
  });

  it('masks code regions without shifting offsets', () => {
    const body = 'a `x` b';
    expect(maskCodeRegions(body)).toHaveLength(body.length);
    expect(maskCodeRegions(body)).toBe('a     b');
  });

  it('normalizes and validates handles', () => {
    expect(normalizeHandle(' @Mia ')).toBe('mia');
    expect(isValidHandle('mia')).toBe(true);
    expect(isValidHandle('-mia')).toBe(false);
    expect(isValidHandle('mi a')).toBe(false);
    expect(isValidHandle('')).toBe(false);
  });
});
