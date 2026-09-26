import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { buildProtocolGuide } from './protocol-docs.ts';

const agents = readFileSync(new URL('../../../AGENTS.md', import.meta.url), 'utf8');
const guide = buildProtocolGuide();

// The agent-facing guide and AGENTS.md must state the same norm v1 rules
// (INV-721); a rule dropped from either shows up here.
const NORM_RULES: Array<[string, RegExp]> = [
  ['one parent, refused at commit', /refuse/i],
  ['legal CONTAINS incl. No milestone', /PROJECT → MILESTONE \/ DECISION \/ EPIC \/ ISSUE/],
  ['EPIC and sub-issues', /ISSUE → ISSUE/],
  ['related items inherit placement', /nearest legal same-repository ancestor/],
  ['mentions become RELATED_TO', /RELATED_TO/],
  ['dependencies as BLOCKS via blocked_by', /blocked_by/],
  ['never invent', /[Nn]ever invent dependencies or structure/],
  ['preview the tree', /lay out the whole tree/],
  ['research label', /labels: \['research'\]/],
  ['research downstream via DERIVED_FROM', /DERIVED_FROM/],
];

describe('protocol guide and AGENTS.md agree on norm v1 (INV-721)', () => {
  for (const [rule, pattern] of NORM_RULES) {
    it(`both state: ${rule}`, () => {
      expect(guide).toMatch(pattern);
      expect(agents).toMatch(pattern);
    });
  }
});
