import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useQuery } from '@apollo/client/react';

import { MyIssuesPage } from './MyIssuesPage';

vi.mock('@apollo/client/react', () => ({ useQuery: vi.fn() }));

const me = { id: 'u1', name: 'Me', email: 'me@test' };
function issue(id: string, title: string, repository: string | null, priority: number, type: string) {
  return {
    id,
    identifier: id,
    title,
    repository,
    priority,
    revision: 1,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    state: { id: `s-${type}`, name: type, type, position: 1 },
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
    expect(screen.getByRole('button', { name: 'Open issue INV-1' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open issue INV-2' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open issue INV-3' })).toBeNull();
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
  });
});
