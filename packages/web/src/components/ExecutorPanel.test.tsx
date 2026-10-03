import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExecutorPanel } from './ExecutorPanel';
const update = vi.fn(async () => ({ data: { executorUpdate: { success: true } } }));
let context: Record<string, unknown>;
vi.mock('@apollo/client/react', () => ({ useQuery: () => ({ data: { executorContextJson: JSON.stringify(context) }, refetch: vi.fn() }), useMutation: () => [update, { loading: false }] }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const dispatch = { id: 'dispatch', workId: 'work', revision: 3, generation: 1, visibleState: 'UNKNOWN', executorActorId: 'agent', checkpoint: 'saved', receipts: [] };
describe('executor review surface', () => {
  it('shows unknown instead of a false stopped status and offers bounded recovery', () => {
    context = { protocolVersion: 1, viewerCanWrite: true, dispatches: [dispatch] };
    render(<MemoryRouter><ExecutorPanel workId="work" /></MemoryRouter>);
    expect(screen.getByText(/may still be running/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Recover within approved budget' }));
    expect(update).toHaveBeenCalledWith({ variables: { workId: 'work', operation: 'recover', detailsJson: JSON.stringify({ expectedRevision: 3, generation: 1 }) } });
  });
  it('shows deployment mismatch and separates reported health from acceptance', () => {
    context = { protocolVersion: 1, viewerCanWrite: false, dispatches: [{ ...dispatch, visibleState: 'DELIVERED', receipts: [{ id: 'receipt', generation: 1, payload: { commitSha: 'pr-head', deployedSha: 'wrong-release', environment: 'production', health: 'pass', behavior: 'unknown', evidenceUrls: [] }, assessment: { versionMatches: false } }] }] };
    render(<MemoryRouter><ExecutorPanel workId="work" /></MemoryRouter>);
    expect(screen.getByRole('alert')).toHaveTextContent('differs from the authorized release');
    expect(screen.getByText(/final human acceptance are separate/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
  it('does not offer writable controls to a read-only viewer', () => {
    context = { protocolVersion: 1, viewerCanWrite: false, dispatches: [dispatch] };
    render(<MemoryRouter><ExecutorPanel workId="work" canDispatch /></MemoryRouter>);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
