import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { apolloMocks, boardQueryResult, renderApp } from './test/app-test-helpers';
import { App } from './App';

// INV-1514: the board drawer shows the field definitions that apply and saves through issueUpdate.
const definitions = [
  { key: 'risk', label: 'Risk', description: null, type: 'ENUM', required: false, searchable: true, options: [{ value: 'low', label: 'low', archived: null }, { value: 'high', label: 'high', archived: null }] },
];

describe('board drawer Fields (INV-1514)', () => {
  it('shows the applicable fields with the stored value and saves a change', async () => {
    const data = {
      ...boardQueryResult,
      issues: {
        ...boardQueryResult.issues,
        nodes: boardQueryResult.issues.nodes.map((issue) => (issue.id === 'issue-2' ? { ...issue, attributes: { risk: 'low' }, fieldDefinitions: definitions } : issue)),
      },
    };
    const target = data.issues.nodes.find((issue) => issue.id === 'issue-2')!;
    const update = vi.fn().mockResolvedValue({ data: { issueUpdate: { success: true, message: null, issue: { ...target, attributes: { risk: 'high' }, revision: target.revision + 1 } } } });
    apolloMocks.useMutation.mockImplementation((document: { loc?: { source: { body: string } } }) =>
      (document?.loc?.source.body ?? '').includes('mutation IssueUpdate') ? [update] : [vi.fn()]);
    renderApp(App, { data, loading: false }, ['/']);

    fireEvent.click(await screen.findByRole('button', { name: 'Open INV-2' }));
    const drawer = await screen.findByRole('dialog', { name: 'Issue detail drawer' });
    const risk = within(drawer).getByRole('combobox', { name: 'Risk' });
    expect(risk).toHaveValue('low');
    fireEvent.change(risk, { target: { value: 'high' } });
    await waitFor(() => expect(update).toHaveBeenCalledWith({ variables: { id: 'issue-2', input: { attributes: { risk: 'high' }, expectedRevision: target.revision } } }));
  });

  it('shows no Fields group when nothing applies', async () => {
    renderApp(App, { data: boardQueryResult, loading: false }, ['/']);
    fireEvent.click(await screen.findByRole('button', { name: 'Open INV-2' }));
    const drawer = await screen.findByRole('dialog', { name: 'Issue detail drawer' });
    expect(within(drawer).queryByText('Fields')).toBeNull();
  });
});
