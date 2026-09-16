import { describe, expect, it } from 'vitest';

import { applyMention, findMentionQuery } from './useMentionSuggest';

describe('mention completion (INV-573)', () => {
  it('opens on a bare @ so the directory is discoverable before you know a handle', () => {
    expect(findMentionQuery('ping @', 6)).toEqual({ start: 5, term: '' });
  });

  it('narrows as you type', () => {
    expect(findMentionQuery('ping @mi', 8)).toEqual({ start: 5, term: 'mi' });
  });

  it('lowercases the term, because handles are lowercase', () => {
    expect(findMentionQuery('ping @MI', 8)?.term).toBe('mi');
  });

  it('does not open inside an email address', () => {
    // Same boundary rule the server's scanner uses; if the menu opened here it
    // would offer to insert a mention the server would never resolve.
    expect(findMentionQuery('mail admin@involute', 19)).toBeNull();
  });

  it('does not open after a doubled @', () => {
    expect(findMentionQuery('prisma @@uni', 12)).toBeNull();
  });

  it('closes once the token is no longer at the caret', () => {
    expect(findMentionQuery('ping @mia now', 13)).toBeNull();
  });

  it('inserts the handle with a trailing space and reports the new caret', () => {
    const value = 'ping @mi';
    const query = findMentionQuery(value, 8)!;

    expect(applyMention(value, query, 'mia', 8)).toEqual({
      caret: 10,
      value: 'ping @mia ',
    });
  });

  it('keeps text after the caret intact', () => {
    const value = 'ping @mi please';
    const query = findMentionQuery(value, 8)!;

    expect(applyMention(value, query, 'mia', 8).value).toBe('ping @mia  please');
  });
});
