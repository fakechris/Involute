import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ReportIncidentDialog } from './ReportIncidentDialog';

const mockRunDeclare = vi.fn();

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  mockRunDeclare.mockResolvedValue({
    data: {
      workPropose: {
        success: true,
        message: null,
        issue: { id: 'issue-i1', identifier: 'INV-77', title: 'Board is blank', severity: 'SEV1', repository: 'fakechris/Involute', commitmentStatus: 'COMMITTED' },
      },
    },
  });
});

vi.mock('@apollo/client/react', () => ({
  useMutation: vi.fn(() => [mockRunDeclare, { loading: false }]),
  useQuery: vi.fn((document, options?: { skip?: boolean }) => {
    const docStr = JSON.stringify(document);
    if (options?.skip) return { data: undefined, loading: false };
    if (docStr.includes('PlacementOptions')) {
      return {
        data: {
          projects: { nodes: [{ id: 'project-2', identifier: 'INV-2', title: 'fakechris/Involute', kind: 'PROJECT' }] },
          milestones: { nodes: [{ id: 'milestone-5', identifier: 'INV-5', title: 'M1', kind: 'MILESTONE', state: { type: 'STARTED' } }] },
          epics: { nodes: [] },
        },
        loading: false,
      };
    }
    return { data: undefined, loading: false };
  }),
}));

const defaultProps = {
  isOpen: true,
  teamId: 'team-1',
  teamKey: 'INV',
  projects: [{ repository: 'fakechris/Involute', name: 'Involute', identifier: 'INV-2', totalCount: 10 }],
  labels: [
    { id: 'label-bug', name: 'bug' },
    { id: 'label-incident', name: 'Incident' },
    { id: 'label-ops', name: 'ops' },
  ],
  boardRepository: null as string | null,
  onClose: vi.fn(),
};

function renderDialog(props: Partial<typeof defaultProps> = {}) {
  return render(
    <MemoryRouter>
      <ReportIncidentDialog {...defaultProps} {...props} />
    </MemoryRouter>,
  );
}

describe('ReportIncidentDialog (INV-1123)', () => {
  it('declares an incident where it belongs, with a required severity and impact', async () => {
    renderDialog();
    const submit = screen.getByRole('button', { name: 'Report incident' });
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Incident title'), { target: { value: 'Board is blank' } });
    fireEvent.change(screen.getByLabelText('Incident impact'), { target: { value: 'Nobody can open the board.' } });
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'fakechris/Involute' } });
    fireEvent.change(screen.getByLabelText('Location'), { target: { value: 'milestone-5' } });
    expect(submit).toBeDisabled(); // no severity yet
    fireEvent.change(screen.getByLabelText('Incident severity'), { target: { value: 'SEV1' } });
    fireEvent.click(screen.getByLabelText('ops'));
    fireEvent.click(submit);

    await waitFor(() =>
      expect(mockRunDeclare).toHaveBeenCalledWith({
        variables: {
          input: {
            teamId: 'team-1',
            title: 'Board is blank',
            description: 'Nobody can open the board.',
            severity: 'SEV1',
            parentId: 'milestone-5',
            labels: ['incident', 'ops'],
            source: 'incident-report',
          },
        },
      }),
    );
    expect(await screen.findByRole('status')).toHaveTextContent('INV-77 declared and in progress');
    expect(screen.getByRole('link', { name: 'Open on board' })).toHaveAttribute('href', '/?issue=INV-77');
  });

  it('offers no Type labels and no triage: an incident is Type: Incident and placed', () => {
    renderDialog();
    expect(screen.queryByLabelText('bug')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Incident')).not.toBeInTheDocument();
    expect(screen.getByLabelText('ops')).toBeInTheDocument();
    expect(screen.queryByText(/send to triage/)).not.toBeInTheDocument();
  });

  it('shows why the server refused the declaration', async () => {
    mockRunDeclare.mockResolvedValueOnce({
      data: { workPropose: { success: false, message: 'An incident needs a severity.', issue: null } },
    });
    renderDialog({ boardRepository: 'fakechris/Involute' });
    fireEvent.change(screen.getByLabelText('Incident title'), { target: { value: 'Board is blank' } });
    fireEvent.change(screen.getByLabelText('Incident impact'), { target: { value: 'Nobody can open the board.' } });
    fireEvent.change(screen.getByLabelText('Incident severity'), { target: { value: 'SEV2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Report incident' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('An incident needs a severity.');
  });

  it('renders nothing when closed', () => {
    renderDialog({ isOpen: false });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
