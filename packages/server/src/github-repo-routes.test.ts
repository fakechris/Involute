import { describe, expect, it } from 'vitest';

import {
  buildIdentifierPattern,
  extractIssueIdentifiers,
  resolveCanonicalIssueRef,
  resolveIssueIdentifierFromPr,
  type RepoRoute,
} from './github-repo-routes.ts';

const ALIAS_ROUTE: RepoRoute = {
  repository: 'fakechris/lumenbox',
  teamKey: 'INV',
  identifierPattern: buildIdentifierPattern(['INV', 'LUM']),
  alias: 'LUM',
};

describe('buildIdentifierPattern', () => {
  it('matches every prefix in the set with word boundaries, case-insensitively', () => {
    expect(extractIssueIdentifiers('feat/INV-12-x', ALIAS_ROUTE)).toEqual(['INV-12']);
    expect(extractIssueIdentifiers('feat/LUM-398-x', ALIAS_ROUTE)).toEqual(['LUM-398']);
    expect(extractIssueIdentifiers('fix: [inv-5] lowercase', ALIAS_ROUTE)).toEqual(['INV-5']);
    expect(extractIssueIdentifiers('fix: [lum-7] lowercase alias', ALIAS_ROUTE)).toEqual(['LUM-7']);
    // Boundary safety: partial prefix collisions must not match.
    expect(extractIssueIdentifiers('SPINV-12 hack', ALIAS_ROUTE)).toEqual([]);
    expect(extractIssueIdentifiers('GLUM-12 hack', ALIAS_ROUTE)).toEqual([]);
    // Unknown prefixes are not part of the pattern at all.
    expect(extractIssueIdentifiers('feat/POP-12-other', ALIAS_ROUTE)).toEqual([]);
  });

  it('escapes regex metacharacters in prefixes', () => {
    const pattern = buildIdentifierPattern(['IN.V']);
    expect(pattern.test('IN.V-12')).toBe(true);
    expect(pattern.test('INV-12')).toBe(false);
  });
});

describe('resolveCanonicalIssueRef (alias semantics)', () => {
  it('canonicalizes alias references to the team key with viaAlias', () => {
    expect(
      resolveCanonicalIssueRef({ branch: 'feat/LUM-398-alias', title: '', route: ALIAS_ROUTE }),
    ).toEqual({ identifier: 'INV-398', viaAlias: true });
  });

  it('leaves team-key references untouched', () => {
    expect(
      resolveCanonicalIssueRef({ branch: 'feat/INV-398-direct', title: '', route: ALIAS_ROUTE }),
    ).toEqual({ identifier: 'INV-398', viaAlias: false });
  });

  it('resolves from the title when the branch carries no reference', () => {
    expect(
      resolveCanonicalIssueRef({ branch: 'patch-1', title: 'fix: [LUM-42] title only', route: ALIAS_ROUTE }),
    ).toEqual({ identifier: 'INV-42', viaAlias: true });
  });

  it('returns undefined for unknown prefixes and missing references', () => {
    expect(
      resolveCanonicalIssueRef({ branch: 'feat/POP-12-other', title: 'no ref', route: ALIAS_ROUTE }),
    ).toBeUndefined();
    expect(
      resolveCanonicalIssueRef({ branch: 'main', title: 'quick fix', route: ALIAS_ROUTE }),
    ).toBeUndefined();
  });

  it('keeps resolveIssueIdentifierFromPr as a thin string wrapper', () => {
    expect(
      resolveIssueIdentifierFromPr({ branch: 'feat/LUM-398-alias', title: '', route: ALIAS_ROUTE }),
    ).toBe('INV-398');
    expect(
      resolveIssueIdentifierFromPr({ branch: 'feat/INV-9-direct', title: '', route: ALIAS_ROUTE }),
    ).toBe('INV-9');
    expect(
      resolveIssueIdentifierFromPr({ branch: 'main', title: 'nothing', route: ALIAS_ROUTE }),
    ).toBeUndefined();
  });
});
