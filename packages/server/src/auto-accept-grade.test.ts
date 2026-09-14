import { describe, expect, it } from 'vitest';

import { evaluateAutoAcceptGrade } from './auto-accept-grade.ts';

describe('evaluateAutoAcceptGrade', () => {
  it('requires human review for a self-reported merged PR', () => {
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
    expect(result.tier).toBe('LIKELY');
    expect(result.reasons.some((reason) => reason.includes('unverified'))).toBe(true);
  });

  it.each(['exit:0', 'status:pass', 'result=success'])('requires human review for self-reported TEST %s', (summary) => {
    const result = evaluateAutoAcceptGrade({
      runStatus: 'COMPLETED',
      evidence: [{ kind: 'TEST', summary, url: 'https://ci.example/job/1' }],
    });
    expect(result.tier).toBe('LIKELY');
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
