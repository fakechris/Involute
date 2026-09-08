import { describe, expect, it } from 'vitest';

import { evaluateAutoAcceptGrade } from './auto-accept-grade.ts';

describe('evaluateAutoAcceptGrade', () => {
  it('grades CLEAR for merged PR on a completed run', () => {
    const result = evaluateAutoAcceptGrade({
      runStatus: 'COMPLETED',
      evidence: [
        {
          kind: 'PR',
          summary: 'Landing fix; merged: true; checks: green',
          url: 'https://github.com/fakechris/Involute/pull/42',
        },
      ],
    });
    expect(result.tier).toBe('CLEAR');
    expect(result.reasons.some((reason) => reason.includes('PR merged'))).toBe(true);
  });

  it('grades CLEAR for TEST exit 0', () => {
    const result = evaluateAutoAcceptGrade({
      runStatus: 'COMPLETED',
      evidence: [{ kind: 'TEST', summary: 'unit suite exit:0', url: 'https://ci.example/job/1' }],
    });
    expect(result.tier).toBe('CLEAR');
  });

  it('keeps PR with only green checks as LIKELY (not CLEAR)', () => {
    const result = evaluateAutoAcceptGrade({
      runStatus: 'COMPLETED',
      evidence: [{ kind: 'PR', summary: 'checks: green', url: 'https://github.com/org/repo/pull/1' }],
    });
    expect(result.tier).toBe('LIKELY');
  });

  it('refuses CLEAR when a fail signal is present', () => {
    const result = evaluateAutoAcceptGrade({
      runStatus: 'COMPLETED',
      evidence: [
        { kind: 'TEST', summary: 'exit: 0' },
        { kind: 'PR', summary: 'merged: false' },
      ],
    });
    expect(result.tier).toBe('AMBIGUOUS');
  });

  it('grades soft-only evidence as AMBIGUOUS', () => {
    const result = evaluateAutoAcceptGrade({
      runStatus: 'COMPLETED',
      evidence: [{ kind: 'SCREENSHOT', summary: 'looks good', url: 'https://example/shot.png' }],
    });
    expect(result.tier).toBe('AMBIGUOUS');
  });

  it('grades missing run or evidence as INSUFFICIENT', () => {
    expect(
      evaluateAutoAcceptGrade({ runStatus: 'RUNNING', evidence: [{ kind: 'TEST', summary: 'exit:0' }] })
        .tier,
    ).toBe('INSUFFICIENT');
    expect(evaluateAutoAcceptGrade({ runStatus: 'COMPLETED', evidence: [] }).tier).toBe(
      'INSUFFICIENT',
    );
  });
});
