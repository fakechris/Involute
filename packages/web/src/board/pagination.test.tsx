import type { SelectionSetNode } from 'graphql';
import { ApolloLink, Observable } from '@apollo/client';
import { ApolloProvider } from '@apollo/client/react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { expect, it, vi } from 'vitest';
import { apolloMocks, boardQueryResult } from '../test/app-test-helpers';
import { createApolloClient } from '../lib/apollo';
import { BoardPage } from '../routes/BoardPage';

function complete(data: any, selection: SelectionSetNode): any {
  if (data == null) return null;
  if (Array.isArray(data)) return data.map((item) => complete(item, selection));
  return Object.fromEntries(selection.selections.filter((field) => field.kind === 'Field').map((field) => {
    const key = field.name.value;
    const value = data[key] ?? null;
    return [key, field.selectionSet ? complete(value, field.selectionSet) : value];
  }));
}

it('keeps a later-page issue open after its detail query writes to the cache', async () => {
  const real = await vi.importActual<typeof import('@apollo/client/react')>('@apollo/client/react');
  apolloMocks.useQuery.mockImplementation(real.useQuery);
  apolloMocks.useMutation.mockImplementation(real.useMutation);
  localStorage.setItem("involute.activeTeamKey", "INV");
  const client = createApolloClient();
  const requests: string[] = [];
  const later = { ...boardQueryResult.issues.nodes[0]!, __typename: 'Issue', id: 'later', identifier: 'INV-671', title: 'Later page item' };
  client.setLink(new ApolloLink((operation) => new Observable((observer) => {
    requests.push(operation.operationName ?? '');
    let data: unknown;
    if (operation.operationName === 'BoardPage') {
      data = { ...boardQueryResult, projectSummary: { totalCount: 201, noRepositoryCount: 0, projects: [] }, issues: {
        nodes: operation.variables.after ? [later] : boardQueryResult.issues.nodes,
        pageInfo: { endCursor: operation.variables.after ? 'last' : 'first', hasNextPage: !operation.variables.after },
      } };
    } else if (operation.operationName === 'GraphProjects') {
      data = { projectSummary: { totalCount: 201, projects: [] } };
    } else if (operation.operationName === 'IssueContract') {
      data = { issue: { __typename: 'Issue', id: 'later', revision: 2, commitmentStatus: 'COMMITTED', outcome: null, scope: null, constraints: null, acceptance: null, verification: null, pendingContractAmendment: null } };
    } else {
      data = { issue: null };
    }
    const definition = operation.query.definitions.find((item) => item.kind === 'OperationDefinition')!;
    observer.next({ data: complete(data, definition.selectionSet) });
    observer.complete();
  })));
  render(<ApolloProvider client={client}><MemoryRouter><BoardPage /></MemoryRouter></ApolloProvider>);
  fireEvent.click(await screen.findByRole('button', { name: 'Load more issues' }));
  fireEvent.click(await screen.findByText('Later page item'));
  await waitFor(() => expect(requests).toContain('IssueContract'));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  expect(screen.getByTestId('issue-card-later')).toBeInTheDocument();
  expect(requests.filter((name) => name === 'BoardPage')).toHaveLength(2);
  client.stop();
});
