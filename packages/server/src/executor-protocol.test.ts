import { describe, expect, it } from 'vitest';
import { parseExecutorReceipt, receiptAssessment, executorVisibleState } from './executor-protocol.js';
const sha = 'a'.repeat(40);
const receipt = { version: 1, repository: 'test/repo', commitSha: sha, pullRequestNumber: 12, environment: 'staging', deployedSha: sha, health: 'pass', behavior: 'pass', evidenceUrls: ['https://example.test/receipt'], observedAt: '2026-10-03T00:00:00.000Z' };
describe('external executor receipts are observations, not acceptance', () => {
  it('rejects unknown versions and malformed provenance', () => {
    for (const change of [{ version: 2 }, { commitSha: 'main' }, { health: 'accepted' }, { evidenceUrls: ['file:///secret'] }, { observedAt: 'yesterday' }]) expect(() => parseExecutorReceipt({ ...receipt, ...change })).toThrow();
  });
  it('shows a deployed version mismatch even when health and CI are green', () => {
    expect(receiptAssessment(parseExecutorReceipt({ ...receipt, deployedSha: 'b'.repeat(40) }), sha)).toMatchObject({ versionMatches: false, productionAccepted: false });
  });
  it('never infers deployment or production acceptance from a commit or PR', () => {
    expect(receiptAssessment(parseExecutorReceipt({ ...receipt, deployedSha: null, environment: null, health: 'unknown', behavior: 'unknown' }))).toMatchObject({ deploymentObserved: false, productionAccepted: false });
    expect(receiptAssessment(parseExecutorReceipt(receipt), sha).productionAccepted).toBe(false);
  });
  it('compares deployment to the authorized release, not the PR head', () => {
    const release = 'b'.repeat(40);
    expect(receiptAssessment(parseExecutorReceipt({ ...receipt, deployedSha: release }), release).versionMatches).toBe(true);
  });
  it('does not equate a requested stop or expired executor lease with an acknowledged stop', () => {
    const now = new Date('2026-10-03T01:00:00Z');
    expect(executorVisibleState({ state: 'STOP_REQUESTED', leaseUntil: new Date('2026-10-03T00:00:00Z') }, now)).toBe('UNKNOWN');
    expect(executorVisibleState({ state: 'RUNNING', leaseUntil: new Date('2026-10-03T00:00:00Z') }, now)).toBe('UNKNOWN');
    expect(executorVisibleState({ state: 'STOPPED', leaseUntil: null }, now)).toBe('STOPPED');
  });
});
