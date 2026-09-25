import { describe, expect, it } from 'vitest';

import { deriveTimeline, type AuditPoint } from './work-timeline.ts';

const states = new Map([
  ['s-backlog', { name: 'Backlog', type: 'BACKLOG' as const }],
  ['s-ready', { name: 'Ready', type: 'UNSTARTED' as const }],
  ['s-progress', { name: 'In Progress', type: 'STARTED' as const }],
  ['s-review', { name: 'In Review', type: 'REVIEW' as const }],
  ['s-done', { name: 'Done', type: 'COMPLETED' as const }],
  ['s-canceled', { name: 'Canceled', type: 'CANCELED' as const }],
]);

const day = (n: number) => new Date(Date.UTC(2026, 8, n));

function audit(n: number, before: string | null, after: string, extra: Partial<AuditPoint> = {}): AuditPoint {
  return { at: day(n), beforeStateId: before, afterStateId: after, afterCommitment: 'COMMITTED', isCreation: before === null, ...extra };
}

const subject = (stateId: string, updated = 30, commitmentStatus = 'COMMITTED') => ({
  id: 'w1',
  stateId,
  commitmentStatus,
  updatedAt: day(updated),
});

describe('deriveTimeline (INV-682)', () => {
  it('follows a full ready -> progress -> review -> done path', () => {
    const entry = deriveTimeline(
      subject('s-done', 9),
      [audit(1, null, 's-ready'), audit(3, 's-ready', 's-progress'), audit(4, 's-progress', 's-progress'), audit(6, 's-progress', 's-review'), audit(9, 's-review', 's-done')],
      states,
    );
    expect(entry.history).toBe('FULL');
    expect(entry.committedAt).toEqual(day(1));
    expect(entry.startedAt).toEqual(day(3));
    expect(entry.reviewAt).toEqual(day(6));
    expect(entry.completedAt).toEqual(day(9));
    expect(entry.canceledAt).toBeNull();
    // Edits that keep the state do not add transitions.
    expect(entry.transitions.map((transition) => transition.stateType)).toEqual(['UNSTARTED', 'STARTED', 'REVIEW', 'COMPLETED']);
  });

  it('counts a jump straight to Done as starting and finishing at once', () => {
    const entry = deriveTimeline(subject('s-done', 5), [audit(1, null, 's-ready'), audit(5, 's-ready', 's-done')], states);
    expect(entry.startedAt).toEqual(day(5));
    expect(entry.reviewAt).toBeNull();
    expect(entry.completedAt).toEqual(day(5));
  });

  it('clears completedAt when work is reopened and dates the latest Done spell', () => {
    const reopened = deriveTimeline(
      subject('s-progress', 8),
      [audit(1, null, 's-progress'), audit(4, 's-progress', 's-done'), audit(8, 's-done', 's-progress')],
      states,
    );
    expect(reopened.completedAt).toBeNull();
    expect(reopened.startedAt).toEqual(day(1));

    const doneAgain = deriveTimeline(
      subject('s-done', 12),
      [audit(1, null, 's-progress'), audit(4, 's-progress', 's-done'), audit(8, 's-done', 's-progress'), audit(12, 's-progress', 's-done')],
      states,
    );
    expect(doneAgain.completedAt).toEqual(day(12));
  });

  it('records cancellation separately from completion', () => {
    const entry = deriveTimeline(subject('s-canceled', 3), [audit(1, null, 's-ready'), audit(3, 's-ready', 's-canceled')], states);
    expect(entry.canceledAt).toEqual(day(3));
    expect(entry.completedAt).toBeNull();
    expect(entry.startedAt).toBeNull();
  });

  it('dates commitment from the audit where a candidate became committed', () => {
    const entry = deriveTimeline(
      subject('s-ready', 4),
      [audit(1, null, 's-ready', { afterCommitment: 'CANDIDATE' }), audit(4, 's-ready', 's-ready')],
      states,
    );
    expect(entry.committedAt).toEqual(day(4));
  });

  it('invents no dates for work with no audit trail', () => {
    const entry = deriveTimeline(subject('s-done', 20), [], states);
    expect(entry).toMatchObject({ history: 'NONE', startedAt: null, completedAt: null, committedAt: null, transitions: [] });
  });

  it('marks history partial when auditing began after creation, without dating the earlier state', () => {
    const entry = deriveTimeline(subject('s-review', 7), [audit(7, 's-progress', 's-review', { isCreation: false })], states);
    expect(entry.history).toBe('PARTIAL');
    expect(entry.transitions).toEqual([{ at: day(7), stateId: 's-review', stateName: 'In Review', stateType: 'REVIEW' }]);
    expect(entry.startedAt).toEqual(day(7));
    expect(entry.committedAt).toEqual(day(7));
  });

  it('appends a move the trail missed at the last write and marks it partial', () => {
    const entry = deriveTimeline(subject('s-done', 15), [audit(1, null, 's-ready'), audit(3, 's-ready', 's-progress')], states);
    expect(entry.history).toBe('PARTIAL');
    expect(entry.completedAt).toEqual(day(15));
  });
});
