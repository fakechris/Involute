import { useLazyQuery, useMutation, useQuery } from '@apollo/client/react';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { Btn } from '../components/Primitives';
import { Field, TextInput } from '../components/controls';
import { SettingsSectionHeader } from '../components/SettingsShell';
import {
  GITHUB_APP_MANIFEST_START_MUTATION,
  GITHUB_CONNECTION_REMOVE_MUTATION,
  GITHUB_CONNECTION_REPOSITORIES_QUERY,
  GITHUB_INSTALL_START_MUTATION,
  GITHUB_PROJECT_CREATE_MUTATION,
  GITHUB_SETUP_QUERY,
  GITHUB_TOKEN_CONNECT_MUTATION,
  type GitHubConnectionInfo,
  type GitHubRepositoryInfo,
  type GitHubSetup,
  type GitHubTeamSetup,
} from './settings-queries';
import { NoticeLine, type Notice } from './WorkspaceSettingsTabs';

/**
 * Settings → GitHub (INV-1677): the steps that connect this deployment to
 * GitHub, in the order a person does them. Step 1 — a workspace Admin creates
 * the deployment's GitHub App once; GitHub hands its credentials straight to
 * the server. Teams install it on their own accounts in the next step.
 */

/** GitHub's manifest flow wants a browser form POST; a fetch cannot follow it onto github.com. */
export function postManifest(postUrl: string, manifest: string, doc: Document = document): void {
  const form = doc.createElement('form');
  form.method = 'post';
  form.action = postUrl;
  const input = doc.createElement('input');
  input.type = 'hidden';
  input.name = 'manifest';
  input.value = manifest;
  form.appendChild(input);
  doc.body.appendChild(form);
  form.submit();
}

function defaultName(): string {
  return `Involute ${window.location.hostname}`.slice(0, 34).trim();
}

type Refusable<T> = { success: boolean; message?: string | null } & T;

export function GitHubSettingsTab({
  submit = postManifest,
  go = (url: string) => window.location.assign(url),
}: {
  submit?: (postUrl: string, manifest: string) => void;
  go?: (url: string) => void;
}) {
  const [searchParams] = useSearchParams();
  const { data, loading, error, refetch } = useQuery<{ githubSetup: GitHubSetup }>(GITHUB_SETUP_QUERY);
  const [start, starting] = useMutation<{ githubAppManifestStart: { success: boolean; message?: string | null; postUrl: string | null; manifest: string | null } }, { input: { owner?: string | null; name?: string | null } }>(GITHUB_APP_MANIFEST_START_MUTATION);
  const [owner, setOwner] = useState('');
  const [name, setName] = useState(defaultName);
  const [notice, setNotice] = useState<Notice>(null);

  if (error) return <p role="alert">Could not load the GitHub setup: {error.message}</p>;
  if (loading && !data) return <p role="status">Loading…</p>;
  const setup = data?.githubSetup;
  if (!setup) return null;

  const returned = searchParams.get('github');
  const returnedError = searchParams.get('github_error');

  async function create() {
    setNotice(null);
    try {
      const result = await start({ variables: { input: { owner: owner.trim() || null, name: name.trim() || null } } });
      const payload = result.data?.githubAppManifestStart;
      if (!payload?.success || !payload.postUrl || !payload.manifest) {
        setNotice({ ok: false, text: payload?.message ?? 'The GitHub App could not be started.' });
        return;
      }
      submit(payload.postUrl, payload.manifest);
    } catch (failure) {
      setNotice({ ok: false, text: failure instanceof Error ? failure.message : 'The GitHub App could not be started.' });
    }
  }

  return (
    <section aria-label="GitHub">
      <SettingsSectionHeader title="GitHub">
        Connect this deployment to GitHub so pull requests, branches and merges show up on the work they name. Each team connects its own accounts; credentials stay on the server, sealed.
      </SettingsSectionHeader>
      {returned === 'app-created' ? <NoticeLine notice={{ ok: true, text: 'The GitHub App was created and its credentials stored on the server.' }} /> : null}
      {returned === 'connected' ? <NoticeLine notice={{ ok: true, text: `Connected ${searchParams.get('account') ?? 'the account'} through the GitHub App.` }} /> : null}
      {returnedError ? <NoticeLine notice={{ ok: false, text: returnedError }} /> : null}

      <div className="github-setup__step" aria-label="Step 1: the deployment's GitHub App" role="group">
        <h3>1. The deployment&apos;s GitHub App</h3>
        {!setup.secretKeyConfigured ? (
          <p role="alert">
            The server has no INVOLUTE_SECRET_KEY, so it cannot store GitHub credentials. An operator sets it once in the server environment (any long random string) and restarts; see docs/github-connection.md.
          </p>
        ) : setup.app ? (
          <dl className="github-setup__facts">
            <dt>App</dt>
            <dd>
              <a href={setup.app.htmlUrl} target="_blank" rel="noreferrer">{setup.app.name}</a> · owned by {setup.app.ownerLogin || 'unknown'}
            </dd>
            <dt>Events</dt>
            <dd className="mono">{setup.webhookUrl}</dd>
            <dt>Last delivery</dt>
            <dd>{setup.lastDeliveryAt ? new Date(setup.lastDeliveryAt).toLocaleString() : 'none yet — GitHub sends events once a team installs the App'}</dd>
          </dl>
        ) : setup.viewerCanCreateApp ? (
          <form
            className="github-setup__form"
            onSubmit={(event) => {
              event.preventDefault();
              void create();
            }}
          >
            <p className="settings-section__sub">
              GitHub opens with everything filled in: read-only access to pull requests, code and checks, and events delivered to {setup.webhookUrl}. Click Create there; GitHub sends you back here and the server keeps the keys.
            </p>
            <Field label="App name" hint="Unique on GitHub, at most 34 characters.">
              <TextInput value={name} maxLength={34} onChange={(event) => setName(event.target.value)} aria-label="App name" />
            </Field>
            <Field label="Organisation (optional)" hint="Create the App under an organisation you administer; empty creates it on your own account.">
              <TextInput value={owner} onChange={(event) => setOwner(event.target.value)} aria-label="Organisation" placeholder="your own account" />
            </Field>
            <NoticeLine notice={notice} />
            <Btn variant="accent" type="submit" disabled={starting.loading}>Create GitHub App</Btn>
          </form>
        ) : (
          <p className="settings-section__sub">Not created yet. A workspace Admin creates it here once; then every team can connect.</p>
        )}
        {setup.envWebhookSecret || setup.envToken ? (
          <p className="settings-section__sub">
            This server also has {[setup.envWebhookSecret ? 'GITHUB_WEBHOOK_SECRET' : null, setup.envToken ? 'GITHUB_TOKEN' : null].filter(Boolean).join(' and ')} in its environment from an earlier setup; it is still used where no team connection applies.
          </p>
        ) : null}
      </div>

      <div className="github-setup__step" aria-label="Step 2: connect your teams" role="group">
        <h3>2. Connect your teams</h3>
        <p className="settings-section__sub">
          Each team installs the App on the GitHub accounts or organisations its repositories live in, and picks which repositories. An installation belongs to one team; the team reads only what it installed.
        </p>
        {setup.teams.length === 0 ? <p className="settings-section__sub">You are not on any team yet.</p> : null}
        {setup.teams.map((entry) => (
          <TeamConnections key={entry.team.id} entry={entry} appReady={Boolean(setup.app)} go={go} onChanged={() => void refetch()} />
        ))}
      </div>

      <div className="github-setup__step" aria-label="Step 3: is it working" role="group">
        <h3>3. Is it working</h3>
        <p className="settings-section__sub">
          Every repository a team&apos;s project names, how far Involute has read its pull requests, and with which credential. A repository read by nothing shows here as &quot;none&quot;: connect its owner above.
        </p>
        {setup.teams.map((entry) => (
          <RepositoryHealth key={entry.team.id} entry={entry} />
        ))}
      </div>
    </section>
  );
}

const CREDENTIAL_LABEL: Record<string, string> = { app: 'GitHub App', 'team-token': 'team token', env: 'server GITHUB_TOKEN', none: 'none' };

function RepositoryHealth({ entry }: { entry: GitHubTeamSetup }) {
  if (entry.repositories.length === 0) return null;
  return (
    <div className="github-setup__team" role="region" aria-label={`${entry.team.key} repositories`}>
      <div className="github-setup__team-head">
        <strong>{entry.team.name}</strong> <span className="mono observation-card__meta">{entry.team.key}</span>
      </div>
      <ul className="issue-children" role="list">
        {entry.repositories.map((repo) => (
          <li key={repo.repository} role="listitem" className="issue-children__row github-setup__connection-head">
            <span className="mono">{repo.repository}</span>
            <span className="observation-card__meta">{repo.project.identifier}</span>
            <span className={repo.credential === 'none' ? 'github-setup__bad' : 'observation-card__meta'}>read by {CREDENTIAL_LABEL[repo.credential] ?? repo.credential}</span>
            <span className="observation-card__meta">{repo.syncedThrough ? `synced through ${new Date(repo.syncedThrough).toLocaleString()}` : 'not synced yet'}</span>
            {repo.deadLetters > 0 ? <span className="github-setup__bad">{repo.deadLetters} pull request{repo.deadLetters === 1 ? '' : 's'} the sync gave up on (Operations)</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function TeamConnections({ entry, appReady, go, onChanged }: { entry: GitHubTeamSetup; appReady: boolean; go: (url: string) => void; onChanged: () => void }) {
  const [notice, setNotice] = useState<Notice>(null);
  const [tokenOpen, setTokenOpen] = useState(false);
  const [account, setAccount] = useState('');
  const [token, setToken] = useState('');
  const [install, installing] = useMutation<{ githubInstallStart: Refusable<{ url: string | null }> }, { teamId: string }>(GITHUB_INSTALL_START_MUTATION);
  const [connect, connecting] = useMutation<{ githubTokenConnect: Refusable<{ connection: { id: string } | null }> }, { input: { teamId: string; accountLogin: string; token: string } }>(GITHUB_TOKEN_CONNECT_MUTATION);

  async function startInstall() {
    setNotice(null);
    try {
      const result = await install({ variables: { teamId: entry.team.id } });
      const payload = result.data?.githubInstallStart;
      if (!payload?.success || !payload.url) {
        setNotice({ ok: false, text: payload?.message ?? 'The installation could not be started.' });
        return;
      }
      go(payload.url);
    } catch (failure) {
      setNotice({ ok: false, text: failure instanceof Error ? failure.message : 'The installation could not be started.' });
    }
  }

  async function connectWithToken() {
    setNotice(null);
    try {
      const result = await connect({ variables: { input: { teamId: entry.team.id, accountLogin: account.trim(), token } } });
      const payload = result.data?.githubTokenConnect;
      if (!payload?.success) {
        setNotice({ ok: false, text: payload?.message ?? 'The token was not saved.' });
        return;
      }
      setToken('');
      setTokenOpen(false);
      setNotice({ ok: true, text: `Connected ${account.trim()} with a token.` });
      onChanged();
    } catch (failure) {
      setNotice({ ok: false, text: failure instanceof Error ? failure.message : 'The token was not saved.' });
    }
  }

  return (
    <div className="github-setup__team" role="region" aria-label={`Team ${entry.team.key}`}>
      <div className="github-setup__team-head">
        <strong>{entry.team.name}</strong> <span className="mono observation-card__meta">{entry.team.key}</span>
      </div>
      {entry.connections.length === 0 ? <p className="settings-section__sub">Not connected to GitHub.</p> : null}
      <ul className="issue-children" role="list" aria-label={`${entry.team.key} GitHub connections`}>
        {entry.connections.map((connection) => (
          <ConnectionRow key={connection.id} connection={connection} canManage={entry.viewerCanManage} teamId={entry.team.id} onChanged={onChanged} />
        ))}
      </ul>
      {entry.viewerCanManage ? (
        <div className="github-setup__actions">
          <Btn size="sm" variant="accent" onClick={() => void startInstall()} disabled={!appReady || installing.loading} title={appReady ? undefined : 'A workspace Admin creates the App first (step 1).'}>
            Install on GitHub
          </Btn>
          <Btn size="sm" variant="subtle" onClick={() => setTokenOpen((open) => !open)}>Use a token instead</Btn>
        </div>
      ) : (
        <p className="settings-section__sub">A team Owner connects this team.</p>
      )}
      {tokenOpen ? (
        <form
          className="github-setup__form"
          onSubmit={(event) => {
            event.preventDefault();
            void connectWithToken();
          }}
        >
          <Field label="GitHub account or organisation" hint="The owner part of owner/name.">
            <TextInput value={account} onChange={(event) => setAccount(event.target.value)} aria-label="GitHub account" />
          </Field>
          <Field label="Read-only token" hint="A fine-grained token with read access to pull requests, contents and metadata. Stored sealed; never shown again.">
            <TextInput type="password" value={token} onChange={(event) => setToken(event.target.value)} aria-label="Token" autoComplete="off" />
          </Field>
          <Btn size="sm" variant="accent" type="submit" disabled={connecting.loading || !account.trim() || !token.trim()}>Connect with token</Btn>
        </form>
      ) : null}
      <NoticeLine notice={notice} />
    </div>
  );
}

function ConnectionRow({ connection, canManage, teamId, onChanged }: { connection: GitHubConnectionInfo; canManage: boolean; teamId: string; onChanged: () => void }) {
  const [notice, setNotice] = useState<Notice>(null);
  const [remove, removing] = useMutation<{ githubConnectionRemove: Refusable<{ removed: boolean }> }, { id: string }>(GITHUB_CONNECTION_REMOVE_MUTATION);
  const [loadRepositories, repositories] = useLazyQuery<{ githubConnectionRepositories: GitHubRepositoryInfo[] }, { connectionId: string }>(GITHUB_CONNECTION_REPOSITORIES_QUERY, { fetchPolicy: 'network-only' });
  const [createProject] = useMutation<{ issueCreate: Refusable<{ issue: { id: string; identifier: string } | null }> }, { input: { teamId: string; title: string; kind: 'PROJECT'; repository: string } }>(GITHUB_PROJECT_CREATE_MUTATION);

  async function disconnect() {
    if (!window.confirm(`Disconnect ${connection.accountLogin}? Involute stops reading its repositories for this team. Uninstall the App on GitHub to revoke it there too.`)) return;
    const result = await remove({ variables: { id: connection.id } }).catch((failure: unknown) => ({ data: { githubConnectionRemove: { success: false, removed: false, message: failure instanceof Error ? failure.message : null } } }));
    const payload = result.data?.githubConnectionRemove;
    if (!payload?.success) {
      setNotice({ ok: false, text: payload?.message ?? 'The connection was not removed.' });
      return;
    }
    onChanged();
  }

  async function addProject(repository: string) {
    setNotice(null);
    const result = await createProject({ variables: { input: { teamId, title: repository, kind: 'PROJECT', repository } } }).catch((failure: unknown) => ({ data: { issueCreate: { success: false, issue: null, message: failure instanceof Error ? failure.message : null } } }));
    const payload = result.data?.issueCreate;
    if (!payload?.success) {
      setNotice({ ok: false, text: payload?.message ?? 'The project was not created.' });
      return;
    }
    setNotice({ ok: true, text: `Created ${payload.issue?.identifier ?? 'the project'} for ${repository}; its pull requests now reach this team.` });
    void repositories.refetch?.();
  }

  const kind = connection.kind === 'APP_INSTALLATION' ? `GitHub App · ${connection.repositorySelection === 'selected' ? 'selected repositories' : 'all repositories'}` : 'token';
  return (
    <li role="listitem" className="issue-children__row github-setup__connection">
      <div className="github-setup__connection-head">
        <span className="mono">{connection.accountLogin}</span>
        <span className="observation-card__meta">{kind}</span>
        <span className={connection.status === 'ACTIVE' ? 'observation-card__meta' : 'github-setup__bad'}>{connection.status === 'ACTIVE' ? 'connected' : 'disconnected'}</span>
        {connection.lastError ? <span className="github-setup__bad">{connection.lastError}</span> : null}
        <Btn size="sm" variant="subtle" onClick={() => void loadRepositories({ variables: { connectionId: connection.id } })}>Repositories</Btn>
        {canManage ? <Btn size="sm" variant="danger" onClick={() => void disconnect()} disabled={removing.loading}>Disconnect</Btn> : null}
      </div>
      {repositories.error ? <p role="alert">{repositories.error.message}</p> : null}
      {repositories.data ? (
        <ul className="github-setup__repos" aria-label={`${connection.accountLogin} repositories`}>
          {repositories.data.githubConnectionRepositories.map((repo) => (
            <li key={repo.fullName}>
              <span className="mono">{repo.fullName}</span>
              {repo.private ? <span className="observation-card__meta"> private</span> : null}
              {repo.project ? (
                <span className="observation-card__meta"> · project {repo.project.identifier}</span>
              ) : canManage ? (
                <> · <button type="button" className="ui-action" onClick={() => void addProject(repo.fullName)}>Create project</button></>
              ) : (
                <span className="observation-card__meta"> · no project</span>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      <NoticeLine notice={notice} />
    </li>
  );
}
