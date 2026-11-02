import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { FieldDefinitionSummary } from './board/types';
import { apolloMocks, boardQueryResult, renderApp } from './test/app-test-helpers';
import { App } from './App';

// INV-1503: the issue page shows the field definitions that apply to the item and saves their values.
const definitions: FieldDefinitionSummary[] = [
  { key: 'customer', label: 'Customer', description: null, type: 'TEXT', required: true, options: [] },
  { key: 'risk', label: 'Risk', description: 'Delivery risk', type: 'ENUM', required: false, options: [{ value: 'low', label: 'Low', archived: null }, { value: 'high', label: 'High', archived: null }] },
];

const data = {
  ...boardQueryResult,
  issues: {
    ...boardQueryResult.issues,
    nodes: boardQueryResult.issues.nodes.map((issue) =>
      issue.id === 'issue-1' ? { ...issue, attributes: { risk: 'low' }, fieldDefinitions: definitions } : issue,
    ),
  },
};

describe('issue page Fields (INV-1503)', () => {
  it('renders each applicable field, marks a missing required one, and saves a change through issueUpdate', async () => {
    const saved = { ...data.issues.nodes[0], attributes: { risk: 'high' }, revision: 2 };
    const update = vi.fn().mockResolvedValue({ data: { issueUpdate: { success: true, message: null, issue: saved } } });
    apolloMocks.useMutation.mockImplementation((document: { loc?: { source: { body: string } } }) =>
      (document?.loc?.source.body ?? '').includes('mutation IssueUpdate') ? [update] : [vi.fn()]);
    renderApp(App, { data, loading: false }, ['/issue/issue-1']);

    const fields = await screen.findByLabelText('Fields');
    expect(fields).toHaveTextContent('Customer');
    expect(screen.getByLabelText('required')).toHaveClass('issue-fields__required--missing');
    const risk = screen.getByRole('combobox', { name: 'Risk' });
    expect(risk).toHaveValue('low');
    fireEvent.change(risk, { target: { value: 'high' } });
    await waitFor(() => expect(update).toHaveBeenCalledWith({ variables: { id: 'issue-1', input: { attributes: { risk: 'high' }, expectedRevision: 1 } } }));

    const customer = screen.getByRole('textbox', { name: 'Customer' });
    fireEvent.change(customer, { target: { value: 'Acme' } });
    fireEvent.blur(customer);
    await waitFor(() => expect(update).toHaveBeenCalledWith({ variables: { id: 'issue-1', input: { attributes: { customer: 'Acme' }, expectedRevision: 2 } } }));
  });

  it('shows no Fields row when nothing applies', async () => {
    renderApp(App, { data: boardQueryResult, loading: false }, ['/issue/issue-1']);
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByLabelText('Fields')).toBeNull();
  });
});
