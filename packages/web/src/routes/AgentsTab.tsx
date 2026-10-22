import { gql } from '@apollo/client';
import { useMutation, useQuery } from '@apollo/client/react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { AGENTS_QUERY, AGENT_OWNER_CANDIDATES_QUERY } from '../board/queries';
import type { UserSummary } from '../board/types';

import { Checkbox, Field, Select, TextInput } from '../components/controls';
import { DataTable } from '../components/DataTable';
import { Btn } from '../components/Primitives';
import { SettingsSectionHeader } from '../components/SettingsShell';
import { readStoredTeamKey } from '../board/utils';

// Mirrors the server's AGENT_SCOPES; `answer` was missing here, so UI-issued agents could not reply to requests (INV-606).
const AGENT_SCOPES = ['read', 'propose', 'claim', 'report', 'update', 'link', 'answer'] as const;

const HANDLE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function deriveHandle(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
}

const SCOPE_DESCRIPTIONS: Record<string, string> = {
  read: 'Search, read context, list ready work',
  propose: 'Create candidate work',
  claim: 'Claim committed work',
  report: 'Report runs and attach evidence',
  update: 'Update non-contract fields',
  link: 'Create typed work links',
  answer: 'Answer requests addressed to this actor',
};

interface AgentCredentialSummary {
  id: string;
  name: string;
  scopes: string[];
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  user: { id: string; name: string; email: string; handle: string | null; deactivatedAt: string | null; owner: { id: string; name: string | null; handle: string | null } | null };
}

interface AgentsQueryData {
  teams: { nodes: Array<{ id: string; key: string; name: string; viewerCanManage?: boolean }> };
  agentCredentials: AgentCredentialSummary[];
}

const AGENTS_TAB_QUERY = gql`
  query AgentsTab($teamId: String!) {
    teams {
      nodes {
        id
        key
        name
      }
    }
    agentCredentials(teamId: $teamId) {
      id
      name
      scopes
      createdAt
      expiresAt
      revokedAt
      user {
        id
        name
        email
        handle
        deactivatedAt
        owner {
          id
          name
          handle
        }
      }
    }
  }
`;

const AGENT_CREATE_MUTATION = gql`
  mutation AgentCredentialCreate($input: AgentCredentialCreateInput!) {
    agentCredentialCreate(input: $input) {
      success
      token
      credential {
        id
        name
        scopes
        user { id handle }
      }
    }
  }
`;

const AGENT_REVOKE_MUTATION = gql`
  mutation AgentCredentialRevoke($id: String!) {
    agentCredentialRevoke(id: $id) {
      success
    }
  }
`;

export function AgentsTab({ teamKey: fixedTeamKey }: { teamKey?: string } = {}) {
  const teamsQuery = useQuery<{ teams: AgentsQueryData['teams'] }>(gql`
    query AgentsTeams {
      teams {
        nodes {
          id
          key
          name
          viewerCanManage
        }
      }
    }
  `);
  // Issuing and revoking credentials is managing a team (OWNER or ADMIN);
  // only teams the server says this viewer manages are offered here.
  const teams = (teamsQuery.data?.teams.nodes ?? []).filter((team) => team.viewerCanManage);
  const storedKey = readStoredTeamKey();
  const [teamKey, setTeamKey] = useState('');
  const manageableKeys = new Set(teams.map((team) => team.key));
  // On a team's settings page the team is fixed; in Settings it can be chosen.
  const effectiveKey = [fixedTeamKey, teamKey, storedKey, teams[0]?.key].find((key): key is string => Boolean(key && manageableKeys.has(key))) ?? '';

  const { data, loading, refetch } = useQuery<AgentsQueryData>(AGENTS_TAB_QUERY, {
    variables: { teamId: effectiveKey },
    skip: !effectiveKey,
  });
  const [runCreate] = useMutation<
    { agentCredentialCreate: { success: boolean; token: string | null; credential: { id: string; name: string; scopes: string[]; user: { id: string; handle: string | null } } | null } },
    { input: { team: string; name: string; email?: string; scopes: string[]; expiresAt?: string; handle?: string; ownerId?: string; runtime?: string; description?: string; agentCardUrl?: string } }
  >(AGENT_CREATE_MUTATION);
  // What already exists, so the form can say "this handle is taken" or
  // "this will add a credential to X" before the server has to.
  const directory = useQuery<{ agents: UserSummary[] }>(AGENTS_QUERY, { variables: { teamKey: null } });
  const owners = useQuery<{ viewer: { id: string } | null; users: { nodes: Array<Pick<UserSummary, 'id' | 'name' | 'email' | 'actorKind' | 'deactivatedAt'>> } }>(AGENT_OWNER_CANDIDATES_QUERY);
  const viewerId = owners.data?.viewer?.id ?? null;
  const [runRevoke] = useMutation<{ agentCredentialRevoke: { success: boolean } }, { id: string }>(AGENT_REVOKE_MUTATION);

  const [name, setName] = useState('');
  const [handle, setHandle] = useState('');
  const [handleTouched, setHandleTouched] = useState(false);
  const [email, setEmail] = useState('');
  const [ownerId, setOwnerId] = useState('');
  const [runtime, setRuntime] = useState('');
  const [description, setDescription] = useState('');
  const [agentCardUrl, setAgentCardUrl] = useState('');
  const [scopes, setScopes] = useState<string[]>(['read', 'propose', 'claim', 'report', 'answer']);
  const [expiresAt, setExpiresAt] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [fresh, setFresh] = useState<{ token: string; handle: string | null } | null>(null);

  const credentials = useMemo(() => data?.agentCredentials ?? [], [data]);
  const agents = useMemo(() => directory.data?.agents ?? [], [directory.data]);
  const humans = useMemo(
    () => (owners.data?.users.nodes ?? []).filter((user) => user.actorKind === 'HUMAN' && !user.deactivatedAt),
    [owners.data],
  );
  const effectiveOwnerId = ownerId || viewerId || '';
  const effectiveHandle = handleTouched ? handle.trim().toLowerCase() : deriveHandle(name);
  const trimmedEmail = email.trim().toLowerCase();
  const existingByEmail = trimmedEmail ? agents.find((agent) => agent.email?.toLowerCase() === trimmedEmail) ?? null : null;
  const handleOwner = effectiveHandle ? agents.find((agent) => agent.handle === effectiveHandle) ?? null : null;
  const handleTaken = Boolean(handleOwner && (!existingByEmail || handleOwner.id !== existingByEmail.id));
  const handleInvalid = Boolean(effectiveHandle) && !HANDLE_PATTERN.test(effectiveHandle);
  const emailInvalid = Boolean(trimmedEmail) && !EMAIL_SHAPE.test(trimmedEmail);
  const canSubmit = Boolean(name.trim() && effectiveKey && !pending && !handleTaken && !handleInvalid && !emailInvalid);

  function toggleScope(scope: string) {
    if (scope === 'read') return;
    setScopes((prev) => (prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope]));
  }

  async function handleCreate() {
    if (!name.trim() || !effectiveKey) return;
    setError(null);
    setPending(true);
    try {
      const result = await runCreate({
        variables: {
          input: {
            team: effectiveKey,
            name: name.trim(),
            ...(trimmedEmail ? { email: trimmedEmail } : {}),
            ...(effectiveHandle ? { handle: effectiveHandle } : {}),
            ...(effectiveOwnerId ? { ownerId: effectiveOwnerId } : {}),
            ...(runtime.trim() ? { runtime: runtime.trim() } : {}),
            ...(description.trim() ? { description: description.trim() } : {}),
            ...(agentCardUrl.trim() ? { agentCardUrl: agentCardUrl.trim() } : {}),
            scopes,
            ...(expiresAt ? { expiresAt: new Date(expiresAt).toISOString() } : {}),
          },
        },
      });
      const payload = result.data?.agentCredentialCreate;
      if (!payload?.success || !payload?.token) {
        setError('Could not issue the credential. Check the handle and email, and that you may manage this team.');
        return;
      }
      setFresh({ token: payload.token, handle: payload.credential?.user.handle ?? null });
      setName('');
      setHandle('');
      setHandleTouched(false);
      setEmail('');
      setRuntime('');
      setDescription('');
      setAgentCardUrl('');
      await Promise.all([refetch(), directory.refetch()]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not issue the credential.');
    } finally {
      setPending(false);
    }
  }

  async function handleRevoke(id: string) {
    if (!window.confirm('Revoke this credential? Connected agents lose access immediately.')) return;
    setError(null);
    try {
      await runRevoke({ variables: { id } });
      await refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not revoke the credential.');
    }
  }

  if (!teamsQuery.loading && teams.length === 0) {
    return (
      <>
        <SettingsSectionHeader title="Agents">
          Only a team owner can issue or revoke agent credentials. You do not manage any team.
        </SettingsSectionHeader>
      </>
    );
  }

  return (
    <>
      <SettingsSectionHeader title="Agents">
        Issue revocable MCP tokens for AI agents. Tokens are shown once and work on
        <span className="mono"> /mcp </span> only. Only team owners can manage them.
      </SettingsSectionHeader>

      {teams.length > 1 && !fixedTeamKey && (
        <div className="form-stack agents-tab__team">
          <Field label="Team">
            <Select value={effectiveKey} onChange={(e) => setTeamKey(e.target.value)}>
              {teams.map((t) => (
                <option key={t.id} value={t.key}>{t.name}</option>
              ))}
            </Select>
          </Field>
        </div>
      )}

      {fresh && (
        <div className="agents-tab__fresh">
          <div className="agents-tab__fresh-title">Copy this token now — it will not be shown again.</div>
          <div className="mono agents-tab__token">{fresh.token}</div>
          {fresh.handle ? (
            <div className="field__hint">
              Mention as <span className="mono">@{fresh.handle}</span> · <Link to={`/agents/${fresh.handle}`}>open its page</Link>
            </div>
          ) : null}
          <div className="agents-tab__fresh-actions">
            <Btn variant="subtle" size="md" onClick={() => { void navigator.clipboard?.writeText(fresh.token); }}>Copy token</Btn>
            <Btn variant="ghost" size="md" onClick={() => setFresh(null)}>Done</Btn>
          </div>
        </div>
      )}

      {error && <p role="alert" className="dialog-shell__error">{error}</p>}

      {loading ? (
        <p role="status" className="field__hint">Loading agents…</p>
      ) : (
        <DataTable
          label="Agent credentials"
          rows={credentials}
          rowKey={(cred) => cred.id}
          empty="No agent credentials yet."
          rowClassName={(cred) => (cred.revokedAt ? 'data-table__row--muted' : undefined)}
          columns={[
            {
              key: 'credential',
              header: 'Credential · actor',
              render: (cred) => (
                <span className="data-table__primary">
                  <span>{cred.name}</span>
                  <span className="data-table__secondary">
                    <Link to={`/agents/${cred.user.handle ?? cred.user.id}`}>
                      {cred.user.handle ? `@${cred.user.handle}` : cred.user.name || cred.user.email}
                    </Link>
                    {cred.user.owner ? ` · owner ${cred.user.owner.name ?? cred.user.owner.handle ?? cred.user.owner.id}` : ' · no owner'}
                    {cred.user.deactivatedAt ? ' · actor deactivated' : ''}
                  </span>
                </span>
              ),
            },
            { key: 'scopes', header: 'Scopes', width: '220px', render: (cred) => <span className="mono data-table__secondary">{cred.scopes.join(', ')}</span> },
            {
              key: 'actions',
              header: '',
              align: 'end',
              render: (cred) => (cred.revokedAt
                ? <span className="data-table__secondary">revoked</span>
                : <Btn variant="danger" onClick={() => void handleRevoke(cred.id)}>Revoke</Btn>),
            },
          ]}
        />
      )}

      <h3 className="settings-section__title">Issue a credential</h3>
      <div className="form-stack agents-tab__form">
        <Field label="Agent name">
          <TextInput aria-label="Agent name" placeholder="e.g. Codex review" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field
          label="Handle"
          hint="Mention as @handle."
          error={handleTaken
            ? `@${effectiveHandle} already belongs to ${handleOwner?.name ?? handleOwner?.email ?? 'another actor'}. Pick another handle.`
            : handleInvalid ? 'Handles are 1–32 characters of a-z, 0-9, _ or -.' : undefined}
        >
          <TextInput
            aria-label="Handle"
            placeholder="handle"
            value={effectiveHandle}
            onChange={(e) => { setHandleTouched(true); setHandle(e.target.value); }}
          />
        </Field>
        <Field
          label="Email"
          error={emailInvalid ? 'That is not an email address.' : undefined}
          hint={!emailInvalid && existingByEmail
            ? `This adds a credential to the existing actor ${existingByEmail.name ?? existingByEmail.email}${existingByEmail.handle ? ` (@${existingByEmail.handle})` : ''}; no new actor is created.`
            : 'Optional; generated if blank.'}
        >
          <TextInput aria-label="Email" placeholder="agent@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Accountable owner" htmlFor="agent-owner">
          <Select value={effectiveOwnerId} onChange={(e) => setOwnerId(e.target.value)}>
            {humans.length === 0 ? <option value="">{owners.loading ? 'Loading people…' : 'You'}</option> : null}
            {humans.map((user) => (
              <option key={user.id} value={user.id}>{user.name ?? user.email ?? user.id}{user.id === viewerId ? ' (you)' : ''}</option>
            ))}
          </Select>
        </Field>
        <Field label="Runtime">
          <TextInput aria-label="Runtime" placeholder="e.g. codex, claude-code" value={runtime} onChange={(e) => setRuntime(e.target.value)} />
        </Field>
        <Field label="Description" hint="Shown in the directory.">
          <TextInput aria-label="Description" placeholder="What this agent does" value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Field label="Agent card URL">
          <TextInput aria-label="Agent card URL" placeholder="Optional" value={agentCardUrl} onChange={(e) => setAgentCardUrl(e.target.value)} />
        </Field>
        <div className="field">
          <span className="field__label">Scopes (Linear-style; read is always granted)</span>
          <div className="checkbox-group">
            {AGENT_SCOPES.map((scope) => (
              <Checkbox
                key={scope}
                title={SCOPE_DESCRIPTIONS[scope]}
                label={<span className="mono">{scope}</span>}
                checked={scopes.includes(scope)}
                disabled={scope === 'read'}
                onChange={() => toggleScope(scope)}
              />
            ))}
          </div>
        </div>
        <Field label="Expiry date (optional)">
          <TextInput type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} aria-label="Expiry date (optional)" />
        </Field>
        <div>
          <Btn variant="accent" size="md" disabled={!canSubmit} loading={pending} onClick={() => void handleCreate()}>
            {pending ? 'Issuing…' : 'Issue credential'}
          </Btn>
        </div>
      </div>
    </>
  );
}
