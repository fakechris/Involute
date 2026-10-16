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
  ['research closing checks the attachment', /Research without an attachment/],
  ['bugs carry the Type label', /labels: \['bug'\]/],
  ['one Type per item', /at most one per item/],
  ['zero-bug: priority or reason, never backlog', /[Zz]ero-bug/],
  ['agent bugs with parent, priority and steps are committed directly', /steps_to_reproduce/],
  ['agent bug proposal refused without a priority', /proposal is refused/],
  ['agent-filed bugs never enter Candidates', /does not go to Candidates/],
  ['work_file_bug is the agent bug harness', /work_file_bug/],
  ['incidents carry the Type label Incident', /labels: \['incident'\]/],
  ['incidents start In Progress and announce incident.declared', /incident\.declared/],
  ['postmortem timeline merges impact timestamps and starred entries (INV-1212)', /时间线（自动：影响时间戳 \+ 标星条目）/],
  ['status is read, not remembered via agent_inbox or commitmentStatus (INV-1246)', /Status is read, not remembered/],
  ['unread_decisions piggybacked reminder on MCP tool responses (INV-1245)', /unread_decisions/],
];

describe('protocol guide and AGENTS.md agree on norm v1 (INV-721)', () => {
  for (const [rule, pattern] of NORM_RULES) {
    it(`both state: ${rule}`, () => {
      expect(guide).toMatch(pattern);
      expect(agents).toMatch(pattern);
    });
  }

  it('includes the 2026-10-16 silent batch-commit counterexample in protocol_get_guide (INV-1246)', () => {
    expect(guide).toContain('## Status is read, not remembered (INV-1246)');
    expect(guide).toContain('2026-10-16 counterexample');
    expect(guide).toContain('01:43');
    expect(guide).toContain('06:54');
    expect(guide).toContain('09:32');
    expect(guide).toContain('still waiting for your decision');
  });

  it('documents agent_inbox in skills/involute, skills/propose-work, and skills/agent-setup (INV-1246)', () => {
    const involuteSkill = readFileSync(new URL('../../../skills/involute/SKILL.md', import.meta.url), 'utf8');
    const proposeWorkSkill = readFileSync(new URL('../../../skills/propose-work/SKILL.md', import.meta.url), 'utf8');
    const agentSetupSkill = readFileSync(new URL('../../../skills/agent-setup/SKILL.md', import.meta.url), 'utf8');

    expect(involuteSkill).toMatch(/agent_inbox/i);
    expect(involuteSkill).toMatch(/status is read, not remembered/i);
    expect(proposeWorkSkill).toMatch(/agent_inbox/i);
    expect(agentSetupSkill).toMatch(/agent_inbox/i);
  });
});
