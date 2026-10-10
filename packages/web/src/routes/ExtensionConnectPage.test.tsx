import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CAPTURE_EXTENSION_ID } from '../extension/constants';
import { ExtensionConnectPage } from './ExtensionConnectPage';
import { ExtensionsTab } from './ExtensionsTab';

const mutations: Record<string, ReturnType<typeof vi.fn>> = {};
function mutation(name: string) {
  mutations[name] ??= vi.fn();
  return mutations[name]!;
}
const tokens = [
  { createdAt: '2026-10-10T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z', id: 't-live', lastUsedAt: null, name: 'Involute Capture', revokedAt: null },
  { createdAt: '2026-09-01T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z', id: 't-old', lastUsedAt: null, name: 'Old laptop', revokedAt: '2026-09-02T00:00:00Z' },
];
const mockRefetch = vi.fn().mockResolvedValue(undefined);

vi.mock('@apollo/client/react', () => ({
  useMutation: vi.fn((doc: { definitions: Array<{ name?: { value: string } }> }) => [mutation(doc.definitions[0]!.name!.value), { loading: false }]),
  useQuery: vi.fn(() => ({ data: { extensionTokens: tokens }, loading: false, refetch: mockRefetch })),
}));

vi.mock('../lib/session', () => ({
  fetchSessionState: vi.fn().mockResolvedValue({ authenticated: true, authMode: 'session', googleOAuthConfigured: false, viewer: { email: 'chris@test', globalRole: 'ADMIN', id: 'user-1', name: 'Chris' } }),
}));

function setChrome(sendMessage?: (id: string, message: unknown, callback: (response: unknown) => void) => void) {
  (globalThis as { chrome?: unknown }).chrome = sendMessage ? { runtime: { sendMessage } } : undefined;
}

function renderConnect(search = `?extension=${CAPTURE_EXTENSION_ID}`) {
  return render(<MemoryRouter initialEntries={[`/extension/connect${search}`]}><ExtensionConnectPage /></MemoryRouter>);
}

afterEach(() => {
  cleanup();
  setChrome();
});

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(mutations)) delete mutations[key];
  mutation('ExtensionTokenCreate').mockResolvedValue({
    data: { extensionTokenCreate: { extensionToken: { expiresAt: '2027-01-08T00:00:00Z', id: 't-new', name: 'Involute Capture' }, message: null, success: true, token: 'inv_ext_secret' } },
  });
  mutation('ExtensionTokenRevoke').mockResolvedValue({ data: { extensionTokenRevoke: { success: true } } });
});

describe('Connect Involute Capture (INV-1145)', () => {
  it('hands the token to the known extension through Chrome messaging, not to the page', async () => {
    const sendMessage = vi.fn((_id: string, _message: unknown, callback: (response: unknown) => void) => callback({ ok: true }));
    setChrome(sendMessage);
    const post = vi.spyOn(window, 'postMessage');
    renderConnect();
    const button = await screen.findByRole('button', { name: 'Connect extension' });
    await waitFor(() => expect(button).not.toBeDisabled());
    fireEvent.click(button);

    expect(await screen.findByRole('status')).toHaveTextContent('Connected');
    expect(sendMessage).toHaveBeenCalledWith(
      CAPTURE_EXTENSION_ID,
      expect.objectContaining({ person: expect.objectContaining({ id: 'user-1' }), server: window.location.origin, token: 'inv_ext_secret', type: 'involute.connect' }),
      expect.any(Function),
    );
    expect(post).not.toHaveBeenCalled();
    expect(mutations.ExtensionTokenRevoke).not.toHaveBeenCalled();
  });

  it('revokes the token at once when the extension does not take it', async () => {
    setChrome((_id, _message, callback) => callback(undefined));
    renderConnect();
    const button = await screen.findByRole('button', { name: 'Connect extension' });
    await waitFor(() => expect(button).not.toBeDisabled());
    fireEvent.click(button);
    expect(await screen.findByRole('alert')).toHaveTextContent('did not answer');
    expect(mutations.ExtensionTokenRevoke).toHaveBeenCalledWith({ variables: { id: 't-new' } });
  });

  it('sends nothing to an unknown extension, and nothing outside Chrome', async () => {
    renderConnect('?extension=someotherextensionid');
    expect(screen.getByRole('alert')).toHaveTextContent('does not know');
    expect(screen.queryByRole('button', { name: 'Connect extension' })).toBeNull();
    cleanup();

    renderConnect();
    const button = await screen.findByRole('button', { name: 'Connect extension' });
    await waitFor(() => expect(button).not.toBeDisabled());
    fireEvent.click(button);
    expect(await screen.findByRole('alert')).toHaveTextContent('Open this page in Chrome');
    expect(mutations.ExtensionTokenCreate).not.toHaveBeenCalled();
  });
});

describe('Settings → Extensions (INV-1145)', () => {
  it('lists connections and disconnects a live one', async () => {
    render(<MemoryRouter><ExtensionsTab /></MemoryRouter>);
    expect(screen.getByText('Old laptop')).toBeInTheDocument();
    const disconnect = screen.getAllByRole('button', { name: 'Disconnect' });
    expect(disconnect).toHaveLength(1);
    fireEvent.click(disconnect[0]!);
    await waitFor(() => expect(mutations.ExtensionTokenRevoke).toHaveBeenCalledWith({ variables: { id: 't-live' } }));
    expect(mockRefetch).toHaveBeenCalled();
  });
});
