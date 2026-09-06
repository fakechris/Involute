import { describe, expect, it } from 'vitest';

import { describeIql, IqlParseError, parseIql } from '../src/iql.js';

describe('parseIql', () => {
  it('parses field terms, comparisons, and negation', () => {
    const query = parseIql('team:SON state:"In Review" priority:>=2 updated:>30d -commitment:rejected');
    expect(query.terms.map((term) => [term.field, term.op, term.value, term.negated])).toEqual([
      ['team', 'eq', 'SON', false],
      ['state', 'eq', 'In Review', false],
      ['priority', 'gte', '2', false],
      ['updated', 'gt', '30d', false],
      ['commitment', 'eq', 'rejected', true],
    ]);
  });

  it('treats bare words as free-text terms', () => {
    const query = parseIql('migration backup');
    expect(query.terms.map((term) => term.field)).toEqual([null, null]);
    expect(query.terms.map((term) => term.value)).toEqual(['migration', 'backup']);
  });

  it('keeps quoted strings together and supports IN lists', () => {
    const query = parseIql('label:"release blocker" state-type:STARTED,REVIEW');
    expect(query.terms[0]?.value).toBe('release blocker');
    expect(query.terms[1]?.value).toBe('STARTED,REVIEW');
  });

  it('round-trips through describeIql', () => {
    const text = 'team:SON -state:done priority:>=2';
    expect(describeIql(parseIql(text))).toBe(text);
  });

  it('rejects unknown fields, empty values, and unterminated quotes with positions', () => {
    expect(() => parseIql('bogus:1')).toThrow(IqlParseError);
    try {
      parseIql('state:done bogus:1');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(IqlParseError);
      expect((error as IqlParseError).term).toBe('bogus:1');
      expect((error as IqlParseError).position).toBe(2);
    }
    expect(() => parseIql('state:')).toThrow(IqlParseError);
    expect(() => parseIql('state:"unfinished')).toThrow(IqlParseError);
    expect(() => parseIql('priority:>2,<5')).toThrow(IqlParseError);
  });

  it('does not treat negative numbers as negation', () => {
    const query = parseIql('priority:-1');
    expect(query.terms[0]?.negated).toBe(false);
    expect(query.terms[0]?.value).toBe('-1');
  });

  it('returns an empty term list for blank queries', () => {
    expect(parseIql('   ').terms).toEqual([]);
  });
});
