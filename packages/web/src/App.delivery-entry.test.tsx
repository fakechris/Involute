import { fireEvent, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { apolloMocks, boardQueryResult, getDocumentSource, renderApp } from './test/app-test-helpers';
import { App } from './App';

// INV-1023: a delivery change awaiting approval is decidable wherever a person
// opens the work — the board drawer and the issue page, not only /candidates.
const pendingChange = {
  id: 'change-1',
  viewerCanDecide: true,
  reason: 'Hand the unit to @claud-code',
  changesJson: JSON.stringify({ contract: {}, mergeSourceIds: [], policy: { environments: ['production'], units: [{ key: 'u', title: 'Unit', criteria: [0], paths: ['src/'], actions: ['edit'], dependsOn: [], checks: [] }] } }),
  beforeJson: JSON.stringify({ contracts: { 'issue-1': { acceptance: 'Works' } }, policy: null }),
  work: { id: 'issue-1', identifier: 'INV-1', title: 'First issue', revision: 1, acceptance: 'Works', repository: 'fakechris/Involute', assignee: { id: 'user-1' }, team: { memberships: { nodes: [{ user: { id: 'user-1', name: 'Admin', actorKind: 'HUMAN' } }] } } },
};
const deliveryContext = { viewerCanWrite: true, work: { id: 'issue-1', identifier: 'INV-1', title: 'First issue', revision: 1, acceptance: 'Works', repository: 'fakechris/Involute', supersededBy: null }, grant: null, authorizationValid: false, authorizationMessage: 'Pending', units: [] };

type QueryImpl = (document: unknown, options?: unknown) => unknown;

describe('delivery changes are decidable from the drawer and the issue page (INV-1023)', () => {
  afterEach(() => { apolloMocks.useQuery.mockReset(); apolloMocks.useMutation.mockImplementation(originalMutation); });
  const originalMutation = apolloMocks.useMutation.getMockImplementation() as (document: unknown) => unknown;

  // renderApp installs the board mocks; delivery queries are layered on afterwards and the tree re-rendered.
  function withDeliveryQueries(pending: boolean) {
    const fallback = apolloMocks.useQuery.getMockImplementation() as QueryImpl;
    apolloMocks.useQuery.mockImplementation(((document: unknown, options?: unknown) => {
      const source = getDocumentSource(document);
      if (source.includes('query DeliveryQueue')) {
        const workId = (options as { variables?: { workId?: string | null } } | undefined)?.variables?.workId ?? null;
        return { data: { deliveryChanges: { nodes: pending && workId === 'issue-1' ? [pendingChange] : [], pageInfo: { hasNextPage: false, endCursor: null } } }, refetch: vi.fn(), fetchMore: vi.fn(), loading: false };
      }
      if (source.includes('query DeliveryPanel')) return { data: { deliveryContext }, refetch: vi.fn(), loading: false };
      return fallback(document, options);
    }) as never);
    // The decision card reads the mutation's loading state; the shared helpers return a bare [fn].
    apolloMocks.useMutation.mockImplementation(((document: unknown) =>
      getDocumentSource(document).includes('mutation DeliveryDecision') ? [vi.fn().mockResolvedValue({ data: { deliveryChangeDecide: { success: true } } }), { loading: false }] : originalMutation(document)) as never);
  }

  it('shows Approve delivery change in the board drawer', async () => {
    renderApp(App, { data: boardQueryResult, loading: false }, ['/']);
    withDeliveryQueries(true);
    fireEvent.click(await screen.findByRole('button', { name: 'Open INV-1' }));
    const drawer = await screen.findByRole('dialog', { name: 'Issue detail drawer' });
    const section = await within(drawer).findByRole('region', { name: 'Delivery changes awaiting approval' });
    expect(within(section).getByRole('heading', { name: 'Delivery changes awaiting approval · 1' })).toBeInTheDocument();
    expect(within(section).getByRole('button', { name: 'Approve delivery change' })).toBeInTheDocument();
  });

  it('shows Approve delivery change on the issue page', async () => {
    const result = renderApp(App, { data: boardQueryResult, loading: false }, ['/issue/issue-1']);
    withDeliveryQueries(true);
    result.rerender(<MemoryRouter initialEntries={['/issue/issue-1']}><App /></MemoryRouter>);
    const section = await screen.findByRole('region', { name: 'Delivery changes awaiting approval' });
    expect(within(section).getByRole('button', { name: 'Approve delivery change' })).toBeInTheDocument();
    expect(within(section).getByText('Hand the unit to @claud-code')).toBeInTheDocument();
  });

  it('shows nothing delivery-related on an ordinary issue', async () => {
    const result = renderApp(App, { data: boardQueryResult, loading: false }, ['/issue/issue-1']);
    withDeliveryQueries(false);
    result.rerender(<MemoryRouter initialEntries={['/issue/issue-1']}><App /></MemoryRouter>);
    await screen.findByRole('heading', { name: /Sub-issues/ });
    expect(screen.queryByRole('region', { name: 'Delivery changes awaiting approval' })).toBeNull();
    expect(screen.queryByText('Delivery authorization')).toBeNull();
  });
});
