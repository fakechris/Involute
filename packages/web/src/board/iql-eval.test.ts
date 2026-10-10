import { describe, expect, it } from 'vitest';

import { matchesIql } from './iql-eval';
import type { IssueSummary } from './types';

const issue = (severity: IssueSummary['severity']) => ({ severity } as unknown as IssueSummary);

// Saved views read severity: the way the server does (INV-1115).
describe('matchesIql severity', () => {
  it('matches listed severities, none for unjudged, and negation', () => {
    expect(matchesIql('severity:sev1', issue('SEV1'), null)).toBe(true);
    expect(matchesIql('severity:sev1,sev2', issue('SEV2'), null)).toBe(true);
    expect(matchesIql('severity:sev1', issue('SEV3'), null)).toBe(false);
    expect(matchesIql('severity:none', issue(null), null)).toBe(true);
    expect(matchesIql('severity:none', issue(undefined), null)).toBe(true);
    expect(matchesIql('-severity:sev1', issue(null), null)).toBe(true);
    expect(matchesIql('severity:!=sev1', issue('SEV1'), null)).toBe(false);
  });
});
