import { MockedProvider } from '@apollo/client/testing/react';
import type { MockedResponse } from '@apollo/client/testing';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';

import { BOARD_PAGE_QUERY, NOTIFICATIONS_PAGE_QUERY, PROJECT_ISSUES_QUERY } from '../board/queries';
import { InboxPage } from './InboxPage';
import { MyIssuesPage } from './MyIssuesPage';
import { ProjectsPage } from './ProjectsPage';

const emptyIssuePage = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
const board = {
  projectSummary: { totalCount: 0, noRepositoryCount: 0, projects: [], projectsWithoutRepository: [] },
  teams: { nodes: [] },
  users: { nodes: [] },
  issueLabels: { nodes: [] },
  issueStateCounts: [],
  issues: emptyIssuePage,
};
const team = {
  id: 'team-inv', key: 'INV', name: 'Involute', viewerCanWrite: false, viewerCanManage: false,
  issueCount: 0, memberships: { nodes: [] }, states: { nodes: [] },
};
const projectsRequest = { query: PROJECT_ISSUES_QUERY, variables: { teamKey: 'INV' } };
const teamsRequest = { query: BOARD_PAGE_QUERY, variables: { first: 1 } };
const outage = new Error('Failed to fetch');

function renderPage(page: ReactNode, mocks: ReadonlyArray<MockedResponse>) {
  return render(<MockedProvider mocks={mocks}><MemoryRouter>{page}</MemoryRouter></MockedProvider>);
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe('retryable list load errors', () => {
  it('does not mistake a failed My Issues request for an empty list', async () => {
    const request = {
      query: BOARD_PAGE_QUERY,
      variables: { first: 500, withDescriptions: true, filter: { assignee: { isMe: { eq: true } } } },
    };
    renderPage(<MyIssuesPage />, [{ request, error: outage }, { request, result: { data: board } }]);

    expect(await screen.findByRole('heading', { name: 'Could not load your issues' })).toBeVisible();
    expect(screen.queryByText('No issues assigned to you')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { name: 'No issues assigned to you' })).toBeVisible();
  });

  it('retries the Projects team lookup before loading the project list', async () => {
    const project = {
      id: 'project-1', identifier: 'INV-1', title: 'Workspace tools', description: null, priority: 0,
      severity: null, kind: 'PROJECT', repository: 'acme/tools', alias: null, autoAcceptBugs: false,
      webOrigins: [], autonomy: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
      state: { id: 'state-1', name: 'Ready', type: 'UNSTARTED', position: 1 },
      assignee: null, team: { id: team.id, key: team.key, name: team.name }, children: { nodes: [] },
    };
    renderPage(<ProjectsPage />, [
      { request: teamsRequest, error: outage },
      { request: teamsRequest, result: { data: { ...board, teams: { nodes: [team] } } } },
      { request: projectsRequest, result: { data: { issues: { nodes: [project] } } } },
    ]);

    expect(screen.getByText('Loading projects…')).toBeVisible();
    expect(await screen.findByRole('heading', { name: 'Could not load projects' })).toBeVisible();
    expect(screen.queryByText(/ask a team owner/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('button', { name: /Workspace tools/ })).toBeVisible();
  });

  it('retries a failed projects query and preserves the true empty state', async () => {
    renderPage(<ProjectsPage />, [
      { request: teamsRequest, result: { data: { ...board, teams: { nodes: [team] } } } },
      { request: projectsRequest, error: outage },
      { request: projectsRequest, result: { data: { issues: { nodes: [] } } } },
    ]);

    expect(await screen.findByRole('heading', { name: 'Could not load projects' })).toBeVisible();
    expect(screen.queryByText('No projects yet')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { name: 'No projects yet' })).toBeVisible();
  });

  it('retries Activity without losing the unread filter', async () => {
    const unread = { query: NOTIFICATIONS_PAGE_QUERY, variables: { first: 50, unreadOnly: true } };
    renderPage(<InboxPage />, [
      { request: { query: NOTIFICATIONS_PAGE_QUERY, variables: { first: 50 } }, error: outage },
      { request: unread, error: outage },
      {
        request: unread,
        result: { data: {
          unreadNotificationCount: 1,
          notifications: { nodes: [{
            id: 'notification-1', type: 'run.completed', payload: { summary: 'New run completed' },
            readAt: null, createdAt: '2026-01-01T00:00:00Z', actionable: false,
            resolvedAt: null, resolution: null, resolvedBy: null, work: null,
          }] },
        } },
      },
    ]);

    expect(await screen.findByRole('heading', { name: 'Could not load activity' })).toBeVisible();
    fireEvent.click(screen.getByRole('tab', { name: 'unread' }));
    expect(await screen.findByRole('heading', { name: 'Could not load activity' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('New run completed')).toBeVisible();
    expect(screen.getByRole('tab', { name: 'unread' })).toHaveAttribute('aria-selected', 'true');
  });
});
