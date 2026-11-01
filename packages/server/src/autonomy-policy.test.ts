import { describe, expect, it } from 'vitest';

import {
  BUILT_IN_LOCKS, GATES, LEVEL_DESCRIPTIONS, LEVEL_PRESETS,
  decide, evaluatePredicate, resolveAutonomy, validateGateTable, validatePredicate,
  type AutonomyFacts, type AutonomyLevel, type Decider, type Gate,
} from './autonomy-policy.js';

// INV-1488: the resolver is the one place the per-level table lives; this test
// pins docs/autonomy-policy.md §3.1 cell by cell so a drift is a red test.
describe('autonomy policy: level presets (docs/autonomy-policy.md §3.1)', () => {
  const table: Record<Gate, Record<AutonomyLevel, Decider>> = {
    candidate_commit:   { 0: 'human', 1: 'auto', 2: 'auto', 3: 'auto' },
    contract_amendment: { 0: 'human', 1: 'auto', 2: 'auto', 3: 'auto' },
    review_accept:      { 0: 'human', 1: 'human', 2: 'auto', 3: 'auto' },
    agent_delegation:   { 0: 'none', 1: 'none', 2: 'none', 3: 'auto' },
    merge_signal:       { 0: 'human', 1: 'human', 2: 'human', 3: 'human' },
    spend_budget:       { 0: 'none', 1: 'none', 2: 'none', 3: 'human' },
  };

  for (const gate of GATES) {
    for (const level of [0, 1, 2, 3] as const) {
      it(`${gate} at L${level} is ${table[gate][level]}`, () => {
        expect(LEVEL_PRESETS[level][gate].decider).toBe(table[gate][level]);
      });
    }
  }

  it('describes every level in English and Chinese', () => {
    for (const level of [0, 1, 2, 3] as const) {
      expect(LEVEL_DESCRIPTIONS[level].name).toMatch(new RegExp(`^L${level} `));
      expect(LEVEL_DESCRIPTIONS[level].en.length).toBeGreaterThan(40);
      expect(LEVEL_DESCRIPTIONS[level].zh.length).toBeGreaterThan(20);
    }
  });

  it('every preset condition is itself valid', () => {
    for (const level of [0, 1, 2, 3] as const) expect(validateGateTable(LEVEL_PRESETS[level])).toEqual([]);
    for (const lock of BUILT_IN_LOCKS) expect(validatePredicate(lock.when)).toEqual([]);
  });
});

describe('autonomy policy: conditions are typed fields only (§3)', () => {
  it('refuses an unknown field, a missing operator and a malformed list', () => {
    expect(validatePredicate({ field: 'title', eq: 'x' })).toEqual([expect.stringContaining('unknown field "title"')]);
    expect(validatePredicate({ field: 'type' })).toEqual([expect.stringContaining('exactly one of')]);
    expect(validatePredicate({ field: 'type', in: 'bug' })).toEqual([expect.stringContaining('must be a list')]);
    expect(validatePredicate({ all: [{ field: 'priority', gte: '2' }] })).toEqual([expect.stringContaining('all[0].gte: must be a number')]);
  });

  it('refuses an unknown gate and an unknown decider', () => {
    expect(validateGateTable({ merge: { decider: 'auto' } })).toEqual(['gates.merge: unknown gate']);
    expect(validateGateTable({ review_accept: { decider: 'robot' } })).toEqual(['gates.review_accept.decider: human / auto / none']);
  });

  it('evaluates eq / in / not_in / gte / lte / subset_of, case-insensitively, and never matches an unknown fact', () => {
    const facts: AutonomyFacts = { type: 'Bug', priority: 2, labels: ['bug', 'web'], amendment_fields: ['verification'], severity: null };
    expect(evaluatePredicate({ field: 'type', eq: 'bug' }, facts)).toBe(true);
    expect(evaluatePredicate({ field: 'labels', in: ['WEB'] }, facts)).toBe(true);
    expect(evaluatePredicate({ field: 'severity', not_in: ['SEV1'] }, facts)).toBe(true);
    expect(evaluatePredicate({ field: 'priority', gte: 2 }, facts)).toBe(true);
    expect(evaluatePredicate({ field: 'priority', lte: 1 }, facts)).toBe(false);
    expect(evaluatePredicate({ field: 'amendment_fields', subset_of: ['verification'] }, facts)).toBe(true);
    expect(evaluatePredicate({ field: 'amendment_fields', subset_of: ['scope'] }, facts)).toBe(false);
    expect(evaluatePredicate({ field: 'checks', eq: 'green' }, facts)).toBe(false);
  });
});

describe('autonomy policy: resolution (§6)', () => {
  it('a fresh workspace resolves to L0 with every gate human or none', () => {
    const resolved = resolveAutonomy({});
    expect(resolved.level).toBe(0);
    expect(resolved.source).toBe('default');
    expect(Object.values(resolved.gates).every((gate) => gate.decider !== 'auto')).toBe(true);
  });

  it('effective = min(ceiling, project ?? team, agent trust), and says which one clamped', () => {
    expect(resolveAutonomy({ workspace: { level: 3 }, team: { level: 2 } })).toMatchObject({ level: 2, source: 'team' });
    expect(resolveAutonomy({ workspace: { level: 3 }, team: { level: 2 }, project: { level: 1 } })).toMatchObject({ level: 1, source: 'project' });
    expect(resolveAutonomy({ workspace: { level: 1 }, team: { level: 3 } })).toMatchObject({ level: 1, source: 'ceiling', requested: 3 });
    expect(resolveAutonomy({ workspace: { level: 3 }, team: { level: 3 }, agentTrust: 'OBSERVE' })).toMatchObject({ level: 0, source: 'agent_trust' });
    expect(resolveAutonomy({ workspace: { level: 3 }, team: { level: 3 }, agentTrust: 'L3' })).toMatchObject({ level: 3, source: 'team' });
  });

  it('a scope may tighten a gate but cannot loosen one the level keeps human', () => {
    const tightened = resolveAutonomy({ workspace: { level: 2 }, team: { level: 2, gates: { review_accept: { decider: 'human' } } } });
    expect(tightened.gates.review_accept).toMatchObject({ decider: 'human', from: 'team' });
    const loosened = resolveAutonomy({ workspace: { level: 1 }, team: { level: 1, gates: { review_accept: { decider: 'auto' } } } });
    expect(loosened.gates.review_accept).toMatchObject({ decider: 'human', from: 'preset' });
  });

  it('observe mode reports what would happen and keeps the decision with a person', () => {
    const future = new Date(Date.now() + 86_400_000);
    const resolved = resolveAutonomy({ workspace: { level: 2 }, team: { level: 2, observeUntil: future } });
    expect(resolved.observing).toBe(true);
    const facts: AutonomyFacts = { auto_accept_grade: 'CLEAR', pr_merged: true, checks: 'green', reproducibility: 'ALWAYS', severity: null };
    expect(decide(resolved, 'review_accept', facts)).toMatchObject({ decider: 'human', matched: true, reason: expect.stringContaining('observing') });
    const past = new Date(Date.now() - 1_000);
    const live = resolveAutonomy({ workspace: { level: 2 }, team: { level: 2, observeUntil: past } });
    expect(decide(live, 'review_accept', facts)).toMatchObject({ decider: 'auto', matched: true });
  });

  it('built-in locks keep SEV1/SEV2, deploys and intermittent bugs with a person at every level', () => {
    const resolved = resolveAutonomy({ workspace: { level: 3 }, team: { level: 3 } });
    const clear: AutonomyFacts = { auto_accept_grade: 'CLEAR', pr_merged: true, checks: 'green', reproducibility: 'ALWAYS', severity: null };
    expect(decide(resolved, 'review_accept', clear).decider).toBe('auto');
    expect(decide(resolved, 'review_accept', { ...clear, severity: 'SEV2' })).toMatchObject({ decider: 'human', reason: expect.stringContaining('INV-1126') });
    expect(decide(resolved, 'review_accept', { ...clear, delivery_actions: ['edit', 'deploy'] })).toMatchObject({ decider: 'human', reason: expect.stringContaining('deploy') });
    expect(decide(resolved, 'review_accept', { ...clear, reproducibility: 'SOMETIMES' })).toMatchObject({ decider: 'human', reason: expect.stringContaining('INV-1122') });
    expect(resolved.locked).toEqual(expect.arrayContaining(['sev1_sev2_done', 'deploy_or_credentials', 'intermittent_bug']));
  });

  it('L1 commits a bug with steps, acceptance and priority ≤ High, escalates the rest', () => {
    const resolved = resolveAutonomy({ workspace: { level: 1 }, team: { level: 1 } });
    const good: AutonomyFacts = { type: 'bug', has_steps: true, has_acceptance: true, priority: 2 };
    expect(decide(resolved, 'candidate_commit', good).decider).toBe('auto');
    expect(decide(resolved, 'candidate_commit', { ...good, priority: 1 })).toMatchObject({ decider: 'human', reason: expect.stringContaining('Escalated') });
    expect(decide(resolved, 'candidate_commit', { ...good, type: 'feature' }).decider).toBe('human');
    expect(decide(resolved, 'candidate_commit', { ...good, has_acceptance: false }).decider).toBe('human');
    expect(decide(resolved, 'contract_amendment', { amendment_fields: ['verification'] }).decider).toBe('auto');
    expect(decide(resolved, 'contract_amendment', { amendment_fields: ['verification', 'acceptance'] }).decider).toBe('human');
    expect(decide(resolved, 'agent_delegation', {})).toMatchObject({ decider: 'none' });
  });
});
