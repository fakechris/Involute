import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeliveryChangeQueue, DeliveryPanel } from './DeliveryPanel';

let response: Record<string, unknown>;
vi.mock('@apollo/client/react', () => ({
  useQuery: () => ({ data: response, refetch: vi.fn(), fetchMore: vi.fn(), loading: false }),
  useMutation: () => [vi.fn(), { loading: false }],
}));
afterEach(cleanup);
const work = { id: 'root', identifier: 'INV-1', title: 'Package', revision: 1, acceptance: 'One criterion', repository: 'test/repo' };
function context(grant: unknown) {
  response = { deliveryContext: { work, grant, viewerCanWrite: true, authorizationValid: false, authorizationMessage: 'Pending', units: [] } };
}
describe('delivery approval boundaries', () => {
  it('keeps a malformed policy from crashing the work page', () => {
    context({ revision: 1, policyJson: '{' });
    render(<MemoryRouter><DeliveryPanel workId="root" /></MemoryRouter>);
    expect(screen.getByRole('alert').textContent).toContain('policy could not be read');
  });
  it('keeps one malformed change from crashing the candidate queue', () => {
    response = { deliveryChanges: { nodes: [{ id: 'change', work, viewerCanDecide: true, reason: 'Clarify', changesJson: '{', beforeJson: '{}' }], pageInfo: { hasNextPage: false } } };
    render(<MemoryRouter><DeliveryChangeQueue /></MemoryRouter>);
    expect(screen.getByRole('alert').textContent).toContain('change could not be read');
  });
  it('refuses to submit an incomplete or fractional workflow check', () => {
    context(null);
    render(<MemoryRouter><DeliveryPanel workId="root" /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Approve bounded unit' } });
    fireEvent.click(screen.getByLabelText('Propose implementation authority'));
    fireEvent.click(screen.getByRole('button', { name: 'Add implementation' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add CI check' }));
    const submit = screen.getByRole('button', { name: 'Propose delivery change' });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText('GitHub workflow ID'), { target: { value: '1.5' } });
    fireEvent.change(screen.getByLabelText('Exact CI job name'), { target: { value: 'tests' } });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText('GitHub workflow ID'), { target: { value: '42' } });
    expect(submit).not.toBeDisabled();
  });
});
