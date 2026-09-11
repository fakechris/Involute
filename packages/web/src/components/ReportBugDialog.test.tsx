import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ReportBugDialog } from './ReportBugDialog';

const mockRunBugReport = vi.fn();
const mockRunFileUpload = vi.fn();

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  vi.clearAllMocks();
  mockRunBugReport.mockResolvedValue({
    data: {
      bugReport: {
        success: true,
        issue: {
          id: 'issue-b1',
          identifier: 'INV-42',
          title: 'Crash on drag',
          priority: 1,
          repository: 'fakechris/Involute',
        },
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
}));

const defaultProps = {
  isOpen: true,
  teamId: 'team-1',
  projects: [
    { repository: 'fakechris/Involute', name: 'Involute', identifier: 'INV-2', totalCount: 10 },
  ],
  labels: [
    { id: 'label-bug', name: 'bug' },
    { id: 'label-ui', name: 'ui' },
  ],
  onClose: vi.fn(),
};

function renderDialog(props: Partial<typeof defaultProps> = {}) {
  return render(
    <MemoryRouter>
      <ReportBugDialog {...defaultProps} {...props} />
    </MemoryRouter>,
  );
}

describe('ReportBugDialog', () => {
  it('submits a bug report with title, priority, project, and labels', async () => {
    renderDialog();

    fireEvent.change(screen.getByLabelText('Bug title'), { target: { value: 'Crash on drag' } });
    fireEvent.change(screen.getByLabelText('Bug priority'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('Bug project'), { target: { value: 'fakechris/Involute' } });
    fireEvent.click(screen.getByLabelText('ui'));

    fireEvent.click(screen.getByRole('button', { name: 'Report bug' }));

    await waitFor(() => {
      expect(mockRunBugReport).toHaveBeenCalledWith({
        variables: {
          input: {
            teamId: 'team-1',
            title: 'Crash on drag',
            description: null,
            priority: 1,
            repository: 'fakechris/Involute',
            labelIds: ['label-ui'],
          },
        },
      });
    });

    expect(await screen.findByText('INV-42')).toBeInTheDocument();
    const openLink = screen.getByRole('link', { name: 'Open on board' });
    expect(openLink).toHaveAttribute('href', '/?issue=INV-42');
  });

  it('excludes the bug label from the type label checkboxes', () => {
    renderDialog();

    expect(screen.queryByLabelText('bug')).not.toBeInTheDocument();
    expect(screen.getByLabelText('ui')).toBeInTheDocument();
  });

  it('shows an error when the mutation does not succeed', async () => {
    mockRunBugReport.mockResolvedValueOnce({
      data: { bugReport: { success: false, issue: null } },
    });
    renderDialog();

    fireEvent.change(screen.getByLabelText('Bug title'), { target: { value: 'Broken upload' } });
    fireEvent.click(screen.getByRole('button', { name: 'Report bug' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not report the bug');
  });

  it('renders nothing when closed', () => {
    renderDialog({ isOpen: false });

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
