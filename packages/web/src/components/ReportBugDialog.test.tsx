import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ReportBugDialog } from './ReportBugDialog';

const mockRunBugReport = vi.fn();
const mockRunFileUpload = vi.fn();
const similarBugs = vi.fn();

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  similarBugs.mockReturnValue([]);
  mockRunBugReport.mockResolvedValue({
    data: {
      bugReport: {
        success: true,
        message: null,
        issue: { id: 'issue-b1', identifier: 'INV-42', title: 'Crash on drag', priority: 1, repository: 'fakechris/Involute' },
      },
    },
  });
});

vi.mock('@apollo/client/react', () => ({
  useMutation: vi.fn((document) => {
    const docStr = JSON.stringify(document);
    if (docStr.includes('BugReport')) {
      return [mockRunBugReport, { loading: false }];
    }
    return [mockRunFileUpload, { loading: false }];
  }),
  useQuery: vi.fn((document, options?: { skip?: boolean; variables?: { title?: string } }) => {
    const docStr = JSON.stringify(document);
    if (options?.skip) return { data: undefined, loading: false };
    if (docStr.includes('SimilarBugs')) {
      return { data: { similarBugs: similarBugs(options?.variables?.title) }, loading: false };
    }
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
    { id: 'label-feature', name: 'Feature' },
    { id: 'label-ui', name: 'ui' },
  ],
  boardRepository: null as string | null,
  onClose: vi.fn(),
};

function renderDialog(props: Partial<typeof defaultProps> = {}) {
  return render(
    <MemoryRouter>
      <ReportBugDialog {...defaultProps} {...props} />
    </MemoryRouter>,
  );
}

function fillRequired() {
  fireEvent.change(screen.getByLabelText('Bug title'), { target: { value: 'Crash on drag' } });
  fireEvent.change(screen.getByLabelText('Steps to reproduce'), { target: { value: '1. Drag a card' } });
  fireEvent.change(screen.getByLabelText('Bug priority'), { target: { value: '1' } });
}

describe('ReportBugDialog (INV-749)', () => {
  it('reports a bug where it belongs, with priority, steps and extra labels', async () => {
    renderDialog();
    const submit = screen.getByRole('button', { name: 'Report bug' });
    expect(submit).toBeDisabled();

    fillRequired();
    expect(submit).toBeDisabled(); // not placed yet
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'fakechris/Involute' } });
    fireEvent.change(screen.getByLabelText('Location'), { target: { value: 'milestone-5' } });
    fireEvent.click(screen.getByLabelText('ui'));
    fireEvent.click(submit);

    await waitFor(() =>
      expect(mockRunBugReport).toHaveBeenCalledWith({
        variables: {
          input: {
            teamId: 'team-1',
            title: 'Crash on drag',
            description: null,
            stepsToReproduce: '1. Drag a card',
            priority: 1,
            parentId: 'milestone-5',
            labelIds: ['label-ui'],
          },
        },
      }),
    );
    expect(await screen.findByRole('status')).toHaveTextContent('INV-42 reported');
    expect(screen.getByRole('link', { name: 'Open on board' })).toHaveAttribute('href', '/?issue=INV-42');
    expect(JSON.parse(window.localStorage.getItem('involute.createPlacement.INV') ?? 'null')).toEqual({
      repository: 'fakechris/Involute',
      parentId: 'milestone-5',
    });
  });

  it('sends a bug to triage when the reporter is not sure where it belongs', async () => {
    mockRunBugReport.mockResolvedValueOnce({
      data: { bugReport: { success: true, message: null, issue: { id: 'issue-b2', identifier: 'INV-43', title: 'x', priority: 2, repository: null } } },
    });
    renderDialog();
    fillRequired();
    fireEvent.click(screen.getByLabelText('Not sure where it belongs — send to triage'));
    expect(screen.queryByLabelText('Project')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Report bug' }));

    await waitFor(() => expect(mockRunBugReport).toHaveBeenCalledTimes(1));
    expect(mockRunBugReport.mock.calls[0]![0].variables.input).not.toHaveProperty('parentId');
    expect(await screen.findByRole('status')).toHaveTextContent('INV-43 sent to triage');
    expect(screen.getByRole('link', { name: 'Open triage' })).toHaveAttribute('href', '/candidates');
  });

  it('starts in the project the board is filtered to', () => {
    renderDialog({ boardRepository: 'fakechris/Involute' });
    expect(screen.getByLabelText('Project')).toHaveValue('fakechris/Involute');
    expect(screen.getByLabelText('Location')).toHaveValue('INV-2');
  });

  it('offers no Type labels: a bug is Type: Bug', () => {
    renderDialog();
    expect(screen.queryByLabelText('bug')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Feature')).not.toBeInTheDocument();
    expect(screen.getByLabelText('ui')).toBeInTheDocument();
  });

  it('shows open bugs with similar titles while typing', async () => {
    similarBugs.mockImplementation((title?: string) =>
      title === 'Crash on drag' ? [{ id: 'bug-9', identifier: 'INV-9', title: 'Drag crashes the board', state: { id: 's', name: 'In Progress' } }] : [],
    );
    renderDialog();
    fireEvent.change(screen.getByLabelText('Bug title'), { target: { value: 'Crash on drag' } });
    const region = await screen.findByRole('region', { name: 'Similar open bugs' });
    expect(within(region).getByRole('link', { name: /INV-9 Drag crashes the board/ })).toHaveAttribute('href', '/issue/bug-9');
  });

  it('shows why the server refused the report', async () => {
    mockRunBugReport.mockResolvedValueOnce({
      data: { bugReport: { success: false, message: 'A bug report needs steps to reproduce.', issue: null } },
    });
    renderDialog({ boardRepository: 'fakechris/Involute' });
    fillRequired();
    fireEvent.click(screen.getByRole('button', { name: 'Report bug' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('A bug report needs steps to reproduce.');
  });

  it('renders nothing when closed', () => {
    renderDialog({ isOpen: false });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
