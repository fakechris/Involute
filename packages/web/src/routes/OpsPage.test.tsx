import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  OPS_INBOUND_REPLAY_MUTATION,
  OPS_SYNC_DEAD_LETTER_CLEAR_MUTATION,
  WEBHOOK_CREATE_MUTATION,
  WEBHOOK_UPDATE_MUTATION,
} from '../ops/queries';
import { OpsPage } from './OpsPage';

const mutations = new Map<unknown, ReturnType<typeof vi.fn>>();
const mutationFor = (doc: unknown) => {
  if (!mutations.has(doc)) mutations.set(doc, vi.fn());
  return mutations.get(doc)!;
};
let refused = false;

vi.mock('@apollo/client/react', () => ({
  useQuery: vi.fn(() => ({
    data: refused
      ? undefined
      : {
          opsOverview: {
            watermarks: [{ key: 'github_sync_acme/app', repository: 'acme/app', watermark: '2026-09-20T00:00:00.000Z', updatedAt: '2026-09-27T00:00:00.000Z' }],
            syncDeadLetters: [{ id: 'dl-1', repository: 'acme/app', itemRef: 'pr#20', error: 'deadlock', attempts: 3, lastFailedAt: '2026-09-27T00:00:00.000Z' }],
            inbound: {
              counts: [{ status: 'DEAD', count: 1 }],
              oldestPendingAt: null,
              dead: [{ id: 'in-1', deliveryId: 'd-1', eventType: 'push', repository: 'acme/app', attempts: 4, lastErrorCode: 'E_X', receivedAt: '2026-09-27T00:00:00.000Z', replayable: true }],
            },
            outboxFailures: [{ id: 'o-1', type: 'work.committed', attempts: 5, lastError: 'HTTP 500', createdAt: '2026-09-27T00:00:00.000Z', deadLetteredAt: null }],
            webhooks: [{ id: 'w-1', label: 'CI', url: 'https://hooks.example.com/ci', teamId: null, eventTypes: [], filterQuery: null, enabled: false, consecutiveFailures: 10, createdAt: '2026-09-01T00:00:00.000Z' }],
            audits: [{ id: 'a-1', action: 'inbound-replayed', subject: 'acme/app push d-0', reason: 'upstream fixed', createdAt: '2026-09-27T00:00:00.000Z', byActor: { id: 'u', name: 'Chris' } }],
          },
        },
    loading: false,
    error: refused ? { message: 'The ops page and its actions are for workspace admins.', errors: [{ extensions: { code: 'FORBIDDEN' } }] } : undefined,
    refetch: vi.fn(),
  })),
  useLazyQuery: vi.fn(() => [vi.fn(), { data: undefined, loading: false, error: undefined }]),
  useMutation: vi.fn((doc: unknown) => [mutationFor(doc), { loading: false }]),
}));

afterEach(() => cleanup());
beforeEach(() => {
  mutations.clear();
  refused = false;
});

const renderPage = () => render(<MemoryRouter><OpsPage /></MemoryRouter>);

describe('the ops page (INV-796)', () => {
  it('shows sync, dead letters, inbound, outbox, webhooks and the audit', async () => {
    renderPage();
    expect(await screen.findByLabelText('Sync watermarks')).toHaveTextContent('acme/app');
    expect(screen.getByText('acme/app pr#20')).toBeInTheDocument();
    expect(screen.getByLabelText('Inbound counts')).toHaveTextContent('dead 1');
    expect(screen.getByLabelText('Outbox failures')).toHaveTextContent('HTTP 500');
    expect(screen.getByText('disabled after 10 failures')).toBeInTheDocument();
    expect(screen.getByLabelText('Ops audit')).toHaveTextContent('upstream fixed');
  });

  it('asks why before clearing a dead letter or replaying a delivery', async () => {
    mutationFor(OPS_SYNC_DEAD_LETTER_CLEAR_MUTATION).mockResolvedValue({ data: { opsSyncDeadLetterClear: { success: true, message: null } } });
    mutationFor(OPS_INBOUND_REPLAY_MUTATION).mockResolvedValue({ data: { opsInboundReplay: { success: false, message: 'It changed; refresh and try again.' } } });
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Clear and retry' }));
    const clear = screen.getByRole('button', { name: 'Clear and retry' });
    expect(clear).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Why: Clear and retry'), { target: { value: 'Deadlock fixed' } });
    fireEvent.click(clear);
    await waitFor(() =>
      expect(mutationFor(OPS_SYNC_DEAD_LETTER_CLEAR_MUTATION)).toHaveBeenCalledWith({ variables: { id: 'dl-1', reason: 'Deadlock fixed' } }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Replay' }));
    fireEvent.change(screen.getByLabelText('Why: Replay'), { target: { value: 'Upstream fixed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Replay' }));
    await waitFor(() =>
      expect(mutationFor(OPS_INBOUND_REPLAY_MUTATION)).toHaveBeenCalledWith({ variables: { id: 'in-1', expectedAttempts: 4, reason: 'Upstream fixed' } }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('refresh and try again');
  });

  it('re-enables a disabled webhook and shows a new secret once', async () => {
    mutationFor(WEBHOOK_UPDATE_MUTATION).mockResolvedValue({ data: { webhookUpdate: { success: true } } });
    mutationFor(WEBHOOK_CREATE_MUTATION).mockResolvedValue({ data: { webhookCreate: { success: true, secret: 's3cret' } } });
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Re-enable' }));
    await waitFor(() => expect(mutationFor(WEBHOOK_UPDATE_MUTATION)).toHaveBeenCalledWith({ variables: { id: 'w-1', input: { enabled: true } } }));

    fireEvent.change(screen.getByLabelText('Webhook URL'), { target: { value: 'https://hooks.example.com/new' } });
    fireEvent.change(screen.getByLabelText('Webhook events'), { target: { value: 'work.committed, bug.reported' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add webhook' }));
    await waitFor(() =>
      expect(mutationFor(WEBHOOK_CREATE_MUTATION)).toHaveBeenCalledWith({
        variables: { input: { url: 'https://hooks.example.com/new', label: null, team: null, eventTypes: ['work.committed', 'bug.reported'] } },
      }),
    );
    expect(await screen.findByRole('status')).toHaveTextContent('s3cret');
  });

  it('tells a non-admin the page is not for them when the server refuses', async () => {
    refused = true;
    renderPage();
    expect(await screen.findByText('The ops page is for workspace admins.')).toBeInTheDocument();
  });
});
