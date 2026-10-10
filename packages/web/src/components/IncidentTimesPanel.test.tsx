import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { formatImpactDuration, impactSummary, IncidentTimesPanel } from './IncidentTimesPanel';

afterEach(() => cleanup());

// INV-1125: the issue page shows an incident's impact timestamps and how long the impact lasted.
describe('IncidentTimesPanel (INV-1125)', () => {
  it('formats impact durations', () => {
    expect(formatImpactDuration(45 * 60_000)).toBe('45m');
    expect(formatImpactDuration(185 * 60_000)).toBe('3h 5m');
    expect(formatImpactDuration((2 * 24 + 4) * 60 * 60_000)).toBe('2d 4h');
  });

  it('measures from impact start, counting a missing mitigation as the resolution', () => {
    const base = { impactStartedAt: '2026-10-09T08:00:00.000Z', detectedAt: '2026-10-09T09:00:00.000Z' };
    expect(impactSummary({ ...base, resolvedAt: '2026-10-09T11:00:00.000Z' })).toBe('Impact 3h 0m');
    expect(impactSummary({ ...base, mitigatedAt: '2026-10-09T09:30:00.000Z', resolvedAt: '2026-10-09T11:00:00.000Z' })).toBe('Impact 3h 0m · mitigated after 1h 30m');
    expect(impactSummary(base, new Date('2026-10-09T08:20:00.000Z'))).toBe('Impact ongoing for 20m');
  });

  it('shows the four timestamps and saves a change as an ISO time, clearing only mitigated and resolved', () => {
    const onUpdate = vi.fn();
    render(
      <IncidentTimesPanel
        work={{ impactStartedAt: '2026-10-09T08:00:00.000Z', detectedAt: '2026-10-09T09:00:00.000Z', mitigatedAt: '2026-10-09T09:30:00.000Z', resolvedAt: null }}
        onUpdate={onUpdate}
        now={new Date('2026-10-09T10:00:00.000Z')}
      />,
    );
    expect(screen.getByText('Mitigated after 1h 30m · not resolved yet')).toBeTruthy();
    for (const label of ['Impact started', 'Detected', 'Mitigated', 'Resolved']) expect(screen.getByLabelText(label)).toBeTruthy();
    expect((screen.getByLabelText('Resolved') as HTMLInputElement).value).toBe('');

    fireEvent.change(screen.getByLabelText('Resolved'), { target: { value: '2026-10-09T12:15' } });
    expect(onUpdate).toHaveBeenLastCalledWith({ resolvedAt: new Date('2026-10-09T12:15').toISOString() });

    fireEvent.change(screen.getByLabelText('Mitigated'), { target: { value: '' } });
    expect(onUpdate).toHaveBeenLastCalledWith({ mitigatedAt: null });

    onUpdate.mockClear();
    fireEvent.change(screen.getByLabelText('Detected'), { target: { value: '' } });
    expect(onUpdate).not.toHaveBeenCalled();
  });
});
