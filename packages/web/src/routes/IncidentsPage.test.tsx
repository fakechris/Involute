import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useQuery } from '@apollo/client/react';

import { IncidentsPage } from './IncidentsPage';
import { IncidentTimesPanel } from '../components/IncidentTimesPanel';
import { expectRowOpensDrawer, renderWithDrawerHost } from '../test/drawer-host-harness';

vi.mock('../components/RouteIssueDrawer', () => import('../test/route-issue-drawer-stub'));

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
  byProject: [
    { project: { id: 'p1', identifier: 'INV-10', title: 'Incident E2E' }, openCount: 0, resolvedCount: 2 },
    { project: { id: 'p2', identifier: 'INV-11', title: 'Other project' }, openCount: 1, resolvedCount: 0 },
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
  it.each([[0, '0m'], [29, '0m'], [30, '1m'], [59, '1m'], [60, '1m'], [61, '1m'], [90, '2m']])('rounds %i seconds consistently with incident detail', (seconds, expected) => {
    const start = '2026-10-01T00:00:00.000Z';
    const end = new Date(Date.parse(start) + Number(seconds) * 1000).toISOString();
    serve({ incidentSummary: {
      ...summary,
      mttrHours: Number(seconds) / 3600, mttrSampleCount: 1,
      mttmHours: Number(seconds) / 3600, mttmSampleCount: 1,
      incidents: [{ ...summary.incidents[2], impactStartedAt: start, resolvedAt: end, impactHours: Number(seconds) / 3600 }],
    } });
    render(<MemoryRouter><IncidentsPage /><IncidentTimesPanel work={{ impactStartedAt: start, detectedAt: start, mitigatedAt: end, resolvedAt: end }} onUpdate={vi.fn()} /></MemoryRouter>);
    expect(screen.getByText(`Impact ${expected} · mitigated after ${expected}`)).toBeInTheDocument();
    expect(within(screen.getByTestId('incident-INV-1')).getByText(String(expected))).toBeInTheDocument();
    expect(within(screen.getByLabelText('Incident statistics')).getAllByText(`${expected} (n=1)`)).toHaveLength(2);
  });

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
    expect(within(screen.getByLabelText('Incidents by project')).getByText('Incident E2E').closest('tr')).toHaveTextContent('Incident E2E02');
    expect(within(screen.getByLabelText('Incidents by project')).getByText('Other project').closest('tr')).toHaveTextContent('Other project10');

    expect(screen.getByTestId('incident-INV-3')).toHaveTextContent('Ongoing · 5h 30m');
    expect(screen.getByTestId('incident-INV-3')).toHaveTextContent('Not required');
    expect(screen.getByTestId('incident-INV-2')).toHaveTextContent('Missing');
    expect(screen.getByTestId('incident-INV-1')).toHaveTextContent('File attached');
    expect(screen.getByTestId('incident-INV-1')).toHaveTextContent('1 of 2 done · 1 overdue');
    expect(screen.getByText('2 declined or duplicate incidents are not counted.')).toBeInTheDocument();

    // The row opens the drawer in place (INV-1387); its href is still the issue page.
    const link = within(screen.getByTestId('incident-INV-1')).getByRole('link', { name: /INV-1/ });
    expect(link).toHaveAttribute('href', '/issue/INV-1');
    fireEvent.click(link);
    expect(screen.queryByTestId('where')).toBeNull();
    expect(screen.getByTestId('incident-INV-1')).toBeInTheDocument();
  });

  it('opens an incident in the drawer and Esc closes it, keeping the filters (INV-1387)', async () => {
    serve({ incidentSummary: summary });
    const url = '/incidents?project=acme/incidents&q=board';
    renderWithDrawerHost(<IncidentsPage />, url);
    await expectRowOpensDrawer(within(screen.getByTestId('incident-INV-1')).getByRole('link', { name: /INV-1/ }), 'INV-1', url);
  });

  it('narrows the incident list by project and text from the URL (INV-1314)', () => {
    serve({ incidentSummary: summary });
    render(
      <MemoryRouter initialEntries={['/incidents?project=acme/incidents&q=board']}>
        <IncidentsPage />
      </MemoryRouter>,
    );
    expect(screen.getByRole('button', { name: 'Project: acme/incidents' })).toBeInTheDocument();
    expect(screen.getByTestId('incident-INV-1')).toBeInTheDocument();
    expect(screen.queryByTestId('incident-INV-2')).toBeNull();
    expect(screen.queryByTestId('incident-INV-3')).toBeNull();
  });

  it('offers no priority or owner filter: incident rows carry neither (INV-1385)', () => {
    serve({ incidentSummary: summary });
    render(
      <MemoryRouter initialEntries={['/incidents']}>
        <IncidentsPage />
      </MemoryRouter>,
    );
    const filters = screen.getByRole('group', { name: 'Filters' });
    expect(within(filters).queryByRole('combobox', { name: 'Filter by priority' })).toBeNull();
    expect(within(filters).queryByRole('combobox', { name: 'Filter by owner' })).toBeNull();
    expect(within(filters).getByRole('searchbox', { name: 'Filter by text' })).toBeInTheDocument();
  });

  it('counts resolved incidents in the header and names repository-less projects', () => {
    serve({ incidentSummary: {
      ...summary,
      openCount: 0,
      resolvedCount: 1,
      byRepository: [{ repository: null, openCount: 0, resolvedCount: 1 }],
      byProject: [{ project: { id: 'p1', identifier: 'INV-10', title: 'Incident E2E' }, openCount: 0, resolvedCount: 1 }],
      incidents: [{ ...summary.incidents[2], repository: null }],
    } });
    const { container } = render(<MemoryRouter><IncidentsPage /></MemoryRouter>);
    expect(container.querySelector('.page-header__count')).toHaveTextContent('1');
    expect(screen.getByLabelText('Incident statistics')).toHaveTextContent('0Ongoing1Resolved');
    const breakdown = screen.getByLabelText('Incidents by project');
    expect(within(breakdown).getByText('Incident E2E')).toBeInTheDocument();
    expect(within(breakdown).queryByText('No project')).not.toBeInTheDocument();
  });

  it('shows No project only for a group without a PROJECT ancestor', () => {
    serve({ incidentSummary: { ...summary, byProject: [{ project: null, openCount: 1, resolvedCount: 2 }] } });
    render(<MemoryRouter><IncidentsPage /></MemoryRouter>);
    expect(within(screen.getByLabelText('Incidents by project')).getByText('No project')).toBeInTheDocument();
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
        byProject: [],
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
