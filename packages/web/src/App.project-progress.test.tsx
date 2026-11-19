import { fireEvent, screen } from '@testing-library/react';
import { print } from 'graphql';
import { describe, expect, it } from 'vitest';

import { PROJECT_ISSUES_QUERY } from './board/queries';
import { boardQueryResult, getIssue, renderApp } from './test/app-test-helpers';

const project = {
  ...getIssue('issue-1'),
  id: 'proj-1',
  identifier: 'INV-96',
  kind: 'PROJECT' as const,
  title: 'Project progress',
  children: { nodes: [] },
};

describe('project committed-work progress', () => {
  it('requests only committed children from the server', () => {
    expect(print(PROJECT_ISSUES_QUERY)).toContain('children(commitmentStatus: COMMITTED)');
  });

  it('counts and renders the returned children on the overview and detail', async () => {
    const ready = { ...getIssue('issue-1'), title: 'Committed ready child' };
    const done = {
      ...getIssue('issue-2'), title: 'Committed done child',
      state: { ...getIssue('issue-2').state!, name: 'Done', type: 'COMPLETED' as const },
    };
    const data = { ...boardQueryResult, issues: { ...boardQueryResult.issues, nodes: [
      { ...project, children: { nodes: [ready, done] } },
    ] } };
    renderApp({ data, loading: false }, ['/projects']);
    expect(await screen.findByText('50% complete')).toBeInTheDocument();
    expect(screen.getByText('1/2 issues')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Project progress'));
    expect(await screen.findByText('2 child issues (CONTAINS)')).toBeInTheDocument();
    expect(screen.getByText('Committed ready child')).toBeInTheDocument();
    expect(screen.getByText('Committed done child')).toBeInTheDocument();
    expect(screen.getByText('50% complete')).toBeInTheDocument();
    expect(screen.getByText('1/2 issues')).toBeInTheDocument();
  });

  it('shows an empty detail without progress when no committed children are returned', async () => {
    const data = { ...boardQueryResult, issues: { ...boardQueryResult.issues, nodes: [project] } };
    renderApp({ data, loading: false }, ['/projects']);
    fireEvent.click(await screen.findByText('Project progress'));
    expect(await screen.findByText('0 child issues (CONTAINS)')).toBeInTheDocument();
    expect(screen.getByText(/No child issues linked/)).toBeInTheDocument();
    expect(screen.queryByText(/% complete/)).not.toBeInTheDocument();
  });

  it('shows the query error instead of project progress', async () => {
    renderApp({ error: new Error('Project query failed'), loading: false }, ['/projects']);
    expect(await screen.findByRole('alert')).toHaveTextContent('Project query failed');
    expect(screen.queryByText(/% complete/)).not.toBeInTheDocument();
  });
});
