import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useQuery } from '@apollo/client/react';

import { IncidentsPage } from './IncidentsPage';

const summary = {
  openCount: 1,
  resolvedCount: 2,
  excludedCount: 2,
  mttrHours: 3,
  mttrSampleCount: 2,
  mttmHours: 1.5,
  mttmSampleCount: 2,
  bySeverity: [
    { severity: 'SEV1', openCount: 0, resolvedCount: 1 },
    { severity: 'SEV2', openCount: 0, resolvedCount: 1 },
    { severity: 'SEV3', openCount: 1, resolvedCount: 0 },
  ],
  byRepository: [
    { repository: 'acme/incidents', openCount: 0, resolvedCount: 2 },
    { repository: 'acme/other', openCount: 1, resolvedCount: 0 },
  ],
  followUps: { total: 3, completed: 1, declined: 1, overdue: 1, overdueOpen: 1, completionRate: 0.5 },
  incidents: [
    { id: 'c', identifier: 'INV-3', title: 'Sync stalled', severity: 'SEV3', repository: 'acme/other', stateName: 'In Progress', impactStartedAt: '2026-10-01T20:00:00.000Z', resolvedAt: null, impactHours: 5.5, ongoing: true, postmortemRequired: false, postmortemAttached: false, followUpTotal: 0, followUpCompleted: 0, followUpDeclined: 0, followUpOverdueOpen: 0 },
    { id: 'b', identifier: 'INV-2', title: 'Search slow', severity: 'SEV2', repository: 'acme/incidents', stateName: 'In Review', impactStartedAt: '2026-10-01T10:00:00.000Z', resolvedAt: '2026-10-01T12:00:00.000Z', impactHours: 2, ongoing: false, postmortemRequired: true, postmortemAttached: false, followUpTotal: 0, followUpCompleted: 0, followUpDeclined: 0, followUpOverdueOpen: 0 },
    { id: 'a', identifier: 'INV-1', title: 'Board down', severity: 'SEV1', repository: 'acme/incidents', stateName: 'Done', impactStartedAt: '2026-10-01T00:00:00.000Z', resolvedAt: '2026-10-01T04:00:00.000Z', impactHours: 4, ongoing: false, postmortemRequired: true, postmortemAttached: true, followUpTotal: 3, followUpCompleted: 1, followUpDeclined: 1, followUpOverdueOpen: 1 },
  ],
};

vi.mock('@apollo/client/react', () => ({
  useQuery: vi.fn(),
}));

const mockedUseQuery = vi.mocked(useQuery);
function serve(data: unknown) {
  mockedUseQuery.mockReturnValue({ data, loading: false, error: undefined, refetch: vi.fn() } as never);
}

function Where() {
  return <pre data-testid="where">{useLocation().pathname}</pre>;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('IncidentsPage (INV-1129)', () => {
  it('shows counts, MTTR / MTTM with sample sizes, follow-up rates and the incident list', () => {
    serve({ incidentSummary: summary });
    render(
      <MemoryRouter initialEntries={['/incidents']}>
        <Routes>
          <Route path="/incidents" element={<IncidentsPage />} />
          <Route path="/issue/:id" element={<Where />} />
        </Routes>
      </MemoryRouter>,
    );
    const stats = screen.getByLabelText('Incident statistics');
    expect(stats).toHaveTextContent('1Ongoing');
    expect(stats).toHaveTextContent('2Resolved');
    expect(stats).toHaveTextContent('1h 30m (n=2)MTTM');
    expect(stats).toHaveTextContent('3h 0m (n=2)MTTR');
    const followUps = screen.getByLabelText('Follow-ups');
    expect(followUps).toHaveTextContent('50%Follow-ups done (1 of 2)');
    expect(followUps).toHaveTextContent('1Overdue, still open');

    expect(within(screen.getByLabelText('Incidents by severity')).getByText('SEV3 Minor').closest('tr')).toHaveTextContent('SEV3 Minor10');
    expect(within(screen.getByLabelText('Incidents by project')).getByText('acme/other').closest('tr')).toHaveTextContent('acme/other10');

    expect(screen.getByTestId('incident-INV-3')).toHaveTextContent('Ongoing · 5h 30m');
    expect(screen.getByTestId('incident-INV-3')).toHaveTextContent('Not required');
    expect(screen.getByTestId('incident-INV-2')).toHaveTextContent('Missing');
    expect(screen.getByTestId('incident-INV-1')).toHaveTextContent('Attached');
    expect(screen.getByTestId('incident-INV-1')).toHaveTextContent('1 of 2 done · 1 overdue');
    expect(screen.getByText('2 declined or duplicate incidents are not counted.')).toBeInTheDocument();

    fireEvent.click(within(screen.getByTestId('incident-INV-1')).getByRole('button'));
    expect(screen.getByTestId('where')).toHaveTextContent('/issue/INV-1');
  });

  it('shows an empty state with no incidents', () => {
    serve({
      incidentSummary: {
        ...summary,
        openCount: 0,
        resolvedCount: 0,
        excludedCount: 0,
        mttrHours: null,
        mttrSampleCount: 0,
        mttmHours: null,
        mttmSampleCount: 0,
        bySeverity: [],
        byRepository: [],
        followUps: { total: 0, completed: 0, declined: 0, overdue: 0, overdueOpen: 0, completionRate: null },
        incidents: [],
      },
    });
    render(
      <MemoryRouter>
        <IncidentsPage />
      </MemoryRouter>,
    );
    expect(screen.getByText('No incidents')).toBeInTheDocument();
    expect(screen.queryByLabelText('Incident statistics')).toBeNull();
  });
});
