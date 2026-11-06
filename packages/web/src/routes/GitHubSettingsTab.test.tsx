import { MockedProvider } from '@apollo/client/testing/react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GitHubSettingsTab, postManifest } from './GitHubSettingsTab';
import { GITHUB_APP_MANIFEST_START_MUTATION, GITHUB_CONNECTION_REMOVE_MUTATION, GITHUB_INSTALL_START_MUTATION, GITHUB_SETUP_QUERY, GITHUB_TOKEN_CONNECT_MUTATION } from './settings-queries';

const setup = (extra: Record<string, unknown> = {}) => ({
  request: { query: GITHUB_SETUP_QUERY },
  result: {
    data: {
      githubSetup: {
        __typename: 'GitHubSetup',
        secretKeyConfigured: true,
        webhookUrl: 'https://involute.example.com/api/webhooks/github',
        envWebhookSecret: false,
        envToken: true,
        app: null,
        lastDeliveryAt: null,
        viewerCanCreateApp: true,
        teams: [],
        ...extra,
      },
    },
  },
});

function renderTab(mocks: unknown[], submit = vi.fn(), path = '/settings?tab=github', go = vi.fn()) {
  render(
    <MockedProvider mocks={mocks as never}>
      <MemoryRouter initialEntries={[path]}>
        <GitHubSettingsTab submit={submit} go={go} />
      </MemoryRouter>
    </MockedProvider>,
  );
  return submit;
}

describe('Settings → GitHub (INV-1677)', () => {
  afterEach(cleanup);

  it('an Admin creates the App: the server signs the manifest and the browser posts it to GitHub', async () => {
    const submit = renderTab([
      setup(),
      {
        request: { query: GITHUB_APP_MANIFEST_START_MUTATION, variables: { input: { owner: 'acme-org', name: 'Involute test' } } },
        result: { data: { githubAppManifestStart: { __typename: 'GitHubAppManifestPayload', success: true, message: null, postUrl: 'https://github.com/organizations/acme-org/settings/apps/new?state=s', manifest: '{"name":"Involute test"}' } } },
      },
    ]);
    fireEvent.change(await screen.findByLabelText('App name'), { target: { value: 'Involute test' } });
    fireEvent.change(screen.getByLabelText('Organisation'), { target: { value: 'acme-org' } });
    fireEvent.click(screen.getByText('Create GitHub App'));
    await waitFor(() => expect(submit).toHaveBeenCalledWith('https://github.com/organizations/acme-org/settings/apps/new?state=s', '{"name":"Involute test"}'));
    expect(screen.getByText(/GITHUB_TOKEN in its environment/)).toBeInTheDocument();
  });

  it('shows the refusal instead of leaving for GitHub', async () => {
    const submit = renderTab([
      setup(),
      {
        request: { query: GITHUB_APP_MANIFEST_START_MUTATION, variables: { input: { owner: null, name: 'Involute localhost' } } },
        result: { data: { githubAppManifestStart: { __typename: 'GitHubAppManifestPayload', success: false, message: 'This deployment already has a GitHub App.', postUrl: null, manifest: null } } },
      },
    ]);
    fireEvent.change(await screen.findByLabelText('App name'), { target: { value: 'Involute localhost' } });
    fireEvent.click(screen.getByText('Create GitHub App'));
    expect(await screen.findByRole('alert')).toHaveTextContent('already has a GitHub App');
    expect(submit).not.toHaveBeenCalled();
  });

  it('shows the App once it exists, and the result GitHub sent the person back with', async () => {
    renderTab(
      [setup({ viewerCanCreateApp: false, app: { __typename: 'GitHubAppInfo', appId: '77', slug: 'involute-x', name: 'Involute x', htmlUrl: 'https://github.com/apps/involute-x', ownerLogin: 'fakechris', installUrl: 'https://github.com/apps/involute-x/installations/new', createdAt: '2026-11-06T00:00:00.000Z' } })],
      vi.fn(),
      '/settings?tab=github&github=app-created',
    );
    expect(await screen.findByRole('link', { name: 'Involute x' })).toHaveAttribute('href', 'https://github.com/apps/involute-x');
    expect(screen.getByText(/created and its credentials stored/)).toBeInTheDocument();
    expect(screen.queryByText('Create GitHub App')).not.toBeInTheDocument();
  });

  it('says what the operator must set when the server cannot store secrets', async () => {
    renderTab([setup({ secretKeyConfigured: false })]);
    expect(await screen.findByText(/no INVOLUTE_SECRET_KEY/)).toBeInTheDocument();
  });

  it('posts the manifest as a form, the way GitHub requires', () => {
    const submitted: Array<{ action: string; manifest: string | null }> = [];
    const realSubmit = HTMLFormElement.prototype.submit;
    HTMLFormElement.prototype.submit = function submit(this: HTMLFormElement) {
      submitted.push({ action: this.action, manifest: (this.elements.namedItem('manifest') as HTMLInputElement | null)?.value ?? null });
    };
    try {
      postManifest('https://github.com/settings/apps/new?state=s', '{"a":1}');
    } finally {
      HTMLFormElement.prototype.submit = realSubmit;
    }
    expect(submitted).toEqual([{ action: 'https://github.com/settings/apps/new?state=s', manifest: '{"a":1}' }]);
  });

  const app = { __typename: 'GitHubAppInfo', appId: '77', slug: 'involute-x', name: 'Involute x', htmlUrl: 'https://github.com/apps/involute-x', ownerLogin: 'fakechris', installUrl: 'https://github.com/apps/involute-x/installations/new', createdAt: '2026-11-06T00:00:00.000Z' };
  const team = (extra: Record<string, unknown> = {}) => ({
    __typename: 'GitHubTeamSetup',
    team: { __typename: 'Team', id: 't1', key: 'INV', name: 'Involute' },
    viewerCanManage: true,
    connections: [],
    repositories: [],
    ...extra,
  });
  const connection = { __typename: 'GitHubConnectionInfo', id: 'c1', kind: 'APP_INSTALLATION', accountLogin: 'fakechris', accountType: 'User', repositorySelection: 'all', status: 'ACTIVE', lastError: null, lastCheckedAt: null, createdAt: '2026-11-06T00:00:00.000Z' };

  it('a team Owner installs the App for their team: the server signs where GitHub should go', async () => {
    const go = vi.fn();
    renderTab(
      [
        setup({ viewerCanCreateApp: false, app, teams: [team()] }),
        { request: { query: GITHUB_INSTALL_START_MUTATION, variables: { teamId: 't1' } }, result: { data: { githubInstallStart: { __typename: 'GitHubInstallStartPayload', success: true, message: null, url: 'https://github.com/apps/involute-x/installations/new?state=s' } } } },
      ],
      vi.fn(),
      '/settings?tab=github',
      go,
    );
    fireEvent.click(await screen.findByText('Install on GitHub'));
    await waitFor(() => expect(go).toHaveBeenCalledWith('https://github.com/apps/involute-x/installations/new?state=s'));
    expect(screen.getByText('Not connected to GitHub.')).toBeInTheDocument();
  });

  it('install waits for the App, and members who do not own the team are told who connects it', async () => {
    renderTab([setup({ viewerCanCreateApp: false, teams: [team(), team({ team: { __typename: 'Team', id: 't2', key: 'LUM', name: 'Lumen' }, viewerCanManage: false })] })]);
    expect(await screen.findByRole('button', { name: 'Install on GitHub' })).toBeDisabled();
    expect(screen.getByText('A team Owner connects this team.')).toBeInTheDocument();
  });

  it('connects an owner with a pasted token instead', async () => {
    renderTab([
      setup({ viewerCanCreateApp: false, app, teams: [team()] }),
      { request: { query: GITHUB_TOKEN_CONNECT_MUTATION, variables: { input: { teamId: 't1', accountLogin: 'acme', token: 'github_pat_x' } } }, result: { data: { githubTokenConnect: { __typename: 'GitHubConnectionPayload', success: true, message: null, connection: { __typename: 'GitHubConnectionInfo', id: 'c9' } } } } },
      setup({ viewerCanCreateApp: false, app, teams: [team()] }),
    ]);
    fireEvent.click(await screen.findByText('Use a token instead'));
    fireEvent.change(screen.getByLabelText('GitHub account'), { target: { value: 'acme' } });
    fireEvent.change(screen.getByLabelText('Token'), { target: { value: 'github_pat_x' } });
    fireEvent.click(screen.getByText('Connect with token'));
    expect(await screen.findByText('Connected acme with a token.')).toBeInTheDocument();
  });

  it('shows a team connection and disconnects it after the Owner confirms', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderTab([
      setup({ viewerCanCreateApp: false, app, teams: [team({ connections: [connection] })] }),
      { request: { query: GITHUB_CONNECTION_REMOVE_MUTATION, variables: { id: 'c1' } }, result: { data: { githubConnectionRemove: { __typename: 'GitHubConnectionRemovePayload', success: true, message: null, removed: true } } } },
      setup({ viewerCanCreateApp: false, app, teams: [team()] }),
    ]);
    expect(await screen.findByText('GitHub App · all repositories')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Disconnect'));
    expect(await screen.findByText('Not connected to GitHub.')).toBeInTheDocument();
    vi.restoreAllMocks();
  });

  it('shows each repository, how far it is synced and what reads it', async () => {
    renderTab([
      setup({
        viewerCanCreateApp: false,
        app,
        teams: [
          team({
            repositories: [
              { __typename: 'GitHubRepositoryHealth', repository: 'fakechris/Involute', project: { __typename: 'Issue', id: 'p1', identifier: 'INV-79' }, syncedThrough: '2026-11-05T00:00:00.000Z', lastSyncAt: '2026-11-06T00:00:00.000Z', deadLetters: 0, credential: 'app' },
              { __typename: 'GitHubRepositoryHealth', repository: 'chris/staffgics', project: { __typename: 'Issue', id: 'p2', identifier: 'INV-300' }, syncedThrough: null, lastSyncAt: null, deadLetters: 2, credential: 'none' },
            ],
          }),
        ],
      }),
    ]);
    const health = await screen.findByRole('region', { name: 'INV repositories' });
    expect(health).toHaveTextContent('read by GitHub App');
    expect(health).toHaveTextContent('read by none');
    expect(health).toHaveTextContent('not synced yet');
    expect(health).toHaveTextContent('2 pull requests the sync gave up on');
  });
});
