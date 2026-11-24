import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useQuery } from '@apollo/client/react';

import { MyIssuesPage } from './MyIssuesPage';
import { expectRowOpensDrawer, renderWithDrawerHost } from '../test/drawer-host-harness';

vi.mock('../components/RouteIssueDrawer', () => import('../test/route-issue-drawer-stub'));

vi.mock('@apollo/client/react', () => ({ useQuery: vi.fn() }));

const me = { id: 'u1', name: 'Me', email: 'me@test' };
function issue(id: string, title: string, repository: string | null, priority: number, type: string, name = type) {
  return {
    id,
    identifier: id,
    title,
    repository,
    priority,
    revision: 1,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    state: { id: `s-${type}`, name, type, position: 1 },
    team: { id: 't', key: 'INV' },
    labels: { nodes: [] },
    assignee: me,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('MyIssuesPage (INV-1314)', () => {
  it('filters by project, work filters and state from the page toolbar', () => {
    vi.mocked(useQuery).mockReturnValue({
      data: {
        issues: {
          nodes: [
            issue('INV-1', 'Fix login', 'acme/web', 1, 'STARTED'),
            issue('INV-2', 'Tune queries', 'acme/api', 1, 'STARTED'),
            issue('INV-3', 'Polish header', 'acme/web', 3, 'UNSTARTED'),
          ],
        },
      },
      loading: false,
    } as never);
    render(
      <MemoryRouter initialEntries={['/my-issues?project=acme/web&priority=1']}>
        <MyIssuesPage />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'My Issues' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Project: acme/web' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open issue INV-1' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open issue INV-2' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Open issue INV-3' })).toBeNull();
    expect(screen.getByLabelText('Filter by state')).toHaveValue('');
  });

  it('says when nothing is assigned', () => {
    vi.mocked(useQuery).mockReturnValue({ data: { issues: { nodes: [] } }, loading: false } as never);
    render(
      <MemoryRouter>
        <MyIssuesPage />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { name: 'No issues assigned to you' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clear all filters' })).not.toBeInTheDocument();
  });

  it('groups review work separately from Todo and filters by In Review (INV-2120)', () => {
    vi.mocked(useQuery).mockReturnValue({
      data: { issues: { nodes: [
        issue('INV-1', 'Fix login', 'acme/web', 1, 'UNSTARTED', 'Ready'),
        issue('INV-2', 'Tune queries', 'acme/api', 1, 'REVIEW', 'In Review'),
      ] } },
      loading: false,
    } as never);
    render(<MemoryRouter><MyIssuesPage /></MemoryRouter>);
    const review = screen.getByRole('list', { name: 'In Review' });
    const todo = screen.getByRole('list', { name: 'Todo' });
    expect(within(review).getByRole('link', { name: 'Open issue INV-2' })).toBeInTheDocument();
    expect(within(review).getByText('In Review')).toBeInTheDocument();
    expect(within(todo).getByRole('link', { name: 'Open issue INV-1' })).toBeInTheDocument();
    expect(within(todo).getByText('Ready')).toBeInTheDocument();
    expect(within(todo).queryByRole('link', { name: 'Open issue INV-2' })).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole('combobox', { name: 'Filter by state' }), { target: { value: 'REVIEW' } });
    expect(screen.queryByRole('list', { name: 'Todo' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open issue INV-2' })).toBeInTheDocument();
  });

  it('shows a no-match state and clears text, project, priority and workflow filters together (INV-2121)', () => {
    vi.mocked(useQuery).mockReturnValue({
      data: { issues: { nodes: [issue('INV-1', 'Fix login', 'acme/web', 1, 'STARTED')] } },
      loading: false,
    } as never);
    render(<MemoryRouter initialEntries={['/my-issues?project=acme/web&priority=1']}><MyIssuesPage /></MemoryRouter>);
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter by state' }), { target: { value: 'STARTED' } });
    expect(screen.getByRole('link', { name: 'Open issue INV-1' })).toBeInTheDocument();
    const search = screen.getByRole('searchbox', { name: 'Filter by text' });
    fireEvent.change(search, { target: { value: 'no-such-issue' } });
    fireEvent.keyDown(search, { key: 'Enter' });

    expect(screen.getByRole('heading', { name: 'No issues match your filters' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'No issues assigned to you' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear all filters' }));

    expect(screen.getByRole('link', { name: 'Open issue INV-1' })).toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: 'Filter by text' })).toHaveValue('');
    expect(screen.getByRole('combobox', { name: 'Filter by state' })).toHaveValue('');
    expect(screen.getByRole('combobox', { name: 'Filter by priority' })).toHaveValue('');
    expect(screen.queryByRole('button', { name: 'Project: acme/web' })).not.toBeInTheDocument();
  });

  it('opens a row in the drawer and Esc closes it, keeping the filters (INV-1387)', async () => {
    vi.mocked(useQuery).mockReturnValue({
      data: { issues: { nodes: [issue('INV-1', 'Fix login', 'acme/web', 1, 'STARTED')] } },
      loading: false,
    } as never);
    const url = '/my-issues?project=acme/web&priority=1';
    renderWithDrawerHost(<MyIssuesPage />, url);
    await expectRowOpensDrawer(screen.getByRole('link', { name: 'Open issue INV-1' }), 'INV-1', url);
  });
});
